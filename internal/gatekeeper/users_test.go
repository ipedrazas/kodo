package gatekeeper

import (
	"crypto/rand"
	"crypto/rsa"
	"encoding/json"
	"net/http"
	"net/http/httptest"
	"testing"
	"time"

	"github.com/go-jose/go-jose/v4"
)

// testIssuer serves a JWKS and a userinfo endpoint, and signs ID tokens.
type testIssuer struct {
	*httptest.Server
	signer jose.Signer
	// What /userinfo answers, by Authorization header.
	userinfo map[string]map[string]any
	calls    int
}

func newTestIssuer(t *testing.T) *testIssuer {
	t.Helper()
	key, err := rsa.GenerateKey(rand.Reader, 2048)
	if err != nil {
		t.Fatal(err)
	}
	signer, err := jose.NewSigner(jose.SigningKey{Algorithm: jose.RS256, Key: key},
		(&jose.SignerOptions{}).WithHeader("kid", "test"))
	if err != nil {
		t.Fatal(err)
	}
	iss := &testIssuer{signer: signer, userinfo: map[string]map[string]any{}}
	mux := http.NewServeMux()
	mux.HandleFunc("/keys", func(w http.ResponseWriter, _ *http.Request) {
		_ = json.NewEncoder(w).Encode(jose.JSONWebKeySet{Keys: []jose.JSONWebKey{
			{Key: &key.PublicKey, KeyID: "test", Algorithm: "RS256", Use: "sig"},
		}})
	})
	mux.HandleFunc("/userinfo", func(w http.ResponseWriter, r *http.Request) {
		iss.calls++
		body, ok := iss.userinfo[r.Header.Get("Authorization")]
		if !ok {
			w.WriteHeader(http.StatusUnauthorized)
			return
		}
		_ = json.NewEncoder(w).Encode(body)
	})
	iss.Server = httptest.NewServer(mux)
	t.Cleanup(iss.Close)
	return iss
}

func (i *testIssuer) token(t *testing.T, claims map[string]any) string {
	t.Helper()
	all := map[string]any{"iss": "https://auth.test", "aud": "kodo", "exp": time.Now().Add(time.Hour).Unix()}
	for k, v := range claims {
		all[k] = v
	}
	payload, _ := json.Marshal(all)
	signed, err := i.signer.Sign(payload)
	if err != nil {
		t.Fatal(err)
	}
	raw, err := signed.CompactSerialize()
	if err != nil {
		t.Fatal(err)
	}
	return raw
}

func identify(t *testing.T, u *OIDCUsers, token, access string) User {
	t.Helper()
	r := httptest.NewRequest(http.MethodGet, "/gatekeeper/api/connections", nil)
	r.Header.Set(IdentityHeader, token)
	if access != "" {
		r.Header.Set("Authorization", "Bearer "+access)
	}
	user, err := u.Identify(r)
	if err != nil {
		t.Fatal(err)
	}
	return user
}

func TestEmailFromUserinfo(t *testing.T) {
	iss := newTestIssuer(t)
	iss.userinfo["Bearer erin"] = map[string]any{"sub": "sub-erin", "email": "Erin@Test"}
	users := NewOIDCUsers(t.Context(), "https://auth.test", "kodo", iss.URL+"/keys")
	users.UserinfoURL = iss.URL + "/userinfo"

	// An email in the ID token is used as it is.
	alice := iss.token(t, map[string]any{"sub": "sub-alice", "email": "alice@test"})
	if u := identify(t, users, alice, "erin"); u.Email != "alice@test" || iss.calls != 0 {
		t.Errorf("with an email claim: %+v after %d userinfo calls", u, iss.calls)
	}

	erin := iss.token(t, map[string]any{"sub": "sub-erin"})
	if u := identify(t, users, erin, "erin"); u.Sub != "sub-erin" || u.Email != "erin@test" {
		t.Errorf("from userinfo: %+v", u)
	}
	// Remembered: not asked again, and known without the access token.
	if u := identify(t, users, erin, ""); u.Email != "erin@test" || iss.calls != 1 {
		t.Errorf("remembered: %+v after %d userinfo calls", u, iss.calls)
	}

	// Another user's access token, and one userinfo refuses, give no email
	// and do not refuse the user.
	frank := iss.token(t, map[string]any{"sub": "sub-frank"})
	if u := identify(t, users, frank, "erin"); u.Sub != "sub-frank" || u.Email != "" {
		t.Errorf("another user's access token: %+v", u)
	}
	grace := iss.token(t, map[string]any{"sub": "sub-grace"})
	if u := identify(t, users, grace, "unknown"); u.Sub != "sub-grace" || u.Email != "" {
		t.Errorf("a refused access token: %+v", u)
	}
}

func TestNoUserinfoWithoutURL(t *testing.T) {
	iss := newTestIssuer(t)
	users := NewOIDCUsers(t.Context(), "https://auth.test", "kodo", iss.URL+"/keys")
	if u := identify(t, users, iss.token(t, map[string]any{"sub": "sub-erin"}), "erin"); u.Email != "" || iss.calls != 0 {
		t.Errorf("%+v after %d userinfo calls", u, iss.calls)
	}
}
