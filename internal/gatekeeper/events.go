package gatekeeper

import (
	"encoding/json"
	"net/http"
	"regexp"
)

// Decisions for the Blueprint versions the agent writes: a user's agent
// authored a draft, and a user published it. Admin is any administrator's
// action: changing a setting, a budget, a workspace's members, withdrawing
// a Blueprint version, suspending a user.
const (
	Authored  = "authored"
	Published = "published"
	Admin     = "admin"
)

// Event is what a kernel reports for the audit log on POST /v1/events: a
// Blueprint version authored or published, or an admin's action. The
// Gatekeeper records it as the kernel's fleet asserts it, as it does a call.
type Event struct {
	Kind      string `json:"kind"`
	Workspace string `json:"workspace"`
	// Who authored or published it, or acted.
	User         Owner    `json:"user"`
	Blueprint    string   `json:"blueprint"`
	Version      string   `json:"version"`
	Bundle       string   `json:"bundle"`
	Capabilities []string `json:"capabilities"`
	// The agent session it was authored in.
	Session string `json:"session,omitempty"`
	// An admin's action, e.g. member.set, what it acted on, and how, as the
	// kernel describes it.
	Action string `json:"action,omitempty"`
	Target string `json:"target,omitempty"`
	Detail string `json:"detail,omitempty"`
}

var (
	digest = regexp.MustCompile(`^[0-9a-f]{64}$`)
	action = regexp.MustCompile(`^[a-z]+(\.[a-z]+){0,3}$`)
)

const maxDetail = 4096

// valid reports whether an event has the shape its kind needs.
func (e Event) valid() bool {
	if e.User.User == "" {
		return false
	}
	switch e.Kind {
	case Authored, Published:
		return e.Blueprint != "" && e.Version != "" && digest.MatchString(e.Bundle)
	case Admin:
		return action.MatchString(e.Action) && len(e.Target) <= 512 && len(e.Detail) <= maxDetail
	}
	return false
}

func (s *Server) handleEvent(w http.ResponseWriter, r *http.Request) {
	body, fleet, ok := s.trusted(w, r)
	if !ok {
		return
	}
	var e Event
	if err := json.Unmarshal(body, &e); err != nil || !e.valid() {
		http.Error(w, "malformed event", http.StatusBadRequest)
		return
	}
	rec := Record{
		Decision: e.Kind, Fleet: fleet, Workspace: e.Workspace, User: e.User.User, Email: e.User.Email,
		Blueprint: e.Blueprint, Version: e.Version, Cell: e.Session, Bundle: e.Bundle, Capabilities: e.Capabilities,
		Action: e.Action, Target: e.Target, Detail: e.Detail,
	}
	if !s.record(r.Context(), rec) {
		http.Error(w, "the audit log is unavailable", http.StatusServiceUnavailable)
		return
	}
	w.WriteHeader(http.StatusNoContent)
}
