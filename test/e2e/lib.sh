# Helpers for the end-to-end tests that go through the hiddenfield.dev
# gateway: curl as a logged-in user, and log the test users in to Dex.
# Source it from the repository root; it reads .auth.env.
# shellcheck shell=bash
set -a
# shellcheck disable=SC1091
. ./.auth.env
set +a
GATEWAY=${GATEWAY:-192.168.2.224}
DOMAIN=${DOMAIN:-hiddenfield.dev}
APP=https://app.$DOMAIN
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

login() { # login USER PASSWORD
  rm -f "$(jar "$1")"
  # Follow the login redirects to Dex's password form.
  local form
  form=$(c "$1" -L -o /dev/null -w '%{url_effective}' "$APP/api/whoami")
  [[ $form == https://auth.$DOMAIN/* ]] || fail "login for $1 did not reach Dex: $form"
  # Submit it; Dex redirects to the gateway's callback, which sets the
  # session cookie and returns to the original URL.
  local who
  who=$(c "$1" -L --data-urlencode "login=$1@$DOMAIN" --data-urlencode "password=$2" "$form")
  [[ $who == *"\"email\":\"$1@$DOMAIN\""* ]] || fail "login for $1 ended with: $who"
  echo "$1 logged in: $who"
}

api() { # api USER METHOD PATH [JSON]
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/api$3"
}

