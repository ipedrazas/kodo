package gatekeeper

import (
	"bytes"
	"context"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

const (
	resendKey = "re_test_key"
	send      = "email:outbox:send"
	from      = "Alice <alice@acme.test>"
)

// fakeResend plays Resend: it checks keys, lists one verified domain, and
// records every email it is asked to send. Sends wait while block is set.
type fakeResend struct {
	*httptest.Server
	mu    sync.Mutex
	sent  []sentEmail
	block chan struct{}
	// arrived is signalled when a send reaches the fake.
	arrived chan struct{}
}

type sentEmail struct {
	Auth, Key string
	Body      map[string]any
}

func newFakeResend(t *testing.T) *fakeResend {
	f := &fakeResend{arrived: make(chan struct{}, 100)}
	f.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		auth := r.Header.Get("Authorization")
		w.Header().Set("Content-Type", "application/json")
		switch {
		case r.URL.Path == "/domains" && auth == "Bearer "+resendKey:
			_, _ = io.WriteString(w, `{"data":[{"name":"acme.test","status":"verified"},{"name":"pending.test","status":"pending"}]}`)
		case r.URL.Path == "/domains" && auth == "Bearer re_sending_only":
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"statusCode":401,"name":"restricted_api_key","message":"This API key is restricted to only send emails"}`)
		case r.URL.Path == "/emails" && r.Method == http.MethodPost && auth == "Bearer "+resendKey:
			var body map[string]any
			_ = json.NewDecoder(r.Body).Decode(&body)
			f.mu.Lock()
			f.sent = append(f.sent, sentEmail{auth, r.Header.Get("Idempotency-Key"), body})
			n, block := len(f.sent), f.block
			f.mu.Unlock()
			f.arrived <- struct{}{}
			if block != nil {
				<-block
			}
			_, _ = fmt.Fprintf(w, `{"id":"email-%d"}`, n)
		default:
			w.WriteHeader(http.StatusUnauthorized)
			_, _ = io.WriteString(w, `{"statusCode":401,"name":"validation_error","message":"API key is invalid"}`)
		}
	}))
	t.Cleanup(func() {
		f.mu.Lock()
		if f.block != nil {
			close(f.block)
			f.block = nil
		}
		f.mu.Unlock()
		f.Close()
	})
	return f
}

func (f *fakeResend) emails() []sentEmail {
	f.mu.Lock()
	defer f.mu.Unlock()
	return append([]sentEmail(nil), f.sent...)
}

// as sends a request to the Gatekeeper's user API as a user.
func (h *harness) as(identity, method, path, body string) (int, map[string]any) {
	return h.asOn(h.public.URL, identity, method, path, body)
}

func (h *harness) asOn(base, identity, method, path, body string) (int, map[string]any) {
	var r io.Reader
	if body != "" {
		r = strings.NewReader(body)
	}
	req, _ := http.NewRequest(method, base+"/gatekeeper/api"+path, r)
	req.Header.Set(IdentityHeader, identity)
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out map[string]any
	_ = json.NewDecoder(res.Body).Decode(&out)
	return res.StatusCode, out
}

func (h *harness) connectEmail(account string) {
	h.t.Helper()
	body, _ := json.Marshal(map[string]string{"token": resendKey, "account": account})
	if status, out := h.as("alice-token", "PUT", "/connections/email", string(body)); status != http.StatusOK {
		h.t.Fatalf("connecting email: %d %v", status, out)
	}
}

func sendCall(message string) Call {
	return Call{
		Workspace: "team", Cell: "cabc", Blueprint: "mailer", Version: "1",
		Owner: Owner{User: alice, Email: "alice@test"}, Grants: []string{send}, Capability: send,
		Request: CallRequest{Method: "POST", Body: []byte(message)},
	}
}

const draft = `{"to":"bob@example.com","subject":"Quarterly numbers","text":"Hi Bob,\nhere they are."}`

// queue connects alice's email and queues one send, returning its id.
func (h *harness) queue() string {
	h.t.Helper()
	h.connectEmail(from)
	status, a := h.call(sendCall(draft), fleetKey)
	if status != http.StatusOK || a.Status != http.StatusAccepted {
		h.t.Fatalf("queueing: %d %+v %s", status, a, a.Body)
	}
	return a.Headers["x-kodo-approval"]
}

// query asks for approvals as the kernel of fleet kodo/prod would for cell.
func (h *harness) query(cell string, ids ...string) []ApprovalStatus {
	h.t.Helper()
	body, _ := json.Marshal(ApprovalQuery{Cell: cell, Owner: Owner{User: alice}, IDs: ids})
	ts := fmt.Sprint(time.Now().Unix())
	req, _ := http.NewRequest(http.MethodPost, h.internal.URL+"/v1/approvals/query", bytes.NewReader(body))
	req.Header.Set(FleetHeader, "kodo/prod")
	req.Header.Set(TimestampHeader, ts)
	req.Header.Set(SignatureHeader, SignatureFor([]byte(fleetKey), ts, body))
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		h.t.Fatal(err)
	}
	defer func() { _ = res.Body.Close() }()
	var out struct{ Approvals []ApprovalStatus }
	if err := json.NewDecoder(res.Body).Decode(&out); err != nil {
		h.t.Fatalf("query: %d %v", res.StatusCode, err)
	}
	return out.Approvals
}

func (h *harness) decisions(id string) []Record {
	var out []Record
	for _, r := range h.audit() {
		if r.Approval == id {
			out = append(out, r)
		}
	}
	return out
}

// replica is a second Gatekeeper on the same bucket, optionally with its
// clock moved on.
func (h *harness) replica(skew time.Duration) *httptest.Server {
	other := *h.srv
	other.Now = func() time.Time { return time.Now().Add(skew) }
	srv := httptest.NewServer(other.Public())
	h.t.Cleanup(srv.Close)
	return srv
}

func TestSendWaitsForApproval(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	if !ValidApprovalID(id) {
		t.Fatalf("approval id %q", id)
	}
	if len(h.resend.emails()) != 0 {
		t.Fatal("the email was sent before approval")
	}
	status, out := h.as("alice-token", "GET", "/approvals?state=pending", "")
	list := out["approvals"].([]any)
	if status != http.StatusOK || len(list) != 1 {
		t.Fatalf("pending list: %d %v", status, out)
	}
	ap := list[0].(map[string]any)
	summary := fmt.Sprint(ap["summary"])
	for _, want := range []string{"Send an email", `"Alice" <alice@acme.test>`, "bob@example.com", "Quarterly numbers", "here they are."} {
		if !strings.Contains(summary, want) {
			t.Errorf("summary lacks %q: %s", want, summary)
		}
	}
	if ap["cell"] != "cabc" || ap["blueprint"] != "mailer" || ap["fleet"] != "kodo/prod" || ap["state"] != StatePending {
		t.Errorf("approval %v", ap)
	}
	if got := h.query("cabc", id); got[0].State != StatePending || got[0].Capability != send {
		t.Errorf("gadget sees %+v", got)
	}
	recs := h.decisions(id)
	if len(recs) != 1 || recs[0].Decision != Queued || recs[0].Cell != "cabc" || recs[0].Grant != send {
		t.Errorf("audit %+v", recs)
	}
}

func TestApprovingRunsTheCallOnce(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	status, out := h.as("alice-token", "POST", "/approvals/"+id+"/approve", "")
	ap := out["approval"].(map[string]any)
	if status != http.StatusOK || ap["state"] != StateDone || ap["decidedBy"] != "alice@test" {
		t.Fatalf("approve: %d %v", status, out)
	}
	sent := h.resend.emails()
	if len(sent) != 1 {
		t.Fatalf("%d emails sent", len(sent))
	}
	if sent[0].Key != id || sent[0].Auth != "Bearer "+resendKey || sent[0].Body["from"] != `"Alice" <alice@acme.test>` ||
		sent[0].Body["subject"] != "Quarterly numbers" {
		t.Errorf("sent %+v", sent[0])
	}
	if status, out := h.as("alice-token", "POST", "/approvals/"+id+"/approve", ""); status != http.StatusConflict ||
		!strings.Contains(fmt.Sprint(out["error"]), "already done") {
		t.Errorf("second approve: %d %v", status, out)
	}
	if len(h.resend.emails()) != 1 {
		t.Error("a second approve sent again")
	}
	got := h.query("cabc", id)[0]
	if got.State != StateDone || got.Result == nil || got.Result.Status != 200 || string(got.Result.Body) != `{"id":"email-1"}` {
		t.Errorf("gadget sees %+v", got)
	}

	var trail []string
	for _, r := range h.decisions(id) {
		trail = append(trail, r.Decision)
		if r.Decision == Approved && (r.User != alice || r.Email != "alice@test" || r.Time.IsZero()) {
			t.Errorf("approval not attributed: %+v", r)
		}
		if r.Decision == Executed && r.Status != 200 {
			t.Errorf("executed record %+v", r)
		}
	}
	if strings.Join(trail, ",") != "queued,approved,executed" {
		t.Errorf("audit trail %v", trail)
	}
}

func TestRacingReplicasRunTheCallAtMostOnce(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	replicas := []string{h.public.URL, h.replica(0).URL, h.replica(0).URL}
	var wg sync.WaitGroup
	statuses := make(chan int, 30)
	for i := range 30 {
		wg.Add(1)
		go func() {
			defer wg.Done()
			status, _ := h.asOn(replicas[i%len(replicas)], "alice-token", "POST", "/approvals/"+id+"/approve", "")
			statuses <- status
		}()
	}
	wg.Wait()
	close(statuses)
	count := map[int]int{}
	for s := range statuses {
		count[s]++
	}
	if count[http.StatusOK] != 1 || count[http.StatusConflict] != 29 {
		t.Errorf("statuses %v", count)
	}
	if n := len(h.resend.emails()); n != 1 {
		t.Fatalf("%d emails sent", n)
	}
	executed := 0
	for _, r := range h.decisions(id) {
		if r.Decision == Executed || r.Decision == Approved {
			executed++
		}
	}
	if executed != 2 {
		t.Errorf("%d approved/executed records, want one each", executed)
	}
}

func TestRejectingNeverRunsTheCall(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	status, out := h.as("alice-token", "POST", "/approvals/"+id+"/reject", "")
	if status != http.StatusOK || out["approval"].(map[string]any)["state"] != StateRejected {
		t.Fatalf("reject: %d %v", status, out)
	}
	if status, _ := h.as("alice-token", "POST", "/approvals/"+id+"/approve", ""); status != http.StatusConflict {
		t.Errorf("approve after reject: %d", status)
	}
	if len(h.resend.emails()) != 0 {
		t.Fatal("a rejected email was sent")
	}
	if got := h.query("cabc", id)[0]; got.State != StateRejected || got.Result != nil {
		t.Errorf("gadget sees %+v", got)
	}
	recs := h.decisions(id)
	if last := recs[len(recs)-1]; last.Decision != Rejected || last.User != alice || last.Email != "alice@test" {
		t.Errorf("audit %+v", recs)
	}
}

func TestAReplicaKilledMidCallLeavesTheApprovalFailed(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	h.resend.mu.Lock()
	h.resend.block = make(chan struct{})
	h.resend.mu.Unlock()

	// Replica A approves; the send reaches Resend and hangs there, as if A
	// died mid-call.
	done := make(chan map[string]any)
	go func() {
		_, out := h.as("alice-token", "POST", "/approvals/"+id+"/approve", "")
		done <- out
	}()
	<-h.resend.arrived

	// Replica B, past the stale limit, reports it failed and does not retry.
	b := h.replica(DefaultApprovalStale + time.Second)
	_, out := h.asOn(b.URL, "alice-token", "GET", "/approvals/"+id, "")
	ap := out["approval"].(map[string]any)
	if ap["state"] != StateFailed || !strings.Contains(fmt.Sprint(ap["reason"]), "will not be retried") {
		t.Fatalf("after the stale limit: %v", ap)
	}
	if status, _ := h.asOn(b.URL, "alice-token", "POST", "/approvals/"+id+"/approve", ""); status != http.StatusConflict {
		t.Errorf("approving a failed approval: %d", status)
	}

	// A finishing late does not change what was reported.
	h.resend.mu.Lock()
	close(h.resend.block)
	h.resend.block = nil
	h.resend.mu.Unlock()
	<-done
	if got := h.query("cabc", id)[0]; got.State != StateFailed {
		t.Errorf("after A finished: %+v", got)
	}
	if n := len(h.resend.emails()); n != 1 {
		t.Errorf("%d sends, want the one A started", n)
	}
	failed := 0
	for _, r := range h.decisions(id) {
		if r.Decision == Failed {
			failed++
		}
	}
	if failed != 1 {
		t.Errorf("%d failure records", failed)
	}
}

func TestAnApprovalLeftExecutingIsReportedFailed(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	// What a replica leaves behind if it dies right after taking the approval.
	ap, version, err := h.srv.Approvals.Get(context.Background(), alice, id)
	if err != nil {
		t.Fatal(err)
	}
	then := time.Now().Add(-2 * DefaultApprovalStale)
	ap.State, ap.DecidedAt, ap.ExecutingAt, ap.DecidedBy = StateExecuting, &then, &then, "alice@test"
	if _, err := h.srv.Approvals.Replace(context.Background(), ap, version); err != nil {
		t.Fatal(err)
	}
	if got := h.query("cabc", id)[0]; got.State != StateFailed {
		t.Fatalf("gadget sees %+v", got)
	}
	if len(h.resend.emails()) != 0 {
		t.Error("the call was retried")
	}
}

func TestPendingApprovalsSurviveARestart(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	// A new Gatekeeper on the same bucket: nothing is held in memory.
	restarted := h.replica(0)
	status, out := h.asOn(restarted.URL, "alice-token", "POST", "/approvals/"+id+"/approve", "")
	if status != http.StatusOK || out["approval"].(map[string]any)["state"] != StateDone {
		t.Fatalf("approve after restart: %d %v", status, out)
	}
}

func TestUnapprovedCallsExpire(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	later := h.replica(DefaultApprovalTTL + time.Hour)
	for range 2 {
		_, out := h.asOn(later.URL, "alice-token", "GET", "/approvals/"+id, "")
		if out["approval"].(map[string]any)["state"] != StateExpired {
			t.Fatalf("after the TTL: %v", out)
		}
	}
	if status, _ := h.asOn(later.URL, "alice-token", "POST", "/approvals/"+id+"/approve", ""); status != http.StatusConflict {
		t.Errorf("approving an expired approval: %d", status)
	}
	expired := 0
	for _, r := range h.decisions(id) {
		if r.Decision == Expired {
			expired++
		}
	}
	if expired != 1 || len(h.resend.emails()) != 0 {
		t.Errorf("%d expiry records, %d emails", expired, len(h.resend.emails()))
	}
}

func TestApprovalsBelongToTheCellsOwner(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	if status, _ := h.as("bob-token", "POST", "/approvals/"+id+"/approve", ""); status != http.StatusNotFound {
		t.Errorf("bob approved alice's call: %d", status)
	}
	if _, out := h.as("bob-token", "GET", "/approvals", ""); len(out["approvals"].([]any)) != 0 {
		t.Errorf("bob sees %v", out)
	}
	for _, bad := range []string{"../../vault/x", "20261001t000000-zzzzzzzzzzzz"} {
		if status, _ := h.as("alice-token", "GET", "/approvals/"+bad, ""); status != http.StatusNotFound {
			t.Errorf("%s: %d", bad, status)
		}
	}
	req, _ := http.NewRequest(http.MethodPost, h.public.URL+"/gatekeeper/api/approvals/"+id+"/approve", nil)
	req.Header.Set(IdentityHeader, "alice-token")
	req.Header.Set("Origin", "https://cabc.g.example.test")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusForbidden || len(h.resend.emails()) != 0 {
		t.Errorf("a cross-origin approve: %d", res.StatusCode)
	}
	res, _ = http.Get(h.public.URL + "/gatekeeper/")
	_ = res.Body.Close()
	if res.Header.Get("X-Frame-Options") != "DENY" || !strings.Contains(res.Header.Get("Content-Security-Policy"), "frame-ancestors 'none'") {
		t.Errorf("the page can be framed: %v", res.Header)
	}
}

func TestAGadgetSeesOnlyItsCellsApprovals(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	for name, got := range map[string]ApprovalStatus{
		"other cell": h.query("cother", id)[0],
		"no such id": h.query("cabc", "20261001t000000-000000000000")[0],
		"malformed":  h.query("cabc", "../x")[0],
	} {
		if got.State != StateUnknown || got.Capability != "" {
			t.Errorf("%s: %+v", name, got)
		}
	}
}

func TestSendsAreCheckedBeforeTheyAreQueued(t *testing.T) {
	h := newHarness(t)
	_, a := h.call(sendCall(draft), fleetKey)
	if a.Status != http.StatusForbidden || !strings.Contains(string(a.Body), "not connected email") {
		t.Errorf("without a connection: %+v %s", a, a.Body)
	}
	h.connectEmail(from)
	for name, msg := range map[string]string{
		"sets from":        `{"to":"bob@example.com","from":"ceo@acme.test","subject":"s","text":"t"}`,
		"sets headers":     `{"to":"bob@example.com","subject":"s","text":"t","headers":{"Bcc":"x@y.z"}}`,
		"header injection": `{"to":"bob@example.com","subject":"s\r\nBcc: x@y.z","text":"t"}`,
		"bad address":      `{"to":"not an address","subject":"s","text":"t"}`,
		"no recipient":     `{"subject":"s","text":"t"}`,
		"no content":       `{"to":"bob@example.com","subject":"s"}`,
		"not json":         `to=bob`,
		"too many":         `{"to":[` + strings.Repeat(`"a@b.c",`, 50) + `"a@b.c"],"subject":"s","text":"t"}`,
	} {
		_, a := h.call(sendCall(msg), fleetKey)
		if a.Status != http.StatusForbidden || a.Headers["x-kodo-decision"] != Denied {
			t.Errorf("%s: %+v %s", name, a, a.Body)
		}
	}
	c := sendCall(draft)
	c.Request.Method = "GET"
	if _, a := h.call(c, fleetKey); a.Status != http.StatusForbidden {
		t.Errorf("GET on a send capability: %+v", a)
	}
	c = sendCall(draft)
	c.Capability, c.Grants = "email:outbox:frobnicate", []string{"email:outbox:frobnicate"}
	if _, a := h.call(c, fleetKey); a.Status != http.StatusForbidden || !strings.Contains(string(a.Body), "unknown verb") {
		t.Errorf("unknown verb: %s", a.Body)
	}
	if ids, _ := h.srv.Approvals.IDs(context.Background(), alice); len(ids) != 0 {
		t.Errorf("denied calls were queued: %v", ids)
	}
}

func TestAChangedConnectionFailsTheApproval(t *testing.T) {
	h := newHarness(t)
	id := h.queue()
	h.connectEmail("Mallory <mallory@acme.test>")
	_, out := h.as("alice-token", "POST", "/approvals/"+id+"/approve", "")
	ap := out["approval"].(map[string]any)
	if ap["state"] != StateFailed || !strings.Contains(fmt.Sprint(ap["reason"]), "connection changed") {
		t.Errorf("approve: %v", ap)
	}
	if len(h.resend.emails()) != 0 {
		t.Error("sent from another address than the one approved")
	}
}

func TestQueueingFailsClosedWithoutTheAuditLog(t *testing.T) {
	h := newHarness(t)
	h.connectEmail(from)
	h.srv.Audit = Audit{Store: failingStore{h.store}}
	_, a := h.call(sendCall(draft), fleetKey)
	if a.Status != http.StatusServiceUnavailable {
		t.Fatalf("queued without an audit record: %+v", a)
	}
	if ids, _ := h.srv.Approvals.IDs(context.Background(), alice); len(ids) != 0 {
		t.Errorf("approval kept: %v", ids)
	}
}

func TestOnlyRecentApprovalsCanBePending(t *testing.T) {
	a := Approvals{TTL: time.Hour}
	now := time.Date(2026, 10, 1, 12, 0, 0, 0, time.UTC)
	ids := []string{"20261001t115959-000000000000", "20261001t110001-000000000000", "20261001t105959-000000000000", "20260930t120000-000000000000"}
	if got := a.Pending(ids, now); len(got) != 2 || got[1] != ids[1] {
		t.Errorf("pending candidates %v", got)
	}
}
