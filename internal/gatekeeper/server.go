package gatekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"sort"
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
	// What the call consumed, for a metered provider. The kernel counts it
	// for the cell; the gadget does not see it.
	Usage *Usage `json:"usage,omitempty"`
}

// DecisionHeader tells the gadget whether a response is the upstream's
// (allowed), the Gatekeeper's (denied, failed), or a call parked for its
// owner's approval (pending), in which case ApprovalHeader names it.
const (
	DecisionHeader = "X-Kodo-Decision"
	ApprovalHeader = "X-Kodo-Approval"
	Pending        = "pending"
)

const (
	maxCallBytes     = 2 << 20
	maxUpstreamBytes = 5 << 20
	maxTokenBytes    = 8 << 10
	maxQueryIDs      = 100
	listedApprovals  = 50
)

// Server is the Gatekeeper. Internal serves kernels on the fleet-facing
// port; Public serves users, behind the gateway's login.
type Server struct {
	Trust     Trust
	Tokens    Tokens
	Audit     Audit
	Approvals Approvals
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
	mux.HandleFunc("POST /v1/approvals/query", s.queryApprovals)
	mux.HandleFunc("POST /v1/events", s.handleEvent)
	mux.HandleFunc("POST /v1/audit/query", s.queryAudit)
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	return mux
}

// trusted reads a kernel's signed request, or answers it and returns false.
func (s *Server) trusted(w http.ResponseWriter, r *http.Request) ([]byte, string, bool) {
	body, err := io.ReadAll(http.MaxBytesReader(w, r.Body, maxCallBytes))
	if err != nil {
		http.Error(w, "call too large", http.StatusRequestEntityTooLarge)
		return nil, "", false
	}
	fleet, err := s.Trust.Verify(r.Header, body, s.now())
	if err != nil {
		s.record(r.Context(), Record{Decision: Untrusted, Reason: err.Error(), Fleet: fleet})
		http.Error(w, "untrusted caller: "+err.Error(), http.StatusUnauthorized)
		return nil, "", false
	}
	return body, fleet, true
}

func (s *Server) handleCall(w http.ResponseWriter, r *http.Request) {
	body, fleet, ok := s.trusted(w, r)
	if !ok {
		return
	}
	var call Call
	if err := json.Unmarshal(body, &call); err != nil || call.Cell == "" || call.Owner.User == "" {
		http.Error(w, "malformed call", http.StatusBadRequest)
		return
	}
	call.Request.Method = strings.ToUpper(call.Request.Method)
	ctx := r.Context()

	rec := Record{
		Fleet: fleet, Workspace: call.Workspace, User: call.Owner.User, Email: call.Owner.Email,
		Blueprint: call.Blueprint, Version: call.Version, Cell: call.Cell, Grant: call.Capability,
		Method: call.Request.Method, Path: call.Request.Path,
	}
	deny := func(reason string) {
		rec.Decision, rec.Reason = Denied, reason
		if !s.record(ctx, rec) {
			writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
			return
		}
		writeAnswer(w, denial(reason))
	}
	provider, c, reason := s.decide(call)
	if reason != "" {
		deny(reason)
		return
	}
	waits, _ := SideEffecting(c)
	if c.Verb == "read" && len(call.Request.Body) > 0 {
		deny("read calls take no body")
		return
	}
	rec.Provider = c.Provider
	platform, isPlatform := provider.(PlatformProvider)
	if isPlatform && waits {
		deny(c.Provider + " has no calls that wait for approval")
		return
	}
	// A platform provider's calls use the platform's credentials; any other
	// provider's use the owner's.
	var account string
	if !isPlatform {
		conn, err := s.Tokens.Connection(ctx, call.Owner.User, c.Provider)
		if err != nil {
			reason := "the cell's owner has not connected " + c.Provider
			if !errors.Is(err, ErrNotConnected) {
				s.log().Error("reading connection", "provider", c.Provider, "err", err)
				reason = "the owner's " + c.Provider + " connection is unavailable"
			}
			deny(reason)
			return
		}
		account = conn.Account
	}
	upstream, err := provider.Prepare(ctx, c, call.Request, account)
	if err != nil {
		deny(err.Error())
		return
	}
	if waits {
		s.queue(w, r, call, fleet, provider, c, account, rec)
		return
	}

	var token string
	if isPlatform {
		platform.Attribute(upstream, fleet, call)
	} else if token, err = s.Tokens.Token(ctx, call.Owner.User, c.Provider); err != nil {
		s.log().Error("reading token", "provider", c.Provider, "err", err)
		deny("the owner's " + c.Provider + " token is unavailable")
		return
	}
	// The decision is recorded before the call is made: if it cannot be
	// recorded, the call does not happen.
	rec.Decision = Allowed
	if !s.record(ctx, rec) {
		writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
		return
	}
	provider.Authorize(upstream, token)
	answer, err := s.send(upstream, provider, rec)
	if err != nil {
		answer = failure(http.StatusBadGateway, err.Error())
	} else if m, ok := provider.(Metering); ok {
		// What the call consumed is recorded once it is known, and goes back
		// to the kernel, which counts it for the cell.
		answer.Usage = m.Meter(&answer)
		rec.Decision, rec.Status, rec.Usage = Metered, answer.Status, answer.Usage
		s.record(ctx, rec)
	}
	writeAnswer(w, answer)
}

