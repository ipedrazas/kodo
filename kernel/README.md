# Kernel

The application every kodo fleet runs. It serves each cell at `<cell-id>.g.<domain>`, runs the cell's gadget in isolation, and keeps the registries of Blueprints and workspaces behind an API. It also keeps the agent's sessions and runs the agent's code. How to write a gadget is in [GADGETS.md](GADGETS.md); what the agent's code can do is in [AGENT.md](AGENT.md).

## How it fits together

| Durable Object | One per | Holds |
| --- | --- | --- |
| `Cell` | gadget instance | Its binding (workspace, Blueprint version), sockets, the gadget's alarm, the approvals it waits on, and its usage by month; the gadget runs inside it as a facet with its own database |
| `Workspace` | workspace | Quota, the list of cells and of sessions with the agent, and the workspace's markdown docs |
| `Session` | chat with the agent | Its transcript, its grants, the turn in progress, the approvals its runs wait on, and its usage |
| `Catalog` | fleet | Every published Blueprint version |
| `Keys` | fleet | The key that signs each cell's identity for its gadget |

A gadget reaches the outside world only through its grants. `GadgetHost.call` signs each call with the fleet's Gatekeeper key and sends the Gatekeeper the cell, its workspace, Blueprint version, owner and grants with the gadget's request; the Gatekeeper decides, holds the tokens and makes the call. A model call comes back with what it used, which the cell counts; the gadget sees only the response. A call the Gatekeeper parks for approval comes back as `202 pending`; the cell then asks `POST /v1/approvals/query` about it on its alarm (after 2 s, doubling to once a minute), which it shares with the gadget's alarm, and calls the gadget's `onApproval` when it settles.

A session runs the agent's code in an **ephemeral cell**: a new cell, never served by hostname, that loads the one runner bundle (SES locks its isolate down, and each run gets a Compartment of its own), gets exactly the session's grants, runs the code once and is deleted. Its calls go to the Gatekeeper like a gadget's, as Blueprint `agent`, version `<session id>`; the session counts their tokens and follows the approvals they queue, since the cell is gone by then. See [AGENT.md](AGENT.md).

A cell serves only while its workspace has bound it; a hostname for any other cell is a 404. Gadget bundles are stored by SHA-256 through the `BUNDLES` R2 binding (`r2/bundles/sha256/<digest>.js` in the fleet bucket), and a cell checks the digest before it runs one.

## API

Served under `/api/` on any host that is not a cell hostname. Every request, to the API or a cell, must carry one of:

- **An OIDC ID token** in `x-kodo-identity`, which the gateway forwards after the user logs in. The kernel checks its signature against the issuer's keys, and its issuer, audience and expiry.
- **The admin token** in `x-kodo-admin-token`, which the operator uses. The kernel holds only its SHA-256.
- **A turn token** in `x-kodo-turn`, which the kernel issues to the agent when a session's owner starts a turn. It is signed with the fleet's kernel key, names one session and turn, and works only for that session's own routes (not its grants, not starting turns) and its workspace's docs, until the turn ends or after 5 minutes. It never reaches a cell.

Anything else is a 401. The router drops every `x-kodo-*` header a client sends before setting its own, and refuses writes and WebSockets whose `Origin` is another host. The identity settings are baked in at deploy time by `scripts/deploy.sh` (from `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL` and `KERNEL_ADMIN_TOKEN`), as are the Gatekeeper's (`GATEKEEPER_URL`, `GATEKEEPER_KEY`, `FLEET_ID`, which the operator sets from `Fleet.spec.gatekeeper`); Worker variables override them in local development.

