#!/usr/bin/env bash
# Runs operator.sh on an existing cluster with published images, using the
# Tigris bucket in .env: creates the bucket Secret, and either installs the
# operator in the cluster from OPERATOR_IMAGE or runs it from source for the
# duration. Each run uses a fresh prefix in the bucket.
# usage: CONTEXT=default KERNEL_IMAGE=... KERNEL_IMAGE_2=... [OPERATOR_IMAGE=...] cluster.sh
set -euo pipefail
root=$(cd "$(dirname "$0")/../.." && pwd)
cd "$root"
: "${CONTEXT:?}" "${KERNEL_IMAGE:?}" "${KERNEL_IMAGE_2:?}"
export NS=${NS:-kodo-e2e}
set -a
# shellcheck disable=SC1091
. ./.env
set +a
k=(kubectl --context "$CONTEXT" -n "$NS")

kubectl --context "$CONTEXT" create namespace "$NS" --dry-run=client -o yaml | kubectl --context "$CONTEXT" apply -f -
"${k[@]}" create secret generic bucket --from-literal=AWS_ACCESS_KEY_ID="$AWS_ACCESS_KEY_ID" \
  --from-literal=AWS_SECRET_ACCESS_KEY="$AWS_SECRET_ACCESS_KEY" --dry-run=client -o yaml | "${k[@]}" apply -f -
mkdir -p "${RESULTS:-test/e2e/results}"
if [[ -n ${OPERATOR_IMAGE:-} ]]; then
  # Install the operator in the cluster, as config/ does, with this image.
  kubectl --context "$CONTEXT" apply -k config
  kubectl --context "$CONTEXT" -n kodo-system set image deploy/kodo-operator operator="$OPERATOR_IMAGE"
  kubectl --context "$CONTEXT" -n kodo-system rollout status deploy/kodo-operator --timeout=180s
else
  kubectl --context "$CONTEXT" apply -k config/crd
  go build -o /tmp/kodo-operator ./cmd/operator
  kubeconfig=$(mktemp)
  kubectl config view --minify --flatten --context "$CONTEXT" > "$kubeconfig"
  /tmp/kodo-operator --kubeconfig "$kubeconfig" --metrics-bind-address 0 \
    --health-probe-bind-address :18081 > "${RESULTS:-test/e2e/results}/operator.log" 2>&1 &
  operator=$!
  trap 'kill $operator' EXIT
fi

BUCKET=${BUCKET:-kodo-dev/e2e-$(date +%s)} BUCKET_ENDPOINT=$AWS_ENDPOINT_URL_S3 BUCKET_REGION=${AWS_REGION:-auto} \
  test/e2e/operator.sh
