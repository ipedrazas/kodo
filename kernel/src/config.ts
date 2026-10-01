import { DEPLOY_CONFIG } from "./deploy-config";
import type { Env } from "./env";

// How the kernel checks identity. Worker variables (set through .dev.vars in
// local development) override the deploy-time configuration.
export interface AuthConfig {
  // The OIDC issuer, e.g. https://auth.hiddenfield.dev.
  issuer: string;
  // The client id tokens must be issued to.
  audience: string;
  // Where the issuer's signing keys are fetched from; may be an in-cluster URL.
  jwksUrl: string;
  // SHA-256 (hex) of the admin token the operator uses, or empty for none.
  adminTokenSha256: string;
}

export function authConfig(env: Env): AuthConfig {
  return {
    issuer: env.OIDC_ISSUER ?? DEPLOY_CONFIG.issuer,
    audience: env.OIDC_AUDIENCE ?? DEPLOY_CONFIG.audience,
    jwksUrl: env.OIDC_JWKS_URL ?? DEPLOY_CONFIG.jwksUrl,
    adminTokenSha256: env.ADMIN_TOKEN_SHA256 ?? DEPLOY_CONFIG.adminTokenSha256,
  };
}

// How the kernel reaches the Gatekeeper, which makes every external call a
// gadget's grants allow. Without a URL, capability calls fail.
export interface GatekeeperConfig {
  // e.g. http://kodo-gatekeeper.kodo-system.svc:8081
  url: string;
  // The fleet's key, shared with the Gatekeeper, that signs each call.
  key: string;
  // The fleet's name as the Gatekeeper knows it: <namespace>/<fleet>.
  fleet: string;
}

export function gatekeeperConfig(env: Env): GatekeeperConfig {
  return {
    url: env.GATEKEEPER_URL ?? DEPLOY_CONFIG.gatekeeperUrl,
    key: env.GATEKEEPER_KEY ?? DEPLOY_CONFIG.gatekeeperKey,
    fleet: env.FLEET_ID ?? DEPLOY_CONFIG.fleet,
  };
}
