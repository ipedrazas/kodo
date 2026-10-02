package agent

import (
	"context"
	"encoding/json"
	"io"
	"net/http"
	"net/http/httptest"
	"strings"
	"sync"
	"testing"
	"time"
)

// fakeKernel plays the kernel API for one session. Model calls are answered
// by `model` in turn; runs by `run`.
type fakeKernel struct {
	t        *testing.T
	mu       sync.Mutex
	session  Session
	turn     string
	token    string
	ended    bool
	requests []map[string]any // model requests
	model    func(n int, req map[string]any) (int, string)
	run      func(code string) RunResult
	docs     map[string]string
	auths    []string // the auth header of every call after the turn started
	block    chan struct{}
}

func newFakeKernel(t *testing.T) (*fakeKernel, *httptest.Server) {
	f := &fakeKernel{
		t:       t,
		session: Session{ID: "s1", Workspace: "team", Title: "New chat", Owner: Owner{User: "u1", Email: "alice@test"}, Grants: []string{"inference:model/agent:invoke"}},
		token:   "turn-token",
		docs:    map[string]string{"skills/email.md": "# Email\nBe brief."},
	}
	srv := httptest.NewServer(http.HandlerFunc(f.serve))
	t.Cleanup(srv.Close)
	return f, srv
}

func (f *fakeKernel) serve(w http.ResponseWriter, r *http.Request) {
	f.mu.Lock()
	defer f.mu.Unlock()
	body, _ := io.ReadAll(r.Body)
	path := strings.TrimPrefix(r.URL.Path, "/api/workspaces/team")
	identity, turn := r.Header.Get(IdentityHeader), r.Header.Get(TurnHeader)
	if f.turn != "" && !strings.HasSuffix(path, "/turns") {
		f.auths = append(f.auths, "identity="+identity+" turn="+turn)
	}
	needTurn := func() bool {
		if turn != f.token || f.ended {
			http.Error(w, `{"error":"bad turn"}`, http.StatusUnauthorized)
			return false
		}
		return true
	}
	switch {
	case r.Method == "POST" && path == "/sessions":
		var b map[string]any
		_ = json.Unmarshal(body, &b)
		f.session.Grants = nil
		for _, g := range b["grants"].([]any) {
			f.session.Grants = append(f.session.Grants, g.(string))
		}
		writeJSON(w, 201, f.session)
	case r.Method == "POST" && path == "/sessions/s1/turns":
		if identity != "alice-id-token" {
			http.Error(w, `{"error":"no identity"}`, http.StatusUnauthorized)
			return
		}
		var b struct{ Content string }
		_ = json.Unmarshal(body, &b)
		f.turn = "t1"
		f.session.Messages = append(f.session.Messages, Message{Seq: len(f.session.Messages) + 1, Role: "user", Content: b.Content})
		f.session.Turn = &Turn{ID: "t1", ExpiresAt: time.Now().Add(time.Minute).UnixMilli()}
		writeJSON(w, 201, map[string]any{"turn": Turn{ID: "t1", Token: f.token, ExpiresAt: f.session.Turn.ExpiresAt}, "session": f.session})
	case r.Method == "DELETE" && path == "/sessions/s1/turns/t1":
		if !needTurn() {
			return
		}
		f.ended = true
		f.session.Turn = nil
		w.WriteHeader(204)
	case r.Method == "POST" && path == "/sessions/s1/messages":
		if !needTurn() {
			return
		}
		var m Message
		_ = json.Unmarshal(body, &m)
		m.Seq = len(f.session.Messages) + 1
		f.session.Messages = append(f.session.Messages, m)
		writeJSON(w, 201, m)
	case r.Method == "POST" && path == "/sessions/s1/complete":
		if !needTurn() {
			return
		}
		var b struct {
			Model   string         `json:"model"`
			Request map[string]any `json:"request"`
		}
		_ = json.Unmarshal(body, &b)
		if b.Model != "agent" {
			f.t.Errorf("model %q, want agent", b.Model)
		}
		f.requests = append(f.requests, b.Request)
		n := len(f.requests)
		if f.block != nil {
			f.mu.Unlock()
			<-f.block
			f.mu.Lock()
		}
		status, answer := f.model(n, b.Request)
		w.Header().Set("Content-Type", "application/json")
		w.WriteHeader(status)
		_, _ = io.WriteString(w, answer)
	case r.Method == "POST" && path == "/sessions/s1/runs":
		if !needTurn() {
			return
		}
		var b struct{ Code string }
		_ = json.Unmarshal(body, &b)
		writeJSON(w, 200, f.run(b.Code))
	case r.Method == "GET" && path == "/docs":
		writeJSON(w, 200, map[string]any{"docs": []Doc{{Path: "skills/email.md", Description: "How we write emails"}}})
	case r.Method == "GET" && strings.HasPrefix(path, "/docs/"):
		doc, ok := f.docs[strings.TrimPrefix(path, "/docs/")]
		if !ok {
			http.Error(w, `{"error":"document does not exist"}`, 404)
			return
		}
		_, _ = io.WriteString(w, doc)
	default:
		f.t.Errorf("unexpected kernel call %s %s", r.Method, r.URL.Path)
		http.Error(w, "{}", 404)
	}
}

