# Runbook

How to check, deploy, change and repair a running kodo platform. The examples use the hiddenfield.dev environment on the k3s cluster (kube context `default`, see [deploy/k3s](../deploy/k3s/README.md)); on another cluster the names are the same apart from the domain, the fleet's namespace and the IdP. How the pieces fit is in [architecture.md](architecture.md).

## At a glance

| What | Where | Healthy when |
| --- | --- | --- |
| Fleet `kodo` | namespace `kodo`, pods `kodo-0..2` | `Ready=True`, `KernelDeployed=True`, `Upgrading=False`; pods ready on `/.well-known/celld/health` |
| Operator | `kodo-system/kodo-operator` | Running; no reconcile errors in its log |
| Gatekeeper | `kodo-system/kodo-gatekeeper` | Ready on `/healthz` (port 8080) |
| Agent | `kodo-system/kodo-agent` | Ready on `/healthz` |
| Inference gateway | `kodo-inference`, Service `kodo-inference.envoy-gateway-system.svc` | Gateway `Programmed`; AI Gateway controller running in `envoy-ai-gateway-system` |
| Gateway | `kodo-gateway`, 192.168.2.224 | `app`, `auth`, `*.g.hiddenfield.dev` serve with a valid certificate |
| IdP | Dex, `kodo-auth` | Ready on `/healthz` |
| OpenBao | `openbao.alacasa.uk:8200` (outside the cluster) | Reachable from the cluster |
| Buckets | Tigris `kodo-dev` (fleet), `kodo-dev-gatekeeper` | `celld diagnose` passes with the fleet key |

Local files the tasks read, all git-ignored: `.env` (Tigris admin key, Cloudflare token, OpenBao AppRole, `OPENROUTER_API_KEY`, `RESEND_*`), `.buckets.env` (the scoped fleet and Gatekeeper keys), `.auth.env` (the Dex client secret, the tap client's `TAP_CLIENT_SECRET`, which you add by hand, and the test users' passwords).

## Health check

```sh
kubectl -n kodo get fleet kodo -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
kubectl -n kodo get fleet kodo -o jsonpath='{.status.kernel}{"\n"}'          # last kernel image that deployed
kubectl -n kodo get pods -o wide
kubectl -n kodo-system get deploy,pods
kubectl -n kodo-inference get gateway,pods
task api TARGET=k3s ROUTE=/version                                             # the kernel's build
curl -sI https://app.hiddenfield.dev/ | head -1                                # 302 to Dex without a session
```

The admin dashboard, `https://app.hiddenfield.dev/admin/` (as `carol@hiddenfield.dev`), shows the kernel build, the nodes and conditions the operator last reported (refreshed every minute), budgets and spend, and the audit log.

End-to-end checks, each safe to run against the live environment:

| Task | Checks |
| --- | --- |
| `task k3s:identity-test` | Login, TLS, sharing |
| `task k3s:gatekeeper-test` | Grants, Gatekeeper reads, egress, vault, audit |
| `task k3s:approvals-test` | Approval queue with Resend; restarts the Gatekeeper twice |
| `task k3s:inference-test` | Model grants, routing, budgets, usage |
| `task k3s:examples-test` | daybreak and hn-reader through the gateway |
| `task k3s:chat-test` | Socket push; holds a quiet socket for `QUIET_S` (600 s) |
| `task k3s:agent-test` | Agent runs; restarts the agent twice |
| `task k3s:authoring-test` | Agent-written gadgets, publishing |
| `task k3s:admin-test` | Admins, membership, settings, withdrawal, suspension, audit; switches the agent to the simulator for one turn |

## Logs

```sh
kubectl -n kodo logs kodo-0 --tail=200                    # celld and the kernel's console output, per node
kubectl -n kodo-system logs deploy/kodo-operator --tail=200
kubectl -n kodo-system logs deploy/kodo-gatekeeper --tail=200
kubectl -n kodo-system logs deploy/kodo-agent --tail=200
kubectl -n kodo-auth logs deploy/dex --tail=200
kubectl -n kodo get jobs                                  # kernel deploy Jobs; their logs show a failed deploy
```

What a gadget or the agent did with a capability is in the audit log: `/admin/` → Audit, filtered by user, workspace, cell, Blueprint or decision (`allowed`, `denied`, `untrusted`, `metered`; for approvals `queued`, `approved`, `executed`, `failed`, `rejected`, `expired`; and the events `authored`, `published`, `admin`).

## Deploy

