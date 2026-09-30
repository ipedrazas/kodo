#!/bin/sh
# Runs inside the client pod. Increments CELLS counters round-robin for SECONDS
# seconds and prints one line per request: epoch-seconds cell body status time.
# usage: writer.sh PREFIX CELLS SECONDS
end=$(( $(date +%s) + $3 ))
while [ "$(date +%s)" -lt "$end" ]; do
  i=0
  while [ "$i" -lt "$2" ]; do
    out=$(curl -s -m 120 -w ' %{http_code} %{time_total}' "http://celld/counter/$1-$i")
    echo "$(date +%s) $i $out"
    i=$((i + 1))
  done
done
