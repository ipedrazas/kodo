#!/usr/bin/env bash
# End-to-end test of the Gatekeeper read path on the k3s cluster, through the
# real gateway, fleet and Gatekeeper. Checks each Phase 7 acceptance
# criterion. Expects `task k3s:up` to have run, with the Gatekeeper, and:
#   .auth.env      the test users' passwords
#   .buckets.env   the scoped fleet and Gatekeeper bucket keys
#   GITHUB_TOKEN   a token that can read REPO (default: the gh CLI's token);
#                  it is stored for alice only for the run, then disconnected
#   REPO           a repository to grant (default ipedrazas/kodo)
#   OTHER_REPO     one not granted (default ipedrazas/dotfiles)
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=test/e2e/lib.sh
. test/e2e/lib.sh
set -a
# shellcheck disable=SC1091
. ./.env
# shellcheck disable=SC1091
. ./.buckets.env
set +a
GITHUB_TOKEN=${GITHUB_TOKEN:-$(gh auth token)}
REPO=${REPO:-ipedrazas/kodo}
OTHER_REPO=${OTHER_REPO:-ipedrazas/dotfiles}
GRANT="github:repo/$REPO:read"
GK_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
SCRATCH=kodo-gatekeeper-e2e
started=$(date -u +%Y%m%dT%H%M%S)
day=$(date -u +%Y/%m/%d)
export AWS_REGION=${AWS_REGION:-auto}
q() { python3 -c 'import sys, urllib.parse; print(urllib.parse.quote(sys.argv[1], safe=""))' "$1"; }
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
as_fleet() { AWS_ACCESS_KEY_ID=$FLEET_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$FLEET_SECRET_ACCESS_KEY "$@"; }
as_gatekeeper() { AWS_ACCESS_KEY_ID=$GATEKEEPER_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$GATEKEEPER_SECRET_ACCESS_KEY "$@"; }
gk() { # gk USER METHOD PATH [JSON]: the Gatekeeper's user API
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/gatekeeper/api$3"
}
cleanup() {
  gk alice DELETE /connections/github >/dev/null 2>&1 || true
  kubectl delete namespace "$SCRATCH" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Log in and connect GitHub"
login alice "$ALICE_PASSWORD"
out=$(gk alice PUT /connections/github "{\"token\":\"$GITHUB_TOKEN\"}")
[[ $(tail -1 <<<"$out") == 200 ]] || fail "connecting GitHub: $out"
account=$(head -1 <<<"$out" | json 'd["account"]')
echo "alice connected GitHub as $account"
listed=$(gk alice GET /connections | head -1)
[[ $listed == *'"provider":"github"'* && $listed != *ciphertext* && $listed != *"$GITHUB_TOKEN"* ]] ||
  fail "connections list: $listed"

step "Publish the repo viewer and the capabilities fixture"
kubectl -n kodo apply -k examples/repo-viewer >/dev/null
kubectl -n kodo create configmap gadgets-caps --from-file=capabilities.js=kernel/test/gadgets/capabilities.js \
  --dry-run=client -o yaml | kubectl apply -f - >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Blueprint
metadata: {name: caps-e2e, namespace: kodo}
spec:
  fleet: kodo
  blueprint: caps
  version: e2e
  source: {name: gadgets-caps, key: capabilities.js}
  capabilities: ["github:repo/*/*:read", "github:repo/*/*:write"]
---
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/repo-viewer-1.0.0 blueprint/caps-e2e --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null
new_cell() { api alice POST /workspaces/team/cells "{\"blueprint\":\"$1\"}" | head -1 | json 'd["id"]'; }
viewer=$(new_cell repo-viewer)
caps=$(new_cell caps)
cell() { echo "https://$1.g.$DOMAIN"; }
echo "repo viewer $viewer, fixture $caps"

step "A gadget without the grant has no binding"
[[ $(c alice "$(cell "$caps")/grants") == "[]" ]] || fail "fixture has bindings before any grant"
[[ $(c alice "$(cell "$viewer")/api/repos" | json 'd["repos"]') == "[]" ]] || fail "viewer lists repos before any grant"
[[ $(status alice "$(cell "$viewer")/api/repos/$REPO") == 403 ]] || fail "viewer read $REPO without a grant"
echo "no grants, no bindings"

step "A gadget with github:repo/$REPO:read reads that repo"
for id in "$viewer" "$caps"; do
  res=$(api alice PUT "/workspaces/team/cells/$id/grants" "{\"grants\":[\"$GRANT\"]}")
  [[ $(tail -1 <<<"$res") == 200 ]] || fail "granting $GRANT to $id: $res"
done
repo=$(c alice "$(cell "$viewer")/api/repos/$REPO")
[[ $(json 'd["name"]' <<<"$repo") == "$REPO" ]] || fail "viewer read: $repo"
[[ $(json 'len(d["commits"]) > 0 and bool(d["readme"])' <<<"$repo") == True ]] || fail "no commits or README: $repo"
echo "read $REPO: $(json '"%s, %d commits, README %d bytes" % (d["name"], len(d["commits"]), len(d["readme"]))' <<<"$repo")"

step "The same gadget is denied a repo or verb outside its grant"
[[ $(status alice "$(cell "$viewer")/api/repos/$OTHER_REPO") == 403 ]] || fail "viewer read $OTHER_REPO"
raw() { c alice "$(cell "$caps")/raw?cap=$(q "$1")&method=$2&path=$(q "${3:-}")"; }
other=$(raw "github:repo/$OTHER_REPO:read" GET)
[[ $(json 'd["status"]' <<<"$other") == 403 && $other == *"no grant"* ]] || fail "another repo: $other"
post=$(raw "$GRANT" POST /issues)
[[ $(json 'd["status"]' <<<"$post") == 403 && $post == *"not a read"* ]] || fail "another verb: $post"
escape=$(raw "$GRANT" GET "/../../$OTHER_REPO")
[[ $(json 'd["status"]' <<<"$escape") == 403 ]] || fail "path escape: $escape"
write=$(raw "github:repo/$REPO:write" POST /issues)
[[ $(json 'd["status"]' <<<"$write") == 403 ]] || fail "write capability: $write"
echo "other repo, POST, path escape and write: all 403 from the Gatekeeper"

step "The Gatekeeper rejects calls that do not come from a trusted fleet"
kubectl create namespace "$SCRATCH" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
kubectl -n "$SCRATCH" run outsider --image=curlimages/curl:8.16.0 --restart=Never --command -- sleep 600 >/dev/null
kubectl -n "$SCRATCH" run impostor --image=curlimages/curl:8.16.0 --restart=Never \
  --labels=kodo.dev/role=node,kodo.dev/fleet=impostor --command -- sleep 600 >/dev/null
kubectl -n "$SCRATCH" wait --for=condition=Ready pod/outsider pod/impostor --timeout=120s >/dev/null
GK=http://kodo-gatekeeper.kodo-system.svc:8081
code=0
kubectl -n "$SCRATCH" exec outsider -- curl -s -m 5 -o /dev/null "$GK/healthz" || code=$?
[[ $code == 7 || $code == 28 ]] || fail "a pod outside any fleet reached the internal port (curl exit $code)"
body="{\"workspace\":\"team\",\"cell\":\"$caps\",\"blueprint\":\"caps\",\"version\":\"e2e\",\"owner\":{\"user\":\"x\",\"email\":\"alice@$DOMAIN\"},\"grants\":[\"$GRANT\"],\"capability\":\"$GRANT\",\"request\":{\"method\":\"GET\",\"path\":\"\"}}"
signed() { # signed FLEET KEY: POST the call as FLEET signed with KEY
  local ts sig
  ts=$(date +%s)
  sig=$(printf '%s.%s' "$ts" "$body" | openssl dgst -sha256 -hmac "$2" | sed 's/^.* //')
  kubectl -n "$SCRATCH" exec impostor -- curl -s -m 10 -o /dev/null -w '%{http_code}' -X POST "$GK/v1/calls" \
    -H "x-kodo-fleet: $1" -H "x-kodo-timestamp: $ts" -H "x-kodo-signature: v1=$sig" --data-raw "$body"
}
[[ $(signed kodo/kodo not-the-key) == 401 ]] || fail "a call with a forged signature was accepted"
[[ $(signed "$SCRATCH/impostor" not-the-key) == 401 ]] || fail "a call from an unknown fleet was accepted"
echo "outside pods cannot connect; fleet-labelled impostors without the key get 401"

step "Direct outbound connections from a fleet pod fail"
probe() { # probe HOST PORT: exit 0 if a fleet node can open a TCP connection
  kubectl -n kodo exec kodo-0 -- timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1
}
tunnel() { # tunnel HOST:PORT: the egress proxy's answer to CONNECT
  kubectl -n kodo exec kodo-0 -- timeout 10 bash -c \
    "exec 3<>/dev/tcp/kodo-gatekeeper.kodo-system.svc/8082; printf 'CONNECT $1 HTTP/1.1\r\nHost: $1\r\n\r\n' >&3; head -1 <&3" |
    tr -d '\r'
}
for target in "1.1.1.1 443" "api.github.com 443" "t3.storage.dev 443" "dex.kodo-auth.svc 80"; do
  # shellcheck disable=SC2086
  if probe $target; then fail "kodo-0 reached $target directly"; fi
done
probe kodo-gatekeeper.kodo-system.svc 8081 || fail "kodo-0 cannot reach the Gatekeeper"
probe dex.kodo-auth.svc 5556 || fail "kodo-0 cannot reach Dex's keys"
[[ $(tunnel api.github.com:443) == *" 403 "* ]] || fail "the egress proxy tunnelled to GitHub"
[[ $(tunnel t3.storage.dev:443) == *" 200 "* ]] || fail "the egress proxy does not tunnel to the bucket"
echo "direct: 1.1.1.1, GitHub, Tigris blocked; Gatekeeper and Dex open; proxy: Tigris only"

step "Tokens are ciphertext, only in the Gatekeeper's bucket, and never in a fleet"
key=$(as_gatekeeper aws s3 ls "s3://$GK_BUCKET/vault/" --recursive | awk '/github.json$/ {print $4}' | head -1)
[[ -n $key ]] || fail "no stored GitHub connection"
stored=$(as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$key" -)
[[ $stored == *'"ciphertext":"vault:v1:'* && $stored != *"$GITHUB_TOKEN"* ]] || fail "stored connection is not ciphertext"
echo "$key holds only a transit ciphertext"
for prefix in vault/ approvals/ audit/; do
  if as_fleet aws s3 ls "s3://$GK_BUCKET/$prefix" >/dev/null 2>&1; then fail "the fleet key can list $prefix"; fi
done
if as_fleet aws s3 cp "s3://$GK_BUCKET/$key" - >/dev/null 2>&1; then fail "the fleet key can read $key"; fi
fleet_key=$(kubectl -n kodo get secret bucket -o jsonpath='{.data.AWS_ACCESS_KEY_ID}' | base64 -d)
[[ $fleet_key == "$FLEET_ACCESS_KEY_ID" ]] || fail "the fleet does not run with the scoped key"
echo "the fleet's bucket key cannot list or read vault/, approvals/ or audit/"
for p in kodo-0 kodo-1 kodo-2; do
  if kubectl -n kodo logs "$p" --tail=-1 | grep -qF "$GITHUB_TOKEN"; then fail "the token is in $p's log"; fi
done
if kubectl -n kodo get secrets -o yaml | grep -qF "$(printf %s "$GITHUB_TOKEN" | base64)"; then
  fail "the token is in a fleet Secret"
fi
echo "the token is in no fleet log or Secret"

step "The Gatekeeper holds no encryption key"
kubectl -n "$SCRATCH" run bao --image=quay.io/openbao/openbao:2.4.1 --restart=Never \
  --env="BAO_ADDR=$(kubectl -n kodo-system get secret kodo-gatekeeper-openbao -o jsonpath='{.data.OPENBAO_ADDR}' | base64 -d)" \
  --env="ROLE_ID=$(kubectl -n kodo-system get secret kodo-gatekeeper-openbao -o jsonpath='{.data.OPENBAO_ROLE_ID}' | base64 -d)" \
  --env="SECRET_ID=$(kubectl -n kodo-system get secret kodo-gatekeeper-openbao -o jsonpath='{.data.OPENBAO_SECRET_ID}' | base64 -d)" \
  --command -- sleep 600 >/dev/null
kubectl -n "$SCRATCH" wait --for=condition=Ready pod/bao --timeout=120s >/dev/null
policy=$(kubectl -n "$SCRATCH" exec bao -- sh -c '
  export BAO_TOKEN=$(bao write -field=token auth/approle/login role_id=$ROLE_ID secret_id=$SECRET_ID)
  bao read transit/keys/kodo-gatekeeper >/dev/null 2>&1 && echo read-key
  bao read transit/export/encryption-key/kodo-gatekeeper >/dev/null 2>&1 && echo export-key
  bao write -f transit/keys/kodo-gatekeeper/rotate >/dev/null 2>&1 && echo rotate-key
  bao write transit/encrypt/kodo-gatekeeper plaintext=aGk= context=aGk= >/dev/null 2>&1 && echo encrypt
  true')
[[ $policy == encrypt ]] || fail "the Gatekeeper's OpenBao role can: $policy"
echo "the Gatekeeper's role can encrypt, but not read, export or rotate the key"

step "Each call is in the audit log"
records=$(as_gatekeeper aws s3api list-objects-v2 --bucket "$GK_BUCKET" --prefix "audit/$day/" \
  --start-after "audit/$day/$started" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep json || true)
[[ -n $records ]] || fail "no audit records since $started"
for r in $records; do as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$r" -; echo; done > "$results/audit.jsonl"
python3 - "$viewer" "$caps" "$GRANT" "$results/audit.jsonl" <<'PY' || fail "audit records incomplete"
import json, sys
viewer, caps, grant, path = sys.argv[1:]
records = [json.loads(l) for l in open(path) if l.strip()]
def find(**want):
    return [r for r in records if all(r.get(k) == v for k, v in want.items())]
allowed = find(cell=viewer, grant=grant, decision="allowed", blueprint="repo-viewer", workspace="team")
denied = find(cell=caps, decision="denied")
rejected = find(decision="rejected")
for r in allowed + denied:
    assert r["user"] and r["email"].startswith("alice@") and r["fleet"] == "kodo/kodo", r
assert allowed and denied and rejected, (len(allowed), len(denied), len(rejected))
print(f"{len(records)} records: {len(allowed)} allowed for the viewer, {len(denied)} denied for the fixture, {len(rejected)} rejected impostors")
print("e.g.", json.dumps(allowed[0]))
PY

step "Clean up"
for id in "$viewer" "$caps"; do api alice DELETE "/workspaces/team/cells/$id" >/dev/null; done
[[ $(gk alice DELETE /connections/github | tail -1) == 204 ]] || fail "disconnecting GitHub"
gone=$(as_gatekeeper aws s3 ls "s3://$GK_BUCKET/$key" || true)
[[ -z $gone ]] || fail "the token is still stored after disconnecting"
echo "cells deleted, GitHub disconnected, token removed"

printf '\nPASS\n'