CI builds `ghcr.io/ipedrazas/kodo-{kernel,operator,gatekeeper,agent}` for amd64 and arm64, tagged `main` and `sha-<commit>` from main and `pr-<number>` from pull requests. **Deploy by `sha-<commit>`, never `:main`**: nodes cache an old `:main` and the pull policy is `IfNotPresent`. A PR's `sha-` tag is its merge commit, not its head; list them with `gh api /users/ipedrazas/packages/container/kodo-<image>/versions`.

Record what you deployed (image tags per component) where the team can see it.

### Kernel

```sh
kubectl -n kodo patch fleet kodo --type merge -p '{"spec":{"kernel":"ghcr.io/ipedrazas/kodo-kernel:sha-<commit>"}}'
kubectl -n kodo get jobs -w                               # the deploy Job
kubectl -n kodo get fleet kodo -o jsonpath='{.status.kernel}{"\n"}'
task api TARGET=k3s ROUTE=/version
```

Nodes adopt the new kernel within 30 s without a restart. For about 30 s after that, Durable Objects that were active keep the old code, so a new RPC method can fail with `is not a function` until they are evicted. That clears by itself.

### Operator, Gatekeeper, agent

```sh
kubectl -n kodo-system set image deploy/kodo-operator operator=ghcr.io/ipedrazas/kodo-operator:sha-<commit>
task k3s:gatekeeper GATEKEEPER_IMAGE=ghcr.io/ipedrazas/kodo-gatekeeper:sha-<commit>
task k3s:agent AGENT_IMAGE=ghcr.io/ipedrazas/kodo-agent:sha-<commit>
```

If the operator's ClusterRole or the CRDs changed, `kubectl apply -k config` first. The Gatekeeper and agent tasks also apply their ConfigMaps from `deploy/k3s/{gatekeeper,agent}`; kustomize gives each a new hashed name, and old `kodo-agent-<hash>` ConfigMaps linger harmlessly.

### celld

Change `Fleet.spec.celld`. **This is an outage**: mixed celld versions cannot share a fleet, so the operator stops every node before starting the new image (about 36 s on k3s under gVisor). Announce it, then:

```sh
kubectl -n kodo patch fleet kodo --type merge -p '{"spec":{"celld":"ghcr.io/denoland/celld:<version>"}}'
kubectl -n kodo get fleet kodo -w                         # Upgrading=True until every node runs the new image
```

Check the celld release notes and [the upstream report](../spike/celld/upstream/celld-0.6.0-report.md) first; the kernel image bundles its own celld for deploying and may need to move with it.

### Inference models and rate limits

Edit [`deploy/inference/models.yaml`](../deploy/inference/models.yaml) or [`budgets.yaml`](../deploy/inference/budgets.yaml) and `kubectl apply -k deploy/inference`. Changes take a few seconds; expect a handful of 500s while a model moves between backends. If the AI Gateway controller is down, Envoy Gateway keeps the last configuration and applies nothing new (it fails closed).

### Platform settings

The agent's model, output limit and steps per turn, new chats' grants, and monthly token budgets are runtime settings: change them at `/admin/`, not in env vars or YAML. They apply on the next turn or call, and each change is audited.

### Rollback

Deploy the previous `sha-` tag the same way. Kernel and Go services roll back without data changes. A celld rollback is another full stop of the fleet. Bucket state is forward-compatible only as far as celld promises; do not roll celld back across a release that changed its storage format.

## Routine operations

### Call the kernel API as the operator

```sh
task api TARGET=k3s ROUTE=/workspaces
task api TARGET=k3s METHOD=PUT ROUTE=/workspaces/team BODY='{"quota":50}'
```

This runs curl in a `client` pod in `kodo` with the fleet's admin token. If the pod is stuck `Unknown`, `kubectl -n kodo delete pod client` and run the task again.

### Publish or withdraw a Blueprint

