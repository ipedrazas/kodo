import { api } from "./api";
import type { Env } from "./env";
import { cellFromHost } from "./hostname";
import { CELL_HEADER, text } from "./http";

export { Catalog } from "./catalog";
export { Cell } from "./cell";
export { GadgetHost, Keys } from "./host";
export { Workspace } from "./workspace";

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const url = new URL(request.url);
    const cell = cellFromHost(url.hostname);
    if (cell) {
      const headers = new Headers(request.headers);
      headers.set(CELL_HEADER, cell);
      return env.CELL.getByName(cell).fetch(new Request(request, { headers }));
    }
    const [, first, ...rest] = url.pathname.split("/");
    if (first === "api") return api(request, env, rest.map(decodeURIComponent));
    return text(404, "not found");
  },
} satisfies ExportedHandler<Env>;
