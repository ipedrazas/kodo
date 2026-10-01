# OpenBao for the Gatekeeper

The Gatekeeper stores users' tokens only as ciphertext. It encrypts and decrypts them with OpenBao's transit engine and never holds the key: its policy allows `encrypt` and `decrypt` on one key and nothing else.

| File | What |
| --- | --- |
| [`gatekeeper-policy.hcl`](gatekeeper-policy.hcl) | The policy: `update` on `transit/encrypt/kodo-gatekeeper` and `transit/decrypt/kodo-gatekeeper` |
| [`setup.sh`](setup.sh) | Enables transit and AppRole if needed, creates the key, writes the policy and the role, and issues a `role_id` and `secret_id` |

## Set up

As an OpenBao administrator, with the `bao` CLI (or `vault`, with `BAO=vault`):

```sh
export BAO_ADDR=http://openbao.alacasa.uk:8200
export BAO_TOKEN=<an admin token>          # or `bao login` first
deploy/openbao/setup.sh --env-file .env    # or: task openbao:setup
```

It writes `OPENBAO_ADDR`, `OPENBAO_ROLE_ID` and `OPENBAO_SECRET_ID` into `.env`, leaving everything else in the file alone; without `--env-file` it prints them. Then deploy, or redeploy, the Gatekeeper:

```sh
task k3s:gatekeeper GATEKEEPER_IMAGE=ghcr.io/ipedrazas/kodo-gatekeeper:main
```

The script is safe to run again; each run issues a new `secret_id`, and earlier ones stay valid until they expire or you destroy them.

| What it creates | Settings |
| --- | --- |
| Transit key `transit/keys/kodo-gatekeeper` | `aes256-gcm96`, `derived=true` (each ciphertext is bound to a context, `kodo/vault/<user>/<provider>`, so one user's ciphertext does not decrypt as another's), not exportable, deletion not allowed |
| Policy `kodo-gatekeeper` | From `gatekeeper-policy.hcl` |
| AppRole `auth/approle/role/kodo-gatekeeper` | `token_ttl=1h`, `token_max_ttl=4h`, `secret_id_ttl=0` (never expires) |

Override with `TRANSIT_MOUNT`, `TRANSIT_KEY`, `APPROLE_MOUNT`, `ROLE`, `TOKEN_TTL`, `TOKEN_MAX_TTL`, `SECRET_ID_TTL`, and `BOUND_CIDRS` (e.g. `192.168.2.0/24`, so the `secret_id` and its tokens work only from the cluster's network). If you change the mount or key name, set `OPENBAO_TRANSIT_MOUNT` and `OPENBAO_TRANSIT_KEY` in the Gatekeeper's ConfigMap to match.

## Rotate the secret ID

```sh
deploy/openbao/setup.sh --rotate --env-file .env
task k3s:gatekeeper GATEKEEPER_IMAGE=...
```

The Gatekeeper reads the secret ID from its mounted Secret on every login, so it picks up the new one without a restart once the kubelet refreshes the mount. To revoke the old one, look up its accessor with `bao list auth/approle/role/kodo-gatekeeper/secret-id` and `bao write auth/approle/role/kodo-gatekeeper/secret-id-accessor/destroy secret_id_accessor=...`.

## Kubernetes auth instead of AppRole

The Gatekeeper can log in with its service account instead (`OPENBAO_AUTH=kubernetes`, `OPENBAO_ROLE=kodo-gatekeeper`, and `automountServiceAccountToken: true` on its pod). OpenBao then has to reach the cluster's API server to review tokens:

```sh
bao auth enable kubernetes
bao write auth/kubernetes/config kubernetes_host=https://<api-server>:6443 kubernetes_ca_cert=@ca.crt
bao write auth/kubernetes/role/kodo-gatekeeper \
  bound_service_account_names=kodo-gatekeeper bound_service_account_namespaces=kodo-system \
  token_policies=kodo-gatekeeper token_ttl=1h
```

## Test against a dev server

```sh
bao server -dev -dev-no-store-token -dev-root-token-id=root -dev-listen-address=127.0.0.1:18200 &
BAO_ADDR=http://127.0.0.1:18200 BAO_TOKEN=root deploy/openbao/setup.sh > /tmp/approle.env
set -a; . /tmp/approle.env; set +a
OPENBAO_TEST_ADDR=$OPENBAO_ADDR OPENBAO_TEST_ROLE_ID=$OPENBAO_ROLE_ID OPENBAO_TEST_SECRET_ID=$OPENBAO_SECRET_ID \
  go test ./internal/vault -run TestTransitAgainstOpenBao -v
```

The test encrypts and decrypts through the AppRole, checks that another context cannot decrypt, and checks that the role cannot read or export the key.
