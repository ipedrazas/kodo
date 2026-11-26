# Helpers for the end-to-end tests that go through the hiddenfield.dev
# gateway: curl as a logged-in user, and sign the test users in to Authrim.
# Source it from the repository root; it reads .auth.env.
#
# The test users are alice, bob and carol, <name>@$EMAIL_DOMAIN. Authrim has
# no password form, so each signs in with an authenticator app, and the code
# is computed here from the secret in .auth.env: ALICE_TOTP_SECRET,
# BOB_TOTP_SECRET, CAROL_TOTP_SECRET (deploy/k3s/authrim-test-users.sh
# creates the accounts and writes them).
# shellcheck shell=bash
set -a
# shellcheck disable=SC1091
. ./.auth.env
set +a
GATEWAY=${GATEWAY:-192.168.2.224}
DOMAIN=${DOMAIN:-hiddenfield.dev}
APP=https://app.$DOMAIN
# The identity provider, and the domain of the test users' addresses.
IDP=${IDP:-https://auth.applet.one}
EMAIL_DOMAIN=${EMAIL_DOMAIN:-$DOMAIN}
export EMAIL_DOMAIN
results=${RESULTS:-test/e2e/results}
mkdir -p "$results"
k=(kubectl -n kodo)

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }
jar() { echo "$results/cookies-$1"; }
# curl through the gateway as USER (a cookie jar), or "anonymous".
c() {
  local who=$1
  shift
  local args=(-sS -m 30 --connect-to "::$GATEWAY:")
  [[ $who != anonymous ]] && args+=(-b "$(jar "$who")" -c "$(jar "$who")")
  curl "${args[@]}" "$@"
}
status() { c "$@" -o /dev/null -w '%{http_code}'; }
# curl to the identity provider with USER's cookie jar. It is not behind the
# gateway, and it refuses a write that names no origin.
idp() {
  local who=$1
  shift
  curl -sS -m 30 -b "$(jar "$who")" -c "$(jar "$who")" -H "Origin: $IDP" "$@"
}

# totp SECRET: the authenticator app's current code (SHA-1, 6 digits, 30 s).
totp() {
  python3 -c '
import base64, hashlib, hmac, struct, sys, time
secret = sys.argv[1].replace(" ", "").upper()
key = base64.b32decode(secret + "=" * (-len(secret) % 8))
digest = hmac.new(key, struct.pack(">Q", int(time.time()) // 30), hashlib.sha1).digest()
at = digest[-1] & 15
print("%06d" % ((struct.unpack(">I", digest[at:at + 4])[0] & 0x7FFFFFFF) % 1000000))' "$1"
}
# field NAME: a string field of the JSON on stdin, or nothing.
field() {
  python3 -c '
import json, sys
try:
    print(json.load(sys.stdin).get(sys.argv[1]) or "")
except ValueError:
    pass' "$1"
}

login() { # login USER: sign in as <USER>@$EMAIL_DOMAIN, unless USER still is
  local user=$1 email=$1@$EMAIL_DOMAIN who secret location form challenge started verified next try
  who=$(c "$user" "$APP/api/whoami" 2>/dev/null || true)
  if [[ -z ${FRESH_LOGIN:-} && $who == *"\"email\":\"$email\""* ]]; then
    echo "$user is logged in: $who"
    return
  fi
  secret=$(tr '[:lower:]' '[:upper:]' <<<"${user}_TOTP_SECRET")
  secret=${!secret:-}
  [[ -n $secret ]] || fail "no $(tr '[:lower:]' '[:upper:]' <<<"$user")_TOTP_SECRET in .auth.env: run deploy/k3s/authrim-test-users.sh"
  rm -f "$(jar "$user")"
  # The gateway sends a request without a session to Authrim, which shows
  # its login page for a challenge.
  location=$(c "$user" -o /dev/null -w '%{redirect_url}' "$APP/api/whoami")
  [[ $location == "$IDP/authorize?"* ]] || fail "login for $user was not sent to Authrim: $location"
  form=$(idp "$user" -L -o /dev/null -w '%{url_effective}' "$location")
  [[ $form == "$IDP/login?"*challenge_id=* ]] || fail "login for $user did not reach Authrim's login page: $form"
  challenge=${form#*challenge_id=}
  challenge=${challenge%%&*}
  # Sign in with the authenticator app. Authrim refuses a code it has seen,
  # so a second sign-in within 30 s waits for the next code.
  for try in 1 2; do
    started=$(idp "$user" -H 'content-type: application/json' -d "{\"identifier\":\"$email\"}" "$IDP/api/auth/totp/login/start")
    verified=$(idp "$user" -H 'content-type: application/json' \
      -d "{\"challenge_id\":\"$(field challenge_id <<<"$started")\",\"code\":\"$(totp "$secret")\",\"authorization_challenge_id\":\"$challenge\"}" \
      "$IDP/api/auth/totp/login/verify")
    next=$(field redirect_url <<<"$verified")
    [[ -n $next ]] && break
    [[ $try == 1 ]] && sleep $((31 - $(date +%s) % 30))
  done
  [[ -n $next ]] || fail "Authrim refused $user's code: $verified"
  [[ $next == /* ]] && next=$IDP$next
  # Authrim finishes the authorization and redirects to the gateway's
  # callback, which sets the session cookie and returns to the first URL.
  for try in 1 2 3 4 5; do
    [[ $next == "$APP/"* ]] && break
    [[ $next == "$IDP/"* ]] || fail "login for $user was redirected to: $next"
    next=$(idp "$user" -o /dev/null -w '%{redirect_url}' "$next")
  done
  [[ $next == "$APP/oauth2/callback?"* ]] || fail "login for $user did not return to the gateway: $next"
  who=$(c "$user" -L "$next")
  [[ $who == *"\"email\":\"$email\""* ]] || fail "login for $user ended with: $who"
  echo "$user logged in: $who"
}

api() { # api USER METHOD PATH [JSON]
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/api$3"
}
