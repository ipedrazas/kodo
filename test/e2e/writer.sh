#!/bin/sh
# Runs inside the client pod. Requests one fixture-gadget cell every 0.2 s
# until the file /tmp/stop-<cell> exists, printing one line per request in
# the format spike/celld/scripts/check.py reads: epoch cell body status secs.
# usage: writer.sh SERVICE CELL
while [ ! -e "/tmp/stop-$2" ]; do
  out=$(curl -s -m 30 -H "Host: $2.g.kodo" -w ' %{http_code} %{time_total}' "http://$1/")
  echo "$(date +%s) 0 $out"
  sleep 0.2
done
