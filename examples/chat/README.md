# Chat

A kodo gadget for a chat room: one room per cell, whose members are the people the cell is shared with. Lines appear for everyone the moment they are said; nobody polls. It is the smallest app that sends unprompted: the cell holds everyone's WebSocket, and the gadget asks it to send each new line to all of them.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App`, with its page |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `chat` version `1.0.0`; it needs no capabilities |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

- The page opens a WebSocket to its cell. `onOpen` sends it the last 50 lines and who is here, and tells the others someone came.
- A line sent on a socket, or posted to `POST /api/lines`, is stored in the cell's SQLite database and sent to every open socket with `this.broadcast()`. `onClose` tells the others someone left. Who is here comes from `this.sockets()`.
- The owner and editors can write. A viewer can read `GET /api/lines` but cannot open a socket, because the kernel refuses viewers' WebSockets.
- The page sends `ping` every 30 seconds, which the kernel answers `pong` without waking the gadget, so proxies keep a quiet socket open. It reconnects, backing off up to 30 seconds, if the socket closes or does not open within 10 seconds.

## Deploy it

You need a fleet, a workspace and a login (on hiddenfield.dev: `task k3s:up`). These steps use hiddenfield.dev.

```sh
kubectl -n kodo apply -k examples/chat
kubectl -n kodo wait blueprint/chat-1.0.0 --for=condition=Published
```

Logged in as alice (the cookie jar from `test/e2e/lib.sh`'s `login`, or your browser's session), create a room and share it with bob:

```sh
curl -b jar -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"blueprint":"chat"}' https://app.hiddenfield.dev/api/workspaces/team/cells
curl -b jar -X PUT -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"role":"editor"}' https://app.hiddenfield.dev/api/workspaces/team/cells/<cell>/shares/bob@hiddenfield.dev
```

Both open `https://<cell>.g.hiddenfield.dev/`. `task k3s:chat-test` does the same as alice and bob through the gateway and checks that lines arrive within a second and that a quiet socket stays open.
