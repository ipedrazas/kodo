# hiddenfield.dev on the k3s cluster

The LAN environment: cert-manager, Envoy Gateway and the operator-managed `kodo` fleet, served at `app.hiddenfield.dev` and `*.g.hiddenfield.dev`, with Authrim at `auth.applet.one` as the identity provider. Public access is a Cloudflare Tunnel at `kodo.applet.one`, [below](#public-access); the step-by-step is in [docs/public-access.md](../../docs/public-access.md).

| Piece | Where |
| --- | --- |
| Gateway | Envoy Gateway, namespace `kodo-gateway`, MetalLB address **192.168.2.224** |
| Certificate | Let's Encrypt via Cloudflare DNS-01: `app`, `auth` and `*.g.hiddenfield.dev`, renewed by cert-manager |
| Identity provider | Authrim at `https://auth.applet.one` (Admin UI at `https://adm.applet.one`), client `kodo`, outside the cluster. Dex still runs in `kodo-auth` at `https://auth.hiddenfield.dev`, for `tap.hiddenfield.dev` only: kodo no longer accepts its tokens |
| Fleet | `Fleet/kodo` in namespace `kodo`, bucket `kodo-dev`, default-deny egress |
| Gatekeeper | `kodo-gatekeeper` in `kodo-system`, bucket `kodo-dev-gatekeeper`, OpenBao at `openbao.alacasa.uk`; users connect accounts at `app.hiddenfield.dev/gatekeeper/` |
| Login | `SecurityPolicy/kodo-login`: OIDC with Authrim, one session cookie on `.hiddenfield.dev`; the gateway forwards the ID token and the access token |
| Inference gateway | Envoy AI Gateway, namespace `kodo-inference`, Service `kodo-inference.envoy-gateway-system.svc` (Gatekeeper only); models `default` and `agent` (OpenRouter) and `sim` (in-cluster simulator); budgets in Redis. See [deploy/inference](../inference/README.md) |
| Tunnel | `cloudflared` in `kodo-gateway`, two replicas, forwarding `app.kodo.applet.one` and `*.g.kodo.applet.one` to the gateway; see [Public access](#public-access) |
| Agent | `kodo-agent` in `kodo-system`, the chat at `app.hiddenfield.dev/chat/`; calls the fleet's kernel at `kodo.kodo.svc` and thinks with the model `agent`. See [kernel/AGENT.md](../../kernel/AGENT.md) |

## Bring it up

`.env` needs the Tigris admin key (`AWS_ACCESS_KEY_ID`, `AWS_SECRET_ACCESS_KEY`, `AWS_ENDPOINT_URL_S3`, `AWS_ENDPOINT_URL_IAM`), `CLOUDFLARE_API_TOKEN` (Zone DNS Edit and Zone Read on hiddenfield.dev, for cert-manager), `LETSENCRYPT_EMAIL`, the Gatekeeper's OpenBao AppRole, which `task openbao:setup` writes (see [deploy/openbao](../openbao/README.md)), and `OPENROUTER_API_KEY` for the `default` and `agent` models. The approvals test also needs `RESEND_API_KEY` and `RESEND_FROM`, a From address on a domain verified in that Resend account. `helm` must be on `PATH` for the AI Gateway charts.

```sh
BAO_ADDR=http://openbao.alacasa.uk:8200 BAO_TOKEN=<admin> task openbao:setup   # once
task k3s:up KERNEL_IMAGE=ghcr.io/ipedrazas/kodo-kernel:main OPERATOR_IMAGE=ghcr.io/ipedrazas/kodo-operator:main \
  GATEKEEPER_IMAGE=ghcr.io/ipedrazas/kodo-gatekeeper:main AGENT_IMAGE=ghcr.io/ipedrazas/kodo-agent:main
deploy/k3s/authrim-test-users.sh   # once: the tests' users in Authrim, see Test users
task k3s:identity-test
task k3s:gatekeeper-test        # Phase 7: grants, the Gatekeeper, egress, the vault and audit
task k3s:approvals-test         # Phase 8: the approval queue; restarts the Gatekeeper twice
task k3s:inference-test         # Phase 9: models through grants, routing, budgets (now the kernel's) and usage
task k3s:agent-test             # Phase 10: the agent's code in ephemeral cells; restarts the agent twice
task k3s:authoring-test         # Phase 11: the agent writes gadgets; the author publishes them
task k3s:admin-test             # Phase 12: admins, membership, settings, withdrawal, suspension, audit
```

## Bucket keys

The admin key in `.env` is used only to create two scoped keys, once, with `task k3s:bucket-keys` ([`bucket-keys.sh`](bucket-keys.sh)), into `.buckets.env` (git-ignored):

| Key | Can read and write | Used by |
| --- | --- | --- |
| `FLEET_*` | `kodo-dev` only | the fleet's nodes and kernel deploy Job (Secret `kodo/bucket`) |
| `GATEKEEPER_*` | `kodo-dev-gatekeeper` only | the Gatekeeper (Secret `kodo-system/kodo-gatekeeper-bucket`): `vault/`, `approvals/`, `audit/` |

They are Tigris IAM policies on access keys, so a fleet's credentials cannot list or read the Gatekeeper's bucket. The fleet key passes `celld diagnose`.

## Egress

The fleet's nodes can open connections only to DNS, each other and the Gatekeeper (8081 for calls, 8082 for the egress proxy). Tigris's addresses change with DNS, so the nodes reach the bucket through the Gatekeeper's egress proxy (`HTTPS_PROXY`), which tunnels only to `t3.storage.dev`, `*.t3.storage.dev` and `auth.applet.one`: the kernel fetches Authrim's signing keys and asks its userinfo endpoint through it. Anything else, GitHub and the model providers included, is refused. Models are reached only through the Gatekeeper, which is the only client the inference gateway admits.

## Identity

Users sign in to Authrim with a passkey, a code sent by email, or an authenticator app. `.auth.env` (git-ignored) holds the Authrim client's `AUTHRIM_CLIENT_ID` and `AUTHRIM_CLIENT_SECRET`; the client, its redirect URIs (`https://app.hiddenfield.dev/oauth2/callback` and the public one), its scopes and its Default Audience are set by hand in Authrim's Admin UI, as the [runbook](../../docs/public-access.md) describes. `k3s:up` still writes the Dex client secret and Dex's static passwords there, for `tap.hiddenfield.dev`.

Authrim leaves the email out of its ID tokens, so the kernel and the Gatekeeper ask its userinfo endpoint (`Fleet.spec.auth.userinfoURL`, `OIDC_USERINFO_URL`) with the access token the gateway forwards. Authrim 0.5.0's `ar-userinfo` Worker needs `ISSUER_URL` set for that to answer; see the runbook, step 3.4.

Platform admins are named by the address they sign in with. This repository is public, so they are set on the cluster and not in [`fleet.yaml`](fleet.yaml); applying the file leaves them as they are:

```sh
kubectl -n kodo patch fleet kodo --type merge -p '{"spec":{"admins":{"emails":["<address>"]}}}'
```

### Test users

The end-to-end tests sign in as `alice`, `bob` and `carol`, `<name>@hiddenfield.dev` (`EMAIL_DOMAIN` changes the domain). Authrim has no password form, so each has an authenticator app, and the tests compute its code from a secret in `.auth.env` (`ALICE_TOTP_SECRET`, `BOB_TOTP_SECRET`, `CAROL_TOTP_SECRET`). [`authrim-test-users.sh`](authrim-test-users.sh) creates the three accounts and writes the secrets. It needs, in Authrim's Admin UI, **Authentication Methods** → **Authenticator App** with **Login** and **Signup** ticked; afterwards untick **Signup**, and mark the three addresses as verified, because kodo ignores an email the identity provider has not verified. The Admin UI has no control for that; the script's header has the one API call that does it, from the browser's console. `task k3s:admin-test` also needs `carol@hiddenfield.dev` among the Fleet's admins. Whoever holds a secret can sign in as that user.

## DNS

`app`, `auth` and `*.g` under hiddenfield.dev must resolve to 192.168.2.224, as DNS-only records: Cloudflare's proxy certificate does not cover second-level wildcards. The certificate itself needs no DNS records beyond the ones cert-manager creates for each challenge.

## Public access

The public names are `app.kodo.applet.one` and `*.g.kodo.applet.one`, through a Cloudflare Tunnel in the Applet One account; the hiddenfield.dev names stay on the LAN. `cloudflared` ([`cloudflared.yaml`](cloudflared.yaml)) dials out to Cloudflare and forwards what arrives to the gateway over HTTPS, with the request's hostname as SNI, so no port is opened.

| Piece | Where |
| --- | --- |
| Listeners | `https-public` and `https-public-cells` on the same Gateway ([`gateway.yaml`](gateway.yaml)) |
| Certificate | `kodo-applet-one`, from a private CA in `kodo-gateway` that only `cloudflared` trusts; browsers see Cloudflare's certificate |
| Routes and login | [`public.yaml`](public.yaml): the same backends, `SecurityPolicy/kodo-login-public` with Authrim at `auth.applet.one`, session cookie on `.kodo.applet.one` |

`.env` needs `CLOUDFLARE_ACCOUNT_ID`, the account that holds the applet.one zone (a tunnel serves only hostnames in its own account), and `CLOUDFLARE_TUNNEL_API_TOKEN` with Account: Cloudflare Tunnel Edit and, on the zone, Zone Read, DNS Edit and SSL and Certificates Read. `.auth.env` needs `AUTHRIM_CLIENT_ID` and `AUTHRIM_CLIENT_SECRET`, of an Authrim client with the redirect URI `https://app.kodo.applet.one/oauth2/callback`.

```sh
task k3s:tunnel                 # creates the tunnel once (.tunnel.json, git-ignored), the listeners, routes and cloudflared
deploy/k3s/tunnel.sh dns        # app.kodo and *.g.kodo become proxied CNAMEs to the tunnel
deploy/k3s/tunnel.sh undns      # removes them
```

The hostnames and where they go are in `cloudflared.yaml`, not in the Cloudflare dashboard; bump `kodo.dev/config-version` when changing them.

Cloudflare's free certificate covers `applet.one` and `*.applet.one`, so neither public name. The zone needs an advanced certificate for `*.kodo.applet.one` and `*.g.kodo.applet.one` (Advanced Certificate Manager, paid) before `tunnel.sh dns`, which refuses to create the records without one. How to check and order it, and every other step by hand, is in the [runbook](../../docs/public-access.md).

The kernel and the Gatekeeper accept ID tokens from one issuer, `Fleet/kodo`'s `auth` and the Gatekeeper's `OIDC_ISSUER`: Authrim, for both the public names and hiddenfield.dev. A user is the same person on either, with one login each, since the session cookies are per domain.

## How a request is authenticated

1. Envoy Gateway sends a request without a session to Authrim. After login, Authrim redirects to `app.hiddenfield.dev/oauth2/callback`, and the gateway sets its session cookies on `.hiddenfield.dev`, so one login covers the app and every cell.
2. The gateway forwards the user's ID token to the kernel in `x-kodo-identity`, and the access token as a bearer token in `Authorization`.
3. The kernel verifies the ID token against Authrim's keys (fetched through the egress proxy). The token names the user but carries no email, so the kernel asks Authrim's userinfo endpoint with the access token, uses the answer only if it is for the same user, and remembers it. It then checks the cell's owner and shares, and removes both tokens and the session cookies before the gadget sees the request.
4. On `/chat`, the gateway forwards the ID token to the agent instead, which passes it to the kernel to create a session or start a turn, and keeps it no longer than that request; the kernel knows the user's email from an earlier request. For the rest of the turn the agent uses the turn token the kernel gave it, which reaches only that session.
