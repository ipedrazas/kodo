#!/usr/bin/env bash
# End-to-end test of the agent on the k3s cluster, through the real gateway,
# agent, fleet, Gatekeeper, inference gateway (DeepSeek V4 Flash on
# OpenRouter as the model "agent"), Hacker News' public API and Resend.
# Checks each Phase 10 acceptance criterion. Expects `task k3s:up` to have
# run, with the agent (task k3s:agent), and:
#   .auth.env        the test users' passwords
#   .buckets.env     the Gatekeeper's bucket key, to read the audit log
#   RESEND_API_KEY   a Resend API key (sending access is enough); stored for
#   RESEND_FROM      alice only for the run, then disconnected. The one email
#                    the agent drafts is rejected, never sent.
# The agent restarts twice.
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
: "${RESEND_API_KEY:?set RESEND_API_KEY}" "${RESEND_FROM:?set RESEND_FROM}"
MODEL=inference:model/agent:invoke
WEB=web:hn.algolia.com/api/v1:read
SEND=email:outbox:send
GK_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
GK=(kubectl -n kodo-system)
run=$(date -u +%Y%m%dT%H%M%S)
started=$run
day=$(date -u +%Y/%m/%d)
CODEWORD="PERIWINKLE-$run"
export AWS_REGION=${AWS_REGION:-auto}
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
as_gatekeeper() { AWS_ACCESS_KEY_ID=$GATEKEEPER_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$GATEKEEPER_SECRET_ACCESS_KEY "$@"; }
admin() { deploy/fleet/api.sh default "$@"; }
gk() { # gk USER METHOD PATH [JSON]: the Gatekeeper's user API, body then status
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/gatekeeper/api$3"
}
chat() { # chat USER METHOD PATH [JSON]: the agent's API, body then status
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/chat/api$3"
}
body() { head -1 <<<"$1"; }
code() { tail -1 <<<"$1"; }
session() { api alice GET "/workspaces/team/sessions/$sid" | head -1; }
# run_code CODE: runs code in the session as alice, prints the result.
run_code() {
  local payload out
  payload=$(python3 -c 'import json, sys; print(json.dumps({"code": sys.argv[1]}))' "$1")
  out=$(api alice POST "/workspaces/team/sessions/$sid/runs" "$payload")
  [[ $(code "$out") == 200 ]] || fail "running code: $out"
  body "$out"
}
wait_for() { # wait_for SECONDS WHAT COMMAND...: until COMMAND succeeds
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out after ${SECONDS}s waiting for $what"
    sleep 2
  done
}
idle() { [[ $(session | json 'd["turn"]' 2>/dev/null) == None ]]; }
# say MESSAGE: sends a message as alice and waits for the agent to finish.
say() {
  local payload out
  payload=$(python3 -c 'import json, sys; print(json.dumps({"content": sys.argv[1]}))' "$1")
  out=$(chat alice POST "/workspaces/team/sessions/$sid/messages" "$payload")
  [[ $(code "$out") == 202 ]] || fail "sending '$1': $out"
  wait_for 300 "the agent to answer '$1'" idle
}
transcript() { session > "$results/agent-session.json"; }
runs=()
cleanup() {
  gk alice DELETE /connections/email >/dev/null 2>&1 || true
  admin DELETE /workspaces/team/docs/facts/launch.md >/dev/null 2>&1 || true
  [[ -n ${notes:-} ]] && api alice DELETE "/workspaces/team/cells/$notes" >/dev/null 2>&1 || true
}
trap cleanup EXIT

step "Log in, open a chat, grant it Hacker News, put a document in the workspace"
login alice "$ALICE_PASSWORD"
login bob "$BOB_PASSWORD"
out=$(chat alice POST /workspaces/team/sessions '{}')
[[ $(code "$out") == 201 ]] || fail "creating a session: $out"
sid=$(body "$out" | json 'd["id"]')
[[ $(body "$out" | json 'd["grants"]') == "['$MODEL']" ]] || fail "a new session should hold only $MODEL: $out"
# Bodies with commas are built outside $(...): bash 3.2 brace-expands them inside.
grants="{\"grants\":[\"$MODEL\",\"$WEB\"]}"
out=$(api alice PUT "/workspaces/team/sessions/$sid/grants" "$grants")
[[ $(code "$out") == 200 ]] || fail "granting $WEB: $out"
[[ $(api bob GET "/workspaces/team/sessions/$sid" | tail -1) == 404 ]] || fail "bob can see alice's session"
doc=$(mktemp)
printf -- '---\ndescription: The team'"'"'s launch code word\n---\n# Launch\n\nThe launch code word is %s.\n' "$CODEWORD" > "$doc"
[[ $(admin PUT /workspaces/team/docs/facts/launch.md "@$doc" | tail -1) == 200 ]] || fail "putting the document"
echo "session $sid holds $MODEL and $WEB; facts/launch.md is in the workspace"

