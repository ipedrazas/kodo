#!/usr/bin/env bash
# End-to-end test of the agent writing gadgets on the k3s cluster, through
# the real gateway, agent, fleet, Gatekeeper, inference gateway (the model
# "agent") and Hacker News' public API. Checks each Phase 11 acceptance
# criterion. Expects `task k3s:up` with the agent, and:
#   .auth.env        the test users' passwords
#   .buckets.env     the Gatekeeper's bucket key, to read the audit log
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
WEB=web:hn.algolia.com/api/v1:read
GK_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
run=$(date -u +%Y%m%dT%H%M%S)
started=$run
day=$(date -u +%Y/%m/%d)
gadget="echo-$(date -u +%m%d%H%M%S)"
export AWS_REGION=${AWS_REGION:-auto}
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
as_gatekeeper() { AWS_ACCESS_KEY_ID=$GATEKEEPER_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$GATEKEEPER_SECRET_ACCESS_KEY "$@"; }
chat() { # chat USER METHOD PATH [JSON]: the agent's API, body then status
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/chat/api$3"
}
body() { head -1 <<<"$1"; }
code() { tail -1 <<<"$1"; }
session() { api alice GET "/workspaces/team/sessions/$sid" | head -1; }
wait_for() { # wait_for SECONDS WHAT COMMAND...
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out after ${SECONDS}s waiting for $what"
    sleep 3
  done
}
idle() { [[ $(session | json 'd["turn"]' 2>/dev/null) == None ]]; }
say() {
  local payload out
  payload=$(python3 -c 'import json, sys; print(json.dumps({"content": sys.argv[1]}))' "$1")
  out=$(chat alice POST "/workspaces/team/sessions/$sid/messages" "$payload")
  [[ $(code "$out") == 202 ]] || fail "sending: $out"
  wait_for 300 "the agent to answer" idle
}
# The last draft of the gadget in the latest turn: "version ok".
last_draft() {
  session > "$results/authoring-session.json"
  python3 - "$results/authoring-session.json" "$gadget" <<'PY'
import json, sys
ms, name = json.load(open(sys.argv[1]))["messages"], sys.argv[2]
start = max(i for i, m in enumerate(ms) if m["role"] == "user")
drafts = [json.loads(m["content"]) for m in ms[start:] if m["role"] == "tool" and m.get("name") == "write_gadget"]
drafts = [d for d in drafts if d.get("name") == name and d.get("version")]
if drafts:
    print(drafts[-1]["version"], drafts[-1]["ok"])
PY
}
cell_url() { echo "https://$1.g.$DOMAIN"; }
in_cell() { # in_cell USER CELL METHOD PATH [JSON]: the gadget's own API, body then status
  local args=(-X "$3" -H "Origin: $(cell_url "$2")" -w '\n%{http_code}')
  [[ -n ${5:-} ]] && args+=(-H 'content-type: application/json' -d "$5")
  c "$1" "${args[@]}" "$(cell_url "$2")$4"
}
cells=()
cleanup() {
  for cl in "${cells[@]:-}"; do
    [[ -n $cl ]] || continue
    api alice DELETE "/workspaces/team/cells/$cl" >/dev/null 2>&1 || api bob DELETE "/workspaces/team/cells/$cl" >/dev/null 2>&1 || true
  done
}
trap cleanup EXIT
new_cell() { # new_cell USER VERSION: prints the cell id
  local payload out
  payload="{\"blueprint\":\"$gadget\",\"version\":\"$2\"}"
  out=$(api "$1" POST /workspaces/team/cells "$payload")
  [[ $(code "$out") == 201 ]] || fail "$1 creating a cell of $gadget $2: $out"
  body "$out" | json 'd["id"]'
}
echoes() { # echoes USER CELL TEXT: posts TEXT and checks the reply
  local payload out
  payload=$(python3 -c 'import json, sys; print(json.dumps({"text": sys.argv[1]}))' "$3")
  out=$(in_cell "$1" "$2" POST /api/messages "$payload")
  [[ $(code "$out") == 200 || $(code "$out") == 201 ]] || fail "posting to $2: $out"
  OUT=$(body "$out") python3 - "$3" <<'PY' || fail "the gadget did not echo: $out"
import json, os, sys
r = json.loads(os.environ["OUT"])
assert r.get("from") == "This Gadget" and r.get("text") == sys.argv[1], r
PY
}

step "Log in and open a chat"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
out=$(chat alice POST /workspaces/team/sessions '{}')
[[ $(code "$out") == 201 ]] || fail "creating a session: $out"
sid=$(body "$out" | json 'd["id"]')
echo "session $sid; the gadget will be $gadget"

