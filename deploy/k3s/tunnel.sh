#!/usr/bin/env bash
# The Cloudflare Tunnel that serves kodo publicly at kodo.applet.one
# (deploy/k3s/cloudflared.yaml), through Cloudflare's API:
#
#   tunnel.sh create   create the tunnel, once, and the Secret
#                      kodo-gateway/cloudflared that cloudflared runs with
#   tunnel.sh dns      point app.kodo.applet.one and *.g.kodo.applet.one at
#                      the tunnel (proxied CNAMEs)
#   tunnel.sh undns    remove those two records
#
# .env needs CLOUDFLARE_ACCOUNT_ID, the account that holds the applet.one
# zone (a tunnel serves only hostnames in its own account), and
# CLOUDFLARE_TUNNEL_API_TOKEN with Account: Cloudflare Tunnel Edit and, on the
# zone, Zone Read, DNS Edit and SSL and Certificates Read. It is not
# CLOUDFLARE_API_TOKEN, which is cert-manager's, for hiddenfield.dev.
#
# The tunnel's credentials go to .tunnel.json (git-ignored). The tunnel is
# locally configured: its hostnames and origin are in cloudflared.yaml, not
# in the dashboard. To start again, delete the tunnel in the dashboard and
# remove .tunnel.json.
set -euo pipefail
cd "$(dirname "$0")/../.."
ZONE=${ZONE:-applet.one}
DOMAIN=${DOMAIN:-kodo.$ZONE}
TUNNEL_NAME=${TUNNEL_NAME:-kodo}
NAMES=("app.$DOMAIN" "*.g.$DOMAIN")
set -a
# shellcheck disable=SC1091
. ./.env
set +a
: "${CLOUDFLARE_ACCOUNT_ID:?the Cloudflare account that holds the $ZONE zone}"
: "${CLOUDFLARE_TUNNEL_API_TOKEN:?a Cloudflare API token that can edit tunnels and the DNS of the zone}"

fail() { echo "$*" >&2; exit 1; }

# api METHOD PATH [JSON]: the response, or Cloudflare's errors and a failure.
api() {
  local out args=(-sS -m 30 -X "$1" -H "Authorization: Bearer $CLOUDFLARE_TUNNEL_API_TOKEN")
  [[ -n ${3:-} ]] && args+=(-H 'Content-Type: application/json' -d "$3")
  out=$(curl "${args[@]}" "https://api.cloudflare.com/client/v4$2")
  jq -e '.success == true' >/dev/null 2>&1 <<<"$out" || {
    echo "Cloudflare $1 $2: $(jq -c '.errors' <<<"$out" 2>/dev/null || echo "$out")" >&2
    return 1
  }
  echo "$out"
}

zone() {
  local id
  # CLOUDFLARE_ZONE_ID (the zone's Overview page shows it) saves the lookup,
  # for a token that can edit the zone's DNS but not list zones.
  [[ -n ${CLOUDFLARE_ZONE_ID:-} ]] && { echo "$CLOUDFLARE_ZONE_ID"; return; }
  id=$(api GET "/zones?per_page=50" | jq -r --arg z "$ZONE" '.result[] | select(.name == $z) | .id')
  [[ -n $id ]] || fail "the token cannot see a zone named $ZONE: give it Zone Read on the zone, or set CLOUDFLARE_ZONE_ID in .env"
  echo "$id"
}

# drop ZONE_ID NAME: removes the name's address records.
drop() {
  local id
  for id in $(api GET "/zones/$1/dns_records?name=$(jq -rn --arg n "$2" '$n|@uri')" |
    jq -r '.result[] | select(.type == "A" or .type == "AAAA" or .type == "CNAME") | .id'); do
    api DELETE "/zones/$1/dns_records/$id" >/dev/null
  done
}

case ${1:-} in
  create)
    if [[ ! -f .tunnel.json ]]; then
      existing=$(api GET "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel?name=$TUNNEL_NAME&is_deleted=false" | jq -r '.result[0].id // empty')
      [[ -z $existing ]] || fail "tunnel $TUNNEL_NAME ($existing) exists but .tunnel.json does not: restore the file, or delete the tunnel and run this again"
      secret=$(openssl rand -base64 32)
      id=$(api POST "/accounts/$CLOUDFLARE_ACCOUNT_ID/cfd_tunnel" \
        "$(jq -n --arg name "$TUNNEL_NAME" --arg secret "$secret" '{name: $name, tunnel_secret: $secret, config_src: "local"}')" | jq -r '.result.id')
      (umask 077 && jq -n --arg a "$CLOUDFLARE_ACCOUNT_ID" --arg i "$id" --arg s "$secret" \
        '{AccountTag: $a, TunnelID: $i, TunnelSecret: $s}' > .tunnel.json)
      echo "created tunnel $TUNNEL_NAME ($id)"
    fi
    id=$(jq -r '.TunnelID' .tunnel.json)
    kubectl create namespace kodo-gateway --dry-run=client -o yaml | kubectl apply -f - >/dev/null
    kubectl -n kodo-gateway create secret generic cloudflared \
      --from-file=credentials.json=.tunnel.json --from-literal=TUNNEL_ID="$id" \
      --dry-run=client -o yaml | kubectl apply -f -
    ;;
  dns)
    [[ -f .tunnel.json ]] || fail "no .tunnel.json: run tunnel.sh create first"
    id=$(jq -r '.TunnelID' .tunnel.json)
    zone=$(zone)
    # Cloudflare's free certificate covers the zone and one level of names
    # under it, so neither of these. Proxied without a certificate, a name
    # fails its TLS handshake.
    hosts=$(api GET "/zones/$zone/ssl/certificate_packs?status=all" |
      jq -c '[.result[] | select(.status == "active") | .hosts[]?]') || hosts='[]'
    for want in "*.$DOMAIN" "*.g.$DOMAIN"; do
      [[ $want == "*.$DOMAIN" ]] && alt="app.$DOMAIN" || alt=$want
      if ! jq -e --arg a "$want" --arg b "$alt" 'index($a) != null or index($b) != null' >/dev/null <<<"$hosts" && [[ -z ${FORCE:-} ]]; then
        fail "no active edge certificate covers $alt. Order an advanced certificate for *.$DOMAIN and *.g.$DOMAIN (SSL/TLS, Edge Certificates), or set FORCE=1"
      fi
    done
    for name in "${NAMES[@]}"; do
      drop "$zone" "$name"
      api POST "/zones/$zone/dns_records" "$(jq -n --arg name "$name" --arg content "$id.cfargotunnel.com" \
        '{name: $name, type: "CNAME", content: $content, proxied: true, ttl: 1, comment: "kodo: deploy/k3s/tunnel.sh"}')" >/dev/null
      echo "$name -> $id.cfargotunnel.com (proxied)"
    done
    ;;
  undns)
    zone=$(zone)
    for name in "${NAMES[@]}"; do
      drop "$zone" "$name"
      echo "$name removed"
    done
    ;;
  *)
    fail "usage: tunnel.sh create | dns | undns"
    ;;
esac
