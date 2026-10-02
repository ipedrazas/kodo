# Operator

The kodo operator runs fleets and keeps their registries in step with Kubernetes resources. It reconciles three kinds in `kodo.dev/v1alpha1`:

| Kind | Becomes |
| --- | --- |
| `Fleet` | A celld StatefulSet, a public Service, a headless peers Service, NetworkPolicies, a Job that deploys the kernel image to the fleet's bucket, and, with a Gatekeeper, the fleet's signing key and its entry in the Gatekeeper's trusted fleets |
| `Blueprint` | One published Blueprint version in the fleet's catalog, as `POST /api/bundles` and `PUT /api/blueprints/:name/:version` |
| `Workspace` | A workspace with a quota, as `PUT /api/workspaces/:name`; its status shows the cell count |

## Install

```sh
kubectl apply -k config                      # CRDs, RBAC, and the operator in kodo-system
kubectl create namespace kodo
kubectl -n kodo create secret generic bucket \
  --from-literal=AWS_ACCESS_KEY_ID=... --from-literal=AWS_SECRET_ACCESS_KEY=...
kubectl -n kodo apply -f config/samples/fleet.yaml
kubectl -n kodo create configmap notes --from-file=notes.js=kernel/examples/notes.js
kubectl -n kodo apply -f config/samples/notes.yaml
```

