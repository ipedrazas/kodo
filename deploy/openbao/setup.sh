#!/usr/bin/env bash
# Prepares OpenBao for the kodo Gatekeeper and prints its AppRole credentials.
# Run it once, as an OpenBao administrator; it is safe to run again.
#
#   1. enables the transit engine (if it is not already)
#   2. creates the transit key, derived (each ciphertext is bound to a user
#      and provider) and not exportable
#   3. writes the policy in gatekeeper-policy.hcl: encrypt and decrypt only
#   4. enables AppRole auth (if it is not already) and writes the role
#   5. prints the role_id and a new secret_id, or writes them into an env file
#
# Needs the bao CLI (or vault, with BAO=vault), BAO_ADDR and an admin
# BAO_TOKEN (or a `bao login` session).
#
# usage: deploy/openbao/setup.sh [--env-file FILE] [--rotate]
#   --env-file FILE  set OPENBAO_ADDR, OPENBAO_ROLE_ID and OPENBAO_SECRET_ID
#                    in FILE (e.g. .env) instead of printing them
#   --rotate         only issue a new secret_id for the existing role
#
# Settings (environment):
#   TRANSIT_MOUNT     transit                the transit engine's mount
#   TRANSIT_KEY       kodo-gatekeeper        the key's name
#   APPROLE_MOUNT     approle                the AppRole auth mount
#   ROLE              kodo-gatekeeper        the role, and the policy's name
#   TOKEN_TTL         1h                     life of a Gatekeeper login
#   TOKEN_MAX_TTL     4h
#   SECRET_ID_TTL     0                      0 never expires; rotate with --rotate
#   BOUND_CIDRS       (none)                 e.g. 192.168.2.0/24: where the
#                                            secret_id and tokens may be used from
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
BAO=${BAO:-bao}
TRANSIT_MOUNT=${TRANSIT_MOUNT:-transit}
TRANSIT_KEY=${TRANSIT_KEY:-kodo-gatekeeper}
APPROLE_MOUNT=${APPROLE_MOUNT:-approle}
ROLE=${ROLE:-kodo-gatekeeper}
TOKEN_TTL=${TOKEN_TTL:-1h}
TOKEN_MAX_TTL=${TOKEN_MAX_TTL:-4h}
SECRET_ID_TTL=${SECRET_ID_TTL:-0}
BOUND_CIDRS=${BOUND_CIDRS:-}

env_file="" rotate=""
while [[ $# -gt 0 ]]; do
  case $1 in
    --env-file) env_file=$2; shift 2 ;;
    --rotate) rotate=1; shift ;;
    *) echo "unknown argument: $1" >&2; exit 2 ;;
  esac
done
: "${BAO_ADDR:?set BAO_ADDR to the address of OpenBao}"
export VAULT_ADDR=$BAO_ADDR
[[ -n ${BAO_TOKEN:-} ]] && export VAULT_TOKEN=$BAO_TOKEN
log() { echo "$*" >&2; }

if [[ -z $rotate ]]; then
  if ! "$BAO" secrets list -format=json | grep -q "\"$TRANSIT_MOUNT/\""; then
    "$BAO" secrets enable -path="$TRANSIT_MOUNT" transit >/dev/null
    log "enabled transit at $TRANSIT_MOUNT/"
  fi
  if ! "$BAO" read "$TRANSIT_MOUNT/keys/$TRANSIT_KEY" >/dev/null 2>&1; then
    "$BAO" write -f "$TRANSIT_MOUNT/keys/$TRANSIT_KEY" type=aes256-gcm96 derived=true exportable=false >/dev/null
    log "created transit key $TRANSIT_MOUNT/keys/$TRANSIT_KEY (derived, not exportable)"
  fi
  "$BAO" write "$TRANSIT_MOUNT/keys/$TRANSIT_KEY/config" deletion_allowed=false >/dev/null

  sed -e "s#transit/encrypt/kodo-gatekeeper#$TRANSIT_MOUNT/encrypt/$TRANSIT_KEY#" \
      -e "s#transit/decrypt/kodo-gatekeeper#$TRANSIT_MOUNT/decrypt/$TRANSIT_KEY#" \
      "$here/gatekeeper-policy.hcl" | "$BAO" policy write "$ROLE" - >/dev/null
  log "wrote policy $ROLE"

  if ! "$BAO" auth list -format=json | grep -q "\"$APPROLE_MOUNT/\""; then
    "$BAO" auth enable -path="$APPROLE_MOUNT" approle >/dev/null
    log "enabled AppRole at auth/$APPROLE_MOUNT/"
  fi
  role_args=(
    token_policies="$ROLE"
    token_ttl="$TOKEN_TTL"
    token_max_ttl="$TOKEN_MAX_TTL"
    secret_id_ttl="$SECRET_ID_TTL"
    secret_id_num_uses=0
    token_num_uses=0
  )
  if [[ -n $BOUND_CIDRS ]]; then
    role_args+=(secret_id_bound_cidrs="$BOUND_CIDRS" token_bound_cidrs="$BOUND_CIDRS")
  fi
  "$BAO" write "auth/$APPROLE_MOUNT/role/$ROLE" "${role_args[@]}" >/dev/null
  log "wrote role auth/$APPROLE_MOUNT/role/$ROLE"
fi

role_id=$("$BAO" read -field=role_id "auth/$APPROLE_MOUNT/role/$ROLE/role-id")
secret_id=$("$BAO" write -f -field=secret_id "auth/$APPROLE_MOUNT/role/$ROLE/secret-id")
log "issued a new secret_id for $ROLE"

if [[ -z $env_file ]]; then
  printf 'OPENBAO_ADDR=%s\nOPENBAO_ROLE_ID=%s\nOPENBAO_SECRET_ID=%s\n' "$BAO_ADDR" "$role_id" "$secret_id"
  exit 0
fi
# Replace or append each setting in the env file, keeping everything else.
touch "$env_file"
tmp=$(mktemp)
trap 'rm -f "$tmp"' EXIT
grep -v -E '^(OPENBAO_ADDR|OPENBAO_ROLE_ID|OPENBAO_SECRET_ID)=' "$env_file" > "$tmp" || true
printf 'OPENBAO_ADDR=%s\nOPENBAO_ROLE_ID=%s\nOPENBAO_SECRET_ID=%s\n' "$BAO_ADDR" "$role_id" "$secret_id" >> "$tmp"
cat "$tmp" > "$env_file"
log "wrote OPENBAO_ADDR, OPENBAO_ROLE_ID and OPENBAO_SECRET_ID to $env_file"
