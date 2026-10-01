#!/usr/bin/env bash
# End-to-end test of the approval queue on the k3s cluster, through the real
# gateway, fleet, Gatekeeper (two replicas), OpenBao, Tigris and Resend.
# Checks each Phase 8 acceptance criterion. Expects `task k3s:up` to have
# run, with the Gatekeeper, and:
#   .auth.env        the test users' passwords
#   .buckets.env     the Gatekeeper's bucket key, to read the audit log
#   RESEND_API_KEY   a Resend API key (sending access is enough); it is stored
#                    for alice only for the run, then disconnected
#   RESEND_FROM      the From address, on a domain verified in Resend
#   MAIL_TO          where the approved email goes (default delivered@resend.dev,
#                    Resend's test address that accepts and drops mail)
# The kill test points the Gatekeeper at a tarpit for a minute and restores
# it; the Gatekeeper restarts twice.
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
MAIL_TO=${MAIL_TO:-delivered@resend.dev}
SEND=email:outbox:send
GK_BUCKET=${GATEKEEPER_BUCKET:-kodo-dev-gatekeeper}
SCRATCH=kodo-approvals-e2e
GK=(kubectl -n kodo-system)
run=$(date -u +%Y%m%dT%H%M%S)
started=$run
day=$(date -u +%Y/%m/%d)
export AWS_REGION=${AWS_REGION:-auto}
json() { python3 -c "import json, sys; d = json.load(sys.stdin); print($1)"; }
as_gatekeeper() { AWS_ACCESS_KEY_ID=$GATEKEEPER_ACCESS_KEY_ID AWS_SECRET_ACCESS_KEY=$GATEKEEPER_SECRET_ACCESS_KEY "$@"; }
gk() { # gk USER METHOD PATH [JSON]: the Gatekeeper's user API, body then status
  local args=(-X "$2" -H "Origin: $APP" -w '\n%{http_code}')
  [[ -n ${4:-} ]] && args+=(-H 'content-type: application/json' -d "$4")
  c "$1" "${args[@]}" "$APP/gatekeeper/api$3"
}
# While the Gatekeeper restarts the gateway answers 503 without JSON; then
# this prints nothing and the caller's wait tries again.
approval() { gk alice GET "/approvals/$1" | head -1 | json "d['approval']$2" 2>/dev/null; }
outbox() { c alice "$(cell)/api/outbox/$1" | json "$2"; }
cell() { echo "https://$mailer.g.$DOMAIN"; }
draft() { # draft SUBJECT: send a draft from the mailer, print the approval id
  local out
  out=$(c alice -X POST -H "Origin: $(cell)" -H 'content-type: application/json' -w '\n%{http_code}' \
    -d "{\"to\":[\"$MAIL_TO\"],\"subject\":\"$1\",\"text\":\"Sent by the kodo approvals e2e test, run $run.\"}" \
    "$(cell)/api/outbox")
  [[ $(tail -1 <<<"$out") == 202 ]] || fail "drafting '$1': $out"
  head -1 <<<"$out" | json 'd["id"]'
}
wait_for() { # wait_for SECONDS WHAT COMMAND...: until COMMAND succeeds
  local deadline=$((SECONDS + $1)) what=$2
  shift 2
  until "$@"; do
    ((SECONDS < deadline)) || fail "timed out after ${SECONDS}s waiting for $what"
    sleep 2
  done
}
restore() {
  "${GK[@]}" set env deploy/kodo-gatekeeper RESEND_API_URL- >/dev/null 2>&1 || true
}
cleanup() {
  restore
  [[ -n ${mailer:-} ]] && api alice DELETE "/workspaces/team/cells/$mailer" >/dev/null 2>&1 || true
  gk alice DELETE /connections/email >/dev/null 2>&1 || true
  kubectl delete namespace "$SCRATCH" --wait=false >/dev/null 2>&1 || true
}
trap cleanup EXIT
# A previous run's namespace may still be going away.
kubectl delete namespace "$SCRATCH" --ignore-not-found --wait=true --timeout=180s >/dev/null

