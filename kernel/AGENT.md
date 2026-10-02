# The agent's code

The agent at `app.<domain>/chat/` answers by writing JavaScript and running it. Each run happens in an **ephemeral cell**: a new cell, created for that run, with exactly the capabilities the user granted the chat, deleted when the run ends. This page is the contract for that code, and how the kernel holds it to it. [`agent.test.mjs`](test/agent.test.mjs) checks every part of it.

## Sessions and turns

A chat is a **session** with the agent, a `Session` Durable Object registered in its workspace. It holds the transcript, the capabilities its owner granted it, and the turn in progress. The agent service ([`internal/agent`](../internal/agent)) is stateless and has no authority of its own:

1. The user sends a message. The agent passes it to the kernel with the user's ID token, which starts a **turn** and returns a **turn token**.
2. For the rest of the turn the agent uses only that token. It reaches this one session and nothing else: it can read the transcript, append the agent's messages, call the models the session holds grants for, run code, read the workspace's docs, and end the turn. It cannot change the session's grants, start another turn, or touch the user's cells, shares or other sessions.
3. The turn ends when the agent ends it, or after 5 minutes. The token stops working then, and a turn the agent never ended is marked in the transcript as interrupted.

New sessions are granted `inference:model/agent:invoke`, the model the agent thinks with. Its calls go through the Gatekeeper as the session, so they count against the owner's and workspace's budgets and are in the audit log. The owner adds or removes grants in the chat's settings like any cell's, but a session has no Blueprint declaring what it may hold: any concrete capability will do. The Gatekeeper still decides every call, with the owner's own connections.

## Gadgets the agent writes

Asked for a gadget, the agent reads its guide ([`internal/agent/gadgets.md`](../internal/agent/gadgets.md)) and submits a module with `write_gadget`. The kernel stores it by digest as a **draft**: the next version (1, 2, ...) of that Blueprint name, authored by the session's owner in that session. It records in the Gatekeeper's audit log that they authored it (a draft that cannot be audited is not kept), then loads it once in an ephemeral cell with no grants, asks for `GET /` and makes up to five requests the agent gives (its `checks`, against the same database), so the agent learns at once whether it works and can fix it. A name the agent first used belongs to that user: nobody else's agent can add versions to it, nor to a name published with the admin token.

A draft is the author's alone: nobody else sees it in the catalog or can create a cell from it. The author can try it from the chat, where it appears as a card with the code and the capabilities it asks for, and publish it there. Publishing is the user's act with their own login; a turn token cannot do it, so the agent never can. It is audited too, and from then on anyone can open the version. A revision is a new draft version; cells keep the version they run until their owner moves them. A new cell starts with no grants: its owner grants the capabilities the version declares, on the settings page, which also lists the gadgets their agent wrote and publishes drafts.

Each draft is a new bundle, and celld 0.6.0 keeps every bundle it loads in memory, so a session may write at most 20.

## What the code is

The body of an async function. It returns a JSON value, and may log:

```js
const res = await grants["web:hn.algolia.com/api/v1:read"].fetch("/search?query=kubernetes&hitsPerPage=3");
const { hits } = await res.json();
console.log(`${hits.length} stories`);
return hits.map((h) => h.title);
```

The run answers `{ok, value, error, logs, approvals, calls, ms}`.

| Name | What it is |
| --- | --- |
| `grants` | One object per capability the session holds, keyed by the capability. `fetch(path, {method, headers, body})` makes a call within it, like a gadget's binding ([GADGETS.md](GADGETS.md#capabilities)), and returns `{status, ok, headers, text(), json()}`. `body` is a string, or a JSON value sent as JSON. |
| `input` | The JSON value passed with the code, or `null`. |
| `console` | `log`, `info`, `warn`, `error`, `debug`: up to 200 lines, which come back in `logs`. |
| Built-ins | The standard ones, with `Date.now()` and `Math.random()`; also `URL`, `URLSearchParams`, `atob`, `btoa` and `crypto.randomUUID()`. |

A call that sends, writes or deletes answers `202` with the approval's id in `headers["x-kodo-approval"]`, and is listed in `approvals`. The run's cell is gone by the time anyone decides, so the session follows the approval instead, and adds an event to the transcript when it is approved and made, rejected, expired or failed.

## What the code cannot do

- **Use more than the session holds.** The cell gets the session's grants, nothing of the user's other cells; a capability the session does not hold has no binding at all, and the kernel asserts the session's grants to the Gatekeeper on every call.
- **Reach the network** except through `grants`: there is no `fetch`, and the isolate has no outbound network.
- **Keep anything.** Nothing survives the run. The cell, its storage and its binding are deleted when the run ends, whatever happens; a cell whose node stopped mid-run deletes itself 30 s after the run's time limit. `GET /api/runs/:id` (admin) shows what is left: nothing.
- **Reach another run.** Every run on a node shares one isolate, because celld 0.6.0 never frees a loaded bundle's memory and so every run loads the same one. SES locks that isolate down before any run: the built-ins are frozen, and each run evaluates in a Compartment of its own with a fresh global object. One run cannot leave anything for the next, and the code cannot climb out through `Function` constructors to the runner, the kernel's binding or `lockdown`.
- **Use memory outside the heap.** There is no `ArrayBuffer`, typed array, `DataView`, `Atomics`, `WebAssembly`, `TextEncoder` or `TextDecoder`, and nothing the code is given holds one. celld limits each isolate's heap (`CELLD_V8_HEAP_LIMIT_MB`, 128 MiB by default) but not ArrayBuffers: a run could fill its node's memory faster than celld sheds load, and the node would be killed with every cell on it. On the heap, a run that grows too far is stopped and the isolate recovers. The code works with text and JSON; binary data travels as base64.
- **Run for long.** Each run may take 60 s (`AGENT_RUN_TIMEOUT_MS`), use 2 s of CPU (`AGENT_RUN_CPU_MS`) and make 20 calls through `grants` (`AGENT_RUN_CALLS`); a call over the limit answers `429`. A run over its time or CPU limit fails with an error and the runner serves the next run. Because runs on a node share an isolate, a runaway run holds up other runs on that node until its CPU limit, but not gadgets, which have isolates of their own.
- **Be served.** An ephemeral cell has no page: its hostname is a 404.
