# Dependencies

kodo is three Go services, a kernel Worker and an agent. It depends on other software and services to work: a runtime, object storage, an identity provider, a gateway that logs users in, a vault, an inference gateway and a Kubernetes cluster that enforces network policy. None of these are part of kodo, but kodo does not run without them or something that does the same job.

For each one, this page says what kodo needs from it (the contract), what the reference environment runs, and what else would do. The reference environment is hiddenfield.dev on a k3s cluster ([deploy/k3s](../deploy/k3s/README.md)). Local development and CI use kind. How the pieces connect is in [architecture.md](architecture.md).

## Summary

| Need | Required | Reference (k3s) | kind / CI | Alternatives |
| --- | --- | --- | --- | --- |
| [Kubernetes](#kubernetes-and-network-policy) | Yes | k3s | kind | Any conformant cluster: EKS, GKE, AKS, on-prem |
| [NetworkPolicy enforcement](#kubernetes-and-network-policy) | Yes | k3s's built-in policy controller | kindnet | Calico, Cilium, any enforcing CNI |
| [Sandboxed runtime](#sandboxed-container-runtime) | Strongly recommended | gVisor, `RuntimeClass gvisor` | None (runc) | Kata Containers, GKE Sandbox |
| [Node volumes](#node-volumes) | Yes | `local-path` | kind default | Any StorageClass with low fsync latency |
| [Runtime](#runtime-celld) | Yes, not replaceable | celld 0.6.2 | celld 0.6.2 | None |
| [Object storage](#object-storage) | Yes | Tigris, two buckets | SeaweedFS 3.97 in the cluster | Any S3 API that passes `celld diagnose` (RustFS passed; AWS S3, MinIO, Ceph RGW untested) |
| [Gateway with OIDC](#gateway-and-login) | Yes | Envoy Gateway v1.9.2 | None (admin token only) | Any gateway that logs users in and forwards the ID token |
| [Load balancer](#load-balancer-dns-and-tls) | For external access | MetalLB | Port-forward | Cloud load balancer |
| [DNS and TLS](#load-balancer-dns-and-tls) | Yes | Cloudflare DNS, cert-manager v1.21.2, Let's Encrypt DNS-01 | None | Any wildcard certificate |
| [Identity provider](#identity-provider) | Yes | Dex v2.45.1 | Test harness | Keycloak, Okta, Entra ID, Google, any OIDC provider |
| [Secret encryption](#secret-encryption) | Yes, for user tokens | OpenBao transit | OpenBao dev server (tests) | HashiCorp Vault transit; a cloud KMS (not yet written) |
| [Inference gateway](#inference-gateway) | For model grants and the agent | Envoy AI Gateway v1.1.0 + Redis 8.2 | Test harness | Any OpenAI-compatible endpoint, e.g. LiteLLM |
| [Model backends](#model-backends) | For model grants and the agent | OpenRouter, llm-d inference-sim v0.11.2 | Test harness | Anything the inference gateway can route to |
| [External providers](#external-providers) | Per capability | GitHub, Resend, public APIs | Test harness | — |
| [Container registry](#container-registry) | Yes | GHCR | Images built locally | Any registry the cluster can pull from |
| [Build and operator tools](#tools) | Yes | — | — | — |

## Kubernetes and network policy

**Contract.** A conformant Kubernetes with a network plugin that **enforces** NetworkPolicy. This is a security requirement, not an option. Without it:

- gadgets are not cut off from the network: a fleet node could reach any service in the cluster or on the internet;
- celld's internal listener (port 8081: the peer protocol and an **unauthenticated** operator API) is open to every pod;
- the Gatekeeper's call and egress-proxy ports and the inference gateway are open to every pod.

kodo creates the policies; it cannot tell whether they are enforced. Check before you trust a cluster: from a pod outside the fleet, `curl` a fleet node's port 8081 and expect a timeout.

**Reference.** k3s, which runs an embedded network policy controller by default (unless started with `--disable-network-policy`). kind's default CNI, kindnet, enforces NetworkPolicy in recent kind releases; the operator e2e test relies on it.

**Alternatives.** Calico or Cilium on any distribution; the cloud providers' policy-enforcing options (EKS with the VPC CNI's network policy agent, GKE Dataplane V2, AKS with Azure or Cilium network policy). Fleet pods also need to resolve DNS (allowed by the policies kodo writes) and must not need the Kubernetes API: they get no service account token.

## Sandboxed container runtime

**Why.** A gadget is a V8 isolate in a process shared with the fleet's other gadgets. celld makes no claim about V8 escapes, so a sandboxed runtime on the fleet's pods is the kernel boundary between gadget code and the host. It is per fleet, not per gadget; mutually distrusting tenants get a fleet each.

**Contract.** A `RuntimeClass` named in `Fleet.spec.runtimeClassName`. The fleet runs without one, but then a V8 escape reaches the node's kernel. Phase 13 makes it mandatory.

**Reference.** gVisor (`runsc`), `RuntimeClass gvisor`, installed on the k3s nodes outside this repository (containerd shim plus the `RuntimeClass` object). The Phase 0 spike measured no significant latency difference from runc ([spike results](../spike/celld/README.md)). kind runs without it.

**Alternatives.** Kata Containers (a VM per pod: stronger, heavier); GKE Sandbox (gVisor, managed). Any of them only needs a `RuntimeClass` name.

## Node volumes

**Contract.** Each fleet node gets a PersistentVolume (`Fleet.spec.storageSize`, default 2 GiB; `storageClassName`, default the cluster's). It is a cache of the bucket and can be lost, but celld fsyncs on every write, so **fsync latency sets write latency**. Phase 1 measured about 100 ms per fsync on the k3s nodes and about 120 ms per write.

**Reference.** k3s's `local-path` provisioner. Prefer local NVMe; avoid network block storage with high sync latency.

## Runtime: celld

**Contract.** [celld](https://github.com/denoland/celld), Deno's self-hosted runtime for Workers and Durable Objects. kodo relies on it for cell ownership, placement, hibernation, failover, eviction and code loading, and on its Worker Loader and facets to run gadgets. This is the one dependency with no alternative: the kernel is a celld application.

**Reference.** `ghcr.io/denoland/celld:0.6.2`, set in `Fleet.spec.celld`. The kernel image bundles celld to deploy the kernel, and the kernel tests run under `celld dev`, so the celld CLI is also a build dependency.

**Constraints.** Mixed celld versions cannot share a fleet, so upgrades stop the fleet ([runbook](runbook.md#celld)). Known 0.6.x problems (bundle memory never released, ArrayBuffers outside the heap limit, a WebSocket upgrade hang, a stuck restore after peers self-fence) are in [architecture.md](architecture.md#known-limits) and the [upstream report](../spike/celld/upstream/celld-0.6.0-report.md).

## Object storage

kodo has no database. Object storage is the system of record.

**Contract.** An S3 API with:

- conditional writes (`If-None-Match: *` on create, `If-Match` on update) and ranged reads. `celld diagnose` checks these, and **a provider that fails it is unsupported**. The Gatekeeper also uses conditional writes for approvals and the audit log;
- **two buckets** with separately scoped credentials: one per fleet (celld's cells, bundles, the kernel) and one for the Gatekeeper (`vault/`, `approvals/`, `audit/`). A fleet's credentials must not be able to read the Gatekeeper's bucket. Scoping per bucket works on every provider; scoping per prefix does not;
- reachability from fleet nodes, either by fixed addresses in a NetworkPolicy `ipBlock`, or through the Gatekeeper's egress proxy when the endpoint's addresses change (`Fleet.spec.egress.proxy: true`, hosts in `GATEKEEPER_EGRESS_ALLOW`).

**Reference.** Tigris (`https://t3.storage.dev`, region `auto`), buckets `kodo-dev` and `kodo-dev-gatekeeper`, keys scoped with Tigris IAM policies ([`bucket-keys.sh`](../deploy/k3s/bucket-keys.sh)). Reached through the egress proxy. kind and CI use single-node SeaweedFS in the fleet's namespace ([`seaweedfs.yaml`](../deploy/fleet/kind/seaweedfs.yaml)), which is ephemeral.

**Alternatives.** Tested in Phase 1 ([PHASE1.md](../spike/celld/PHASE1.md)): Tigris, SeaweedFS and RustFS pass `celld diagnose`. Not tested: AWS S3, MinIO (no public image any more), Ceph RGW, GCS interop, Cloudflare R2. Run `celld diagnose` with the fleet's own key before using any of them. Object Lock for the audit bucket, where the provider has it, is planned (Phase 13).

## Gateway and login

**Contract.** Something in front of the fleet, the Gatekeeper and the agent that:

- terminates TLS for `app.<domain>` and `*.g.<domain>` and routes them to the fleet's Service, `app.<domain>/gatekeeper/` to the Gatekeeper's port 8080 and `app.<domain>/chat/` to the agent;
- logs users in with OIDC and keeps **one session cookie on the parent domain**, so one login covers the app and every cell;
- forwards the user's **ID token** (the JWT, not an access token or a username header) in `x-kodo-identity` on every request, refreshing it before it expires. The kernel, the Gatekeeper and the agent verify it themselves; the gateway is not trusted to assert identity;
- passes WebSockets, with an idle timeout clients can keep open by pinging (Envoy's default drops a socket after 5 minutes without traffic);
- buffers request bodies big enough for the agent's transcripts (the inference gateway needs 4 MiB).

**Reference.** Envoy Gateway v1.9.2 with the Gateway API CRDs, from [`deploy/platform`](../deploy/platform/kustomization.yaml). A `SecurityPolicy` does the OIDC login with `forwardIDToken.header: x-kodo-identity`, `cookieDomain` on the parent domain and `refreshToken: true` ([`routes.yaml`](../deploy/k3s/routes.yaml)). The same Envoy Gateway also hosts the inference gateway. On kind there is no gateway: only the admin token works.

**Alternatives.** Any Gateway API or ingress implementation plus something that does the OIDC flow and forwards the ID token: e.g. oauth2-proxy (`--pass-authorization-header` or `--set-xauthrequest` with the ID token, behind a header rename) in front of NGINX, Traefik or Istio. Check that it forwards the ID token rather than an access token, and that the cookie covers the cell subdomains.

## Load balancer, DNS and TLS

**Contract.** One external address for the gateway; DNS records `app`, `auth` (if the IdP is in the cluster) and wildcard `*.g` pointing at it; and a certificate covering `app.<domain>` and `*.g.<domain>`. A wildcard certificate needs the DNS-01 challenge. Cells are second-level wildcards, which many CDN proxies' certificates do not cover, so the records should point straight at the gateway.

**Reference.** MetalLB, fixed address 192.168.2.224. Cloudflare DNS as DNS-only records. cert-manager v1.21.2 with Let's Encrypt and Cloudflare DNS-01 (`CLOUDFLARE_API_TOKEN` with Zone DNS Edit and Zone Read).

**Alternatives.** A cloud load balancer; any cert-manager DNS-01 solver (Route 53, Cloud DNS, Azure DNS, RFC 2136); or a certificate issued elsewhere and stored as a Secret.

## Identity provider

**Contract.** An OpenID Connect provider that issues ID tokens:

- signed with **RS256 or ES256**, with keys at a JWKS URL the fleet nodes and the Gatekeeper can reach (an explicit egress rule for fleet nodes);
- with `iss` matching `Fleet.spec.auth.issuer` and `aud` equal to the gateway's client id (`spec.auth.audience`);
- with `sub` (the user's stable id), `email` and `email_verified`. Shares and workspace memberships are keyed by email, and an email the IdP marks unverified counts for nothing;
- optionally, a groups claim (`spec.admins.groupsClaim`, default `groups`) listing the user's groups, for platform admins by group. Without groups, name admins by email in `spec.admins.emails` (and the IdP must say the email is verified).

`Fleet.spec.auth.jwksURL` defaults to `<issuer>/keys`, which is **Dex's path**. Every other provider needs it set explicitly (Keycloak: `<issuer>/protocol/openid-connect/certs`; most others: the `jwks_uri` from `<issuer>/.well-known/openid-configuration`). The Gatekeeper's `OIDC_JWKS_URL` has the same default.

**Reference.** Dex v2.45.1 in `kodo-auth` with static users (alice, bob, carol), its keys reached in-cluster at `http://dex.kodo-auth.svc:5556/keys` ([`dex.yaml`](../deploy/k3s/dex.yaml)). Static passwords have no groups, so carol is an admin by email. The kernel tests play the IdP: they serve a JWKS and mint tokens.

**Alternatives.** Keycloak, Authentik, Zitadel, Okta, Auth0, Entra ID, Google Workspace, or Dex federating any of them (LDAP, GitHub, SAML).

## Secret encryption

**Contract.** The Gatekeeper stores users' third-party tokens only as ciphertext, through a small interface ([`internal/vault`](../internal/vault/vault.go)): encrypt and decrypt with a **context** that binds each ciphertext to its user and provider, so one user's ciphertext does not decrypt as another's. The Gatekeeper must never hold the key. It must reach the vault over the network.

**Reference.** OpenBao's transit engine, key `kodo-gatekeeper` (`aes256-gcm96`, `derived=true`, not exportable, deletion disallowed), AppRole login with a policy that allows only encrypt and decrypt ([deploy/openbao](../deploy/openbao/README.md)). OpenBao runs outside the cluster at `openbao.alacasa.uk:8200`. Kubernetes auth is supported instead of AppRole.

**Alternatives.** HashiCorp Vault's transit engine speaks the same API, so it should work unchanged (untested). A cloud KMS (AWS KMS with encryption context, GCP KMS with additional authenticated data) would be a second implementation of the interface; it is not written yet.

**If it is lost.** Losing the transit key means every stored token is unreadable and every user reconnects their accounts. Back it up.

## Inference gateway

Needed only for `inference:` grants and the agent.

**Contract.** The Gatekeeper sends OpenAI-style chat completions to `INFERENCE_URL` + `/v1/chat/completions`, with:

- `model` set to the granted model name, which the gateway maps to a backend and backend model;
- the Gatekeeper's key in `x-kodo-gateway-key` (from `INFERENCE_KEY_FILE`). The gateway must admit **only** the Gatekeeper, by key and by network;
- `x-kodo-user`, `x-kodo-workspace` and `x-kodo-blueprint`, for rate limits and metrics labels;
- the response's `usage` field (prompt, completion and total tokens), which the kernel counts against budgets.

Monthly token budgets are the kernel's, so the gateway only needs to route, hold the backends' keys and, as protection for the cluster, limit each user's call rate.

**Reference.** Envoy AI Gateway v1.1.0 (Helm charts `ai-gateway-crds-helm` and `ai-gateway-helm`) as an extension of Envoy Gateway, which is configured for it, for the `Backend` API and for global rate limiting ([`envoy-gateway-config.yaml`](../deploy/platform/envoy-gateway-config.yaml)). Redis 8.2 (append-only, on a volume) keeps the rate-limit counters. Its resources are in [deploy/inference](../deploy/inference/README.md). Notes: Envoy rebuilds rate-limit descriptors from the headers as sent upstream, so they cannot be stripped before the backend; while the AI Gateway controller is down, Envoy Gateway applies no configuration changes at all.

**Alternatives.** LiteLLM (it was the other option in Phase 9), or any OpenAI-compatible proxy that can check a static key header, map model names, and pass `usage` through. A single provider with an OpenAI-compatible API could be called directly, but then its key would sit in the Gatekeeper and there would be no per-user rate limit.

## Model backends

**Reference.** [OpenRouter](https://openrouter.ai) (`OPENROUTER_API_KEY`): model `default` is `meta-llama/llama-3.1-8b-instruct`, model `agent` is `deepseek/deepseek-v4-flash` with reasoning turned off ([`models.yaml`](../deploy/inference/models.yaml)). Model `sim` is [llm-d inference-sim](https://github.com/llm-d/llm-d-inference-sim) v0.11.2 in the cluster, which generates random text and is useful for tests; it rejects the agent's tool schema, so it cannot stand in for the agent's model.

**Alternatives.** Anything the inference gateway can route to: Anthropic, OpenAI, Bedrock, Vertex AI, or vLLM in the cluster. The agent's model must support tool calls and produce enough output for a whole gadget in one tool call (raise its output limit at `/admin/`).

## External providers

The Gatekeeper's providers, each optional and needed only for the capabilities that use them.

| Provider | Capability | Needs | Configured by |
| --- | --- | --- | --- |
| GitHub | `github:…` | Each user connects a token at `/gatekeeper/` | `GITHUB_API_URL` (GitHub Enterprise) |
| Resend | `email:…` | Each user connects an API key and a From address on a domain verified in that account | `RESEND_API_URL` |
| Public web APIs | `web:<host>[/<path>]:read` | No credentials; host on the allowlist; must resolve to public addresses | `GATEKEEPER_WEB_ALLOW` |

The Gatekeeper pod needs outbound HTTPS to each of them; fleet nodes never do.

## Container registry

Images are published to GHCR by CI: `ghcr.io/ipedrazas/kodo-{kernel,operator,gatekeeper,agent}` for amd64 and arm64, and the cluster pulls them anonymously. A private fork needs an image pull secret on the four workloads, including the operator's kernel deploy Jobs. celld comes from `ghcr.io/denoland/celld`.

## Tools

| Tool | Used for | Version |
| --- | --- | --- |
| Go | Operator, Gatekeeper, agent, `kodo` CLI | 1.27 (`go.mod`) |
| Node.js | Kernel typecheck and tests | 24 |
| celld CLI | `celld dev` for kernel tests; kernel deploys | 0.6.2 |
| esbuild | Bundling the kernel and gadgets | On `PATH` |
| [Task](https://taskfile.dev) | Every workflow in [`Taskfile.yml`](../Taskfile.yml) | 3 |
| kubectl | Everything | Matching the cluster |
| kind, Docker | Local clusters, operator e2e | — |
| helm | The AI Gateway charts (`task k3s:platform`) | 3 |
| bao (or vault) CLI | `task openbao:setup` | — |
| aws CLI | Tigris bucket keys (`bucket-keys.sh`) | v2 |
| openssl, htpasswd | Generated secrets and Dex password hashes | — |
| gh | Finding image tags | — |

## Planned

Named in the [plan](../plans/gadgets-on-kubernetes.md) but not used yet:

| Dependency | For | Phase |
| --- | --- | --- |
| Prometheus, OpenTelemetry collector | Fleet metrics from celld and traces through the kernel | 6 |
| KEDA | Scaling fleets on resident cells and queued activations | 6 |
| External Secrets | Bucket credentials, OIDC client secret and DNS-01 credentials from OpenBao | 13 |
| Workload identity (IRSA, GKE Workload Identity) | Bucket access without static keys | 13 |
| Pod Security admission (restricted) | Enforcing the fleet pods' security context | 13 |
| Helm | One chart for the whole platform, with a preflight `celld diagnose` | 14 |
