import type { Env } from "./env";
import { cellFromHost, isCellId } from "./hostname";
import { CELL_HEADER, sha256Hex, text } from "./http";

export { Cell } from "./cell";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cell = cellFromHost(url.hostname);
    if (cell) {
      const headers = new Headers(request.headers);
      headers.set(CELL_HEADER, cell);
      return env.CELL.getByName(cell).fetch(new Request(request, { headers }));
    }
    if (env.KERNEL_DEV === "1" && url.pathname.startsWith("/_dev/")) return dev(request, env, url);
    return text(404, "not found");
  },
} satisfies ExportedHandler<Env>;

// Local development only: the same writes an operator makes with
// `celld r2 put` against a fleet bucket, which celld dev cannot reach.
//   PUT /_dev/bundles        body: bundle source   -> {"digest": "..."}
//   PUT /_dev/cells/<id>     body: {"bundle": "<digest>"}
async function dev(request: Request, env: Env, url: URL): Promise<Response> {
  if (request.method !== "PUT") return text(405, "use PUT");
  if (url.pathname === "/_dev/bundles") {
    const body = await request.arrayBuffer();
    const digest = await sha256Hex(body);
    await env.BUNDLES.put(`sha256/${digest}.js`, body);
    return Response.json({ digest });
  }
  const id = url.pathname.slice("/_dev/cells/".length);
  if (url.pathname.startsWith("/_dev/cells/") && isCellId(id)) {
    await env.CELLS.put(`${id}.json`, await request.text());
    return Response.json({ cell: id });
  }
  return text(404, "not found");
}
