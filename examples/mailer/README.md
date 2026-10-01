# Mailer

A kodo gadget that drafts emails and sends each one only after its owner approves it. It is the smallest app that uses a side-effecting capability: it never sees an API key, cannot choose the sender, and cannot send anything on its own.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App` |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `mailer` version `1.0.0`, declaring `email:outbox:send` |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

- A draft is a `POST` on the binding `this.grants["email:outbox:send"]`. The Gatekeeper checks it is a well-formed message within the grant, parks it in its approval queue and answers at once: `202`, with the approval's id in `x-kodo-approval`. The mailer keeps the draft in its outbox, in the cell's own SQLite database.
- The owner sees the exact message (sender, recipients, subject, body) at `app.<domain>/gatekeeper/` and approves or rejects it. Approving sends it through Resend with the owner's key, once, from the address the owner connected.
- The cell asks the Gatekeeper about the draft until it settles, and then calls the mailer's `onApproval(approval)`, which records `done` (with Resend's answer), `rejected`, `failed` or `expired`. This works while the cell hibernates: the cell's alarm wakes it.
- `GET /api/outbox/<id>?check=1` asks the Gatekeeper directly with `this.approval(id)`, for a page that cannot wait for the cell.

```
browser ──► <cell>.g.<domain> ──► kernel ──► mailer: grants["email:outbox:send"].fetch(POST draft)
                                   │  signed call                      ▲
                                   ▼                                   │ onApproval (cell alarm,
                              Gatekeeper ── approvals/<user>/<id> ─────┘  /v1/approvals/query)
                                   ▲  pending ──► executing ──► done | failed
owner ──► app.<domain>/gatekeeper/ ┘  (approve: one replica wins, sends once)
                                   ▼
                          api.resend.com/emails  (owner's key from OpenBao, Idempotency-Key)
```

## Deploy it

You need a fleet with a Gatekeeper (on hiddenfield.dev: `task k3s:up`), a workspace, a login, and a [Resend](https://resend.com) account with a verified domain. These steps use hiddenfield.dev; replace the domain with yours.

### 1. Publish the Blueprint

```sh
kubectl -n kodo apply -k examples/mailer
kubectl -n kodo wait blueprint/mailer-1.0.0 --for=condition=Published
```

### 2. Connect email

Open `https://app.hiddenfield.dev/gatekeeper/`, choose `email`, and give a Resend API key (*sending access* is enough) and the From address to send as, on a domain verified in that Resend account. With a full-access key the Gatekeeper checks the domain is verified; with a sending-only key Resend checks it when it sends. The key is encrypted with OpenBao and stored only as ciphertext.

```sh
curl -X PUT https://app.hiddenfield.dev/gatekeeper/api/connections/email \
  -H 'Origin: https://app.hiddenfield.dev' -H 'content-type: application/json' \
  -b cookies -d '{"token":"re_...","account":"You <you@example.com>"}'
```

### 3. Create a cell and grant it email

```sh
APP=https://app.hiddenfield.dev
curl -b cookies -H "Origin: $APP" -X POST "$APP/api/workspaces/team/cells" \
  -H 'content-type: application/json' -d '{"blueprint":"mailer"}'
curl -b cookies -H "Origin: $APP" -X PUT "$APP/api/workspaces/team/cells/<cell>/grants" \
  -H 'content-type: application/json' -d '{"grants":["email:outbox:send"]}'
```

### 4. Draft, approve, see it sent

Open `https://<cell>.g.hiddenfield.dev/`, write a draft and send it for approval. It appears as pending in the mailer, and at `https://app.hiddenfield.dev/gatekeeper/` (the home page shows how many calls wait). Approve it there; within a minute the mailer shows it sent, with Resend's id. Editors of a shared cell can draft too; only the owner approves, and every email goes from the owner's address.

## Run it locally

The kernel's tests run this gadget under `celld dev` against a stand-in Gatekeeper that queues every send:

```sh
cd kernel && node --test test/mailer.test.mjs
```

## What gets recorded

Each step is an object in the Gatekeeper's bucket under `audit/<yyyy>/<mm>/<dd>/`, with the approval's id:

```json
{"time":"2026-10-01T10:00:00Z","decision":"queued","fleet":"kodo/kodo","workspace":"team","user":"<oidc subject>","email":"alice@hiddenfield.dev","blueprint":"mailer","version":"1.0.0","cell":"<cell>","grant":"email:outbox:send","method":"POST","provider":"email","approval":"<id>"}
{"time":"2026-10-01T10:02:13Z","decision":"approved", ... "email":"alice@hiddenfield.dev","approval":"<id>"}
{"time":"2026-10-01T10:02:14Z","decision":"executed", ... "approval":"<id>","status":200}
```

A rejected draft ends with `"decision":"rejected"`; one that no one decides on ends with `"decision":"expired"` after 7 days.
