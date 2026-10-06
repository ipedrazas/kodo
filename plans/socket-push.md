# Socket push: gadgets that send unprompted

**User stories**: a chat gadget; a page that updates when an approval settles or an alarm fires; several people watching the same cell see each other's changes.

Today a gadget can only answer the message it was sent: `onMessage` returns a reply and the cell sends it on the same socket (`kernel/src/cell.ts`, `webSocketMessage`). It cannot send to another socket, nor from `fetch()`, `onAlarm()` or `onApproval()`, so a chat has to poll. The cell already holds every socket (celld 0.6.0 facets cannot), so the cell is what sends; the gadget needs a way to ask it to, the same way it asks for an alarm.

## Design

The path is the one `setAlarm` takes: the `Gadget` runtime calls the host binding `env.KODO` with its signed props, `GadgetHost` verifies them and calls the gadget's own cell, and the cell acts. A gadget can only reach its own cell's sockets, because the props name the cell and the token proves it.

### What the gadget gets

| Surface | What it is |
| --- | --- |
| `onOpen(socket, caller)` | Optional. A WebSocket to the cell opened. Called after the socket is accepted, so a send from it reaches the new socket. Without it a gadget only learns of a socket from its first message. |
| `this.sockets()` | The sockets open on this cell now: `[{socket, user, email, role, openedAt}]`. |
| `this.send(socket, message)` | Sends a string or `ArrayBuffer` on one socket, or on each of a list. Resolves to how many it was sent on; a socket that has closed, or an id that is not this cell's, is skipped. |
| `this.broadcast(message, {except})` | Sends on every open socket of the cell, except `except` (a socket or a list). Resolves to how many. |
| `this.closeSocket(socket, code, reason)` | Closes one socket; `onClose` follows. |

All of them work from any handler: `fetch`, `onOpen`, `onMessage`, `onClose`, `onAlarm`, `onApproval`. Sends made during `onMessage` go out before its return value. The `onMessage` return value keeps working as it does.

A chat is then:

```js
onOpen(socket, caller) {
  return this.send(socket, JSON.stringify({ history: this.recent() }));
}
async onMessage(socket, message, caller) {
  const line = this.add(caller.email, String(message));
  await this.broadcast(JSON.stringify({ line }));
}
```

### Kernel changes

- **`kernel/src/host.ts`**
  - `GadgetHost` gets `sockets(props)`, `send(props, targets, message, except)` (with `targets` null for a broadcast) and `closeSocket(props, socket, code, reason)`. Each verifies the props and calls the cell, the same way `setAlarm` does.
  - `GADGET_RUNTIME` adds the four methods to `Gadget`, through `#host`, so they wait for the first host call like the others do.
  - It also adds `__kodoOpened(socket, caller)`, which calls `onOpen` when the gadget defines it, following the `__kodoApprovalSettled` pattern.
- **`kernel/src/cell.ts`**
  - `acceptSocket` records `openedAt` in the attachment, tags the socket with its id (see spike), and calls `onOpen` once the 101 is returned (`ctx.waitUntil`). An `onOpen` that throws closes the socket with 4011, as `onMessage` does.
  - New `gadgetSockets()`, `pushToSockets(targets, message, except)` and `closeGadgetSocket(socket, code, reason)` find sockets with `ctx.getWebSockets(tag)`, or by scanning attachments.
  - On an ephemeral or checking cell (`binding.run` is set), `sockets()` is empty and sends return 0.
- **Limits**
  - A message is at most 1 MiB (`MAX_REQUEST_BODY`).
  - One `send` takes at most 1000 targets.
  - A cell holds at most `GADGET_MAX_SOCKETS` sockets (default 1000). An upgrade past that limit gets a 503, because there's no cap today.
  - Sends are synchronous `ws.send` calls on the cell, not facet calls, so a broadcast to many sockets costs the gadget a single host call.
- **Usage**: `MonthUsage` gets `pushed`, the frames sent on the gadget's behalf other than `onMessage` replies, so fan-out shows in the usage report without inflating `requests`.

Sockets already outlive gadget restarts (grant changes, timeouts, version moves) because the cell holds them. Push keeps that property: the socket ids a gadget stored in its database are still valid after a restart, and after the cell hibernates.

### Docs and tooling

- **`kernel/GADGETS.md`**: add the table rows above. Drop "Push to a socket unprompted" from what a gadget cannot do. Add `onOpen` throwing to Failures.
- **`internal/agent/gadgets.md`**: replace "It cannot push unprompted" with the new API, so the agent can write chat-like gadgets.
- **`internal/celldapp/celldapp.go`**: the refusal for `acceptWebSocket`/`getWebSockets` points at `onOpen`, `send` and `broadcast`.
- **`README.md`**: mention push in the Gadget row.

## Spike first (half a day, under `celld dev`)

These celld 0.6.0 behaviours decide details above. Each is answered by a test, not assumed:

