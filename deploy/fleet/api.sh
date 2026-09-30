#!/usr/bin/env bash
# Calls the kernel API of a fleet from inside the cluster, through the client
# pod, since the API has no ingress until Phase 5. A body argument starting
# with @ is read from that file.
# usage: api.sh CONTEXT METHOD PATH [BODY|@FILE]
#   e.g. api.sh default PUT /workspaces/team '{"quota":10}'
set -euo pipefail
context=$1 method=$2 path=$3 body=${4:-}
k=(kubectl --context "$context" -n kodo)

"${k[@]}" get pod client >/dev/null 2>&1 ||
  "${k[@]}" run client --image=curlimages/curl:8.16.0 --restart=Never --command -- sleep 604800 >/dev/null
"${k[@]}" wait --for=condition=Ready pod/client --timeout=120s >/dev/null

curl=(curl -sS -m 60 -X "$method" -H "Host: api.kodo" -w '\n%{http_code}\n')
if [[ -z $body ]]; then
  "${k[@]}" exec client -- "${curl[@]}" "http://celld/api$path"
elif [[ $body == @* ]]; then
  "${k[@]}" exec -i client -- "${curl[@]}" --data-binary @- "http://celld/api$path" < "${body#@}"
else
  "${k[@]}" exec -i client -- "${curl[@]}" -H 'content-type: application/json' --data-binary @- \
    "http://celld/api$path" <<< "$body"
fi
