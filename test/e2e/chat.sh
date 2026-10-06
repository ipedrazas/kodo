#!/usr/bin/env bash
# End-to-end test of socket push with the chat example on the k3s cluster:
# alice and bob in one room through the real gateway (wss via Envoy, OIDC
# login). A line from one reaches the other within a second, and a quiet
# socket that pings, as the page does, survives QUIET_S seconds (default
# 600). Expects `task k3s:up` and .auth.env.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=test/e2e/lib.sh
. test/e2e/lib.sh
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
ok() { [[ $(tail -1 <<<"$1") == "${2:-200}" ]] || fail "${3:-call}: $1"; head -1 <<<"$1"; }
cleanup() {
  [[ -n ${room:-} ]] && api alice DELETE "/workspaces/team/cells/$room" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Log in and publish the chat example"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
kubectl -n kodo apply -k examples/chat >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/chat-1.0.0 --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null
echo "chat 1.0.0 published"

step "Alice opens a room and shares it with bob"
room=$(ok "$(api alice POST /workspaces/team/cells '{"blueprint":"chat"}')" 201 "creating the room" | json 'd["id"]')
ok "$(api alice PUT "/workspaces/team/cells/$room/shares/bob@$DOMAIN" '{"role":"editor"}')" 200 "sharing with bob" >/dev/null
echo "room $room shared with bob as editor"

step "Lines through the gateway, then a quiet socket"
GATEWAY=$GATEWAY DOMAIN=$DOMAIN QUIET_S=${QUIET_S:-600} node test/e2e/chat-sockets.mjs "$room" "$(jar alice)" "$(jar bob)"

step "Pushed frames are in the usage report"
usage=$(ok "$(api alice GET /workspaces/team/usage)" 200 "reading usage")
pushed=$(json "[c['pushed'] for c in d['cells'] if c['id'] == '$room'][0]" <<<"$usage")
[[ $pushed -gt 0 ]] || fail "the room pushed nothing: $usage"
echo "room $room pushed $pushed frames"
echo "PASS"