Uploading bundles, publishing and configuring workspaces need the admin token. Any user may create cells in a workspace, owns what they create, and sees and manages only their own cells and those shared with them. The admin token acts as every cell's owner, and must name an `owner` when it creates a cell.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/version` | | `{build}`, the kernel image's build identifier |
| POST | `/api/bundles` | gadget source | 201 `{digest}` |
| GET | `/api/blueprints` | | `{blueprints: [name]}`: the names with a published version, and the caller's drafts |
| GET | `/api/blueprints/:name` | | `{name, versions: [...]}`, each with `status` (`draft` or `published`) and, for the agent's, `author`, `session`, `workspace` and `publishedBy` |
| PUT | `/api/blueprints/:name/:version` | `{bundle, capabilities?, tier?}` | 201, or 409 if already published |
| POST | `/api/blueprints/:name/:version/publish` | | Publishes a draft the agent wrote: its author only (or the admin token), never a turn token. Recorded in the Gatekeeper's audit log first; a 503 if it cannot be, and the draft stays a draft |
| PUT | `/api/workspaces/:ws` | `{quota?}` (default 100) | Creates or updates the workspace |
| GET | `/api/workspaces/:ws` | | `{name, quota, cells}` |
| GET | `/api/workspaces/:ws/usage[?month=YYYY-MM]` | | Usage in a month (default this one, UTC): `{workspace, month, totals, owners, cells}`. Each has `requests` (HTTP requests and WebSocket messages that reached the gadget, written a few seconds after use, so a cell that stops in that time loses a few), `storageBytes` (the gadget's database, as last measured) and `inference` (model calls and input, output and total tokens; per granted model for a cell); totals and owners add `cells`, `activeCells` and `sessions`. Sessions with the agent are rows too, with `kind: "session"` and Blueprint `agent`: their turns and runs as requests, and the tokens of their model calls and their runs'. The admin token sees every cell and session; a user sees the ones they own. |
| GET | `/api/workspaces/:ws/cells` | | `{cells: [...]}` |
| POST | `/api/workspaces/:ws/cells` | `{blueprint, version?}` (default: the latest published, or for its author the latest draft of a name with none published) | 201 `{id, blueprint, version, owner, shares, createdAt}`, or 409 over quota. A draft only for its author |
| GET | `/api/workspaces/:ws/cells/:id` | | The cell |
| PATCH | `/api/workspaces/:ws/cells/:id` | `{version}` | Moves the cell to another version of its Blueprint |
| DELETE | `/api/workspaces/:ws/cells/:id` | | 204; deletes the gadget's storage |
| GET | `/api/workspaces/:ws/cells/:id/shares` | | `{shares: {email: role}}` |
| PUT | `/api/workspaces/:ws/cells/:id/shares/:email` | `{role}`: `viewer` or `editor` | Shares the cell, or changes the role |
| DELETE | `/api/workspaces/:ws/cells/:id/shares/:email` | | Revokes access |
| GET | `/api/workspaces/:ws/cells/:id/grants` | | `{grants: [capability]}` |
| PUT | `/api/workspaces/:ws/cells/:id/grants` | `{grants: [capability]}` | Replaces the cell's grants; each must be concrete and covered by one its Blueprint version declares. The gadget restarts with the new bindings. |
| GET | `/api/whoami` | | The verified caller |
| GET | `/api/workspaces/:ws/docs` | | `{docs: [{path, description, bytes, updatedAt}]}`; the description is the front matter's `description:`, else the first heading or line |
| GET | `/api/workspaces/:ws/docs/:path` | | The document, as markdown |
| PUT | `/api/workspaces/:ws/docs/:path` | markdown (at most 256 KiB) | Creates or replaces it (admin token). Paths are lowercase segments ending in `.md`, e.g. `skills/email.md` |
| DELETE | `/api/workspaces/:ws/docs/:path` | | 204 (admin token) |
| GET | `/api/workspaces/:ws/sessions` | | `{sessions: [...]}`, the caller's |
| POST | `/api/workspaces/:ws/sessions` | `{title?, grants?}` | 201, the session; at most 50 per owner per workspace |
| GET | `/api/workspaces/:ws/sessions/:id[?after=N]` | | `{id, workspace, title, owner, createdAt, grants, turn, pending, messages}`: the messages after number N, the turn in progress if any, and the approvals its runs wait on |
| DELETE | `/api/workspaces/:ws/sessions/:id` | | 204; deletes the transcript |
| PUT | `/api/workspaces/:ws/sessions/:id/grants` | `{grants: [capability]}` | Replaces the session's grants: concrete capabilities, any provider. Not with a turn token |
| POST | `/api/workspaces/:ws/sessions/:id/turns` | `{content}` | 201 `{turn: {id, token, startedAt, expiresAt}, session}`: appends the owner's message and starts a turn, or 409 while one is in progress. Not with a turn token |
| DELETE | `/api/workspaces/:ws/sessions/:id/turns/:turn` | | 204; ends the turn (its token, or the owner) |
| POST | `/api/workspaces/:ws/sessions/:id/messages` | `{role, content, tool_calls?, tool_call_id?, name?, run?}` | Appends the agent's message: `user`, `assistant` (with chat completion `tool_calls`) or `tool`. Only with the turn token. The kernel writes `event`s itself: an approval settled, a turn that ran out of time |
| POST | `/api/workspaces/:ws/sessions/:id/complete` | `{model, request}` | Calls `inference:model/<model>:invoke` with the chat completion `request`, if the session holds that grant, as the session; answers with the model's status and body |
| POST | `/api/workspaces/:ws/sessions/:id/runs` | `{code, input?}` | Runs the code in an ephemeral cell: `{id, ok, value, error, logs, approvals, calls, ms}` |
| POST | `/api/workspaces/:ws/sessions/:id/drafts` | `{name, source, capabilities?, checks?}` | 201 `{blueprint, check}`: stores a gadget the agent wrote as the next draft version (1, 2, ...) of `name` for the session's owner, records that they authored it in the Gatekeeper's audit log, and loads it once in an ephemeral cell; `check` is what `GET /` answered, then each of up to five `checks` (`{method, path, body?}`, against the same database), and `ok` unless one failed or answered 5xx. A name with versions by anyone else is a 409. At most 20 per session and 96 KiB each |
| GET | `/api/runs/:id` | | `{bound, keys}`: what is left of a run's cell; nothing, once it has run (admin token) |

Owner, editor and viewer: the owner may do anything, including sharing, moving and deleting the cell; an editor may use it fully; a viewer may only read it (GET and HEAD, no WebSockets). Shares are keyed by the email in the caller's ID token.

Names are one lowercase DNS label. Versions are letters, digits, `.`, `+` and `-`. Capabilities are `<provider>:<resource>:<verb>`; a Blueprint may declare them with `*` for one resource segment, and only the cell's owner grants concrete ones. Moving a cell to a version that does not declare a grant drops it. Errors are `{"error": "..."}`.

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

The tests start `celld dev` on a temporary copy of the project and drive it through the API. `kernel.test.mjs` covers how gadgets run; `api.test.mjs` covers the registries and runs `examples/notes.js` against the gadget contract; `identity.test.mjs` covers identity, sharing and origins; `capabilities.test.mjs` covers grants and signed calls; `approvals.test.mjs` covers calls that wait for approval, across hibernation; `inference.test.mjs` runs [`examples/ask`](../examples/ask) against model grants and checks the usage report; `agent.test.mjs` covers sessions, turn tokens, model calls as a session, and runs: their grants, isolation, limits, cleanup and approvals; `example.test.mjs` runs [`examples/repo-viewer`](../examples/repo-viewer), `mailer.test.mjs` [`examples/mailer`](../examples/mailer), `daybreak.test.mjs` [`examples/daybreak`](../examples/daybreak) and `hn-reader.test.mjs` [`examples/hn-reader`](../examples/hn-reader). The harness plays the identity provider: it serves a JWKS and mints tokens for test users. It can also play the Gatekeeper: it checks each call's signature, answers with canned responses, and answers approval queries from a map the test controls.
