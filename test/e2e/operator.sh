#!/usr/bin/env bash
# End-to-end test of the operator against a running cluster. Expects the CRDs
# installed and the operator running, and a Secret named "bucket" in $NS with
# AWS_ACCESS_KEY_ID and AWS_SECRET_ACCESS_KEY for the bucket below.
#
# Checks each Phase 4 acceptance criterion in turn:
#   1. a Fleet comes up serving, with the kernel deployed
#   2. Blueprint and Workspace resources reach the kernel's registries
#   3. the internal listener is closed to other pods
#   4. a kernel image change rolls out with no failed request
#   5. a celld image change stops every node first and loses no write
#   6. deleting the Fleet leaves the bucket's data, so a new Fleet has it
#
# Environment:
#   CONTEXT         kubectl context (required)
#   NS              namespace, created if missing (default kodo-e2e)
#   KERNEL_IMAGE    kernel image, and KERNEL_IMAGE_2 a different build of it
#   CELLD_IMAGE     celld image, and CELLD_IMAGE_2 another reference to a
#                   version that can share its data
#   BUCKET          bucket[/prefix]; BUCKET_ENDPOINT and BUCKET_REGION optional
#   RUNTIME_CLASS   optional, e.g. gvisor
set -euo pipefail
: "${CONTEXT:?}" "${KERNEL_IMAGE:?}" "${KERNEL_IMAGE_2:?}" "${BUCKET:?}"
NS=${NS:-kodo-e2e}
CELLD_IMAGE=${CELLD_IMAGE:-ghcr.io/denoland/celld:0.6.0}
CELLD_IMAGE_2=${CELLD_IMAGE_2:-ghcr.io/denoland/celld@sha256:e188a7f2bb0b8cec9fb04ee4c3d1ed7cca0ea0419519ae2a9ba36e5b6fe5161b}
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
results=${RESULTS:-$root/test/e2e/results}
mkdir -p "$results"
k=(kubectl --context "$CONTEXT" -n "$NS")

step() { printf '\n== %s\n' "$*"; }
fail() { echo "FAIL: $*" >&2; exit 1; }

fleet() { # fleet CELLD KERNEL
  cat <<YAML | "${k[@]}" apply -f -
apiVersion: kodo.dev/v1alpha1
kind: Fleet
metadata:
  name: kodo
spec:
  celld: $1
  kernel: $2
  replicas: 3
  ${RUNTIME_CLASS:+runtimeClassName: $RUNTIME_CLASS}
  bucket:
    name: $BUCKET
    ${BUCKET_ENDPOINT:+endpoint: $BUCKET_ENDPOINT}
    ${BUCKET_REGION:+region: $BUCKET_REGION}
    credentialsSecret: bucket
  resources:
    requests: {cpu: 100m, memory: 256Mi}
    limits: {memory: 1Gi}
YAML
}

wait_ready() {
  "${k[@]}" wait fleet/kodo --for=condition=Ready --timeout=600s >/dev/null ||
    { "${k[@]}" get fleet kodo -o yaml; "${k[@]}" get pods; fail "fleet not ready"; }
}

api() { # api METHOD PATH [JSON]
  local args=(-s -m 30 -X "$1" -H 'Host: api.kodo' -w '\n%{http_code}')
  [[ -n ${3:-} ]] && args+=(-H 'content-type: application/json' -d "$3")
  "${k[@]}" exec client -- curl "${args[@]}" "http://kodo/api$2"
}

