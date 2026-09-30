# Phase 1: spike follow-ups

Sep 30, 2026. Same fleet as [Phase 0](README.md): celld 0.6.0, three nodes on k3s under gVisor, 1 GiB memory limit per node, Tigris. Raw output is in `results/phase1/`; a draft report to the celld maintainers is in [upstream/celld-0.6.0-report.md](upstream/celld-0.6.0-report.md).

## Summary

The Phase 0 verdict holds for durability and fails for density. No test lost a committed write, but celld 0.6.0 has four problems that bear directly on running many untrusted gadgets:

| Problem | Effect | Mitigation available now |
| --- | --- | --- |
| Facet calls can hang forever after a burst of new cells | Affected cells stop answering until their node restarts | Bound each gadget call; answer 503 instead of hanging |
| Each distinct gadget bundle keeps ~7 MiB that is never released | About 100 distinct bundles per 1 GiB node, after which the whole fleet refuses all requests | Limit distinct bundles per fleet, larger nodes, periodic redeploys; no real fix on our side |
| A hibernatable WebSocket inside a facet never connects | Gadgets cannot own WebSockets | The kernel's cell holds the socket and relays messages to the gadget |
| A panic on surviving nodes after an owner is killed with a WebSocket client reconnecting | Fleet unavailable for about two minutes (1 of 2 runs) | None |

**Recommendation:** keep celld, report the four problems upstream, and build Phase 2 (the kernel) with the mitigations. Before Phase 6 (density and autoscaling), stop and decide again based on what upstream fixes. If the bundle-memory problem is not fixed, the draft's goal of thousands of gadget instances per cluster is only reachable when those instances share a small number of bundles.

## Exit criteria

| Criterion | Result |
| --- | --- |
| The hang is explained and avoided, or reproducible on demand and reported upstream with a workaround in place | **Partly.** Reproducible (3 of 4 runs of a 900-cell burst) and reported in the draft; it is in celld's facets, not in our code. The workaround bounds the failure (503 after 30 s) but does not recover the cell. |
| Gadget cold activation measured at several database sizes; 300 ms target confirmed, revised or given a path | **Met.** The target is not reachable; see below. |
| Warm write latency explained | **Met.** Disk fsync. |
| Behaviour beyond the Dynamic Worker limit known | **Met.** Memory runs out first, at about 100 bundles per node. |
| WebSocket to a gadget survives hibernation; failover behaviour documented | **Partly.** Works for a plain Durable Object, including a 60 s idle and an owner kill; does not work inside a facet at all. |
| CI brings up a fleet on kind and runs the kill test | **Pending.** The `fleet` job is in this PR; it runs for the first time on the PR. |
| `celld diagnose` passes on Tigris, MinIO and AWS S3 | **Changed.** MinIO no longer publishes images on Docker Hub, so CI uses SeaweedFS instead. Tigris, SeaweedFS and RustFS pass. AWS S3 is not tested yet (no credentials). |

## The hang

A burst of 900 new gadget cells from 24 concurrent clients:

| Run | Facet source | Kernel | Hung | Notes |
| --- | --- | --- | --- | --- |
| h1 | Worker Loader | Phase 0 | 37 | One node |
| h2 | Worker Loader | + tracing | 0 | |
| h3 | Worker Loader | + tracing | 217 | One node; all stopped at `await facet.fetch()` |
| w1 | Worker Loader | + abort and retry | 24 (as 503) | Abort plus two retries, one with a freshly loaded Worker, hung every time |
| x1 | Compiled into the deployment | + tracing | 14 (+15 × 500) | All three nodes |

x1 rules out the Worker Loader and our bundle loading: the facet class came from the application itself. Every hung request stopped after the facet stub was obtained and before `facet.fetch()` returned. The node's `/state` showed requests and retiring isolates that never drained, and the logs showed follower evictions caused by slow fsync (see next section) around each burst, which may be the trigger. Restarting the node always cleared it, with the cells' state intact.

The kernel now races each gadget call against a 10 s timer, aborts the facet and retries twice, then answers 503. That turns an indefinite hang into a bounded error; it does not make the cell usable again.

## Write latency

A warm write costs about 120 ms. It is the node disks:

