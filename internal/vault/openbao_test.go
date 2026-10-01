package vault

import (
	"context"
	"encoding/json"
	"errors"
	"fmt"
	"net/http"
	"net/http/httptest"
	"os"
	"strings"
	"sync/atomic"
	"testing"
)

// A fake transit engine: logins issue numbered tokens, and the first token
// is revoked after one use, to check the client logs in again.
func fakeOpenBao(t *testing.T) (*httptest.Server, *atomic.Int32) {
	var logins atomic.Int32
	srv := httptest.NewServer(http.HandlerFunc(func(w http.ResponseWriter, r *http.Request) {
		var body map[string]string
		_ = json.NewDecoder(r.Body).Decode(&body)
		switch {
		case r.URL.Path == "/v1/auth/approle/login":
			if body["role_id"] != "role" || body["secret_id"] != "secret" {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"errors":["invalid role or secret ID"]}`))
				return
			}
			n := logins.Add(1)
			_ = json.NewEncoder(w).Encode(map[string]any{"auth": map[string]any{
				"client_token": fmt.Sprintf("token-%d", n), "lease_duration": 3600,
			}})
		case r.Header.Get("X-Vault-Token") == "token-1" && logins.Load() == 1 && r.URL.Path == "/v1/transit/decrypt/k":
			w.WriteHeader(http.StatusForbidden)
			_, _ = w.Write([]byte(`{"errors":["permission denied"]}`))
		case r.URL.Path == "/v1/transit/encrypt/k":
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{
				"ciphertext": "vault:v1:" + body["context"] + ":" + body["plaintext"],
			}})
		case r.URL.Path == "/v1/transit/decrypt/k":
			parts := strings.SplitN(strings.TrimPrefix(body["ciphertext"], "vault:v1:"), ":", 2)
			if parts[0] != body["context"] {
				w.WriteHeader(http.StatusBadRequest)
				_, _ = w.Write([]byte(`{"errors":["cipher: message authentication failed"]}`))
				return
			}
			_ = json.NewEncoder(w).Encode(map[string]any{"data": map[string]string{"plaintext": parts[1]}})
		default:
			http.NotFound(w, r)
		}
	}))
	t.Cleanup(srv.Close)
	return srv, &logins
}

func TestTransitLogsInEncryptsAndRetriesAfterRevocation(t *testing.T) {
	srv, logins := fakeOpenBao(t)
	v := &Transit{Addr: srv.URL, Key: "k", Login: AppRole{RoleID: "role", SecretID: "secret"}}
	ctx := context.Background()
	ct, err := v.Encrypt(ctx, []byte("alice/github"), []byte("token"))
	if err != nil || !strings.HasPrefix(ct, "vault:v1:") {
		t.Fatalf("encrypt: %q, %v", ct, err)
	}
	plain, err := v.Decrypt(ctx, []byte("alice/github"), ct)
	if err != nil || string(plain) != "token" {
		t.Fatalf("decrypt: %q, %v", plain, err)
	}
	if logins.Load() != 2 {
		t.Errorf("%d logins, want 2 (one after the revoked token)", logins.Load())
	}
	if _, err := v.Decrypt(ctx, []byte("bob/github"), ct); !errors.Is(err, ErrDenied) {
		t.Errorf("decrypt under another context: %v", err)
	}
}

func TestAppRoleReadsTheSecretIDFile(t *testing.T) {
	srv, _ := fakeOpenBao(t)
	file := t.TempDir() + "/secret-id"
	if err := os.WriteFile(file, []byte("secret\n"), 0o600); err != nil {
		t.Fatal(err)
	}
	v := &Transit{Addr: srv.URL, Key: "k", Login: AppRole{RoleID: "role", SecretIDFile: file}}
	if _, err := v.Encrypt(context.Background(), []byte("c"), []byte("p")); err != nil {
		t.Fatal(err)
	}
	bad := &Transit{Addr: srv.URL, Key: "k", Login: AppRole{RoleID: "role", SecretID: "wrong"}}
	if _, err := bad.Encrypt(context.Background(), []byte("c"), []byte("p")); err == nil {
		t.Fatal("a wrong secret ID logged in")
	}
}

// Against a real OpenBao prepared by deploy/openbao/setup.sh, with the
// role_id and secret_id it printed:
//
//	OPENBAO_TEST_ADDR=http://127.0.0.1:8200 OPENBAO_TEST_ROLE_ID=... OPENBAO_TEST_SECRET_ID=... go test ./internal/vault
func TestTransitAgainstOpenBao(t *testing.T) {
	addr := os.Getenv("OPENBAO_TEST_ADDR")
	if addr == "" {
		t.Skip("OPENBAO_TEST_ADDR is not set")
	}
	v := &Transit{Addr: addr, Key: "kodo-gatekeeper", Login: AppRole{
		RoleID: os.Getenv("OPENBAO_TEST_ROLE_ID"), SecretID: os.Getenv("OPENBAO_TEST_SECRET_ID"),
	}}
	ctx := context.Background()
	ct, err := v.Encrypt(ctx, []byte("kodo/vault/alice/github"), []byte("ghp_test"))
	if err != nil || !strings.HasPrefix(ct, "vault:v1:") || strings.Contains(ct, "ghp_test") {
		t.Fatalf("encrypt: %q, %v", ct, err)
	}
	plain, err := v.Decrypt(ctx, []byte("kodo/vault/alice/github"), ct)
	if err != nil || string(plain) != "ghp_test" {
		t.Fatalf("decrypt: %q, %v", plain, err)
	}
	if _, err := v.Decrypt(ctx, []byte("kodo/vault/bob/github"), ct); err == nil {
		t.Error("ciphertext decrypted under another user's context")
	}
	// The policy allows nothing but encrypt and decrypt.
	token, _, err := v.Login.Login(ctx, v)
	if err != nil {
		t.Fatal(err)
	}
	for _, path := range []string{"/v1/transit/keys/kodo-gatekeeper", "/v1/transit/export/encryption-key/kodo-gatekeeper"} {
		req, _ := http.NewRequest(http.MethodGet, addr+path, nil)
		req.Header.Set("X-Vault-Token", token)
		res, err := http.DefaultClient.Do(req)
		if err != nil {
			t.Fatal(err)
		}
		_ = res.Body.Close()
		if res.StatusCode != http.StatusForbidden {
			t.Errorf("GET %s: %d, want 403", path, res.StatusCode)
		}
	}
}
