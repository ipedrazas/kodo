#!/usr/bin/env bash
# Runs a celld command against the fleet bucket of TARGET, appending the
# bucket flags. For kind it port-forwards to SeaweedFS for the duration.
# usage: with-bucket.sh k3s|kind COMMAND...
#   e.g. with-bucket.sh kind kernel/scripts/deploy.sh
set -euo pipefail
target=$1
shift
case "$target" in
  k3s)
    : "${AWS_ENDPOINT_URL_S3:?load .env first (the Taskfile does)}"
    exec "$@" --bucket s3://kodo-dev --endpoint "$AWS_ENDPOINT_URL_S3" --region auto
    ;;
  kind)
    kubectl --context "kind-${KIND_CLUSTER:-kodo}" -n kodo port-forward svc/seaweedfs 18333:8333 >/dev/null &
    forward=$!
    trap 'kill $forward' EXIT
    until curl -s -o /dev/null http://127.0.0.1:18333; do sleep 1; done
    AWS_ACCESS_KEY_ID=devkey AWS_SECRET_ACCESS_KEY=devsecret AWS_REGION=us-east-1 \
      "$@" --bucket s3://kodo-ci --endpoint http://127.0.0.1:18333
    ;;
  *)
    echo "unknown target $target: use k3s or kind" >&2
    exit 2
    ;;
esac
