package agent

import (
	"context"
	"encoding/json"
	"errors"
	"io"
	"log/slog"
	"net/http"
	"net/url"
	"strings"
	"sync"
	"time"
)

// Server serves the chat at /chat/ and works through turns. It is behind the
// gateway's login, which forwards the user's ID token; the agent passes it
// to the kernel, which checks it, and keeps it no longer than the request.
type Server struct {
	Kernel *Kernel
	Log    *slog.Logger

	mu      sync.Mutex
	running map[string]context.CancelFunc
	wg      sync.WaitGroup
	closed  bool
}

func (s *Server) log() *slog.Logger {
	if s.Log != nil {
		return s.Log
	}
	return slog.Default()
}

// Handler serves the chat page and its API.
func (s *Server) Handler() http.Handler {
	mux := http.NewServeMux()
	mux.HandleFunc("GET /chat", func(w http.ResponseWriter, r *http.Request) {
		http.Redirect(w, r, "/chat/", http.StatusMovedPermanently)
	})
	mux.HandleFunc("GET /chat/{$}", s.page)
	mux.HandleFunc("GET /chat/api/config", s.user(s.config))
	mux.HandleFunc("POST /chat/api/workspaces/{ws}/sessions", s.user(s.createSession))
	mux.HandleFunc("POST /chat/api/workspaces/{ws}/sessions/{id}/messages", s.user(s.send))
	mux.HandleFunc("GET /healthz", func(w http.ResponseWriter, _ *http.Request) { _, _ = io.WriteString(w, "ok\n") })
	return mux
}

func (s *Server) page(w http.ResponseWriter, _ *http.Request) {
	h := w.Header()
	h.Set("Content-Type", "text/html; charset=utf-8")
	h.Set("Content-Security-Policy", "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'")
	h.Set("X-Content-Type-Options", "nosniff")
	_, _ = io.WriteString(w, chatPage)
}

