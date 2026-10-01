# Writing a gadget

A gadget is a small app that runs once per cell: every user or document gets its own instance with its own database. This page is the contract between a gadget and the kernel. [`examples/notes.js`](examples/notes.js) uses every part of it, and the kernel's tests run that example against this contract.

## Shape

A gadget is one JavaScript module that exports a class named `App`. Extend `Gadget` from the `kodo` module, which the kernel provides:

```js
import { Gadget } from "kodo";

export class App extends Gadget {
  async fetch(request) {
    return new Response("hello");
  }
}
```

A class that extends `DurableObject` from `cloudflare:workers` also runs, but cannot use the methods `Gadget` adds.

## What the gadget can use

| Surface | What it is |
| --- | --- |
| `fetch(request)` | Every HTTP request to the cell's hostname, `<cell-id>.g.<domain>`, from a caller the kernel has already authenticated and authorised. Required. |
| Caller headers | `x-kodo-user` (the identity provider's subject), `x-kodo-email`, and `x-kodo-role`: `owner`, `editor` or `viewer`. The kernel sets them; a client cannot. |
| `this.ctx.storage` | The gadget's own SQLite database: `storage.sql` and the synchronous `storage.kv`. It survives restarts, hibernation, moves between nodes and moves to a new Blueprint version. |
| `this.cellId` | The id of the cell this instance runs in. |
| `this.setAlarm(when)` | Asks the cell to call `onAlarm()` at `when`, a `Date` or epoch milliseconds. Replaces any earlier alarm. |
| `this.deleteAlarm()` | Cancels the alarm. |
| `onAlarm()` | Optional. Called when the alarm fires. |
| `onMessage(socket, message, caller)` | Optional. A message on a WebSocket to the cell. A string or `ArrayBuffer` return value is sent back on the same socket. `socket` is an opaque id; `caller` is `{user, email, role}` of whoever opened it. |
| `onClose(socket, code, reason)` | Optional. A WebSocket to the cell closed. |
| `this.grants` | One binding per capability the cell's owner granted, keyed by the capability, e.g. `this.grants["github:repo/acme/api:read"]`. Empty until the owner grants something. See [Capabilities](#capabilities). |

## What the gadget cannot do

- **See credentials.** The login session cookies and the ID token are removed before a request reaches the gadget; cookies the gadget sets for its own origin are passed through.
- **Serve writes to other origins.** The kernel refuses a write, and any WebSocket, whose `Origin` is not the cell's own; reads from other origins are allowed and the gadget decides on CORS.
- **Reach the network.** `fetch()` and `connect()` to anything outside throw. External services are reached only through `this.grants`.
- **See a token.** A binding's calls are made by the Gatekeeper with the owner's token; the gadget gets the response, never the credential.
- **See other bindings.** `this.env` holds only `KODO`, which `Gadget` uses to talk to its cell; every call on it is checked against the cell's signed identity, so a gadget can act only for its own cell.
- **Hold a WebSocket itself** or **set a native alarm.** celld 0.6.0 supports neither inside a gadget, so the cell holds both and passes the events on.
- **Push to a socket unprompted.** A gadget can answer a message, but cannot yet send on a socket from `fetch()` or `onAlarm()`.
- **Run for long.** Each call must answer within 30 s and use at most 5 s of CPU (`GADGET_CALL_TIMEOUT_MS`, `GADGET_CPU_MS`). A call over either limit fails; the gadget restarts on the next call with its storage intact.

## Capabilities

A Blueprint declares what its gadget may reach as capabilities, `<provider>:<resource>:<verb>`, when it is published. A `*` stands for one path segment of the resource: `github:repo/*/*:read` covers reading any GitHub repository. Each cell's owner then grants concrete capabilities, a subset of the declared ones, with `PUT /api/workspaces/:ws/cells/:id/grants` (see the [README](README.md#api)), and the gadget restarts with one binding per grant:

```js
const repo = this.grants["github:repo/acme/api:read"];
if (!repo) return new Response("not granted", { status: 403 });
const res = await repo.fetch("/readme", { headers: { accept: "application/vnd.github.raw+json" } });
```

`fetch(path, init)` on a binding returns a `Response`. The path is relative to the capability's resource, with any query string; `""` is the resource itself. Only `method`, `headers` and `body` of `init` are used. The call goes to the kernel, which asserts the cell, its owner and its grants to the Gatekeeper; the Gatekeeper checks the call is within the grant, makes it with the owner's token, and records the decision in the audit log. Calls use the owner's token whoever is using the cell, so a viewer of a shared cell reads with the owner's access.

| Provider | Resource | Verb | Allows |
| --- | --- | --- | --- |
| `github` | `repo/<owner>/<repo>` | `read` | `GET` and `HEAD` on `https://api.github.com/repos/<owner>/<repo>` and everything under it. Request headers other than `Accept`, `If-None-Match` and `If-Modified-Since` are dropped; redirects come back as they are. |

Writes, sends and deletes wait for the approval queue (Phase 8). A response says who produced it in `x-kodo-decision`: `allowed` (the provider's answer), `denied` (403 from the Gatekeeper, with `{"error"}`) or `error`/`failed` (the kernel or Gatekeeper could not make the call). The owner must have connected the provider at `app.<domain>/gatekeeper/`; until then, calls are denied.

## Failures

| What happens | What the caller sees |
| --- | --- |
| No identity, or an invalid or expired one | HTTP 401 (behind the gateway, a login redirect) |
| The cell is not the caller's and not shared with them | HTTP 403 |
| A viewer writes or opens a WebSocket | HTTP 403 |
| The gadget throws, fails to load, or has no `App` | HTTP 502 `gadget failed: ...` |
| A call takes longer than the time limit | HTTP 504 |
| `onMessage` throws or is missing | The socket closes with code 4011 |
| `onAlarm` throws | Logged; the alarm is not retried |
| A binding's call is outside its grant, or the owner has not connected the provider | The binding answers 403, `x-kodo-decision: denied` |
| The fleet has no Gatekeeper, or it is unreachable | The binding answers 503 or 502, `x-kodo-decision: error` |

## Publishing

A gadget is published as a version of a Blueprint through the kernel API; see the [README](README.md#api). A version is immutable. Existing cells keep the version they were created with until they are moved to another, and a move keeps the gadget's storage, so a new version must read the data the old one wrote.
