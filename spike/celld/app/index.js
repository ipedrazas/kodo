import { DurableObject } from "cloudflare:workers";

// Baseline: a plain Durable Object, used for the durability and failover runs.
export class Counter extends DurableObject {
  async fetch() {
    let n = (await this.ctx.storage.get("n")) ?? 0;
    n++;
    await this.ctx.storage.put("n", n);
    return Response.json({ n });
  }
}

// A gadget cell. The gadget code is not part of this deployment: the cell
// fetches the bundle from object storage by digest and runs its App class as a
// facet with its own SQLite database, no bindings and no outbound network.
export class Cell extends DurableObject {
  async fetch(request) {
    const digest = new URL(request.url).searchParams.get("bundle") ??
      (await this.ctx.storage.get("bundle"));
    if (!digest) return new Response("no bundle bound to this cell\n", { status: 404 });
    await this.ctx.storage.put("bundle", digest);

    const worker = this.env.LOADER.get(digest, async () => {
      const object = await this.env.BUNDLES.get(`sha256/${digest}.js`);
      if (!object) throw new Error(`bundle ${digest} not found`);
      return {
        compatibilityDate: "2026-01-01",
        mainModule: "gadget.js",
        modules: { "gadget.js": await object.text() },
        env: {},
        globalOutbound: null,
      };
    });
    const facet = this.ctx.facets.get("gadget", () => ({
      class: worker.getDurableObjectClass("App"),
    }));
    return facet.fetch(request);
  }
}

export default {
  fetch(request, env) {
    const url = new URL(request.url);
    const [, kind, name] = url.pathname.split("/");
    if (kind === "counter" && name) return env.COUNTER.getByName(name).fetch(request);
    if (kind === "cell" && name) return env.CELL.getByName(name).fetch(request);
    return new Response("not found\n", { status: 404 });
  },
};