step "The agent produces a working gadget from a chat request"
say "Write a gadget named $gadget. GET / serves a chat page: when I type a message and send it, the page shows my message and then a reply from \"This Gadget\" with exactly the same text. Behind the page, POST /api/messages takes JSON {text}, stores the message, and answers JSON {\"from\": \"This Gadget\", \"text\": <the same text>}; GET /api/messages answers a JSON array of the stored messages, each with a text field."
read -r v1 ok1 <<<"$(last_draft)"
[[ -n ${v1:-} && $ok1 == True ]] || fail "the agent did not write a working draft (see $results/authoring-session.json)"
mine=$(new_cell alice "$v1")
cells+=("$mine")
page=$(c alice -w '\n%{http_code}' "$(cell_url "$mine")/")
[[ $(code "$page") == 200 && $page == *"<"* ]] || fail "the gadget's page: $page"
echoes alice "$mine" "hello from the e2e test $run"
[[ $(in_cell alice "$mine" GET /api/messages | head -1) == *"hello from the e2e test $run"* ]] || fail "the message was not stored"
echo "$gadget $v1: a draft that serves its page, echoes and stores; alice tried it in $mine"

step "The draft is not instantiable by others until the user publishes"
[[ $(api bob GET "/blueprints/$gadget" | tail -1) == 404 ]] || fail "bob can see the draft"
payload="{\"blueprint\":\"$gadget\",\"version\":\"$v1\"}"
[[ $(api bob POST /workspaces/team/cells "$payload" | tail -1) == 404 ]] || fail "bob could open the draft"
[[ $(api bob POST "/blueprints/$gadget/$v1/publish" | tail -1) == 404 ]] || fail "bob could publish the draft"
out=$(api alice POST "/blueprints/$gadget/$v1/publish")
[[ $(code "$out") == 200 && $(body "$out" | json 'd["status"]') == published ]] || fail "publishing: $out"
bobs=$(new_cell bob "$v1")
cells+=("$bobs")
echoes bob "$bobs" "bob was here"
echo "bob could neither see, open nor publish it; once alice published it, bob's cell $bobs echoes"

step "A revised gadget becomes a new Blueprint version; existing instances are unaffected"
say "Revise $gadget: keep everything it does, and add GET /api/top, which answers JSON {\"title\": ...} with the title of the most popular Hacker News story about kodo, fetched with the capability $WEB from the path /search?query=kodo&tags=story&hitsPerPage=1. If that capability is not granted, /api/top answers 403 with JSON {\"error\": ...}."
read -r v2 ok2 <<<"$(last_draft)"
[[ -n ${v2:-} && $ok2 == True && $v2 != "$v1" ]] || fail "the revision is not a new working version (see $results/authoring-session.json)"
versions=$(api alice GET "/blueprints/$gadget" | head -1)
VERSIONS=$versions python3 - "$v1" "$v2" "$WEB" <<'PY' || fail "versions: $versions"
import json, os, sys
v1, v2, web = sys.argv[1:]
vs = {v["version"]: v for v in json.loads(os.environ["VERSIONS"])["versions"]}
assert vs[v1]["status"] == "published" and vs[v2]["status"] == "draft", vs
assert web in vs[v2]["capabilities"], vs[v2]
PY
[[ $(api alice GET "/workspaces/team/cells/$mine" | head -1 | json 'd["version"]') == "$v1" ]] || fail "alice's cell moved off $v1"
[[ $(api bob GET "/workspaces/team/cells/$bobs" | head -1 | json 'd["version"]') == "$v1" ]] || fail "bob's cell moved off $v1"
[[ $(status alice "$(cell_url "$mine")/api/top") != 200 ]] || fail "alice's cell on $v1 serves the revision's /api/top"
[[ $(in_cell alice "$mine" GET /api/messages | head -1) == *"hello from the e2e test $run"* ]] || fail "the message was not stored"
echo "$gadget $v1: a draft that serves its page, echoes and stores; alice tried it in $mine"

step "The draft is not instantiable by others until the user publishes"
[[ $(api bob GET "/blueprints/$gadget" | tail -1) == 404 ]] || fail "bob can see the draft"
payload="{\"blueprint\":\"$gadget\",\"version\":\"$v1\"}"
[[ $(api bob POST /workspaces/team/cells "$payload" | tail -1) == 404 ]] || fail "bob could open the draft"
[[ $(api bob POST "/blueprints/$gadget/$v1/publish" | tail -1) == 404 ]] || fail "bob could publish the draft"
out=$(api alice POST "/blueprints/$gadget/$v1/publish")
[[ $(code "$out") == 200 && $(body "$out" | json 'd["status"]') == published ]] || fail "publishing: $out"
bobs=$(new_cell bob "$v1")
cells+=("$bobs")
echoes bob "$bobs" "bob was here"
echo "bob could neither see, open nor publish it; once alice published it, bob's cell $bobs echoes"

