# hiddenfield.dev on the k3s cluster

The LAN environment: cert-manager, Envoy Gateway, Dex and the operator-managed `kodo` fleet, served at `app.hiddenfield.dev` and `*.g.hiddenfield.dev`. Public access through the VPS proxy is [issue #8](https://github.com/ipedrazas/kodo/issues/8).

| Piece | Where |
| --- | --- |
| Gateway | Envoy Gateway, namespace `kodo-gateway`, MetalLB address **192.168.2.224** |
| Certificate | Let's Encrypt via Cloudflare DNS-01: `app`, `auth` and `*.g.hiddenfield.dev`, renewed by cert-manager |
| Identity provider | Dex at `https://auth.hiddenfield.dev`, namespace `kodo-auth`, users `alice` and `bob` |
| Fleet | `Fleet/kodo` in namespace `kodo`, bucket `kodo-dev`, default-deny egress |
| Gatekeeper | `kodo-gatekeeper` in `kodo-system`, bucket `kodo-dev-gatekeeper`, OpenBao at `openbao.alacasa.uk`; users connect accounts at `app.hiddenfield.dev/gatekeeper/` |
| Login | `SecurityPolicy/kodo-login`: OIDC with Dex, one session cookie on `.hiddenfield.dev` |
| Inference gateway | Envoy AI Gateway, namespace `kodo-inference`, Service `kodo-inference.envoy-gateway-system.svc` (Gatekeeper only); models `default` (OpenRouter) and `sim` (in-cluster simulator); budgets in Redis. See [deploy/inference](../inference/README.md) |

## Bring it up

`.env` needs the Tigris admin key (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_IAM`), `CLOUDFLARE_API_TOKEN` (Zone DNS Edit and Zone Read on hiddenfield.dev), `LETSENCRYPT_EMAIL`, the Gatekeeper's OpenBao AppRole, which `task openbao:setup` writes (see [deploy/openbao](../openbao/README.md)), and `OPENROUTER_API_KEY` for the `default` model. The approvals test also needs `RESEND_API_KEY` and `RESEND_FROM`, a From address on a domain verified in that Resend account. `helm` must be on `PATH` for the AI Gateway charts.

```sh
BAO_ADDR=http://openbao.alacasa.uk:8200 BAO_TOKEN=<admin> task openbao:setup   # once
task k3s:up KERNEL_IMAGE=ghcr.io/ipedrazas/kodo-kernel:main OPERATOR_IMAGE=ghcr.io/ipedrazas/kodo-operator:main \
  GATEKEEPER_IMAGE=ghcr.io/ipedrazas/kodo-gatekeeper:main
task k3s:identity-test
task k3s:gatekeeper-test        # Phase 7: grants, the Gatekeeper, egress, the vault and audit
task k3s:approvals-test         # Phase 8: the approval queue; restarts the Gatekeeper twice
task k3s:inference-test         # Phase 9: models through grants, routing, budgets and usage
```

## Bucket keys

The admin key in `.env` is used only to create two scoped keys, once, with `task k3s:bucket-keys` ([`bucket-keys.sh`](bucket-keys.sh)), into `.buckets.env` (git-ignored):

| Key | Can read and write | Used by |
| --- | --- | --- |
| `FLEET_*` | `kodo-dev` only | the fleet's nodes and kernel deploy Job (Secret `kodo/bucket`) |
| `GATEKEEPER_*` | `kodo-dev-gatekeeper` only | the Gatekeeper (Secret `kodo-system/kodo-gatekeeper-bucket`): `vault/`, `approvals/`, `audit/` |

They are Tigris IAM policies on access keys, so a fleet's credentials cannot list or read the Gatekeeper's bucket. The fleet key passes `celld diagnose`.

## Egress

The fleet's nodes can open connections only to DNS, each other, the Gatekeeper (8081 for calls, 8082 for the egress proxy) and Dex's keys. Tigris's addresses change with DNS, so the nodes reach the bucket through the Gatekeeper's egress proxy (`HTTPS_PROXY`), which tunnels only to `t3.storage.dev` and `*.t3.storage.dev`. Anything else, GitHub and the model providers included, is refused. Models are reached only through the Gatekeeper, which is the only client the inference gateway admits.

`k3s:up` creates `.auth.env` (git-ignored) with the Dex client secret and the test users' passwords on first run. Log in as `alice@hiddenfield.dev` or `bob@hiddenfield.dev` with those passwords.

## DNS

`app`, `auth` and `*.g` must resolve to 192.168.2.224, as DNS-only records: Cloudflare's proxy certificate does not cover second-level wildcards. The certificate itself needs no DNS records beyond the ones cert-manager creates for each challenge.

## How a request is authenticated

1. Envoy Gateway sends a request without a session to Dex. After login, Dex redirects to `app.hiddenfield.dev/oauth2/callback`, and the gateway sets its session cookies on `.hiddenfield.dev`, so one login covers the app and every cell.
2. The gateway forwards the user's ID token to the kernel in `x-kodo-identity`.
3. The kernel verifies the token against Dex's keys (fetched in-cluster), checks the cell's owner and shares, and removes the token and session cookies before the gadget sees the request.
