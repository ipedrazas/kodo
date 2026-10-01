# Plan: Gadgets on Kubernetes

> Source PRD: [Gadgets on Kubernetes — Technical Solution Draft](./Gadgets%20on%20Kubernetes%20-%20Technical%20Solution%20Draft.md) (Sep 30, 2026)
>
> Revised after the [Phase 0 celld spike](../spike/celld/README.md). celld already provides cell ownership, placement, hibernation, failover and runtime code loading, so the placement registry, the lease library and the Go cell router from the first version of this plan are gone.

## Architectural decisions

Durable decisions that apply across all phases:

- **Runtime**: celld. A **fleet** is a set of celld nodes sharing one bucket prefix and running one application. celld owns single-writer ownership, placement, hibernation, failover, rebalancing and memory-pressure eviction; we configure and verify these, we do not build them.
- **Kernel**: the one application every fleet runs. It is a Worker, written in TypeScript, that routes requests, authorises them, loads gadget bundles and hands each gadget its capabilities. It replaces the Go cell router.
- **Gadget API**: our own, not Cloudflare OS compatibility. A gadget is a bundle whose main module exports a Durable Object class. The kernel loads it by digest with the Worker Loader and runs it as a facet of its cell, with its own SQLite database, no ambient network, and only the bindings the kernel passes in.
- **Cell**: one kernel Durable Object per gadget instance, holding the instance's Blueprint version and grants, with the gadget as its facet. Facets cannot set alarms or hold WebSockets in celld 0.6.0, so the cell holds schedules and WebSockets on the gadget's behalf and passes events to it as calls. Every call into a gadget is bounded in time and answered with an error rather than left hanging.
- **State**: everything durable lives in the bucket. There is no database. The per-workspace registry of cells, owners, shares and grants is itself a Durable Object (one per Workspace).
- **Key models**: Fleet, Workspace, Blueprint (name, version, bundle digest, capabilities, tier), Cell (workspace, cell id, blueprint version, owner), Grant (user, cell, capability), Share (user, cell, role).
- **Go services**: the operator, the Gatekeeper and a small metrics exporter. Go does not sit on the request path to a gadget.
- **CRDs**: `Fleet`, `Blueprint`, `Workspace` under `kodo.dev/v1alpha1`. Cells never go in etcd.
- **Gatekeeper state**: the Gatekeeper is stateless. Encrypted tokens and approvals are bucket objects under prefixes only the Gatekeeper's credentials can read, never a fleet's. Every approval state change (pending → approved → executing → done, or rejected) is a conditional write, so two replicas cannot claim the same approval. An approval that fails mid-execution is reported as failed, not retried.
- **Secrets**: tokens are encrypted through a vault interface and only the ciphertext is stored. OpenBao's transit engine is the first backend; a cloud KMS can follow. Platform secrets (bucket credentials, OIDC client secret, DNS-01 credentials) reach the cluster through External Secrets, from OpenBao where it is available. OpenBao is supported, not required.
- **Bucket layout**: celld owns the layout of a fleet's bucket. Gadget bundles go through an R2 binding, which celld stores under `r2/bundles/sha256/<digest>.js`. Blueprint versions, workspaces and cell bindings are Durable Objects of the kernel (`Catalog`, `Workspace`, `Cell`), so they live in celld's cell state rather than as objects of ours. Objects outside any fleet (`vault/<user>/`, `approvals/<user>/<id>.json`, `audit/<yyyy>/<mm>/<dd>/`) sit beside it under their own prefixes.
- **Storage contract**: whatever `celld diagnose` accepts, which includes conditional writes and ranged reads. A provider that fails it is unsupported.
- **Hostnames**: `<cell-id>.g.<domain>` for cells, `app.<domain>` for the shell UI, the agent chat and the API. One wildcard certificate via cert-manager DNS-01; celld does not terminate TLS.
- **API**: under `app.<domain>/api/`, served by the kernel: workspaces, blueprints, cells, grants, shares.
- **Identity**: OIDC at the gateway (Gateway API, Envoy Gateway as reference), with one session cookie on the parent domain covering the app and every cell. The gateway forwards the user's ID token in `x-kodo-identity`; the kernel verifies it against the issuer's keys and strips it, and the session cookies, before a gadget sees the request. The operator uses a per-fleet admin token instead. Cells are shared by email as viewer or editor, and every cell refuses writes and WebSockets from other origins.
- **Capabilities**: `<provider>:<resource>:<verb>`, declared by the Blueprint, granted per instance by the user. A grant becomes a binding in the gadget's `env` that calls back into the kernel, which calls the Gatekeeper. Tokens never enter a fleet.
- **Isolation**: a gadget is a V8 isolate in a process shared with other gadgets of the same fleet; celld makes no claim beyond that. The kernel boundary is gVisor on the fleet's pods. Mutually distrusting tenants get a fleet each.
- **Egress**: default-deny NetworkPolicy on fleet pods; egress only to the Gatekeeper, the inference gateway and the bucket endpoint. celld's internal listener is unauthenticated for operator actions, so it is reachable only from pods of the same fleet.
- **Upgrades**: mixed celld versions cannot share a fleet, so a celld upgrade stops a fleet and restarts it. Kernel deployments roll without a restart.
- **Kernel delivery**: the kernel ships as an image (celld, esbuild and the kernel source) that the operator runs as a Job against the fleet's bucket. The operator reaches each kernel API through the Kubernetes API server's service proxy. Images are published to GHCR by CI.
- **Metric labels**: workspace and blueprint only; user and cell detail lives in traces, logs and audit.
- **Environments**: kind with SeaweedFS for local development and CI (MinIO no longer publishes images); the k3s cluster with gVisor and Tigris for integration, performance and demos.
- **Node disks**: fleet nodes need low fsync latency; celld's write latency and follower health follow it directly (Phase 1 measured about 100 ms per fsync on the k3s nodes and 120 ms per write).
- **Loaded code is memory**: each distinct gadget bundle costs about 7 MiB per node in celld 0.6.0 and is not released, so the number of distinct bundles a fleet serves is bounded by node memory until upstream fixes it.
- **Out of scope for v1**: the container tier, the wider Cloudflare API surface as a gadget-facing API, multi-region fleets.

