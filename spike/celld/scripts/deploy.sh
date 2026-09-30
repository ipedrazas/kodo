#!/usr/bin/env bash
# Deploys the spike app and uploads every gadget in gadgets/ by SHA-256
# digest. Extra arguments select the bucket, e.g. --bucket s3://NAME
# --endpoint URL. Needs celld and esbuild on PATH.
set -euo pipefail
cd "$(dirname "$0")/.."
celld deploy app "$@"
for gadget in gadgets/*.js; do
  digest=$(shasum -a 256 "$gadget" | cut -d' ' -f1)
  celld r2 put bundles "sha256/$digest.js" --path "$gadget" --content-type text/javascript "$@" >/dev/null
  echo "$(basename "$gadget" .js) $digest"
done
