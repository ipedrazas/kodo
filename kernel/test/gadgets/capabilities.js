import { Gadget } from "kodo";

// Test gadget for capability bindings.
//   /grants                  the capabilities it has a binding for
//   /use?cap=C&path=P        GET P on the binding for C
//   /raw?cap=C&method=M&path=P
//                            calls the host directly for C, binding or not
//   /forge?cell=X&cap=C      calls the host with made-up props for cell X
//   /burst?cap=C&n=N         N concurrent calls on the binding for C
//   /send?cap=C              POSTs the request body on the binding for C
//   /approval?id=I           this.approval(I)
//   /settled                 every approval onApproval has been called with
//   /alarm?in=MS             sets the gadget's alarm; /alarmed counts its runs
const view = async (a) => ({
  id: a.id,
  state: a.state,
  capability: a.capability,
  reason: a.reason,
  decided: a.decidedAt instanceof Date,
  status: a.response?.status ?? null,
  body: a.response ? await a.response.text() : null,
});

export class App extends Gadget {
  async onApproval(approval) {
    const settled = this.ctx.storage.kv.get("settled") ?? [];
    this.ctx.storage.kv.put("settled", [...settled, await view(approval)]);
  }

  async onAlarm() {
    this.ctx.storage.kv.put("alarmed", (this.ctx.storage.kv.get("alarmed") ?? 0) + 1);
  }

  async fetch(request) {
    const url = new URL(request.url);
    const cap = url.searchParams.get("cap");
    const path = url.searchParams.get("path") ?? "";
    if (url.pathname === "/grants") return Response.json(Object.keys(this.grants));
    if (url.pathname === "/use") {
      const grant = this.grants[cap];
      if (!grant) return Response.json({ binding: false });
      const res = await grant.fetch(path, { headers: { accept: "application/json" } });
      return Response.json({ binding: true, status: res.status, body: await res.text() });
    }
    if (url.pathname === "/send") {
      const res = await this.grants[cap].fetch(path, { method: "POST", body: await request.text() });
      return Response.json({
        status: res.status,
        decision: res.headers.get("x-kodo-decision"),
        approval: res.headers.get("x-kodo-approval"),
        body: await res.json(),
      });
    }
    if (url.pathname === "/approval") return Response.json(await view(await this.approval(url.searchParams.get("id"))));
    if (url.pathname === "/settled") return Response.json(this.ctx.storage.kv.get("settled") ?? []);
    if (url.pathname === "/alarm") {
      await this.setAlarm(Date.now() + Number(url.searchParams.get("in")));
      return Response.json({ ok: true });
    }
    if (url.pathname === "/alarmed") return Response.json(this.ctx.storage.kv.get("alarmed") ?? 0);
    if (url.pathname === "/burst") {
      const n = Number(url.searchParams.get("n") ?? 3);
      const statuses = await Promise.all(Array.from({ length: n }, () => this.grants[cap].fetch(path).then((r) => r.status)));
      return Response.json(statuses);
    }
    if (url.pathname === "/raw") {
      const res = await this.env.KODO.call(this.ctx.props, cap, {
        method: url.searchParams.get("method") ?? "GET",
        path,
      });
      return Response.json({ status: res.status, body: new TextDecoder().decode(res.body) });
    }
    if (url.pathname === "/forge") {
      const props = { cell: url.searchParams.get("cell"), token: btoa("not a real token"), grants: [cap] };
      try {
        await this.env.KODO.call(props, cap, { method: "GET", path: "" });
        return Response.json({ forged: "accepted" });
      } catch (err) {
        return Response.json({ forged: "rejected", error: err.message });
      }
    }
    return new Response("capabilities fixture\n");
  }
}