---

## Phase 0: celld spike (done)

See [spike/celld/README.md](../spike/celld/README.md). Verdict: go. No committed write was lost; runtime loading by digest works; gadget cold activation is about 600 ms p50; one hang was seen and not explained.

---

## Phase 1: Spike follow-ups and storage check (done)

See [spike/celld/PHASE1.md](../spike/celld/PHASE1.md). Durability held throughout; density did not. celld 0.6.0 has four problems, drafted as a report to its maintainers: facet calls that hang after a burst, loaded bundles that are never released (about 100 distinct bundles per 1 GiB node before the fleet refuses everything), no WebSockets inside facets, and a panic on surviving nodes after an owner is killed. Cold gadget activation is about 0.8 s plus 0.1 s per MiB, so the 300 ms target is replaced by cold p50 under 1 s for gadgets under 1 MiB. Warm write latency is the node disks. CI runs a fleet on kind with SeaweedFS. AWS S3 was dropped from this phase; Tigris, SeaweedFS and RustFS are the tested providers.

---

## Phase 2: Kernel and one gadget end to end (done)

Merged in [#5](https://github.com/ipedrazas/kodo/pull/5). The cell-to-bundle binding by hand was replaced in Phase 3.

**User stories**: routing by hostname; bundle loading by digest; per-cell SQLite; scale to zero.

### What to build

The kernel as a real project in the repository, with its build, tests and deployment in the Taskfile and CI. A request to `<cell-id>.g.<domain>` reaches the kernel, which resolves the cell, loads the gadget bundle from `bundles/sha256/` and forwards the request to the gadget facet. The cell-to-bundle binding is set by hand in this phase. Idle eviction is configured so an unused cell hibernates.

### Acceptance criteria

- [x] A bundle uploaded by digest is served at its cell hostname
- [x] Two cells of the same bundle keep separate state
- [x] The gadget sees no bindings and cannot make outbound connections
- [x] A gadget error or an unknown bundle produces a clear response and does not affect other cells
- [x] An idle cell hibernates and the next request restores its state
- [x] WebSocket connections reach the gadget through the cell, which holds the socket
- [x] A gadget call that hangs is answered with an error within a bounded time, and the cell keeps serving other calls
- [x] Kernel tests run in CI; deploys to kind and to k3s under gVisor from one task

---

## Phase 3: Blueprints, workspaces and the gadget API (done)

Merged in [#6](https://github.com/ipedrazas/kodo/pull/6). The contract is [kernel/GADGETS.md](../kernel/GADGETS.md); the sample is [kernel/examples/notes.js](../kernel/examples/notes.js).

**User stories**: versioned gadget templates; one instance per user or document; per-team quotas.

### What to build

The Workspace registry and the first version of the API. Publishing a Blueprint version records its manifest (bundle digest, declared capabilities, tier) in the kernel's catalog. Creating a cell from a Blueprint in a Workspace records it in that Workspace's registry and pins the Blueprint version. The gadget API is written down: what a gadget exports, what it receives, what it cannot do.

### Acceptance criteria

- [x] A Blueprint version can be published and listed through the API
- [x] Creating two cells from one Blueprint yields two independent instances
- [x] A new Blueprint version does not alter existing cells; a cell can be moved to it explicitly
- [x] A Workspace lists its cells and enforces a cell quota
- [x] A cell not in any registry is not served
- [x] The gadget API document matches what the kernel enforces, with a sample gadget that uses all of it, including WebSocket messages and scheduled events delivered by the cell

---

## Phase 4: Operator and CRDs (done)

Merged in [#7](https://github.com/ipedrazas/kodo/pull/7). Verified end to end on kind in CI and on the k3s cluster under gVisor; see [config/README.md](../config/README.md).

**User stories**: declarative fleets; runs on any conformant Kubernetes.

### What to build

The Go operator. A `Fleet` reconciles into the celld workload, its Services, its bucket credentials, its kernel deployment and the NetworkPolicy that confines the internal listener to the fleet's own pods. `Blueprint` and `Workspace` resources reconcile into the same API calls Phase 3 exposed, so cluster operators can manage them declaratively. A kernel change rolls out without restarting nodes; a celld version change follows the stop-and-restart rule.

### Acceptance criteria

- [x] Applying a Fleet produces a serving fleet with the kernel deployed
- [x] Changing the kernel version on a Fleet rolls it out with no failed requests
- [x] Changing the celld version restarts the fleet in the documented order and loses no committed writes
- [x] The internal listener is unreachable from outside the fleet's pods
- [x] Pod termination grace is long enough for celld's handoff, verified by a rolling restart under load
- [x] Applying Blueprint and Workspace resources has the same effect as the API calls
- [x] Deleting a Fleet leaves its bucket data untouched

---

## Phase 5: Identity, TLS and sharing (done)

Merged in [#9](https://github.com/ipedrazas/kodo/pull/9), running at hiddenfield.dev on the LAN ([deploy/k3s/README.md](../deploy/k3s/README.md)); public access is [#8](https://github.com/ipedrazas/kodo/issues/8). Not built: the optional anonymous capability URLs, and workspace membership (any logged-in user can create cells in any workspace, within its quota).

**User stories**: OIDC at the gateway; wildcard TLS; per-user instances; shares.

### What to build

Gateway API with OIDC against a customer IdP (Dex in kind), the wildcard certificate via cert-manager, and the signed identity header, which the kernel verifies. Cells get an owner; the kernel authorises each request against ownership and the Workspace's share grants. Optional capability URLs give anonymous read-only access.

### Acceptance criteria

- [x] Unauthenticated requests are redirected to the IdP
- [x] The kernel rejects a missing, unsigned or expired identity header
- [x] Two users each run their own instance of one gadget and cannot open each other's
- [x] Sharing a cell with a role grants the second user access; revoking removes it
- [x] The gadget receives the caller's identity but no credential
- [x] Wildcard certificate issues and renews on the k3s cluster
- [x] Each cell is served from its own origin

---

## Phase 6: Autoscaling and observability

**User stories**: density; scaling on cells, not CPU; metrics and traces.

**Checkpoint before starting**: decide again on celld based on what upstream has fixed of the Phase 1 problems, in particular the unreleased bundle memory, which caps density.

### What to build

A small exporter that turns celld's node leases and `/state` into Prometheus metrics, and KEDA scaling of each Fleet on resident cells and activations waiting for capacity. Resident-cell and memory limits are set per Fleet from the pod's resources. Kernel and Go services emit OpenTelemetry traces. A load test establishes cells per pod and per cluster.

### Acceptance criteria

- [ ] A fleet scales out when activations queue and back in when nodes have headroom, with no failed requests during either
- [ ] A node at its limit hibernates idle cells rather than failing activations
- [ ] Metrics cover active cells, activations/s, activation p95, hibernations, bucket errors and fleet health
- [ ] Metric labels are limited to workspace and blueprint
- [ ] A trace follows a request from the gateway through the kernel to the gadget
- [ ] The load test reports cells per pod and per cluster on k3s, against the draft's goal of thousands per cluster
- [ ] Scale to zero nodes and back is either supported or explicitly ruled out with the reason

---

## Phase 7: Gatekeeper read path

**User stories**: capabilities, not credentials; token vault; default-deny network; audit.

### What to build

The Gatekeeper as a stateless Go service outside every fleet, with per-request scope enforcement and a per-user token vault: tokens encrypted with OpenBao transit and stored as ciphertext under `vault/`. The Gatekeeper authenticates to OpenBao with its Kubernetes identity. A Blueprint declares capabilities, the user grants a subset per instance, and the kernel gives the gadget one binding per grant. A call on that binding goes to the kernel, which asserts the cell and grant to the Gatekeeper. GitHub read is the first provider. Default-deny egress goes onto fleet pods, and every request and decision is appended to `audit/`.

### Acceptance criteria

- [ ] A gadget with a granted `github:repo/<org>/<repo>:read` reads that repo
- [ ] The same gadget is denied a repo or verb outside its grant
- [ ] A gadget without the grant has no binding at all
- [ ] The Gatekeeper rejects a call that does not come from a fleet it trusts
- [ ] Direct outbound connections from a fleet pod fail, except to the Gatekeeper, inference gateway and bucket
- [ ] OAuth tokens are stored only as ciphertext, the Gatekeeper holds no encryption key, and no token reaches a fleet
- [ ] A fleet's bucket credentials cannot read `vault/` or `approvals/`
- [ ] The vault backend is an interface with OpenBao transit as its one implementation
- [ ] Each call is in the audit log with user, gadget, cell, grant and decision

---

## Phase 8: Approval queue

**User stories**: side-effecting calls wait for a human.

### What to build

The Gatekeeper classifies calls by verb. Writes, sends and deletes are parked as objects under `approvals/`, each state change a conditional write; the user sees the pending action in the shell UI, approves or rejects it, and only then does the call run. An email provider is the first side-effecting integration.

### Acceptance criteria

- [ ] A gadget drafts an email and the send waits in the queue
- [ ] Approving runs the call at most once, even with two Gatekeeper replicas racing; rejecting never runs it
- [ ] A Gatekeeper killed mid-execution leaves the approval reported as failed, not silently retried or lost
- [ ] The gadget observes the pending, approved and rejected outcomes
- [ ] Pending approvals survive a Gatekeeper restart and cell hibernation
- [ ] Audit records who approved what, and when

---

## Phase 9: Inference gateway

**User stories**: model routing; cost per user and team; budgets.

### What to build

Deploy the inference gateway (LiteLLM or Envoy AI Gateway, chosen in this phase) with a virtual key per user and team. Gadgets reach models through an inference binding; keys stay outside the fleet. Budgets and rate limits are enforced at the gateway and usage is attributed per user and workspace.

### Acceptance criteria

- [ ] A gadget calls a model through its binding with no provider key in the fleet
- [ ] A user over budget is refused at the gateway
- [ ] Token usage is reported per user and team
- [ ] Routing to at least two backends is configurable without gadget changes
- [ ] Storage and activity per workspace are reported alongside tokens

---

## Phase 10: Agent code execution

**User stories**: agent as a tenant; ephemeral cells.

### What to build

The agent service and the chat surface at `app.<domain>`, with session state in the workspace. The agent plans, writes a snippet, and asks the kernel to run it as an ephemeral gadget with the user's grants, destroyed afterwards. Workspace markdown (skills, knowledge) is loaded into context on demand.

### Acceptance criteria

- [ ] A chat request results in code executed in an ephemeral cell and a result returned
- [ ] The ephemeral cell has exactly the user's grants, never more
- [ ] A side-effecting call from agent code goes through the approval queue
- [ ] The ephemeral cell and its state are gone after the run
- [ ] Runaway agent code is stopped by CPU and request limits without affecting other cells
- [ ] Chat history survives an agent service restart

---

## Phase 11: Agent gadget authoring

**User stories**: agent writes gadgets; publishing is a user action.

### What to build

The agent produces a gadget bundle; the kernel stores it by digest and creates a draft Blueprint version with its declared capabilities. The user reviews the requested capabilities, publishes, and opens an instance.

### Acceptance criteria

- [ ] The agent produces a working gadget from a chat request
- [ ] The draft is not instantiable by others until the user publishes
- [ ] The user sees and grants capabilities before first use
- [ ] A revised gadget becomes a new Blueprint version; existing instances are unaffected
- [ ] Audit records who authored and who published

---

## Phase 12: Tenancy and hardening

**User stories**: layered isolation; per-tenant fleets; high availability.

### What to build

A fleet per tenant or trust tier, each with its own bucket prefix, credentials and node pool. Fleet pods run with restricted Pod Security, no ServiceAccount token, a read-only root filesystem and a mandatory sandboxed RuntimeClass. The operator, Gatekeeper and exporter run with replicas and leader election. Bucket access uses workload identity where the platform has it.

### Acceptance criteria

- [ ] A fleet pod refuses to start without the sandboxed RuntimeClass and passes restricted Pod Security admission
- [ ] A cell of one tenant cannot be served by another tenant's fleet, and one fleet's credentials cannot read another's prefix
- [ ] Losing any one operator or Gatekeeper replica causes no failed requests beyond in-flight ones
- [ ] Losing a whole node, and two fleet nodes at once, loses no committed writes
- [ ] Workload identity is used for bucket access where available, External Secrets otherwise
- [ ] Audit objects use Object Lock where the provider supports it

---

## Phase 13: Helm chart and install

**User stories**: runs on any conformant Kubernetes; installable in one afternoon.

### What to build

A single Helm chart for the whole platform with documented prerequisites (Gateway API, cert-manager, KEDA, External Secrets, a bucket, an IdP, and OpenBao or another supported vault backend), a preflight check that runs `celld diagnose` against the customer's bucket, and an install guide.

### Acceptance criteria

- [ ] Clean install on a fresh k3s cluster and on one managed cluster (EKS, GKE or AKS)
- [ ] Preflight fails clearly on a bucket that does not meet the storage contract
- [ ] Someone outside the team completes the install from the guide in one afternoon
- [ ] Upgrade from the previous chart version keeps existing cells intact, including a celld version change
- [ ] Uninstall leaves the bucket untouched
