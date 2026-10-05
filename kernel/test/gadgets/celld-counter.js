// testdata/app/gadget-entry.js
import { DurableObject } from "cloudflare:workers";

// testdata/app/src/counter.ts
var Counter = class {
  constructor(state, _env) {
    this.state = state;
  }
  state;
  async fetch(request) {
    if (request.method === "GET") {
      const value = await this.state.storage.get("value") ?? 0;
      return Response.json({ value });
    }
    if (request.method === "POST") {
      const value = (await this.state.storage.get("value") ?? 0) + 1;
      await this.state.storage.put("value", value);
      return Response.json({ value });
    }
    return Response.json({ error: "NOT_FOUND" }, { status: 404 });
  }
};

// testdata/app/gadget-entry.js
var env = new Proxy({}, {
  get(_, key) {
    if (typeof key === "symbol") return void 0;
    throw new Error("env." + key + " is not available in a kodo gadget; it reaches the outside through capability grants");
  }
});
var App = class extends DurableObject {
  #inner;
  constructor(ctx, _env) {
    super(ctx, _env);
    this.#inner = new Counter(ctx, env);
  }
  fetch(request) {
    return this.#inner.fetch(request);
  }
};
export {
  App
};
