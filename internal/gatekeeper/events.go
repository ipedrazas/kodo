package gatekeeper

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// Decisions for the Blueprint versions the agent writes: a user's agent
// authored a draft, and a user published it.
const (
	Authored  = "authored"
	Published = "published"
)

// Event is what a kernel reports for the audit log about a Blueprint
// version, on POST /v1/events. The Gatekeeper records it as the kernel's
// fleet asserts it, as it does a call.
type Event struct {
	Kind      string `json:"kind"`
	Workspace string `json:"workspace"`
	// Who authored or published it.
	User         Owner    `json:"user"`
	Blueprint    string   `json:"blueprint"`
	Version      string   `json:"version"`
	Bundle       string   `json:"bundle"`
	Capabilities []string `json:"capabilities"`
	// The agent session it was authored in.
	Session string `json:"session,omitempty"`
}

var digest = regexp.MustCompile(`^[0-9a-f]{64}$`)

func (s *Server) handleEvent(w http.ResponseWriter, r *http.Request) {
	body, fleet, ok := s.trusted(w, r)
	if !ok {
		return
	}
	var e Event
	if err := json.Unmarshal(body, &e); err != nil || (e.Kind != Authored && e.Kind != Published) ||
		e.User.User == "" || e.Blueprint == "" || e.Version == "" || !digest.MatchString(e.Bundle) {
		http.Error(w, "malformed event", http.StatusBadRequest)
		return
	}
	rec := Record{
		Decision: e.Kind, Fleet: fleet, Workspace: e.Workspace, User: e.User.User, Email: e.User.Email,
		Blueprint: e.Blueprint, Version: e.Version, Cell: e.Session, Bundle: e.Bundle, Capabilities: e.Capabilities,
	}
	if !s.record(r.Context(), rec) {
		http.Error(w, "the audit log is unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
