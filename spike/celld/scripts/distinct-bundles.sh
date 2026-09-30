#!/bin/sh
# Runs inside the client pod. Reads "index digest" lines from FILE and opens
# one gadget cell per line, each on its own bundle, with PARALLEL clients.
# Prints: index status seconds body-prefix
# usage: distinct-bundles.sh FILE PREFIX PARALLEL TIMEOUT
file=$1 prefix=$2 parallel=$3 timeout=$4
xargs -P "$parallel" -n 2 sh -c '
  out=$(curl -s -m "$2" -w "|%{http_code} %{time_total}" "http://celld/cell/$1-$3?bundle=$4")
  echo "$3 ${out##*|} $(echo "${out%|*}" | cut -c1-120)"
' _ "$prefix" "$timeout" < "$file"
