#!/usr/bin/env bash
# End-to-end test of the daybreak and hn-reader examples on the k3s cluster,
# through the real gateway, fleet and Gatekeeper, with Hacker News read from
# hn.algolia.com and summaries from the inference gateway. Expects `task
# k3s:up`, a Gatekeeper with GATEKEEPER_WEB_ALLOW=hn.algolia.com, and
# .auth.env. MODEL picks the model for the summary (default sim, which is
# free; default for the real one).
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
# shellcheck source=test/e2e/lib.sh
. test/e2e/lib.sh
MODEL=${MODEL:-sim}
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
cell_url() { echo "https://$1.g.$DOMAIN"; }
gadget() { # gadget USER CELL METHOD PATH [JSON]: the gadget's answer, then the status
  local args=(-X "$3" -H "Origin: $(cell_url "$2")" -w '\n%{http_code}')
  [[ -n ${5:-} ]] && args+=(-H 'content-type: application/json' -d "$5")
  c "$1" "${args[@]}" "$(cell_url "$2")$4"
}
ok() { [[ $(tail -1 <<<"$1") == "${2:-200}" ]] || fail "${3:-call}: $1"; head -1 <<<"$1"; }
cleanup() {
  [[ -n ${daybreak:-} ]] && api alice DELETE "/workspaces/team/cells/$daybreak" >/dev/null 2>&1 || true
  [[ -n ${reader:-} ]] && api alice DELETE "/workspaces/team/cells/$reader" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Log in and publish both examples"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
kubectl -n kodo apply -k examples/daybreak >/dev/null
kubectl -n kodo apply -k examples/hn-reader >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/daybreak-1.0.1 blueprint/hn-reader-1.0.1 --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null
echo "daybreak 1.0.1 and hn-reader 1.0.1 published"

step "Daybreak: a circle of two finds time and meets"
daybreak=$(ok "$(api alice POST /workspaces/team/cells '{"blueprint":"daybreak"}')" 201 "creating the circle" | json 'd["id"]')
gadget bob "$daybreak" GET /api/state | tail -1 | grep -qx 403 || fail "bob could open the circle before it was shared"
ok "$(api alice PUT "/workspaces/team/cells/$daybreak/shares/bob@$DOMAIN" '{"role":"editor"}')" 200 "sharing with bob" >/dev/null
members=$(ok "$(gadget bob "$daybreak" GET /api/state)" 200 "bob opening the circle" | json '[m["email"] for m in d["members"]]')
echo "circle $daybreak shared with bob; members after his first visit: $members"
at() { python3 -c "import datetime as t; d = t.datetime.now(t.timezone.utc) + t.timedelta(days=2); print(int(d.replace(hour=$1, minute=0, second=0, microsecond=0).timestamp() * 1000))"; }
# JSON bodies are built first: bash 3.2 brace-expands them inside $(...).
free() { printf '{"start":%s,"end":%s}' "$(at "$1")" "$(at "$2")"; }
body=$(free 17 21)
ok "$(gadget alice "$daybreak" POST /api/slots "$body")" 200 "alice's free time" >/dev/null
body=$(free 19 23)
state=$(ok "$(gadget bob "$daybreak" POST /api/slots "$body")" 200 "bob's free time")
[[ $(json '[(w["with"], w["start"], w["end"]) for w in d["windows"]]' <<<"$state") == "[('alice@$DOMAIN', $(at 19), $(at 21))]" ]] ||
  fail "bob's shared windows: $state"
echo "alice free 17:00-21:00, bob 19:00-23:00 (UTC, in two days): bob sees 19:00-21:00 free together"
body=$(printf '{"with":"alice@%s","start":%s,"end":%s,"title":"kodo e2e dinner"}' "$DOMAIN" "$(at 19)" "$(at 20)")
state=$(ok "$(gadget bob "$daybreak" POST /api/meetings "$body")" 200 "proposing")
meeting=$(json 'd["meetings"][0]["id"]' <<<"$state")
[[ $(gadget bob "$daybreak" POST "/api/meetings/$meeting/accept" | tail -1) == 403 ]] || fail "bob accepted his own proposal"
state=$(ok "$(gadget alice "$daybreak" POST "/api/meetings/$meeting/accept")" 200 "accepting")
STATE=$state python3 - "$DOMAIN" <<'PY' || fail "after accepting: $state"
import json, os, sys
s = json.loads(os.environ["STATE"])
m = s["meetings"][0]
assert m["status"] == "accepted" and m["with"] == "bob@" + sys.argv[1], m
free = {x["email"].split("@")[0]: [(f["end"] - f["start"]) // 3600000 for f in x["free"]] for x in s["members"]}
assert free["alice"] == [2, 1] and free["bob"] == [3], free
print(f"accepted '{m['title']}'; free hours left: alice {free['alice']}, bob {free['bob']}")
PY
ok "$(gadget alice "$daybreak" POST "/api/meetings/$meeting/cancel")" 200 "cancelling" >/dev/null
echo "cancelled; the hour is free again for both"

step "HN Reader: Hacker News through a web grant, summarised by a model"
reader=$(ok "$(api alice POST /workspaces/team/cells '{"blueprint":"hn-reader"}')" 201 "creating the reader" | json 'd["id"]')
[[ $(gadget alice "$reader" GET /api/stories | tail -1) == 403 ]] || fail "the reader read without a grant"
body=$(printf '{"grants":["web:hn.algolia.com/api/v1:read","inference:model/%s:invoke"]}' "$MODEL")
ok "$(api alice PUT "/workspaces/team/cells/$reader/grants" "$body")" 200 "granting" >/dev/null
front=$(ok "$(gadget alice "$reader" GET '/api/stories?list=front')" 200 "the front page")
n=$(json 'len(d["stories"])' <<<"$front")
((n >= 10)) || fail "the front page has $n stories"
echo "front page: $n stories, e.g. $(json 'repr(d["stories"][0]["title"]) + " (" + str(d["stories"][0]["points"]) + " points)"' <<<"$front")"
id=$(json 'max(d["stories"], key=lambda s: s["comments"])["id"]' <<<"$front")
thread=$(ok "$(gadget alice "$reader" GET "/api/stories/$id")" 200 "story $id")
echo "story $id: $(json 'str(len(d["comments"])) + " of " + str(d["total"]) + " comments shown"' <<<"$thread")"
[[ $(json 'any("<p>" in c["text"] or "<a " in c["text"] for c in d["comments"])' <<<"$thread") == False ]] ||
  fail "comments still contain HTML"
[[ $(gadget alice "$reader" GET '/api/stories?list=front' | head -1 | json "[s['read'] for s in d['stories'] if s['id'] == '$id'][0]") == True ]] ||
  fail "the story is not marked read"
[[ $(gadget bob "$reader" GET /api/stories | tail -1) == 403 ]] || fail "bob could open alice's reader"
summary=$(ok "$(gadget alice "$reader" POST "/api/stories/$id/summary" '{}')" 200 "summarising")
echo "summary by $(json 'd["model"] + " (" + str(d["backend"]) + ")"' <<<"$summary"): $(json 'd["text"][:100].replace("\n", " ")' <<<"$summary")…"

step "Clean up"
for cell in "$daybreak" "$reader"; do
  [[ $(api alice DELETE "/workspaces/team/cells/$cell" | tail -1) == 204 ]] || fail "deleting $cell"
done
daybreak='' reader=''
echo "cells deleted"

printf '\nPASS\n'
