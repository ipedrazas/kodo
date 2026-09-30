# Gadgets on Kubernetes — Technical Solution Draft

Sep 30, 2026 · @Ivan Pedrazas

## Context and goals

We build a Kubernetes-native control plane that places, activates, hibernates and secures per-user mini-apps (gadgets), with all durable state in any S3-compatible store (Tigris by default).

Cloudflare OS pairs an agent chat UI with gadgets: sandboxed, per-user app instances in the Sandstorm "grain" model, plus Gatekeepers that mediate every external call. It only runs on Workers, Durable Objects, Dynamic Workers and Cloudflare Access. Customers keep asking to run it in their own clusters.

**Goals**

- One instance per document or user, not one shared multi-tenant server
- Zero ambient authority: no network, no credentials, only granted capabilities
- Scale to zero: idle gadgets cost object storage only
- Storage-agnostic: core S3 API only, no provider-specific features on the critical path
- Density: thousands of gadget instances per cluster, not a pod each
- Runs on any conformant Kubernetes (EKS, GKE, AKS, k3s, on-prem)

**Non-goals (v1)**

- Full Cloudflare API surface (KV, Queues, Vectorize, AI bindings)
- Multi-region active-active cells
- Running arbitrary containers users bring themselves

## Primitive mapping

Every Cloudflare primitive the product depends on needs a Kubernetes-side owner; the gadget runtime is the only one we cannot take off the shelf.

| Cloudflare OS / Workers | Role | Kubernetes-native equivalent |
| --- | --- | --- |
| Worker (workshop-backend "kernel") | Stateless API, orchestration | Deployment behind Gateway API |
| Durable Object | Single-writer actor with its own SQLite | Cell: actor pinned to one runtime pod, SQLite on local disk, replicated to S3 |
| Dynamic Workers | Load code at runtime | Runtime pool loads gadget bundles from S3 by content hash |
| Facets | Isolate gadgets inside a workspace | V8 isolate per gadget instance; gVisor/Kata RuntimeClass for the container tier |
| Cloudflare Access | Identity at the edge | OIDC at the gateway (customer IdP, Keycloak or Dex) |
| AI Gateway | Inference routing, cost per user | Inference gateway (LiteLLM or Envoy AI Gateway) with per-user virtual keys |
| Gatekeepers | Capability-scoped access to external services | Gatekeeper service: token vault, egress proxy, approval queue |
| Outbound disabled | No ambient network | Default-deny NetworkPolicy; egress only to Gatekeeper and inference gateway |
| R2 | Object storage | Any S3 API (Tigris default; MinIO, Ceph RGW, AWS S3, GCS interop) |

**Runtime decision.** Pod-per-gadget does not survive the per-instance model: Cloudflare reports over 4,000 gadgets internally, each multiplied by users and documents. So gadgets run as isolates inside a shared runtime pool, and the control plane places cells onto runtime pods. celld (Deno, Apache 2.0) already implements Workers and Durable Objects on V8, SQLite and S3, and is the first candidate for that pool. A container tier (one pod per instance, gVisor) stays available for gadgets that need a real process.

## Architecture overview

A small control plane decides where each gadget cell runs; a shared runtime pool executes cells as isolates; only two services may talk to the outside world.

&#91;embedded content: platform architecture · control plane, runtime pool, egress, storage\]

The router asks Placement which pod owns a cell and activates it from S3 if it is idle. Gadgets reach external systems only through Gatekeeper, and models only through the inference gateway. The agent service runs its own code as ephemeral cells in the same pool.

## Gadget lifecycle and scheduling

A gadget instance (a cell) lives in S3 and is resident on a pod only while someone uses it; placement is a lease the control plane grants, not a Kubernetes scheduling decision.

&#91;embedded content: gadget cell lifecycle · 7 states\]

A lost pod never loses committed state: its leases expire, the epoch moves on, and the next request restores the cell elsewhere.

**What lives where**

| Object | Store | Why |
| --- | --- | --- |
| RuntimePool | CRD | Few and declarative: image, node pool, RuntimeClass, capacity |
| Blueprint | CRD + S3 manifest | Versioned template: bundle digest, capabilities, tier |
| Workspace | CRD | Per team: quotas, default grants, IdP group |
| Gadget instance (cell) | Placement registry | High cardinality and churn; etcd is the wrong store |
| Lease | Placement registry or S3 conditional write | One writer per cell, fenced by epoch |

