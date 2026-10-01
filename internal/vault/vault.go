// Package vault encrypts and decrypts the Gatekeeper's stored tokens with a
// key the Gatekeeper never holds. OpenBao's transit engine is the one
// implementation; a cloud KMS can be another.
package vault

import (
	"context"
	"errors"
)

// Vault encrypts and decrypts small secrets. The context binds a ciphertext
// to what it belongs to (a user and provider): decrypting it under any other
// context fails, so ciphertexts cannot be swapped between users.
type Vault interface {
	Encrypt(ctx context.Context, context, plaintext []byte) (string, error)
	Decrypt(ctx context.Context, context []byte, ciphertext string) ([]byte, error)
}

// ErrDenied is returned when the backend refuses the operation, for example
// because the ciphertext was made under another context.
var ErrDenied = errors.New("vault refused the operation")
