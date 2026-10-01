package vault

import (
	"bytes"
	"context"
	"encoding/base64"
	"encoding/json"
	"fmt"
	"io"
	"net/http"
	"os"
	"strings"
	"sync"
	"time"
)

// Transit is a Vault on OpenBao's transit engine (Vault's API is the same).
// The key lives in OpenBao and is never exported; the Gatekeeper's policy
// allows only encrypt and decrypt on it. The key must be created with
// derived=true, so every operation takes a context.
type Transit struct {
	// Addr is OpenBao's address, e.g. https://openbao.example.com:8200.
	Addr string
	// Mount is the transit engine's mount path; "transit" if empty.
	Mount string
	// Key is the transit key's name.
	Key string
	// Login obtains a client token.
	Login Login
	// HTTP is the client to use; http.DefaultClient if nil.
	HTTP *http.Client

	mu      sync.Mutex
	token   string
	expires time.Time
}

// Login authenticates to OpenBao and returns a client token and how long it
// is valid for.
type Login interface {
	Login(ctx context.Context, t *Transit) (token string, ttl time.Duration, err error)
}

// AppRole logs in with a role ID and secret ID.
type AppRole struct {
	// Mount of the AppRole auth method; "approle" if empty.
	Mount  string
	RoleID string
	// SecretID, or SecretIDFile to read it from a file on each login, so a
	// rotated secret ID in a mounted Secret is picked up.
	SecretID     string
	SecretIDFile string
}

func (a AppRole) Login(ctx context.Context, t *Transit) (string, time.Duration, error) {
	secret := a.SecretID
	if a.SecretIDFile != "" {
		b, err := os.ReadFile(a.SecretIDFile)
		if err != nil {
			return "", 0, err
		}
		secret = strings.TrimSpace(string(b))
	}
	return t.login(ctx, orDefault(a.Mount, "approle"), map[string]string{"role_id": a.RoleID, "secret_id": secret})
}

// Kubernetes logs in with the pod's service account token.
type Kubernetes struct {
	// Mount of the Kubernetes auth method; "kubernetes" if empty.
	Mount string
	Role  string
	// JWTFile is the projected service account token;
	// /var/run/secrets/kubernetes.io/serviceaccount/token if empty.
	JWTFile string
}

func (k Kubernetes) Login(ctx context.Context, t *Transit) (string, time.Duration, error) {
	jwt, err := os.ReadFile(orDefault(k.JWTFile, "/var/run/secrets/kubernetes.io/serviceaccount/token"))
	if err != nil {
		return "", 0, err
	}
	return t.login(ctx, orDefault(k.Mount, "kubernetes"), map[string]string{"role": k.Role, "jwt": strings.TrimSpace(string(jwt))})
}

// StaticToken uses a fixed token, for development against `bao server -dev`.
type StaticToken string

func (s StaticToken) Login(context.Context, *Transit) (string, time.Duration, error) {
	return string(s), 24 * time.Hour, nil
}

func (t *Transit) Encrypt(ctx context.Context, context, plaintext []byte) (string, error) {
	var out struct {
		Ciphertext string `json:"ciphertext"`
	}
	err := t.do(ctx, "encrypt", map[string]string{
		"plaintext": base64.StdEncoding.EncodeToString(plaintext),
		"context":   base64.StdEncoding.EncodeToString(context),
	}, &out)
	return out.Ciphertext, err
}

func (t *Transit) Decrypt(ctx context.Context, context []byte, ciphertext string) ([]byte, error) {
	var out struct {
		Plaintext string `json:"plaintext"`
	}
	if err := t.do(ctx, "decrypt", map[string]string{
		"ciphertext": ciphertext,
		"context":    base64.StdEncoding.EncodeToString(context),
	}, &out); err != nil {
		return nil, err
	}
	return base64.StdEncoding.DecodeString(out.Plaintext)
}