step "Log in, connect email, publish the mailer"
login alice "$ALICE_PASSWORD"
out=$(gk alice PUT /connections/email "{\"token\":\"$RESEND_API_KEY\",\"account\":\"$RESEND_FROM\"}")
[[ $(tail -1 <<<"$out") == 200 ]] || fail "connecting email: $out"
echo "alice connected email as $(head -1 <<<"$out" | json 'd["account"]')"
kubectl -n kodo apply -k examples/mailer >/dev/null
cat <<YAML | kubectl apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata: {name: team, namespace: kodo}
spec: {fleet: kodo, quota: 100}
YAML
kubectl -n kodo wait blueprint/mailer-1.0.0 --for=condition=Published --timeout=120s >/dev/null
kubectl -n kodo wait workspace/team --for=condition=Synced --timeout=120s >/dev/null
mailer=$(api alice POST /workspaces/team/cells '{"blueprint":"mailer"}' | head -1 | json 'd["id"]')
res=$(api alice PUT "/workspaces/team/cells/$mailer/grants" "{\"grants\":[\"$SEND\"]}")
[[ $(tail -1 <<<"$res") == 200 ]] || fail "granting $SEND: $res"
echo "mailer cell $mailer, granted $SEND"

step "A gadget drafts an email and the send waits in the queue"
first=$(draft "kodo e2e $run: approve")
[[ $(outbox "$first" 'd["state"]') == pending ]] || fail "the gadget does not see $first pending"
pending=$(gk alice GET '/approvals?state=pending' | head -1)
PENDING=$pending python3 - "$first" "$MAIL_TO" "$run" <<'PY' || fail "the approval is not listed as pending: $pending"
import json, os, sys
first, to, run = sys.argv[1:]
a = next(a for a in json.loads(os.environ["PENDING"])["approvals"] if a["id"] == first)
fields = {f["name"]: f["value"] for f in a["summary"]["fields"]}
assert a["state"] == "pending" and a["capability"] == "email:outbox:send", a
assert to in fields["To"] and run in fields["Subject"] and run in a["summary"]["body"], fields
print(f"pending: {a['summary']['title']} to {fields['To']} from {fields['From']}, subject {fields['Subject']!r}")
PY
sleep 5
[[ $(approval "$first" '["state"]') == pending ]] || fail "$first left pending on its own"
echo "still pending 5 s later; the gadget sees it as pending"

step "Two Gatekeeper replicas race to approve it; the email is sent once"
ips=$("${GK[@]}" get pods -l app.kubernetes.io/name=kodo-gatekeeper --field-selector=status.phase=Running \
  -o jsonpath='{range .items[*]}{.status.podIP}{" "}{end}')
(($(wc -w <<<"$ips") >= 2)) || fail "need two Gatekeeper replicas, found: $ips"
# Twelve approves at once through the gateway, which spreads them over the
# replicas; its access log says which replica answered each. The session
# cookie is encrypted by the gateway, so the ID token cannot go to the pods
# directly. The cookie jar is only read, by all of them.
raced=$(date -u +%Y-%m-%dT%H:%M:%S)
statuses=$(for _ in $(seq 12); do
  curl -sS -m 30 --connect-to "::$GATEWAY:" -b "$(jar alice)" -X POST -H "Origin: $APP" -o /dev/null \
    -w '%{http_code}\n' "$APP/gatekeeper/api/approvals/$first/approve" &
done; wait)
ok=$(grep -c '^200$' <<<"$statuses" || true)
conflict=$(grep -c '^409$' <<<"$statuses" || true)
[[ $ok == 1 && $conflict == 11 ]] || fail "racing approves answered: $(sort <<<"$statuses" | uniq -c | xargs)"
# The gateway's access log arrives with a lag; read it until all twelve are in.
answers() {
  kubectl -n envoy-gateway-system logs -l gateway.envoyproxy.io/owning-gateway-name=kodo -c envoy --tail=-1 \
    --since-time="${raced}Z" | python3 -c '
import json, sys, collections
first = sys.argv[1]
by = collections.Counter()
for line in sys.stdin:
    try: r = json.loads(line)
    except ValueError: continue
    if r.get("x-envoy-origin-path") == f"/gatekeeper/api/approvals/{first}/approve":
        by[(r["upstream_host"].split(":")[0], r["response_code"])] += 1
print(" ".join(f"{h}:{c}x{n}" for (h, c), n in sorted(by.items())))' "$first"
}
logged() {
  answered=$(answers)
  [[ $(tr ' ' '\n' <<<"$answered" | grep -o 'x[0-9]*$' | tr -d x | paste -sd+ - | bc) == 12 ]] 2>/dev/null
}
wait_for 60 "the gateway to log the twelve approves" logged
replicas=$(tr ' ' '\n' <<<"$answered" | cut -d: -f1 | sort -u | grep -c . || true)
((replicas >= 2)) || fail "the approves did not reach two replicas: $answered"
echo "12 approves through the gateway, answered by $replicas replicas ($answered): 1 ran the call, 11 got 409"
state=$(approval "$first" '["state"]')
status=$(approval "$first" '["result"]["status"]')
[[ $state == "done" && $status == 200 ]] || fail "after approval: $state $status"
email_id=$(gk alice GET "/approvals/$first" | head -1 |
  python3 -c 'import base64, json, sys; print(json.loads(base64.b64decode(json.load(sys.stdin)["approval"]["result"]["body"]))["id"])')
