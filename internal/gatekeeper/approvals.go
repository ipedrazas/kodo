package gatekeeper

import (
	"context"
	"crypto/rand"
	"encoding/hex"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"regexp"
	"sort"
	"strings"
	"sync"
	"time"
)

// Approval states. A call that changes something outside waits as pending
// until the cell's owner approves it (executing, then done or failed) or
// rejects it, or it expires. done means the provider answered, whatever its
// status; failed means the call was not made, or its outcome is unknown.
// Every state change is a conditional write, so only one Gatekeeper replica
// can move an approval out of pending, and an approval is executed at most
// once. Nothing ever moves an approval back to pending or retries it.
const (
	StatePending   = "pending"
	StateExecuting = "executing"
	StateDone      = "done"
	StateFailed    = "failed"
	StateRejected  = "rejected"
	StateExpired   = "expired"
	// What a gadget is told about an approval that is not its cell's.
	StateUnknown = "unknown"
)

// Approval is a side-effecting call waiting for, or past, its owner's
// decision, stored as approvals/<user>/<id>.json in the Gatekeeper's bucket.
type Approval struct {
	ID          string      `json:"id"`
	State       string      `json:"state"`
	Reason      string      `json:"reason,omitempty"`
	Fleet       string      `json:"fleet"`
	Workspace   string      `json:"workspace"`
	Cell        string      `json:"cell"`
	Blueprint   string      `json:"blueprint"`
	Version     string      `json:"version"`
	Owner       Owner       `json:"owner"`
	Capability  string      `json:"capability"`
	Provider    string      `json:"provider"`
	Account     string      `json:"account"`
	Request     CallRequest `json:"request"`
	Summary     Summary     `json:"summary"`
	CreatedAt   time.Time   `json:"createdAt"`
	ExpiresAt   time.Time   `json:"expiresAt"`
	DecidedAt   *time.Time  `json:"decidedAt,omitempty"`
	DecidedBy   string      `json:"decidedBy,omitempty"`
	ExecutingAt *time.Time  `json:"executingAt,omitempty"`
	FinishedAt  *time.Time  `json:"finishedAt,omitempty"`
	// The provider's answer, once done.
	Result *Answer `json:"result,omitempty"`
}

// ApprovalStatus is what a gadget learns about one of its approvals.
type ApprovalStatus struct {
	ID         string     `json:"id"`
	State      string     `json:"state"`
	Capability string     `json:"capability,omitempty"`
	Reason     string     `json:"reason,omitempty"`
	CreatedAt  *time.Time `json:"createdAt,omitempty"`
	DecidedAt  *time.Time `json:"decidedAt,omitempty"`
	Result     *Answer    `json:"result,omitempty"`
}

func (a Approval) Status() ApprovalStatus {
	created := a.CreatedAt
	return ApprovalStatus{
		ID: a.ID, State: a.State, Capability: a.Capability, Reason: a.Reason,
		CreatedAt: &created, DecidedAt: a.DecidedAt, Result: a.Result,
	}
}

// Approvals stores approvals in the Gatekeeper's bucket.
type Approvals struct {
	Store Store
	// TTL is how long a call waits for approval before it expires.
	TTL time.Duration
	// Stale is how long an approval may be executing before it is reported
	// failed: a replica stopped mid-call. It must be well beyond the upstream
	// timeout.
	Stale time.Duration
}

const (
	DefaultApprovalTTL   = 7 * 24 * time.Hour
	DefaultApprovalStale = time.Minute
	maxResultBytes       = 256 << 10
)

var approvalID = regexp.MustCompile(`^[0-9]{8}t[0-9]{6}-[0-9a-f]{12}$`)

// ValidApprovalID reports whether s is an approval id: time-ordered, so a
// user's approvals list newest first by key.
func ValidApprovalID(s string) bool { return approvalID.MatchString(s) }

func newApprovalID(now time.Time) (string, error) {
	suffix := make([]byte, 6)
	if _, err := rand.Read(suffix); err != nil {
		return "", err
	}
	return strings.ToLower(now.UTC().Format("20060102T150405")) + "-" + hex.EncodeToString(suffix), nil
}

func approvalKey(user, id string) string {
	return path.Join("approvals", userKey(user), id+".json")
}

func (a Approvals) ttl() time.Duration {
	if a.TTL > 0 {
		return a.TTL
	}
	return DefaultApprovalTTL
}

func (a Approvals) stale() time.Duration {
	if a.Stale > 0 {
		return a.Stale
	}
	return DefaultApprovalStale
}

