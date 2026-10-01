// Package gatekeeper is the service that makes every external call a gadget
// is allowed to make. A fleet's kernel asserts which cell is calling, who owns
// it and what it was granted; the Gatekeeper decides whether the call is
// within a grant, makes it with the owner's token from the vault, and records
// the decision in the audit log. Tokens never leave the Gatekeeper.
package gatekeeper

import (
	"context"
	"fmt"
	"net/http"
	"strings"
	"time"
)

// Capability is <provider>:<resource>:<verb>, e.g. github:repo/acme/api:read.
// The resource may itself contain slashes and colons.
type Capability struct {
	Provider string
	Resource string
	Verb     string
}

func (c Capability) String() string { return c.Provider + ":" + c.Resource + ":" + c.Verb }

// ParseCapability splits a capability. A wildcard is not a grant, so a
// capability that contains `*` is refused.
func ParseCapability(s string) (Capability, error) {
	first, last := strings.Index(s, ":"), strings.LastIndex(s, ":")
	if first <= 0 || last == first || last == len(s)-1 || len(s) > 256 || strings.ContainsAny(s, " *\t\n") {
		return Capability{}, fmt.Errorf("malformed capability %q", s)
	}
	return Capability{Provider: s[:first], Resource: s[first+1 : last], Verb: s[last+1:]}, nil
}

// The verbs the Gatekeeper knows, and whether their calls change something
// outside: those wait in the approval queue until the cell's owner approves
// them. A read or an invoke (a model call, which changes nothing outside but
// is budgeted) runs at once; any other verb is denied.
var verbs = map[string]bool{"read": false, "invoke": false, "write": true, "send": true, "delete": true}

// SideEffecting reports whether a capability's calls wait for approval, and
// whether its verb is one the Gatekeeper knows at all.
func SideEffecting(c Capability) (waits, known bool) {
	waits, known = verbs[c.Verb]
	return waits, known
}

// Provider is one external service the Gatekeeper can call for gadgets.
type Provider interface {
	// Prepare checks a gadget's request against a capability and returns the
	// request to make upstream, without credentials. An error is a denial,
	// and its message says why. account is the connected account the call
	// acts as.
	Prepare(ctx context.Context, c Capability, r CallRequest, account string) (*http.Request, error)
	// Authorize adds a user's token to a prepared request.
	Authorize(req *http.Request, token string)
	// Account checks a token and returns the account it acts as. requested
	// is the account the user asked for, for providers where they choose
	// one (see AccountChooser); otherwise it is empty.
	Account(ctx context.Context, token, requested string) (string, error)
	// ResponseHeaders lists the upstream response headers a gadget may see.
	ResponseHeaders() []string
	// Describe says what a prepared call will do, for the person asked to
	// approve it.
	Describe(c Capability, r CallRequest, account string) Summary
}

// PlatformProvider is a provider whose credentials the platform holds, not
// each user: users connect nothing, its calls carry no user's token, and it
// names each call's owner, workspace and cell to the service it reaches,
// which budgets and reports on them.
type PlatformProvider interface {
	Provider
	Attribute(req *http.Request, fleet string, call Call)
}

// Metering is a provider whose answers say what the call consumed. Meter may
// also rewrite the answer for the gadget.
type Metering interface {
	Meter(a *Answer) *Usage
}

// TimeLimited is a provider whose calls may take longer, or must take less,
// than DefaultCallTimeout.
type TimeLimited interface {
	CallTimeout() time.Duration
}

// DefaultCallTimeout bounds a call to a provider.
const DefaultCallTimeout = 15 * time.Second

// AccountChooser is a provider whose users name the account when they
// connect, such as the From address of email.
type AccountChooser interface {
	// AccountPrompt is the label for that field.
	AccountPrompt() string
}

// Summary describes a call for a person: a title, the facts that matter, and
// the content it will send.
type Summary struct {
	Title  string  `json:"title"`
	Fields []Field `json:"fields,omitempty"`
	Body   string  `json:"body,omitempty"`
}

type Field struct {
	Name  string `json:"name"`
	Value string `json:"value"`
}