echo "Resend accepted it as $email_id"
check=$(curl -s -m 15 -o /dev/null -w '%{http_code}' -H "Authorization: Bearer $RESEND_API_KEY" "https://api.resend.com/emails/$email_id")
case $check in
  200) echo "Resend has email $email_id" ;;
  401) echo "(a sending-only key cannot look the email up at Resend)" ;;
  *) fail "Resend does not know $email_id: $check" ;;
esac
sent=0
for p in $("${GK[@]}" get pods -l app.kubernetes.io/name=kodo-gatekeeper -o name); do
  n=$("${GK[@]}" logs "$p" | grep -c "\"approval\":\"$first\",\"status\":200" || true)
  sent=$((sent + n))
done
[[ $sent == 1 ]] || fail "the Gatekeepers logged $sent sends of $first"
echo "across both replicas, one send of $first"

step "The gadget observes the approval"
seen() { [[ $(outbox "$1" "d['state'] + ' ' + str(d['notified'])") == "$2 True" ]]; }
wait_for 120 "the mailer to hear $first was sent" seen "$first" "done"
outbox "$first" '"%s, provider answered %s: %s" % (d["state"], d["status"], d["response"])'

step "Rejecting never runs the call, and the gadget observes it"
second=$(draft "kodo e2e $run: reject")
[[ $(gk alice POST "/approvals/$second/reject" | tail -1) == 200 ]] || fail "rejecting $second"
[[ $(gk alice POST "/approvals/$second/approve" | tail -1) == 409 ]] || fail "approving a rejected call"
[[ $(approval "$second" '["state"]') == rejected ]] || fail "$second is not rejected"
wait_for 120 "the mailer to hear $second was rejected" seen "$second" rejected
echo "rejected; approve afterwards is refused; the mailer shows it rejected"

step "A pending approval survives a Gatekeeper restart and the cell's hibernation"
third=$(draft "kodo e2e $run: killed mid-send")
# A tarpit that accepts the send and never answers, in place of Resend.
kubectl create namespace "$SCRATCH" --dry-run=client -o yaml | kubectl apply -f - >/dev/null
cat <<'YAML' | kubectl -n "$SCRATCH" apply -f - >/dev/null
apiVersion: v1
kind: Pod
metadata: {name: tarpit, labels: {app: tarpit}}
spec:
  containers:
    - name: tarpit
      image: python:3.13-alpine
      command: [python, -u, -c]
      args:
        - |
          import http.server, time
          class H(http.server.BaseHTTPRequestHandler):
              def do_POST(self):
                  print("send", self.path, self.headers.get("Idempotency-Key"), flush=True)
                  time.sleep(600)
          http.server.ThreadingHTTPServer(("", 8080), H).serve_forever()
---
apiVersion: v1
kind: Service
metadata: {name: tarpit}
spec: {selector: {app: tarpit}, ports: [{port: 8080}]}
YAML
kubectl -n "$SCRATCH" wait --for=condition=Ready pod/tarpit --timeout=120s >/dev/null
"${GK[@]}" set env deploy/kodo-gatekeeper "RESEND_API_URL=http://tarpit.$SCRATCH.svc:8080" >/dev/null
"${GK[@]}" rollout status deploy/kodo-gatekeeper --timeout=180s >/dev/null
echo "every Gatekeeper replica restarted"
# The fleet hibernates a cell after 30 s without work; the cell's polls are
# 2, 4, 8, 16, 32 and then 60 s apart.
sleep 75
[[ $(approval "$third" '["state"]') == pending ]] || fail "$third did not survive the restart"
[[ $(c alice "$(cell)/api/outbox" | json "[m['state'] for m in d['outbox'] if m['id'] == '$third'][0]") == pending ]] ||
  fail "the mailer lost $third"
