# The inference gateway

Gadgets reach models only through grants, `inference:model/<name>:invoke`, and only through the Gatekeeper. The Gatekeeper sends each call to this gateway, [Envoy AI Gateway](https://aigateway.envoyproxy.io) v1.1 on Envoy Gateway, which decides which backend serves the model, holds the backends' keys, and enforces budgets and rate limits per user and per workspace.

```
gadget ─ grants["inference:model/default:invoke"].fetch("/chat/completions")
  │ kernel: signed call (cell, owner, workspace, grants)
  ▼
Gatekeeper ─ checks the grant and the body, sets model=default,
  │          x-kodo-gateway-key, x-kodo-user, x-kodo-workspace, x-kodo-blueprint
  ▼
kodo-inference.envoy-gateway-system.svc:80  (ClusterIP; NetworkPolicy: Gatekeeper pods only)
  api_key_auth ─ ext_proc (AI Gateway) ─ rate limit (Redis) ─ router
  │ default ─► OpenRouter, meta-llama/llama-3.1-8b-instruct   (key from Secret openrouter)
  │ sim     ─► sim.kodo-inference.svc:8000, an OpenAI-compatible simulator
  ▼
answer + usage ─► Gatekeeper (audit: metered) ─► kernel (cell counts tokens) ─► gadget
```

| File | What |
| --- | --- |
| [`gateway.yaml`](gateway.yaml) | The Gateway and its `EnvoyProxy` (ClusterIP Service `kodo-inference`), the Gatekeeper's key (`SecurityPolicy`, `sanitize: true`), and the NetworkPolicy that admits only Gatekeeper pods |
| [`models.yaml`](models.yaml) | The `AIGatewayRoute` from model names to backends, the token costs it records, and the backends: OpenRouter (with its `BackendSecurityPolicy` and TLS) and the simulator |
| [`budgets.yaml`](budgets.yaml) | Token budgets per user and per workspace, and a call rate per user |
| [`simulator.yaml`](simulator.yaml) | [llm-d inference-sim](https://github.com/llm-d/llm-d-inference-sim) in echo mode |
| [`ai-gateway-values.yaml`](ai-gateway-values.yaml) | Values for the AI Gateway controller chart |

The platform side is in [`deploy/platform`](../platform): Envoy Gateway's configuration gains the AI Gateway as an extension server, the `Backend` API and global rate limiting, and [Redis](../platform/redis.yaml) (append-only, on a volume) keeps the counters.

## Deploy

`task k3s:up` includes it. On its own:

```sh
task k3s:platform     # Envoy Gateway config, Redis, the AI Gateway CRDs and controller (needs helm)
task k3s:inference    # keys, the OpenRouter Secret (OPENROUTER_API_KEY in .env), this directory, Gatekeeper restart
task k3s:inference-test
```

`k3s:inference` creates the key only the Gatekeeper sends, once, in Secret `kodo-system/kodo-gatekeeper-inference`, and copies it to `kodo-inference/kodo-inference-clients`. The Gatekeeper reads it at start (`INFERENCE_KEY_FILE`) and calls `INFERENCE_URL`, set in [`deploy/k3s/gatekeeper`](../k3s/gatekeeper/kustomization.yaml).

## Models

A gadget names a model; this gateway decides who serves it. To move every gadget using `default` to another backend, change its rule in `models.yaml` and apply it: no Blueprint, grant or gadget changes. A model can also have several `backendRefs` with weights, or priorities for failover. To add a provider, add a `Backend`, an `AIServiceBackend` with its schema (`OpenAI` with `prefix: /api/v1` for OpenRouter) and a `BackendSecurityPolicy` for its key.

## Budgets

[`budgets.yaml`](budgets.yaml) is one `BackendTrafficPolicy` on the Gateway. Each rule keys on a header the Gatekeeper sets: `x-kodo-user`, the owner's subject at the identity provider, and `x-kodo-workspace`, `<fleet namespace>/<fleet>/<workspace>`. A rule with `type: Distinct` gives every user or workspace its own counter.

| Rule | Limit |
| --- | --- |
| Tokens per user | 1,000,000 a month |
| Tokens per workspace | 5,000,000 a month |
| Calls per user | 60 a minute |

A call goes through while every matching rule has budget left; when it finishes, the total tokens the backend reported are taken from each token rule. So the call that crosses a budget is answered, and the next is refused with 429, which the gadget sees as `{"error"}` with `x-ratelimit-reset`. To give one user or workspace a lower budget, add a rule with an `Exact` header match; it adds to the default, so it cannot raise it. Changing the rules can reset the counters.

## Usage

| Where | What | Per |
| --- | --- | --- |
| Kernel: `GET /api/workspaces/:ws/usage` | Model calls and tokens, requests, last activity, storage | Cell, owner, workspace; by month |
| Gatekeeper audit log | One `metered` record per model call: status and tokens | Call, with user, workspace, cell, Blueprint |
| The AI Gateway's metrics (`:1064/metrics` on the proxy pod) | `gen_ai_client_token_usage` and latencies | Model, workspace (`kodo_workspace`), Blueprint (`kodo_blueprint`) |

## What a backend sees

The Gatekeeper sends no email address, cell or credential, and the gateway removes its key. A backend does see `x-kodo-user`, `x-kodo-workspace` and `x-kodo-blueprint`: Envoy charges the token budgets when the response ends, building the rate limit descriptors again from the request headers as they went upstream, and an upstream filter that removed them (the AI Gateway's `headerMutation`) would leave nothing to charge. That is why the user is the opaque subject rather than an email address.

## Findings

- With headers removed by `headerMutation`, the budgets passed every call: the check on the way in worked, but the tokens were never charged. Envoy logged one rate limit call per request; the counters in Redis stayed at 0 while the AI Gateway's metrics counted the tokens.
- AI Gateway v1.1.0 is built against Envoy Gateway v1.8.1; it runs on v1.9.2 (Envoy 1.39) here. Envoy Gateway turns off `x-envoy-ratelimited`, so a refusal is a 429 with `x-ratelimit-*` headers and no body; a backend's own 429 has a body.
- The extension hook fails closed: while the AI Gateway controller is down, Envoy Gateway keeps every proxy's last configuration, the main gateway's included, and applies no changes.
