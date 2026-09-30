#!/bin/sh
# Runs inside the client pod. Requests N cells of KIND with PARALLEL concurrent
# clients and prints one line per request: index status seconds.
# usage: burst.sh KIND PREFIX N PARALLEL TIMEOUT [QUERY]
seq 1 "$3" | xargs -P "$4" -I{} curl -s -o /dev/null -m "$5" \
  -w '{} %{http_code} %{time_total}\n' "http://celld/$1/$2-{}$6"
