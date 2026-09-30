# celld 0.6.0: four problems found running a fleet on Kubernetes

Draft for a report to the celld maintainers (patches and reports go by email to ry@deno.com). Not sent.

Environment for all four: celld 0.6.0 (`ghcr.io/denoland/celld:0.6.0`), three nodes as a Kubernetes StatefulSet on k3s 1.36, amd64, 4 CPU / 8 GiB per machine, gVisor (`runsc`) RuntimeClass, 2 GiB `local-path` volume per node, Tigris as the bucket, `CELLD_IDLE_EVICT_S=30`, everything else default. The node disks are slow at fsync (about 100 ms per synchronous 4 KiB write), which may matter for the first problem. The application and scripts are in this repository under `spike/celld/`.

## 1. Facet calls hang indefinitely after a burst of new cells

**What happens.** 24 concurrent clients create 900 new Durable Objects, each of which starts a facet and calls `facet.fetch()`. In three of four runs, some of those calls never return (we stopped waiting at 120 s): 37, 217 and 24 of 900. They are all on one node or spread over all three. On an affected node, `/state` shows `deployment.isolates.cells.<script>.requests` and `retiring` stuck above zero, and later requests to the same cells hang too. The cells answer again, with their state intact, only after that node restarts.

**It is not specific to the Worker Loader.** The same happens (14 hung, 15 returned `route failed: RuntimeFailed`) when the facet class is the application's own `ctx.exports.LocalApp` rather than a class from `env.LOADER`. Plain Durable Objects without facets did not hang in two 300-object bursts, but we did not run a 900-object burst without facets.

**Abort does not recover it.** Racing `facet.fetch()` against a 10 s timer, then calling `ctx.facets.abort(name, reason)` and retrying (once with the memoized `LOADER.get()` Worker, once with a fresh `LOADER.load()`), hangs again on every retry for the affected cells.

**Logs.** No warning or error for the hung cells themselves. Around the bursts: `gray follower evicted ... rule="backstop" outstanding_ms=1510`, `log ensemble degraded; acks ride the bucket`, and on the affected node, isolates that log `isolate retiring` but never `isolate freed`.

**Reproduce.** Deploy `spike/celld/app`, start the client pod (`task spike:client`), then run `spike/celld/scripts/hang-repro.sh h1 900 24 OUTDIR` (Worker Loader facet) or `KIND=xcell spike/celld/scripts/hang-repro.sh x1 900 24 OUTDIR` (compiled-in facet). The script prints the last `TRACE` step each hung request reached; for every hung request it was the line before `await facet.fetch(request)`.

## 2. Panic "entered isolate 0 after it was freed" on surviving nodes

**What happens.** A client holds a hibernatable WebSocket to a plain Durable Object (no facets). We force-kill the node that owns it (`kubectl delete pod --grace-period=0 --force`). The client reconnects once a second. Both surviving nodes panic within seconds:

```
INFO celld::js::websocket: accepted hibernatable WebSocket ws_id=21 scope=WsEcho:<id>
thread 'tokio-rt-worker' (7) panicked at crates/celld/pool.rs:251:21:
entered isolate 0 after it was freed
```

Kubernetes restarts them, but the fleet then serves nothing for about two minutes: all three nodes report unready until `ready_gate_open ... waited_ms=118207`, with `eager node-log recovery failed ... no complete true witness` in between.

It happened in one of two runs. In the other, the client reconnected 2.5 s after the kill and the object's state was intact.

**Reproduce.** `spike/celld/scripts/ws-test.sh /wsecho/w1 LOG` opens the socket, idles 60 s, force-kills the owner at 90 s and keeps reconnecting until 180 s.

## 3. A hibernatable WebSocket accepted inside a facet never works

**What happens.** The same class works as a top-level Durable Object and fails as a facet. As a facet, `ctx.acceptWebSocket(server)` and returning `new Response(null, { status: 101, webSocket: client })` from `fetch()` gives the client an immediate close with 1006. Every reconnect then opens and is closed at once with 1012 `owner unavailable`. The parent's `facet.fetch()` resolves normally.

It fails the same way whether the facet class comes from the Worker Loader or from `ctx.exports`. The facets documentation does not say WebSockets are unsupported in facets.

**Reproduce.** With `spike/celld/app` deployed: `node ws-client.mjs ws://HOST/wsecho/w1 8` works; `node ws-client.mjs ws://HOST/xcell/w1 8` (compiled-in facet) fails.

## 4. Loaded Dynamic Workers are never released, and a full node blocks the fleet

**What happens.** 8 concurrent clients each open a new Durable Object that loads a different bundle (900 distinct bundles, one per object) and runs it as a facet. After 319 objects (about 106 per node), every request to the fleet fails, including plain Durable Objects that load nothing:

```
Worker failed: rejected: Error: route failed: CapacityExhausted
```

`/state` on the nodes shows `pressured: true`, `memory_headroom: false`, about 780 MiB RSS against a 1 GiB container limit, only 14–18 resident cells, and 200+ `shed_cells`. So roughly 7 MiB per loaded bundle stays allocated after the objects that loaded it have hibernated. It does not recover on its own (checked for 7.5 minutes). A new deployment or a node restart clears it.

It happens with `env.LOADER.get(digest, …)` and equally with `env.LOADER.load(code)` holding one Worker per resident object.

**It also blocks restarts.** While two nodes stayed pressured, a restarted third node never became ready: `ready_gate_expired ... reason=Some(MemoryHeadroom { node: ... }) waited_ms=120054`, and readiness stayed closed, so a Kubernetes rollout could not proceed until the pressured nodes were restarted as well.

**Reproduce.** Upload N copies of a gadget that differ by a trailing comment, then `spike/celld/scripts/distinct-bundles.sh FILE PREFIX 8 60` inside the client pod, where FILE lists "index digest" pairs.
