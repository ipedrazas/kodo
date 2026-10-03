# Kernel

The application every kodo fleet runs. It serves each cell at `<cell-id>.g.<domain>`, runs the cell's gadget in isolation, and keeps the registries of Blueprints and workspaces behind an API. It also keeps the agent's sessions and runs the agent's code. How to write a gadget is in [GADGETS.md](GADGETS.md); what the agent's code can do is in [AGENT.md](AGENT.md).

## How it fits together

| Durable Object | One per | Holds |
| --- | --- | --- |
| `Cell` | gadget instance | Its binding (workspace, Blueprint version), sockets, the gadget's alarm, the approvals it waits on, and its usage by month; the gadget runs inside it as a facet with its own database |
| `Workspace` | workspace | Quota, members and their roles, the list of cells and of sessions with the agent, and the workspace's markdown docs |
| `Session` | chat with the agent | Its transcript, its grants, the turn in progress, the approvals its runs wait on, and its usage |
| `Catalog` | fleet | Every Blueprint version (draft, published or withdrawn), the fleet's workspaces, and who is a member of which |
| `Platform` | fleet | The agent's settings and new chats' grants, monthly model token budgets and what each user and workspace spent, the users who signed in and who is suspended, and the cluster as the operator last reported it |
| `Keys` | fleet | The key that signs each cell's identity for its gadget |

A gadget reaches the outside world only through its grants. `GadgetHost.call` signs each call with the fleet's Gatekeeper key and sends the Gatekeeper the cell, its workspace, Blueprint version, owner and grants with the gadget's request; the Gatekeeper decides, holds the tokens and makes the call. A model call comes back with what it used, which the cell counts; the gadget sees only the response. A call the Gatekeeper parks for approval comes back as `202 pending`; the cell then asks `POST /v1/approvals/query` about it on its alarm (after 2 s, doubling to once a minute), which it shares with the gadget's alarm, and calls the gadget's `onApproval` when it settles.

A session runs the agent's code in an **ephemeral cell**: a new cell, never served by hostname, that loads the one runner bundle (SES locks its isolate down, and each run gets a Compartment of its own), gets exactly the session's grants, runs the code once and is deleted. Its calls go to the Gatekeeper like a gadget's, as Blueprint `agent`, version `<session id>`; the session counts their tokens and follows the approvals they queue, since the cell is gone by then. See [AGENT.md](AGENT.md).

A cell serves only while its workspace has bound it; a hostname for any other cell is a 404. Gadget bundles are stored by SHA-256 through the `BUNDLES` R2 binding (`r2/bundles/sha256/<digest>.js` in the fleet bucket), and a cell checks the digest before it runs one.

## Pages

On the app host the kernel also serves three pages, behind the same identity check as the API: `/`, your cells in a workspace and creating one, and `/settings/`, where you manage everything you own. It has sections for the workspace you work in (and, for its admins, its members, quota and docs), your cells (grants, shares, version, deleting them), the gadgets your agent wrote (publishing drafts, opening cells from them), your chats' grants, your Gatekeeper connections and pending approvals, and this month's usage. `/settings/?workspace=<ws>&cell=<id>` opens on one cell; the older `/?workspace=<ws>&cell=<id>` forwards there.

`/admin/` is the platform admins' dashboard, a 403 for anyone else, and no other page may frame it. It shows the fleet (the kernel's build, and the nodes and conditions the operator reports), the agent's settings and new chats' grants, budgets with each user's and workspace's spend against them, the models and rate limits configured in the cluster, workspaces (members, quota, docs), every Blueprint version with its author and publisher (withdrawing and restoring them), users (suspending them), and the audit log, searched by user, workspace, cell, Blueprint and decision.

## Roles