**Placement rules**

- Prefer the pod already holding the workspace's other cells (warm bundle cache)
- Otherwise the least-loaded pod in a pool matching the Blueprint's tier and tenant
- Cap resident cells per pod by memory; hibernate least-recently-used cells under pressure
- Scale the pool with KEDA on resident cells and activation queue depth, not CPU
- On pod drain, hibernate its cells and release leases so they re-place on the next request

## Storage

Object storage is the system of record; pods and local disks are caches that can be lost at any time.

**Contract with the provider.** We use only GetObject, PutObject, HeadObject, ListObjectsV2, DeleteObject(s), multipart upload, and conditional writes (If-Match / If-None-Match). Conditional writes carry the single-writer guarantee, so they are a hard requirement. Everything else is configuration: endpoint, region ("auto" for Tigris), path-style flag, credentials.

**Credentials.** Workload identity where the platform has it (IRSA, GKE Workload Identity); otherwise a Secret synced by External Secrets. Only runtime pods and the control plane get bucket access; gadgets never see keys.

**Bucket layout**

```
bundles/sha256/<digest>.tar.zst          immutable gadget code, content-addressed
blueprints/<name>/<version>.json         manifest: bundle digest, capabilities, tier
cells/<workspace>/<cell-id>/snapshot/    periodic SQLite snapshots
cells/<workspace>/<cell-id>/ltx/         incremental page logs (LTX)
cells/<workspace>/<cell-id>/lease        owner pod + epoch, written with If-Match
workspaces/<workspace>/files/            Yjs documents, uploads
audit/<yyyy>/<mm>/<dd>/                  append-only Gatekeeper and approval log
```

**Per-cell SQLite.** Each cell writes SQLite locally and streams page changes to S3, snapshotting on hibernate. Every S3 write carries the lease epoch, so a stale owner after a partition is rejected rather than corrupting state.

**Compatibility.** CI runs the storage suite against Tigris, MinIO and AWS S3. A provider that fails the conditional-write tests is unsupported, not degraded.

## Security model

Agent-written gadget code is untrusted by default, so it gets no authority except capabilities granted by name, and every side effect is logged.

**Capabilities, not credentials.** A Blueprint declares what it wants (`github:repo/acme/api:read`, `gcal:events:write`). The user grants a subset per instance. The runtime injects a binding per grant; the binding calls the Gatekeeper, which holds the OAuth token and enforces scope. Tokens never enter the isolate.

**Gatekeeper service**

- Token vault: per-user OAuth tokens, encrypted at rest (KMS or Vault transit)
- Scope enforcement per request: resource, verb, rate limit
- Side-effecting calls (send, write, delete) go to an approval queue; the user approves in the UI, then the call runs
- Every request and decision lands in `audit/` with user, gadget, cell and grant

**Layered isolation**

| Layer | Control |
| --- | --- |
| Isolate | V8 isolate per instance; no fs, no sockets, bindings only |
| Runtime pod | gVisor RuntimeClass, restricted Pod Security, no ServiceAccount token, read-only root |
| Network | Default-deny NetworkPolicy; egress only to Gatekeeper, inference gateway, S3 endpoint |
| Tenancy | Separate runtime pool (node pool, optionally namespace) per customer or trust tier |
| Browser | Each instance served from its own subdomain, so gadgets cannot read each other's origin |

**Why this matters for agents.** Prompt injection and excessive agency become contained failures: an injected gadget can only call what its grants allow, and anything irreversible waits for a human.

## Networking, routing and TLS

One wildcard hostname and one wildcard certificate front every gadget; the router, not Kubernetes Services, decides which pod serves a request.

- **DNS:** `*.g.<customer-domain>` points at the gateway load balancer; `app.<customer-domain>` serves the shell UI and agent chat
- **TLS:** cert-manager issues the wildcard via DNS-01 (Route 53, Cloud DNS, Cloudflare DNS, RFC2136 for on-prem)
- **Gateway:** Gateway API (Envoy Gateway as reference); one HTTPRoute for the wildcard to the cell router; WebSockets enabled for Yjs and live gadgets
- **Authn:** OIDC at the gateway; the router receives a signed, short-lived identity header and rejects anything unsigned
- **Routing:** hostname `<cell-id>.g.…` → router looks up placement → proxies to the owning runtime pod, activating the cell first if needed
- **Sharing:** a share is a grant (user, cell, role), checked by the router; optional capability URLs for anonymous read-only links

