package gatekeeper

import (
	"crypto/hmac"
	"crypto/sha256"
	"encoding/hex"
	"errors"
	"fmt"
	"net/http"
	"os"
	"path/filepath"
	"regexp"
	"strconv"
	"strings"
	"time"
)

// Headers a kernel signs its calls with.
const (
	FleetHeader     = "X-Kodo-Fleet"
	TimestampHeader = "X-Kodo-Timestamp"
	SignatureHeader = "X-Kodo-Signature"
)

// MaxSkew is how far a call's timestamp may be from the Gatekeeper's clock.
const MaxSkew = time.Minute

var fleetID = regexp.MustCompile(`^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)/([a-z0-9](?:[a-z0-9.-]{0,251}[a-z0-9])?)$`)

// Trust holds the keys of the fleets the Gatekeeper accepts calls from: one
// file per fleet in Dir, named <namespace>.<fleet>, as the operator writes
// them into a Secret that is mounted there. Files are read on every call, so
// a fleet added or removed takes effect when the kubelet updates the mount.
type Trust struct {
	Dir string
}

// SignatureFor is the signature a fleet sends with body at timestamp ts.
func SignatureFor(key []byte, ts string, body []byte) string {
	mac := hmac.New(sha256.New, key)
	mac.Write([]byte(ts))
	mac.Write([]byte("."))
	mac.Write(body)
	return "v1=" + hex.EncodeToString(mac.Sum(nil))
}

// Verify checks that a call was signed by a trusted fleet within MaxSkew of
// now, and returns the fleet as <namespace>/<name>.
func (t Trust) Verify(h http.Header, body []byte, now time.Time) (string, error) {
	fleet := h.Get(FleetHeader)
	m := fleetID.FindStringSubmatch(fleet)
	if m == nil {
		return "", errors.New("missing or malformed fleet")
	}
	ts := h.Get(TimestampHeader)
	sec, err := strconv.ParseInt(ts, 10, 64)
	if err != nil {
		return fleet, errors.New("missing or malformed timestamp")
	}
	if skew := now.Sub(time.Unix(sec, 0)); skew > MaxSkew || skew < -MaxSkew {
		return fleet, fmt.Errorf("timestamp is %s away from now", skew.Round(time.Second))
	}
	key, err := os.ReadFile(filepath.Join(t.Dir, m[1]+"."+m[2]))
	if err != nil {
		return fleet, errors.New("fleet is not trusted")
	}
	want := SignatureFor([]byte(strings.TrimSpace(string(key))), ts, body)
	if !hmac.Equal([]byte(want), []byte(h.Get(SignatureHeader))) {
		return fleet, errors.New("bad signature")
	}
	return fleet, nil
}
