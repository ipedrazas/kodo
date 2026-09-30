#!/usr/bin/env python3
"""Summarises an activate.sh log as p50/p95/max per phase and kind."""
import collections
import statistics
import sys

groups = collections.defaultdict(list)
for line in open(sys.argv[1]):
    phase, kind, status, secs = line.split()
    groups[(phase, kind, status)].append(float(secs) * 1000)
for (phase, kind, status), ms in sorted(groups.items()):
    ms.sort()
    print(f"{phase:5} {kind:7} status={status} n={len(ms):3} p50={statistics.median(ms):5.0f}ms p95={ms[int(len(ms)*0.95)]:5.0f}ms max={ms[-1]:5.0f}ms")
