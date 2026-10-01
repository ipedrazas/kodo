#!/bin/sh
# Deploys the kernel with its identity settings from the environment:
#   OIDC_ISSUER, OIDC_AUDIENCE, OIDC_JWKS_URL   the identity provider
#   KERNEL_ADMIN_TOKEN                          the operator's admin token
# and, for capability calls, the Gatekeeper:
#   GATEKEEPER_URL, GATEKEEPER_KEY, FLEET_ID    where it is, the fleet's
#                                               signing key, <namespace>/<fleet>
# The settings are written into src/deploy-config.ts of a copy of the kernel,
# then `celld deploy` runs on the copy with any extra arguments (the bucket
# flags; celld also reads CELLD_BUCKET, S3_ENDPOINT and AWS_*).
# Needs celld and esbuild on PATH.
set -eu
src=$(cd "$(dirname "$0")/.." && pwd)
work=$(mktemp -d)
trap 'rm -rf "$work"' EXIT
cp -R "$src/wrangler.jsonc" "$src/src" "$work/"

# JSON string escaping for values that should never need it, but might.
quote() { printf '"%s"' "$(printf '%s' "$1" | sed -e 's/\\/\\\\/g' -e 's/"/\\"/g')"; }
hash=""
if [ -n "${KERNEL_ADMIN_TOKEN:-}" ]; then
  if command -v sha256sum >/dev/null; then
    hash=$(printf '%s' "$KERNEL_ADMIN_TOKEN" | sha256sum | cut -d' ' -f1)
  else
    hash=$(printf '%s' "$KERNEL_ADMIN_TOKEN" | shasum -a 256 | cut -d' ' -f1)
  fi
fi
cat > "$work/src/deploy-config.ts" <<TS
export const DEPLOY_CONFIG = {
  issuer: $(quote "${OIDC_ISSUER:-}"),
  audience: $(quote "${OIDC_AUDIENCE:-}"),
  jwksUrl: $(quote "${OIDC_JWKS_URL:-}"),
  adminTokenSha256: $(quote "$hash"),
  gatekeeperUrl: $(quote "${GATEKEEPER_URL:-}"),
  gatekeeperKey: $(quote "${GATEKEEPER_KEY:-}"),
  fleet: $(quote "${FLEET_ID:-}"),
};
TS
exec celld deploy "$work" "$@"
