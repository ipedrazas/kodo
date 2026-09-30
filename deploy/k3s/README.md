# hiddenfield.dev on the k3s cluster

The LAN environment: cert-manager, Envoy Gateway, Dex and the operator-managed `kodo` fleet, served at `app.hiddenfield.dev` and `*.g.hiddenfield.dev`. Public access through the VPS proxy is [issue #8](https://github.com/ipedrazas/kodo/issues/8).

| Piece | Where |
| --- | --- |
| Gateway | Envoy Gateway, namespace `kodo-gateway`, MetalLB address **192.168.2.224** |
| Certificate | Let's Encrypt via Cloudflare DNS-01: `app`, `auth` and `*.g.hiddenfield.dev`, renewed by cert-manager |
| Identity provider | Dex at `https://auth.hiddenfield.dev`, namespace `kodo-auth`, users `alice` and `bob` |
| Fleet | `Fleet/kodo` in namespace `kodo`, bucket `kodo-dev` |
| Login | `SecurityPolicy/kodo-login`: OIDC with Dex, one session cookie on `.hiddenfield.dev` |

## Bring it up

`.env` needs the bucket credentials, `CLOUDFLARE_API_TOKEN` (Zone DNS Edit and Zone Read on hiddenfield.dev) and `LETSENCRYPT_EMAIL`.

```sh
task k3s:up KERNEL_IMAGE=ghcr.io/ipedrazas/kodo-kernel:main OPERATOR_IMAGE=ghcr.io/ipedrazas/kodo-operator:main
task k3s:identity-test
```

`k3s:up` creates `.auth.env` (git-ignored) with the Dex client secret and the test users' passwords on first run. Log in as `alice@hiddenfield.dev` or `bob@hiddenfield.dev` with those passwords.

## DNS

`app`, `auth` and `*.g` must resolve to 192.168.2.224, as DNS-only records: Cloudflare's proxy certificate does not cover second-level wildcards. The certificate itself needs no DNS records beyond the ones cert-manager creates for each challenge.

## How a request is authenticated

1. Envoy Gateway sends a request without a session to Dex. After login, Dex redirects to `app.hiddenfield.dev/oauth2/callback`, and the gateway sets its session cookies on `.hiddenfield.dev`, so one login covers the app and every cell.
2. The gateway forwards the user's ID token to the kernel in `x-kodo-identity`.
3. The kernel verifies the token against Dex's keys (fetched in-cluster), checks the cell's owner and shares, and removes the token and session cookies before the gadget sees the request.