func toolCallAnswer(id, name, args string) string {
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{
		"message":       map[string]any{"role": "assistant", "content": nil, "tool_calls": []any{map[string]any{"id": id, "type": "function", "function": map[string]any{"name": name, "arguments": args}}}},
		"finish_reason": "tool_calls",
	}}})
	return string(b)
}

func textAnswer(text string) string {
	b, _ := json.Marshal(map[string]any{"choices": []any{map[string]any{"message": map[string]any{"role": "assistant", "content": text}, "finish_reason": "stop"}}})
	return string(b)
}

func newServer(kernelURL string) *Server {
	return &Server{Kernel: NewKernel(kernelURL), Config: Config{Model: "agent", MaxSteps: 4, MaxTokens: 256}}
}

// send posts a message to the agent as alice and waits for the turn to end.
func send(t *testing.T, s *Server, f *fakeKernel, content string) {
	t.Helper()
	h := s.Handler()
	req := httptest.NewRequest("POST", "https://app.test/chat/api/workspaces/team/sessions/s1/messages", strings.NewReader(`{"content":"`+content+`"}`))
	req.Header.Set(IdentityHeader, "alice-id-token")
	req.Header.Set("Origin", "https://app.test")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("send: %d %s", rec.Code, rec.Body)
	}
	if strings.Contains(rec.Body.String(), f.token) {
		t.Fatal("the turn token went to the browser")
	}
	deadline := time.Now().Add(5 * time.Second)
	for {
		f.mu.Lock()
		ended := f.ended
		f.mu.Unlock()
		if ended {
			return
		}
		if time.Now().After(deadline) {
			t.Fatal("the turn did not end")
		}
		time.Sleep(10 * time.Millisecond)
	}
}

func roles(ms []Message) string {
	var out []string
	for _, m := range ms {
		out = append(out, m.Role)
	}
	return strings.Join(out, ",")
}

func TestTurnRunsCodeAndAnswers(t *testing.T) {
	f, srv := newFakeKernel(t)
	f.session.Grants = []string{"inference:model/agent:invoke", "web:hn.algolia.com/api/v1:read"}
	f.model = func(n int, req map[string]any) (int, string) {
		if n == 1 {
			return 200, toolCallAnswer("call_a", "run_code", `{"code":"return 6*7"}`)
		}
		return 200, textAnswer("It is 42.")
	}
	var codes []string
	f.run = func(code string) RunResult {
		codes = append(codes, code)
		return RunResult{ID: "rabc", OK: true, Value: json.RawMessage(`42`), Logs: []string{}}
	}
	send(t, newServer(srv.URL), f, "what is 6 times 7")

	if got := roles(f.session.Messages); got != "user,assistant,tool,assistant" {
		t.Fatalf("transcript %s", got)
	}
	tool := f.session.Messages[2]
	if tool.ToolCallID != "call_a" || tool.Run != "rabc" || tool.Name != "run_code" || !strings.Contains(tool.Content, `"value":42`) {
		t.Fatalf("tool message %+v", tool)
	}
	if f.session.Messages[3].Content != "It is 42." {
		t.Fatalf("answer %q", f.session.Messages[3].Content)
	}
	if len(codes) != 1 || codes[0] != "return 6*7" {
		t.Fatalf("runs %v", codes)
	}
	// After the turn started, every call carried the turn token and never
	// the user's ID token.
	for _, a := range f.auths {
		if a != "identity= turn=turn-token" {
			t.Fatalf("a kernel call used %q", a)
		}
	}
	// The second model call saw the tool's result; the system prompt names
	// the grants, the docs and the tools.
	msgs := f.requests[1]["messages"].([]any)
	system := msgs[0].(map[string]any)["content"].(string)
	for _, want := range []string{"alice@test", "web:hn.algolia.com/api/v1:read", "https://hn.algolia.com/api/v1", "skills/email.md: How we write emails", "https://app.test/gatekeeper/"} {
		if !strings.Contains(system, want) {
			t.Errorf("system prompt lacks %q", want)
		}
	}
	last := msgs[len(msgs)-1].(map[string]any)
	if last["role"] != "tool" || last["tool_call_id"] != "call_a" {
		t.Fatalf("last message to the model %v", last)
	}
	if len(f.requests[0]["tools"].([]any)) != 2 {
		t.Fatal("tools missing from the model request")
	}
}