1. **Re-entrant host calls:** a host call from the gadget reaches the cell while the cell is awaiting that gadget's `onMessage`. `setAlarm` from `fetch` suggests yes, but test it from `onMessage`.
2. **Socket tags:** whether `acceptWebSocket(ws, tags)` and `getWebSockets(tag)` work on hibernated sockets. If they don't, scan attachments; that's fine at the 1000-socket cap.
3. **`onOpen` timing:** whether a `send` to the new socket before the 101 reaches the client arrives or is lost. This decides whether `onOpen` runs in `waitUntil`.
4. **Bursts:** 50 clients sending at once, each `onMessage` broadcasting. This checks the "facet calls hang after a burst" bug from Phase 1 against host calls made from inside facet calls.
5. **Idle sockets through the gateway:** Envoy Gateway's idle timeout on an upgraded connection. A quiet chat socket must survive or reconnect. Check whether celld supports `setWebSocketAutoResponse` for ping/pong; if not, the client pings and the kernel answers it without waking the gadget.

### Spike results (2026-10-06, celld 0.6.0 under `celld dev`)

1. **Re-entrant host calls:** yes. A `broadcast` from `onMessage` reaches the cell while it awaits that `onMessage` (`push.test.mjs`).
2. **Socket tags:** they work, also after the cell hibernates with sockets open. Lookups use `getWebSockets(id)`.
3. **`onOpen` timing:** `onOpen` runs in `waitUntil` after the 101; its send arrives every time.
4. **Bursts:** 50 to 200 sockets broadcasting at once all deliver. The failures first seen were not celld's: `kernelKey()` cached a pending promise in a module variable, and on a fresh `GadgetHost` isolate the concurrent host calls that awaited it were cancelled as hung. The key alone is now cached. `Gadget.#host` likewise calls the host directly once warm, instead of chaining on the first call's promise. Separately, celld refuses a cell more than 64 requests in flight (`CELLD_MAX_CELL_REQUESTS`) with 503 `cell request limit reached`. That limits concurrent upgrades, not messages.
5. **Idle sockets:** celld supports `setWebSocketAutoResponse`, so the cell answers `ping` with `pong` without waking. On k3s (`test/e2e/chat.sh`), a socket that pings every 30 s still works after 10 minutes. One that never pings is dropped by the gateway after 5 minutes without its client being told: it looks open but delivers nothing either way. Lines arrive in 60–225 ms. The first line after the room has hibernated (30 s idle on k3s) can take over a second, about 1.3 s once, while the cell wakes and loads its gadget.

Also found: after a few thousand sockets have opened and closed on one cell (about 2,400 with the push fixture, 6,000 with an echo gadget; `main` too), celld loses the 101 for some concurrent upgrades. The cell accepts the socket and lists it, but the client never gets the answer, and in CI the upgrade fails with 500 after 300 s. Upgrades one at a time still succeed, on that cell and others, and the cell keeps serving HTTP. It is a celld 0.6.0 issue to report upstream with a repro. Until then, clients should reconnect with a timeout on the open, as the chat page does.

Also found: celld keeps a closed socket in `getWebSockets()` with `readyState` OPEN until `webSocketClose` returns. The cell tracks sockets it is closing, so `onClose` does not see the closing socket in `sockets()`.

## Slices

1. **Send to a socket.**
   - Add `sockets()`, `send()` and the host and cell methods.
   - Test with a Gadget-based fixture, `kernel/test/gadgets/push.js`:
     - Two sockets: A's message reaches B.
     - `POST /push` from `fetch()` reaches an open socket.
     - An unknown id returns 0.
     - Forged props are refused, extending the `?forge` test.
     - A closed socket is skipped.
2. **Broadcast, `onOpen`, `closeSocket`, limits, usage.**
   - Tests:
     - `broadcast` with `except`.
     - `onOpen` gets the caller, and its send arrives.
     - `onAlarm` broadcasts.
     - A message over 1 MiB is refused.
     - The 1001st socket gets 503.
     - `pushed` is counted.
     - A grant change restarts the gadget, and the stored socket ids still work.
3. **Chat example and e2e.**
   - Add `examples/chat`, a page plus gadget, shared as editor with a second user.
   - Add `test/e2e/chat.sh` on k3s: two users through the real gateway (wss via Envoy, OIDC). A line from one reaches the other within a second, and a quiet socket survives 10 minutes.
   - Docs as above.

## Acceptance criteria

- [x] A gadget sends on any of its cell's sockets from `fetch`, `onOpen`, `onMessage`, `onClose`, `onAlarm` and `onApproval`
- [x] A gadget cannot send on, list or close another cell's sockets
- [x] Two users in a shared chat cell see each other's lines within a second on k3s, through the gateway
- [x] Socket ids stay valid across gadget restarts and cell hibernation
- [x] A broadcast to 1000 sockets is one host call and finishes within the call time limit
- [x] Oversized messages, too many targets and too many sockets fail with a clear error, not a hung call
- [x] Pushed frames appear in the cell's usage
- [x] GADGETS.md, the agent's gadget guide and `kodo publish`'s refusal describe the new API

## Open questions

- **Viewers:** today a viewer gets 403 on upgrade. Should they get a receive-only socket, so a viewer can watch a chat or a live page? Messages they send would close the socket with 4003, and `caller.role` already tells the gadget who they are. I'd allow it, as a follow-up once this lands.
- **Presence:** `sockets()` returns each socket's user, so presence is something the gadget builds itself rather than a kernel feature. I'd keep it in the gadget.
