#!/bin/sh
# Runs inside the client pod. Creates N counters and N gadget cells, waits for
# idle eviction to hibernate them, then times a cold and a warm request each.
# usage: activate.sh PREFIX N BUNDLE_DIGEST IDLE_SECONDS
hit() {
  i=0
  while [ "$i" -lt "$2" ]; do
    t=$(curl -s -o /dev/null -m 120 -w '%{http_code} %{time_total}' "http://celld/counter/$1-$i")
    echo "$3 counter $t"
    t=$(curl -s -o /dev/null -m 120 -w '%{http_code} %{time_total}' "http://celld/cell/$1-$i$4")
    echo "$3 gadget $t"
    i=$((i + 1))
  done
}
hit "$1" "$2" first "?bundle=$3"
sleep "$4"
hit "$1" "$2" cold ""
hit "$1" "$2" warm ""
