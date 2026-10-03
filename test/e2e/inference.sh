#!/usr/bin/env bash
# End-to-end test of the inference gateway on the k3s cluster, through the
# real gateway, fleet, Gatekeeper, Envoy AI Gateway, OpenRouter and the
# in-cluster simulator. Checks each Phase 9 acceptance criterion. Expects
# `task k3s:up` (or k3s:platform and k3s:inference) to have run, and:
#   .auth.env            the test users' passwords
#   .buckets.env         the Gatekeeper's bucket key, to read the audit log
#   OPENROUTER_API_KEY   the platform's OpenRouter key, in .env; the test only
#                        checks it never reaches the fleet. The default model
#                        costs a few hundred tokens per run.
# It moves the model "default" to the simulator and back, and gives bob a
# budget of his own in the kernel and removes it; both are restored on exit.
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
: "${OPENROUTER_API_KEY:?set OPENROUTER_API_KEY}"
DEFAULT=inference:model/default:invoke
SIM=inference:model/sim:invoke
GK_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
INF=(kubectl -n kodo-inference)
month=$(date -u +%Y-%m)
started=$(date -u +%Y%m%dT%H%M%S)
day=$(date -u +%Y/%m/%d)
export AWS_REGION=${AWS_REGION:-auto}
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
as_gatekeeper() { AWS_ACCESS_KEY_ID=$GATEKEEPER_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$GATEKEEPER_SECRET_ACCESS_KEY "$@"; }
cell_url() { echo "https://$1.g.$DOMAIN"; }
ask() { # ask USER CELL MODEL PROMPT: the gadget's answer, then the status
  c "$1" -X POST -H "Origin: $(cell_url "$2")" -H 'content-type: application/json' -w '\n%{http_code}' \
    -d "{\"model\":\"$3\",\"prompt\":\"$4\"}" "$(cell_url "$2")/api/chat"
}
admin_api() { deploy/fleet/api.sh "$(kubectl config current-context)" "$@"; }
budgets=''
set_budgets() { [[ $(admin_api PUT /admin/budgets "$1" | sed -n 2p) == 200 ]] || fail "setting budgets to $1"; }
route_default() { # route_default BACKEND MODEL: point the model "default" at a backend
  "${INF[@]}" patch aigatewayroute kodo-inference --type=json -p "[
    {\"op\":\"replace\",\"path\":\"/spec/rules/0/backendRefs\",\"value\":[{\"name\":\"$1\",\"modelNameOverride\":\"$2\"}]}]" >/dev/null
}
restore() {
  kubectl apply -k deploy/inference >/dev/null 2>&1 || true
  [[ -n $budgets ]] && admin_api PUT /admin/budgets "$budgets" >/dev/null 2>&1 || true
}
cleanup() {
  restore
  [[ -n ${alice_cell:-} ]] && api alice DELETE "/workspaces/team/cells/$alice_cell" >/dev/null 2>&1 || true
  [[ -n ${bob_cell:-} ]] && api bob DELETE "/workspaces/team/cells/$bob_cell" >/dev/null 2>&1 || true
}
trap cleanup EXIT
wait_for() { # wait_for SECONDS WHAT COMMAND...: until COMMAND succeeds
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out after ${SECONDS}s waiting for $what"
    sleep 3
  done
}

step "Log in and publish the ask gadget"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
bob_sub=$(c bob "$APP/api/whoami" | json 'd["user"]')
kubectl -n kodo apply -k examples/ask >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/ask-1.0.0 --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null
alice_cell=$(api alice POST /workspaces/team/cells '{"blueprint":"ask"}' | head -1 | json 'd["id"]')
bob_cell=$(api bob POST /workspaces/team/cells '{"blueprint":"ask"}' | head -1 | json 'd["id"]')
for who in alice bob; do
  cell=alice_cell
  [[ $who == bob ]] && cell=bob_cell
  res=$(api "$who" PUT "/workspaces/team/cells/${!cell}/grants" "{\"grants\":[\"$DEFAULT\",\"$SIM\"]}")
  [[ $(tail -1 <<<"$res") == 200 ]] || fail "granting models to $who's cell: $res"
done
echo "alice's cell $alice_cell, bob's cell $bob_cell, both granted $DEFAULT and $SIM"

step "A gadget calls a model through its binding with no provider key in the fleet"
out=$(ask alice "$alice_cell" default "Reply with one word: the capital of France.")
[[ $(tail -1 <<<"$out") == 200 ]] || fail "asking default: $out"
backend=$(head -1 <<<"$out" | json 'd["backend"]')
[[ $backend == meta-llama/* ]] || fail "default was answered by $backend"
echo "default answered by $backend: $(head -1 <<<"$out" | json 'd["content"][:80]') ($(head -1 <<<"$out" | json 'd["tokens"]'))"
out=$(ask alice "$alice_cell" sim "hello from kodo")
[[ $(tail -1 <<<"$out") == 200 && $(head -1 <<<"$out" | json 'd["backend"]') == kodo-sim ]] || fail "asking sim: $out"
echo "sim answered: $(head -1 <<<"$out" | json 'd["content"]')"
# The key is in the inference gateway's namespace only: not in any Secret or
# ConfigMap of the fleet's or the Gatekeeper's namespace.
for ns in kodo kodo-system; do
  found=$(kubectl -n "$ns" get secrets,configmaps -o json | python3 -c '
import base64, json, sys
key = sys.argv[1].encode()
n = 0
for item in json.load(sys.stdin)["items"]:
    for v in (item.get("data") or {}).values():
        n += 1
        raw = base64.b64decode(v) if item["kind"] == "Secret" else v.encode()
        if key in raw: print("found in", item["kind"], item["metadata"]["name"]); sys.exit()
print(f"scanned {n} values")' "$OPENROUTER_API_KEY")
  [[ $found == scanned* ]] || fail "the OpenRouter key is in namespace $ns: $found"
  echo "namespace $ns: $found, no OpenRouter key"
done
[[ $(kubectl -n kodo-inference get secret openrouter -o jsonpath='{.data.apiKey}' | base64 -d) == "$OPENROUTER_API_KEY" ]] ||
  fail "the scan would not have found the key: it is not the one the gateway uses"
kubectl -n kodo exec kodo-0 -- env | grep -q "$OPENROUTER_API_KEY" && fail "the OpenRouter key is in a fleet node's environment"
probe() { kubectl -n kodo exec kodo-0 -- timeout 6 bash -c "exec 3<>/dev/tcp/$1/$2" >/dev/null 2>&1; }
tunnel() {
  kubectl -n kodo exec kodo-0 -- timeout 10 bash -c \
    "exec 3<>/dev/tcp/kodo-gatekeeper.kodo-system.svc/8082; printf 'CONNECT $1 HTTP/1.1\r\nHost: $1\r\n\r\n' >&3; head -1 <&3" |
    tr -d '\r'
}
probe kodo-inference.envoy-gateway-system.svc 80 && fail "a fleet node reached the inference gateway"
probe openrouter.ai 443 && fail "a fleet node reached OpenRouter"
[[ $(tunnel openrouter.ai:443) == *" 403 "* ]] || fail "the egress proxy tunnelled to OpenRouter"
# Only the Gatekeeper's pods, in kodo-system, reach the inference gateway: a
# pod with the Gatekeeper's label in the fleet's namespace does not.
impostor=$(kubectl -n kodo run inference-impostor --rm -i --restart=Never --labels=app.kubernetes.io/name=kodo-gatekeeper \
  --image=curlimages/curl:8.16.0 --command -- curl -s -m 5 -o /dev/null -w '%{http_code}' \
  http://kodo-inference.envoy-gateway-system.svc/v1/models 2>/dev/null | head -c 3 || true)
[[ $impostor == 000 ]] || fail "a pod outside kodo-system reached the inference gateway: $impostor"
echo "no OpenRouter key in a fleet node's environment"
echo "fleet nodes cannot reach the inference gateway or OpenRouter, directly or through the egress proxy; nor can an impostor pod"

step "Routing to two backends is configurable without gadget changes"
route_default sim kodo-sim
moved() { [[ $(ask alice "$alice_cell" default "where are you?" | head -1 | json 'd.get("backend")') == kodo-sim ]]; }
wait_for 60 "the model default to move to the simulator" moved
echo "default now answered by kodo-sim, the same gadget and grant"
restore
back() { [[ $(ask alice "$alice_cell" default "and now?" | head -1 | json 'd.get("backend")') == meta-llama/* ]]; }
wait_for 60 "the model default to move back to OpenRouter" back
echo "default answered by OpenRouter again"

step "A user over budget is refused"
# Budgets are the kernel's since Phase 12: bob gets one of a single token
# this month, so his next call crosses it and the one after is refused.
budgets=$(admin_api GET /admin/budgets | head -1)
[[ $budgets == '{'* ]] || fail "reading the budgets: $budgets"
set_budgets "$(BUDGETS=$budgets python3 -c '
import json, os, sys
b = json.loads(os.environ["BUDGETS"]); b["users"] = {**b.get("users", {}), sys.argv[1]: 1}; print(json.dumps(b))' "$bob_sub")"
refused() { [[ $(ask bob "$bob_cell" sim "spend some tokens for the budget test please" | tail -1) == 429 ]]; }
wait_for 30 "bob to be refused once his budget is spent" refused
out=$(ask bob "$bob_cell" sim "one more")
[[ $(tail -1 <<<"$out") == 429 && $(head -1 <<<"$out" | json 'd["error"]') == *budget* ]] || fail "bob over budget: $out"
echo "bob: $(head -1 <<<"$out" | json 'd["error"]')"
[[ $(ask alice "$alice_cell" sim "am I still fine?" | tail -1) == 200 ]] || fail "alice was refused with bob's budget"
echo "alice, in the same workspace, is not affected"
set_budgets "$budgets"
fresh() { [[ $(ask bob "$bob_cell" sim "back again" | tail -1) == 200 ]]; }
wait_for 30 "bob to be served without his test budget" fresh
echo "with the test budget gone, bob is served again"
spend=$(admin_api GET "/admin/usage?month=$month" | head -1)
SPEND=$spend python3 - "$bob_sub" <<'PY' || fail "budget usage: $spend"
import json, os, sys
u = json.loads(os.environ["SPEND"])
bob = next(x for x in u["users"] if x["user"] == sys.argv[1])
team = next(x for x in u["workspaces"] if x["workspace"] == "team")
assert bob["calls"] >= 2 and bob["tokens"] > 0 and team["tokens"] >= bob["tokens"], (bob, team)
print(f"spent this month: bob {bob['tokens']} tokens of {bob['budget']}, team {team['tokens']} of {team['budget']}")
PY

step "Token usage, storage and activity are reported per user and team"
sleep 7 # the cells write their counts a few seconds after use
report=$(admin_api GET "/workspaces/team/usage?month=$month" | head -1)
REPORT=$report python3 - "$alice_cell" "$bob_cell" <<'PY' || fail "usage report: $report"
import json, os, sys
alice_cell, bob_cell = sys.argv[1:]
r = json.loads(os.environ["REPORT"])
cells = {c["id"]: c for c in r["cells"]}
a, b = cells[alice_cell], cells[bob_cell]
assert a["inference"]["default"]["calls"] >= 3 and a["inference"]["default"]["total"] > 0, a
assert a["inference"]["sim"]["calls"] >= 2, a
# Bob's refused calls used nothing; at least the one after his test budget counts.
assert b["inference"]["sim"]["calls"] >= 1 and "default" not in b["inference"], b
for c in (a, b):
    assert c["requests"] >= c["inference"]["sim"]["calls"] and c["lastActive"] and c["storageBytes"] > 0, c
owners = {o["email"].split("@")[0]: o for o in r["owners"]}
for name, cell in (("alice", a), ("bob", b)):
    assert owners[name]["inference"]["total"] >= sum(m["total"] for m in cell["inference"].values()), owners[name]
t = r["totals"]
assert t["inference"]["total"] == sum(o["inference"]["total"] for o in r["owners"]), t
assert t["storageBytes"] == sum(c["storageBytes"] or 0 for c in r["cells"]) and t["activeCells"] >= 2, t
print(f"workspace team, {r['month']}: {t['cells']} cells ({t['activeCells']} active), {t['requests']} requests, "
      f"{t['storageBytes']} bytes stored, {t['inference']['calls']} model calls, {t['inference']['total']} tokens")
for name, o in sorted(owners.items()):
    print(f"  {name}: {o['cells']} cells, {o['requests']} requests, {o['inference']['calls']} calls, "
          f"{o['inference']['input']} in / {o['inference']['output']} out")
print(f"  alice's cell: {json.dumps(a['inference'])}, {a['storageBytes']} bytes, {a['requests']} requests")
PY
mine=$(api bob GET "/workspaces/team/usage" | head -1)
MINE=$mine python3 - "$bob_cell" "$alice_cell" "$bob_sub" <<'PY' || fail "bob's own report: $mine"
import json, os, sys
bob_cell, alice_cell, bob_sub = sys.argv[1:]
r = json.loads(os.environ["MINE"])
ids = [c["id"] for c in r["cells"]]
assert bob_cell in ids and alice_cell not in ids, ids
assert all(c["owner"]["user"] == bob_sub for c in r["cells"]) and [o["user"] for o in r["owners"]] == [bob_sub], r["owners"]
print(f"bob's own report: his {len(ids)} cells only, {r['totals']['inference']['total']} tokens")
PY

# Per call, with user, workspace, cell and tokens, in the Gatekeeper's audit log.
records=$(as_gatekeeper aws s3api list-objects-v2 --bucket "$GK_BUCKET" --prefix "audit/$day/" \
  --start-after "audit/$day/$started" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep json || true)
for r in $records; do as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$r" -; echo; done > "$results/inference-audit.jsonl"
python3 - "$alice_cell" "$bob_cell" "$results/inference-audit.jsonl" <<'PY' || fail "audit records incomplete"
import json, sys
alice_cell, bob_cell, path = sys.argv[1:]
records = [json.loads(l) for l in open(path) if l.strip()]
metered = [r for r in records if r["decision"] == "metered"]
ok = [r for r in metered if r["cell"] == alice_cell and r["status"] == 200 and r["usage"]["total"] > 0]
# The kernel refuses calls over budget before they reach the Gatekeeper.
refused = [r for r in metered if r["cell"] == bob_cell and r["status"] == 429]
assert ok and not refused, (len(metered), len(ok), len(refused))
assert all(r["user"] and r["workspace"] == "team" and r["grant"].startswith("inference:model/") for r in metered)
print(f"audit: {len(metered)} metered calls, e.g. {json.dumps(ok[0])}")
PY
# The gateway's own metrics, labelled with workspace and Blueprint only.
pod=$(kubectl -n envoy-gateway-system get pod -l gateway.envoyproxy.io/owning-gateway-name=kodo-inference -o name | head -1)
kubectl -n envoy-gateway-system port-forward "$pod" 19564:1064 >/dev/null 2>&1 &
pf=$!
sleep 3
metrics=$(curl -s http://127.0.0.1:19564/metrics | grep '^gen_ai_client_token_usage_sum' | grep 'kodo_workspace="kodo/kodo/team"' || true)
kill $pf
wait $pf 2>/dev/null || true
[[ -n $metrics ]] || fail "no token metrics for workspace kodo/kodo/team"
grep -q 'kodo_blueprint="ask"' <<<"$metrics" || fail "token metrics have no Blueprint label"
! grep -qE 'kodo_user|@' <<<"$metrics" || fail "token metrics carry a user"
echo "gateway metrics: $(wc -l <<<"$metrics" | tr -d ' ') token series for workspace kodo/kodo/team, labelled by Blueprint, none by user"

step "Clean up"
for who in alice bob; do
  cell=${who}_cell
  [[ $(api "$who" DELETE "/workspaces/team/cells/${!cell}" | tail -1) == 204 ]] || fail "deleting ${!cell}"
done
alice_cell='' bob_cell=''
echo "cells deleted"

printf '\nPASS\n'