// user requires the gateway's identity header and refuses writes from
// other origins.
func (s *Server) user(next func(http.ResponseWriter, *http.Request, Auth)) http.HandlerFunc {
	return func(w http.ResponseWriter, r *http.Request) {
		identity := r.Header.Get(IdentityHeader)
		if identity == "" {
			jsonError(w, http.StatusUnauthorized, "missing identity")
			return
		}
		if r.Method != http.MethodGet && crossOrigin(r) {
			jsonError(w, http.StatusForbidden, "cross-origin request refused")
			return
		}
		next(w, r, Auth{Identity: identity})
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

// config tells the page how the agent works now, as the kernel says.
func (s *Server) config(w http.ResponseWriter, r *http.Request, auth Auth) {
	c, err := s.Kernel.Agent(r.Context(), auth)
	if err != nil {
		kernelError(w, err)
		return
	}
	writeJSON(w, http.StatusOK, map[string]any{"model": c.Model, "grant": modelCapability(c.Model), "maxTokens": c.MaxTokens, "maxSteps": c.MaxSteps})
}

// createSession creates a session with the grants the platform gives new
// chats, which include the agent's model.
func (s *Server) createSession(w http.ResponseWriter, r *http.Request, auth Auth) {
	var body struct {
		Title string `json:"title"`
	}
	if r.ContentLength != 0 {
		if err := json.NewDecoder(io.LimitReader(r.Body, 4<<10)).Decode(&body); err != nil {
			jsonError(w, http.StatusBadRequest, "body must be {title?}")
			return
		}
	}
	session, err := s.Kernel.CreateSession(r.Context(), auth, r.PathValue("ws"), body.Title, nil)
	if err != nil {
		kernelError(w, err)
		return
	}
	writeJSON(w, http.StatusCreated, session)
}

// send starts a turn with the user's message and works through it in the
// background; the page follows the transcript in the kernel.
func (s *Server) send(w http.ResponseWriter, r *http.Request, auth Auth) {
	var body struct {
		Content string `json:"content"`
	}
	if err := json.NewDecoder(io.LimitReader(r.Body, 64<<10)).Decode(&body); err != nil || strings.TrimSpace(body.Content) == "" {
		jsonError(w, http.StatusBadRequest, "body must be {content}")
		return
	}
	ws, id := r.PathValue("ws"), r.PathValue("id")
	tn, session, config, err := s.Kernel.StartTurn(r.Context(), auth, ws, id, body.Content)
	if err != nil {
		kernelError(w, err)
		return
	}
	ctx, ok := s.begin(id, time.UnixMilli(tn.ExpiresAt))
	if !ok {
		// Shutting down: give the turn back so the user can try again.
		_ = s.Kernel.EndTurn(r.Context(), Auth{Turn: tn.Token}, ws, id, tn.ID)
		jsonError(w, http.StatusServiceUnavailable, "the agent is restarting; try again")
		return
	}
	t := &turn{
		kernel:  s.Kernel,
		config:  config,
		log:     s.log(),
		app:     "https://" + r.Host,
		ws:      ws,
		id:      id,
		auth:    Auth{Turn: tn.Token},
		session: session,
	}
	go s.work(ctx, t, tn)
	writeJSON(w, http.StatusAccepted, map[string]any{"turn": map[string]any{"id": tn.ID, "expiresAt": tn.ExpiresAt}})
}

// begin registers a turn, unless the server is shutting down.
func (s *Server) begin(id string, deadline time.Time) (context.Context, bool) {
	s.mu.Lock()
	defer s.mu.Unlock()
	if s.closed {
		return nil, false
	}
	if s.running == nil {
		s.running = map[string]context.CancelFunc{}
	}
	ctx, cancel := context.WithDeadline(context.Background(), deadline)
	s.running[id] = cancel
	s.wg.Add(1)
	return ctx, true
}

func (s *Server) work(ctx context.Context, t *turn, tn Turn) {
	defer s.wg.Done()
	defer func() {
		s.mu.Lock()
		if cancel := s.running[t.id]; cancel != nil {
			cancel()
		}
		delete(s.running, t.id)
		s.mu.Unlock()
	}()
	start := time.Now()
	t.run(ctx)
	// A turn cut short by a shutdown says so; one that ran out of time is
	// reported by the kernel.
	end, cancel := context.WithTimeout(context.Background(), 10*time.Second)
	defer cancel()
	if ctx.Err() != nil && s.isClosed() {
		t.say(end, "I was interrupted by a restart. Ask me again.")
	}
	if err := s.Kernel.EndTurn(end, t.auth, t.ws, t.id, tn.ID); err != nil && StatusOf(err) != http.StatusUnauthorized {
		s.log().Warn("ending a turn", "session", t.id, "err", err)
	}
	s.log().Info("turn done", "session", t.id, "messages", len(t.session.Messages), "seconds", time.Since(start).Seconds())
}

func (s *Server) isClosed() bool {
	s.mu.Lock()
	defer s.mu.Unlock()
	return s.closed
}

// Shutdown stops taking turns, interrupts the ones in progress, and waits
// for them to say so and end, or for ctx.
func (s *Server) Shutdown(ctx context.Context) {
	s.mu.Lock()
	s.closed = true
	for _, cancel := range s.running {
		cancel()
	}
	s.mu.Unlock()
	done := make(chan struct{})
	go func() {
		s.wg.Wait()
		close(done)
	}()
	select {
	case <-done:
	case <-ctx.Done():
	}
}

func writeJSON(w http.ResponseWriter, status int, v any) {
	w.Header().Set("Content-Type", "application/json")
	w.WriteHeader(status)
	_ = json.NewEncoder(w).Encode(v)
}

func jsonError(w http.ResponseWriter, status int, msg string) {
	writeJSON(w, status, map[string]string{"error": msg})
}

// kernelError passes on the kernel's refusal, or reports that it could not
// be reached.
func kernelError(w http.ResponseWriter, err error) {
	var e *Error
	if errors.As(err, &e) {
		jsonError(w, e.Status, e.Message)
		return
	}
	jsonError(w, http.StatusBadGateway, "the kernel did not answer: "+err.Error())
}