// Create stores a new pending approval and sets its id.
func (a Approvals) Create(ctx context.Context, ap *Approval, now time.Time) error {
	ap.State = StatePending
	ap.CreatedAt = now.UTC()
	ap.ExpiresAt = ap.CreatedAt.Add(a.ttl())
	for range 3 {
		id, err := newApprovalID(now)
		if err != nil {
			return err
		}
		ap.ID = id
		data, err := json.Marshal(ap)
		if err != nil {
			return err
		}
		if err := a.Store.Create(ctx, approvalKey(ap.Owner.User, id), data); !errors.Is(err, ErrExists) {
			return err
		}
	}
	return ErrExists
}

// Get reads an approval as stored, with its version.
func (a Approvals) Get(ctx context.Context, user, id string) (Approval, string, error) {
	if !ValidApprovalID(id) {
		return Approval{}, "", ErrNotFound
	}
	data, version, err := a.Store.GetVersion(ctx, approvalKey(user, id))
	if err != nil {
		return Approval{}, "", err
	}
	var ap Approval
	if err := json.Unmarshal(data, &ap); err != nil {
		return Approval{}, "", fmt.Errorf("approval %s: %w", id, err)
	}
	return ap, version, nil
}

// Replace writes an approval if it is still at version, and returns its new
// version.
func (a Approvals) Replace(ctx context.Context, ap Approval, version string) (string, error) {
	data, err := json.Marshal(ap)
	if err != nil {
		return "", err
	}
	return a.Store.Replace(ctx, approvalKey(ap.Owner.User, ap.ID), data, version)
}

// Delete removes an approval that never left pending.
func (a Approvals) Delete(ctx context.Context, ap Approval) error {
	return a.Store.Delete(ctx, approvalKey(ap.Owner.User, ap.ID))
}

// IDs lists a user's approval ids, newest first.
func (a Approvals) IDs(ctx context.Context, user string) ([]string, error) {
	keys, err := a.Store.List(ctx, path.Join("approvals", userKey(user))+"/")
	if err != nil {
		return nil, err
	}
	ids := make([]string, 0, len(keys))
	for _, k := range keys {
		if id := strings.TrimSuffix(path.Base(k), ".json"); ValidApprovalID(id) {
			ids = append(ids, id)
		}
	}
	sort.Sort(sort.Reverse(sort.StringSlice(ids)))
	return ids, nil
}

// settle moves an approval whose time has passed to its final state: a
// pending one past its expiry to expired, and one executing for longer than
// Stale to failed. It returns the audit decision, or "" if nothing changed.
func (a Approvals) settle(ap *Approval, now time.Time) string {
	switch {
	case ap.State == StatePending && now.After(ap.ExpiresAt):
		ap.State, ap.FinishedAt = StateExpired, &now
		ap.Reason = "no one approved it within " + a.ttl().String()
		return Expired
	case ap.State == StateExecuting && ap.ExecutingAt != nil && now.Sub(*ap.ExecutingAt) > a.stale():
		ap.State, ap.FinishedAt = StateFailed, &now
		ap.Reason = "the Gatekeeper stopped while making the call: it may or may not have reached " +
			ap.Provider + ", and it will not be retried"
		return Failed
	}
	return ""
}

// errNotPending is returned by a change to an approval that has already
// been decided.
var errNotPending = errors.New("approval is not pending")

// loadApproval reads an approval, settling it first if its time has passed.
// Whichever reader settles it records that in the audit log.
func (s *Server) loadApproval(ctx context.Context, user, id string) (Approval, string, error) {
	for range 5 {
		ap, version, err := s.Approvals.Get(ctx, user, id)
		if err != nil {
			return Approval{}, "", err
		}
		decision := s.Approvals.settle(&ap, s.now())
		if decision == "" {
			return ap, version, nil
		}
		version, err = s.Approvals.Replace(ctx, ap, version)
		if errors.Is(err, ErrConflict) {
			continue
		}
		if err != nil {
			return Approval{}, "", err
		}
		s.log().Warn("approval settled", "approval", ap.ID, "state", ap.State, "reason", ap.Reason)
		s.record(ctx, approvalRecord(ap, decision))
		return ap, version, nil
	}
	return Approval{}, "", ErrConflict
}

// transition changes an approval with a conditional write, rereading it if
// another replica changed it first. change returns an error to leave the
// approval as it is.
func (s *Server) transition(ctx context.Context, user, id string, change func(*Approval) error) (Approval, string, error) {
	for range 5 {
		ap, version, err := s.loadApproval(ctx, user, id)
		if err != nil {
			return Approval{}, "", err
		}
		if err := change(&ap); err != nil {
			return ap, version, err
		}
		version, err = s.Approvals.Replace(ctx, ap, version)
		if errors.Is(err, ErrConflict) {
			continue
		}
		return ap, version, err
	}
	return Approval{}, "", ErrConflict
}

