# Running a celld app on kodo

You have a celld app, a Worker with a Durable Object class, and it works under `celld dev`. This page takes one such app, [`examples/celld-todos`](../examples/celld-todos/README.md), and puts it in front of users twice: once on plain Kubernetes, then on kodo. The code is the same both times. What changes is what you have to build around it.

## The app

A to-do list. The Worker routes `/lists/<name>/` to one `Todos` object per name, and each object keeps its items in its own SQLite database and serves a page and a JSON API:

```
examples/celld-todos/
  wrangler.jsonc     the Worker, binding LISTS to class Todos
  src/index.js       the router: /lists/<name>/... → LISTS.idFromName(name)
  src/todos.js       class Todos: state.storage.sql, GET /, /api/items
```

It has nothing kodo-specific in it. It runs locally as it is:

```sh
celld dev examples/celld-todos        # needs esbuild on PATH
open http://127.0.0.1:9876/lists/groceries/
```

Anyone who can reach port 9876 can read and change every list. That is fine on a laptop. The rest of this page is about what it takes to make it otherwise.

## On plain Kubernetes

"You can deploy any application in Kubernetes if you know how to define all the things you need" is true. For this app, those things are:

| Need | What you build | Why |
| --- | --- | --- |
| Nodes | A StatefulSet of celld nodes, a headless Service for peers and a Service for traffic, node volumes with low fsync latency | celld places each object on one node and moves it when a node goes away |
| State | An S3 bucket, credentials for it in a Secret, and the node settings that point at it | Objects hibernate to the bucket and restore from it; node disks are only a cache |
| Deploying code | A Job or CI step that runs `celld deploy` against the bucket, and a rollout for the nodes | celld reads the Worker from the bucket |
| Upgrades | A procedure for new celld versions | Mixed celld versions cannot share a fleet |
| A hostname | A DNS record, a Gateway and an HTTPRoute (or an Ingress) | Users need a URL |
| TLS | cert-manager, an issuer, a certificate, the DNS-01 or HTTP-01 plumbing | Browsers need HTTPS |
| Login | An OIDC provider, a client registered with it, and an auth proxy or gateway policy in front of the app | Today anyone with the URL can use any list |
| Who owns a list | Code: record an owner on create, check it on every request | Login says who you are, not which lists are yours |
| Sharing | Code: shares, roles (read or write), an API and a page to manage them | A list for a family or a team |
| Isolation | One origin per list, or the lists can read each other's data through the browser | `/lists/a/` and `/lists/b/` share an origin, cookies and storage |
| Network policy | NetworkPolicies so the nodes reach only the bucket and each other; nothing on the peer port 8081 from outside | celld's internal listener includes an unauthenticated operator API |
| Untrusted code | A sandboxed runtime (gVisor, Kata) if anyone else's code runs on the nodes | Workers share a process per node |
| Quotas and usage | Code: who may create how many lists, and what each costs | A shared cluster |

None of these is hard alone, and each is a well-known Kubernetes pattern. Together they are most of a platform, and the rows marked "Code" go into the app itself: every app you write has to implement login, ownership and sharing again, correctly.

## On kodo

kodo is that platform, built once. A Durable Object class becomes a **gadget**, every list becomes a **cell** with its own hostname, and the rows above are already there.

### 1. Publish the class

`kodo publish` bundles the class, checks it, and publishes it as a Blueprint through the operator. It needs `kubectl` access to the fleet's namespace, as a platform admin:

```sh
go build -o bin/kodo ./cmd/kodo
bin/kodo publish examples/celld-todos --class Todos --name todos --version 0.1.0
```

It waits until the operator reports the Blueprint `Published`, then says how to create a cell.

`--dry-run` writes the gadget, the Blueprint and a kustomization without applying them, so you can review or commit them instead. The class runs unchanged: kodo wraps it in a generated `App` and passes it the cell's storage. The router in `src/index.js` is left behind, because kodo routes by hostname instead.

### 2. Create a list

At `https://app.<domain>/`, pick a workspace and create a cell from `todos`, or with the API:

```sh
curl -b jar -H "Origin: https://app.<domain>" -H 'content-type: application/json' \
  -d '{"blueprint":"todos"}' https://app.<domain>/api/workspaces/team/cells
# {"id":"c6jtf5ynfmmac","blueprint":"todos","version":"0.1.0","owner":"alice@...", ...}
```

### 3. Open it

`https://c6jtf5ynfmmac.g.<domain>/` shows the page. Each item says who added it: the class reads `x-kodo-email`, which the kernel sets for every request and which a client cannot forge. On `celld dev` the same code shows "someone".

### 4. Share it

On the settings page, or:

```sh
curl -b jar -X PUT -H "Origin: https://app.<domain>" -H 'content-type: application/json' \
  -d '{"role":"editor"}' https://app.<domain>/api/workspaces/team/cells/c6jtf5ynfmmac/shares/bob@example.com
```

Bob signs in and opens the same URL. A `viewer` share could read the list but not change it: the kernel refuses viewers' writes before the class sees them.

## What happened behind the scenes

| On plain Kubernetes you built | On kodo |
| --- | --- |
| Nodes, Services, volumes | The operator runs them from a `Fleet` resource |
| Bucket and credentials | Set once per fleet; every cell's database lives there |
| Deploying code | `kodo publish` creates a `Blueprint`; the operator uploads it through the kernel |
| celld upgrades | Change `Fleet.spec.celld`; the operator stops and restarts the fleet |
| DNS, gateway, TLS | One wildcard certificate and route for `*.g.<domain>`, set up with the cluster |
| Login | Envoy Gateway's OIDC login in front of every cell; the kernel verifies the ID token |
| Who owns a list | Every cell has an owner, the user who created it |
| Sharing | Viewer and editor shares per cell, with an API and a settings page |
| Isolation | Each cell has its own hostname, so its own origin; the kernel strips login cookies and tokens before the gadget sees a request, and refuses cross-origin writes |
| Network policy | The operator writes the fleet's NetworkPolicies; gadgets have no network at all |
| Untrusted code | Each gadget runs as a separate isolate, on gVisor nodes where configured |
| Quotas and usage | Per-workspace cell quotas, per-cell usage, a platform admin dashboard |

[architecture.md](architecture.md) has the whole picture, and [dependencies.md](dependencies.md) has what the cluster itself needs (DNS, the identity provider, object storage).

## What does not carry over

A gadget has no ambient authority, so `kodo publish` refuses a class that needs any, and says why:

- **`env` bindings and secrets.** A gadget has none. It reaches services through capabilities its owner grants: GitHub, email, public web APIs, models. The Gatekeeper makes those calls and holds the tokens.
- **Outbound `fetch()`.** It throws. Use a `web:` grant instead, e.g. `web:hn.algolia.com/api/v1:read`.
- **Native alarms and WebSockets.** The cell holds both, so a gadget uses `this.setAlarm()` and `onOpen()`/`onMessage()` instead.
- **Other classes and the router.** One class becomes one gadget. What the router did with `idFromName(name)` becomes one cell per name.

A class that needs any of these is rewritten against the `Gadget` class, which is still a small change to a Durable Object. See [GADGETS.md](../kernel/GADGETS.md), and [`examples/hn-reader`](../examples/hn-reader/README.md) for a gadget that calls an API and a model.
