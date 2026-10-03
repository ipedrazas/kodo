#!/usr/bin/env bash
# End-to-end test of administration on the k3s cluster, through the real
# gateway, Dex, fleet, operator, agent, Gatekeeper and inference gateway (the
# simulator, which is free). Checks each Phase 12 acceptance criterion.
# Expects `task k3s:up` with the agent, Phase 12 images, and:
#   .auth.env   the test users' passwords; carol is the platform admin
#               (deploy/k3s/fleet.yaml), alice and bob are not
# It switches the agent to the simulator for one turn, gives bob a test
# suspension, and withdraws a test Blueprint version; all are undone on exit.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=test/e2e/lib.sh
. test/e2e/lib.sh
: "${CAROL_PASSWORD:?run deploy/k3s/auth-secrets.sh: carol has no password}"
run=$(date -u +%Y%m%d%H%M%S)
WS=admin-e2e
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
body() { head -1 <<<"$1"; }
code() { tail -1 <<<"$1"; }
ok() { # ok OUTPUT STATUS WHAT: the body, if the status is right
  [[ $(code "$1") == "$2" ]] || fail "$3: $1"
  body "$1"
}
chat() { # chat USER METHOD PATH [JSON]: the agent's API
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/chat/api$3"
}
wait_for() { # wait_for SECONDS WHAT COMMAND...
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out after ${SECONDS}s waiting for $what"
    sleep 2
  done
}
settings='' cells=() withdrawn=''
cleanup() {
  [[ -n $settings ]] && api carol PUT /admin/settings "$settings" >/dev/null 2>&1 || true
  api carol PUT /admin/users/"${bob_sub:-x}" '{"suspended":false}' >/dev/null 2>&1 || true
  [[ -n $withdrawn ]] && api carol POST "/blueprints/fixture/$withdrawn/restore" >/dev/null 2>&1 || true
  for cl in "${cells[@]:-}"; do
    [[ -n $cl ]] || continue
    for who in alice bob; do api "$who" DELETE "/workspaces/$WS/cells/$cl" >/dev/null 2>&1 || true; done
  done
}
trap cleanup EXIT

step "Log in"
login alice "$ALICE_PASSWORD" >/dev/null
login bob "$BOB_PASSWORD" >/dev/null
login carol "$CAROL_PASSWORD" >/dev/null
bob_sub=$(api bob GET /whoami | head -1 | json 'd["user"]')
echo "alice, bob and carol logged in"

step "A user named in the Fleet is a platform admin; anyone else gets 403"
[[ $(api carol GET /whoami | head -1 | json 'd.get("platformAdmin")') == True ]] || fail "carol is not a platform admin"
[[ $(api alice GET /whoami | head -1 | json 'd.get("platformAdmin")') == None ]] || fail "alice is a platform admin"
for path in /admin/overview /admin/settings /admin/budgets /admin/usage /admin/workspaces /admin/blueprints /admin/users "/admin/audit?days=1"; do
  [[ $(code "$(api alice GET "$path")") == 403 ]] || fail "alice reached $path"
  [[ $(code "$(api carol GET "$path")") == 200 ]] || fail "carol could not reach $path"
done
for w in "PUT /admin/settings {}" "PUT /admin/budgets {}" "PUT /admin/users/$bob_sub {\"suspended\":true}" "POST /blueprints/fixture/e2e/withdraw" "PUT /workspaces/x-$run {}"; do
  read -r m p b <<<"$w"
  [[ $(code "$(api alice "$m" "$p" "${b:-}")") == 403 ]] || fail "alice could $w"
done
[[ $(status alice "$APP/admin/") == 403 ]] || fail "alice opened the dashboard"
page=$(c carol "$APP/admin/")
[[ $page == *"<title>Admin · kodo</title>"* ]] || fail "carol's dashboard: ${page:0:200}"
echo "carol has every admin endpoint and the dashboard; alice has none"

step "Existing workspaces kept their users as members"
members=$(ok "$(api alice GET /workspaces/team/members)" 200 "team's members")
MEMBERS=$members python3 -c '
import json, os
m = {x["email"]: x for x in json.loads(os.environ["MEMBERS"])["members"]}
for who in ("alice", "bob"):
    e = f"{who}@hiddenfield.dev"
    assert m.get(e, {}).get("role") in ("member", "admin"), (e, m)
print("team:", ", ".join(e + " (" + x["role"] + ", added by " + x["addedBy"] + ")" for e, x in sorted(m.items())))' || fail "team's members: $members"

