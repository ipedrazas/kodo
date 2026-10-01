# Repo viewer

A kodo gadget that shows the README, latest commits and basic facts of GitHub repositories. It is the smallest app that uses a capability: it never sees a GitHub token, only the repositories its cell's owner granted it.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App` |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `repo-viewer` version `1.0.0`, declaring `github:repo/*/*:read` |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

- `this.grants` holds one binding per capability the cell's owner granted. The gadget lists the ones that look like `github:repo/<owner>/<repo>:read` as the repositories it can show.
- `grant.fetch("/readme")` calls `GET https://api.github.com/repos/<owner>/<repo>/readme`, through the kernel and the Gatekeeper, with the owner's token. The path is relative to the granted repository, so the gadget cannot ask for another one.
- Answers are cached for a minute in the cell's own SQLite database, `this.ctx.storage.sql`.
- A repository it was not granted has no binding, and the page says so.

```
browser ──► <cell>.g.<domain> ──► kernel ──► repo viewer (this.grants)
                                   │  signed call: cell, owner, grants
                                   ▼
                              Gatekeeper ──► OpenBao (decrypt owner's token)
                                   │       ──► audit/ (decision)
                                   ▼
                          api.github.com/repos/<owner>/<repo>/...
```

## Deploy it

You need a fleet with a Gatekeeper (on hiddenfield.dev: `task k3s:up`), a workspace, and a login. These steps use hiddenfield.dev; replace the domain with yours.

### 1. Publish the Blueprint

With the operator, from the repository root:

```sh
kubectl -n kodo apply -k examples/repo-viewer
kubectl -n kodo wait blueprint/repo-viewer-1.0.0 --for=condition=Published
```

Or through the API with the admin token, which `task api` uses:

```sh
task api TARGET=k3s METHOD=POST ROUTE=/bundles BODY=@examples/repo-viewer/gadget.js
# {"digest":"<digest>"}
task api TARGET=k3s METHOD=PUT ROUTE=/blueprints/repo-viewer/1.0.0 \
  BODY='{"bundle":"<digest>","capabilities":["github:repo/*/*:read"]}'
```

A Blueprint version is immutable: to change the gadget, publish `1.0.1` and move cells to it.

### 2. Connect GitHub

Open `https://app.hiddenfield.dev/gatekeeper/`, log in, choose `github` and paste a token. A [fine-grained personal access token](https://github.com/settings/personal-access-tokens/new) with read-only *Contents* and *Metadata* on the repositories you want to view is enough. The Gatekeeper checks the token with GitHub, encrypts it with OpenBao, and stores only the ciphertext; neither the fleet nor the gadget ever sees it.

The same from the command line, given a session cookie:

```sh
curl -X PUT https://app.hiddenfield.dev/gatekeeper/api/connections/github \
  -H 'Origin: https://app.hiddenfield.dev' -H 'content-type: application/json' \
  -b cookies -d '{"token":"github_pat_..."}'
```

### 3. Create a cell and grant it a repository

From `https://app.hiddenfield.dev/`, or with the API as the logged-in user:

```sh
APP=https://app.hiddenfield.dev
curl -b cookies -H "Origin: $APP" -X POST "$APP/api/workspaces/team/cells" \
  -H 'content-type: application/json' -d '{"blueprint":"repo-viewer"}'
# {"id":"<cell>", ...}
curl -b cookies -H "Origin: $APP" -X PUT "$APP/api/workspaces/team/cells/<cell>/grants" \
  -H 'content-type: application/json' -d '{"grants":["github:repo/ipedrazas/kodo:read"]}'
```

Only the cell's owner can grant, and only what the Blueprint declares (`github:repo/*/*:read` covers any single repository). The gadget restarts with the new bindings; its storage is kept.

### 4. Open it

`https://<cell>.g.hiddenfield.dev/` shows the granted repositories. Share the cell with `PUT /api/workspaces/team/cells/<cell>/shares/<email>`: a viewer reads with your grants and token, and cannot change them.

To take access away, grant an empty list (`{"grants":[]}`), or disconnect GitHub at `/gatekeeper/`, after which every call is denied.

## Run it locally

The kernel's tests run this gadget under `celld dev` against a stand-in Gatekeeper that answers like GitHub:

```sh
cd kernel && node --test test/example.test.mjs
```

## What gets recorded

Each call is an object in the Gatekeeper's bucket under `audit/<yyyy>/<mm>/<dd>/`:

```json
{"time":"2026-10-01T10:00:00Z","decision":"allowed","fleet":"kodo/kodo","workspace":"team",
 "user":"<oidc subject>","email":"alice@hiddenfield.dev","blueprint":"repo-viewer","version":"1.0.0",
 "cell":"<cell>","grant":"github:repo/ipedrazas/kodo:read","method":"GET","path":"/readme","provider":"github"}
```

A call outside the grant is recorded with `"decision":"denied"` and the reason, and never reaches GitHub.
