# Ask

A kodo gadget that puts questions to a model and keeps the conversation. It is the smallest app that uses a model: it holds no API key, cannot choose a provider, and every token it uses counts against its owner's and its workspace's budgets.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App` |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `ask` version `1.0.0`, declaring `inference:model/*:invoke` |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

- Each model the owner grants, `inference:model/<name>:invoke`, is a binding in `this.grants`; the page offers them by name.
- A question is a `POST /chat/completions` on that binding with the last ten messages and `max_tokens: 256`. The Gatekeeper sends it to the platform's [inference gateway](../../deploy/inference/README.md), which picks the backend for the model; the answer's `model` says which backend model answered, and its `usage` how many tokens it took. The conversation is kept in the cell's own SQLite database.
- If the owner or the workspace is over budget, the question is refused with 429 and the page shows why.

## Deploy it

You need a fleet with a Gatekeeper and the inference gateway (on hiddenfield.dev: `task k3s:up`), a workspace and a login. These steps use hiddenfield.dev.

```sh
kubectl -n kodo apply -k examples/ask
kubectl -n kodo wait blueprint/ask-1.0.0 --for=condition=Published
```

Logged in as alice (the cookie jar from `test/e2e/lib.sh`'s `login`, or your browser's session), create a cell and grant it models:

```sh
curl -b jar -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"blueprint":"ask"}' https://app.hiddenfield.dev/api/workspaces/team/cells
curl -b jar -X PUT -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"grants":["inference:model/default:invoke","inference:model/sim:invoke"]}' \
  https://app.hiddenfield.dev/api/workspaces/team/cells/<cell>/grants
```

Open `https://<cell>.g.hiddenfield.dev/`, pick a model and ask. `GET https://app.hiddenfield.dev/api/workspaces/team/usage` shows the tokens your cells used this month.
