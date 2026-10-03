package gatekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"net/http"
	"strconv"
	"testing"
	"time"
)

// auditQuery signs and sends a search as fleet kodo/prod, or with the given
// key.
func (h *harness) auditQuery(q AuditQuery, key string) (int, AuditResult) {
	h.t.Helper()
	body, _ := json.Marshal(q)
	ts := strconv.FormatInt(time.Now().Unix(), 10)
	req, _ := http.NewRequest(http.MethodPost, h.internal.URL+"/v1/audit/query", bytes.NewReader(body))
	req.Header.Set(FleetHeader, "kodo/prod")
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, SignatureFor([]byte(key), ts, body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out AuditResult
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func adminEvent(action, target string) Event {
	return Event{
		Kind: Admin, Workspace: "team", User: Owner{User: "sub-root", Email: "root@test"},
		Action: action, Target: target, Detail: `{"role":"member"}`,
	}
}

func TestAdminEventsAreAudited(t *testing.T) {
	h := newHarness(t)
	if code := h.event(adminEvent("member.set", "bob@test"), fleetKey); code != http.StatusNoContent {
		t.Fatalf("admin event: %d", code)
	}
	recs := h.audit()
	if len(recs) != 1 {
		t.Fatalf("%d records", len(recs))
	}
	r := recs[0]
	if r.Decision != Admin || r.Action != "member.set" || r.Target != "bob@test" || r.Detail != `{"role":"member"}` ||
		r.User != "sub-root" || r.Email != "root@test" || r.Fleet != "kodo/prod" || r.Workspace != "team" {
		t.Fatalf("record %+v", r)
	}
}

func TestAdminEventsNeedAnAction(t *testing.T) {
	h := newHarness(t)
	noAction := adminEvent("", "x")
	badAction := adminEvent("Delete Everything", "x")
	noUser := adminEvent("user.suspend", "x")
	noUser.User = Owner{}
	big := adminEvent("settings.update", "")
	big.Detail = string(bytes.Repeat([]byte("x"), maxDetail+1))
	for name, e := range map[string]Event{"no action": noAction, "bad action": badAction, "no user": noUser, "big detail": big} {
		if code := h.event(e, fleetKey); code != http.StatusBadRequest {
			t.Errorf("%s: %d", name, code)
		}
	}
	if code := h.event(adminEvent("user.suspend", "x"), "not-the-key"); code != http.StatusUnauthorized {
		t.Fatalf("untrusted: %d", code)
	}
}

func TestAuditSearchFindsTheFleetsRecordsNewestFirst(t *testing.T) {
	h := newHarness(t)
	ctx := context.Background()
	now := time.Now().UTC()
	add := func(at time.Time, r Record) {
		r.Time = at
		if _, err := h.srv.Audit.Append(ctx, r); err != nil {
			t.Fatal(err)
		}
	}
	add(now.Add(-3*time.Hour), Record{Decision: Allowed, Fleet: "kodo/prod", Workspace: "team", User: alice, Email: "alice@test", Cell: "c1", Blueprint: "notes"})
	add(now.Add(-2*time.Hour), Record{Decision: Denied, Fleet: "kodo/prod", Workspace: "lab", User: "sub-bob", Email: "bob@test", Cell: "c2"})
	add(now.Add(-time.Hour), Record{Decision: Admin, Fleet: "kodo/prod", Workspace: "team", User: "sub-root", Email: "root@test", Action: "blueprint.withdraw", Target: "notes@2"})
	add(now.Add(-30*time.Hour), Record{Decision: Allowed, Fleet: "kodo/prod", Workspace: "team", User: alice, Cell: "c1"})
	// Another fleet's record is never shown.
	add(now.Add(-time.Minute), Record{Decision: Allowed, Fleet: "kodo/other", Workspace: "team", User: alice, Cell: "c9"})

	_, all := h.auditQuery(AuditQuery{Days: 1, Limit: 10}, fleetKey)
	if len(all.Records) != 3 || all.Records[0].Action != "blueprint.withdraw" || all.Records[2].Cell != "c1" {
		t.Fatalf("today: %+v", all.Records)
	}
	if _, two := h.auditQuery(AuditQuery{Days: 2, Limit: 10}, fleetKey); len(two.Records) != 4 {
		t.Fatalf("two days: %d records", len(two.Records))
	}
	cases := map[string]struct {
		q    AuditQuery
		want int
	}{
		"by email":        {AuditQuery{User: "ALICE@test"}, 1},
		"by subject":      {AuditQuery{User: "sub-bob"}, 1},
		"by workspace":    {AuditQuery{Workspace: "team"}, 2},
		"by cell":         {AuditQuery{Cell: "c2"}, 1},
		"by blueprint":    {AuditQuery{Blueprint: "notes"}, 2},
		"by decision":     {AuditQuery{Decision: Admin}, 1},
		"other fleet's":   {AuditQuery{Cell: "c9"}, 0},
		"several filters": {AuditQuery{Workspace: "team", Decision: Allowed}, 1},
	}
	for name, c := range cases {
		c.q.Days, c.q.Limit = 1, 10
		code, res := h.auditQuery(c.q, fleetKey)
		if code != http.StatusOK || len(res.Records) != c.want {
			t.Errorf("%s: %d, %d records, want %d", name, code, len(res.Records), c.want)
		}
	}
	_, limited := h.auditQuery(AuditQuery{Days: 1, Limit: 1}, fleetKey)
	if len(limited.Records) != 1 || !limited.Truncated {
		t.Fatalf("limit: %+v", limited)
	}
	_, paged := h.auditQuery(AuditQuery{Days: 1, Limit: 10, Before: limited.Records[0].Time.Format(time.RFC3339Nano)}, fleetKey)
	if len(paged.Records) != 2 || paged.Records[0].Decision != Denied {
		t.Fatalf("before: %+v", paged.Records)
	}
}

func TestAuditSearchNeedsATrustedFleetAndBounds(t *testing.T) {
	h := newHarness(t)
	if code, _ := h.auditQuery(AuditQuery{Days: 1, Limit: 10}, "not-the-key"); code != http.StatusUnauthorized {
		t.Fatalf("untrusted: %d", code)
	}
	for _, q := range []AuditQuery{{Days: 0, Limit: 10}, {Days: 32, Limit: 10}, {Days: 1, Limit: 0}, {Days: 1, Limit: 501}, {Days: 1, Limit: 1, Before: "yesterday"}} {
		if code, _ := h.auditQuery(q, fleetKey); code != http.StatusBadRequest {
			t.Errorf("%+v: %d", q, code)
		}
	}
}
