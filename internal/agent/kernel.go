// Package agent is the kodo agent: a chat at app.<domain>/chat/ where the
// agent plans, writes JavaScript and runs it in ephemeral cells with the
// session's grants. It holds no state and no authority of its own. Sessions
// live in the kernel; the agent creates them and starts turns with the
// user's ID token, then works through the turn with the token the kernel
// issues for it, which reaches only that session.
package agent

import (
	"bytes"
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// Headers the kernel reads: the user's ID token, which the gateway forwards,
// and a turn token.
const (
	IdentityHeader = "X-Kodo-Identity"
	TurnHeader     = "X-Kodo-Turn"
)

// Kernel calls the kernel API of the fleet.
type Kernel struct {
	// e.g. http://kodo.kodo.svc. Any host that is not a cell's serves the API.
	URL  string
	HTTP *http.Client
}

// Auth is how a request to the kernel is authorised: as the user, or as a
// turn.
type Auth struct {
	Identity string
	Turn     string
}

func (a Auth) set(h http.Header) {
	if a.Turn != "" {
		h.Set(TurnHeader, a.Turn)
	} else if a.Identity != "" {
		h.Set(IdentityHeader, a.Identity)
	}
}

// Owner is who a session belongs to.
type Owner struct {
	User  string `json:"user"`
	Email string `json:"email"`
}

// ToolCall is a tool call as the chat completions API writes it.
type ToolCall struct {
	ID       string       `json:"id"`
	Type     string       `json:"type"`
	Function FunctionCall `json:"function"`
}

// FunctionCall is the function a tool call names, with its arguments as JSON.
type FunctionCall struct {
	Name      string `json:"name"`
	Arguments string `json:"arguments"`
}

// Message is one entry of a session's transcript.
type Message struct {
	Seq        int             `json:"seq,omitempty"`
	Role       string          `json:"role"`
	Content    string          `json:"content"`
	ToolCalls  []ToolCall      `json:"tool_calls,omitempty"`
	ToolCallID string          `json:"tool_call_id,omitempty"`
	Name       string          `json:"name,omitempty"`
	Run        string          `json:"run,omitempty"`
	Approval   json.RawMessage `json:"approval,omitempty"`
	At         int64           `json:"at,omitempty"`
}

// Turn is the session's turn in progress.
type Turn struct {
	ID        string `json:"id"`
	StartedAt int64  `json:"startedAt"`
	ExpiresAt int64  `json:"expiresAt"`
	// Only in the answer that starts the turn.
	Token string `json:"token,omitempty"`
}

// Session is a session with the agent as the kernel returns it.
type Session struct {
	ID        string    `json:"id"`
	Workspace string    `json:"workspace"`
	Title     string    `json:"title"`
	Owner     Owner     `json:"owner"`
	CreatedAt int64     `json:"createdAt"`
	Grants    []string  `json:"grants"`
	Turn      *Turn     `json:"turn"`
	Messages  []Message `json:"messages"`
}

// Doc is one of the workspace's markdown documents.
type Doc struct {
	Path        string `json:"path"`
	Description string `json:"description"`
}

// RunResult is what came of running code in an ephemeral cell.
type RunResult struct {
	ID        string          `json:"id"`
	OK        bool            `json:"ok"`
	Value     json.RawMessage `json:"value,omitempty"`
	Error     string          `json:"error,omitempty"`
	Logs      []string        `json:"logs"`
	Approvals []struct {
		ID         string `json:"id"`
		Capability string `json:"capability"`
	} `json:"approvals"`
	Calls int   `json:"calls"`
	MS    int64 `json:"ms"`
}

// Draft is a gadget the agent wrote, stored as a draft Blueprint version,
// and what its page answered when the kernel loaded it.
type Draft struct {
	Blueprint struct {
		Name         string   `json:"name"`
		Version      string   `json:"version"`
		Status       string   `json:"status"`
		Capabilities []string `json:"capabilities"`
	} `json:"blueprint"`
	Check struct {
		OK          bool   `json:"ok"`
		Status      int    `json:"status,omitempty"`
		ContentType string `json:"contentType,omitempty"`
		Body        string `json:"body,omitempty"`
		Error       string `json:"error,omitempty"`
		Requests    []struct {
			Method string `json:"method"`
			Path   string `json:"path"`
			Status int    `json:"status,omitempty"`
			Body   string `json:"body,omitempty"`
			Error  string `json:"error,omitempty"`
		} `json:"requests,omitempty"`
	} `json:"check"`
}

// Error is a refusal from the kernel.
type Error struct {
	Status  int
	Message string
}

func (e *Error) Error() string { return fmt.Sprintf("kernel answered %d: %s", e.Status, e.Message) }

// StatusOf is the HTTP status of a kernel refusal, or 0 for any other error.
func StatusOf(err error) int {
	var e *Error
	if errors.As(err, &e) {
		return e.Status
	}
	return 0
}

func (k *Kernel) client() *http.Client {
	if k.HTTP != nil {
		return k.HTTP
	}
	return http.DefaultClient
}

// do sends a request and decodes a JSON answer into out, if out is not nil.
// A body that is []byte goes as it is; anything else as JSON.
func (k *Kernel) do(ctx context.Context, auth Auth, method, path string, body, out any) error {
	var reader io.Reader
	if body != nil {
		b, err := json.Marshal(body)
		if err != nil {
			return err
		}
		reader = bytes.NewReader(b)
	}
	req, err := http.NewRequestWithContext(ctx, method, strings.TrimSuffix(k.URL, "/")+"/api"+path, reader)
	if err != nil {
		return err
	}
	auth.set(req.Header)
	if body != nil {
		req.Header.Set("Content-Type", "application/json")
	}
	res, err := k.client().Do(req)
	if err != nil {
		return err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	if err != nil {
		return err
	}
	if res.StatusCode >= 300 {
		var e struct {
			Error string `json:"error"`
		}
		msg := strings.TrimSpace(string(raw))
		if json.Unmarshal(raw, &e) == nil && e.Error != "" {
			msg = e.Error
		}
		return &Error{Status: res.StatusCode, Message: msg}
	}
	if out == nil || len(raw) == 0 {
		return nil
	}
	if b, ok := out.(*[]byte); ok {
		*b = raw
		return nil
	}
	return json.Unmarshal(raw, out)
}

func sessionPath(ws, id string) string {
	return "/workspaces/" + url.PathEscape(ws) + "/sessions/" + url.PathEscape(id)
}

// CreateSession creates a session owned by the user with these grants.
func (k *Kernel) CreateSession(ctx context.Context, auth Auth, ws, title string, grants []string) (Session, error) {
	body := map[string]any{"grants": grants}
	if title != "" {
		body["title"] = title
	}
	var s Session
	err := k.do(ctx, auth, http.MethodPost, "/workspaces/"+url.PathEscape(ws)+"/sessions", body, &s)
	return s, err
}

// StartTurn starts a turn with the user's message, and returns the turn
// with its token and the session.
func (k *Kernel) StartTurn(ctx context.Context, auth Auth, ws, id, content string) (Turn, Session, error) {
	var out struct {
		Turn    Turn    `json:"turn"`
		Session Session `json:"session"`
	}
	err := k.do(ctx, auth, http.MethodPost, sessionPath(ws, id)+"/turns", map[string]string{"content": content}, &out)
	return out.Turn, out.Session, err
}

// EndTurn ends a turn.
func (k *Kernel) EndTurn(ctx context.Context, auth Auth, ws, id, turn string) error {
	return k.do(ctx, auth, http.MethodDelete, sessionPath(ws, id)+"/turns/"+url.PathEscape(turn), nil, nil)
}

// Session reads a session with its whole transcript.
func (k *Kernel) Session(ctx context.Context, auth Auth, ws, id string) (Session, error) {
	var s Session
	err := k.do(ctx, auth, http.MethodGet, sessionPath(ws, id), nil, &s)
	return s, err
}

// Append adds the agent's message to the transcript.
func (k *Kernel) Append(ctx context.Context, auth Auth, ws, id string, m Message) (Message, error) {
	var out Message
	err := k.do(ctx, auth, http.MethodPost, sessionPath(ws, id)+"/messages", m, &out)
	return out, err
}

// Complete calls one of the session's models with a chat completion
// request. A model's own refusal (429 over budget, say) comes back as its
// status and body, not as an error.
func (k *Kernel) Complete(ctx context.Context, auth Auth, ws, id, model string, request any) (int, []byte, error) {
	b, err := json.Marshal(map[string]any{"model": model, "request": request})
	if err != nil {
		return 0, nil, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(k.URL, "/")+"/api"+sessionPath(ws, id)+"/complete", bytes.NewReader(b))
	if err != nil {
		return 0, nil, err
	}
	auth.set(req.Header)
	req.Header.Set("Content-Type", "application/json")
	res, err := k.client().Do(req)
	if err != nil {
		return 0, nil, err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 8<<20))
	return res.StatusCode, raw, err
}

// Run runs code in an ephemeral cell with the session's grants.
func (k *Kernel) Run(ctx context.Context, auth Auth, ws, id, code string) (RunResult, error) {
	var r RunResult
	err := k.do(ctx, auth, http.MethodPost, sessionPath(ws, id)+"/runs", map[string]string{"code": code}, &r)
	return r, err
}

// Draft stores a gadget the agent wrote as a draft for the session's owner.
// checks are requests the kernel makes to it after GET /, to test it.
func (k *Kernel) Draft(ctx context.Context, auth Auth, ws, id, name, source string, capabilities []string, checks []any) (Draft, error) {
	var d Draft
	body := map[string]any{"name": name, "source": source, "capabilities": capabilities}
	if len(checks) > 0 {
		body["checks"] = checks
	}
	err := k.do(ctx, auth, http.MethodPost, sessionPath(ws, id)+"/drafts", body, &d)
	return d, err
}

// Docs lists the workspace's documents.
func (k *Kernel) Docs(ctx context.Context, auth Auth, ws string) ([]Doc, error) {
	var out struct {
		Docs []Doc `json:"docs"`
	}
	err := k.do(ctx, auth, http.MethodGet, "/workspaces/"+url.PathEscape(ws)+"/docs", nil, &out)
	return out.Docs, err
}

// Doc reads one of the workspace's documents.
func (k *Kernel) Doc(ctx context.Context, auth Auth, ws, path string) (string, error) {
	segments := strings.Split(path, "/")
	for i, s := range segments {
		segments[i] = url.PathEscape(s)
	}
	var raw []byte
	err := k.do(ctx, auth, http.MethodGet, "/workspaces/"+url.PathEscape(ws)+"/docs/"+strings.Join(segments, "/"), nil, &raw)
	return string(raw), err
}

// timeout is how long one kernel call may take: a run's 60 s and the
// Gatekeeper's, with room to spare.
const timeout = 90 * time.Second

// NewKernel is a kernel client with a timeout on every call.
func NewKernel(baseURL string) *Kernel {
	return &Kernel{URL: baseURL, HTTP: &http.Client{Timeout: timeout}}
}
