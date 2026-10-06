import { Gadget } from "kodo";

// Test gadget for sending on the cell's sockets. Each socket gets
// {opened, user, email, role} from onOpen first, unless POST /fail-open has
// made onOpen throw.
//
// Socket messages are JSON commands, answered with {sent} or {error}:
//   {to: [ids], text}        sends {from, text} on the sockets
//   {broadcast: text}        sends {from, text} on every socket but this one
//   {self: text}             sends {self: text} on this socket, then answers
//
// HTTP:
//   GET  /sockets                     this.sockets()
//   POST /push?to=ID[&to=ID]          sends the body on the sockets
//   POST /broadcast[?except=ID]       sends the body on every socket
//   POST /close?socket=ID&code=C&reason=R
//   POST /big                         sends a message over 1 MiB
//   POST /many                        names 1001 sockets in one send
//   POST /alarm?in=MS                 onAlarm broadcasts {alarm: true}
//   POST /fail-open                   onOpen throws from now on
//   GET  /closed                      the sockets onClose was called for, and
//                                     whether sockets() still listed them
//   GET  /forge?cell=X                calls the host for cell X with made-up props
const answer = (promise) =>
  promise.then(
    (sent) => ({ sent }),
    (err) => ({ error: err.message }),
  );

export class App extends Gadget {
  async onOpen(socket, caller) {
    if (this.ctx.storage.kv.get("fail-open")) throw new Error("onOpen refused");
    await this.send(socket, JSON.stringify({ opened: socket, user: caller.user, email: caller.email, role: caller.role }));
  }

  async onMessage(socket, message) {
    const command = JSON.parse(String(message));
    if (command.to) return JSON.stringify(await answer(this.send(command.to, JSON.stringify({ from: socket, text: command.text }))));
    if (command.broadcast !== undefined) {
      return JSON.stringify(await answer(this.broadcast(JSON.stringify({ from: socket, text: command.broadcast }), { except: socket })));
    }
    if (command.self !== undefined) {
      await this.send(socket, JSON.stringify({ self: command.self }));
      return JSON.stringify({ answered: command.self });
    }
    return JSON.stringify({ error: "unknown command" });
  }

  async onClose(socket, code, reason) {
    const listed = (await this.sockets()).some((s) => s.socket === socket);
    const closed = this.ctx.storage.kv.get("closed") ?? [];
    this.ctx.storage.kv.put("closed", [...closed, { socket, code, reason, listed }]);
  }

  async onAlarm() {
    await this.broadcast(JSON.stringify({ alarm: true }));
  }

  async fetch(request) {
    const url = new URL(request.url);
    const q = url.searchParams;
    switch (url.pathname) {
      case "/sockets":
        return Response.json(
          (await this.sockets()).map((s) => ({ ...s, openedAt: s.openedAt instanceof Date ? s.openedAt.getTime() : s.openedAt })),
        );
      case "/push":
        return Response.json(await answer(this.send(q.getAll("to"), await request.text())));
      case "/broadcast":
        return Response.json(await answer(this.broadcast(await request.text(), { except: q.getAll("except") })));
      case "/close":
        return Response.json(await answer(this.closeSocket(q.get("socket"), Number(q.get("code") ?? 1000), q.get("reason") ?? "")));
      case "/big":
        return Response.json(await answer(this.broadcast("x".repeat(1024 * 1024 + 1))));
      case "/many":
        return Response.json(await answer(this.send(Array.from({ length: 1001 }, (_, i) => `s${i}`), "hi")));
      case "/alarm":
        await this.setAlarm(Date.now() + Number(q.get("in")));
        return Response.json({ ok: true });
      case "/fail-open":
        this.ctx.storage.kv.put("fail-open", true);
        return Response.json({ ok: true });
      case "/closed":
        return Response.json(this.ctx.storage.kv.get("closed") ?? []);
      case "/forge": {
        const props = { cell: q.get("cell"), token: btoa("not a real token") };
        const tries = {
          sockets: () => this.env.KODO.sockets(props),
          send: () => this.env.KODO.send(props, null, "forged", []),
          close: () => this.env.KODO.closeSocket(props, "any", 1000, ""),
        };
        const out = {};
        for (const [name, fn] of Object.entries(tries)) {
          try {
            await fn();
            out[name] = "accepted";
          } catch {
            out[name] = "rejected";
          }
        }
        return Response.json(out);
      }
    }
    return new Response("not found", { status: 404 });
  }
}