step "A workspace admin manages members, quota and docs of their workspace and nothing beyond it"
ok "$(api carol PUT "/workspaces/$WS" "{\"quota\":5,\"members\":{\"alice@$DOMAIN\":\"admin\"}}")" 200 "carol creating $WS" >/dev/null
api alice DELETE "/workspaces/$WS/members/bob@$DOMAIN" >/dev/null 2>&1 || true
[[ $(api alice GET "/workspaces/$WS" | head -1 | json 'd["role"]') == admin ]] || fail "alice is not $WS's admin"
[[ $(code "$(api bob POST "/workspaces/$WS/cells" '{"blueprint":"fixture","version":"e2e"}')") == 403 ]] || fail "bob, not a member, created a cell"
[[ $(code "$(chat bob POST "/workspaces/$WS/sessions" '{}')") == 403 ]] || fail "bob, not a member, started a chat"
echo "bob, not a member, can create neither cells nor chats in $WS"
ok "$(api alice PUT "/workspaces/$WS/members/bob@$DOMAIN" '{"role":"member"}')" 200 "alice adding bob" >/dev/null
bobs=$(ok "$(api bob POST "/workspaces/$WS/cells" '{"blueprint":"fixture","version":"e2e"}')" 201 "bob's cell, as a member" | json 'd["id"]')
cells+=("$bobs")
[[ $(api alice PUT "/workspaces/$WS" '{"quota":7}' | head -1 | json 'd["quota"]') == 7 ]] || fail "alice setting the quota"
ok "$(c alice -X PUT -H "Origin: $APP" -H 'content-type: text/markdown' --data-binary $'# Admin e2e\n\nRun '"$run" -w '\n%{http_code}' "$APP/api/workspaces/$WS/docs/e2e.md")" 200 "alice writing a doc" >/dev/null
[[ $(api bob GET "/workspaces/$WS/docs/e2e.md" | head -1) == "# Admin e2e" ]] || fail "bob reading the doc"
[[ $(code "$(api bob PUT "/workspaces/$WS/members/carol@$DOMAIN" '{"role":"member"}')") == 403 ]] || fail "bob, a member, managed members"
[[ $(code "$(api alice PUT /workspaces/team '{"quota":1}')") == 403 ]] || fail "alice changed team"
[[ $(code "$(api alice PUT "/workspaces/team/members/x@$DOMAIN" '{"role":"member"}')") == 403 ]] || fail "alice managed team's members"
echo "alice, $WS's admin, added bob, set the quota to 7 and wrote a doc; team is not hers"

