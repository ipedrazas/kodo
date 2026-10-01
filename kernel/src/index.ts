import { api } from "./api";
import type { Env } from "./env";
import { HOME_PAGE } from "./home";
import { cellFromHost } from "./hostname";
import { CALLER_HEADER, CELL_HEADER, text } from "./http";
import { IdentityError, identify } from "./identity";

export { Catalog } from "./catalog";
export { Cell } from "./cell";
export { GadgetHost, Keys } from "./host";
export { Workspace } from "./workspace";

// Session cookies the gateway sets. They are credentials, so they never reach
// a gadget.
const SESSION_COOKIE = /^(kodo-|OauthHMAC|OauthExpires|OauthNonce|RefreshToken|BearerToken|IdToken|CodeVerifier)/;
const SAFE_METHODS = new Set(["GET", "HEAD", "OPTIONS"]);

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cell = cellFromHost(url.hostname);
    const [, first, ...rest] = url.pathname.split("/");
    const home = !cell && url.pathname === "/" && request.method === "GET";
    if (!cell && first !== "api" && !home) return text(404, "not found");

    let caller;
    try {
      caller = await identify(request, env);
    } catch (err) {
      if (err instanceof IdentityError) return text(401, err.message);
      throw err;
    }
    // Every cell has its own origin; a browser request from any other origin
    // may read (subject to CORS) but not change anything or open a socket.
    if (crossOrigin(request, url)) return text(403, "cross-origin request refused");
    if (home) {
      return new Response(HOME_PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        },
      });
    }

    const headers = new Headers();
    for (const [name, value] of request.headers) {
      if (!name.startsWith("x-kodo-")) headers.set(name, value);
    }
    stripSessionCookies(headers);
    headers.set(CALLER_HEADER, JSON.stringify(caller));
    const forwarded = new Request(request, { headers });

    if (cell) {
      headers.set(CELL_HEADER, cell);
      return env.CELL.getByName(cell).fetch(new Request(request, { headers }));
    }
    return api(forwarded, env, rest.map(decodeURIComponent), caller);
  },
} satisfies ExportedHandler<Env>;

function crossOrigin(request: Request, url: URL): boolean {
  const origin = request.headers.get("Origin");
  const unsafe = !SAFE_METHODS.has(request.method) || request.headers.get("Upgrade")?.toLowerCase() === "websocket";
  if (!unsafe || !origin) return false;
  try {
    return new URL(origin).host !== url.host;
  } catch {
    return true;
  }
}

function stripSessionCookies(headers: Headers): void {
  const cookie = headers.get("Cookie");
  if (!cookie) return;
  const kept = cookie
    .split(";")
    .map((c) => c.trim())
    .filter((c) => c && !SESSION_COOKIE.test(c.split("=")[0]));
  if (kept.length) headers.set("Cookie", kept.join("; "));
  else headers.delete("Cookie");
}
