package gatekeeper

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"time"
)

// Decisions recorded in the audit log.
const (
	Allowed      = "allowed"
	Denied       = "denied"
	Rejected     = "rejected" // the call did not come from a trusted fleet
	Connected    = "connected"
	Disconnected = "disconnected"
)

// Record is one audit entry: who called what, under which grant, and what
// the Gatekeeper decided.
type Record struct {
	Time      time.Time `json:"time"`
	Decision  string    `json:"decision"`
	Reason    string    `json:"reason,omitempty"`
	Fleet     string    `json:"fleet,omitempty"`
	Workspace string    `json:"workspace,omitempty"`
	User      string    `json:"user"`
	Email     string    `json:"email,omitempty"`
	Blueprint string    `json:"blueprint,omitempty"`
	Version   string    `json:"version,omitempty"`
	Cell      string    `json:"cell,omitempty"`
	Grant     string    `json:"grant,omitempty"`
	Method    string    `json:"method,omitempty"`
	Path      string    `json:"path,omitempty"`
	Provider  string    `json:"provider,omitempty"`
}

// Audit appends records to audit/<yyyy>/<mm>/<dd>/ in the store, one object
// each, created with a conditional write so no record is ever overwritten.
type Audit struct {
	Store Store
}

func (a Audit) Append(ctx context.Context, r Record) (string, error) {
	if r.Time.IsZero() {
		r.Time = time.Now()
	}
	r.Time = r.Time.UTC()
	data, err := json.Marshal(r)
	if err != nil {
		return "", err
	}
	for range 3 {
		suffix := make([]byte, 6)
		if _, err := rand.Read(suffix); err != nil {
			return "", err
		}
		key := fmt.Sprintf("audit/%s/%s-%s.json", r.Time.Format("2006/01/02"),
			r.Time.Format("20060102T150405.000000000Z"), hex.EncodeToString(suffix))
		err := a.Store.Create(ctx, key, data)
		if !errors.Is(err, ErrExists) {
			return key, err
		}
	}
	return "", ErrExists
}
