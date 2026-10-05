// testdata/app/gadget-entry.js
import { DurableObject } from "cloudflare:workers";

// testdata/app/src/settings.ts
var Settings = class {
  constructor(_state, env2) {
    this.env = env2;
  }
  env;
  async fetch() {
    const key = ["API", "KEY"].join("_");
    return new Response(this.env[key]);
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
    this.#inner = new Settings(ctx, env);
  }
  fetch(request) {
    return this.#inner.fetch(request);
  }
};
export {
  App
};