step "Changing the agent's model or output limit applies to the next turn without a restart"
agent_pods() { kubectl -n kodo-system get pod -l app.kubernetes.io/name=kodo-agent -o jsonpath='{range .items[*]}{.metadata.name}:{.status.containerStatuses[0].restartCount} {end}'; }
pods=$(agent_pods)
envs=$(kubectl -n kodo-system get deploy kodo-agent -o json | python3 -c '
import json, sys
d = json.load(sys.stdin)["spec"]["template"]["spec"]["containers"][0]
print(" ".join(sorted([e["name"] for e in d.get("env", [])] + [r["configMapRef"]["name"] for r in d.get("envFrom", []) if "configMapRef" in r])))')
cm=$(kubectl -n kodo-system get cm -o json | python3 -c '
import json, sys
for i in json.load(sys.stdin)["items"]:
    if i["metadata"]["name"].startswith("kodo-agent"): print(" ".join(sorted(i.get("data", {}))))' | sort -u)
[[ $cm == KERNEL_URL ]] || fail "the agent's ConfigMap has more than KERNEL_URL: $cm"
echo "the agent's environment: $envs; its ConfigMap holds only $cm"
settings=$(ok "$(api carol GET /admin/settings)" 200 "reading the settings")
sim=$(SETTINGS=$settings python3 -c 'import json, os; s = json.loads(os.environ["SETTINGS"]); s["agent"].update(model="sim", maxTokens=777, maxSteps=1); print(json.dumps(s))')
ok "$(api carol PUT /admin/settings "$sim")" 200 "switching the agent to the simulator" >/dev/null
config=$(ok "$(chat alice GET /config)" 200 "the chat's config")
[[ $(json 'd["grant"], d["maxTokens"]' <<<"$config") == "inference:model/sim:invoke 777" ]] || fail "the chat's config: $config"
sid=$(ok "$(chat alice POST /workspaces/team/sessions '{"title":"admin e2e"}')" 201 "a new chat" | json 'd["id"]')
ok "$(chat alice POST "/workspaces/team/sessions/$sid/messages" '{"content":"Say hello."}')" 202 "a turn" >/dev/null
idle() { [[ $(api alice GET "/workspaces/team/sessions/$sid" | head -1 | json 'd["turn"]') == None ]]; }
wait_for 120 "the turn to end" idle
api alice GET "/workspaces/team/sessions/$sid" | head -1 > "$results/admin-session.json"
python3 - "$results/admin-session.json" <<'PY' || fail "the turn did not use the simulator"
import json, sys
s = json.load(open(sys.argv[1]))
assert "inference:model/sim:invoke" in s["grants"], s["grants"]
answers = [m for m in s["messages"] if m["role"] == "assistant"]
assert answers and answers[-1]["content"], s["messages"]
print(f"the turn ran on the simulator: {answers[-1]['content'][:80]!r}")
PY
sim_calls=$(api carol GET /admin/usage | head -1 | python3 -c '
import json, sys
u = json.load(sys.stdin)
print(next(x["calls"] for x in u["workspaces"] if x["workspace"] == "team"))')
[[ $(agent_pods) == "$pods" ]] || fail "the agent restarted: $pods -> $(agent_pods)"
api carol PUT /admin/settings "$settings" >/dev/null
settings=''
api alice DELETE "/workspaces/team/sessions/$sid" >/dev/null
echo "no agent pod restarted ($pods); team has made $sim_calls model calls this month; settings restored"

step "A withdrawn Blueprint version cannot be instantiated; existing cells keep running"
digest=$(ok "$(c carol -X POST -H "Origin: $APP" -H 'content-type: text/javascript' --data-binary @kernel/test/gadgets/fixture.js -w '\n%{http_code}' "$APP/api/bundles")" 201 "carol uploading" | json 'd["digest"]')
ok "$(api carol PUT "/blueprints/fixture/a$run" "{\"bundle\":\"$digest\"}")" 201 "carol publishing fixture a$run" >/dev/null
alices=$(ok "$(api alice POST "/workspaces/$WS/cells" "{\"blueprint\":\"fixture\",\"version\":\"a$run\"}")" 201 "alice's cell" | json 'd["id"]')
cells+=("$alices")
ok "$(api carol POST "/blueprints/fixture/a$run/withdraw")" 200 "withdrawing" >/dev/null
withdrawn="a$run"
[[ $(code "$(api bob POST "/workspaces/$WS/cells" "{\"blueprint\":\"fixture\",\"version\":\"a$run\"}")") == 410 ]] || fail "a cell from a withdrawn version"
[[ $(status alice "https://$alices.g.$DOMAIN/") == 200 ]] || fail "alice's cell on the withdrawn version stopped"
echo "fixture a$run withdrawn: no new cells (410); alice's $alices still serves"

step "A suspended user's requests and turns are refused, and their cells are not served to them"
ok "$(api carol PUT "/admin/users/$bob_sub" '{"suspended":true}')" 200 "suspending bob" >/dev/null
refused() { [[ $(code "$(api bob GET /whoami)") == 403 ]]; }
wait_for 30 "bob to be refused" refused
sleep 6 # every node's isolates, not just the one that answered
[[ $(status bob "https://$bobs.g.$DOMAIN/") == 403 ]] || fail "bob's own cell served while suspended"
[[ $(code "$(chat bob POST "/workspaces/$WS/sessions" '{}')") == 403 ]] || fail "bob started a chat while suspended"
[[ $(code "$(api alice GET /whoami)") == 200 ]] || fail "alice refused with bob"
api carol PUT "/admin/users/$bob_sub" '{"suspended":false}' >/dev/null
served() { [[ $(status bob "https://$bobs.g.$DOMAIN/") == 200 ]]; }
wait_for 30 "bob to be served again" served
echo "bob was refused everywhere, his own cell included, until carol lifted it"

step "The dashboard shows models and budgets as configured, with usage against them"
report() { [[ $(api carol GET /admin/overview | head -1 | json 'bool(d["cluster"] and d["cluster"].get("models"))') == True ]]; }
wait_for 90 "the operator's cluster report" report
api carol GET /admin/overview | head -1 > "$results/admin-overview.json"
api carol GET /admin/usage | head -1 > "$results/admin-usage.json"
python3 - "$results/admin-overview.json" "$results/admin-usage.json" "$bob_sub" <<'PY' || fail "the cluster report or usage"
import json, sys
o, u, bob = json.load(open(sys.argv[1])), json.load(open(sys.argv[2])), sys.argv[3]
c = o["cluster"]
models = {m["name"]: m for m in c["models"]}
assert {"agent", "default", "sim"} <= set(models), models
assert any(r["limit"] == 60 and r["unit"] == "Minute" for r in c["rateLimits"]), c["rateLimits"]
assert c["fleet"]["readyReplicas"] >= 1 and c["nodes"], c["fleet"]
assert u["budgets"]["user"] and u["budgets"]["workspace"], u["budgets"]
assert any(x["user"] == bob for x in u["users"]) and all("budget" in x for x in u["users"] + u["workspaces"]), u
print(f"models: " + ", ".join(f"{n} -> {m['backends'][0]['backend']} {m['backends'][0].get('model', '')}" for n, m in sorted(models.items())))
print(f"rate limits: " + ", ".join(f"{r['limit']}/{r['unit']} per {', '.join(r['headers'])}" for r in c["rateLimits"]))
print(f"fleet {c['fleet']['name']}: {c['fleet']['readyReplicas']}/{c['fleet']['replicas']} nodes, kernel {c['fleet']['kernel']}")
team = next(x for x in u["workspaces"] if x["workspace"] == "team")
print(f"budgets: {u['budgets']['user']:,} per user, {u['budgets']['workspace']:,} per workspace; team spent {team['tokens']:,} of {team['budget']:,}")
PY

step "Everything the admin token did for a person, carol does through her login"
[[ $(api carol GET /workspaces | head -1 | json '"team" in d["workspaces"] and "'"$WS"'" in d["workspaces"]') == True ]] || fail "carol listing workspaces"
usage=$(api carol GET "/workspaces/$WS/usage" | head -1)
[[ $(json "sorted({c['owner']['email'].split('@')[0] for c in d['cells']})" <<<"$usage") == "['alice', 'bob']" ]] || fail "carol's usage report: $usage"
ok "$(c carol -X PUT -H "Origin: $APP" -H 'content-type: text/markdown' --data-binary '# by carol' -w '\n%{http_code}' "$APP/api/workspaces/$WS/docs/carol.md")" 200 "carol writing a doc" >/dev/null
ok "$(api carol DELETE "/workspaces/$WS/docs/carol.md")" 204 "carol deleting a doc" >/dev/null
echo "carol published a Blueprint, created a workspace, read every cell's usage and wrote docs"

step "Every admin action is in the audit log with who did it, searchable from the dashboard"
search() { api carol GET "/admin/audit?decision=admin&days=1&limit=200&$1" | head -1; }
found() {
  search "user=carol@$DOMAIN" > "$results/admin-audit-carol.json"
  search "user=alice@$DOMAIN&workspace=$WS" > "$results/admin-audit-alice.json"
  python3 - "$results/admin-audit-carol.json" "$results/admin-audit-alice.json" "$run" "$bob_sub" <<'PY'
import json, sys
carol, alice = (json.load(open(p))["records"] for p in sys.argv[1:3])
run, bob = sys.argv[3:5]
def has(records, action, target=None):
    return any(r["action"] == action and (target is None or r.get("target") == target) for r in records)
need = [
    has(carol, "settings.update"), has(carol, "blueprint.publish", f"fixture@a{run}"),
    has(carol, "blueprint.withdraw", f"fixture@a{run}"), has(carol, "user.suspend", bob), has(carol, "user.unsuspend", bob),
    has(alice, "member.set"), has(alice, "workspace.update"), has(alice, "doc.put", "e2e.md"),
]
if not all(need):
    sys.exit(1)
print(f"carol: {len(carol)} admin records today, e.g. {json.dumps(next(r for r in carol if r['action'] == 'user.suspend'))}")
print(f"alice in the workspace she administers: {len(alice)}, e.g. {json.dumps(next(r for r in alice if r['action'] == 'member.set'))}")
PY
}
wait_for 30 "the admin actions in the audit search" found

step "Clean up"
api carol POST "/blueprints/fixture/a$run/restore" >/dev/null && withdrawn=''
for cl in "${cells[@]}"; do
  out=$(api alice DELETE "/workspaces/$WS/cells/$cl")
  [[ $(code "$out") == 204 ]] || [[ $(code "$(api bob DELETE "/workspaces/$WS/cells/$cl")") == 204 ]] || fail "deleting $cl"
done
cells=()
echo "cells deleted, version restored"

printf '\nPASS\n'
