package gatekeeper

import (
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"time"
)

// CallRequest is the gadget's request on a binding.
type CallRequest struct {
	Method string `json:"method"`
	// Relative to the capability's resource, with any query string.
	Path    string            `json:"path"`
	Headers map[string]string `json:"headers,omitempty"`
	Body    []byte            `json:"body,omitempty"`
}

// Owner is the user a cell belongs to, whose token its calls use.
type Owner struct {
	User  string `json:"user"`
	Email string `json:"email"`
}

// Call is what a kernel sends to POST /v1/calls: the facts about the calling
// cell that the kernel vouches for, and the gadget's request.
type Call struct {
	Workspace  string      `json:"workspace"`
	Cell       string      `json:"cell"`
	Blueprint  string      `json:"blueprint"`
	Version    string      `json:"version"`
	Owner      Owner       `json:"owner"`
	Grants     []string    `json:"grants"`
	Capability string      `json:"capability"`
	Request    CallRequest `json:"request"`
}

// Answer is the Gatekeeper's response to a call it accepted from a trusted
// fleet: the upstream response, or a denial as a 403 with {"error"}.
type Answer struct {
	Status  int               `json:"status"`
	Headers map[string]string `json:"headers"`
	Body    []byte            `json:"body,omitempty"`
}

// DecisionHeader tells the gadget whether a response is the upstream's
// (allowed) or the Gatekeeper's (denied, failed).
const DecisionHeader = "X-Kodo-Decision"

const (
	maxCallBytes     = 2 << 20
	maxUpstreamBytes = 5 << 20
	maxTokenBytes    = 8 << 10
)

// Server is the Gatekeeper. Internal serves kernels on the fleet-facing
// port; Public serves users, behind the gateway's login.
type Server struct {
	Trust     Trust
	Tokens    Tokens
	Audit     Audit
	Providers map[string]Provider
	Users     Users
	// Upstream makes the calls to providers. It must not follow redirects,
	// which could leave the granted resource.
	Upstream *http.Client
	Log      *slog.Logger
	Now      func() time.Time
}

// NoRedirects is an Upstream client that returns redirects to the gadget.
func NoRedirects(timeout time.Duration) *http.Client {
	return &http.Client{
		Timeout:       timeout,
		CheckRedirect: func(*http.Request, []*http.Request) error { return http.ErrUseLastResponse },
	}
}

func (s *Server) now() time.Time {
	if s.Now != nil {
		return s.Now()
	}
	return time.Now()
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Internal is the handler kernels call.
func (s *Server) Internal() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("POST /v1/calls", s.handleCall)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	return mux
}

func (s *Server) handleCall(w http.ResponseWriter, r *http.Request) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCallBytes))
	if err != nil {
		http.Error(w, "call too large", http.StatusRequestEntityTooLarge)
		return
	}
	fleet, err := s.Trust.Verify(r.Header, body, s.now())
	if err != nil {
		s.record(r, Record{Decision: Rejected, Reason: err.Error(), Fleet: fleet})
		http.Error(w, "untrusted caller: "+err.Error(), http.StatusUnauthorized)
		return
	}
	var call Call
	if err := json.Unmarshal(body, &call); err != nil || call.Cell == "" || call.Owner.User == "" {
		http.Error(w, "malformed call", http.StatusBadRequest)
		return
	}
	call.Request.Method = strings.ToUpper(call.Request.Method)

	rec := Record{
		Fleet: fleet, Workspace: call.Workspace, User: call.Owner.User, Email: call.Owner.Email,
		Blueprint: call.Blueprint, Version: call.Version, Cell: call.Cell, Grant: call.Capability,
		Method: call.Request.Method, Path: call.Request.Path,
	}
	provider, upstream, reason := s.decide(r, call)
	if reason != "" {
		rec.Decision, rec.Reason = Denied, reason
		if !s.record(r, rec) {
			writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
			return
		}
		writeAnswer(w, denial(reason))
		return
	}
	rec.Provider = providerName(call.Capability)
	token, err := s.Tokens.Token(r.Context(), call.Owner.User, rec.Provider)
	if err != nil {
		reason := "the cell's owner has not connected " + rec.Provider
		if !errors.Is(err, ErrNotConnected) {
			s.log().Error("reading token", "provider", rec.Provider, "err", err)
			reason = "the owner's " + rec.Provider + " token is unavailable"
		}
		rec.Decision, rec.Reason = Denied, reason
		if !s.record(r, rec) {
			writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
			return
		}
		writeAnswer(w, denial(reason))
		return
	}
	// The decision is recorded before the call is made: if it cannot be
	// recorded, the call does not happen.
	rec.Decision = Allowed
	if !s.record(r, rec) {
		writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
		return
	}
	provider.Authorize(upstream, token)
	writeAnswer(w, s.forward(upstream, provider, rec))
}

