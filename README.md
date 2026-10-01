# kodo

Gadgets on Kubernetes: small, per-user apps ("gadgets") that run as isolated instances in a shared runtime, on your own cluster. Every user or document gets its own instance, a **cell**, with its own SQLite database; cells hibernate to an S3 bucket when idle and wake on the next request. Gadgets have no network: they reach external services only through capabilities their owner grants, and a separate Gatekeeper makes those calls with tokens the gadget never sees.

kodo runs on [celld](https://github.com/denoland/celld), a self-hosted runtime for Workers and Durable Objects. celld provides cell ownership, placement, hibernation and failover across a fleet of nodes that share a bucket; kodo adds the kernel, the operator and the Gatekeeper.

The design is in [plans/](plans/): the [technical solution draft](plans/Gadgets%20on%20Kubernetes%20-%20Technical%20Solution%20Draft.md) and the [phased plan](plans/gadgets-on-kubernetes.md), with what each phase built and measured.

## How it fits together

```
                 app.<domain>, <cell>.g.<domain>
browser ──► gateway (OIDC login, TLS) ─────────────────────────┐
                 │ /gatekeeper/                                │ ID token in x-kodo-identity
                 ▼                                             ▼
        ┌─────────────────┐   signed calls (8081)   ┌──────────────────────────┐
        │   Gatekeeper    │ ◄────────────────────── │  fleet: celld nodes      │
        │   kodo-system   │   egress proxy (8082)   │  ┌────────────────────┐  │
        │                 │ ◄────────────────────── │  │ kernel (Worker)    │  │
        └──┬─────┬─────┬──┘                         │  │  cells ─ gadgets   │  │
           │     │     │                            │  └────────────────────┘  │
     OpenBao  bucket  GitHub, …                     └──────────┬───────────────┘
     transit  vault/                                           │
              audit/                                    fleet bucket (cells,
                                                        bundles, kernel)
```

| Piece | What it does | Where |
| --- | --- | --- |
| **Fleet** | A set of celld nodes sharing one bucket and running the kernel. Default-deny egress. | `Fleet` resource |
| **Kernel** | The one Worker every fleet runs: routes requests by hostname, verifies identity, authorises owners and shares, loads gadget bundles by digest, and runs each cell's gadget as an isolated facet. Serves the API at `app.<domain>/api/`. | [kernel/](kernel/README.md) |
| **Gadget** | A JavaScript module exporting `App`. Gets HTTP requests, its own database, alarms, WebSocket messages, and one binding per granted capability. | [kernel/GADGETS.md](kernel/GADGETS.md) |
| **Operator** | Reconciles `Fleet`, `Blueprint` and `Workspace` resources: nodes, Services, NetworkPolicies, kernel deploys, the catalog and workspaces. | [config/](config/README.md) |
| **Gatekeeper** | Stateless service outside every fleet. Holds users' tokens as OpenBao transit ciphertext, makes the calls grants allow, records every decision in `audit/`, and is the fleets' egress proxy. | [cmd/gatekeeper](cmd/gatekeeper/main.go), [config/README.md](config/README.md#gatekeeper) |

The words: a **Blueprint** is a versioned gadget (a bundle plus the capabilities it may ask for); a **Workspace** holds cells under a quota; a **cell** is one instance of a Blueprint version, owned by a user and optionally shared as viewer or editor; a **capability** is `<provider>:<resource>:<verb>`, e.g. `github:repo/acme/api:read`, declared by a Blueprint and granted per cell by its owner.

## Write a gadget

```js
import { Gadget } from "kodo";

export class App extends Gadget {
  async fetch(request) {
    const repo = this.grants["github:repo/acme/api:read"];
    if (!repo) return new Response("ask the owner to grant github:repo/acme/api:read", { status: 403 });
    return repo.fetch("/readme", { headers: { accept: "application/vnd.github.raw+json" } });
  }
}
```

The contract is [kernel/GADGETS.md](kernel/GADGETS.md). Two examples: [kernel/examples/notes.js](kernel/examples/notes.js) uses storage, WebSockets and alarms; [examples/repo-viewer](examples/repo-viewer/README.md) reads GitHub through a grant, with a step-by-step deploy guide.

## Run it

You need [Task](https://taskfile.dev), Go, Node 24, [celld](https://github.com/denoland/celld) and esbuild on `PATH`, and kubectl. Kubernetes clusters need a network plugin that enforces NetworkPolicy.

```sh
task kernel:check                 # kernel typecheck and tests under celld dev
task ci                           # Go: tidy, generated files, lint, tests, build
task kernel:up TARGET=kind        # a kind cluster with SeaweedFS, a fleet, the kernel, a smoke test
task operator:e2e:kind            # the operator end to end on kind
```

The integration environment is hiddenfield.dev on a k3s cluster with gVisor, Tigris, Dex, Envoy Gateway and OpenBao; see [deploy/k3s](deploy/k3s/README.md):

```sh
task openbao:setup                # once, as an OpenBao admin: deploy/openbao/README.md
task k3s:up KERNEL_IMAGE=... OPERATOR_IMAGE=... GATEKEEPER_IMAGE=...
task k3s:identity-test            # identity, TLS and sharing
task k3s:gatekeeper-test          # grants, the Gatekeeper, egress, vault and audit
```

Images are built by CI for amd64 and arm64: `ghcr.io/ipedrazas/kodo-{kernel,operator,gatekeeper}`, tagged `main` and `sha-<commit>` from main and `pr-<number>` from pull requests.

## Repository

| Path | What |
| --- | --- |
| `api/v1alpha1` | The `kodo.dev/v1alpha1` CRD types |
| `cmd/operator`, `internal/controller` | The operator |
| `cmd/gatekeeper`, `internal/gatekeeper` | The Gatekeeper: calls, GitHub provider, token vault, audit, egress proxy |
| `internal/vault` | The vault interface and its OpenBao transit implementation |
| `kernel/` | The kernel Worker, its tests and the gadget contract |
| `examples/` | Example gadgets with their Blueprints |
| `config/` | CRDs, RBAC, the operator and the Gatekeeper base manifests |
| `deploy/` | Environments: kind and k3s fleets, hiddenfield.dev, OpenBao setup |
| `images/` | Dockerfiles for the kernel, operator and Gatekeeper images |
| `test/e2e` | End-to-end tests on kind and k3s |
| `spike/celld` | The Phase 0 and 1 celld spike and its results |
| `plans/` | The solution draft and the phased plan |

## Status

Phases 0 to 5 are done: celld spike, kernel, Blueprints and workspaces, operator, identity and sharing. Phase 7 (the Gatekeeper read path) is in progress; Phase 6 (autoscaling and observability) has not started. The [plan](plans/gadgets-on-kubernetes.md) has the details and what comes next: approvals, the inference gateway and the agent.

## License

[MIT](LICENSE)