step "A revised gadget becomes a new Blueprint version; existing instances are unaffected"
say "Revise $gadget: keep everything it does, and add GET /api/top, which answers JSON {\"title\": ...} with the title of the most popular Hacker News story about kodo, fetched with the capability $WEB from the path /search?query=kodo&tags=story&hitsPerPage=1. If that capability is not granted, /api/top answers 403 with JSON {\"error\": ...}."
read -r v2 ok2 <<<"$(last_draft)"
[[ -n ${v2:-} && $ok2 == True && $v2 != "$v1" ]] || fail "the revision is not a new working version (see $results/authoring-session.json)"
versions=$(api alice GET "/blueprints/$gadget" | head -1)
VERSIONS=$versions python3 - "$v1" "$v2" "$WEB" <<'PY' || fail "versions: $versions"
import json, os, sys
v1, v2, web = sys.argv[1:]
vs = {v["version"]: v for v in json.loads(os.environ["VERSIONS"])["versions"]}
assert vs[v1]["status"] == "published" and vs[v2]["status"] == "draft", vs
assert web in vs[v2]["capabilities"], vs[v2]
PY
for cl in "$mine" "$bobs"; do
  [[ $(api alice GET "/workspaces/team/cells/$cl" | head -1 | json 'd["version"]' 2>/dev/null || api bob GET "/workspaces/team/cells/$cl" | head -1 | json 'd["version"]') == "$v1" ]] ||
    fail "cell $cl moved off $v1"
  [[ $(status alice "$(cell_url "$cl")/api/top") != 200 ]] || [[ $cl == "$bobs" ]] || fail "cell $cl serves /api/top"
done
[[ $(in_cell alice "$mine" GET /api/messages | head -1) == *"hello from the e2e test $run"* ]] || fail "alice's cell lost its messages"
[[ $(api bob GET "/blueprints/$gadget" | head -1 | json '[v["version"] for v in d["versions"]]') == "['$v1']" ]] || fail "bob can see the revision"
echo "$v2 is a draft declaring $WEB; cells on $v1 are unchanged and keep their data; bob sees only $v1"

step "The user sees and grants capabilities before first use"
out=$(api alice POST "/blueprints/$gadget/$v2/publish")
[[ $(code "$out") == 200 ]] || fail "publishing $v2: $out"
fresh=$(new_cell alice "$v2")
cells+=("$fresh")
[[ $(api alice GET "/workspaces/team/cells/$fresh" | head -1 | json 'd["grants"]') == "[]" ]] || fail "a new cell has grants"
before=$(in_cell alice "$fresh" GET /api/top)
[[ $(code "$before") != 200 ]] || fail "the gadget reached Hacker News without a grant: $before"
grants="{\"grants\":[\"$WEB\"]}"
out=$(api alice PUT "/workspaces/team/cells/$fresh/grants" "$grants")
[[ $(code "$out") == 200 ]] || fail "granting: $out"
top() { out=$(in_cell alice "$fresh" GET /api/top); [[ $(code "$out") == 200 ]]; }
wait_for 30 "the granted gadget to answer" top
[[ $(body "$out" | json 'type(d["title"]).__name__') == str ]] || fail "/api/top: $out"
echo "without the grant /api/top answered $(code "$before"); after granting $WEB: $(body "$out")"

step "Audit records who authored and who published"
records=$(as_gatekeeper aws s3api list-objects-v2 --bucket "$GK_BUCKET" --prefix "audit/$day/" \
  --start-after "audit/$day/$started" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep json || true)
for r in $records; do as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$r" -; echo; done > "$results/authoring-audit.jsonl"
alice_sub=$(c alice "$APP/api/whoami" | json 'd["user"]')
python3 - "$results/authoring-audit.jsonl" "$gadget" "$sid" "$alice_sub" "$v1" "$v2" <<'PY' || fail "audit records incomplete"
import json, sys
path, name, session, alice, v1, v2 = sys.argv[1:]
recs = [json.loads(l) for l in open(path) if l.strip()]
mine = [r for r in recs if r.get("blueprint") == name]
authored = {r["version"] for r in mine if r["decision"] == "authored" and r["user"] == alice and r.get("cell") == session}
published = {r["version"] for r in mine if r["decision"] == "published" and r["user"] == alice}
assert {v1, v2} <= authored and {v1, v2} <= published, (authored, published)
print(f"audit: alice authored {sorted(authored)} in session {session} and published {sorted(published)}")
PY

step "PASS"
