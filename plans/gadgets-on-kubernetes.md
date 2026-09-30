# Plan: Gadgets on Kubernetes

> Source PRD: [Gadgets on Kubernetes — Technical Solution Draft](./Gadgets%20on%20Kubernetes%20-%20Technical%20Solution%20Draft.md) (Sep 30, 2026)

## Architectural decisions

Durable decisions that apply across all phases:

- **Languages**: Go (kubebuilder / controller-runtime) for the control plane, cell router and Gatekeeper. celld is the runtime pool, subject to the Phase 0 go/no-go.
- **Gadget API**: our own narrow API, Workers-shaped but with no promise to run Cloudflare OS code unmodified. A gadget is a bundle exporting a fetch handler, with a per-cell SQLite database and named bindings as its only authority.
- **CRDs**: `RuntimePool`, `Blueprint`, `Workspace` under `kodo.dev/v1alpha1`. Cells and leases never go in etcd.
- **Placement registry**: Postgres (CloudNativePG) is the queryable index of cells, owners and pod load. The S3 `lease` object (owner pod + epoch, written with If-Match) is the only correctness fence; the registry can be rebuilt from S3.
- **Key models**: Workspace, Blueprint (name, version, bundle digest, capabilities, tier), Cell (workspace, cell id, blueprint version, owner user, state), Lease (pod, epoch), Grant (user, cell, capability), Share (user, cell, role).
- **Cell states**: the seven-state lifecycle from the draft; the state names are fixed in Phase 3 and reused in metrics and the registry.
- **Bucket layout**: as in the draft, unchanged (`bundles/sha256/`, `blueprints/`, `cells/<workspace>/<cell-id>/{snapshot,ltx,lease}`, `workspaces/<workspace>/files/`, `audit/<yyyy>/<mm>/<dd>/`).
- **Storage contract**: core S3 operations plus conditional writes only. A provider failing the conditional-write tests is unsupported.
- **Hostnames**: `<cell-id>.g.<domain>` for cells, `app.<domain>` for the shell UI and agent chat. One wildcard certificate via cert-manager DNS-01.
- **Identity**: OIDC at the gateway (Gateway API, Envoy Gateway as reference). The router accepts only a short-lived signed JWT identity header.
- **Capabilities**: `<provider>:<resource>:<verb>`, declared by the Blueprint, granted per instance by the user, enforced by the Gatekeeper. Tokens never enter the isolate.
- **Egress**: default-deny NetworkPolicy on runtime pods; egress only to Gatekeeper, inference gateway and the S3 endpoint.
- **Tenancy**: shared cluster with per-tenant runtime pools. Cluster-per-customer is an install of the same chart, not a separate mode.
- **Metric labels**: workspace and blueprint only; user and cell detail lives in traces, logs and audit.
- **Environments**: kind for local development and CI; the existing k3s cluster with gVisor for integration, performance measurement and demos. Runtime pods run under the gVisor RuntimeClass on k3s from Phase 0, so every latency figure includes its overhead.
- **Out of scope for v1**: the container tier (one pod per instance), the wider Cloudflare API surface, multi-region active-active cells.

---

## Phase 0: celld spike

**User stories**: Delivery phase 1; open question on celld dynamic loading.

### What to build

Run celld as a StatefulSet on the k3s cluster under gVisor, backed by Tigris. Deploy a sample gadget with a fetch handler and SQLite state. Measure cold activation, hibernation and failover, and establish whether celld can load a bundle at runtime by content hash or whether we must add that ourselves. Time-boxed to two weeks and ends in a written go/no-go on celld.

### Acceptance criteria

- [ ] Sample gadget serves requests and persists SQLite state to Tigris
- [ ] Killing the pod mid-workload loses no committed writes
- [ ] Cold activation, hibernation and failover times recorded against snapshot size, with and without gVisor
- [ ] Dynamic bundle loading answered: supported, or scoped as our work
- [ ] Go/no-go on celld written up, with the fallback if no-go

---

## Phase 1: Storage conformance suite

**User stories**: Storage contract; compatibility; open question on Tigris, MinIO and Ceph behaviour.

### What to build

A lease-and-epoch library over S3 conditional writes, and a conformance suite that exercises the full storage contract: acquire, renew, take over with a higher epoch, and reject a stale writer. The suite runs in CI against MinIO (in kind), Tigris and AWS S3.

### Acceptance criteria

- [ ] Two contenders for one lease: exactly one wins
- [ ] A writer holding a stale epoch is rejected on every write path
- [ ] Suite passes on Tigris, MinIO and AWS S3 in CI
- [ ] A provider without working conditional writes fails the suite loudly
- [ ] Provider configuration is endpoint, region, path-style flag and credentials only

---

## Phase 2: One cell end to end

**User stories**: Routing by hostname; bundle loading by digest; per-cell SQLite.

### What to build

