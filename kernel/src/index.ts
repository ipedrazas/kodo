import { ADMIN_PAGE } from "./admin-page";
import { api } from "./api";
import type { Env } from "./env";
import { HOME_PAGE } from "./home";
import { SETTINGS_PAGE } from "./settings";
import { cellFromHost } from "./hostname";
import { CALLER_HEADER, CELL_HEADER, text } from "./http";
import { IdentityError, identify, isAdmin } from "./identity";
import { noteUser, platformView } from "./platform";

export { Catalog } from "./catalog";
export { Cell } from "./cell";
export { GadgetHost, Keys } from "./host";
export { Platform } from "./platform";
export { Session } from "./session";
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
    const settings = !cell && (url.pathname === "/settings" || url.pathname === "/settings/") && request.method === "GET";
    const adminPage = !cell && (url.pathname === "/admin" || url.pathname === "/admin/") && request.method === "GET";
    const page = !cell && request.method === "GET" && (url.pathname === "/" || settings || adminPage);
    if (!cell && first !== "api" && !page) return text(404, "not found");

    let caller;
    try {
      caller = await identify(request, env);
    } catch (err) {
      if (err instanceof IdentityError) return text(401, err.message);
      throw err;
    }
    // A suspended user is refused everywhere: the API, their chats' turns,
    // every cell, their own included.
    if (caller.kind !== "admin" && (await platformView(env)).suspended.has(caller.user)) {
      return text(403, "your account is suspended; ask a platform admin");
    }
    if (caller.kind === "user") await noteUser(env, caller.user, caller.email);
    // Every cell has its own origin; a browser request from any other origin
    // may read (subject to CORS) but not change anything or open a socket.
    if (crossOrigin(request, url)) return text(403, "cross-origin request refused");
    // A turn token is for the API, and only its own session there.
    if (caller.kind === "turn" && (cell || page)) return text(403, "a turn token may use only its own session");
    if (settings && url.pathname === "/settings") return Response.redirect(new URL("/settings/" + url.search, url).toString(), 301);
    if (adminPage && url.pathname === "/admin") return Response.redirect(new URL("/admin/" + url.search, url).toString(), 301);
    if (adminPage && !isAdmin(caller)) return text(403, "the admin dashboard is for platform admins");
    if (page) {
      return new Response(adminPage ? ADMIN_PAGE : settings ? SETTINGS_PAGE : HOME_PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // No other page, a gadget's included, may frame the admin's.
          "content-security-policy":
            "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'" + (adminPage ? "; frame-ancestors 'none'" : ""),
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
