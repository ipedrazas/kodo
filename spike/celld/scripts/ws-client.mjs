// Runs inside a Node pod. Opens a WebSocket to a gadget cell, sends a message
// at 0 s and 60 s (after idle eviction could have run), then keeps the socket
// open; if the server closes it, reconnects and sends again. Prints one JSON
// line per event with seconds since start.
// usage: node ws-client.mjs URL SECONDS
const [url, seconds] = process.argv.slice(2);
const t0 = Date.now();
const log = (event, data = {}) =>
  console.log(JSON.stringify({ t: ((Date.now() - t0) / 1000).toFixed(1), event, ...data }));

function open(target, first) {
  const opened = Date.now();
  const ws = new WebSocket(target);
  ws.onopen = () => {
    log("open", { ms: Date.now() - opened });
    ws.send(first);
  };
  ws.onmessage = (m) => log("message", JSON.parse(m.data));
  ws.onerror = (e) => log("error", { message: e.message ?? String(e) });
  ws.onclose = (e) => {
    log("close", { code: e.code, reason: e.reason });
    if (Date.now() - t0 < seconds * 1000) setTimeout(() => open(url.split("?")[0], "after-reconnect"), 1000);
  };
  return ws;
}

const ws = open(url, "first");
setTimeout(() => ws.readyState === WebSocket.OPEN && ws.send("after-60s-idle"), 60_000);
setTimeout(() => process.exit(0), seconds * 1000);