step "A chat request results in code executed in an ephemeral cell and a result returned"
say "Use run_code to compute the 20th Fibonacci number (F(1) = F(2) = 1), and to fetch the title of the most popular Hacker News story about kubernetes from /search?query=kubernetes&tags=story&hitsPerPage=1. Tell me both."
transcript
python3 - "$results/agent-session.json" <<'PY' || fail "the chat did not run code and answer (see $results/agent-session.json)"
import json, sys
s = json.load(open(sys.argv[1]))
ms = s["messages"]
calls = [c for m in ms if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == "run_code"]
results = [m for m in ms if m["role"] == "tool" and m.get("run")]
ok = [m for m in results if json.loads(m["content"]).get("ok")]
web = [m for m in ok if "hn.algolia" in next(c["function"]["arguments"] for c in calls if c["id"] == m["tool_call_id"]) or "search" in next(c["function"]["arguments"] for c in calls if c["id"] == m["tool_call_id"])]
answer = ms[-1]
assert calls and ok, f"{len(calls)} run_code calls, {len(ok)} ran ok"
assert answer["role"] == "assistant" and "6765" in answer["content"].replace(",", ""), answer
assert web, "no run used the Hacker News grant"
print(f"{len(calls)} runs, e.g. {ok[0]['run']}; answer: {answer['content'][:200]!r}")
PY
while read -r r; do runs+=("$r"); done < <(python3 -c 'import json, sys; [print(m["run"]) for m in json.load(open(sys.argv[1]))["messages"] if m.get("run")]' "$results/agent-session.json")

step "Workspace documents are read on demand"
say "What is our team's launch code word? Check the workspace documents."
transcript
python3 - "$results/agent-session.json" "$CODEWORD" <<'PY' || fail "the agent did not read the document (see $results/agent-session.json)"
import json, sys
ms, word = json.load(open(sys.argv[1]))["messages"], sys.argv[2]
last_user = max(i for i, m in enumerate(ms) if m["role"] == "user")
turn = ms[last_user:]
reads = [c for m in turn if m["role"] == "assistant" for c in m.get("tool_calls", []) if c["function"]["name"] == "read_doc"]
assert reads and "facts/launch.md" in reads[0]["function"]["arguments"], turn
assert word in turn[-1]["content"], turn[-1]
print(f"read {reads[0]['function']['arguments']}; answer: {turn[-1]['content'][:120]!r}")
PY

step "The ephemeral cell has exactly the session's grants, never more"
r=$(run_code 'return Object.keys(grants).sort();')
runs+=("$(json 'd["id"]' <<<"$r")")
[[ $(json 'd["value"]' <<<"$r") == "['$MODEL', '$WEB']" ]] || fail "a run's grants: $r"
r=$(run_code 'return [grants["github:repo/ipedrazas/kodo:read"] === undefined, grants["'$SEND'"] === undefined];')
runs+=("$(json 'd["id"]' <<<"$r")")
[[ $(json 'd["value"]' <<<"$r") == "[True, True]" ]] || fail "a run has bindings the session does not hold: $r"
r=$(run_code 'const res = await grants["'$WEB'"].fetch("/search?query=kodo&hitsPerPage=1"); return res.status;')
web_run=$(json 'd["id"]' <<<"$r")
runs+=("$web_run")
[[ $(json 'd["value"]' <<<"$r") == 200 ]] || fail "a run could not use $WEB: $r"
echo "a run sees [$MODEL, $WEB] and nothing else; run $web_run read Hacker News"