The thinnest complete path: a request to `<cell-id>.g.<domain>` reaches the cell router, which resolves a statically configured placement and proxies to a single runtime pod. The pod fetches the gadget bundle from `bundles/sha256/` by digest, runs it as an isolate and streams SQLite changes to S3. No hibernation, no auth, one pod.

### Acceptance criteria

- [ ] A bundle uploaded by digest is served at its cell hostname
- [ ] Two cells of the same bundle keep separate state
- [ ] State survives a runtime pod restart
- [ ] WebSocket connections proxy through the router
- [ ] Runs on kind and on k3s under gVisor

---

## Phase 3: Hibernate and reactivate

**User stories**: Scale to zero; cell lifecycle.

### What to build

The cell lifecycle state machine. An idle cell snapshots to S3, releases its lease and is evicted from memory; the next request activates it from the snapshot plus page log before serving. With every cell hibernated, the pool can scale to zero replicas.

### Acceptance criteria

- [ ] A cell hibernates after a configurable idle period
- [ ] A request to a hibernated cell activates it and returns the prior state
- [ ] Concurrent requests during activation are queued, not failed or double-activated
- [ ] Activation p95 measured against the 300 ms target with the bundle cached
- [ ] A hibernated cell holds no memory and no lease

---

## Phase 4: Multi-pod placement and failover

**User stories**: Placement registry; leases and epochs; placement rules; drain.

### What to build

The placement service backed by Postgres. The router asks placement who owns a cell; placement grants a lease to a pod, preferring the pod already holding the workspace's cells and otherwise the least-loaded one. Lost pods' leases expire and their cells re-place on the next request. Draining a pod hibernates its cells and releases their leases first.

### Acceptance criteria

- [ ] Cells spread across several runtime pods and route correctly
- [ ] Killing a pod: its cells are served from another pod with no committed writes lost
- [ ] A partitioned former owner cannot write after the epoch advances
- [ ] Draining a pod hibernates its cells cleanly before termination
- [ ] The registry can be rebuilt from S3 lease objects
- [ ] Workspace affinity is observable in placement decisions

---

## Phase 5: Blueprint, RuntimePool and Workspace CRDs

**User stories**: Declarative objects; versioned gadget templates; per-team quotas.

### What to build

The three CRDs and their controllers. A RuntimePool reconciles into a runtime workload with its image, node pool, RuntimeClass and capacity. A Blueprint version pins a bundle digest, capabilities and tier, mirrored to `blueprints/`. A Workspace carries quotas and its IdP group. A control plane API creates a cell from a Blueprint in a Workspace.

### Acceptance criteria

- [ ] Applying a RuntimePool produces running runtime pods
- [ ] Applying a Blueprint makes it instantiable; a new version does not alter existing cells
- [ ] Creating two instances of one Blueprint yields two independent cells
- [ ] Workspace cell quota is enforced at creation
- [ ] Placement respects the Blueprint's tier when choosing a pool

---

## Phase 6: Identity, TLS and sharing

**User stories**: OIDC at the gateway; wildcard TLS; per-user instances; shares.

### What to build

Gateway API with OIDC against a customer IdP (Dex in kind), the wildcard certificate via cert-manager, and the signed identity header between gateway and router. Cells get an owner; the router authorises each request against ownership and share grants. Optional capability URLs give anonymous read-only access.

### Acceptance criteria

- [ ] Unauthenticated requests are redirected to the IdP
- [ ] The router rejects requests with a missing, unsigned or expired identity header
- [ ] Two users each run their own instance of one gadget and cannot open each other's
- [ ] Sharing a cell with a role grants the second user access; revoking removes it
- [ ] Wildcard certificate issues and renews on the k3s cluster
- [ ] Each cell is served from its own origin

---

## Phase 7: Autoscaling and memory pressure

**User stories**: Density; KEDA scaling; metrics.

### What to build

Per-pod caps on resident cells by memory, with least-recently-used hibernation under pressure. KEDA scales each pool on resident cells and activation queue depth. Prometheus metrics and OpenTelemetry traces for router, runtime and control plane.

### Acceptance criteria

- [ ] A pod at its memory cap hibernates its least-recently-used cell instead of failing activation
- [ ] The pool scales out under activation load and back in when idle, to zero if configured
- [ ] Metrics cover active cells, activations/s, activation p95, hibernations, S3 ops and errors, lease conflicts
- [ ] Metric labels are limited to workspace and blueprint
- [ ] A load test on k3s reports cells per pod and cells per cluster

---

## Phase 8: Gatekeeper read path

**User stories**: Capabilities, not credentials; token vault; default-deny network; audit.

### What to build

The Gatekeeper service with an encrypted per-user token vault and per-request scope enforcement. A Blueprint declares capabilities, the user grants a subset per instance, and the runtime injects one binding per grant that calls the Gatekeeper. GitHub read is the first provider. Default-deny NetworkPolicy goes onto runtime pods, and every request and decision is appended to `audit/`.

