#!/usr/bin/env bash
# Calls the kernel API of a fleet from inside the cluster, through the client
# pod, with the fleet's admin token: the operator's Fleet "kodo" (Secret
# kodo-admin-token, Service kodo) if there is one, else the fleet from
# `task fleet:up` (Secret kernel-admin, Service celld). A body argument
# starting with @ is read from that file.
# usage: api.sh CONTEXT METHOD PATH [BODY|@FILE]
#   e.g. api.sh default PUT /workspaces/team '{"quota":10}'
set -euo pipefail
context=$1 method=$2 path=$3 body=${4:-}
k=(kubectl --context "$context" -n kodo)

"${k[@]}" get pod client >/dev/null 2>&1 ||
  "${k[@]}" run client --image=curlimages/curl:8.16.0 --restart=Never --command -- sleep 604800 >/dev/null
"${k[@]}" wait --for=condition=Ready pod/client --timeout=120s >/dev/null

if "${k[@]}" get secret kodo-admin-token >/dev/null 2>&1; then
  secret=kodo-admin-token service=kodo
else
  secret=kernel-admin service=celld
fi
token=$("${k[@]}" get secret "$secret" -o jsonpath='{.data.token}' | base64 -d)
curl=(curl -sS -m 60 -X "$method" -H "Host: api.kodo" -H "x-kodo-admin-token: $token" -w '\n%{http_code}\n')
if [[ -z $body ]]; then
  "${k[@]}" exec client -- "${curl[@]}" "http://$service/api$path"
elif [[ $body == @* ]]; then
  "${k[@]}" exec -i client -- "${curl[@]}" --data-binary @- "http://$service/api$path" < "${body#@}"
else
  "${k[@]}" exec -i client -- "${curl[@]}" -H 'content-type: application/json' --data-binary @- \
    "http://$service/api$path" <<< "$body"
fi
