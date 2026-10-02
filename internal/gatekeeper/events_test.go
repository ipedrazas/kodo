package gatekeeper

import (
	"bytes"
	"encoding/json"
	"net/http"
	"strconv"
	"strings"
	"testing"
	"time"
)

// event signs and sends an event as fleet kodo/prod, or with the given key.
func (h *harness) event(e any, key string) int {
	h.t.Helper()
	body, _ := json.Marshal(e)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req, _ := http.NewRequest(http.MethodPost, h.internal.URL+"/v1/events", bytes.NewReader(body))
	req.Header.Set(FleetHeader, "kodo/prod")
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, SignatureFor([]byte(key), ts, body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	_ = res.Body.Close()
	return res.StatusCode
}

func authoredEvent() Event {
	return Event{
		Kind: Authored, Workspace: "kodo/prod/team", User: Owner{User: alice, Email: "alice@test"},
		Blueprint: "echo", Version: "1", Bundle: strings.Repeat("a", 64),
		Capabilities: []string{"web:hn.algolia.com/api/v1:read"}, Session: "s123",
	}
}

func TestBlueprintEventsAreAudited(t *testing.T) {
	h := newHarness(t)
	authored := authoredEvent()
	published := authored
	published.Kind, published.Session = Published, ""
	for _, e := range []Event{authored, published} {
		if code := h.event(e, fleetKey); code != http.StatusNoContent {
			t.Fatalf("%s: %d", e.Kind, code)
		}
	}
	recs := h.audit()
	if len(recs) != 2 {
		t.Fatalf("%d records, want 2", len(recs))
	}
	byKind := map[string]Record{}
	for _, r := range recs {
		byKind[r.Decision] = r
	}
	a := byKind[Authored]
	if a.Fleet != "kodo/prod" || a.User != alice || a.Email != "alice@test" || a.Blueprint != "echo" || a.Version != "1" ||
		a.Cell != "s123" || a.Bundle != authored.Bundle || len(a.Capabilities) != 1 {
		t.Fatalf("authored record %+v", a)
	}
	if p := byKind[Published]; p.User != alice || p.Version != "1" || p.Cell != "" {
		t.Fatalf("published record %+v", p)
	}
}

func TestBlueprintEventsNeedATrustedFleetAndAShape(t *testing.T) {
	h := newHarness(t)
	if code := h.event(authoredEvent(), "not-the-key"); code != http.StatusUnauthorized {
		t.Fatalf("untrusted event: %d", code)
	}
	bad := authoredEvent()
	bad.Kind = "deleted"
	noUser := authoredEvent()
	noUser.User = Owner{}
	noBundle := authoredEvent()
	noBundle.Bundle = "abc"
	for _, e := range []Event{bad, noUser, noBundle} {
		if code := h.event(e, fleetKey); code != http.StatusBadRequest {
			t.Fatalf("%+v: %d", e, code)
		}
	}
	for _, r := range h.audit() {
		if r.Decision == Authored || r.Decision == Published {
			t.Fatalf("a bad event was recorded: %+v", r)
		}
	}
}

func TestBlueprintEventsFailWithoutTheAuditLog(t *testing.T) {
	h := newHarness(t)
	h.srv.Audit = Audit{Store: failingStore{h.store}}
	if code := h.event(authoredEvent(), fleetKey); code != http.StatusServiceUnavailable {
		t.Fatalf("event without an audit log: %d", code)
	}
}