func TestTurnReadsDocs(t *testing.T) {
	f, srv := newFakeKernel(t)
	f.model = func(n int, req map[string]any) (int, string) {
		switch n {
		case 1:
			return 200, toolCallAnswer("c1", "read_doc", `{"path":"skills/email.md"}`)
		case 2:
			return 200, toolCallAnswer("c2", "read_doc", `{"path":"nope.md"}`)
		}
		return 200, textAnswer("done")
	}
	send(t, newServer(srv.URL), f, "how do we write emails")
	if f.session.Messages[2].Content != "# Email\nBe brief." {
		t.Fatalf("doc %q", f.session.Messages[2].Content)
	}
	if !strings.Contains(f.session.Messages[4].Content, "there is no document nope.md") {
		t.Fatalf("missing doc %q", f.session.Messages[4].Content)
	}
}

func TestTurnExplainsModelRefusals(t *testing.T) {
	for _, tc := range []struct {
		status int
		body   string
		want   string
	}{
		{429, "", "budget"},
		{403, `{"error":"the session has no grant for inference:model/agent:invoke"}`, "grant it inference:model/agent:invoke"},
		{502, `{"error":{"message":"upstream down"}}`, "upstream down"},
	} {
		f, srv := newFakeKernel(t)
		f.model = func(int, map[string]any) (int, string) { return tc.status, tc.body }
		send(t, newServer(srv.URL), f, "hi")
		got := f.session.Messages[len(f.session.Messages)-1]
		if got.Role != "assistant" || !strings.Contains(got.Content, tc.want) {
			t.Errorf("%d: %q lacks %q", tc.status, got.Content, tc.want)
		}
	}
}

func TestTurnStopsAfterMaxSteps(t *testing.T) {
	f, srv := newFakeKernel(t)
	f.model = func(n int, _ map[string]any) (int, string) {
		return 200, toolCallAnswer("c"+string(rune('0'+n)), "run_code", `{"code":"return 1"}`)
	}
	f.run = func(string) RunResult { return RunResult{ID: "r1", OK: true, Value: json.RawMessage(`1`)} }
	send(t, newServer(srv.URL), f, "loop")
	if len(f.requests) != 4 {
		t.Fatalf("%d model calls, want 4", len(f.requests))
	}
	if last := f.session.Messages[len(f.session.Messages)-1]; !strings.Contains(last.Content, "stopped after 4 steps") {
		t.Fatalf("last message %q", last.Content)
	}
}

func TestShutdownInterruptsTurns(t *testing.T) {
	f, srv := newFakeKernel(t)
	f.block = make(chan struct{})
	f.model = func(int, map[string]any) (int, string) { return 200, textAnswer("too late") }
	s := newServer(srv.URL)
	h := s.Handler()
	req := httptest.NewRequest("POST", "https://app.test/chat/api/workspaces/team/sessions/s1/messages", strings.NewReader(`{"content":"hi"}`))
	req.Header.Set(IdentityHeader, "alice-id-token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusAccepted {
		t.Fatalf("send: %d %s", rec.Code, rec.Body)
	}
	time.Sleep(50 * time.Millisecond)
	go func() {
		time.Sleep(100 * time.Millisecond)
		close(f.block)
	}()
	ctx, cancel := context.WithTimeout(context.Background(), 5*time.Second)
	defer cancel()
	s.Shutdown(ctx)
	f.mu.Lock()
	defer f.mu.Unlock()
	if !f.ended {
		t.Fatal("the interrupted turn was not ended")
	}
	if last := f.session.Messages[len(f.session.Messages)-1]; !strings.Contains(last.Content, "interrupted by a restart") {
		t.Fatalf("last message %q", last.Content)
	}
	// A turn started after shutdown is given back at once.
	f.ended, f.turn, f.session.Turn = false, "", nil
	f.mu.Unlock()
	req = httptest.NewRequest("POST", "https://app.test/chat/api/workspaces/team/sessions/s1/messages", strings.NewReader(`{"content":"again"}`))
	req.Header.Set(IdentityHeader, "alice-id-token")
	rec = httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	f.mu.Lock()
	if rec.Code != http.StatusServiceUnavailable || !f.ended {
		t.Fatalf("after shutdown: %d %s, turn ended %v", rec.Code, rec.Body, f.ended)
	}
}

