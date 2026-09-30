import { DurableObject } from "cloudflare:workers";

// Sample gadget for WebSocket behaviour: a hibernatable WebSocket that echoes
// each message with a counter kept in SQLite, so a reply shows whether the
// gadget kept its state across hibernation or a move to another node.
export class App extends DurableObject {
  async fetch(request) {
    if (request.headers.get("Upgrade") !== "websocket") {
      return new Response("expected a WebSocket upgrade\n", { status: 426 });
    }
    const [server, client] = Object.values(new WebSocketPair());
    this.ctx.acceptWebSocket(server);
    return new Response(null, { status: 101, webSocket: client });
  }

  webSocketMessage(ws, message) {
    const n = (this.ctx.storage.kv.get("n") ?? 0) + 1;
    this.ctx.storage.kv.put("n", n);
    ws.send(JSON.stringify({ n, echo: String(message) }));
  }
}