Target cold activation under 300 ms with the bundle cached; the spike measures the real figure against snapshot size.

## Agent runtime and inference gateway

The agent is just another tenant of the platform: its code-mode snippets run in ephemeral cells with the user's grants, and all model calls go through one gateway.

- **Agent service:** Deployment holding chat sessions (state in the workspace cell); plans, writes code, and asks the control plane for an ephemeral cell to run it
- **Code execution:** ephemeral cell, same isolate runtime, same grants as the user, destroyed after the run; nothing the agent writes gets more authority than the user has
- **Gadget authoring:** the agent writes a bundle, the control plane stores it by digest and creates a Blueprint version; publishing is a user action
- **Company context:** skills and knowledge as markdown in the workspace, loaded into the agent's context on demand
- **Inference gateway:** LiteLLM or Envoy AI Gateway; virtual key per user and team; routes to Anthropic, Bedrock, Vertex or in-cluster vLLM; budgets and rate limits enforced here

This keeps the deterministic core (placement, grants, audit) separate from the reasoning layer, which only ever proposes actions.

## Observability, audit and cost

Every trace, log and audit record carries workspace, user, blueprint and cell, so cost and incidents trace back to a person and an app.

| Signal | Source | Key metrics or content |
| --- | --- | --- |
| Metrics | Prometheus from router, runtime, control plane | Active cells, activations/s, activation p95, hibernations, S3 ops and errors, lease conflicts |
| Traces | OpenTelemetry | Request → router → cell → Gatekeeper → external API |
| Audit | Gatekeeper and approval queue → S3 `audit/` | Who called what, under which grant, approved by whom; Object Lock where the provider supports it |
| Cost | Inference gateway + runtime | Tokens per user and team; cell-seconds and storage per workspace |

Metrics carry only workspace and blueprint to keep Prometheus cardinality bounded; per-user and per-cell detail lives in traces, logs and audit.

## Delivery plan and open questions

Four phases, each ending in a demo a customer could run in their own cluster.

1. **Spike (2 weeks):** celld on Kubernetes as a StatefulSet with Tigris; run a sample Worker + Durable Object; measure activation, hibernation and failover. Exit: a pod kill loses no committed writes.
2. **Control plane MVP:** Blueprint and RuntimePool CRDs, placement registry, cell router, hibernation, OIDC, wildcard TLS. Exit: two users each run their own instance of one gadget.
3. **Gatekeepers and inference:** capability grants, token vault, approval queue, audit, inference gateway. Exit: a gadget reads a GitHub repo and drafts an email that waits for approval.
4. **Agent and hardening:** code-mode agent, gVisor tier, per-tenant pools, HA control plane, Helm chart. Exit: installable by a customer in one afternoon.

**Open questions**

- [ ] Compatibility target: run Cloudflare OS code unmodified on celld, or define our own gadget API and port Blueprints?
- [ ] Does celld support Dynamic Workers and Facets, or do we add dynamic bundle loading ourselves?
- [ ] Placement registry: Postgres (CloudNativePG) or S3 conditional writes only?
- [ ] Tenancy: shared cluster with per-customer pools, or cluster per customer?
- [ ] Which Tigris features (global replication, conditional writes) have we verified, and what is the fallback on MinIO and Ceph?

## Sources

- [cloudflare/cloudflare-os on GitHub](https://github.com/cloudflare/cloudflare-os)
- [The Register: celld liberates Durable Objects from Cloudflare](https://www.theregister.com/devops/2026/08/12/nodejs-creator-liberates-durable-objects-from-cloudflare-with-celld/5286954)
- [reptile.haus: what celld means for your architecture](https://reptile.haus/journal/celld-self-hosted-durable-objects-architecture-2026/)
- [daily.dev: Cloudflare OS explained](https://daily.dev/posts/cloudflare-os-what-it-is-how-it-works-and-why-cloudflare-built-it-xglyrv2wf)
