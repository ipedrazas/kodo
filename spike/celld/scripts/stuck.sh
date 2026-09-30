#!/bin/sh
# Run from a workstation. Prints the in-flight requests and retiring isolates
# of each celld node, which stay above zero on a node with hung requests.
for p in 0 1 2; do
  kubectl -n "${NS:-kodo-spike}" exec client -- curl -s -m 10 "http://celld-$p.celld-peers:8081/state" |
    python3 -c "
import json, sys
d = json.load(sys.stdin)
i = d['deployment']['isolates']['cells'].get('kodo-spike', {})
print('celld-$p', 'owned', d.get('owned_cells'), 'resident', d['node_load'].get('resident_cells'),
      'requests', i.get('requests'), 'retiring', i.get('retiring'), 'live', i.get('live'))"
done
