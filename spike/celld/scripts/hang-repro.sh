#!/bin/sh
# Run from a workstation. Bursts N new gadget cells, then prints the outcome,
# per-node hung-request counters, and for each failed request the last TRACE
# step the kernel logged and the node that logged it.
# usage: [KIND=cell|xcell] hang-repro.sh PREFIX N PARALLEL OUTDIR
set -e
NS=${NS:-kodo-spike}
KIND=${KIND:-cell}
D=${BUNDLE:-1af72ab4e5e02960df7506fb4cf324251131f9b350035d46d620a973514dcdb1}
here=$(dirname "$0")
t0=$(date -u +%Y-%m-%dT%H:%M:%SZ)
kubectl -n "$NS" exec client -- sh /tmp/burst.sh "$KIND" "$1" "$2" "$3" 120 "?bundle=$D" > "$4/$1-burst.log" || true
awk '{c[$2]++} END{for(k in c) print "status", k, c[k]}' "$4/$1-burst.log"
"$here/stuck.sh"
for p in 0 1 2; do
  kubectl -n "$NS" logs "celld-$p" --since-time="$t0" | grep "TRACE /$KIND/$1-" |
    sed -E "s/^([^ ]+) .*TRACE ([^ ]+) ([a-z0-9-]+)$/\1 celld-$p \2 \3/"
done > "$4/$1-trace.log"
python3 - "$1" "$4" "$KIND" <<'PY'
import collections, sys
prefix, out, kind = sys.argv[1], sys.argv[2], sys.argv[3]
last = {}
for line in open(f"{out}/{prefix}-trace.log"):
    ts, node, path, step = line.split()
    last[path] = (step, node)
fails = [l.split()[0] for l in open(f"{out}/{prefix}-burst.log") if l.split()[1] != "200"]
c = collections.Counter(last.get(f"/{kind}/{prefix}-{i}", ("no-trace", "-")) for i in fails)
print("failed", len(fails), "by (last step, node):", dict(c))
PY
