# Phase 0: celld spike

Sep 30, 2026. celld 0.6.0, three nodes on the k3s cluster (3 × 4 CPU / 8 GiB, amd64), Tigris bucket `kodo-celld-spike`.

## Verdict

**Go on celld as the runtime, and shrink the plan around it.** celld already does most of what the plan assigned to our control plane: single-writer ownership by conditional write, placement, hibernation, failover, rebalancing, memory-pressure shedding, and loading code at runtime into a separate isolate with its own SQLite database. No committed write was lost in any test.

Three things stand against an unconditional go:

- **One unexplained hang.** After a 900-cell burst, one node stopped answering for about 60 of the gadget cells it owned until the pod was restarted. No state was lost. Two later 300-cell bursts did not reproduce it.
- **Gadget cold activation misses the 300 ms target** (p50 about 540–600 ms).
- **celld is a beta** that states it "is not safe for hostile multi-tenant use", and it accepts no pull requests.

## What was run

- `app/`: one celld application with a plain `Counter` Durable Object and a `Cell` Durable Object. `Cell` fetches a gadget bundle from object storage by SHA-256 digest, loads it with the Worker Loader, and runs its `App` class as a facet with `env: {}` and `globalOutbound: null`.
- `gadgets/notes.js`: a sample gadget that counts requests in its own SQLite database and reports the bindings and network it can see.
- `k8s/celld.yaml`: a three-replica StatefulSet under the `gvisor` RuntimeClass with a 2 GiB `local-path` volume each and idle eviction at 30 s.
- `scripts/`: the load scripts (run inside a client pod in the same namespace) and the checkers. Raw output is in `results/`.

Reproduce with `task spike:deploy` and `task spike:up`; `task spike:down` removes the namespace.

## Exit criteria

| Criterion | Result |
| --- | --- |
| Sample gadget serves requests and persists SQLite state to Tigris | Met |
| Killing a pod mid-workload loses no committed writes | Met: 0 lost in every run below |
| Activation, hibernation and failover measured, with and without gVisor | Met, see below |
| Dynamic bundle loading answered | Supported by celld (Worker Loader and facets); nothing for us to build |
| Go/no-go written up | This file |

## Durability and failover

Each run increments 12 counters round-robin and checks that every acknowledged value is exactly one more than the last acknowledged value for that counter.

| Run (gVisor unless noted) | Acked | Errors | Lost | Slowest request |
| --- | --- | --- | --- | --- |
| Force-kill one pod (`--grace-period=0 --force`) | 456 | 0 | 0 | 1.9 s |
| Force-kill one pod and delete its volume | 816 | 0 | 0 | 2.2 s |
| Rolling restart of all three pods (gVisor → runc) | 1139 | 1 | 0 | 4.7 s |
| Force-kill one pod, then read 30 gadget cells | 30 | 0 | 0 | 11 s |

- The one error in the rolling restart was an HTTP 500 `durability unproven`: celld refused to acknowledge a write it could not prove durable, which is the correct failure.
- The volume-loss run has a weakness: the kill landed 2 s after the workload started, and while a rolling restart was still finishing, so the killed node held few writes.
- A cell whose owner was killed answered again after 1–2 s in the counter runs and up to 11 s in the gadget run; the node lease lifetime is 10 s.

## Latency

Measured with curl from a pod in the cluster, 30 cells per row, sequential. Every request performs a write.

| Request | gVisor p50 / p95 | runc p50 / p95 |
| --- | --- | --- |
| Counter, warm | 131 / 376 ms | 187 / 347 ms |
| Counter, cold (hibernated 50 s earlier) | 279 / 511 ms | 222 / 471 ms |
| Counter, first ever | 602 / 855 ms | 575 / 743 ms |
| Gadget cell, warm | 152 / 424 ms | 168 / 415 ms |
| Gadget cell, cold | 599 / 886 ms | 536 / 900 ms |
| Gadget cell, first ever | 996 / 1124 ms | 896 / 1327 ms |

