import { type AuthConfig, authConfig } from "./config";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import { TURN_HEADER, verifyTurn } from "./turn";

// The gateway forwards the caller's OIDC ID token in this header; the
// operator sends its admin token in the other.
export const IDENTITY_HEADER = "x-kodo-identity";
export const ADMIN_HEADER = "x-kodo-admin-token";

// A turn is the agent acting for a session's owner during one turn of the
// session; see turn.ts. It may use only that session.
export type Caller =
  | { kind: "admin" }
  | { kind: "user"; user: string; email: string }
  | { kind: "turn"; user: string; email: string; workspace: string; session: string; turn: string };

export class IdentityError extends Error {}

// Establishes who is calling. Throws IdentityError when the request carries no
// valid identity.
export async function identify(request: Request, env: Env): Promise<Caller> {
  const config = authConfig(env);
  const admin = request.headers.get(ADMIN_HEADER);
  if (admin) {
    if (config.adminTokenSha256 && (await sha256Hex(new TextEncoder().encode(admin))) === config.adminTokenSha256) {
      return { kind: "admin" };
    }
    throw new IdentityError("invalid admin token");
  }
  const turn = request.headers.get(TURN_HEADER);
  if (turn) {
    const claims = await verifyTurn(env, turn);
    if (!claims) throw new IdentityError("invalid or expired turn token");
    const { user, email, workspace, session } = claims;
    return { kind: "turn", user, email, workspace, session, turn: claims.turn };
  }
  const token = request.headers.get(IDENTITY_HEADER);
  if (!token) throw new IdentityError("missing identity");
  if (!config.issuer || !config.audience || !config.jwksUrl) {
    throw new IdentityError("the kernel has no identity provider configured");
  }
  const claims = await verifyJwt(token, config);
  if (typeof claims.sub !== "string" || !claims.sub) throw new IdentityError("token has no subject");
  const email = typeof claims.email === "string" ? claims.email.toLowerCase() : "";
  return { kind: "user", user: claims.sub, email };
}

interface Jwk extends JsonWebKey {
  kid?: string;
}

interface KeyAlgorithm {
  name: string;
  hash?: string;
  namedCurve?: string;
}

const ALGORITHMS: Record<string, KeyAlgorithm> = {
  RS256: { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
  ES256: { name: "ECDSA", namedCurve: "P-256" },
};
const CLOCK_SKEW_S = 30;
const JWKS_TTL_MS = 10 * 60 * 1000;

let jwks: { url: string; keys: Jwk[]; fetched: number } | undefined;

async function signingKeys(url: string, refresh: boolean): Promise<Jwk[]> {
  if (!refresh && jwks && jwks.url === url && Date.now() - jwks.fetched < JWKS_TTL_MS) return jwks.keys;
  const res = await fetch(url);
  if (!res.ok) throw new IdentityError(`cannot fetch signing keys: ${res.status}`);
  const body = (await res.json()) as { keys?: Jwk[] };
  jwks = { url, keys: body.keys ?? [], fetched: Date.now() };
  return jwks.keys;
}

function b64url(s: string): Uint8Array {
  const b64 = s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=");
  return Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
}

async function verifyJwt(token: string, config: AuthConfig): Promise<Record<string, unknown>> {
  const parts = token.split(".");
  if (parts.length !== 3) throw new IdentityError("malformed token");
  let header: { alg?: string; kid?: string };
  let claims: Record<string, unknown>;
  try {
    header = JSON.parse(new TextDecoder().decode(b64url(parts[0])));
    claims = JSON.parse(new TextDecoder().decode(b64url(parts[1])));
  } catch {
    throw new IdentityError("malformed token");
  }
  const algorithm = header.alg ? ALGORITHMS[header.alg] : undefined;
  if (!algorithm) throw new IdentityError(`unsupported token algorithm ${header.alg}`);

  let keys = await signingKeys(config.jwksUrl, false);
  let jwk = keys.find((k) => k.kid === header.kid);
  if (!jwk) {
    keys = await signingKeys(config.jwksUrl, true);
    jwk = keys.find((k) => k.kid === header.kid);
  }
  if (!jwk) throw new IdentityError("token signed by an unknown key");
  const key = await crypto.subtle.importKey("jwk", jwk, algorithm, false, ["verify"]);
  const verify = algorithm.name === "ECDSA" ? { name: "ECDSA", hash: "SHA-256" } : algorithm;
  const signed = new TextEncoder().encode(`${parts[0]}.${parts[1]}`);
  if (!(await crypto.subtle.verify(verify, key, b64url(parts[2]), signed))) {
    throw new IdentityError("bad token signature");
  }

  const now = Date.now() / 1000;
  if (claims.iss !== config.issuer) throw new IdentityError("token from another issuer");
  const aud = Array.isArray(claims.aud) ? claims.aud : [claims.aud];
  if (!aud.includes(config.audience)) throw new IdentityError("token for another audience");
  if (typeof claims.exp !== "number" || claims.exp < now - CLOCK_SKEW_S) throw new IdentityError("token expired");
  if (typeof claims.nbf === "number" && claims.nbf > now + CLOCK_SKEW_S) throw new IdentityError("token not yet valid");
  return claims;
}
