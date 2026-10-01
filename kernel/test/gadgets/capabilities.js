import { Gadget } from "kodo";

// Test gadget for capability bindings.
//   /grants                  the capabilities it has a binding for
//   /use?cap=C&path=P        GET P on the binding for C
//   /raw?cap=C&method=M&path=P
//                            calls the host directly for C, binding or not
//   /forge?cell=X&cap=C      calls the host with made-up props for cell X
//   /burst?cap=C&n=N         N concurrent calls on the binding for C
export class App extends Gadget {
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