// decide returns the provider and prepared upstream request for a call, or
// why it is denied.
func (s *Server) decide(r *http.Request, call Call) (Provider, *http.Request, string) {
	c, err := ParseCapability(call.Capability)
	if err != nil {
		return nil, nil, err.Error()
	}
	granted := false
	for _, g := range call.Grants {
		if g == call.Capability {
			granted = true
		}
	}
	if !granted {
		return nil, nil, fmt.Sprintf("cell %s has no grant for %s", call.Cell, call.Capability)
	}
	provider, ok := s.Providers[c.Provider]
	if !ok {
		return nil, nil, fmt.Sprintf("no provider %q", c.Provider)
	}
	if len(call.Request.Body) > 0 {
		return nil, nil, "read calls take no body"
	}
	upstream, err := provider.Prepare(r.Context(), c, call.Request)
	if err != nil {
		return nil, nil, err.Error()
	}
	return provider, upstream, ""
}

func (s *Server) forward(req *http.Request, p Provider, rec Record) Answer {
	started := s.now()
	res, err := s.Upstream.Do(req)
	if err != nil {
		s.log().Warn("upstream call failed", "cell", rec.Cell, "grant", rec.Grant, "err", err)
		return failure(http.StatusBadGateway, rec.Provider+" is unreachable")
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxUpstreamBytes+1))
	if err != nil {
		return failure(http.StatusBadGateway, "reading the "+rec.Provider+" response failed")
	}
	if len(body) > maxUpstreamBytes {
		return failure(http.StatusBadGateway, rec.Provider+" response larger than 5 MiB")
	}
	headers := map[string]string{DecisionHeader: Allowed}
	for _, h := range p.ResponseHeaders() {
		if v := res.Header.Get(h); v != "" {
			headers[strings.ToLower(h)] = v
		}
	}
	s.log().Info("call", "decision", Allowed, "fleet", rec.Fleet, "workspace", rec.Workspace,
		"blueprint", rec.Blueprint, "cell", rec.Cell, "grant", rec.Grant, "method", rec.Method,
		"status", res.StatusCode, "ms", s.now().Sub(started).Milliseconds())
	return Answer{Status: res.StatusCode, Headers: headers, Body: body}
}

// record appends to the audit log and reports whether that worked.
func (s *Server) record(r *http.Request, rec Record) bool {
	rec.Time = s.now()
	switch rec.Decision {
	case Allowed:
		// Logged with its upstream status once the call returns.
	case Connected, Disconnected:
		s.log().Info("connection", "decision", rec.Decision, "provider", rec.Provider)
	default:
		s.log().Info("call", "decision", rec.Decision, "reason", rec.Reason, "fleet", rec.Fleet,
			"workspace", rec.Workspace, "blueprint", rec.Blueprint, "cell", rec.Cell, "grant", rec.Grant)
	}
	if _, err := s.Audit.Append(r.Context(), rec); err != nil {
		s.log().Error("audit append failed", "err", err)
		return false
	}
	return true
}

func providerName(capability string) string {
	name, _, _ := strings.Cut(capability, ":")
	return name
}

func denial(reason string) Answer {
	return answerError(http.StatusForbidden, Denied, reason)
}

func failure(status int, reason string) Answer {
	return answerError(status, "failed", reason)
}

