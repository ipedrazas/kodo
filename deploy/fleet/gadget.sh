#!/usr/bin/env bash
# Publishes gadget bundles and binds cells to them by hand, until Phase 3
# adds an API for it.
# usage: gadget.sh k3s|kind put FILE          prints the bundle digest
#        gadget.sh k3s|kind bind CELL DIGEST
set -euo pipefail
here=$(cd "$(dirname "$0")" && pwd)
target=$1 action=$2
case "$action" in
  put)
    digest=$(shasum -a 256 "$3" | cut -d' ' -f1)
    "$here/with-bucket.sh" "$target" celld r2 put bundles "sha256/$digest.js" \
      --path "$3" --content-type text/javascript >/dev/null 2>&1
    echo "$digest"
    ;;
  bind)
    manifest=$(mktemp)
    trap 'rm -f "$manifest"' EXIT
    printf '{"bundle":"%s"}' "$4" > "$manifest"
    "$here/with-bucket.sh" "$target" celld r2 put cells "$3.json" \
      --path "$manifest" --content-type application/json >/dev/null 2>&1
    ;;
  *)
    echo "unknown action $action: use put or bind" >&2
    exit 2
    ;;
esac
