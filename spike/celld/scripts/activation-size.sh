#!/bin/sh
# Runs inside the client pod. For each size in MiB, fills REPS filler-gadget
# cells to that size in 5 MiB requests, waits IDLE seconds for them to
# hibernate, then times one cold and one warm request per cell.
# Prints: size_mib phase status seconds
# usage: activation-size.sh PREFIX FILLER_DIGEST IDLE REPS SIZE...
prefix=$1 digest=$2 idle=$3 reps=$4
shift 4
for size in "$@"; do
  r=0
  while [ "$r" -lt "$reps" ]; do
    cell="http://celld/cell/$prefix-$size-$r"
    curl -s -o /dev/null -m 120 "$cell?bundle=$digest"
    left=$size
    while [ "$left" -gt 0 ]; do
      step=$(( left < 5 ? left : 5 ))
      curl -s -o /dev/null -m 300 "$cell?fill=$step"
      left=$((left - step))
    done
    r=$((r + 1))
  done
  sleep "$idle"
  for phase in cold warm; do
    r=0
    while [ "$r" -lt "$reps" ]; do
      echo "$size $phase $(curl -s -o /dev/null -m 300 -w '%{http_code} %{time_total}' "http://celld/cell/$prefix-$size-$r")"
      r=$((r + 1))
    done
  done
done
