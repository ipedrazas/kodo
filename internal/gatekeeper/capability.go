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

// Provider is one external service the Gatekeeper can call for gadgets.
type Provider interface {
	// Prepare checks a gadget's request against a capability and returns the
	// request to make upstream, without credentials. An error is a denial,
	// and its message says why.
	Prepare(ctx context.Context, c Capability, r CallRequest) (*http.Request, error)
	// Authorize adds a user's token to a prepared request.
	Authorize(req *http.Request, token string)
	// Account checks a token and returns the account it belongs to.
	Account(ctx context.Context, token string) (string, error)
	// ResponseHeaders lists the upstream response headers a gadget may see.
	ResponseHeaders() []string
}