- gVisor makes no measurable difference at this sample size; the runs differ by less than their own spread.
- A warm write costs about 100 ms, against the roughly 25 ms the celld README reports for a fleet. Not investigated; the bucket's distance from the cluster is the first thing to check.
- A gadget cell restores two databases (the cell's and the facet's) and recompiles the bundle, which is where the extra 300 ms goes.

## Burst activation

24 concurrent clients creating cells that did not exist before, under gVisor.

| Burst | OK | Timed out | p50 | p95 |
| --- | --- | --- | --- | --- |
| 300 counters | 300 | 0 | 2.1 s | 3.0 s |
| 300 gadget cells | 300 | 0 | 5.0 s | 6.3 s |
| 900 gadget cells | 889 | 11 (120 s) | 4.6 s | 5.7 s |

That is about 11 new counters or 5 new gadget cells per second across the fleet. The pods stayed under 300 MiB each throughout, with around 350 owned cells per node, nearly all hibernated.

### The hang

After the 900-cell burst, requests to some gadget cells never returned. A second pass over all 900 found 57 timing out and 4 returning HTTP 500; of the first 32 of those retried one at a time, 31 still hung (that retry log was not kept). `/state` on one node (`celld-0`) showed 10 requests and 5 retiring isolates that never drained. New gadget cells placed on that node hung too (13 of 30). Restarting that pod cleared it: all 30 answered, and the 13 that had hung still had their state.

Not diagnosed. The burst started shortly after a pod had been force-killed with its volume deleted and a rolling restart had finished, which may matter. It could also be a fault in `app/index.js` rather than in celld.

## What this changes in the plan

| Plan item | Finding |
| --- | --- |
| Placement registry in Postgres (Phase 4) | Not needed. Ownership is a conditional-write record in the bucket, any node routes a request to the owner, and `celld cell list` enumerates cells. |
| Lease and epoch library (Phase 1) | celld owns this. `celld diagnose` tests a bucket's conditional writes; it passed on Tigris. Phase 1 shrinks to running it against each provider. |
| Hibernate and reactivate (Phase 3) | Built in (`CELLD_IDLE_EVICT_S`). |
| Multi-pod placement, failover and drain (Phase 4) | Built in, including graceful handoff on SIGTERM. |
| Memory-pressure eviction and resident caps (Phase 7) | Built in (`CELLD_MAX_RSS_MB`, `CELLD_MAX_RESIDENT_CELLS`). Autoscaling is still ours: celld publishes load in each node lease and on `/state`. |
| Cell router in Go (Phase 2) | The router is a Worker inside the celld application, not a separate Go service. Go remains for the operator, Gatekeeper and anything outside the fleet. |
| Gadget API | A gadget is a module exporting a Durable Object class, loaded with `env` as its only authority. `globalOutbound: null` blocked outbound `fetch` in the test. |
| Tenancy (Phase 13) | A fleet runs one application and trusts its code. Isolation between customers means a fleet per tenant (a bucket or prefix each), which matches the per-tenant RuntimePool, plus gVisor on the pods. |

## Limits to design around

- **Isolation is a V8 isolate in a shared process.** celld makes no claim about V8 escapes. gVisor on the pod is the kernel boundary, and it is per fleet, not per gadget.
- **256 live Dynamic Workers per process.** Cells of one class share an isolate and therefore one loaded copy of a bundle, so this bounds distinct live bundles per pod, not cells. Not tested at the limit.
- **Facets cannot set alarms**; the parent cell must hold schedules.
- **A fleet needs two or more nodes** for fast writes; a single node waits for the bucket on every write.
- **Flags must be passed as `--flag value`**; `--flag=value` is rejected.
- **No upstream pull requests**; patches go by email, and mixed versions cannot share a fleet.

## Not tested

- Snapshot sizes beyond a few kilobytes, so activation time against database size is unknown.
- WebSockets, and hibernation with open connections.
- Loss of a whole node, a network partition, or two nodes at once.
- MinIO and AWS S3.
- Scale-down to zero nodes and back.
