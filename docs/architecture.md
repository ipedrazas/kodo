# Architecture

kodo runs small per-user apps, **gadgets**, on Kubernetes. Each instance of a gadget is a **cell** with its own SQLite database, served at its own hostname, hibernated to object storage when idle and restored on the next request. Gadgets have no network and no credentials: they reach the outside world only through capabilities their owner grants, and a separate service, the Gatekeeper, makes those calls on their behalf.

This page is the map: the pieces, how a request moves between them, where state lives and where the trust boundaries are. Each section links to the document that holds the detail. Why things are this way is in [plans/](../plans/): the [solution draft](../plans/Gadgets%20on%20Kubernetes%20-%20Technical%20Solution%20Draft.md) and the [phased plan](../plans/gadgets-on-kubernetes.md), whose "Architectural decisions" section is the authoritative list.

## Goals

- **One instance per user or document**, not one multi-tenant server.
- **No ambient authority**: no network, no tokens, only granted capabilities.
- **Scale to zero**: an idle gadget costs object storage only.
- **Storage-agnostic**: any S3 provider that passes `celld diagnose`.
- **Density**: thousands of cells per cluster, not a pod each.
- **Any conformant Kubernetes** with a NetworkPolicy-enforcing network plugin.

## Components

```
                       app.<domain>, <cell>.g.<domain>
  browser ──► gateway (Envoy Gateway: TLS, OIDC login) ──────────────────────────┐
                │ /gatekeeper/          │ /chat/                                 │ x-kodo-identity
                ▼                       ▼                                        ▼
        ┌──────────────┐        ┌──────────────┐  ID token,     ┌─────────────────────────────┐
        │  Gatekeeper  │        │    Agent     │  turn token    │  Fleet: celld nodes         │
        │  kodo-system │        │  kodo-system │ ─────────────► │   kernel (Worker)           │
        │  8080 users  │        └──────────────┘                │   Cell, Workspace, Session, │
        │  8081 calls ◄├──── signed calls ───────────────────── │   Catalog, Platform, Keys   │
        │  8082 egress◄├──── HTTPS_PROXY (bucket only) ──────── │   gadgets as facets         │
        └─┬───┬───┬──┬─┘                                        └──────────────┬──────────────┘
          │   │   │  └─► inference gateway (Envoy AI Gateway) ─► OpenRouter, simulator
          │   │   └────► GitHub, Resend, public web APIs                       │
          │   └────────► Gatekeeper bucket: vault/ approvals/ audit/           ▼
          └────────────► OpenBao transit                       Fleet bucket: cells, bundles, kernel

  operator (kodo-system) ── reconciles Fleet, Blueprint, Workspace; reaches kernels via the API server proxy
```