step "A side-effecting call from agent code goes through the approval queue"
connection="{\"token\":\"$RESEND_API_KEY\",\"account\":\"$RESEND_FROM\"}"
out=$(gk alice PUT /connections/email "$connection")
[[ $(code "$out") == 200 ]] || fail "connecting email: $out"
grants="{\"grants\":[\"$MODEL\",\"$WEB\",\"$SEND\"]}"
out=$(api alice PUT "/workspaces/team/sessions/$sid/grants" "$grants")
[[ $(code "$out") == 200 ]] || fail "granting $SEND: $out"
say "Send an email to delivered@resend.dev with the subject 'kodo agent e2e $run' saying that the agent test ran."
transcript
approval=$(python3 - "$results/agent-session.json" <<'PY'
import json, sys
ms = json.load(open(sys.argv[1]))["messages"]
for m in ms:
    if m["role"] == "tool" and m.get("run"):
        for a in json.loads(m["content"]).get("approvals", []):
            if a["capability"] == "email:outbox:send":
                print(a["id"], m["run"])
PY
)
[[ -n $approval ]] || fail "the agent's code queued no email (see $results/agent-session.json)"
read -r approval send_run <<<"$(tail -1 <<<"$approval")"
runs+=("$send_run")
pending=$(gk alice GET "/approvals/$approval" | head -1)
PENDING=$pending python3 - "$send_run" "$sid" "$run" <<'PY' || fail "the approval is not the agent's pending email: $pending"
import json, os, sys
cell, session, run = sys.argv[1:]
a = json.loads(os.environ["PENDING"])["approval"]
fields = {f["name"]: f["value"] for f in a["summary"]["fields"]}
assert a["state"] == "pending" and a["capability"] == "email:outbox:send", a
assert a["cell"] == cell and a["blueprint"] == "agent" and a["version"] == session, a
assert run in fields["Subject"], fields
print(f"pending: {a['summary']['title']} to {fields['To']}, subject {fields['Subject']!r}, from run {cell}")
PY
out=$(gk alice POST "/approvals/$approval/reject" '{}')
[[ $(code "$out") == 200 ]] || fail "rejecting: $out"
# The run's cell is gone; the session follows the approval and says how it ended.
rejected() { session | python3 -c "import json, sys; ms = json.load(sys.stdin)['messages']; sys.exit(0 if any(m['role'] == 'event' and (m.get('approval') or {}).get('id') == '$approval' and m['approval']['state'] == 'rejected' for m in ms) else 1)"; }
wait_for 120 "the session to report the rejection" rejected
echo "rejected; the session reported it in the transcript"

step "The ephemeral cell and its state are gone after the run"
for r in "${runs[@]}"; do
  out=$(admin GET "/runs/$r")
  [[ $(head -1 <<<"$out") == '{"bound":false,"keys":0}' ]] || fail "run $r left something behind: $out"
  [[ $(status alice "https://$r.g.$DOMAIN/") == 404 ]] || fail "run $r is served"
done
echo "${#runs[@]} runs, nothing left of any, none served"

step "Runaway agent code is stopped by CPU and request limits without affecting other cells"
notes=$(api alice POST /workspaces/team/cells '{"blueprint":"notes"}' | head -1 | json 'd["id"]')
[[ $(status alice "https://$notes.g.$DOMAIN/api/notes") == 200 ]] || fail "the notes cell does not answer"
payload=$(python3 -c 'import json; print(json.dumps({"code": "while (true) {}"}))')
api alice POST "/workspaces/team/sessions/$sid/runs" "$payload" > "$results/agent-runaway.txt" &
runaway=$!
sleep 1
worst=0
for _ in 1 2 3; do
  t=$(c alice -o /dev/null -w '%{http_code} %{time_total}' "https://$notes.g.$DOMAIN/api/notes")
  [[ ${t% *} == 200 ]] || fail "the notes cell answered ${t% *} during the runaway run"
  worst=$(python3 -c "print(max($worst, ${t#* }))")
done
wait "$runaway"
r=$(cat "$results/agent-runaway.txt")
[[ $(code "$r") == 200 && $(body "$r" | json 'd["ok"]') == False && $(body "$r" | json 'd["error"]') == *CPU* ]] ||
  fail "the runaway run was not stopped by the CPU limit: $r"