| Measurement | Result |
| --- | --- |
| Bucket round trip from a pod (TLS, Tigris) | 22 ms |
| Pod to pod on the internal port | 4–5 ms |
| Owner's local log fsync per write (celld log) | ~52 ms |
| Follower persist per append (celld log) | ~28 ms |
| Synchronous 4 KiB write, `dd oflag=dsync`, each node, runc and gVisor alike | ~100 ms |

The first CI run confirms it: the same fleet and kill test on a GitHub runner's disk acknowledged 7379 writes at p50 3 ms and p95 4 ms, with one unacknowledged error and nothing lost.

Reads are fast: a warm read-only gadget request takes 4–30 ms. Fleet nodes need disks with low fsync latency. The same slowness makes followers miss celld's 1.5 s backstop under load (`gray follower evicted`), after which writes wait for the bucket.

## Activation against database size

Filler gadget, three cells per size, hibernated for 50 s before the cold request. Warm requests are read-only.

| Database | Cold (3 samples) | Warm |
| --- | --- | --- |
| 1 MiB | 0.93–0.97 s | 17–26 ms |
| 10 MiB | 1.8–2.2 s | 4–22 ms |
| 50 MiB | 5.1–6.5 s | 14 ms–1.4 s |

Roughly 0.8 s plus 0.1 s per MiB. The 300 ms target for a cold gadget is out of reach on this hardware and this design; what is reachable:

- Keep active gadgets resident longer (a larger `CELLD_IDLE_EVICT_S`), so fewer requests are cold.
- Keep gadget databases small, and put bulk data in objects rather than SQLite.
- Revised target: cold p50 under 1 s for gadgets under 1 MiB; warm p50 under 50 ms for reads and under 150 ms for writes on this disk.

## Distinct bundles

Each cell ran its own bundle (copies of the notes gadget differing by a comment), 8 concurrent clients:

| Loading | Bundles before failure | Failure |
| --- | --- | --- |
| `LOADER.get(digest)` | 319 (≈106 per node) | Every request to the fleet, including plain counters: `CapacityExhausted` |
| `LOADER.load()`, one per resident cell | 320 | Same |

At failure each node had about 780 MiB RSS with only 14–18 resident cells, so roughly 7 MiB per loaded bundle stays allocated after its cells hibernate. It did not recover in 7.5 minutes. A redeploy cleared it in 41 s; a restart also clears it. While two nodes were in this state, a restarted third node could not become ready, which stalled a rollout until the other two were restarted.

## WebSockets

| Case | Result |
| --- | --- |
| Plain Durable Object, idle 60 s | Message after idle answered, state kept |
| Plain Durable Object, owner force-killed (run 1) | Both surviving nodes panicked (`entered isolate 0 after it was freed`); fleet unready for about 2 minutes |
| Plain Durable Object, owner force-killed (run 2) | Client reconnected after 2.5 s, state kept |
| Gadget facet (loaded or compiled in) | Never connects: 1006, then 1012 `owner unavailable` on every retry |

The kernel will have to hold the WebSocket in the cell and pass messages to the gadget as calls. That changes the gadget API (Phase 3).

## Storage providers

`celld diagnose` checks conditional writes (create, reject-create, update, reject-stale):

| Store | Result |
| --- | --- |
| Tigris | Pass |
| SeaweedFS 3.97 (in cluster) | Pass; used for kind and CI |
| RustFS (in cluster) | Pass |
| MinIO | Not tested: no public image on Docker Hub any more |
| AWS S3 | Not tested: needs credentials |

## New in the repository

- `k8s/base`, `k8s/k3s`, `k8s/kind`: the fleet as kustomize overlays; kind runs SeaweedFS in the namespace.
- `.github/workflows/ci.yml`: a `fleet` job that runs a three-node fleet on kind and fails on any lost write.
- Taskfile: `spike:kind:up`, `spike:client`, `spike:kill-test`; `spike:deploy` uploads every gadget in `gadgets/`.
- `gadgets/filler.js`, `gadgets/echo.js`, and control classes in `app/index.js` (`XCell`, `WsEcho`) used above.
- `scripts/`: the repro and measurement scripts named in each section.
