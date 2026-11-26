#!/usr/bin/env bash
# Creates the end-to-end tests' users in Authrim: alice, bob and carol,
# <name>@$EMAIL_DOMAIN, each signing in with an authenticator app whose
# secret goes to .auth.env (ALICE_TOTP_SECRET, BOB_TOTP_SECRET,
# CAROL_TOTP_SECRET). test/e2e/lib.sh computes the codes from them. A user
# who already has a secret in .auth.env is left alone.
#
# In Authrim's Admin UI, first: Authentication Methods, Authenticator App,
# tick Login and Signup, TOTP preset Compatible, Save. Afterwards:
#   - untick Signup again: it lets anyone create an account;
#   - End Users: mark each of the three addresses as verified. kodo ignores
#     an email the identity provider has not verified, so until then the
#     users sign in with no email and the tests fail at login.
# For task k3s:admin-test, carol must also be a platform admin:
#   kubectl -n kodo patch fleet kodo --type merge \
#     -p '{"spec":{"admins":{"emails":["<yours>","carol@<EMAIL_DOMAIN>"]}}}'
#
# Whoever holds a secret can sign in as that user. .auth.env is git-ignored.
set -euo pipefail
cd "$(dirname "$0")/../.."
touch .auth.env
set -a
# shellcheck disable=SC1091
. ./.auth.env
set +a
DOMAIN=${DOMAIN:-hiddenfield.dev}
IDP=${IDP:-https://auth.applet.one}
EMAIL_DOMAIN=${EMAIL_DOMAIN:-$DOMAIN}

fail() { echo "$*" >&2; exit 1; }
# post PATH JSON: the answer. Authrim refuses a write that names no origin.
post() {
  curl -sS -m 30 -H "Origin: $IDP" -H 'content-type: application/json' -d "$2" "$IDP$1"
}
field() {
  python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get(sys.argv[1]) or "")
except ValueError:
    pass' "$1"
}
# The authenticator app's current code (SHA-1, 6 digits, 30 s), as in
# test/e2e/lib.sh.
totp() {
  python3 -c '
import base64, hashlib, hmac, struct, sys, time
secret = sys.argv[1].replace(" ", "").upper()
key = base64.b32decode(secret + "=" * (-len(secret) % 8))
digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
at = digest[-1] & 15
print("%06d" % ((struct.unpack(">I", digest[at:at + 4])[0] & 0x7FFFFFFF) % 1000000))' "$1"
}

for user in alice bob carol; do
  var=$(tr '[:lower:]' '[:upper:]' <<<"$user")_TOTP_SECRET
  if [[ -n ${!var:-} ]]; then
    echo "$user: $var is in .auth.env already"
    continue
  fi
  email=$user@$EMAIL_DOMAIN
  options=$(post /api/auth/totp/signup/options "{\"email\":\"$email\",\"name\":\"$user\"}")
  secret=$(field secret <<<"$options")
  [[ -n $secret ]] || fail "$email: Authrim did not start the signup (is Signup ticked for Authenticator App, and the address unused?): $options"
  uri=$(field otpauth_uri <<<"$options")
  if [[ $uri == *algorithm=* && $uri != *algorithm=SHA1* ]] || [[ $uri == *digits=* && $uri != *digits=6* ]]; then
    fail "$email: the TOTP preset is not Compatible (SHA-1, 6 digits): $uri"
  fi
  activated=$(post /api/auth/totp/signup/activate "{\"challenge_id\":\"$(field challenge_id <<<"$options")\",\"code\":\"$(totp "$secret")\"}")
  [[ $activated != *'"error"'* ]] || fail "$email: Authrim refused the first code: $activated"
  echo "$var=$secret" >> .auth.env
  echo "$email created; $var written to .auth.env"
done
echo "Now, in Authrim's Admin UI: untick Signup for Authenticator App, and mark the three addresses as verified (End Users)."
