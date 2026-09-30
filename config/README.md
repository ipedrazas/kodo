# Operator

The kodo operator runs fleets and keeps their registries in step with Kubernetes resources. It reconciles three kinds in `kodo.dev/v1alpha1`:

| Kind | Becomes |
| --- | --- |
| `Fleet` | A celld StatefulSet, a public Service, a headless peers Service, a NetworkPolicy, and a Job that deploys the kernel image to the fleet's bucket |
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
```

- **Kernel changes** start a new deploy Job for the new image. Nodes adopt the new kernel in place within one pointer poll (30 s), with no restart and no failed requests. `status.kernel` shows the last image that deployed successfully.
- **celld changes** stop the fleet: mixed celld versions cannot share a fleet, so the operator scales the StatefulSet to zero on the old image, waits until every node pod is gone, then starts the new image. The fleet serves nothing in between: about 20 s on kind and 36 s on the k3s cluster under gVisor. The `Upgrading` condition is true until every node runs the new image.
- **Shutdown**: a stopping node keeps serving for 5 s so Services stop routing to it, then gets 60 s for celld's handoff, above its 40 s bound.
- **The internal listener** (port 8081: the peer protocol and celld's unauthenticated operator API) accepts connections only from the fleet's own nodes. The cluster's network plugin must enforce NetworkPolicy.
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

## How the operator reaches the kernel

Through the Kubernetes API server's service proxy (`services/proxy` on the fleet's Service), so it works the same in and out of the cluster and the fleet needs no ingress for it.

## Develop

```sh
task operator:generate        # deepcopy, CRDs and ClusterRole from the Go types
task operator:e2e:kind        # build images, run the operator from source, run test/e2e/operator.sh
```

`task operator:e2e:cluster` runs the same test on an existing cluster with published images and the bucket in `.env`, with the operator installed in the cluster from `OPERATOR_IMAGE` (or run from source if unset).
