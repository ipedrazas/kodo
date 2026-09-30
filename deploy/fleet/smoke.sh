#!/usr/bin/env bash
# Checks a deployed fleet end to end through the kernel API: publishes the
# sample notes gadget, creates a cell from it, and fails unless the cell
# stores a note and returns it.
# usage: smoke.sh CONTEXT
set -euo pipefail
context=$1
here=$(cd "$(dirname "$0")" && pwd)
root=$(cd "$here/../.." && pwd)
api() { "$here/api.sh" "$context" "$@"; }
k=(kubectl --context "$context" -n kodo)

# A new deployment reaches every node within one pointer poll (30 s).
for _ in $(seq 1 20); do
  out=$(api PUT /workspaces/smoke '{"quota":1000}') && [[ $(tail -1 <<< "$out") == 200 ]] && break
  sleep 3
done
digest=$(api POST /bundles "@$root/kernel/examples/notes.js" | head -1 | sed -E 's/.*"digest":"([0-9a-f]+)".*/\1/')
version="smoke-$(date +%s)"
api PUT "/blueprints/notes/$version" "{\"bundle\":\"$digest\"}" >/dev/null
cell=$(api POST /workspaces/smoke/cells "{\"blueprint\":\"notes\",\"version\":\"$version\"}" |
  head -1 | sed -E 's/.*"id":"([a-z0-9]+)".*/\1/')
echo "cell $cell runs notes $version ($digest)"

"${k[@]}" exec client -- curl -sS -m 30 -X POST -H "Host: $cell.g.kodo" --data-binary 'smoke test' http://celld/ >/dev/null
notes=$("${k[@]}" exec client -- curl -sS -m 30 -H "Host: $cell.g.kodo" http://celld/)
echo "notes: $notes"
[[ $notes == '["smoke test"]' ]]

"${k[@]}" exec client -- curl -sS -m 30 -X POST -H "Host: $cell.g.kodo" 'http://celld/remind?in=1000' >/dev/null
for _ in $(seq 1 20); do
  status=$("${k[@]}" exec client -- curl -sS -m 30 -H "Host: $cell.g.kodo" http://celld/status)
  [[ $status == *'"reminders":1'* ]] && break
  sleep 1
done
echo "status: $status"
[[ $status == *'"reminders":1'* ]]
