# Kernel

The application every kodo fleet runs. It routes `<cell-id>.g.<domain>` to the cell's Durable Object, loads the cell's gadget bundle by digest, and runs the gadget as a facet with its own SQLite database, no bindings and no network.

## Gadgets (provisional API)

Phase 3 writes the gadget API down properly; this is what the kernel enforces today.

A gadget is one JavaScript module that exports a Durable Object class named `App`:

```js
import { DurableObject } from "cloudflare:workers";

export class App extends DurableObject {
  // HTTP requests to the cell's hostname.
  async fetch(request) {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    return Response.json({ n });
  }

  // Optional. A message on a WebSocket the cell holds for the gadget. A
  // string or ArrayBuffer return value is sent back on the same socket.
  onMessage(socket, message) {
    return `echo: ${message}`;
  }

  // Optional. The socket closed.
  onClose(socket, code, reason) {}
}
```

- **Storage**: `this.ctx.storage` is the gadget's own SQLite database, separate from the cell's.
- **No authority**: `this.env` is empty, and `fetch()` and `connect()` to the outside throw.
- **WebSockets**: the cell accepts the connection and keeps it across hibernation. The gadget never sees the socket object; it gets each message as a call identified by a socket id. A gadget cannot hold a WebSocket itself, because celld 0.6.0 does not support them inside facets.
- **Limits**: each call must answer within `GADGET_CALL_TIMEOUT_MS` (30 s) and use at most `GADGET_CPU_MS` (5 s) of CPU.
- **No alarms**: facets cannot set alarms in celld 0.6.0; scheduled work arrives in a later phase through the cell.

## Responses the kernel produces

| Status | Meaning |
| --- | --- |
| 404 `not found` | The host is not a cell hostname |
| 404 `cell <id> does not exist` | No manifest for the cell |
| 500 | The cell's manifest is unreadable or has no valid digest |
| 502 `bundle <digest> not found` | The manifest names a bundle that is not stored |
| 502 `bundle <digest> does not match its digest` | The stored bundle's SHA-256 differs from its name |
| 502 `gadget failed: ...` | The bundle does not load, has no `App`, or the call threw |
| 504 `gadget did not answer within N ms` | The call timed out; the gadget is restarted on the next call |

A WebSocket message the gadget fails to handle closes that socket with code 4011.

## Cells and bundles, by hand

Until Phase 3 adds an API, an operator writes two kinds of object into the fleet bucket through celld's R2 bindings:

- **Bundle**: `r2/bundles/sha256/<digest>.js`, the gadget source, named by its SHA-256.
- **Cell manifest**: `r2/cells/<cell-id>.json`, containing `{"bundle": "<digest>"}`.

```sh
digest=$(task gadget:put TARGET=k3s FILE=path/to/gadget.js)
task cell:bind TARGET=k3s CELL=my-cell BUNDLE=$digest
curl -H 'Host: my-cell.g.test' http://<fleet service>/
```

A cell reads its manifest when it activates, so a new binding takes effect once the cell is idle and hibernates.

## Develop and test

```sh
task kernel:check                # typecheck, then the tests under celld dev
task kernel:up TARGET=kind       # kind cluster, fleet, kernel, smoke test
task kernel:up TARGET=k3s        # the same on the k3s cluster under gVisor
```

The tests start `celld dev` on a temporary copy of the project, with `KERNEL_DEV=1` in its `.dev.vars`. That variable enables `PUT /_dev/bundles` and `PUT /_dev/cells/<id>`, the local equivalents of the bucket writes above. `celld deploy` never reads `.dev.vars`, so these routes do not exist on a fleet.