func TestServerRefusesWithoutIdentityOrFromOtherOrigins(t *testing.T) {
	_, srv := newFakeKernel(t)
	h := newServer(srv.URL).Handler()
	for _, tc := range []struct {
		identity, origin string
		want             int
	}{
		{"", "", http.StatusUnauthorized},
		{"alice-id-token", "https://evil.test", http.StatusForbidden},
	} {
		req := httptest.NewRequest("POST", "https://app.test/chat/api/workspaces/team/sessions", strings.NewReader(`{}`))
		if tc.identity != "" {
			req.Header.Set(IdentityHeader, tc.identity)
		}
		if tc.origin != "" {
			req.Header.Set("Origin", tc.origin)
		}
		rec := httptest.NewRecorder()
		h.ServeHTTP(rec, req)
		if rec.Code != tc.want {
			t.Errorf("identity %q origin %q: %d, want %d", tc.identity, tc.origin, rec.Code, tc.want)
		}
	}
}

func TestNewSessionsGetTheAgentsModel(t *testing.T) {
	f, srv := newFakeKernel(t)
	h := newServer(srv.URL).Handler()
	req := httptest.NewRequest("POST", "https://app.test/chat/api/workspaces/team/sessions", strings.NewReader(`{}`))
	req.Header.Set(IdentityHeader, "alice-id-token")
	rec := httptest.NewRecorder()
	h.ServeHTTP(rec, req)
	if rec.Code != http.StatusCreated {
		t.Fatalf("%d %s", rec.Code, rec.Body)
	}
	if len(f.session.Grants) != 1 || f.session.Grants[0] != "inference:model/agent:invoke" {
		t.Fatalf("grants %v", f.session.Grants)
	}
}

func TestHistory(t *testing.T) {
	call := func(id string) ToolCall {
		return ToolCall{ID: id, Type: "function", Function: FunctionCall{Name: "run_code", Arguments: "{}"}}
	}
	ms := []Message{
		{Role: "assistant", Content: "from an earlier window"},
		{Role: "user", Content: "send it"},
		{Role: "assistant", ToolCalls: []ToolCall{call("a"), call("b")}},
		{Role: "tool", ToolCallID: "a", Content: "ran a"},
		// An approval settled while b was running.
		{Role: "event", Content: "approved"},
		{Role: "tool", ToolCallID: "b", Content: strings.Repeat("x", toolResultBytes+100)},
		// A turn cut short after asking for c.
		{Role: "assistant", ToolCalls: []ToolCall{call("c")}},
		{Role: "event", Content: "The agent stopped before it finished answering."},
		{Role: "user", Content: "again"},
	}
	got := history(ms)
	var shape []string
	for _, m := range got {
		s := m.Role
		if m.ToolCallID != "" {
			s += ":" + m.ToolCallID
		}
		shape = append(shape, s)
	}
	want := "user,assistant,tool:a,tool:b,user,assistant,tool:c,user,user"
	if strings.Join(shape, ",") != want {
		t.Fatalf("history %s, want %s", strings.Join(shape, ","), want)
	}
	if *got[4].Content != "[kodo] approved" {
		t.Fatalf("event %q", *got[4].Content)
	}
	if !strings.HasSuffix(*got[3].Content, "[cut off]") {
		t.Fatal("a long tool result was not cut")
	}
	if !strings.Contains(*got[6].Content, "interrupted") {
		t.Fatalf("missing result %q", *got[6].Content)
	}
	if got[1].Content != nil {
		t.Fatal("an assistant message with only tool calls has content")
	}
}
