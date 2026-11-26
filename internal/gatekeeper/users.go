package gatekeeper

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"io"
	"net/http"
	"strings"
	"sync"
	"time"

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

	// UserinfoURL is the issuer's userinfo endpoint, for an issuer that
	// leaves the email out of its ID tokens. The email is then asked for
	// there, with the access token the gateway forwards as a bearer token.
	// The email only labels audit records: a user is known by subject.
	UserinfoURL string
	// HTTP makes the userinfo calls; http.DefaultClient with a 10 s timeout
	// if nil.
	HTTP *http.Client

	mu     sync.Mutex
	emails map[string]knownEmail
}

// knownEmail is what userinfo said for a subject, and until when to trust it.
type knownEmail struct {
	email string
	until time.Time
}

const (
	emailTTL   = 10 * time.Minute
	emailRetry = time.Minute
)

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
	email := claims.Email
	if email == "" && u.UserinfoURL != "" {
		email = u.email(r, token.Subject)
	}
	return User{Sub: token.Subject, Email: strings.ToLower(email)}, nil
}

// email is the subject's email from userinfo, or "" if it cannot be had. A
// failure is not an error: the user is still who the ID token says.
func (u *OIDCUsers) email(r *http.Request, sub string) string {
	u.mu.Lock()
	known, ok := u.emails[sub]
	u.mu.Unlock()
	if ok && time.Now().Before(known.until) {
		return known.email
	}
	access, found := strings.CutPrefix(r.Header.Get("Authorization"), "Bearer ")
	if !found || access == "" {
		return known.email
	}
	email, err := u.userinfo(r.Context(), sub, strings.TrimSpace(access))
	ttl := emailTTL
	if err != nil {
		// Keep what was known, and ask again soon.
		email, ttl = known.email, emailRetry
	}
	u.mu.Lock()
	if u.emails == nil || len(u.emails) > 10_000 {
		u.emails = map[string]knownEmail{}
	}
	u.emails[sub] = knownEmail{email: email, until: time.Now().Add(ttl)}
	u.mu.Unlock()
	return email
}

// userinfo asks the issuer for the email of the access token's holder, who
// must be sub: a caller must not gain another user's email with their own
// token.
func (u *OIDCUsers) userinfo(ctx context.Context, sub, access string) (string, error) {
	ctx, cancel := context.WithTimeout(ctx, 10*time.Second)
	defer cancel()
	req, err := http.NewRequestWithContext(ctx, http.MethodGet, u.UserinfoURL, nil)
	if err != nil {
		return "", err
	}
	req.Header.Set("Authorization", "Bearer "+access)
	req.Header.Set("Accept", "application/json")
	client := u.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return "", err
	}
	defer func() { _ = res.Body.Close() }()
	if res.StatusCode != http.StatusOK {
		return "", fmt.Errorf("userinfo answered %d", res.StatusCode)
	}
	var body struct {
		Sub   string `json:"sub"`
		Email string `json:"email"`
	}
	if err := json.NewDecoder(io.LimitReader(res.Body, 1<<20)).Decode(&body); err != nil {
		return "", err
	}
	if body.Sub != sub {
		return "", errors.New("userinfo is for another subject")
	}
	return body.Email, nil
}
