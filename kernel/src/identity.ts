import { type AuthConfig, authConfig } from "./config";
import type { Env } from "./env";
import { sha256Hex } from "./http";
import { platform } from "./platform";
import { TURN_HEADER, verifyTurn } from "./turn";

// The gateway forwards the caller's OIDC ID token in this header; the
// operator sends its admin token in the other. Where the kernel has a
// userinfo endpoint, the gateway also forwards the caller's access token, as
// a bearer token in Authorization.
export const IDENTITY_HEADER = "x-kodo-identity";
export const ACCESS_HEADER = "authorization";
export const ADMIN_HEADER = "x-kodo-admin-token";

// A turn is the agent acting for a session's owner during one turn of the
// session; see turn.ts. It may use only that session. A user who is a
// platform admin carries `platformAdmin`; a turn never does, whoever its
// owner is.
export type Caller =
  | { kind: "admin" }
  | { kind: "user"; user: string; email: string; platformAdmin?: true }
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
  let claims = await verifyJwt(token, config);
  const user = claims.sub;
  if (typeof user !== "string" || !user) throw new IdentityError("token has no subject");
  if (typeof claims.email !== "string" && config.userinfoUrl) {
    const known = await emailOf(env, config.userinfoUrl, user, bearer(request));
    if (known) claims = { ...claims, email: known.email, email_verified: known.verified ?? undefined };
  }
  // Shares and workspace roles are keyed by email, so an email the IdP says
  // is unverified is not used at all.
  const email = typeof claims.email === "string" && claims.email_verified !== false ? claims.email.toLowerCase() : "";
  const caller: Caller = { kind: "user", user, email };
  if (isPlatformAdmin(claims, email, config)) caller.platformAdmin = true;
  return caller;
}

// An issuer may leave the email out of its ID tokens and give it only at its
// userinfo endpoint, to whoever holds the user's access token. The kernel
// then asks there, for the subject the ID token named, and remembers the
// answer in the platform's store: a call that arrives without the access
// token, such as the agent's, finds the email there.
interface KnownEmail {
  email: string;
  verified: boolean | null;
}

const EMAIL_TTL_MS = 10 * 60_000;
const EMAIL_RETRY_MS = 60_000;
// By subject, per isolate: what is known, and when to ask again.
const emails = new Map<string, { known: KnownEmail | null; until: number }>();

function bearer(request: Request): string {
  const match = /^Bearer\s+(\S+)$/i.exec(request.headers.get(ACCESS_HEADER) ?? "");
  return match ? match[1] : "";
}

async function emailOf(env: Env, url: string, sub: string, access: string): Promise<KnownEmail | null> {
  const cached = emails.get(sub);
  if (cached && Date.now() < cached.until) return cached.known;
  if (emails.size > 10_000) emails.clear();
  let known: KnownEmail | null = null;
  let fresh = false;
  if (access) {
    try {
      known = await userinfo(url, sub, access);
      fresh = true;
    } catch (err) {
      console.log(`userinfo failed: ${err instanceof Error ? err.message : err}`);
    }
  }
  try {
    if (fresh && known) {
      const stored = cached?.known;
      if (!stored || stored.email !== known.email || stored.verified !== known.verified) {
        await platform(env).setEmail(sub, known.email, known.verified);
      }
    } else if (!fresh) {
      known = await platform(env).email(sub);
    }
  } catch (err) {
    console.log(`the email store failed: ${err instanceof Error ? err.message : err}`);
  }
  // Without an answer from the provider, ask again soon.
  emails.set(sub, { known, until: Date.now() + (fresh ? EMAIL_TTL_MS : EMAIL_RETRY_MS) });
  return known;
}

// The email the provider gives for the holder of an access token, or null
// if it gives none. The token must be the same user's as the ID token: a
// client must not gain another user's email by sending their own token.
async function userinfo(url: string, sub: string, access: string): Promise<KnownEmail | null> {
  const res = await fetch(url, { headers: { authorization: `Bearer ${access}`, accept: "application/json" } });
  if (!res.ok) throw new IdentityError(`userinfo answered ${res.status}`);
  const body = (await res.json()) as Record<string, unknown>;
  if (body.sub !== sub) throw new IdentityError("userinfo is for another subject");
  if (typeof body.email !== "string" || !body.email) return null;
  return { email: body.email, verified: typeof body.email_verified === "boolean" ? body.email_verified : null };
}

// Whether a verified token names a platform admin: a member of the
// configured group, or one of the bootstrap emails, which the IdP must say
// it verified.
function isPlatformAdmin(claims: Record<string, unknown>, email: string, config: AuthConfig): boolean {
  if (config.adminGroup) {
    const groups = claims[config.adminGroupsClaim];
    if (Array.isArray(groups) ? groups.includes(config.adminGroup) : groups === config.adminGroup) return true;
  }
  return Boolean(email) && claims.email_verified === true && config.adminEmails.includes(email);
}

// Whether a caller may administer the platform: the operator's admin token,
// or a platform admin through their own login.
export const isAdmin = (caller: Caller): boolean =>
  caller.kind === "admin" || (caller.kind === "user" && caller.platformAdmin === true);

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
