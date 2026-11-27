# Runbook: public access at kodo.applet.one

How to put kodo on the internet at `app.kodo.applet.one` and `*.g.kodo.applet.one` through a Cloudflare Tunnel, with Authrim (`auth.applet.one`) as the login, and how to operate and undo it. The hiddenfield.dev names stay on the LAN and are not changed by anything here until phase 7. What the pieces are is in [deploy/k3s](../deploy/k3s/README.md#public-access).

Each step is marked with how far it has been checked:

- **[checked]**: validated against the k3s cluster (server-side dry run, or the config validated with the real `cloudflared` image), not yet run for real.
- **[untested]**: written from the documentation and the code, never run.

Applied on 2026-11-26 and 27: every phase. Both logins work, on kodo.applet.one and on hiddenfield.dev. A step still marked **[untested]** was done by hand and not noted here; update the marks as you repeat them.

## Facts

| | Value |
| --- | --- |
| Public names | `app.kodo.applet.one`, `*.g.kodo.applet.one` |
| Cloudflare account | Applet One. Its ID is `CLOUDFLARE_ACCOUNT_ID` in `.env`, and stays out of this file: the repository is public |
| Zone | `applet.one` |
| Tunnel | `kodo`, locally configured. Its ID is in `.tunnel.json`, and stays out of this file |
| Identity provider | Authrim, `https://auth.applet.one`, Admin UI at `https://adm.applet.one` (redirects to `/admin`) |
| Authrim client | `kodo`; client ID `21273353-a720-408d-a439-62b1acf1613f` |
| Origin | Service `envoy-kodo-gateway-kodo-9c6f46a6.envoy-gateway-system.svc:443`, listeners `https-public` and `https-public-cells` |
| Kube context | `k3s-homelab` (the Taskfile defaults to `default`: pass `K3S_CONTEXT=k3s-homelab` to every `task`) |

Local files, all git-ignored: `.env` (adds `CLOUDFLARE_ACCOUNT_ID`, `CLOUDFLARE_TUNNEL_API_TOKEN`), `.auth.env` (adds `AUTHRIM_CLIENT_ID`, `AUTHRIM_CLIENT_SECRET`), `.tunnel.json` (the tunnel's credentials; whoever holds it can run the tunnel).

Run every command from the repository root. The commands that call Cloudflare expect the two variables loaded:

```sh
set -a; . ./.env; set +a
CF=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer $CLOUDFLARE_TUNNEL_API_TOKEN"
```

Tools: `kubectl`, `task`, `curl`, `jq`, `openssl`, `dig`.

---

## Phase 1: Cloudflare API token (by hand)

### 1.1 Create the token **[untested]**

A token cannot be created by script without a more powerful token, so this is done in the dashboard, logged in to the Applet One account.

1. Open <https://dash.cloudflare.com/profile/api-tokens> → **Create Token** → **Create Custom Token** → **Get started**.
2. Name: `kodo tunnel`.
3. Permissions, four rows:

   | | | |
   | --- | --- | --- |
   | Account | Cloudflare Tunnel | Edit |
   | Zone | Zone | Read |
   | Zone | DNS | Edit |
   | Zone | SSL and Certificates | Read (Edit if you order the certificate with the API in step 2.2) |

4. Account Resources: **Include** → the Applet One account.
5. Zone Resources: **Include** → **Specific zone** → `applet.one`.
6. **Continue to summary** → **Create Token**. The token is shown once.
7. Add it to `.env`:

   ```sh
   echo 'CLOUDFLARE_TUNNEL_API_TOKEN=<the token>' >> .env
   ```

It is a different token from `CLOUDFLARE_API_TOKEN`, which is cert-manager's, lives in the cluster and reaches only hiddenfield.dev's DNS.

### 1.2 Find the account ID and check the token **[untested]**

```sh
set -a; . ./.env; set +a
CF=https://api.cloudflare.com/client/v4
AUTH="Authorization: Bearer $CLOUDFLARE_TUNNEL_API_TOKEN"

curl -s -H "$AUTH" $CF/user/tokens/verify | jq -r '.result.status'
# expect: active
curl -s -H "$AUTH" $CF/accounts | jq -r '.result[] | "\(.name) \(.id)"'
curl -s -H "$AUTH" "$CF/accounts" | jq -r '.result[] | "\(.name) \(.id)"'
# expect: applet-one and its ID
curl -s -H "$AUTH" "$CF/zones?per_page=50" | jq -r '[.result[].name]'
# expect: a list with applet.one; an empty list means the token has no Zone Read on the zone
```

Add the ID to `.env` (not to this file), then load it:

```sh
echo 'CLOUDFLARE_ACCOUNT_ID=<the id>' >> .env
set -a; . ./.env; set +a
curl -s -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?is_deleted=false" | jq '.success'
# expect: true (the token can manage tunnels)
```

---

## Phase 2: Edge certificate

Cloudflare's free certificate covers `applet.one` and `*.applet.one` only. Both public names are deeper, so the zone needs an advanced certificate that lists `*.kodo.applet.one` and `*.g.kodo.applet.one`. Without it browsers fail the TLS handshake, and `tunnel.sh dns` refuses to create the records.

### 2.1 Check what exists **[untested]**

```sh
ZONE_ID=$(curl -s -H "$AUTH" "$CF/zones?per_page=50" | jq -r '.result[] | select(.name == "applet.one") | .id')
echo "$ZONE_ID"    # a 32-character ID; empty means the token cannot see the zone
curl -s -H "$AUTH" "$CF/zones/$ZONE_ID/ssl/certificate_packs?status=all" |
  jq -r '.result[] | "\(.type) \(.status) \(.hosts | join(","))"'
```

If an `advanced` pack with status `active` lists both `*.kodo.applet.one` and `*.g.kodo.applet.one`, skip to phase 3.

### 2.2 Order it **[untested]**

In the dashboard: `applet.one` → **SSL/TLS** → **Edge Certificates** → **Order Advanced Certificate** → hostnames `applet.one`, `*.kodo.applet.one`, `*.g.kodo.applet.one` → validation **TXT** → **Save**.

Or with the API, if the token has SSL and Certificates Edit (the API asks for the zone's own name in the list):

```sh
curl -s -X POST -H "$AUTH" -H 'Content-Type: application/json' "$CF/zones/$ZONE_ID/ssl/certificate_packs/order" -d '{
  "type": "advanced",
  "hosts": ["*.kodo.applet.one", "*.g.kodo.applet.one"],
  "validation_method": "txt",
  "validity_days": 90,
  "certificate_authority": "google"
}' | jq '{success, errors, id: .result.id, status: .result.status}'
```

The zone's DNS is on Cloudflare, so validation is automatic. Repeat 2.1 until the pack is `active`, usually within minutes.

---

## Phase 3: Authrim client (by hand)

In the Admin UI, `https://adm.applet.one`. These are the same steps as the Applet client in the Applet platform's Authrim runbook (`docs/authrim/RUNBOOK.md`, steps 4.2 and 4.3).

### 3.1 Create the client **[untested]**

1. **Clients** → **Create Client** → type **Server** → name `kodo`.
2. Redirect URI: `https://app.kodo.applet.one/oauth2/callback`.
3. **Create Client**. Save the **Client Secret** in the password manager now; it is shown once.
4. Record the client ID in the Facts table, and add both to `.auth.env`:

   ```sh
   echo 'AUTHRIM_CLIENT_ID=<client id>' >> .auth.env
   echo 'AUTHRIM_CLIENT_SECRET=<client secret>' >> .auth.env
   ```

### 3.2 Set the Default Audience **[untested]**

Open the client → **Edit** → **Scope Settings** → **Default Audience** = `https://auth.applet.one` → **Save Changes**. Without it, sign-in fails at the token step with `invalid_target`. On Authrim's staging it took about a minute to take effect.

### 3.3 Allow `offline_access` **[done]**

The gateway asks for `offline_access` (`scopes` in `SecurityPolicy/kodo-login-public`) so that it gets a refresh token and renews the session without sending the user back to Authrim. A new client allows only `openid`, `profile` and `email`.

Open the client → **Edit** → **Scopes** → **Allowed Scopes** = `openid profile email offline_access` → **Save Changes**. The field is the whole list, space-separated: `offline_access` alone would refuse the other three. Under **OAuth Settings**, **Grant Types** must have both **Authorization Code** and **Refresh Token** ticked.

Without it, sign-in ends on `app.kodo.applet.one/oauth2/callback` with "Auth flow failed" and `error=invalid_scope` in the URL.

### 3.4 Email in the ID token

kodo shares cells and names platform admins by email. Authrim leaves `email` and `email_verified` out of the ID token unless the request carries an OIDC `claims` parameter, and Envoy Gateway cannot send one. Nothing in Authrim's Admin UI changes that (see below), so kodo asks Authrim's userinfo endpoint instead; that is set up in phase 7 (`userinfoURL`, `OIDC_USERINFO_URL` and `forwardAccessToken`), and nothing is needed here.

**Authrim's userinfo endpoint needs a fix first [done 2026-11-26, in the dashboard].** Authrim 0.5.0's setup tool leaves `ISSUER_URL` out of the `ar-userinfo` Worker (`packages/setup/src/core/wrangler.ts` writes it for `ar-auth`, `ar-token`, `ar-discovery` and `ar-management`, not for `ar-userinfo`), and without it the endpoint answers every token with `500 server_error`, "Server configuration error". The Applet platform never calls userinfo, so nothing showed it. Until the Worker has `ISSUER_URL = "https://auth.applet.one"`, users sign in and have no email.

Set it in the Cloudflare dashboard: Worker `production-ar-userinfo` → **Settings** → **Variables and Secrets** → add the plain-text variable `ISSUER_URL` = `https://auth.applet.one` → deploy. A later `pnpm run setup deploy` of Authrim regenerates the Wrangler files and drops it: to keep it, add `component === 'ar-userinfo'` to the list that sets `ISSUER_URL` in `packages/setup/src/core/wrangler.ts` on the patched Authrim branch. `staging-ar-userinfo` has the same gap.

With it set, the page header shows the email in place of the user ID within a minute. Without it, the kernel's log says so:

```sh
kubectl -n kodo logs kodo-0 --since=15m | grep 'userinfo failed'
```

**Tried on 2026-11-26, does not work in Authrim 0.5.0:** a Field Mapping Set made in the Admin UI (**Field Mapping** → a destination profile from **Standard OIDC claims**, a destination Field Mapping Set with `email` and `email_verified` connected, bound on the client under **Claims & ASC**). With the two claims marked **Required**, every sign-in fails: the browser shows "OAuth flow failed." and the gateway's log has Authrim's answer, `500 server_error`, "Failed to apply identity mapping". From Authrim's source, a set saved by the Admin UI's editor produces no claim on the OIDC path, so a required claim is always missing; not marked Required, the claims are silently left out.

To undo it: **Clients** → `kodo` → **Edit** → **Claims & ASC** → **OIDC claims Field Mapping Set** = "Follow the tenant default (no client override)" → **Save Changes**. Leave it there: a bound set also limits what the userinfo endpoint returns.

To see why a sign-in failed at the token step:

```sh
kubectl -n envoy-gateway-system logs deploy/envoy-kodo-gateway-kodo-9c6f46a6 -c envoy --since=15m | grep 'Failed to get access token'
```

---

## Phase 4: Deploy

### 4.1 Create the tunnel and everything in the cluster **[checked]**

```sh
task k3s:tunnel K3S_CONTEXT=k3s-homelab
```

In order, it:

1. Runs `deploy/k3s/tunnel.sh create`: creates the tunnel `kodo` through the API, writes `.tunnel.json`, and creates the Secret `kodo-gateway/cloudflared`. Run again, it keeps the tunnel and only reapplies the Secret.
2. Applies `deploy/k3s/gateway.yaml`: the private CA, the certificate `kodo-applet-one` and the two public listeners.
3. Creates the Secret `kodo/oidc-client-authrim` and applies `deploy/k3s/public.yaml` with the client ID: the public routes and `SecurityPolicy/kodo-login-public`.
4. Applies `deploy/k3s/cloudflared.yaml` and waits for it.

The tunnel ID, where a command needs it:

```sh
jq -r '.TunnelID' .tunnel.json
```

Back up `.tunnel.json` in the password manager. If it is lost the tunnel must be deleted and created again ([Rotate the tunnel's credentials](#rotate-the-tunnels-credentials)).

### 4.2 Verify, before any DNS **[untested]**

```sh
kubectl -n kodo-gateway get certificate kodo-applet-one
# expect: READY True
kubectl -n kodo-gateway get gateway kodo -o jsonpath='{range .status.listeners[*]}{.name} {.conditions[?(@.type=="Programmed")].status} routes={.attachedRoutes}{"\n"}{end}'
# expect: https-public True routes=3, https-public-cells True routes=1
kubectl -n kodo get securitypolicy kodo-login-public -o jsonpath='{range .status.ancestors[*].conditions[*]}{.type}={.status} {.message}{"\n"}{end}'
# expect: Accepted=True
kubectl -n kodo-gateway get pods -l app=cloudflared -o wide
# expect: 2 pods, READY 1/1, on different nodes
kubectl -n kodo-gateway logs -l app=cloudflared --tail=50 | grep -i 'registered tunnel connection'
# expect: four lines per pod
curl -s -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$(jq -r .TunnelID .tunnel.json)" | jq -r '.result.status'
# expect: healthy
```

The gateway answers for the public names on the LAN address too, with the private certificate, so the routes and the login redirect can be checked before the names exist (`-k` because the CA is private):

```sh
curl -sk --connect-to ::192.168.2.224: -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.kodo.applet.one/api/whoami
# expect: 302 https://auth.applet.one/authorize?client_id=<client id>&...
curl -sk --connect-to ::192.168.2.224: -o /dev/null -w '%{http_code} %{redirect_url}\n' https://probe.g.kodo.applet.one/
# expect: 302 to the same place
```

---

## Phase 5: DNS

### 5.1 Create the records **[untested]**

```sh
deploy/k3s/tunnel.sh dns
# expect:
#   app.kodo.applet.one -> <tunnel id>.cfargotunnel.com (proxied)
#   *.g.kodo.applet.one -> <tunnel id>.cfargotunnel.com (proxied)
```

It stops with `no active edge certificate covers ...` if phase 2 is not done. `FORCE=1 deploy/k3s/tunnel.sh dns` skips that check; use it only if the check itself is wrong.

### 5.2 Verify from outside **[untested]**

```sh
dig +short app.kodo.applet.one probe.g.kodo.applet.one
# expect: Cloudflare addresses for both
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.kodo.applet.one/api/whoami
# expect: 302 https://auth.applet.one/authorize?...
curl -s -o /dev/null -w '%{http_code} %{redirect_url}\n' https://probe.g.kodo.applet.one/
# expect: 302 to the same place
```

---

## Phase 6: Sign in

**[untested]** The fleet must be running; it may be suspended to save bucket requests:

```sh
kubectl -n kodo get fleet kodo -o jsonpath='{.spec.suspend}{"\n"}'
kubectl -n kodo patch fleet kodo --type merge -p '{"spec":{"suspend":false}}'
kubectl -n kodo wait fleet/kodo --for=condition=Ready --timeout=600s
```

In a private browser window open `https://app.kodo.applet.one/` and sign in with an email code.

| Result | Meaning |
| --- | --- |
| Back on `app.kodo.applet.one`, a blank page with "token signed by an unknown key" | Expected before phase 7. The gateway accepted the login; the kernel still trusts Dex, and Authrim's signing key is not among Dex's. |
| "Auth flow failed", `error=invalid_scope` in the URL | The client does not allow `offline_access` (3.3). |
| The dashboard | Phase 7 is done and everything works. |
| An Authrim error page naming the redirect URI | The redirect URI on the client is not exactly `https://app.kodo.applet.one/oauth2/callback` (3.1). |
| `invalid_target` | Default Audience missing or not yet applied (3.2). |
| An error mentioning `code_challenge` or PKCE | Authrim wants PKCE and the gateway did not send it. See [Open items](#open-items). |
| Login loops | Cookies from an earlier attempt: clear cookies for `kodo.applet.one`, or see "Requests return 401, or login loops" in the [main runbook](runbook.md). |

---

## Phase 7: Make Authrim the identity provider

**[done 2026-11-26]** The kernel and the Gatekeeper accept ID tokens from one issuer. This phase moves both from Dex to Authrim. From then on a Dex token is refused, so the hiddenfield.dev login moves to Authrim in the same change (7.4). Dex keeps running for `tap.hiddenfield.dev`, which has its own Dex client.

The edits below are on main since 2026-11-26; the commands apply them.

### 7.1 Fleet: `deploy/k3s/fleet.yaml`

```yaml
  auth:
    issuer: https://auth.applet.one
    # The Authrim client ID: Authrim's ID tokens name the client as audience.
    audience: <client id>
    jwksURL: https://auth.applet.one/.well-known/jwks.json
    # Authrim's ID tokens carry no email (3.4): the kernel asks here, with
    # the access token the gateway forwards.
    userinfoURL: https://auth.applet.one/userinfo
  # No `admins` here: the repository is public. Name the platform admins on
  # the cluster; applying this file leaves them as they are.
  egress:
    proxy: true
    # Remove the allow rule for Dex: the keys now come from outside, through
    # the Gatekeeper's egress proxy.
```

### 7.2 Gatekeeper: `deploy/k3s/gatekeeper/kustomization.yaml`

```yaml
      - OIDC_ISSUER=https://auth.applet.one
      - OIDC_AUDIENCE=<client id>
      - OIDC_JWKS_URL=https://auth.applet.one/.well-known/jwks.json
      - OIDC_USERINFO_URL=https://auth.applet.one/userinfo
      # Tigris, and Authrim's signing keys for the fleet's kernel.
      - GATEKEEPER_EGRESS_ALLOW=t3.storage.dev:443,*.t3.storage.dev:443,auth.applet.one:443
```

Both login policies also need the access token forwarded, or there is nothing to ask the userinfo endpoint with: `forwardAccessToken: true` under `oidc` in `SecurityPolicy/kodo-login-public` (`deploy/k3s/public.yaml`) and in `SecurityPolicy/kodo-login` (`deploy/k3s/routes.yaml`, 7.4).

The platform admins, by the address they sign in to Authrim with:

```sh
kubectl -n kodo patch fleet kodo --type merge -p '{"spec":{"admins":{"emails":["<address>"]}}}'
```

### 7.3 Apply

`task k3s:gatekeeper` and the Fleet manifest set images, so pass the ones running now:

```sh
GK=$(kubectl -n kodo-system get deploy kodo-gatekeeper -o jsonpath='{.spec.template.spec.containers[0].image}')
KERNEL=$(kubectl -n kodo get fleet kodo -o jsonpath='{.spec.kernel}')
task k3s:gatekeeper K3S_CONTEXT=k3s-homelab GATEKEEPER_IMAGE=$GK
sed "s#KERNEL_IMAGE#$KERNEL#" deploy/k3s/fleet.yaml | kubectl apply -f -
kubectl -n kodo wait fleet/kodo --for=condition=KernelDeployed --timeout=600s
kubectl -n kodo get fleet kodo -o jsonpath='{range .status.conditions[*]}{.type}={.status} {.reason}{"\n"}{end}'
```

Applying `fleet.yaml` also sets `replicas` and the celld image to the ones in the file; check they match what runs (`kubectl -n kodo get fleet kodo -o jsonpath='{.spec.replicas} {.spec.celld}{"\n"}'`). It leaves `suspend` as it is.

`task k3s:gatekeeper` reads `.env` and `.buckets.env` to recreate the Gatekeeper's Secrets. Where those files are not at hand, the Secrets in the cluster are still good, and this applies the same change in one rollout:

```sh
kubectl kustomize deploy/k3s/gatekeeper | sed "s#kodo-gatekeeper:main#${GK##*/}#" | kubectl apply -f -
kubectl -n kodo-system rollout status deploy/kodo-gatekeeper --timeout=300s
```

Check that the kernel fetches Authrim's keys, without signing in: send it a token that names one of Authrim's keys and carries a bad signature.

```sh
b64() { printf '%s' "$1" | base64 | tr '+/' '-_' | tr -d '=\n'; }
KID=$(curl -s https://auth.applet.one/.well-known/jwks.json | jq -r '[.keys[] | select(.alg == "RS256")][0].kid')
TOKEN="$(b64 "{\"alg\":\"RS256\",\"kid\":\"$KID\"}").$(b64 '{"sub":"probe"}').AAAA"
kubectl -n kodo run idp-probe --rm -i --restart=Never --quiet --image=curlimages/curl:8.16.0 -- \
  curl -s -m 40 -H "x-kodo-identity: $TOKEN" http://kodo.kodo.svc/api/whoami
# expect: bad token signature (the kernel fetched the keys and found this one)
```

`cannot fetch signing keys`, or no answer, means the kernel's `fetch` is not going through the egress proxy: roll back (7.5). Then repeat phase 6.

### 7.4 The hiddenfield.dev login

1. In Authrim, add a second redirect URI to the `kodo` client: `https://app.hiddenfield.dev/oauth2/callback`.
2. In `deploy/k3s/routes.yaml`, `SecurityPolicy/kodo-login`: set `issuer: https://auth.applet.one`, `clientID: <client id>` and `clientSecret.name: oidc-client-authrim`. Leave `redirectURL` and `cookieDomain` as they are.
3. Apply and check:

   ```sh
   kubectl apply -f deploy/k3s/routes.yaml
   curl -s --connect-to ::192.168.2.224: -o /dev/null -w '%{http_code} %{redirect_url}\n' https://app.hiddenfield.dev/api/whoami
   # expect: 302 https://auth.applet.one/authorize?...
   ```

The end-to-end tests (`task k3s:*-test`) log in as alice, bob and carol through Dex's password form. They fail after this phase until `test/e2e/lib.sh` has a way to sign in to Authrim.

### 7.5 Roll back phase 7

Main has the Authrim settings, so the Dex ones come from the last commit before them, `373d073`:

```sh
git checkout 373d073 -- deploy/k3s/fleet.yaml deploy/k3s/gatekeeper/kustomization.yaml deploy/k3s/routes.yaml
task k3s:gatekeeper K3S_CONTEXT=k3s-homelab GATEKEEPER_IMAGE=$GK
sed "s#KERNEL_IMAGE#$KERNEL#" deploy/k3s/fleet.yaml | kubectl apply -f -
kubectl apply -f deploy/k3s/routes.yaml
kubectl -n kodo wait fleet/kodo --for=condition=KernelDeployed --timeout=600s
```

Cells and their data are keyed by the user's `sub`, which differs between Dex and Authrim: what a Dex user owned is not visible to the same person signed in through Authrim, and comes back with the rollback. On 2026-11-26 the Dex users' three cells in `team` were deleted, so a rollback brings back their logins, chats and workspace memberships, not those cells.

---

## Operations

### Health

```sh
kubectl -n kodo-gateway get pods -l app=cloudflared
curl -s -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$(jq -r .TunnelID .tunnel.json)" | jq -r '.result | "\(.status) connections=\(.connections | length)"'
# expect: healthy connections=8
kubectl -n kodo-gateway logs -l app=cloudflared --tail=100
```

### Change a hostname or the origin

Edit the `ingress` list in `deploy/k3s/cloudflared.yaml`, bump the `kodo.dev/config-version` annotation so the pods restart, and apply. A new hostname also needs a listener and certificate name in `gateway.yaml`, a route in `public.yaml`, coverage by the edge certificate, and a DNS record (add it to `NAMES` in `tunnel.sh`).

```sh
kubectl apply -f deploy/k3s/cloudflared.yaml
kubectl -n kodo-gateway rollout status deploy/cloudflared
```

### Upgrade cloudflared

Change the image tag in `deploy/k3s/cloudflared.yaml` and apply as above. The two replicas restart one at a time, so the tunnel stays up.

### Take kodo offline, keep everything

```sh
deploy/k3s/tunnel.sh undns      # the names stop resolving
deploy/k3s/tunnel.sh dns        # and come back
```

Faster and without DNS delay: `kubectl -n kodo-gateway scale deploy/cloudflared --replicas=0` (visitors get Cloudflare error 1033), and `--replicas=2` to return.

### Rotate the tunnel's credentials

A tunnel's secret cannot be changed in place here; replace the tunnel. Public access is down for about a minute.

```sh
kubectl -n kodo-gateway scale deploy/cloudflared --replicas=0
ID=$(jq -r .TunnelID .tunnel.json)
curl -s -X DELETE -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$ID" | jq '.success'
rm .tunnel.json
deploy/k3s/tunnel.sh create
deploy/k3s/tunnel.sh dns        # the records must name the new tunnel
kubectl -n kodo-gateway scale deploy/cloudflared --replicas=2
kubectl -n kodo-gateway rollout status deploy/cloudflared
```

If the delete answers that the tunnel has active connections, wait for the pods to stop and repeat it.

### Rotate the Authrim client secret

Create a new secret for the `kodo` client in the Admin UI, replace `AUTHRIM_CLIENT_SECRET` in `.auth.env`, then:

```sh
set -a; . ./.auth.env; set +a
kubectl -n kodo create secret generic oidc-client-authrim --from-literal=client-secret="$AUTHRIM_CLIENT_SECRET" \
  --dry-run=client -o yaml | kubectl apply -f -
```

### Rotate the API token

Roll it in the dashboard (API Tokens → `kodo tunnel` → **Roll**) and replace `CLOUDFLARE_TUNNEL_API_TOKEN` in `.env`. The cluster does not hold this token; a running tunnel is not affected.

## Troubleshooting

| Symptom | Cause and fix |
| --- | --- |
| Browser: TLS handshake fails (`ERR_SSL_VERSION_OR_CIPHER_MISMATCH`) | No active edge certificate covers the name. Phase 2. |
| Cloudflare error 1033 | No `cloudflared` is connected: pods down, or the DNS record names an old tunnel. Check Health; after a rotation run `tunnel.sh dns`. |
| Cloudflare 502 Bad Gateway | `cloudflared` cannot reach or does not trust the gateway. Its log names the reason: `x509: certificate signed by unknown authority` means the CA changed under a running pod (restart: `kubectl -n kodo-gateway rollout restart deploy/cloudflared`); a connection error means the Service name in `cloudflared.yaml` no longer matches (`kubectl -n envoy-gateway-system get svc -l gateway.envoyproxy.io/owning-gateway-name=kodo`). |
| 404 with an empty body | The hostname is not in `cloudflared`'s `ingress` list, or no route has it. |
| Pods stuck `ContainerCreating` | The Secret `cloudflared` or `kodo-applet-one-tls` is missing: run `task k3s:tunnel`, check the certificate (4.2). |
| Pods restart, log says `Unauthorized: Invalid tunnel secret` | The Secret does not match the tunnel, usually after `.tunnel.json` was replaced. `deploy/k3s/tunnel.sh create` reapplies it; then restart the pods. |
| `tunnel.sh` says the tunnel exists but `.tunnel.json` does not | Restore the file from the password manager, or replace the tunnel (Rotate the tunnel's credentials, from the `curl -X DELETE`, with the ID from `curl -s -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=kodo&is_deleted=false" \| jq -r '.result[0].id'`). |
| "token signed by an unknown key" after login (or "token from another issuer") | The kernel trusts another issuer than the login used: it looks for the token's key among its own issuer's keys before it compares issuers. Phase 7. |
| WebSockets close after a quiet spell | Idle connections are dropped by the gateway after 5 minutes, and Cloudflare has its own idle limit in front of it (not measured here). Clients must reconnect or send pings. |

## Remove everything

```sh
deploy/k3s/tunnel.sh undns
kubectl delete -f deploy/k3s/cloudflared.yaml
kubectl delete -f deploy/k3s/public.yaml
kubectl -n kodo delete secret oidc-client-authrim
kubectl -n kodo-gateway delete secret cloudflared
curl -s -X DELETE -H "$AUTH" "$CF/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel/$(jq -r .TunnelID .tunnel.json)" | jq '.success'
rm .tunnel.json
```

Then, if public access is gone for good: remove the two public listeners, the two Issuers and the two Certificates from `deploy/k3s/gateway.yaml` and delete them from the cluster (`kubectl -n kodo-gateway delete certificate kodo-applet-one tunnel-ca; kubectl -n kodo-gateway delete issuer tunnel-ca selfsigned; kubectl -n kodo-gateway delete secret kodo-applet-one-tls tunnel-ca`), delete the `kodo` client in Authrim, and delete the API token in the dashboard. If phase 7 was done, roll it back first (7.5).

## Open items

1. ~~Email~~ (3.4). Settled on 2026-11-26: the kernel and the Gatekeeper ask Authrim's userinfo endpoint for it (7.1, 7.2). Left to do: make the `ISSUER_URL` of Authrim's `ar-userinfo` Worker survive a redeploy (3.4).
2. ~~The kernel fetching Authrim's keys~~ (7.3). Settled on 2026-11-26: with celld 0.6.2 the kernel's `fetch` goes through `HTTPS_PROXY`, and the kernel reads Authrim's keys through the Gatekeeper's egress proxy.
3. **PKCE**. Authrim advertises S256; whether it requires PKCE for a Server client, and whether Envoy Gateway 1.9.2 sends it, shows at the first login (phase 6).
4. **End-to-end tests** sign in through Dex (7.4).
5. **Sign-out** ends the gateway's session at `/logout`; whether it also ends the Authrim session and where the browser lands has not been checked.
