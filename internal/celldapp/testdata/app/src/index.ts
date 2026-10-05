import { Counter } from "./counter";
import { Tunnel } from "./tunnel";
import { Reminder } from "./reminder";
import { Secret } from "./secret";
import { Settings } from "./settings";

export { Counter, Reminder, Secret, Settings, Tunnel };

export default {
  async fetch(request: Request, env: { COUNTERS: DurableObjectNamespace }): Promise<Response> {
    const name = new URL(request.url).pathname.slice(1) || "default";
    return env.COUNTERS.get(env.COUNTERS.idFromName(name)).fetch(request);
  },
};