// execute makes an approved call, which the caller has just moved to
// executing at version, and records how it ended. It never retries.
func (s *Server) execute(ctx context.Context, ap Approval, version string, approver User) Approval {
	rec := approvalRecord(ap, Approved)
	rec.User, rec.Email = approver.Sub, approver.Email
	if !s.record(ctx, rec) {
		return s.finish(ctx, ap, version, nil, "the audit log is unavailable, so the call was not made", approver)
	}
	provider, ok := s.Providers[ap.Provider]
	c, err := ParseCapability(ap.Capability)
	if !ok || err != nil {
		return s.finish(ctx, ap, version, nil, "no provider "+ap.Provider, approver)
	}
	conn, token, err := s.Tokens.Credential(ctx, ap.Owner.User, ap.Provider)
	switch {
	case errors.Is(err, ErrNotConnected):
		return s.finish(ctx, ap, version, nil, "the owner has disconnected "+ap.Provider, approver)
	case err != nil:
		s.log().Error("reading token", "provider", ap.Provider, "err", err)
		return s.finish(ctx, ap, version, nil, "the owner's "+ap.Provider+" token is unavailable", approver)
	case conn.Account != ap.Account:
		return s.finish(ctx, ap, version, nil, "the "+ap.Provider+" connection changed since the call was queued", approver)
	}
	req, err := provider.Prepare(ctx, c, ap.Request, ap.Account)
	if err != nil {
		return s.finish(ctx, ap, version, nil, err.Error(), approver)
	}
	provider.Authorize(req, token)
	// A provider that deduplicates by key sends this approval once even if
	// the request reaches it twice.
	req.Header.Set("Idempotency-Key", ap.ID)
	answer, err := s.send(req, provider, approvalRecord(ap, Executed))
	if err != nil {
		return s.finish(ctx, ap, version, nil, "the call may or may not have reached "+ap.Provider+": "+err.Error(), approver)
	}
	return s.finish(ctx, ap, version, &answer, "", approver)
}

// finish moves an executing approval to done with the provider's answer, or
// to failed with a reason, and records it.
func (s *Server) finish(ctx context.Context, ap Approval, version string, answer *Answer, reason string, approver User) Approval {
	now := s.now()
	ap.FinishedAt = &now
	decision := Executed
	if answer != nil {
		ap.State = StateDone
		if len(answer.Body) > maxResultBytes {
			answer.Headers["x-kodo-body-omitted"] = fmt.Sprint(len(answer.Body))
			answer.Body = nil
		}
		ap.Result = answer
	} else {
		ap.State, ap.Reason, decision = StateFailed, reason, Failed
	}
	if _, err := s.Approvals.Replace(ctx, ap, version); err != nil {
		// Only a replica that took the approval for stale writes over it, and
		// that has already reported it failed.
		s.log().Error("recording the outcome of an approval", "approval", ap.ID, "state", ap.State, "err", err)
		if current, _, err := s.Approvals.Get(ctx, ap.Owner.User, ap.ID); err == nil {
			ap = current
		}
	}
	rec := approvalRecord(ap, decision)
	rec.User, rec.Email, rec.Reason = approver.Sub, approver.Email, reason
	if answer != nil {
		rec.Status = answer.Status
	}
	s.record(ctx, rec)
	return ap
}

// approvalRecord is the audit record of something that happened to an
// approval, attributed to its owner.
func approvalRecord(ap Approval, decision string) Record {
	return Record{
		Decision: decision, Reason: ap.Reason, Fleet: ap.Fleet, Workspace: ap.Workspace,
		User: ap.Owner.User, Email: ap.Owner.Email, Blueprint: ap.Blueprint, Version: ap.Version,
		Cell: ap.Cell, Grant: ap.Capability, Method: ap.Request.Method, Path: ap.Request.Path,
		Provider: ap.Provider, Approval: ap.ID,
	}
}

// loadApprovals reads several of a user's approvals at once. Ones that
// cannot be read are left out.
func (s *Server) loadApprovals(ctx context.Context, user string, ids []string) []Approval {
	out := make([]*Approval, len(ids))
	var wg sync.WaitGroup
	sem := make(chan struct{}, 8)
	for i, id := range ids {
		wg.Add(1)
		go func() {
			defer wg.Done()
			sem <- struct{}{}
			defer func() { <-sem }()
			ap, _, err := s.loadApproval(ctx, user, id)
			if err == nil {
				out[i] = &ap
			} else if !errors.Is(err, ErrNotFound) {
				s.log().Warn("reading approval", "approval", id, "err", err)
			}
		}()
	}
	wg.Wait()
	approvals := make([]Approval, 0, len(ids))
	for _, ap := range out {
		if ap != nil {
			approvals = append(approvals, *ap)
		}
	}
	return approvals
}