echo "75 s later, after the restart and with the cell idle past its eviction: still pending in the Gatekeeper and the mailer"

step "A Gatekeeper killed mid-execution leaves the approval failed, not retried"
# Read-only on the cookie jar, which the foreground requests keep writing.
curl -sS -m 60 --connect-to "::$GATEWAY:" -b "$(jar alice)" -X POST -H "Origin: $APP" -o /dev/null \
  "$APP/gatekeeper/api/approvals/$third/approve" 2>/dev/null &
executing() { [[ $(approval "$third" '["state"]') == executing ]]; }
wait_for 20 "the approval to start executing" executing
wait_for 20 "the send to reach the tarpit" bash -c "kubectl -n $SCRATCH logs tarpit | grep -q $third"
"${GK[@]}" delete pod -l app.kubernetes.io/name=kodo-gatekeeper --grace-period=0 --force >/dev/null 2>&1
echo "killed every Gatekeeper replica while it was sending $third"
wait || true
restore
"${GK[@]}" rollout status deploy/kodo-gatekeeper --timeout=180s >/dev/null
failed() { [[ $(approval "$third" '["state"]') == failed ]]; }
wait_for 180 "the approval to be reported failed" failed
reason=$(approval "$third" '["reason"]')
[[ $reason == *"stopped while making the call"*"will not be retried"* ]] || fail "reason: $reason"
echo "reported failed: $reason"
[[ $(gk alice POST "/approvals/$third/approve" | tail -1) == 409 ]] || fail "a failed approval could be approved again"
wait_for 120 "the mailer to hear $third failed" seen "$third" failed
sleep 10
attempts=$(kubectl -n "$SCRATCH" logs tarpit | grep -c "$third" || true)
[[ $attempts == 1 ]] || fail "the send of $third was attempted $attempts times"
echo "one attempt, at the tarpit; not retried after the Gatekeeper came back; the mailer shows it failed"

step "Audit records who approved what, and when"
records=$(as_gatekeeper aws s3api list-objects-v2 --bucket "$GK_BUCKET" --prefix "audit/$day/" \
  --start-after "audit/$day/$started" --query 'Contents[].Key' --output text | tr '\t' '\n' | grep json || true)
[[ -n $records ]] || fail "no audit records since $started"
for r in $records; do as_gatekeeper aws s3 cp "s3://$GK_BUCKET/$r" -; echo; done > "$results/approvals-audit.jsonl"
python3 - "$first" "$second" "$third" "$mailer" "$results/approvals-audit.jsonl" <<'PY' || fail "audit records incomplete"
import json, sys
first, second, third, cell, path = sys.argv[1:]
records = [json.loads(l) for l in open(path) if l.strip()]
def trail(id):
    return [r["decision"] for r in sorted((r for r in records if r.get("approval") == id), key=lambda r: r["time"])]
assert trail(first) == ["queued", "approved", "executed"], trail(first)
assert trail(second) == ["queued", "rejected"], trail(second)
assert trail(third) == ["queued", "approved", "failed"], trail(third)
for r in records:
    if r.get("approval") in (first, second, third):
        assert r["cell"] == cell and r["grant"] == "email:outbox:send" and r["email"].startswith("alice@"), r
        assert r["user"] and r["time"], r
approved = next(r for r in records if r.get("approval") == first and r["decision"] == "approved")
executed = next(r for r in records if r.get("approval") == first and r["decision"] == "executed")
assert executed["status"] == 200, executed
print("approve:", " -> ".join(trail(first)), "| reject:", " -> ".join(trail(second)), "| killed:", " -> ".join(trail(third)))
print("e.g.", json.dumps(approved))
PY

step "Clean up"
[[ $(api alice DELETE "/workspaces/team/cells/$mailer" | tail -1) == 204 ]] || fail "deleting $mailer"
mailer=
[[ $(gk alice DELETE /connections/email | tail -1) == 204 ]] || fail "disconnecting email"
echo "cell deleted, email disconnected"

printf '\nPASS\n'
