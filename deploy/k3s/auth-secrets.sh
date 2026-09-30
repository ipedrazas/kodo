#!/usr/bin/env bash
# Creates the secrets the LAN identity setup needs, once: a Dex client secret
# shared with the gateway, and passwords for the test users alice and bob.
# The plain values go to .auth.env (git-ignored) for the e2e test; Kubernetes
# gets the client secret and bcrypt hashes.
set -euo pipefail
cd "$(dirname "$0")/../.."
if [[ ! -f .auth.env ]]; then
  {
    echo "DEX_CLIENT_SECRET=$(openssl rand -hex 24)"
    echo "ALICE_PASSWORD=$(openssl rand -hex 12)"
    echo "BOB_PASSWORD=$(openssl rand -hex 12)"
  } > .auth.env
  chmod 600 .auth.env
fi
set -a
. ./.auth.env
set +a
hash() { htpasswd -nbBC 10 x "$1" | cut -d: -f2 | sed 's/^\$2y\$/$2a$/'; }

kubectl create namespace kodo-auth --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n kodo-auth create secret generic dex-secrets \
  --from-literal=DEX_CLIENT_SECRET="$DEX_CLIENT_SECRET" \
  --from-literal=ALICE_PASSWORD_HASH="$(hash "$ALICE_PASSWORD")" \
  --from-literal=BOB_PASSWORD_HASH="$(hash "$BOB_PASSWORD")" \
  --dry-run=client -o yaml | kubectl apply -f -
kubectl create namespace kodo --dry-run=client -o yaml | kubectl apply -f -
kubectl -n kodo create secret generic oidc-client \
  --from-literal=client-secret="$DEX_CLIENT_SECRET" --dry-run=client -o yaml | kubectl apply -f -