func answerError(status int, decision, reason string) Answer {
	body, _ := json.Marshal(map[string]string{"error": reason})
	return Answer{
		Status:  status,
		Headers: map[string]string{"content-type": "application/json", strings.ToLower(DecisionHeader): decision},
		Body:    body,
	}
}

func writeAnswer(w http.ResponseWriter, a Answer) {
	// Header names reach the gadget lower-cased.
	headers := make(map[string]string, len(a.Headers))
	for k, v := range a.Headers {
		headers[strings.ToLower(k)] = v
	}
	a.Headers = headers
	w.Header().Set("Content-Type", "application/json")
	_ = json.NewEncoder(w).Encode(a)
}

// Public is the handler users reach at app.<domain>/gatekeeper/ through the
// gateway, which logs them in and forwards their ID token.
func (s *Server) Public() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /gatekeeper/{$}", s.page)
	mux.HandleFunc("GET /gatekeeper/api/connections", s.user(s.listConnections))
	mux.HandleFunc("PUT /gatekeeper/api/connections/{provider}", s.user(s.connect))
	mux.HandleFunc("DELETE /gatekeeper/api/connections/{provider}", s.user(s.disconnect))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	return mux
}

func (s *Server) user(next func(http.ResponseWriter, *http.Request, User)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		if s.Users == nil {
			jsonError(w, http.StatusServiceUnavailable, "no identity provider configured")
			return
		}
		u, err := s.Users.Identify(r)
		if err != nil {
			jsonError(w, http.StatusUnauthorized, err.Error())
			return
		}
		// A write from another origin is refused, as the kernel does.
		if r.Method != http.MethodGet && crossOrigin(r) {
			jsonError(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		next(w, r, u)
	}
}

func crossOrigin(r *http.Request) bool {
	origin := r.Header.Get("Origin")
	if origin == "" {
		return false
	}
	u, err := url.Parse(origin)
	return err != nil || u.Host != r.Host
}

func (s *Server) listConnections(w http.ResponseWriter, r *http.Request, u User) {
	conns, err := s.Tokens.List(r.Context(), u.Sub)
	if err != nil {
		s.log().Error("listing connections", "err", err)
		jsonError(w, http.StatusBadGateway, "cannot read connections")
		return
	}
	providers := make([]string, 0, len(s.Providers))
	for name := range s.Providers {
		providers = append(providers, name)
	}
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "providers": providers, "connections": conns})
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request, u User) {
	name := r.PathValue("provider")
	p, ok := s.Providers[name]
	if !ok {
		jsonError(w, http.StatusNotFound, "no provider "+name)
		return
	}
	var body struct {
		Token string `json:"token"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxTokenBytes)).Decode(&body); err != nil ||
		strings.TrimSpace(body.Token) == "" {
		jsonError(w, http.StatusBadRequest, `body must be {"token": "..."}`)
		return
	}
	token := strings.TrimSpace(body.Token)
	account, err := p.Account(r.Context(), token)
	if err != nil {
		jsonError(w, http.StatusBadRequest, err.Error())
		return
	}
	conn, err := s.Tokens.Put(r.Context(), u.Sub, name, account, token)
	if err != nil {
		s.log().Error("storing token", "provider", name, "err", err)
		jsonError(w, http.StatusBadGateway, "cannot store the token")
		return
	}
	s.record(r, Record{Decision: Connected, User: u.Sub, Email: u.Email, Provider: name})
	writeJSON(w, http.StatusOK, conn)
}

func (s *Server) disconnect(w http.ResponseWriter, r *http.Request, u User) {
	name := r.PathValue("provider")
	if _, ok := s.Providers[name]; !ok {
		jsonError(w, http.StatusNotFound, "no provider "+name)
		return
	}
	if err := s.Tokens.Delete(r.Context(), u.Sub, name); err != nil {
		jsonError(w, http.StatusBadGateway, "cannot remove the token")
		return
	}
	s.record(r, Record{Decision: Disconnected, User: u.Sub, Email: u.Email, Provider: name})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) page(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	w.Header().Set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'")
	_, _ = io.WriteString(w, connectionsPage)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
