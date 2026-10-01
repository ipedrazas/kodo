import { Gadget } from "kodo";

// Daybreak: a kodo gadget for finding time with friends. A cell is a circle:
// its owner shares it, as editor, with each friend, and whoever opens it is a
// member from then on. Members add the times they are free, see each other's
// free time and the windows they share, and propose meetings in them;
// accepting one takes that time out of both people's free time. There are no
// accounts, passwords or friend requests: the gateway logs people in, the
// kernel says who they are in x-kodo-user and x-kodo-email, and the cell's
// shares say who belongs. Viewers can look but not change anything; the
// kernel refuses their writes. A daily alarm clears out what is past.
//
//   GET    /                          the page
//   GET    /api/state                 me, members and their free time, shared windows, my meetings
//   POST   /api/slots                 {start, end}: I am free then (epoch ms)
//   DELETE /api/slots/:id             not free after all
//   POST   /api/meetings              {with, start, end, title}: propose a meeting to a member
//   POST   /api/meetings/:id/accept   the recipient accepts; the time is reserved for both
//   POST   /api/meetings/:id/decline  the recipient declines
//   POST   /api/meetings/:id/cancel   the requester withdraws, or either cancels an accepted one
const QUARTER = 15 * 60 * 1000;
const DAY = 24 * 60 * 60 * 1000;
const MAX_SLOT = 12 * 60 * 60 * 1000;
const HORIZON = 60 * DAY;

