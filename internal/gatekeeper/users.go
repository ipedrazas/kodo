package gatekeeper

import (
	"context"
	"errors"
	"net/http"
	"strings"

	"github.com/coreos/go-oidc/v3/oidc"
)

// IdentityHeader carries the user's OIDC ID token, forwarded by the gateway
// after login, as it is for the kernel.
const IdentityHeader = "X-Kodo-Identity"

// User is a verified caller of the Gatekeeper's own API.
type User struct {
	Sub   string `json:"user"`
	Email string `json:"email"`
}

// Users verifies the ID tokens the gateway forwards.
type Users interface {
	Identify(r *http.Request) (User, error)
}

// OIDCUsers checks ID tokens against the issuer's keys.
type OIDCUsers struct {
	verifier *oidc.IDTokenVerifier
}

// NewOIDCUsers verifies tokens from issuer for audience, with keys fetched
// from jwksURL (which may be an in-cluster address).
func NewOIDCUsers(ctx context.Context, issuer, audience, jwksURL string) *OIDCUsers {
	keys := oidc.NewRemoteKeySet(ctx, jwksURL)
	return &OIDCUsers{verifier: oidc.NewVerifier(issuer, keys, &oidc.Config{ClientID: audience})}
}

func (u *OIDCUsers) Identify(r *http.Request) (User, error) {
	raw := r.Header.Get(IdentityHeader)
	if raw == "" {
		return User{}, errors.New("missing identity")
	}
	token, err := u.verifier.Verify(r.Context(), raw)
	if err != nil {
		return User{}, err
	}
	var claims struct {
		Email string `json:"email"`
	}
	_ = token.Claims(&claims)
	if token.Subject == "" {
		return User{}, errors.New("token has no subject")
	}
	return User{Sub: token.Subject, Email: strings.ToLower(claims.Email)}, nil
}