| Who | How | May |
| --- | --- | --- |
| Platform admin | In the IdP group the Fleet names (`spec.admins.group`, in the token's `spec.admins.groupsClaim`, default `groups`), or one of its bootstrap emails (`spec.admins.emails`) unless the IdP says the email is unverified | Everything below, in every workspace, and the admin API and dashboard: settings, budgets, workspaces, publishing and withdrawing Blueprint versions, suspending users, the audit log. They see every cell and its usage and may delete one, but cannot open it, grant it or share it: that is its owner's |
| Workspace admin | A member with the role `admin` | Its members, quota and docs |
| Member | Role `member` | Create cells and chats in it |
| Viewer | Role `viewer` | See the workspace and read its docs |
| Anyone signed in | | Open cells shared with them, in any workspace |

Members are kept by email, as shares are. Workspaces from before Phase 12 made everyone who owned a cell or a chat in them a member. A member removed from a workspace keeps their cells; they create no more and their chats take no more turns there. A suspended user is refused everywhere, the API, their chats' turns and every cell, their own included, within a few seconds (each isolate reads the suspended list at most every 5 s).

The operator's admin token can do everything a platform admin can, and reports the cluster (`PUT /api/admin/cluster`), which nobody else may. A platform admin can do through their own login everything the admin token can do for a person, except publish someone else's draft, which stays its author's act. Every action a person takes as an admin is recorded in the Gatekeeper's audit log as an `admin` event (who, action, workspace, target, detail) before it takes effect; if it cannot be recorded, it does not happen. The admin token's own changes are the operator's, from GitOps, and are not recorded there.

## Budgets

Each model call, a gadget's, a chat's or a run's, counts against its owner's and its workspace's monthly token budgets, which the `Platform` object keeps: a default for every user (1,000,000 tokens) and every workspace (5,000,000), and overrides that raise or lower one. Before a call the kernel asks whether both have budget left, and after it adds the tokens the model reported. The call that crosses a budget is answered and the next is refused with 429 `{"error"}`, without reaching the Gatekeeper; the gadget sees that, and the agent tells the user. The inference gateway keeps only a call rate per user.

## API

Served under `/api/` on any host that is not a cell hostname. Every request, to the API or a cell, must carry one of:

- **An OIDC ID token** in `x-kodo-identity`, which the gateway forwards after the user logs in. The kernel checks its signature against the issuer's keys, and its issuer, audience and expiry.
- **The admin token** in `x-kodo-admin-token`, which the operator uses. The kernel holds only its SHA-256.

A caller whose ID token names a platform admin (see [Roles](#roles)) is marked `platformAdmin` in `/api/whoami`; a turn token never is.
- **A turn token** in `x-kodo-turn`, which the kernel issues to the agent when a session's owner starts a turn. It is signed with the fleet's kernel key, names one session and turn, and works only for that session's own routes (not its grants, not starting turns) and its workspace's docs, until the turn ends or after 5 minutes. It never reaches a cell.

Anything else is a 401. The router drops every `x-kodo-*` header a client sends before setting its own, and refuses writes and WebSockets whose `Origin` is another host. The identity settings are baked in at deploy time by `scripts/deploy.sh` (from `OIDC_ISSUER`, `OIDC_AUDIENCE`, `OIDC_JWKS_URL`, `KERNEL_ADMIN_TOKEN` and the platform admins' `PLATFORM_ADMIN_GROUP`, `PLATFORM_ADMIN_GROUPS_CLAIM` and `PLATFORM_ADMIN_EMAILS`), as are the Gatekeeper's (`GATEKEEPER_URL`, `GATEKEEPER_KEY`, `FLEET_ID`, which the operator sets from `Fleet.spec.gatekeeper`); Worker variables override them in local development.

Uploading bundles, publishing and creating workspaces need a platform admin or the admin token; a workspace's admins configure it. A workspace's members create cells and chats in it, own what they create, and see and manage only their own cells and those shared with them. The admin token acts as every cell's owner, and must name an `owner` when it creates a cell.

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/version` | | `{build}`, the kernel image's build identifier |
| POST | `/api/bundles` | gadget source | 201 `{digest}` |
| GET | `/api/blueprints` | | `{blueprints: [name]}`: the names with a published version, and the caller's drafts |
| GET | `/api/blueprints/:name` | | `{name, versions: [...]}`, each with `status` (`draft` or `published`) and, for the agent's, `author`, `session`, `workspace` and `publishedBy` |
| PUT | `/api/blueprints/:name/:version` | `{bundle, capabilities?, tier?}` | 201, or 409 if already published (platform admin) |
| POST | `/api/blueprints/:name/:version/publish` | | Publishes a draft the agent wrote: its author only (or the admin token), never a turn token. Recorded in the Gatekeeper's audit log first; a 503 if it cannot be, and the draft stays a draft |
| POST | `/api/blueprints/:name/:version/withdraw` | | No new cell may use the version, nor a cell move to it (410); cells on it keep running. `/restore` undoes it (platform admin) |
| PUT | `/api/workspaces/:ws` | `{quota?, members?: {email: role}}` | Creates the workspace (platform admin; quota default 100), or changes its quota and adds or changes members (its admins too). A quota left out is kept |
| GET | `/api/workspaces/:ws` | | `{name, quota, cells, members, role}`, `role` being the caller's, or null |
| GET | `/api/workspaces/:ws/members` | | `{members: [{email, role, addedAt, addedBy}]}` (members) |
| PUT | `/api/workspaces/:ws/members/:email` | `{role}`: `viewer`, `member` or `admin` | Adds a member or changes their role (its admins; not your own) |
| DELETE | `/api/workspaces/:ws/members/:email` | | 204 (its admins; not yourself) |
| GET | `/api/workspaces/:ws/usage[?month=YYYY-MM]` | | Usage in a month (default this one, UTC): `{workspace, month, totals, owners, cells}`. Each has `requests` (HTTP requests and WebSocket messages that reached the gadget, written a few seconds after use, so a cell that stops in that time loses a few), `storageBytes` (the gadget's database, as last measured) and `inference` (model calls and input, output and total tokens; per granted model for a cell); totals and owners add `cells`, `activeCells` and `sessions`. Sessions with the agent are rows too, with `kind: "session"` and Blueprint `agent`: their turns and runs as requests, and the tokens of their model calls and their runs'. Platform admins, the workspace's admins and the admin token see every cell and session; a user sees the ones they own. |
| GET | `/api/workspaces/:ws/cells` | | `{cells: [...]}` |
| POST | `/api/workspaces/:ws/cells` | `{blueprint, version?}` (default: the latest published, or for its author the latest draft of a name with none published) | 201 `{id, blueprint, version, owner, shares, createdAt}`, 403 for a non-member, 409 over quota, 410 for a withdrawn version. A draft only for its author |
| GET | `/api/workspaces/:ws/cells/:id` | | The cell |
| PATCH | `/api/workspaces/:ws/cells/:id` | `{version}` | Moves the cell to another version of its Blueprint |
| DELETE | `/api/workspaces/:ws/cells/:id` | | 204; deletes the gadget's storage (its owner, or a platform admin) |
| GET | `/api/workspaces/:ws/cells/:id/shares` | | `{shares: {email: role}}` |
| PUT | `/api/workspaces/:ws/cells/:id/shares/:email` | `{role}`: `viewer` or `editor` | Shares the cell, or changes the role |
| DELETE | `/api/workspaces/:ws/cells/:id/shares/:email` | | Revokes access |
| GET | `/api/workspaces/:ws/cells/:id/grants` | | `{grants: [capability]}` |
| PUT | `/api/workspaces/:ws/cells/:id/grants` | `{grants: [capability]}` | Replaces the cell's grants; each must be concrete and covered by one its Blueprint version declares. The gadget restarts with the new bindings. |
| GET | `/api/whoami` | | The verified caller |
| GET | `/api/workspaces` | | `{workspaces: [name], memberships: [{workspace, role}]}`: the caller's workspaces, or every one for a platform admin |
| GET | `/api/platform/agent` | | `{model, maxTokens, maxSteps, grant}`: how the agent works now |
| GET | `/api/blueprints?author=me` | | `{versions: [...]}`: every version the caller's agent wrote, drafts and published, newest first |
| GET | `/api/workspaces/:ws/docs` | | `{docs: [{path, description, bytes, updatedAt}]}` (members); the description is the front matter's `description:`, else the first heading or line |
| GET | `/api/workspaces/:ws/docs/:path` | | The document, as markdown |
| PUT | `/api/workspaces/:ws/docs/:path` | markdown (at most 256 KiB) | Creates or replaces it (its admins). Paths are lowercase segments ending in `.md`, e.g. `skills/email.md` |
| DELETE | `/api/workspaces/:ws/docs/:path` | | 204 (its admins) |
| GET | `/api/workspaces/:ws/sessions` | | `{sessions: [...]}`, the caller's |
| POST | `/api/workspaces/:ws/sessions` | `{title?, grants?}` | 201, the session; at most 50 per owner per workspace, members only. Without `grants`, those the platform gives new chats (by default the agent's model) |
| GET | `/api/workspaces/:ws/sessions/:id[?after=N]` | | `{id, workspace, title, owner, createdAt, grants, turn, pending, messages}`: the messages after number N, the turn in progress if any, and the approvals its runs wait on |
| DELETE | `/api/workspaces/:ws/sessions/:id` | | 204; deletes the transcript |
| PUT | `/api/workspaces/:ws/sessions/:id/grants` | `{grants: [capability]}` | Replaces the session's grants: concrete capabilities, any provider. Not with a turn token |
| POST | `/api/workspaces/:ws/sessions/:id/turns` | `{content}` | 201 `{turn: {id, token, startedAt, expiresAt}, session, agent: {model, maxTokens, maxSteps}}`: appends the owner's message, grants the session the agent's current model, and starts a turn, or 409 while one is in progress, 403 if the owner is no longer a member. Not with a turn token |
| DELETE | `/api/workspaces/:ws/sessions/:id/turns/:turn` | | 204; ends the turn (its token, or the owner) |
| POST | `/api/workspaces/:ws/sessions/:id/messages` | `{role, content, tool_calls?, tool_call_id?, name?, run?}` | Appends the agent's message: `user`, `assistant` (with chat completion `tool_calls`) or `tool`. Only with the turn token. The kernel writes `event`s itself: an approval settled, a turn that ran out of time |
| POST | `/api/workspaces/:ws/sessions/:id/complete` | `{model, request}` | Calls `inference:model/<model>:invoke` with the chat completion `request`, if the session holds that grant, as the session; answers with the model's status and body |
| POST | `/api/workspaces/:ws/sessions/:id/runs` | `{code, input?}` | Runs the code in an ephemeral cell: `{id, ok, value, error, logs, approvals, calls, ms}` |
| POST | `/api/workspaces/:ws/sessions/:id/drafts` | `{name, source, capabilities?, checks?}` | 201 `{blueprint, check}`: stores a gadget the agent wrote as the next draft version (1, 2, ...) of `name` for the session's owner, records that they authored it in the Gatekeeper's audit log, and loads it once in an ephemeral cell; `check` is what `GET /` answered, then each of up to five `checks` (`{method, path, body?}`, against the same database), and `ok` unless one failed or answered 5xx. A name with versions by anyone else is a 409. At most 20 per session and 96 KiB each |
| GET | `/api/runs/:id` | | `{bound, keys}`: what is left of a run's cell; nothing, once it has run (platform admin) |

The admin API, for platform admins (and the admin token):

| Method | Path | Body | Result |
| --- | --- | --- | --- |
| GET | `/api/admin/overview` | | `{build, caller, cluster, settings, workspaces, blueprints, versions, users, suspended}` |
| GET, PUT | `/api/admin/settings` | `{agent: {model, maxTokens, maxSteps}, sessionGrants}` | The agent's model (a model name of the inference gateway), `max_tokens` per model call (256 to 200000), model calls per turn (1 to 50), and new chats' grants (`null` for just the agent's model). The agent reads them at the start of each turn |
| GET, PUT | `/api/admin/budgets` | `{user, workspace, users?: {subject: n}, workspaces?: {name: n}}` | Monthly token budgets; `null` is no limit. PUT replaces them |
| GET | `/api/admin/usage[?month=YYYY-MM]` | | `{month, budgets, users, workspaces}`: each one's model calls, input, output and total tokens, and budget |
| GET | `/api/admin/workspaces` | | `{workspaces: [{name, quota, cells, members, admins}]}` |
| GET | `/api/admin/blueprints` | | `{versions}`: every version of every name, with `status`, `author`, `publishedBy`, `withdrawnBy` |
| GET | `/api/admin/users[?month=]` | | `{month, users: [{user, email, firstSeen, lastSeen, suspended, tokens, calls, budget}]}`: everyone who has signed in |
| PUT | `/api/admin/users/:subject` | `{suspended, email?}` | Suspends a user, or lifts it; not yourself |
| GET | `/api/admin/audit?user=&workspace=&cell=&blueprint=&decision=&days=&limit=&before=` | | `{records, scanned, truncated}`: this fleet's audit records of the last `days` (1 to 31, default 1), newest first, from the Gatekeeper |
| PUT | `/api/admin/cluster` | the operator's report | 204 (admin token only) |

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

The tests start `celld dev` on a temporary copy of the project and drive it through the API. `kernel.test.mjs` covers how gadgets run; `api.test.mjs` covers the registries and runs `examples/notes.js` against the gadget contract; `identity.test.mjs` covers identity, sharing and origins; `capabilities.test.mjs` covers grants and signed calls; `approvals.test.mjs` covers calls that wait for approval, across hibernation; `admin.test.mjs` covers platform and workspace admins, membership, settings, budgets, withdrawing, suspending, the audit trail and the cluster report; `inference.test.mjs` runs [`examples/ask`](../examples/ask) against model grants and checks the usage report; `agent.test.mjs` covers sessions, turn tokens, model calls as a session, and runs: their grants, isolation, limits, cleanup and approvals; `example.test.mjs` runs [`examples/repo-viewer`](../examples/repo-viewer), `mailer.test.mjs` [`examples/mailer`](../examples/mailer), `daybreak.test.mjs` [`examples/daybreak`](../examples/daybreak) and `hn-reader.test.mjs` [`examples/hn-reader`](../examples/hn-reader). The harness plays the identity provider: it serves a JWKS and mints tokens for test users. It can also play the Gatekeeper: it checks each call's signature, answers with canned responses, and answers approval queries from a map the test controls.
