#!/usr/bin/env bash
# Deploys the spike app and sample gadgets to the SeaweedFS bucket inside the
# kind cluster, through a port-forward. Needs celld and esbuild on PATH.
set -euo pipefail
NS=${NS:-kodo-spike}
cd "$(dirname "$0")/.."

kubectl -n "$NS" port-forward svc/seaweedfs 18333:8333 >/dev/null &
forward=$!
trap 'kill $forward' EXIT
until curl -s -o /dev/null http://127.0.0.1:18333; do sleep 1; done

export AWS_ACCESS_KEY_ID=devkey AWS_SECRET_ACCESS_KEY=devsecret AWS_REGION=us-east-1
scripts/deploy.sh --bucket s3://kodo-ci --endpoint http://127.0.0.1:18333