class Refused extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS members (user TEXT PRIMARY KEY, email TEXT NOT NULL, joined_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS slots (id TEXT PRIMARY KEY, user TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS meetings (id TEXT PRIMARY KEY, requester TEXT NOT NULL, recipient TEXT NOT NULL,
        title TEXT NOT NULL, start_at INTEGER NOT NULL, end_at INTEGER NOT NULL, status TEXT NOT NULL,
        created_at INTEGER NOT NULL, decided_at INTEGER);`);
  }

  get sql() {
    return this.ctx.storage.sql;
  }

  async fetch(request) {
    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/") {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      });
    }
    const parts = url.pathname.split("/").filter(Boolean);
    if (parts[0] !== "api") return json({ error: "not found" }, 404);
    const me = this.join(request);
    try {
      if (request.method === "GET" && parts[1] === "state" && parts.length === 2) {
      // Where the owner shares the cell: the kodo home page, open on it.
      return json({ ...this.state(me), cell: this.cellId, workspace: request.headers.get("x-kodo-workspace") });
    }
      if (!me) throw new Refused(403, "only people the cell is shared with can change it");
      if (parts[1] === "slots" && parts.length === 2 && request.method === "POST") {
        const { start, end } = await body(request);
        this.addFree(me.user, window(start, end));
      } else if (parts[1] === "slots" && parts.length === 3 && request.method === "DELETE") {
        this.sql.exec("DELETE FROM slots WHERE id = ? AND user = ?", parts[2], me.user);
      } else if (parts[1] === "meetings" && parts.length === 2 && request.method === "POST") {
        await this.propose(me, await body(request));
      } else if (parts[1] === "meetings" && parts.length === 4 && request.method === "POST") {
        this.decide(me, parts[2], parts[3]);
      } else {
        throw new Refused(404, "not found");
      }
      await this.scheduleCleanup();
      return json(this.state(me));
    } catch (err) {
      if (err instanceof Refused) return json({ error: err.message }, err.status);
      throw err;
    }
  }

  // Records the caller as a member, the first time and whenever their email
  // changes. The admin token has no email and does not join.
  join(request) {
    const user = request.headers.get("x-kodo-user");
    const email = request.headers.get("x-kodo-email");
    const role = request.headers.get("x-kodo-role");
    if (!user || !email) return null;
    this.sql.exec(
      `INSERT INTO members (user, email, joined_at) VALUES (?, ?, ?)
       ON CONFLICT (user) DO UPDATE SET email = excluded.email WHERE email != excluded.email`,
      user, email, Date.now(),
    );
    return { user, email, role };
  }

  state(me) {
    const now = Date.now();
    const members = this.sql.exec("SELECT user, email FROM members ORDER BY email").toArray();
    const free = (user) =>
      this.sql
        .exec("SELECT id, start_at, end_at FROM slots WHERE user = ? AND end_at > ? ORDER BY start_at", user, now)
        .toArray()
        .map((s) => ({ id: s.id, start: s.start_at, end: s.end_at }));
    const emailOf = Object.fromEntries(members.map((m) => [m.user, m.email]));
    const mine = me ? free(me.user) : [];
    return {
      me: me ? { email: me.email, role: me.role } : null,
      members: members.map((m) => ({ email: m.email, me: m.user === me?.user, free: free(m.user) })),
      // Where my free time meets each other member's.
      windows: me
        ? members
            .filter((m) => m.user !== me.user)
            .flatMap((m) => overlaps(mine, free(m.user)).map((w) => ({ with: m.email, ...w })))
            .sort((a, b) => a.start - b.start)
        : [],
      meetings: me
        ? this.sql
            .exec(
              `SELECT * FROM meetings WHERE (requester = ? OR recipient = ?) AND end_at > ? AND status IN ('pending', 'accepted')
               ORDER BY start_at`,
              me.user, me.user, now,
            )
            .toArray()
            .map((m) => ({
              id: m.id,
              title: m.title,
              start: m.start_at,
              end: m.end_at,
              status: m.status,
              direction: m.requester === me.user ? "outgoing" : "incoming",
              with: emailOf[m.requester === me.user ? m.recipient : m.requester],
            }))
        : [],
    };
  }

  // Adds free time, merged with any it overlaps or touches.
  addFree(user, { start, end }) {
    const touching = this.sql
      .exec("SELECT id, start_at, end_at FROM slots WHERE user = ? AND start_at <= ? AND end_at >= ?", user, end, start)
      .toArray();
    for (const s of touching) {
      start = Math.min(start, s.start_at);
      end = Math.max(end, s.end_at);
      this.sql.exec("DELETE FROM slots WHERE id = ?", s.id);
    }
    this.sql.exec("INSERT INTO slots VALUES (?, ?, ?, ?)", crypto.randomUUID(), user, start, end);
  }

  // Whether a user is free for the whole of a window.
  isFree(user, { start, end }) {
    return Boolean(
      this.sql.exec("SELECT 1 FROM slots WHERE user = ? AND start_at <= ? AND end_at >= ? LIMIT 1", user, start, end).toArray()
        .length,
    );
  }

  // Takes a window out of a user's free time, splitting the slot it is in.
  reserve(user, { start, end }) {
    const [s] = this.sql
      .exec("SELECT id, start_at, end_at FROM slots WHERE user = ? AND start_at <= ? AND end_at >= ?", user, start, end)
      .toArray();
    this.sql.exec("DELETE FROM slots WHERE id = ?", s.id);
    if (s.start_at < start) this.sql.exec("INSERT INTO slots VALUES (?, ?, ?, ?)", crypto.randomUUID(), user, s.start_at, start);
    if (end < s.end_at) this.sql.exec("INSERT INTO slots VALUES (?, ?, ?, ?)", crypto.randomUUID(), user, end, s.end_at);
  }

  async propose(me, { with: email, start, end, title }) {
    const w = window(start, end);
    const [other] = this.sql.exec("SELECT user FROM members WHERE email = ?", String(email ?? "").toLowerCase()).toArray();
    if (!other) throw new Refused(404, `${email} has not joined this circle yet`);
    if (other.user === me.user) throw new Refused(400, "propose meetings to someone else");
    title = String(title ?? "").trim().slice(0, 100) || "Catch up";
    if (!this.isFree(me.user, w)) throw new Refused(409, "you are not free for all of that time");
    if (!this.isFree(other.user, w)) throw new Refused(409, `${email} is not free for all of that time`);
    const dup = this.sql.exec(
      "SELECT 1 FROM meetings WHERE requester = ? AND recipient = ? AND start_at = ? AND end_at = ? AND status = 'pending'",
      me.user, other.user, w.start, w.end,
    );
    if (dup.toArray().length) throw new Refused(409, "you have already proposed that");
    this.sql.exec(
      "INSERT INTO meetings (id, requester, recipient, title, start_at, end_at, status, created_at) VALUES (?, ?, ?, ?, ?, ?, 'pending', ?)",
      crypto.randomUUID(), me.user, other.user, title, w.start, w.end, Date.now(),
    );
  }

  decide(me, id, action) {
    const [m] = this.sql.exec("SELECT * FROM meetings WHERE id = ?", id).toArray();
    if (!m || (m.requester !== me.user && m.recipient !== me.user)) throw new Refused(404, "no such meeting");
    const w = { start: m.start_at, end: m.end_at };
    const set = (status) => this.sql.exec("UPDATE meetings SET status = ?, decided_at = ? WHERE id = ?", status, Date.now(), id);
    if (action === "accept" || action === "decline") {
      if (m.recipient !== me.user) throw new Refused(403, "only the person invited can answer");
      if (m.status !== "pending") throw new Refused(409, `the meeting is already ${m.status}`);
      if (action === "decline") return set("declined");
      if (w.end <= Date.now()) throw new Refused(409, "that time has passed");
      // Either of them may have given the time to something else since.
      for (const user of [m.requester, m.recipient]) {
        if (!this.isFree(user, w)) throw new Refused(409, "one of you is no longer free then");
      }
      this.reserve(m.requester, w);
      this.reserve(m.recipient, w);
      return set("accepted");
    }
    if (action === "cancel") {
      if (m.status === "pending" && m.requester === me.user) return set("cancelled");
      if (m.status === "accepted") {
        // The time is free again for both.
        this.addFree(m.requester, w);
        this.addFree(m.recipient, w);
        return set("cancelled");
      }
      throw new Refused(409, "only the person who proposed it can withdraw a pending meeting");
    }
    throw new Refused(404, "not found");
  }

  // A daily clean-up while there is anything to clean.
  async scheduleCleanup() {
    if (this.ctx.storage.kv.get("cleanup")) return;
    const at = Date.now() + DAY;
    await this.setAlarm(at);
    this.ctx.storage.kv.put("cleanup", at);
  }

  async onAlarm() {
    const now = Date.now();
    this.sql.exec("DELETE FROM slots WHERE end_at <= ?", now);
    this.sql.exec("DELETE FROM meetings WHERE end_at <= ?", now - 30 * DAY);
    this.sql.exec("DELETE FROM meetings WHERE status IN ('declined', 'cancelled') AND end_at <= ?", now);
    this.ctx.storage.kv.delete("cleanup");
    const left = this.sql.exec("SELECT (SELECT count(*) FROM slots) + (SELECT count(*) FROM meetings) AS n").one().n;
    if (left) await this.scheduleCleanup();
  }
}

// Checks a window: whole quarter hours, in the future, at most 12 hours and
// at most 60 days ahead.
function window(start, end) {
  start = Number(start);
  end = Number(end);
  if (!Number.isInteger(start) || !Number.isInteger(end) || start % QUARTER || end % QUARTER) {
    throw new Refused(400, "start and end must be epoch milliseconds on a quarter hour");
  }
  if (end <= start) throw new Refused(400, "end must be after start");
  if (end - start > MAX_SLOT) throw new Refused(400, "at most 12 hours at a time");
  const now = Date.now();
  if (end <= now) throw new Refused(400, "that time has passed");
  if (start > now + HORIZON) throw new Refused(400, "at most 60 days ahead");
  return { start, end };
}

// The windows of at least a quarter hour in both lists of sorted slots.
function overlaps(a, b) {
  const out = [];
  for (const x of a) {
    for (const y of b) {
      const start = Math.max(x.start, y.start, Math.ceil(Date.now() / QUARTER) * QUARTER);
      const end = Math.min(x.end, y.end);
      if (end - start >= QUARTER) out.push({ start, end });
    }
  }
  return out;
}

async function body(request) {
  try {
    const b = await request.json();
    if (b && typeof b === "object") return b;
  } catch {
    // Fall through.
  }
  throw new Refused(400, "body must be a JSON object");
}

function json(value, status = 200) {
  return Response.json(value, { status });
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Daybreak</title>
<style>
  :root { color-scheme: light dark; --accent: #d97706; --muted: #6b7280; --line: #e5e7eb; --bad: #b91c1c; --ok: #15803d; --card: rgba(127,127,127,.06); }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 60rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.6rem; margin: 0; } h1 span { color: var(--accent); }
  h2 { font-size: 1.05rem; margin: 0 0 .5rem; }
  .muted { color: var(--muted); font-size: .9rem; }
  .grid { display: grid; grid-template-columns: repeat(auto-fit, minmax(17rem, 1fr)); gap: 1rem; margin-top: 1.25rem; }
  section { background: var(--card); border: 1px solid var(--line); border-radius: .6rem; padding: 1rem; min-width: 0; }
  ul { list-style: none; margin: 0; padding: 0; } li { padding: .35rem 0; border-bottom: 1px solid var(--line); display: flex; gap: .5rem; align-items: center; justify-content: space-between; }
  li:last-child { border-bottom: 0; }
  #free { display: flex; flex-wrap: wrap; gap: .4rem; margin-bottom: .5rem; }
  #free input[type="date"] { flex: 1 1 100%; }
  #free input[type="time"] { flex: 1 1 5.5rem; min-width: 0; }
  input, button, select { font: inherit; padding: .3rem .45rem; box-sizing: border-box; max-width: 100%; }
  button { cursor: pointer; } button.link { background: none; border: 0; color: var(--accent); padding: 0; }
  .pending { color: var(--accent); } .accepted { color: var(--ok); }
  #error { color: var(--bad); min-height: 1.4em; }
  dialog form { display: grid; gap: .4rem; min-width: 18rem; }
</style>
</head>
<body>
<h1><span>Day</span>break</h1>
<p class="muted" id="who">Make time for your people.</p>
<p id="error" role="alert"></p>
<div class="grid">
  <section>
    <h2>When I'm free</h2>
    <form id="free">
      <input id="day" type="date" required aria-label="Day">
      <input id="from" type="time" step="900" required value="18:00" aria-label="From">
      <input id="to" type="time" step="900" required value="21:00" aria-label="To">
      <button>Add</button>
    </form>
    <ul id="mine"></ul>
  </section>
  <section>
    <h2>Free together</h2>
    <ul id="windows"></ul>
  </section>
  <section>
    <h2>Meetings</h2>
    <ul id="meetings"></ul>
  </section>
  <section>
    <h2>The circle</h2>
    <ul id="members"></ul>
    <p class="muted" id="invite">The cell's owner adds friends by sharing it with them as editors.</p>
  </section>
</div>
<dialog id="propose">
  <form method="dialog" id="proposal">
    <strong id="proposeWith"></strong>
    <input id="title" maxlength="100" placeholder="What for? (Catch up)" aria-label="Title">
    <input id="pStart" type="datetime-local" step="900" required aria-label="Start">
    <input id="pEnd" type="datetime-local" step="900" required aria-label="End">
    <div><button value="send">Propose</button> <button value="cancel" formnovalidate>Cancel</button></div>
  </form>
</dialog>
<script>
const $ = (id) => document.getElementById(id);
const show = (e) => { $("error").textContent = e ? String(e.message ?? e) : ""; };
const day = new Intl.DateTimeFormat(undefined, { weekday: "short", month: "short", day: "numeric" });
const hm = new Intl.DateTimeFormat(undefined, { hour: "2-digit", minute: "2-digit" });
const span = (s, e) => day.format(s) + " " + hm.format(s) + "–" + hm.format(e);
const local = (ms) => { const d = new Date(ms - new Date(ms).getTimezoneOffset() * 60000); return d.toISOString().slice(0, 16); };
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
let state, proposing;

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function render(s) {
  state = s;
  const editor = s.me && s.me.role !== "viewer";
  $("who").textContent = s.me ? "You are " + s.me.email + (editor ? "" : " (viewer: you can look, not change)") + "." : "Make time for your people.";
  $("free").hidden = !editor;
  const me = s.members.find((m) => m.me);
  $("mine").replaceChildren(...(me?.free ?? []).map((f) => el("li", {}, el("span", { textContent: span(f.start, f.end) }),
    editor ? el("button", { className: "link", textContent: "remove", onclick: () => act("DELETE", "/api/slots/" + f.id) }) : "")));
  if (!me?.free.length) $("mine").append(el("li", { className: "muted", textContent: "Add the evenings and weekends you could meet." }));
  $("windows").replaceChildren(...s.windows.map((w) => el("li", {}, el("span", { textContent: span(w.start, w.end) + " · " + w.with }),
    editor ? el("button", { className: "link", textContent: "propose", onclick: () => propose(w) }) : "")));
  if (!s.windows.length) $("windows").append(el("li", { className: "muted", textContent: "No shared free time yet." }));
  $("meetings").replaceChildren(...s.meetings.map((m) => {
    const actions = [];
    if (m.status === "pending" && m.direction === "incoming") actions.push(["accept", "accept"], ["decline", "decline"]);
    else if (m.status === "pending") actions.push(["withdraw", "cancel"]);
    else actions.push(["cancel", "cancel"]);
    return el("li", {}, el("span", {}, el("strong", { textContent: m.title }), " with " + m.with + ", " + span(m.start, m.end) + " ",
      el("span", { className: m.status, textContent: m.status === "pending" ? (m.direction === "incoming" ? "asks you" : "waiting") : "on" })),
      el("span", {}, ...actions.map(([label, a]) => el("button", { className: "link", textContent: label + " ", onclick: () => act("POST", "/api/meetings/" + m.id + "/" + a) }))));
  }));
  if (!s.meetings.length) $("meetings").append(el("li", { className: "muted", textContent: "Nothing planned." }));
  if (s.me?.role === "owner" && s.cell) {
    const app = location.hostname.replace(/^[^.]+\\.g\\./, "app.");
    $("invite").replaceChildren("Invite friends by sharing this circle with them as editors on ",
      el("a", { textContent: "the kodo home page", href: "https://" + app + "/?workspace=" + encodeURIComponent(s.workspace ?? "") + "&cell=" + encodeURIComponent(s.cell) }), ".");
  }
  $("members").replaceChildren(...s.members.map((m) => el("li", {}, el("span", { textContent: m.email + (m.me ? " (you)" : "") }),
    el("span", { className: "muted", textContent: m.free.length + " free " + (m.free.length === 1 ? "slot" : "slots") }))));
}

async function act(method, path, body) {
  try { render(await call(method, path, body)); show(); } catch (e) { show(e); }
}

function propose(w) {
  proposing = w;
  $("proposeWith").textContent = "With " + w.with;
  $("pStart").value = local(w.start);
  $("pEnd").value = local(Math.min(w.end, w.start + 2 * 3600000));
  $("propose").showModal();
}
$("propose").onclose = () => {
  if ($("propose").returnValue !== "send" || !proposing) return;
  act("POST", "/api/meetings", { with: proposing.with, title: $("title").value, start: new Date($("pStart").value).getTime(), end: new Date($("pEnd").value).getTime() });
  $("title").value = "";
};
$("free").onsubmit = (e) => {
  e.preventDefault();
  const at = (t) => new Date($("day").value + "T" + t).getTime();
  act("POST", "/api/slots", { start: at($("from").value), end: at($("to").value) });
};
$("day").valueAsDate = new Date();
call("GET", "/api/state").then(render, show);
setInterval(() => document.hidden || call("GET", "/api/state").then(render, () => {}), 15000);
</script>
</body>
</html>
`;