runs+=("$(body "$r" | json 'd["id"]')")
python3 -c "import sys; sys.exit(0 if $worst < 1.5 else 1)" || fail "the notes cell took ${worst}s during the runaway run"
r=$(run_code 'const out = []; for (let i = 0; i < 25; i++) out.push((await grants["'$WEB'"].fetch("/search?query=kodo&hitsPerPage=1")).status); return out;')
python3 - "$r" <<'PY' || fail "the call limit did not hold: $r"
import json, sys
r = json.loads(sys.argv[1])
assert r["ok"] and r["value"] == [200] * 20 + [429] * 5 and r["calls"] == 20, r
PY
r=$(run_code 'const a = []; for (let i = 0; i < 768; i++) a.push(new Uint8Array(1 << 20).fill(7)); return a.length;')
[[ $(json 'd["ok"]' <<<"$r") == False && $(json 'd["error"]' <<<"$r") == *Uint8Array* ]] || fail "a run allocated memory outside the heap: $r"
[[ $(json 'd["value"]' <<<"$(run_code 'return "still serving";')") == "still serving" ]] || fail "runs stopped working"
echo "CPU limit stopped the runaway run; notes answered in at most ${worst}s meanwhile; calls stop at 20; no ArrayBuffers"

step "Chat history survives an agent service restart"
before=$(session | json 'len(d["messages"])')
"${GK[@]}" rollout restart deploy/kodo-agent >/dev/null
"${GK[@]}" rollout status deploy/kodo-agent --timeout=180s >/dev/null
[[ $(session | json 'len(d["messages"])') -ge $before ]] || fail "messages were lost in the restart"
say "Remind me: what was the 20th Fibonacci number you computed earlier?"
transcript
python3 - "$results/agent-session.json" <<'PY' || fail "the agent lost the conversation (see $results/agent-session.json)"
import json, sys
ms = json.load(open(sys.argv[1]))["messages"]
assert ms[-1]["role"] == "assistant" and "6765" in ms[-1]["content"].replace(",", ""), ms[-1]
print(f"after the restart: {ms[-1]['content'][:120]!r}")
PY
# A turn in progress when the agent restarts is ended and says so, rather
# than leaving the chat stuck.
payload=$(python3 -c 'import json, sys; print(json.dumps({"content": sys.argv[1]}))' "Use run_code three times, one after another, to compute 2**10, 3**10 and 5**10, then tell me the results.")
out=$(chat alice POST "/workspaces/team/sessions/$sid/messages" "$payload")
[[ $(code "$out") == 202 ]] || fail "sending: $out"
sleep 2
"${GK[@]}" rollout restart deploy/kodo-agent >/dev/null
"${GK[@]}" rollout status deploy/kodo-agent --timeout=180s >/dev/null
wait_for 60 "the interrupted turn to end" idle
echo "history kept ($before messages before the restart); a turn cut off by a restart ended: $(session | json 'd["messages"][-1]["content"][:100]')"

step "Usage and audit"
usage=$(api alice GET /workspaces/team/usage | head -1)
USAGE=$usage python3 - "$sid" <<'PY' || fail "the session's usage is missing: $usage"
import json, os, sys
u = json.loads(os.environ["USAGE"])
row = next(r for r in u["cells"] if r["id"] == sys.argv[1])
assert row["kind"] == "session" and row["blueprint"] == "agent", row
m = row["inference"]["agent"]
assert m["calls"] > 0 and m["total"] > 0, row
print(f"session {row['id']}: {row['requests']} turns and runs, {m['calls']} model calls, {m['total']} tokens")
PY
records=$(as_gatekeeper aws s3api list-objects-v2 --bucket "$GK_BUCKET" --prefix "audit/$day/" \
  --start-after "audit/$day/$started" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep json || true)
for r in $records; do as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$r" -; echo; done > "$results/agent-audit.jsonl"
python3 - "$results/agent-audit.jsonl" "$sid" "$web_run" "$approval" <<'PY' || fail "audit records incomplete"
import json, sys
path, session, web_run, approval = sys.argv[1:]
recs = [json.loads(l) for l in open(path) if l.strip()]
mine = [r for r in recs if r.get("blueprint") == "agent" and r.get("version") == session]
model = [r for r in mine if r.get("cell") == session and r.get("decision") == "metered"]
web = [r for r in mine if r.get("cell") == web_run and r.get("decision") == "allowed"]
sent = [r for r in mine if r.get("approval") == approval]
assert model and web and sent, (len(model), len(web), len(sent))
print(f"audit: {len(model)} model calls as the session, the run's Hacker News call, and the email: {sorted({r['decision'] for r in sent})}")
PY

step "PASS"