### Acceptance criteria

- [ ] A gadget with a granted `github:repo/<org>/<repo>:read` reads that repo
- [ ] The same gadget is denied a repo or verb outside its grant
- [ ] A gadget without the grant has no binding at all
- [ ] Direct outbound connections from a gadget fail
- [ ] OAuth tokens are encrypted at rest and never visible to gadget code
- [ ] Each call is in the audit log with user, gadget, cell, grant and decision

---

## Phase 9: Approval queue

**User stories**: Side-effecting calls wait for a human.

### What to build

Gatekeeper classifies calls by verb. Writes, sends and deletes are parked in an approval queue; the user sees the pending action in the shell UI, approves or rejects it, and only then does the call run. An email provider is the first side-effecting integration.

### Acceptance criteria

- [ ] A gadget drafts an email and the send waits in the queue
- [ ] Approving runs the call exactly once; rejecting never runs it
- [ ] The gadget observes the pending, approved and rejected outcomes
- [ ] Pending approvals survive a Gatekeeper restart and cell hibernation
- [ ] Audit records who approved what, and when

---

## Phase 10: Inference gateway

**User stories**: Model routing; cost per user and team; budgets.

### What to build

Deploy the inference gateway (LiteLLM or Envoy AI Gateway, chosen in this phase) with a virtual key per user and team. Gadgets reach models through an inference binding; keys stay outside the isolate. Budgets and rate limits are enforced at the gateway and usage is attributed per user and workspace.

### Acceptance criteria

- [ ] A gadget calls a model through its binding with no provider key in the isolate
- [ ] A user over budget is refused at the gateway
- [ ] Token usage is reported per user and team
- [ ] Routing to at least two backends is configurable without gadget changes
- [ ] Cell-seconds and storage per workspace are reported alongside tokens

---

## Phase 11: Agent code execution

**User stories**: Agent as a tenant; ephemeral cells.

### What to build

The agent service and the chat surface at `app.<domain>`, with session state in the workspace cell. The agent plans, writes a snippet, and asks the control plane for an ephemeral cell that runs it with the user's grants and is destroyed afterwards. Workspace markdown (skills, knowledge) is loaded into context on demand.

### Acceptance criteria

- [ ] A chat request results in code executed in an ephemeral cell and a result returned
- [ ] The ephemeral cell has exactly the user's grants, never more
- [ ] A side-effecting call from agent code goes through the approval queue
- [ ] The ephemeral cell and its state are gone after the run
- [ ] Chat history survives an agent service restart

---

## Phase 12: Agent gadget authoring

**User stories**: Agent writes gadgets; publishing is a user action.

### What to build

The agent produces a gadget bundle; the control plane stores it by digest and creates a draft Blueprint version with its declared capabilities. The user reviews the requested capabilities, publishes, and opens an instance.

### Acceptance criteria

- [ ] The agent produces a working gadget from a chat request
- [ ] The draft is not instantiable by others until the user publishes
- [ ] The user sees and grants capabilities before first use
- [ ] A revised gadget becomes a new Blueprint version; existing instances are unaffected
- [ ] Audit records who authored and who published

---

## Phase 13: Isolation hardening

**User stories**: Layered isolation; per-tenant pools; HA control plane.

### What to build

Restricted Pod Security, no ServiceAccount token and read-only root on runtime pods; gVisor required rather than merely used. Runtime pools per customer or trust tier, on separate node pools and optionally namespaces. Control plane, router, Gatekeeper and Postgres run with replicas and leader election.

### Acceptance criteria

- [ ] Runtime pods pass restricted Pod Security admission and refuse to start without the sandboxed RuntimeClass
- [ ] A cell from one tenant is never placed on another tenant's pool
- [ ] Losing any one control plane, router or Gatekeeper replica causes no failed requests beyond in-flight ones
- [ ] Postgres failover does not lose placement correctness (leases still fence)
- [ ] Workload identity is used for bucket access where available, External Secrets otherwise
- [ ] Audit objects use Object Lock where the provider supports it

---

## Phase 14: Helm chart and install

**User stories**: Runs on any conformant Kubernetes; installable in one afternoon.

### What to build

A single Helm chart for the whole platform with documented prerequisites (Gateway API, cert-manager, KEDA, CloudNativePG, an S3 bucket, an IdP), a preflight check that runs the storage conformance tests against the customer's bucket, and an install guide.

### Acceptance criteria

- [ ] Clean install on a fresh k3s cluster and on one managed cluster (EKS, GKE or AKS)
- [ ] Preflight fails clearly on a bucket without conditional writes
- [ ] Someone outside the team completes the install from the guide in one afternoon
- [ ] Upgrade from the previous chart version keeps existing cells intact
- [ ] Uninstall leaves the bucket untouched
