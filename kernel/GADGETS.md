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
| `fetch(request)` | Every HTTP request to the cell's hostname, `<cell-id>.g.<domain>`. Required. |
| `this.ctx.storage` | The gadget's own SQLite database: `storage.sql` and the synchronous `storage.kv`. It survives restarts, hibernation, moves between nodes and moves to a new Blueprint version. |
| `this.cellId` | The id of the cell this instance runs in. |
| `this.setAlarm(when)` | Asks the cell to call `onAlarm()` at `when`, a `Date` or epoch milliseconds. Replaces any earlier alarm. |
| `this.deleteAlarm()` | Cancels the alarm. |
| `onAlarm()` | Optional. Called when the alarm fires. |
| `onMessage(socket, message)` | Optional. A message on a WebSocket to the cell. A string or `ArrayBuffer` return value is sent back on the same socket. `socket` is an opaque id. |
| `onClose(socket, code, reason)` | Optional. A WebSocket to the cell closed. |

## What the gadget cannot do

- **Reach the network.** `fetch()` and `connect()` to anything outside throw. External services arrive in Phase 7 as capabilities granted per instance.
- **See other bindings.** `this.env` holds only `KODO`, which `Gadget` uses to talk to its cell; every call on it is checked against the cell's signed identity, so a gadget can act only for its own cell.
- **Hold a WebSocket itself** or **set a native alarm.** celld 0.6.0 supports neither inside a gadget, so the cell holds both and passes the events on.
- **Push to a socket unprompted.** A gadget can answer a message, but cannot yet send on a socket from `fetch()` or `onAlarm()`.
- **Run for long.** Each call must answer within 30 s and use at most 5 s of CPU (`GADGET_CALL_TIMEOUT_MS`, `GADGET_CPU_MS`). A call over either limit fails; the gadget restarts on the next call with its storage intact.

## Failures

| What happens | What the caller sees |
| --- | --- |
| The gadget throws, fails to load, or has no `App` | HTTP 502 `gadget failed: ...` |
| A call takes longer than the time limit | HTTP 504 |
| `onMessage` throws or is missing | The socket closes with code 4011 |
| `onAlarm` throws | Logged; the alarm is not retried |

## Publishing

A gadget is published as a version of a Blueprint through the kernel API; see the [README](README.md#api). A version is immutable. Existing cells keep the version they were created with until they are moved to another, and a move keeps the gadget's storage, so a new version must read the data the old one wrote.
