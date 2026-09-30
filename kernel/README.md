# Kernel

The application every kodo fleet runs. It serves each cell at `<cell-id>.g.<domain>`, runs the cell's gadget in isolation, and keeps the registries of Blueprints and workspaces behind an API. How to write a gadget is in [GADGETS.md](GADGETS.md).

## How it fits together

| Durable Object | One per | Holds |
| --- | --- | --- |
| `Cell` | gadget instance | Its binding (workspace, Blueprint version), sockets and alarm; the gadget runs inside it as a facet with its own database |
| `Workspace` | workspace | Quota and the list of cells; creates, moves and deletes them |
| `Catalog` | fleet | Every published Blueprint version |
| `Keys` | fleet | The key that signs each cell's identity for its gadget |

A cell serves only while its workspace has bound it; a hostname for any other cell is a 404. Gadget bundles are stored by SHA-256 through the `BUNDLES` R2 binding (`r2/bundles/sha256/<digest>.js` in the fleet bucket), and a cell checks the digest before it runs one.

## API

Served under `/api/` on any host that is not a cell hostname. Every request, to the API or a cell, must carry one of:

- **An OIDC ID token** in `x-kodo-identity`, which the gateway forwards after the user logs in. The kernel checks its signature against the issuer's keys, and its issuer, audience and expiry.
- **The admin token** in `x-kodo-admin-token`, which the operator uses. The kernel holds only its SHA-256.

Anything else is a 401. The router drops every `x-kodo-*` header a client sends before setting its own, and refuses writes and WebSockets whose `Origin` is another host. The identity settings are baked in at deploy time by `scripts/deploy.sh` (from `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` and `KERNEL_ADMIN_TOKEN`); Worker variables override them in local development.

Uploading bundles, publishing and configuring workspaces need the admin token. Any user may create cells in a workspace, owns what they create, and sees and manages only their own cells and those shared with them. The admin token acts as every cell's owner, and must name an `owner` when it creates a cell.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/version` | | `{build}`, the kernel image's build identifier |
| POST | `/api/bundles` | gadget source | 201 `{digest}` |
| GET | `/api/blueprints` | | `{blueprints: [name]}` |
| GET | `/api/blueprints/:name` | | `{name, versions: [...]}` |
| PUT | `/api/blueprints/:name/:version` | `{bundle, capabilities?, tier?}` | 201, or 409 if already published |
| PUT | `/api/workspaces/:ws` | `{quota?}` (default 100) | Creates or updates the workspace |
| GET | `/api/workspaces/:ws` | | `{name, quota, cells}` |
| GET | `/api/workspaces/:ws/cells` | | `{cells: [...]}` |
| POST | `/api/workspaces/:ws/cells` | `{blueprint, version?}` (default: latest) | 201 `{id, blueprint, version, owner, shares, createdAt}`, or 409 over quota |
| GET | `/api/workspaces/:ws/cells/:id` | | The cell |
| PATCH | `/api/workspaces/:ws/cells/:id` | `{version}` | Moves the cell to another version of its Blueprint |
| DELETE | `/api/workspaces/:ws/cells/:id` | | 204; deletes the gadget's storage |
| GET | `/api/workspaces/:ws/cells/:id/shares` | | `{shares: {email: role}}` |
| PUT | `/api/workspaces/:ws/cells/:id/shares/:email` | `{role}`: `viewer` or `editor` | Shares the cell, or changes the role |
| DELETE | `/api/workspaces/:ws/cells/:id/shares/:email` | | Revokes access |
| GET | `/api/whoami` | | The verified caller |

Owner, editor and viewer: the owner may do anything, including sharing, moving and deleting the cell; an editor may use it fully; a viewer may only read it (GET and HEAD, no WebSockets). Shares are keyed by the email in the caller's ID token.

Names are one lowercase DNS label. Versions are letters, digits, `.`, `+` and `-`. Capabilities are `<provider>:<resource>:<verb>`; they are recorded now and enforced from Phase 7. Errors are `{"error": "..."}`.

On a fleet, `task api` calls the API from a pod in the cluster:

```sh
task api TARGET=k3s METHOD=POST ROUTE=/bundles BODY=@kernel/examples/notes.js
task api TARGET=k3s METHOD=PUT ROUTE=/blueprints/notes/1.0.0 BODY='{"bundle":"<digest>"}'
task api TARGET=k3s METHOD=PUT ROUTE=/workspaces/team BODY='{"quota":10}'
task api TARGET=k3s METHOD=POST ROUTE=/workspaces/team/cells BODY='{"blueprint":"notes"}'
```

## Develop and test

```sh
task kernel:check                # typecheck, then the tests under celld dev
task kernel:up TARGET=kind       # kind cluster, fleet, kernel, smoke test
task kernel:up TARGET=k3s        # the same on the k3s cluster under gVisor
```

The tests start `celld dev` on a temporary copy of the project and drive it through the API. `kernel.test.mjs` covers how gadgets run; `api.test.mjs` covers the registries and runs `examples/notes.js` against the gadget contract; `identity.test.mjs` covers identity, sharing and origins. The harness plays the identity provider: it serves a JWKS and mints tokens for test users.
