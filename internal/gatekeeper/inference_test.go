package gatekeeper

import (
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"testing"
	"time"
)

const invoke = "inference:model/fast:invoke"

// fakeGateway plays the inference gateway: it records each call and answers
// with a chat completion, or with what `answer` returns.
type fakeGateway struct {
	*httptest.Server
	calls  []*http.Request
	bodies []map[string]any
	answer func(w http.ResponseWriter, r *http.Request)
}

func newFakeGateway(t *testing.T) *fakeGateway {
	g := &fakeGateway{}
	g.Server = httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]any
		_ = json.NewDecoder(r.Body).Decode(&body)
		g.calls = append(g.calls, r)
		g.bodies = append(g.bodies, body)
		if g.answer != nil {
			g.answer(w, r)
			return
		}
		w.Header().Set("Content-Type", "application/json")
		w.Header().Set("Set-Cookie", "upstream=1")
		_, _ = io.WriteString(w, `{"model":"backend-model-1","choices":[{"message":{"role":"assistant","content":"hi"}}],`+
			`"usage":{"prompt_tokens":12,"completion_tokens":3,"total_tokens":15}}`)
	}))
	t.Cleanup(g.Close)
	return g
}

func inferenceHarness(t *testing.T) (*harness, *fakeGateway) {
	h := newHarness(t)
	g := newFakeGateway(t)
	h.srv.Providers["inference"] = Inference{URL: g.URL, Key: "gateway-key"}
	return h, g
}

func chatCall(capability, body string, grants ...string) Call {
	c := readCall(capability, "POST", "/chat/completions", grants...)
	c.Request.Body = []byte(body)
	return c
}

const hello = `{"messages":[{"role":"user","content":"hello"}],"max_tokens":16}`

func TestInferenceCallsTheGrantedModelAsTheOwner(t *testing.T) {
	h, g := inferenceHarness(t)
	// No connection: the platform holds the backends' keys.
	status, a := h.call(chatCall(invoke, `{"model":"something-else","messages":[{"role":"user","content":"hi"}]}`, invoke), fleetKey)
	if status != http.StatusOK || a.Status != http.StatusOK {
		t.Fatalf("got %d %+v", status, a)
	}
	if len(g.calls) != 1 {
		t.Fatalf("gateway got %d calls", len(g.calls))
	}
	r := g.calls[0]
	if r.Method != http.MethodPost || r.URL.Path != "/v1/chat/completions" {
		t.Errorf("gateway got %s %s", r.Method, r.URL.Path)
	}
	if g.bodies[0]["model"] != "fast" {
		t.Errorf("model %v; the grant names the model", g.bodies[0]["model"])
	}
	want := map[string]string{
		GatewayKeyHeader: "gateway-key", InferenceUserHeader: alice, InferenceWSHeader: "kodo/prod/team",
		InferenceBPHeader: "viewer",
	}
	for k, v := range want {
		if got := r.Header.Get(k); got != v {
			t.Errorf("%s: %q, want %q", k, got, v)
		}
	}
	// What the gateway cannot remove carries no email address and no cell.
	for k, vs := range r.Header {
		for _, v := range vs {
			if strings.Contains(v, "alice@test") || strings.Contains(v, "cabc") {
				t.Errorf("%s: %q reached the gateway", k, v)
			}
		}
	}
	if r.Header.Get("Authorization") != "" {
		t.Error("an Authorization header reached the gateway")
	}
	if a.Usage == nil || *a.Usage != (Usage{Model: "backend-model-1", Input: 12, Output: 3, Total: 15}) {
		t.Errorf("usage %+v", a.Usage)
	}
	if _, ok := a.Headers["set-cookie"]; ok || a.Headers["x-kodo-decision"] != Allowed {
		t.Errorf("headers %v", a.Headers)
	}
	var decisions []string
	for _, rec := range h.audit() {
		decisions = append(decisions, rec.Decision)
		if rec.Decision == Metered && (rec.Usage == nil || rec.Usage.Total != 15 || rec.Status != 200 ||
			rec.Cell != "cabc" || rec.User != alice || rec.Workspace != "team" || rec.Grant != invoke) {
			t.Errorf("metered record %+v", rec)
		}
	}
	if strings.Join(decisions, ",") != "allowed,metered" && strings.Join(decisions, ",") != "metered,allowed" {
		t.Errorf("audit decisions %v", decisions)
	}
}