| Component | Runs as | Role | Detail |
| --- | --- | --- | --- |
| **celld** | StatefulSet per fleet | Upstream runtime for Workers and Durable Objects. Owns cell placement, single-writer ownership, hibernation, failover, rebalancing and eviction across nodes sharing one bucket. kodo configures it; it does not reimplement it. | [celld](https://github.com/denoland/celld), [spike](../spike/celld/README.md) |
| **Kernel** | The one Worker every fleet runs (TypeScript) | Routes by hostname, verifies identity, authorises owners, shares and members, loads gadget bundles by digest and runs each as an isolated facet of its cell. Serves the API, the home, settings and admin pages. Keeps the agent's sessions and runs its code. | [kernel/README.md](../kernel/README.md) |
| **Gadget** | A facet inside a `Cell` Durable Object | A JavaScript module exporting `App`. Gets HTTP, its own SQLite, alarms, WebSockets, one binding per granted capability, and approval outcomes. | [kernel/GADGETS.md](../kernel/GADGETS.md) |
| **Operator** | Deployment, `kodo-system` (Go) | Reconciles `Fleet`, `Blueprint` and `Workspace` (`kodo.dev/v1alpha1`) into nodes, Services, NetworkPolicies, kernel deploy Jobs, catalog entries and workspaces. Pushes a cluster report to each kernel every minute. | [config/README.md](../config/README.md) |
| **Gatekeeper** | Deployment, `kodo-system` (Go), stateless | The only path from a fleet to the outside. Verifies a fleet's signed call, checks the grant, holds users' tokens as OpenBao ciphertext, makes reads, queues writes/sends/deletes for approval, sends model calls to the inference gateway, writes the audit log, and is the fleet's egress proxy. | [config/README.md#gatekeeper](../config/README.md#gatekeeper) |
| **Inference gateway** | Envoy AI Gateway, `kodo-inference` | Maps model names to backends, holds their keys, rate-limits per user. Admits only the Gatekeeper. | [deploy/inference](../deploy/inference/README.md) |
| **Agent** | Deployment, `kodo-system` (Go), stateless | The chat at `app.<domain>/chat/`. Thinks with a model, answers by running JavaScript in ephemeral cells, and writes gadgets as draft Blueprints. Has no authority of its own: it acts with a per-turn token. | [kernel/AGENT.md](../kernel/AGENT.md), [internal/agent](../internal/agent) |
| **`kodo` CLI** | Developer tool (Go) | `kodo publish` bundles a celld Durable Object class as a gadget and publishes it. | [GADGETS.md#from-a-celld-project](../kernel/GADGETS.md#from-a-celld-project) |
| **Platform services** | Cluster prerequisites | Envoy Gateway (ingress and OIDC), cert-manager (wildcard certificate via DNS-01), an OIDC provider (Dex on k3s), OpenBao, Redis (rate-limit counters), gVisor. | [dependencies.md](dependencies.md) |

### Vocabulary

| Term | Meaning |
| --- | --- |
| **Fleet** | A set of celld nodes sharing one bucket and running the kernel. The unit of isolation between tenants. |
| **Blueprint** | A versioned gadget: a bundle digest plus the capabilities it may ask for. Versions are draft, published or withdrawn. |
| **Workspace** | A group of cells and chats under a quota, with members (viewer, member, admin) and markdown docs. |
| **Cell** | One instance of a Blueprint version, owned by one user, optionally shared as viewer or editor. Hostname `<cell-id>.g.<domain>`. |
| **Capability** | `<provider>:<resource>:<verb>`, e.g. `github:repo/acme/api:read`. Declared by a Blueprint (with `*` for one segment), granted concretely per cell by its owner. |
| **Session** | A chat with the agent: transcript, grants, the turn in progress. |
| **Ephemeral cell** | A cell created for one run of the agent's code, never served, deleted when the run ends. |

## Request paths

### A user opens a cell

1. The browser asks for `<cell-id>.g.<domain>`. Envoy Gateway terminates TLS and, without a session, sends the user to the IdP. After login it sets a session cookie on the parent domain, so one login covers the app and every cell.
2. The gateway forwards the request to the fleet's Service with the user's ID token in `x-kodo-identity`.
3. celld routes the request to the node that owns the cell, restoring it from the bucket if it was hibernated.
4. The kernel drops any client-sent `x-kodo-*` header, verifies the ID token against the IdP's keys, checks the caller is the owner or has a share, refuses cross-origin writes and WebSockets, strips the token and session cookies, and passes the request to the gadget facet.
5. The gadget answers from its own database. The cell counts the request for usage.

### A gadget calls an external service

1. The gadget calls `this.grants["github:repo/acme/api:read"].fetch(...)`. Only granted capabilities have a binding.
2. The kernel signs the call with the fleet's Gatekeeper key and asserts the cell, workspace, Blueprint version, owner and grants.
3. The Gatekeeper checks the signature against its trusted fleets, checks the capability is granted, records the decision in `audit/` (no record, no call), decrypts the owner's token through OpenBao transit, and makes the call.
4. The answer goes back to the gadget. The token never enters the fleet.

Providers: `github` (user token), `email` (user's Resend key), `web` (public HTTPS APIs on an allowlist, no credentials, public addresses only), `inference` (platform models).

### A call that needs approval

Verbs `write`, `send` and `delete` do not run straight away. The Gatekeeper stores them as `approvals/<user>/<id>.json` in state `pending` and answers `202` with `x-kodo-approval`. The owner approves or rejects at `app.<domain>/gatekeeper/`. Every state change is a write conditional on the object's ETag, so exactly one Gatekeeper replica moves an approval to `executing` and makes the call, at most once. Meanwhile the cell polls `POST /v1/approvals/query` on its alarm (2 s, doubling to once a minute) and calls the gadget's `onApproval` with `done`, `failed`, `rejected` or `expired`. An approval left `executing` by a dead replica is reported `failed` after a minute and never retried.

### A model call

1. Before the call the kernel asks the fleet's `Platform` object whether the owner and the workspace have token budget left; if not, the gadget gets 429 and nothing leaves the fleet.
2. The Gatekeeper checks the grant `inference:model/<name>:invoke`, allowlists the request body, sets `model`, and sends it to the inference gateway with its key and `x-kodo-user`, `x-kodo-workspace`, `x-kodo-blueprint`.
3. The gateway rate-limits per user (Redis), picks the backend for that model name and calls it with the platform's key.
4. Usage comes back: the Gatekeeper records it as `metered`, and the kernel adds the tokens to the cell's usage and the budgets.

Changing which backend serves a model is a change to `deploy/inference/models.yaml`; no gadget or grant changes.

### An agent turn

1. The user sends a message at `/chat/`. The gateway forwards it to the agent with the ID token.
2. The agent starts a turn on the kernel with that token. The kernel appends the message and returns a **turn token** that reaches only this session, for at most 5 minutes, plus the agent's current settings (model, output limit, steps).
3. The agent drops the ID token and, for the rest of the turn, calls the model through the session (`/complete`), runs code (`/runs`) and writes drafts (`/drafts`) with the turn token.
4. A run is an ephemeral cell that loads the one SES-locked runner bundle, gets exactly the session's grants, evaluates the code in its own Compartment and is deleted. Limits: 60 s, 2 s CPU, 20 calls, no ArrayBuffers.
5. A draft is stored by digest as the next version of a Blueprint name owned by the session's owner, audited, and checked once in an ephemeral cell. Publishing it is the author's act through their own login; a turn token cannot.

### Delivering the kernel and Blueprints

The kernel ships as an image containing celld, esbuild and the kernel source. For each new `Fleet.spec.kernel` the operator runs a Job that deploys it into the fleet's bucket; nodes pick up the new kernel within one pointer poll (30 s) with no restart. Blueprints are applied by the operator through the kernel API (`POST /api/bundles`, `PUT /api/blueprints/:name/:version`), reached via the Kubernetes API server's service proxy with the fleet's admin token. Deleting a `Blueprint` resource withdraws the version.

## State

There is no database. Object storage is the system of record; node disks are caches.

| State | Lives in | Written by | Notes |
| --- | --- | --- | --- |
| Cells' SQLite, Durable Object state, kernel code | Fleet bucket (layout owned by celld) | celld | Survives deleting the Fleet; a new Fleet on the same bucket finds every cell |
| Gadget bundles | Fleet bucket, `r2/bundles/sha256/<digest>.js` | Kernel | Content-addressed; a cell checks the digest before running |
| Blueprint catalog, workspaces, members | `Catalog` and `Workspace` Durable Objects | Kernel | Cells never go in etcd |
| Platform settings, budgets, spend, users, suspensions, cluster report | `Platform` Durable Object (one per fleet) | Kernel, operator report | |
| Agent transcripts | `Session` Durable Objects | Kernel | |
| Users' tokens | Gatekeeper bucket, `vault/<user>/<provider>.json` | Gatekeeper | OpenBao transit ciphertext with a derived key bound to user and provider |
| Approvals | Gatekeeper bucket, `approvals/<user>/<id>.json` | Gatekeeper | ETag-conditional state changes |
| Audit log | Gatekeeper bucket, `audit/<yyyy>/<mm>/<dd>/<time>-<id>.json` | Gatekeeper | One object per decision, conditional create; searchable from `/admin/` |
| Fleets, Blueprints, Workspaces (declared) | Kubernetes CRDs | GitOps | Few and declarative |
| Model routes, backends, rate limits | Envoy AI Gateway resources | GitOps | Shown read-only on `/admin/` |
| Rate-limit counters | Redis in `envoy-gateway-system` | Envoy | Append-only, on a volume |
| Admin token, Gatekeeper fleet keys | Secrets `<fleet>-admin-token`, `<fleet>-gatekeeper-key`, `kodo-gatekeeper-fleets` | Operator | Created once |

The fleet's and the Gatekeeper's buckets have separately scoped credentials: a fleet cannot read `vault/`, `approvals/` or `audit/`.

## Trust boundaries

### Identity and credentials

| Credential | Held by | Grants | Lifetime |
| --- | --- | --- | --- |
| OIDC ID token (`x-kodo-identity`) | Gateway session, forwarded per request | Acting as the user on the API and their cells | IdP expiry; stripped before a gadget sees it |
| Admin token (`x-kodo-admin-token`) | Operator, Secret `<fleet>-admin-token` | Everything a platform admin can do, plus the cluster report | Until rotated; the kernel holds only its SHA-256 |
| Turn token (`x-kodo-turn`) | Agent | One session's own routes and its workspace's docs | Until the turn ends, at most 5 min |
| Fleet Gatekeeper key | Kernel (baked in at deploy), Gatekeeper trust Secret | Signing capability calls and events as that fleet | Until the Fleet is deleted |
| Cell identity key | `Keys` Durable Object | Signing each cell's identity for its gadget | |
| Inference gateway key | Gatekeeper, Secret `kodo-gatekeeper-inference` | Calling the inference gateway | |
| OpenBao AppRole | Gatekeeper, Secret `kodo-gatekeeper-openbao` | `encrypt` and `decrypt` on one transit key | `secret_id` never expires; rotate with `setup.sh --rotate` |
| Users' third-party tokens | OpenBao ciphertext in the Gatekeeper bucket | Calls to GitHub, Resend, … | Until the user disconnects |

Roles (platform admin, workspace admin, member, viewer, cell owner/editor/viewer) are in [kernel/README.md#roles](../kernel/README.md#roles). Every action a person takes as an admin is audited before it takes effect.

### Isolation

- **Gadget from gadget**: separate V8 isolates in a process shared by the fleet. celld claims nothing stronger.
- **Fleet from host**: gVisor `RuntimeClass` on fleet pods (k3s), restricted security context.
- **Tenant from tenant**: a fleet each, with its own bucket credentials. (Phase 13 makes this the enforced model.)
- **Agent run from agent run**: one shared isolate per node, locked down by SES, a fresh Compartment per run, no typed arrays.

### Network

- Fleet nodes: default-deny egress. Allowed: DNS, their own fleet, the Gatekeeper on 8081 (calls) and 8082 (egress proxy), and explicit extras (the IdP's keys). The bucket is reached through the egress proxy when its addresses are not fixed (Tigris).
- celld's internal listener (8081, peer protocol and an unauthenticated operator API) accepts only the fleet's own nodes.
- The Gatekeeper's 8081 and 8082 accept only fleet nodes; 8080 is behind the gateway.
- The inference gateway admits only Gatekeeper pods and requires the Gatekeeper's key.
- Fleet pods cannot reach the Kubernetes API; the operator pushes what the dashboard needs.

## Change and failure

| Event | What happens |
| --- | --- |
| New kernel image | Operator runs a deploy Job; nodes adopt it in place within 30 s, no failed requests. Active Durable Objects may run old code for about 30 s more. |
| New celld version | Mixed versions cannot share a fleet: the operator scales to zero, waits, starts the new image. The fleet serves nothing for about 20–40 s. `Upgrading` is true until done. |
| Node stops | Keeps serving for 5 s, then up to 60 s for celld's handoff. Its cells move to other nodes. |
| Node lost | Leases expire; the next request restores each cell elsewhere from the bucket. No committed write is lost. |
| Gatekeeper replica dies | Stateless; another replica serves. An approval it was executing becomes `failed` after a minute. |
| Bucket unreachable | Writes stall; nodes that cannot renew leases self-fence and restart. |
| Fleet deleted | Pods, Services, Jobs and volumes go; the bucket is untouched. |

Operating procedures for all of these are in the [runbook](runbook.md).

## Known limits

From celld 0.6.x, tracked in the [plan](../plans/gadgets-on-kubernetes.md) and [upstream report](../spike/celld/upstream/celld-0.6.0-report.md):

- Each distinct bundle costs about 7 MiB per node and is not released, which bounds distinct gadgets per fleet by node memory.
- ArrayBuffer memory is outside the 128 MiB isolate heap limit. Agent runs have no typed arrays; gadgets still do.
- At most 64 in-flight requests per cell.
- After thousands of WebSocket opens on a node, some upgrades never complete.
- A live session whose followers self-fenced can leave a cell failing to restore (`RestoreFailed`) until the leader pod restarts.
- Fleet nodes need low fsync latency; write latency follows the disk.

Not built yet: autoscaling and metrics (Phase 6, waiting on upstream), tenancy hardening (Phase 13), a Helm chart (Phase 14).
