#!/usr/bin/env bash
# Run from a workstation. Tests a hibernatable WebSocket: idle for 60 s, then
# force-kill the owner node of the cell at 90 s, and record what the client
# sees. PATH_QUERY is the app path, e.g. /wsecho/w1 or /cell/c1?bundle=DIGEST.
# usage: ws-test.sh PATH_QUERY LOG
set -euo pipefail
NS=${NS:-kodo-spike}
target=$1 log=$2
here=$(dirname "$0")

cells() { # prints "node cell-scope" for every resident cell
  for p in 0 1 2; do
    kubectl -n "$NS" exec client -- curl -s -m 10 "http://celld-$p.celld-peers:8081/state" |
      python3 -c "import json,sys; [print('celld-$p', k) for k in json.load(sys.stdin)['deployment']['cells']]"
  done | sort
}

kubectl -n "$NS" get pod wsclient >/dev/null 2>&1 ||
  kubectl -n "$NS" run wsclient --image=node:24-alpine --restart=Never --command -- sleep 604800
kubectl -n "$NS" wait --for=condition=Ready pod/wsclient --timeout=180s >/dev/null
kubectl -n "$NS" cp "$here/ws-client.mjs" wsclient:/tmp/ws-client.mjs

before=$(cells)
kubectl -n "$NS" exec wsclient -- node /tmp/ws-client.mjs "ws://celld$target" 180 > "$log" &
client=$!
sleep 5
owner=$(comm -13 <(echo "$before") <(cells) | awk '{print $1}' | head -1)
echo "owner of $target: ${owner:-unknown}"
sleep 85
if [ -n "$owner" ]; then
  echo "force-killing $owner at $(date +%s)"
  kubectl -n "$NS" delete pod "$owner" --grace-period=0 --force
fi
wait "$client"
cat "$log"
