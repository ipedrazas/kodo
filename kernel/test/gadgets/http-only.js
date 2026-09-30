import { DurableObject } from "cloudflare:workers";

// Test gadget with no WebSocket handlers.
export class App extends DurableObject {
  fetch() {
    return new Response("http only\n");
  }
}
