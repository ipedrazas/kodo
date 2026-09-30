#!/usr/bin/env bash
# Runs operator.sh on a kind cluster: builds two kernel images and loads them
# into kind, runs SeaweedFS as the bucket, installs the CRDs and runs the
# operator from source for the duration. Needs Docker, kind and Go.
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
export CONTEXT=kind-${KIND_CLUSTER:-kodo} NS=kodo-e2e
k=(kubectl --context "$CONTEXT" -n "$NS")

for build in e2e-1 e2e-2; do
  docker build -q -f images/kernel/Dockerfile --build-arg "KERNEL_BUILD=$build" -t "kodo-kernel:$build" .
done
kind get clusters | grep -qx "${KIND_CLUSTER:-kodo}" || kind create cluster --name "${KIND_CLUSTER:-kodo}"
kind load docker-image --name "${KIND_CLUSTER:-kodo}" kodo-kernel:e2e-1 kodo-kernel:e2e-2

kubectl --context "$CONTEXT" create namespace "$NS" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
"${k[@]}" apply -f deploy/fleet/kind/seaweedfs.yaml
"${k[@]}" rollout status deploy/seaweedfs --timeout=180s
"${k[@]}" run mkbucket --rm -i --restart=Never --image=curlimages/curl:8.16.0 --command -- \
  curl -s -o /dev/null -w '%{http_code}\n' -X PUT --aws-sigv4 aws:amz:us-east-1:s3 --user devkey:devsecret \
  http://seaweedfs:8333/kodo-e2e
"${k[@]}" create secret generic bucket --from-literal=AWS_ACCESS_KEY_ID=devkey \
  --from-literal=AWS_SECRET_ACCESS_KEY=devsecret --dry-run=client -o yaml | "${k[@]}" apply -f -

kubectl --context "$CONTEXT" apply -k config/crd
mkdir -p "${RESULTS:-test/e2e/results}"
go build -o /tmp/kodo-operator ./cmd/operator
# The operator follows its kubeconfig's current context, so give it one that
# can only reach the kind cluster.
kubeconfig=$(mktemp)
kubectl config view --minify --flatten --context "$CONTEXT" > "$kubeconfig"
/tmp/kodo-operator --kubeconfig "$kubeconfig" --metrics-bind-address 0 \
  --health-probe-bind-address :18081 > "${RESULTS:-test/e2e/results}/operator.log" 2>&1 &
operator=$!
trap 'kill $operator' EXIT

KERNEL_IMAGE=kodo-kernel:e2e-1 KERNEL_IMAGE_2=kodo-kernel:e2e-2 \
  BUCKET=kodo-e2e BUCKET_ENDPOINT=http://seaweedfs:8333 BUCKET_REGION=us-east-1 \
  test/e2e/operator.sh