Images are built by the Images workflow: `ghcr.io/ipedrazas/kodo-operator` and `ghcr.io/ipedrazas/kodo-kernel`, tagged `main` and `sha-<commit>` from main, and `pr-<number>` from pull requests (whose `sha-` tags name the PR's merge commit).

## Fleet

```yaml
spec:
  celld: ghcr.io/denoland/celld:0.6.0     # node image
  kernel: ghcr.io/ipedrazas/kodo-kernel:main
  replicas: 3
  runtimeClassName: gvisor                # optional
  idleEvictSeconds: 30
  bucket:
    name: kodo-dev                        # bucket[/prefix]
    endpoint: https://t3.storage.dev      # omit for AWS S3
    region: auto
    credentialsSecret: bucket             # AWS_ACCESS_KEY_ID, AWS_SECRET_ACCESS_KEY
  resources: {}                           # per node
  storageSize: 2Gi                        # per node, a cache of the bucket
  auth:                                   # optional; without it only the admin token works
    issuer: https://auth.example.com
    audience: kodo                        # the OIDC client id the gateway uses
    jwksURL: http://dex.auth.svc:5556/keys  # optional; defaults to <issuer>/keys
  gatekeeper: {}                          # optional; the defaults are:
    # namespace: kodo-system
    # service: kodo-gatekeeper
    # trustSecret: kodo-gatekeeper-fleets
  egress:                                 # optional; default-deny egress for the nodes
    proxy: true                           # HTTPS (the bucket) through the Gatekeeper's egress proxy
    allow: []                             # extra NetworkPolicy egress rules, e.g. the IdP's keys
```

- **Admin token**: the operator creates `<fleet>-admin-token` (key `token`) once and deploys the kernel with its hash. It calls the kernel API with it, and so can anyone who can read the Secret.
- **Identity settings** go to the kernel at deploy time, so changing `auth` runs a new deploy Job.

- **Kernel changes** start a new deploy Job for the new image. Nodes adopt the new kernel in place within one pointer poll (30 s), with no restart and no failed requests. `status.kernel` shows the last image that deployed successfully.
- **celld changes** stop the fleet: mixed celld versions cannot share a fleet, so the operator scales the StatefulSet to zero on the old image, waits until every node pod is gone, then starts the new image. The fleet serves nothing in between: about 20 s on kind and 36 s on the k3s cluster under gVisor. The `Upgrading` condition is true until every node runs the new image.
- **Shutdown**: a stopping node keeps serving for 5 s so Services stop routing to it, then gets 60 s for celld's handoff, above its 40 s bound.
- **The internal listener** (port 8081: the peer protocol and celld's unauthenticated operator API) accepts connections only from the fleet's own nodes. The cluster's network plugin must enforce NetworkPolicy.
- **Gatekeeper**: the operator creates `<fleet>-gatekeeper-key` once, adds it to the Gatekeeper's trust Secret as `<namespace>.<fleet>`, and deploys the kernel with the Gatekeeper's URL, the key and the fleet's name. A finalizer removes the entry when the Fleet is deleted or drops `gatekeeper`.
- **Egress**: with `egress` set, `<fleet>-egress` lets the nodes reach only DNS, their own fleet, the Gatekeeper (calls on 8081, egress proxy on 8082) and the `allow` rules. With `proxy: true` the nodes get `HTTPS_PROXY` pointing at the egress proxy, which tunnels only to the hosts in its `GATEKEEPER_EGRESS_ALLOW`; use it when the bucket endpoint has no fixed addresses to put in an `ipBlock`, as with Tigris. Without `egress` the nodes' outbound traffic is not restricted.
- **Deleting a Fleet** removes its pods, Services, Jobs and node volumes, and leaves the bucket untouched; a new Fleet on the same bucket finds every cell as it was.

## Blueprint

```yaml
spec:
  fleet: kodo
  blueprint: notes
  version: 1.0.0
  source: {name: notes, key: notes.js}    # a ConfigMap key
  capabilities: []
```

The spec is immutable, like the version it publishes. Re-applying the same source is a no-op; publishing a version that already exists with a different bundle sets `Published=False` with reason `Conflict`.

## Workspace

```yaml
spec:
  fleet: kodo
  quota: 50
```

The workspace takes the resource's name, which must be one DNS label. Deleting the resource leaves the workspace and its cells in the fleet.

## Gatekeeper

The Gatekeeper ([`cmd/gatekeeper`](../cmd/gatekeeper/main.go)) runs beside the operator in `kodo-system`, outside every fleet, from [`config/gatekeeper`](gatekeeper/gatekeeper.yaml). It serves three ports:

| Port | Who | What |
| --- | --- | --- |
| 8080 | Users, through the gateway at `app.<domain>/gatekeeper/` | A page and API to approve or reject queued calls and to connect and disconnect accounts; checks the user's ID token |
| 8081 | Fleet nodes only (NetworkPolicy) | `POST /v1/calls`: a kernel's signed capability call; `POST /v1/approvals/query`: the state of a cell's approvals |
| 8082 | Fleet nodes only (NetworkPolicy) | The egress proxy: `CONNECT` to allowed hosts |

It needs a ConfigMap `kodo-gatekeeper` (bucket, OIDC and egress settings), a Secret `kodo-gatekeeper-bucket` with credentials for a bucket no fleet can read, and a Secret `kodo-gatekeeper-openbao` with `OPENBAO_ADDR`, `OPENBAO_ROLE_ID` and `OPENBAO_SECRET_ID` from [`deploy/openbao/setup.sh`](../deploy/openbao/README.md). [`deploy/k3s/gatekeeper`](../deploy/k3s/gatekeeper/kustomization.yaml) is the hiddenfield.dev overlay.

In its bucket it keeps `vault/<user>/<provider>.json` (the OpenBao transit ciphertext of a user's token, bound to that user and provider), `approvals/<user>/<id>.json` (a queued call and what became of it) and `audit/<yyyy>/<mm>/<dd>/<time>-<id>.json` (one object per decision, created with a conditional write so none is overwritten). A call is recorded before it is made; if the record cannot be written, the call is refused.

### Approvals

A call whose verb is `write`, `send` or `delete` is checked against the grant and the owner's connection, then stored as a pending approval and answered `202`. The owner approves or rejects it on the page or with the API:

| Method | Path | |
| --- | --- | --- |
| GET | `/gatekeeper/api/approvals[?state=pending]` | The user's 50 most recent approvals, newest first |
| GET | `/gatekeeper/api/approvals/:id` | One approval |
| POST | `/gatekeeper/api/approvals/:id/approve` | Runs the call and answers when it has ended: `done` or `failed` |
| POST | `/gatekeeper/api/approvals/:id/reject` | |

Every state change is a write conditional on the object's ETag (`If-Match`), so of any number of replicas approving at once exactly one moves it from `pending` to `executing` and makes the call; the rest get 409. The approval moves to `done` with the provider's answer, or `failed`. A replica that dies mid-call leaves it `executing`; the first read after `GATEKEEPER_APPROVAL_STALE` (default 1 minute, well beyond the 15 s upstream timeout) moves it to `failed`, and nothing retries it. A pending approval expires after `GATEKEEPER_APPROVAL_TTL` (default 7 days). Calls are sent with `Idempotency-Key: <approval id>` for providers that deduplicate. The audit log records each step: `queued`, `approved` (with the approver), `executed` (with the upstream status), `failed`, `rejected`, `expired`. A call from an untrusted fleet is recorded as `untrusted`.

The `email` provider sends through Resend (`RESEND_API_URL`, default `https://api.resend.com`); each user connects their own API key and the From address, which must be on a domain the key's account has verified (or `onboarding@resend.dev`).

### Web

With `GATEKEEPER_WEB_ALLOW` set (a host, `*.domain` or `*`, comma-separated), the Gatekeeper has a `web` provider: `web:<host>[/<path>]:read` reads a public HTTPS API with no credentials, e.g. `web:hn.algolia.com/api/v1:read`. It is a platform provider, so users connect nothing and it is not offered on the page. Calls are `GET` or `HEAD` under the granted path, carry only `Accept`, `Accept-Language`, `If-None-Match` and `If-Modified-Since` and no identity, and go through a client with no proxy that connects only to public addresses: the check runs on the address actually dialled, after name resolution, so no name can lead it into the cluster. Hosts must be DNS names; IP literals, ports and names under `.svc`, `.local`, `.internal`, `.lan` and similar are refused. Redirects are returned, not followed.

### Inference

With `INFERENCE_URL` set, the Gatekeeper has an `inference` provider: `inference:model/<name>:invoke` grants a model behind the inference gateway ([`deploy/inference`](../deploy/inference/README.md)). It is a platform provider, so users connect nothing and it is not offered on the page; the platform's keys for the model backends live at the gateway. The Gatekeeper takes the gadget's chat completion, refuses fields outside a small allowlist (some backends read fields that pick another model), streaming and `n` above 1, sets `model` to the granted name, and sends it with the key from `INFERENCE_KEY_FILE` (Secret `kodo-gatekeeper-inference`, optional) and three headers the gateway budgets and labels metrics on: `x-kodo-user` (the owner's subject), `x-kodo-workspace` (`<fleet namespace>/<fleet>/<workspace>`) and `x-kodo-blueprint`. A call may take `INFERENCE_TIMEOUT` (default 120 s; the gateway's route for each model and the kernel's 25 s for a gadget's calls bound them further). The decision is recorded before the call as `allowed`, and what it used afterwards as `metered`, with the upstream status and `usage` (`model`, `input`, `output`, `total` tokens); the kernel gets the same usage in the answer and counts it for the cell. A refusal by the gateway's budgets reaches the gadget as 429 with `{"error"}` and `x-ratelimit-reset`.

## How the operator reaches the kernel

Through the Kubernetes API server's service proxy (`services/proxy` on the fleet's Service), so it works the same in and out of the cluster and the fleet needs no ingress for it.

## Develop

```sh
task operator:generate        # deepcopy, CRDs and ClusterRole from the Go types
task operator:e2e:kind        # build images, run the operator from source, run test/e2e/operator.sh
```

`task operator:e2e:cluster` runs the same test on an existing cluster with published images and the bucket in `.env`, with the operator installed in the cluster from `OPERATOR_IMAGE` (or run from source if unset).