func TestInferenceRefusesCallsOutsideTheGrant(t *testing.T) {
	h, g := inferenceHarness(t)
	cases := []struct {
		name string
		call Call
		want string
	}{
		{"not granted", chatCall(invoke, hello), "no grant"},
		{"another model", chatCall("inference:model/big:invoke", hello, invoke), "no grant"},
		{"unknown verb", chatCall("inference:model/fast:train", hello, "inference:model/fast:train"), "unknown verb"},
		{"read verb", readCall("inference:model/fast:read", "GET", "", "inference:model/fast:read"), "only the invoke verb"},
		{"bad resource", chatCall("inference:fast:invoke", hello, "inference:fast:invoke"), "use model/"},
		{"GET", readCall(invoke, "GET", "/chat/completions", invoke), "takes POST"},
		{"other path", func() Call { c := chatCall(invoke, hello, invoke); c.Request.Path = "/embeddings"; return c }(), "serves /chat/completions"},
		{"not JSON", chatCall(invoke, "hello", invoke), "must be a chat completion"},
		{"no messages", chatCall(invoke, `{"messages":[]}`, invoke), "non-empty list"},
		{"stream", chatCall(invoke, `{"messages":[{"role":"user","content":"x"}],"stream":true}`, invoke), "streaming"},
		{"n", chatCall(invoke, `{"messages":[{"role":"user","content":"x"}],"n":3}`, invoke), "n must be 1"},
		{"routing fields", chatCall(invoke, `{"messages":[{"role":"user","content":"x"}],"models":["x"],"provider":{}}`, invoke), "do not take models, provider"},
	}
	for _, tc := range cases {
		t.Run(tc.name, func(t *testing.T) {
			status, a := h.call(tc.call, fleetKey)
			if status != http.StatusOK || a.Status != http.StatusForbidden || !strings.Contains(string(a.Body), tc.want) {
				t.Fatalf("got %d %d %s, want a denial with %q", status, a.Status, a.Body, tc.want)
			}
		})
	}
	if len(g.calls) != 0 {
		t.Errorf("the gateway got %d calls", len(g.calls))
	}
}

func TestInferenceOverBudgetSaysSo(t *testing.T) {
	h, g := inferenceHarness(t)
	g.answer = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("X-Ratelimit-Limit", "100, 100;w=2592000")
		w.Header().Set("X-Ratelimit-Remaining", "0")
		w.Header().Set("X-Ratelimit-Reset", "1285")
		w.WriteHeader(http.StatusTooManyRequests)
	}
	_, a := h.call(chatCall(invoke, hello, invoke), fleetKey)
	if a.Status != http.StatusTooManyRequests || a.Usage != nil || !strings.Contains(string(a.Body), "over the inference budget") ||
		a.Headers["x-ratelimit-reset"] != "1285" || a.Headers["content-type"] != "application/json" {
		t.Fatalf("got %+v %s", a, a.Body)
	}
	metered := false
	for _, rec := range h.audit() {
		metered = metered || (rec.Decision == Metered && rec.Status == http.StatusTooManyRequests && rec.Usage == nil)
	}
	if !metered {
		t.Errorf("the refusal is not in the audit log: %+v", h.audit())
	}
}

func TestInferenceCallsAreTimeLimited(t *testing.T) {
	h, g := inferenceHarness(t)
	h.srv.Providers["inference"] = Inference{URL: g.URL, Timeout: 100 * time.Millisecond}
	release := make(chan struct{})
	t.Cleanup(func() { close(release) })
	g.answer = func(w http.ResponseWriter, r *http.Request) {
		select {
		case <-release:
		case <-r.Context().Done():
		}
	}
	started := time.Now()
	_, a := h.call(chatCall(invoke, hello, invoke), fleetKey)
	if a.Status != http.StatusBadGateway || time.Since(started) > 3*time.Second {
		t.Fatalf("got %d after %s: %s", a.Status, time.Since(started), a.Body)
	}
}

func TestInferenceIsNotAConnection(t *testing.T) {
	h, _ := inferenceHarness(t)
	req, _ := http.NewRequest(http.MethodGet, h.public.URL+"/gatekeeper/api/connections", nil)
	req.Header.Set(IdentityHeader, "alice-token")
	res, err := http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	body, _ := io.ReadAll(res.Body)
	_ = res.Body.Close()
	if strings.Contains(string(body), `"inference"`) {
		t.Errorf("inference is offered as a connection: %s", body)
	}
	req, _ = http.NewRequest(http.MethodPut, h.public.URL+"/gatekeeper/api/connections/inference",
		strings.NewReader(`{"token":"x"}`))
	req.Header.Set(IdentityHeader, "alice-token")
	res, err = http.DefaultClient.Do(req)
	if err != nil {
		t.Fatal(err)
	}
	_ = res.Body.Close()
	if res.StatusCode != http.StatusNotFound {
		t.Errorf("connecting inference: %d", res.StatusCode)
	}
}

func TestABackendsOwn429IsPassedOn(t *testing.T) {
	h, g := inferenceHarness(t)
	g.answer = func(w http.ResponseWriter, _ *http.Request) {
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(http.StatusTooManyRequests)
		_, _ = io.WriteString(w, `{"error":{"message":"provider is busy"}}`)
	}
	_, a := h.call(chatCall(invoke, hello, invoke), fleetKey)
	if a.Status != http.StatusTooManyRequests || !strings.Contains(string(a.Body), "provider is busy") {
		t.Fatalf("got %d %s", a.Status, a.Body)
	}
}
