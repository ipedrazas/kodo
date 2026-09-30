#!/bin/sh
# Runs inside the client pod. Requests N cells of KIND (counter or cell) once
# each and prints: index status seconds body.
# usage: sweep.sh KIND PREFIX N TIMEOUT [QUERY]
i=0
while [ "$i" -lt "$3" ]; do
  out=$(curl -s -m "$4" -w ' %{http_code} %{time_total}' "http://celld/$1/$2-$i$5")
  echo "$i ${out##*\} } ${out%\}*}}" | cut -c1-200
  i=$((i + 1))
done
