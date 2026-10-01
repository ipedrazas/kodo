#!/usr/bin/env bash
# End-to-end test of identity, TLS and sharing on the k3s cluster, through the
# real gateway: logs alice and bob in to Dex with curl, then checks each
# Phase 5 acceptance criterion. Expects `task k3s:up` to have run, and the
# test users' passwords in .auth.env.
#
# Connections go straight to the gateway address, so this works whatever the
# public DNS says; names, SNI and certificates are the real ones.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=test/e2e/lib.sh
. test/e2e/lib.sh

step "TLS"
cert=$(echo | openssl s_client -connect "$GATEWAY:443" -servername "x.g.$DOMAIN" 2>/dev/null |
  openssl x509 -noout -issuer -ext subjectAltName)
echo "$cert"
[[ $cert == *"Let's Encrypt"* && $cert == *"*.g.$DOMAIN"* ]] || fail "cell certificate is not the Let's Encrypt wildcard"
renewal=$(kubectl -n kodo-gateway get certificate hiddenfield -o jsonpath='{.status.renewalTime}')
[[ -n $renewal ]] || fail "cert-manager has not scheduled a renewal"
echo "cert-manager renews at $renewal"
[[ $(status anonymous "http://app.$DOMAIN/") == 301 ]] || fail "plain HTTP does not redirect"

step "Unauthenticated requests go to the identity provider"
location=$(c anonymous -o /dev/null -w '%{redirect_url}' "$APP/api/whoami")
[[ $location == "https://auth.$DOMAIN/auth?"* ]] || fail "anonymous request redirected to: $location"
location=$(c anonymous -o /dev/null -w '%{redirect_url}' "https://anycell.g.$DOMAIN/")
[[ $location == "https://auth.$DOMAIN/auth?"* ]] || fail "anonymous cell request redirected to: $location"
echo "redirected to Dex"

step "Log in"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
page=$(c alice "$APP/")
[[ $page == *"<title>kodo</title>"* ]] || fail "the app page after login: $page"
echo "the app page serves after login"

step "Publish gadgets through the operator"
kubectl -n kodo create configmap gadgets --from-file=fixture.js=kernel/test/gadgets/fixture.js \
  --from-file=notes.js=kernel/examples/notes.js --dry-run=client -o yaml | kubectl apply -f - >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Blueprint
metadata: {name: fixture-e2e, namespace: kodo}
spec: {fleet: kodo, blueprint: fixture, version: e2e, source: {name: gadgets, key: fixture.js}}
---
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/fixture-e2e --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null

step "Each user runs their own instance"
new_cell() { api "$1" POST /workspaces/team/cells '{"blueprint":"fixture","version":"e2e"}' | head -1 | sed -E 's/.*"id":"([a-z0-9]+)".*/\1/'; }
alices=$(new_cell alice)
bobs=$(new_cell bob)
cell() { echo "https://$1.g.$DOMAIN"; }
[[ $(status alice "$(cell "$alices")/") == 200 ]] || fail "alice cannot open her cell"
[[ $(status bob "$(cell "$bobs")/") == 200 ]] || fail "bob cannot open his cell"
[[ $(status bob "$(cell "$alices")/") == 403 ]] || fail "bob opened alice's cell"
[[ $(status alice "$(cell "$bobs")/") == 403 ]] || fail "alice opened bob's cell"
echo "alice $alices and bob $bobs each see only their own"

step "Sharing"
share() { api alice "$1" "/workspaces/team/cells/$alices/shares/bob@$DOMAIN" "${2:-}" | tail -1; }
[[ $(share PUT '{"role":"viewer"}') == 200 ]] || fail "sharing failed"
[[ $(status bob "$(cell "$alices")/") == 200 ]] || fail "viewer cannot read"
[[ $(status bob -X POST -H "Origin: $(cell "$alices")" "$(cell "$alices")/") == 403 ]] || fail "viewer could write"
[[ $(share PUT '{"role":"editor"}') == 200 ]] || fail "changing the role failed"
[[ $(status bob -X POST -H "Origin: $(cell "$alices")" "$(cell "$alices")/") == 200 ]] || fail "editor cannot write"
[[ $(share DELETE) == 200 ]] || fail "revoking failed"
[[ $(status bob "$(cell "$alices")/") == 403 ]] || fail "revoked user still has access"
echo "viewer reads, editor writes, revoked user is refused"

step "What the gadget sees"
seen=$(c alice "$(cell "$alices")/?whoami")
echo "$seen" | python3 -c '
import json, sys
h = json.load(sys.stdin)
assert h.get("x-kodo-email") == "alice@'"$DOMAIN"'", h
assert h.get("x-kodo-role") == "owner", h
assert "x-kodo-identity" not in h, "identity token reached the gadget"
assert "kodo-id" not in h.get("cookie", ""), "session cookie reached the gadget"
assert not any(c.strip().startswith(("Oauth", "kodo-")) for c in h.get("cookie", "").split(";") if c.strip()), h.get("cookie")
print("identity:", h["x-kodo-user"], h["x-kodo-email"], h["x-kodo-role"], "- no token, no session cookie")
'

step "Each cell is its own origin"
[[ $(status alice -X POST -H "Origin: $(cell "$bobs")" "$(cell "$alices")/") == 403 ]] || fail "cross-origin write allowed"
[[ $(status alice -X POST -H "Origin: $(cell "$alices")" "$APP/api/workspaces/team/cells" -d '{}') == 403 ]] ||
  fail "a cell's origin could call the API"
echo "writes from another cell's origin are refused"

step "Log out"
c alice -o /dev/null "$APP/logout"
location=$(c alice -o /dev/null -w '%{redirect_url}' "$APP/api/whoami")
[[ $location == "https://auth.$DOMAIN/auth?"* ]] || fail "still logged in after logout: $location"
echo "logged out"

printf '\nPASS\n'