cell_get() { "${k[@]}" exec client -- curl -s -m 30 -H "Host: $1.g.kodo" http://kodo/; }

start_writer() { # start_writer CELL LOG
  "${k[@]}" exec client -- rm -f "/tmp/stop-$1"
  "${k[@]}" exec client -- sh /tmp/writer.sh kodo "$1" > "$2" &
  writer_pid=$!
}

stop_writer() { # stop_writer CELL
  "${k[@]}" exec client -- touch "/tmp/stop-$1"
  wait "$writer_pid"
}

step "1. Fleet"
kubectl --context "$CONTEXT" create namespace "$NS" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f - >/dev/null
fleet "$CELLD_IMAGE" "$KERNEL_IMAGE"
wait_ready
"${k[@]}" get pod client >/dev/null 2>&1 ||
  "${k[@]}" run client --image=curlimages/curl:8.16.0 --restart=Never --command -- sleep 604800 >/dev/null
"${k[@]}" wait --for=condition=Ready pod/client --timeout=120s >/dev/null
"${k[@]}" cp "$here/writer.sh" client:/tmp/writer.sh
until api GET /version | head -1 | grep -q build; do sleep 3; done
echo "kernel: $(api GET /version | head -1)"

step "2. Blueprint and Workspace resources"
"${k[@]}" create configmap gadgets --from-file=fixture.js="$root/kernel/test/gadgets/fixture.js" \
  --dry-run=client -o yaml | "${k[@]}" apply -f - >/dev/null
cat <<YAML | "${k[@]}" apply -f - >/dev/null
apiVersion: kodo.dev/v1alpha1
kind: Blueprint
metadata:
  name: fixture-1
spec:
  fleet: kodo
  blueprint: fixture
  version: "1"
  source: {name: gadgets, key: fixture.js}
---
apiVersion: kodo.dev/v1alpha1
kind: Workspace
metadata:
  name: e2e
spec:
  fleet: kodo
  quota: 7
YAML
"${k[@]}" wait blueprint/fixture-1 --for=condition=Published --timeout=120s >/dev/null
"${k[@]}" wait workspace/e2e --for=condition=Synced --timeout=120s >/dev/null
api GET /blueprints/fixture | head -1 | grep -q '"version":"1"' || fail "blueprint not in the catalog"
api GET /workspaces/e2e | head -1 | grep -q '"quota":7' || fail "workspace quota not applied"
cell=$(api POST /workspaces/e2e/cells '{"blueprint":"fixture"}' | head -1 | sed -E 's/.*"id":"([a-z0-9]+)".*/\1/')
[[ $(cell_get "$cell") == *'"n":1'* ]] || fail "cell $cell did not serve"
echo "cell $cell serves the fixture gadget"

step "3. Internal listener"
# The same node's public port answers, so the name resolves and the pod is
# reachable; its internal port must then be blocked. Network plugins either
# drop (curl exit 28, timeout) or reject (exit 7, refused) such connections.
public=$("${k[@]}" exec client -- curl -s -m 5 -o /dev/null -w '%{http_code}' "http://kodo-0.kodo-peers:8080/.well-known/celld/health")
[[ $public == 200 ]] || fail "node kodo-0 public port answered $public"
code=0
"${k[@]}" exec client -- curl -s -m 5 -o /dev/null "http://kodo-0.kodo-peers:8081/state" || code=$?
[[ $code == 7 || $code == 28 ]] || fail "internal listener check: curl exit $code, want 7 or 28"
echo "internal port closed to other pods (curl exit $code); public port open"

step "4. Kernel rollout under load"
start_writer "$cell" "$results/kernel-rollout.log"
sleep 3
"${k[@]}" patch fleet kodo --type=merge -p "{\"spec\":{\"kernel\":\"$KERNEL_IMAGE_2\"}}" >/dev/null
until [[ $("${k[@]}" get fleet kodo -o jsonpath='{.status.kernel}') == "$KERNEL_IMAGE_2" ]]; do sleep 2; done
before=$(api GET /version | head -1)
for _ in $(seq 1 30); do # nodes adopt within one 30 s pointer poll
  [[ $(api GET /version | head -1) != "$before" ]] && break
  sleep 2
done
sleep 5
stop_writer "$cell"
echo "kernel now: $(api GET /version | head -1)"
python3 "$root/spike/celld/scripts/check.py" "$results/kernel-rollout.log"
grep -q -v ' 200 ' "$results/kernel-rollout.log" && fail "requests failed during the kernel rollout"
echo "no failed requests"

step "5. celld image change"
start_writer "$cell" "$results/celld-upgrade.log"
sleep 3
"${k[@]}" patch fleet kodo --type=merge -p "{\"spec\":{\"celld\":\"$CELLD_IMAGE_2\"}}" >/dev/null
"${k[@]}" wait fleet/kodo --for=condition=Upgrading --timeout=60s >/dev/null
until [[ $("${k[@]}" get statefulset kodo -o jsonpath='{.spec.replicas}') == 0 ]]; do sleep 1; done
echo "scaled to zero on the old image"
wait_ready
[[ $("${k[@]}" get fleet kodo -o jsonpath='{.status.celld}') == "$CELLD_IMAGE_2" ]] || fail "status does not show the new image"
sleep 5
stop_writer "$cell"
python3 "$root/spike/celld/scripts/check.py" "$results/celld-upgrade.log"

step "6. Delete and recreate the Fleet"
last=$(cell_get "$cell" | sed -E 's/.*"n":([0-9]+).*/\1/')
"${k[@]}" delete fleet kodo --wait=true >/dev/null
"${k[@]}" wait pod -l kodo.dev/fleet=kodo --for=delete --timeout=180s >/dev/null 2>&1 || true
fleet "$CELLD_IMAGE_2" "$KERNEL_IMAGE_2"
wait_ready
until api GET /version | head -1 | grep -q build; do sleep 3; done
now=$(cell_get "$cell" | sed -E 's/.*"n":([0-9]+).*/\1/')
[[ $now -eq $((last + 1)) ]] || fail "cell count went from $last to $now after recreating the Fleet"
echo "cell kept its state: $last -> $now"

printf '\nPASS\n'