// decide returns the provider and capability for a call, or why it is
// denied: not granted, no such provider, or a verb the Gatekeeper does not
// know.
func (s *Server) decide(call Call) (Provider, Capability, string) {
	c, err := ParseCapability(call.Capability)
	if err != nil {
		return nil, c, err.Error()
	}
	granted := false
	for _, g := range call.Grants {
		if g == call.Capability {
			granted = true
		}
	}
	if !granted {
		return nil, c, fmt.Sprintf("cell %s has no grant for %s", call.Cell, call.Capability)
	}
	provider, ok := s.Providers[c.Provider]
	if !ok {
		return nil, c, fmt.Sprintf("no provider %q", c.Provider)
	}
	if _, known := SideEffecting(c); !known {
		return nil, c, fmt.Sprintf("unknown verb %q; the verbs are read, write, send and delete", c.Verb)
	}
	return provider, c, ""
}

// queue parks a side-effecting call for its owner's approval and answers 202
// with the approval. The queued call is recorded first; if it cannot be, the
// call is not queued.
func (s *Server) queue(w http.ResponseWriter, r *http.Request, call Call, fleet string, p Provider, c Capability, account string, rec Record) {
	ctx := r.Context()
	ap := Approval{
		Fleet: fleet, Workspace: call.Workspace, Cell: call.Cell, Blueprint: call.Blueprint, Version: call.Version,
		Owner: call.Owner, Capability: call.Capability, Provider: c.Provider, Account: account,
		Request: call.Request, Summary: p.Describe(c, call.Request, account),
	}
	if err := s.Approvals.Create(ctx, &ap, s.now()); err != nil {
		s.log().Error("queueing a call", "cell", call.Cell, "grant", call.Capability, "err", err)
		writeAnswer(w, failure(http.StatusServiceUnavailable, "the approval queue is unavailable"))
		return
	}
	rec.Decision, rec.Approval = Queued, ap.ID
	if !s.record(ctx, rec) {
		_ = s.Approvals.Delete(ctx, ap)
		writeAnswer(w, failure(http.StatusServiceUnavailable, "the audit log is unavailable"))
		return
	}
	body, _ := json.Marshal(map[string]ApprovalStatus{"approval": ap.Status()})
	writeAnswer(w, Answer{
		Status: http.StatusAccepted,
		Headers: map[string]string{
			"content-type": "application/json", DecisionHeader: Pending, ApprovalHeader: ap.ID,
		},
		Body: body,
	})
}

// ApprovalQuery is what a kernel sends to POST /v1/approvals/query: the
// approvals one of its cells is waiting on.
type ApprovalQuery struct {
	Cell  string   `json:"cell"`
	Owner Owner    `json:"owner"`
	IDs   []string `json:"ids"`
}