// do calls transit/<op>/<key>, logging in first if needed, and once more if
// the token was revoked or expired early.
func (t *Transit) do(ctx context.Context, op string, body map[string]string, out any) error {
	path := fmt.Sprintf("/v1/%s/%s/%s", orDefault(t.Mount, "transit"), op, t.Key)
	for attempt := 0; ; attempt++ {
		token, err := t.clientToken(ctx)
		if err != nil {
			return fmt.Errorf("openbao login: %w", err)
		}
		status, err := t.request(ctx, path, token, body, out)
		if status == http.StatusForbidden && attempt == 0 {
			t.forget(token)
			continue
		}
		return err
	}
}

func (t *Transit) clientToken(ctx context.Context) (string, error) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token != "" && time.Now().Before(t.expires) {
		return t.token, nil
	}
	token, ttl, err := t.Login.Login(ctx, t)
	if err != nil {
		return "", err
	}
	// Renew by logging in again once 80% of the token's life has passed.
	t.token, t.expires = token, time.Now().Add(ttl*4/5)
	return token, nil
}

func (t *Transit) forget(token string) {
	t.mu.Lock()
	defer t.mu.Unlock()
	if t.token == token {
		t.token = ""
	}
}

func (t *Transit) login(ctx context.Context, mount string, body map[string]string) (string, time.Duration, error) {
	var out struct {
		Auth struct {
			ClientToken   string `json:"client_token"`
			LeaseDuration int    `json:"lease_duration"`
		} `json:"auth"`
	}
	if _, err := t.request(ctx, "/v1/auth/"+mount+"/login", "", body, &out); err != nil {
		return "", 0, err
	}
	if out.Auth.ClientToken == "" {
		return "", 0, fmt.Errorf("no client token in the %s login response", mount)
	}
	ttl := time.Duration(out.Auth.LeaseDuration) * time.Second
	if ttl <= 0 {
		ttl = time.Hour
	}
	return out.Auth.ClientToken, ttl, nil
}

// request POSTs body to OpenBao and decodes the "data" of the answer into out
// (or the whole answer, for logins). It returns the HTTP status.
func (t *Transit) request(ctx context.Context, path, token string, body map[string]string, out any) (int, error) {
	payload, err := json.Marshal(body)
	if err != nil {
		return 0, err
	}
	req, err := http.NewRequestWithContext(ctx, http.MethodPost, strings.TrimSuffix(t.Addr, "/")+path, bytes.NewReader(payload))
	if err != nil {
		return 0, err
	}
	req.Header.Set("Content-Type", "application/json")
	if token != "" {
		req.Header.Set("X-Vault-Token", token)
	}
	client := t.HTTP
	if client == nil {
		client = http.DefaultClient
	}
	res, err := client.Do(req)
	if err != nil {
		return 0, err
	}
	defer func() { _ = res.Body.Close() }()
	raw, err := io.ReadAll(io.LimitReader(res.Body, 1<<20))
	if err != nil {
		return res.StatusCode, err
	}
	if res.StatusCode != http.StatusOK {
		var e struct {
			Errors []string `json:"errors"`
		}
		_ = json.Unmarshal(raw, &e)
		msg := strings.Join(e.Errors, "; ")
		if res.StatusCode == http.StatusBadRequest || res.StatusCode == http.StatusForbidden {
			return res.StatusCode, fmt.Errorf("%w: %s %d: %s", ErrDenied, path, res.StatusCode, msg)
		}
		return res.StatusCode, fmt.Errorf("openbao %s: %d: %s", path, res.StatusCode, msg)
	}
	if strings.HasSuffix(path, "/login") {
		return res.StatusCode, json.Unmarshal(raw, out)
	}
	var envelope struct {
		Data json.RawMessage `json:"data"`
	}
	if err := json.Unmarshal(raw, &envelope); err != nil {
		return res.StatusCode, err
	}
	return res.StatusCode, json.Unmarshal(envelope.Data, out)
}

func orDefault(s, def string) string {
	if s == "" {
		return def
	}
	return s
}
