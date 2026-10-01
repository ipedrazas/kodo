package gatekeeper

import (
	"context"
	"encoding/base64"
	"encoding/json"
	"errors"
	"fmt"
	"path"
	"strings"
	"time"

	"github.com/ipedrazas/kodo/internal/vault"
)

// ErrNotConnected is returned for a provider the user has not connected.
var ErrNotConnected = errors.New("not connected")

// Connection is a user's token for one provider, as stored: only the
// ciphertext, under vault/<user>/<provider>.json.
type Connection struct {
	Provider    string    `json:"provider"`
	Account     string    `json:"account"`
	ConnectedAt time.Time `json:"connectedAt"`
	Ciphertext  string    `json:"ciphertext,omitempty"`
}

// Tokens is the per-user token vault: tokens are encrypted by the Vault and
// only their ciphertext is stored.
type Tokens struct {
	Store Store
	Vault vault.Vault
}

// userKey makes an OIDC subject safe as one object key segment.
func userKey(user string) string { return base64.RawURLEncoding.EncodeToString([]byte(user)) }

func tokenKey(user, provider string) string {
	return path.Join("vault", userKey(user), provider+".json")
}

// encryptionContext binds a ciphertext to its user and provider.
func encryptionContext(user, provider string) []byte {
	return []byte("kodo/vault/" + userKey(user) + "/" + provider)
}

func (t Tokens) Put(ctx context.Context, user, provider, account, token string) (Connection, error) {
	ciphertext, err := t.Vault.Encrypt(ctx, encryptionContext(user, provider), []byte(token))
	if err != nil {
		return Connection{}, fmt.Errorf("encrypting the token: %w", err)
	}
	c := Connection{Provider: provider, Account: account, ConnectedAt: time.Now().UTC(), Ciphertext: ciphertext}
	data, err := json.Marshal(c)
	if err != nil {
		return Connection{}, err
	}
	if err := t.Store.Put(ctx, tokenKey(user, provider), data); err != nil {
		return Connection{}, err
	}
	c.Ciphertext = ""
	return c, nil
}

// Token decrypts a user's token for a provider.
func (t Tokens) Token(ctx context.Context, user, provider string) (string, error) {
	_, token, err := t.Credential(ctx, user, provider)
	return token, err
}

// Connection returns a user's connection to a provider, without decrypting
// its token.
func (t Tokens) Connection(ctx context.Context, user, provider string) (Connection, error) {
	data, err := t.Store.Get(ctx, tokenKey(user, provider))
	if errors.Is(err, ErrNotFound) {
		return Connection{}, ErrNotConnected
	}
	if err != nil {
		return Connection{}, err
	}
	var c Connection
	if err := json.Unmarshal(data, &c); err != nil {
		return Connection{}, err
	}
	return c, nil
}

// Credential returns a user's connection to a provider and its decrypted
// token.
func (t Tokens) Credential(ctx context.Context, user, provider string) (Connection, string, error) {
	c, err := t.Connection(ctx, user, provider)
	if err != nil {
		return Connection{}, "", err
	}
	plain, err := t.Vault.Decrypt(ctx, encryptionContext(user, provider), c.Ciphertext)
	if err != nil {
		return Connection{}, "", fmt.Errorf("decrypting the token: %w", err)
	}
	c.Ciphertext = ""
	return c, string(plain), nil
}

func (t Tokens) Delete(ctx context.Context, user, provider string) error {
	return t.Store.Delete(ctx, tokenKey(user, provider))
}

// List returns a user's connections, without their ciphertexts.
func (t Tokens) List(ctx context.Context, user string) ([]Connection, error) {
	keys, err := t.Store.List(ctx, path.Join("vault", userKey(user))+"/")
	if err != nil {
		return nil, err
	}
	out := []Connection{}
	for _, k := range keys {
		if !strings.HasSuffix(k, ".json") {
			continue
		}
		data, err := t.Store.Get(ctx, k)
		if err != nil {
			continue
		}
		var c Connection
		if json.Unmarshal(data, &c) == nil {
			c.Ciphertext = ""
			out = append(out, c)
		}
	}
	return out, nil
}