// queryApprovals tells a cell the state of its approvals. An approval that
// is not that cell's, in that fleet, is unknown.
func (s *Server) queryApprovals(w http.ResponseWriter, r *http.Request) {
	body, fleet, ok := s.trusted(w, r)
	if !ok {
		return
	}
	var q ApprovalQuery
	if err := json.Unmarshal(body, &q); err != nil || q.Cell == "" || q.Owner.User == "" || len(q.IDs) > maxQueryIDs {
		http.Error(w, "malformed query", http.StatusBadRequest)
		return
	}
	found := map[string]ApprovalStatus{}
	for _, ap := range s.loadApprovals(r.Context(), q.Owner.User, q.IDs) {
		if ap.Cell == q.Cell && ap.Fleet == fleet {
			found[ap.ID] = ap.Status()
		}
	}
	out := make([]ApprovalStatus, 0, len(q.IDs))
	for _, id := range q.IDs {
		st, ok := found[id]
		if !ok {
			st = ApprovalStatus{ID: id, State: StateUnknown}
		}
		out = append(out, st)
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": out})
}

// send makes a prepared, authorised call and returns the provider's answer.
// An error means no answer arrived, so the call may or may not have reached
// the provider.
func (s *Server) send(req *http.Request, p Provider, rec Record) (Answer, error) {
	started := s.now()
	timeout := DefaultCallTimeout
	if t, ok := p.(TimeLimited); ok {
		timeout = t.CallTimeout()
	}
	ctx, cancel := context.WithTimeout(req.Context(), timeout)
	defer cancel()
	client := s.Upstream
	if own, ok := p.(OwnClient); ok {
		client = own.Client()
	}
	res, err := client.Do(req.WithContext(ctx))
	if err != nil {
		s.log().Warn("upstream call failed", "cell", rec.Cell, "grant", rec.Grant, "err", err)
		return Answer{}, errors.New(rec.Provider + " is unreachable")
	}
	defer func() { _ = res.Body.Close() }()
	body, err := io.ReadAll(io.LimitReader(res.Body, maxUpstreamBytes+1))
	if err != nil {
		return Answer{}, errors.New("reading the " + rec.Provider + " response failed")
	}
	if len(body) > maxUpstreamBytes {
		return Answer{}, errors.New(rec.Provider + " response larger than 5 MiB")
	}
	headers := map[string]string{DecisionHeader: Allowed}
	for _, h := range p.ResponseHeaders() {
		if v := res.Header.Get(h); v != "" {
			headers[strings.ToLower(h)] = v
		}
	}
	s.log().Info("call", "decision", rec.Decision, "fleet", rec.Fleet, "workspace", rec.Workspace,
		"blueprint", rec.Blueprint, "cell", rec.Cell, "grant", rec.Grant, "method", rec.Method,
		"approval", rec.Approval, "status", res.StatusCode, "ms", s.now().Sub(started).Milliseconds())
	return Answer{Status: res.StatusCode, Headers: headers, Body: body}, nil
}

// record appends to the audit log and reports whether that worked.
func (s *Server) record(ctx context.Context, rec Record) bool {
	rec.Time = s.now()
	switch rec.Decision {
	case Allowed:
		// Logged with its upstream status once the call returns.
	case Connected, Disconnected:
		s.log().Info("connection", "decision", rec.Decision, "provider", rec.Provider)
	case Authored, Published:
		s.log().Info("blueprint", "decision", rec.Decision, "fleet", rec.Fleet, "workspace", rec.Workspace,
			"blueprint", rec.Blueprint, "version", rec.Version, "session", rec.Cell)
	case Admin:
		s.log().Info("admin", "action", rec.Action, "fleet", rec.Fleet, "workspace", rec.Workspace, "target", rec.Target)
	case Metered:
		if rec.Usage != nil {
			s.log().Info("usage", "fleet", rec.Fleet, "workspace", rec.Workspace, "blueprint", rec.Blueprint,
				"cell", rec.Cell, "grant", rec.Grant, "status", rec.Status, "model", rec.Usage.Model,
				"input", rec.Usage.Input, "output", rec.Usage.Output)
		}
	default:
		s.log().Info("call", "decision", rec.Decision, "reason", rec.Reason, "fleet", rec.Fleet,
			"workspace", rec.Workspace, "blueprint", rec.Blueprint, "cell", rec.Cell, "grant", rec.Grant,
			"approval", rec.Approval)
	}
	if _, err := s.Audit.Append(ctx, rec); err != nil {
		s.log().Error("audit append failed", "err", err)
		return false
	}
	return true
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
	mux.HandleFunc("GET /gatekeeper/api/approvals", s.user(s.listApprovals))
	mux.HandleFunc("GET /gatekeeper/api/approvals/{id}", s.user(s.getApproval))
	mux.HandleFunc("POST /gatekeeper/api/approvals/{id}/approve", s.user(s.approve))
	mux.HandleFunc("POST /gatekeeper/api/approvals/{id}/reject", s.user(s.reject))
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
	type providerInfo struct {
		Name string `json:"name"`
		// The label of the account field, for providers where users choose.
		Account string `json:"account,omitempty"`
	}
	providers := make([]providerInfo, 0, len(s.Providers))
	for name, p := range s.Providers {
		if _, ok := p.(PlatformProvider); ok {
			continue
		}
		info := providerInfo{Name: name}
		if c, ok := p.(AccountChooser); ok {
			info.Account = c.AccountPrompt()
		}
		providers = append(providers, info)
	}
	sort.Slice(providers, func(i, j int) bool { return providers[i].Name < providers[j].Name })
	writeJSON(w, http.StatusOK, map[string]any{"user": u, "providers": providers, "connections": conns})
}

func (s *Server) connect(w http.ResponseWriter, r *http.Request, u User) {
	name := r.PathValue("provider")
	p, ok := s.Providers[name]
	if _, platform := p.(PlatformProvider); !ok || platform {
		jsonError(w, http.StatusNotFound, "no provider to connect named "+name)
		return
	}
	var body struct {
		Token string `json:"token"`
		// The account to act as, for providers where users choose one.
		Account string `json:"account"`
	}
	if err := json.NewDecoder(http.MaxBytesReader(w, r.Body, maxTokenBytes)).Decode(&body); err != nil ||
		strings.TrimSpace(body.Token) == "" {
		jsonError(w, http.StatusBadRequest, `body must be {"token": "...", "account": "..."}`)
		return
	}
	token := strings.TrimSpace(body.Token)
	account, err := p.Account(r.Context(), token, strings.TrimSpace(body.Account))
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
	s.record(r.Context(), Record{Decision: Connected, User: u.Sub, Email: u.Email, Provider: name})
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
	s.record(r.Context(), Record{Decision: Disconnected, User: u.Sub, Email: u.Email, Provider: name})
	w.WriteHeader(http.StatusNoContent)
}

func (s *Server) listApprovals(w http.ResponseWriter, r *http.Request, u User) {
	ids, err := s.Approvals.IDs(r.Context(), u.Sub)
	if err != nil {
		s.log().Error("listing approvals", "err", err)
		jsonError(w, http.StatusBadGateway, "cannot read approvals")
		return
	}
	state := r.URL.Query().Get("state")
	if state == StatePending {
		// Older ones have expired, whether or not that is recorded yet.
		ids = s.Approvals.Pending(ids, s.now())
	}
	if len(ids) > listedApprovals {
		ids = ids[:listedApprovals]
	}
	approvals := []Approval{}
	for _, ap := range s.loadApprovals(r.Context(), u.Sub, ids) {
		if state == "" || ap.State == state {
			approvals = append(approvals, ap)
		}
	}
	writeJSON(w, http.StatusOK, map[string]any{"approvals": approvals})
}

func (s *Server) getApproval(w http.ResponseWriter, r *http.Request, u User) {
	ap, _, err := s.loadApproval(r.Context(), u.Sub, r.PathValue("id"))
	if err != nil {
		approvalError(w, err, ap)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"approval": ap})
}

