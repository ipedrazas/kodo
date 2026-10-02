import type { Env } from "./env";
import { kernelKey } from "./host";

// A turn token lets the agent act in one session for one turn, and nothing
// else: append to its transcript, call the models it holds grants for, and
// run code with its grants. The kernel issues one when the session's owner
// starts a turn, so the agent never needs the owner's ID token for longer
// than that request, and never holds a credential that could manage their
// cells, shares or grants. A token stops working when its turn ends, even
// before it expires; the session checks the turn on every call.
export const TURN_HEADER = "x-kodo-turn";

export interface TurnClaims {
  workspace: string;
  session: string;
  turn: string;
  user: string;
  email: string;
  // Epoch milliseconds.
  expiresAt: number;
}

const enc = new TextEncoder();

const b64url = (bytes: Uint8Array) =>
  btoa(String.fromCharCode(...bytes)).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");

const fromB64url = (s: string) =>
  Uint8Array.from(atob(s.replace(/-/g, "+").replace(/_/g, "/").padEnd(Math.ceil(s.length / 4) * 4, "=")), (c) =>
    c.charCodeAt(0),
  );

// Cell props sign a bare cell id, which never contains ":", so a token
// signed for one can never verify as the other.
const signed = (payload: string) => enc.encode(`turn:${payload}`);

export async function signTurn(env: Env, claims: TurnClaims): Promise<string> {
  const payload = b64url(
    enc.encode(
      JSON.stringify({
        w: claims.workspace,
        s: claims.session,
        t: claims.turn,
        u: claims.user,
        e: claims.email,
        x: claims.expiresAt,
      }),
    ),
  );
  const mac = new Uint8Array(await crypto.subtle.sign("HMAC", await kernelKey(env), signed(payload)));
  return `v1.${payload}.${b64url(mac)}`;
}

// The claims of a valid, unexpired token, or null.
export async function verifyTurn(env: Env, token: string): Promise<TurnClaims | null> {
  const [version, payload, mac, ...extra] = token.split(".");
  if (version !== "v1" || !payload || !mac || extra.length) return null;
  try {
    if (!(await crypto.subtle.verify("HMAC", await kernelKey(env), fromB64url(mac), signed(payload)))) return null;
    const c = JSON.parse(new TextDecoder().decode(fromB64url(payload)));
    const claims: TurnClaims = { workspace: c.w, session: c.s, turn: c.t, user: c.u, email: c.e, expiresAt: c.x };
    if (typeof claims.expiresAt !== "number" || claims.expiresAt <= Date.now()) return null;
    if (![claims.workspace, claims.session, claims.turn, claims.user].every((v) => typeof v === "string" && v)) return null;
    if (typeof claims.email !== "string") return null;
    return claims;
  } catch {
    return null;
  }
}
