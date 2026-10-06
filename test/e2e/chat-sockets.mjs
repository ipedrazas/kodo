// The socket half of test/e2e/chat.sh: alice and bob in one chat cell
// through the gateway (wss via Envoy, logged in with their cookie jars). A
// line from one reaches the other within a second, both ways, and a socket
// that only pings, as the page does, still works after QUIET_S seconds.
// Bob's first socket never pings: the gateway drops a quiet stream after
// 5 minutes without telling the client, so it is only reported on.
//
//   node test/e2e/chat-sockets.mjs <cell> <alice jar> <bob jar>
// GATEWAY and DOMAIN as in lib.sh; QUIET_S (default 600) and PING_S
// (default 30).
import { readFileSync } from "node:fs";
import WebSocket from "../../kernel/node_modules/ws/wrapper.mjs";

const [cell, aliceJar, bobJar] = process.argv.slice(2);
const GATEWAY = process.env.GATEWAY ?? "192.168.2.224";
const DOMAIN = process.env.DOMAIN ?? "hiddenfield.dev";
const QUIET_S = Number(process.env.QUIET_S ?? 600);
const PING_S = Number(process.env.PING_S ?? 30);
const host = `${cell}.g.${DOMAIN}`;

const fail = (message) => {
  console.error(`FAIL: ${message}`);
  process.exit(1);
};

// The cookies of a curl jar that curl would send to the cell's host.
function cookies(jar) {
  return readFileSync(jar, "utf8")
    .split("\n")
    .map((l) => l.replace(/^#HttpOnly_/, ""))
    .filter((l) => l && !l.startsWith("#"))
    .map((l) => l.split("\t"))
    .filter(([domain, sub]) => {
      const d = domain.replace(/^\./, "");
      return host === d || (sub === "TRUE" && host.endsWith("." + d));
    })
    .map((f) => `${f[5]}=${f[6]}`)
    .join("; ");
}

// Opens the room as the owner of a jar; resolves once the hello arrives.
function join(name, jar) {
  return new Promise((resolve, reject) => {
    const ws = new WebSocket(`wss://${host}/`, {
      headers: { cookie: cookies(jar), origin: `https://${host}` },
      lookup: (_host, options, cb) => (options?.all ? cb(null, [{ address: GATEWAY, family: 4 }]) : cb(null, GATEWAY, 4)),
    });
    const waiters = [];
    const messages = [];
    const socket = {
      name,
      ws,
      closed: null,
      // The next message of a type ("pong" for a pong), leaving the others.
      next: (type, ms = 5000) =>
        new Promise((res, rej) => {
          let timer;
          const take = () => {
            const i = messages.findIndex((m) => m.type === type);
            if (i < 0) return false;
            clearTimeout(timer);
            res(messages.splice(i, 1)[0]);
            return true;
          };
          if (take()) return;
          waiters.push(take);
          timer = setTimeout(() => {
            waiters.splice(waiters.indexOf(take) >>> 0, 1);
            rej(new Error(`${name}: no ${type} in ${ms} ms`));
          }, ms);
        }),
    };
    ws.on("unexpected-response", (_, res) => reject(new Error(`${name}: upgrade refused: ${res.statusCode}`)));
    ws.on("error", reject);
    ws.on("close", (code, reason) => (socket.closed = { code, reason: String(reason) }));
    ws.on("message", (data) => {
      const text = String(data);
      messages.push(text === "pong" ? { type: "pong" } : JSON.parse(text));
      for (const w of waiters.splice(0)) if (!w()) waiters.push(w);
    });
    ws.on("open", () => socket.next("hello").then((hello) => resolve({ ...socket, hello }), reject));
  });
}

async function say(from, to, text) {
  const started = Date.now();
  from.ws.send(JSON.stringify({ text }));
  const { line } = await to.next("line");
  const ms = Date.now() - started;
  if (line.text !== text) fail(`${to.name} heard ${JSON.stringify(line)} instead of ${text}`);
  await from.next("line");
  if (ms > 1000) fail(`${from.name}'s line took ${ms} ms to reach ${to.name}`);
  console.log(`${from.name} -> ${to.name}: ${ms} ms`);
}

const alice = await join("alice", aliceJar);
const bob = await join("bob", bobJar);
console.log(`both in room ${cell}: ${bob.hello.online.join(", ")}`);
if (!bob.hello.online.some((e) => e.startsWith("alice@"))) fail(`bob does not see alice: ${JSON.stringify(bob.hello)}`);
await alice.next("online");
for (let i = 0; i < 3; i++) {
  await say(alice, bob, `hello bob ${i}`);
  await say(bob, alice, `hello alice ${i}`);
}

console.log(`quiet for ${QUIET_S} s, alice pinging every ${PING_S} s`);
const pinger = setInterval(() => alice.ws.readyState === WebSocket.OPEN && alice.ws.send("ping"), PING_S * 1000);
const quietUntil = Date.now() + QUIET_S * 1000;
while (Date.now() < quietUntil) {
  await new Promise((r) => setTimeout(r, Math.min(30_000, quietUntil - Date.now())));
  if (alice.closed) fail(`alice's socket closed after ${Math.round((QUIET_S * 1000 - (quietUntil - Date.now())) / 1000)} s: ${JSON.stringify(alice.closed)}`);
}
clearInterval(pinger);
await alice.next("pong", 1).catch(() => fail("alice's pings were never answered"));
console.log(`alice's socket is open after ${QUIET_S} s`);
// Whether bob's socket, which never pinged, still delivers both ways.
const silent = await Promise.allSettled([
  (bob.ws.send(JSON.stringify({ text: "bob after the quiet" })), bob.next("line")),
  alice.next("line"),
]);
const works = silent.every((r) => r.status === "fulfilled");
console.log(`bob's socket, which never pinged: ${bob.closed ? `closed ${JSON.stringify(bob.closed)}` : works ? "still works" : "open, but delivers nothing"}`);
bob.ws.close();
// Alice's, which pinged, must still work: with a new socket for bob, both ways.
const again = await join("bob", bobJar);
await alice.next("online");
await say(alice, again, "alice after the quiet");
await say(again, alice, "bob back after the quiet");
again.ws.close();
alice.ws.close();
console.log("chat through the gateway: ok");