// approve runs a pending call: it moves the approval to executing, which
// only one replica can do, makes the call and records how it ended. The call
// is not cancelled if the user goes away.
func (s *Server) approve(w http.ResponseWriter, r *http.Request, u User) {
	now := s.now()
	ap, version, err := s.transition(r.Context(), u.Sub, r.PathValue("id"), func(ap *Approval) error {
		if ap.State != StatePending {
			return errNotPending
		}
		ap.State, ap.DecidedAt, ap.DecidedBy, ap.ExecutingAt = StateExecuting, &now, u.Email, &now
		return nil
	})
	if err != nil {
		approvalError(w, err, ap)
		return
	}
	ap = s.execute(context.WithoutCancel(r.Context()), ap, version, u)
	writeJSON(w, http.StatusOK, map[string]any{"approval": ap})
}

func (s *Server) reject(w http.ResponseWriter, r *http.Request, u User) {
	now := s.now()
	ap, _, err := s.transition(r.Context(), u.Sub, r.PathValue("id"), func(ap *Approval) error {
		if ap.State != StatePending {
			return errNotPending
		}
		ap.State, ap.DecidedAt, ap.DecidedBy, ap.FinishedAt = StateRejected, &now, u.Email, &now
		return nil
	})
	if err != nil {
		approvalError(w, err, ap)
		return
	}
	rec := approvalRecord(ap, Rejected)
	rec.User, rec.Email = u.Sub, u.Email
	s.record(r.Context(), rec)
	writeJSON(w, http.StatusOK, map[string]any{"approval": ap})
}

func approvalError(w http.ResponseWriter, err error, ap Approval) {
	switch {
	case errors.Is(err, ErrNotFound):
		jsonError(w, http.StatusNotFound, "no such approval")
	case errors.Is(err, errNotPending):
		writeJSON(w, http.StatusConflict, map[string]any{"error": "the approval is already " + ap.State, "approval": ap})
	case errors.Is(err, ErrConflict):
		jsonError(w, http.StatusConflict, "the approval is changing; try again")
	default:
		jsonError(w, http.StatusBadGateway, "cannot update the approval")
	}
}

func (s *Server) page(w http.ResponseWriter, _ *http.Request) {
	w.Header().Set("Content-Type", "text/html; charset=utf-8")
	// No other page, a gadget's included, may frame this one and trick its
	// user into approving something.
	w.Header().Set("Content-Security-Policy",
		"default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	w.Header().Set("X-Frame-Options", "DENY")
	_, _ = io.WriteString(w, gatekeeperPage)
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}
