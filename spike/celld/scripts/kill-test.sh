#!/usr/bin/env bash
# Run from a workstation or CI. Writes to counters for SECONDS seconds,
# force-kills one celld pod part-way through, and fails if any acknowledged
# write was lost. Needs the client pod (see client-up in the Taskfile).
# usage: kill-test.sh LOG [SECONDS] [POD]
set -euo pipefail
NS=${NS:-kodo-spike}
log=$1 secs=${2:-60} pod=${3:-celld-1}
here=$(dirname "$0")

kubectl -n "$NS" exec client -- sh /tmp/writer.sh "kill-$(date +%s)" 12 "$secs" > "$log" &
writer=$!
sleep $((secs / 3))
echo "force-killing $pod"
kubectl -n "$NS" delete pod "$pod" --grace-period=0 --force
wait "$writer"
python3 "$here/check.py" "$log"