Apply a `Blueprint` resource ([config/README.md#blueprint](../config/README.md#blueprint)); its spec is immutable, so a new version is a new resource. Deleting the resource withdraws the version: no new cells, existing cells keep running. Platform admins can also withdraw and restore at `/admin/`.

### Users and admins

- **Add a user**: they need an account at the IdP. On k3s, add a static password to [`deploy/k3s/dex.yaml`](../deploy/k3s/dex.yaml) and its hash to `dex-secrets` (see [`auth-secrets.sh`](../deploy/k3s/auth-secrets.sh)).
- **Add them to a workspace**: a workspace admin does it in `/settings/`, or `PUT /api/workspaces/:ws/members/:email`.
- **Make someone a platform admin**: add them to the IdP group in `Fleet.spec.admins.group`, or their email to `spec.admins.emails` (the IdP must mark it verified). Changing `admins` runs a new kernel deploy Job.
- **Suspend a user**: `/admin/` → Users. Takes effect everywhere within 5 s, including their cells' alarms.

### Rotate secrets

| Secret | How |
| --- | --- |
| OpenBao AppRole `secret_id` | `deploy/openbao/setup.sh --rotate --env-file .env`, then `task k3s:gatekeeper GATEKEEPER_IMAGE=<current>`. Destroy the old accessor ([deploy/openbao](../deploy/openbao/README.md#rotate-the-secret-id)) |
| OpenRouter key | Update `OPENROUTER_API_KEY` in `.env`, `task k3s:inference` (restarts the Gatekeeper) |
| Inference gateway key | Delete `kodo-system/kodo-gatekeeper-inference`, `task k3s:inference` |
| Fleet admin token | Delete Secret `kodo/kodo-admin-token` and the current kernel deploy Job (`kubectl -n kodo get jobs`). The operator creates a new token and runs the Job again, which deploys the kernel with the new hash. Check with `task api TARGET=k3s ROUTE=/version` |
| Bucket keys | Revoke in Tigris, remove `.buckets.env`, `task k3s:bucket-keys`, then re-run `task k3s:gatekeeper` and recreate Secret `kodo/bucket` (see `k3s:up`) and restart the fleet's nodes one at a time |
| Dex client secret | Edit `.auth.env`, run `deploy/k3s/auth-secrets.sh`, restart Dex |

### A new fleet

Apply a `Fleet` ([config/samples/fleet.yaml](../config/samples/fleet.yaml)). The operator adds its key to the Gatekeeper's trust Secret, but the Gatekeeper sees it only after the kubelet refreshes the mount, about 2 minutes. Until then the fleet's calls are refused and audited as `untrusted`.

## Troubleshooting

### A cell or the dashboard fails with `RestoreFailed`

Symptoms: a page shows `Worker failed: rejected: … RestoreFailed`; the chat shows `Unexpected token 'W' … not valid JSON`; it persists across requests.

Cause: a celld bug. When bucket timeouts make peer nodes self-fence (exit 3) and restart with new node IDs, the node holding the cell's live log session still lists the old IDs as followers, and every restore fails.

```sh
kubectl -n kodo logs <pod> | grep -E 'follower tail|fold session'
```

Find the node named in `fold session node_X/…`, then restart that pod: `kubectl -n kodo delete pod kodo-<n>`. The cell restores elsewhere within a minute. Not yet reported upstream.

### Requests return 401, or login loops

- The IdP's keys must be reachable from fleet nodes: the egress `allow` rule for Dex's `/keys`, and `Fleet.spec.auth.jwksURL`.
- Clock skew on nodes makes valid tokens look expired.
- If Dex is crash-looping, check its log for a missing `secretEnv`. `dex.yaml` names `TAP_CLIENT_SECRET` for the `tap` client; `auth-secrets.sh` copies it from `.auth.env` into `dex-secrets` and stops if it is missing there. Restart Dex after changing the Secret.

### Capability calls fail

| Seen by the gadget | Likely cause | Check |
| --- | --- | --- |
| No binding in `this.grants` | Capability not granted, or not declared by the cell's Blueprint version (moving a cell to a version that does not declare it drops the grant) | `/settings/` → the cell's grants |
| 403/401 from the Gatekeeper, audit `untrusted` | Fleet not yet in the trust Secret (new fleet: wait 2 min) or key mismatch | `kubectl -n kodo-system get secret kodo-gatekeeper-fleets` |
| 5xx, audit write errors in the Gatekeeper log | Gatekeeper cannot write `audit/`, so it refuses every call | Gatekeeper bucket credentials and reachability |
| 5xx on calls that need a user's token | OpenBao unreachable or AppRole expired/revoked | Gatekeeper log; reach `openbao.alacasa.uk:8200` from a pod |
| 403 from the provider | The user's connected token lacks the scope, or was revoked | User reconnects at `/gatekeeper/` |
| `web:` call refused | Host not in `GATEKEEPER_WEB_ALLOW`, or resolves to a private address | ConfigMap `kodo-gatekeeper` |

### An approval is stuck

`pending` until the owner decides, or 7 days (`GATEKEEPER_APPROVAL_TTL`) then `expired`. `executing` for more than a minute means the replica died mid-call: the next read marks it `failed`, and nothing retries it, because the call may have happened. Check with the provider before asking the user to try again. A cell learns of the outcome on its next alarm (at most a minute).

### Model calls fail

| Symptom | Cause | Fix |
| --- | --- | --- |
| 429 with `{"error"}` | The owner's or workspace's monthly token budget is spent (kernel) | Raise it at `/admin/` → Budgets |
| 429 with `x-ratelimit-*` and an empty body | Over 60 calls a minute per user (gateway) | Wait, or change `budgets.yaml` |
| 429 with a body | The backend's own rate limit | Provider side |
| Agent says "inference is unreachable" or calls time out | A timeout in the chain: gateway route `timeouts.request`, `INFERENCE_TIMEOUT` (120 s), kernel `AGENT_MODEL_TIMEOUT_MS` (130 s), agent client (150 s). Gadget calls are bounded at 25 s | Find which hop cut it from the logs; a reasoning model may spend all its time and tokens reasoning: the `agent` route disables reasoning with a `bodyMutation` |
| 413 | Envoy request buffer; the agent's long transcripts | `ClientTrafficPolicy` `bufferLimit` in `deploy/inference/gateway.yaml` |
| Agent: "My answer was cut off" | Output limit too low for a whole gadget | Raise max tokens at `/admin/` |
| 500s for a few seconds after a model change | Known gateway behaviour while routes update | Wait |

To test the gateway directly, port-forward `svc/kodo-inference` in `envoy-gateway-system` and send `x-kodo-gateway-key` from Secret `kodo-system/kodo-gatekeeper-inference`. **Never print the AI Gateway's extproc config Secrets**: they contain the OpenRouter key.

### WebSockets drop or never open

- A socket idle for 5 minutes is dropped by the gateway. Clients must ping; the cell answers `ping` with `pong` without waking the gadget.
- After thousands of socket opens on one node, some upgrades never get their `101` and fail after 300 s (celld bug). Restart that node pod: `kubectl -n kodo delete pod kodo-<n>`.
- celld allows 64 in-flight requests per cell; more queue.

### A node is out of memory or restarting

Each distinct gadget bundle costs about 7 MiB per node and is never released; many distinct Blueprint versions (including agent drafts) fill memory. Restarting a node frees it; raising `Fleet.spec.resources` buys headroom. Gadgets can allocate ArrayBuffers outside the 128 MiB heap limit, so one gadget can take a node down: find it from the node's log and the cell's usage, and suspend its owner or withdraw its version.

### Kernel deploy Job fails

`kubectl -n kodo logs job/<name>`. Usual causes: the image tag does not exist, or the Job cannot reach the bucket (egress proxy allowlist, bucket key). `status.kernel` keeps the last good image and nodes keep serving it.

### Images do not change after a deploy

You deployed `:main`, or a tag already cached on the node. Deploy by `sha-<commit>`.

## Disaster recovery

The buckets are the only state that matters. Pods, volumes and the Gatekeeper are disposable.

| Lost | Recovery |
| --- | --- |
| A fleet node, or its volume | Nothing to do: celld restores its cells elsewhere from the bucket |
| The whole fleet (namespace or Fleet deleted) | Recreate the bucket Secret and the `Fleet` on the same bucket; every cell is found as it was. Re-apply `Blueprint` and `Workspace` resources |
| The Gatekeeper | Redeploy with `task k3s:gatekeeper`; its state is in its bucket |
| OpenBao transit key | Users' stored tokens cannot be decrypted; every user reconnects at `/gatekeeper/`. The key is created with deletion disallowed: back up OpenBao |
| Redis | Rate-limit counters reset; budgets are in the kernel and unaffected |
| The cluster | Rebuild with `task k3s:up` and the same buckets and `.env`, `.buckets.env`, `.auth.env` |
| A bucket | Not recoverable from kodo. Rely on the provider's versioning or replication |

## Never

- Never `celld deploy` into the fleet bucket by hand: it holds the kernel.
- Never deploy `:main`; use `sha-` tags.
- Never label a scratch pod `app.kubernetes.io/name=kodo-gatekeeper` in `kodo-system`: the Gatekeeper Service will send it traffic.
- Never print Secrets that hold provider keys (`openrouter`, extproc configs, `kodo-gatekeeper-*`) into logs or chat.
- Never give a fleet the Gatekeeper bucket's credentials, or the Tigris admin key.
