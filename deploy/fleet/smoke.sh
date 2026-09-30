#!/usr/bin/env bash
# Checks a deployed fleet end to end: uploads the kernel's fixture gadget,
# binds a cell to it, and requests the cell through the fleet Service from a
# pod in the namespace. Fails unless the cell answers and keeps its count.
# usage: smoke.sh k3s|kind CONTEXT
set -euo pipefail
target=$1 context=$2
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
k=(kubectl --context "$context" -n kodo)

digest=$("$here/gadget.sh" "$target" put "$root/kernel/test/gadgets/fixture.js")
cell="smoke-$(date +%s)"
"$here/gadget.sh" "$target" bind "$cell" "$digest"

"${k[@]}" get pod client >/dev/null 2>&1 ||
  "${k[@]}" run client --image=curlimages/curl:8.16.0 --restart=Never --command -- sleep 604800
"${k[@]}" wait --for=condition=Ready pod/client --timeout=120s >/dev/null

get() { "${k[@]}" exec client -- curl -s -m 30 -H "Host: $cell.g.test" http://celld/; }
# A new deployment reaches every node within one pointer poll (30 s).
for _ in $(seq 1 20); do
  first=$(get) && [[ $first == *'"n":1'* ]] && break
  sleep 3
done
second=$(get)
echo "first: $first"
echo "second: $second"
[[ $first == *'"n":1'* && $second == *'"n":2'* ]]
