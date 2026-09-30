#!/usr/bin/env python3
"""Checks a writer.sh log: every acknowledged increment must be exactly one
more than the previous acknowledged value for that cell, unless requests failed
in between (an unacknowledged write may or may not have committed)."""
import json
import statistics
import sys

last, failed_since, lost, errors, times, slow = {}, {}, 0, 0, [], []
for line in open(sys.argv[1]):
    parts = line.rsplit(" ", 2)
    ts, cell, body = parts[0].split(" ", 2) if parts[0].count(" ") >= 2 else (*parts[0].split(" "), "")
    status, secs = parts[1], float(parts[2])
    if status != "200":
        errors += 1
        failed_since[cell] = failed_since.get(cell, 0) + 1
        continue
    n = json.loads(body)["n"]
    times.append(secs)
    if secs > 1:
        slow.append((int(ts), cell, secs))
    if cell in last:
        gap = n - last[cell]
        if gap < 1:
            lost += 1
            print(f"LOST WRITE cell={cell} acked {last[cell]} then {n}")
        elif gap > 1 + failed_since.get(cell, 0):
            print(f"UNEXPECTED JUMP cell={cell} {last[cell]} -> {n}")
    last[cell], failed_since[cell] = n, 0

times.sort()
print(f"acked={len(times)} errors={errors} lost={lost}")
print(f"latency p50={statistics.median(times)*1000:.0f}ms p95={times[int(len(times)*0.95)]*1000:.0f}ms max={times[-1]*1000:.0f}ms")
for ts, cell, secs in slow:
    print(f"slow: t={ts} cell={cell} {secs:.2f}s")

if lost or not times:
    sys.exit(1)
