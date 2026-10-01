import { Gadget } from "kodo";

// HN Reader: a kodo gadget for reading Hacker News, with summaries of a
// thread by a model. It has no network of its own: the grant
// web:hn.algolia.com/api/v1:read lets it read the Algolia HN API through the
// Gatekeeper, and any inference:model/<name>:invoke grant lets it ask that
// model for a summary, counted against its owner's budget. Lists and threads
// are cached in the cell's own database, so a page loads with at most one
// call, and the cache is served if Hacker News cannot be reached. Read and
// saved stories are kept per person, so a cell can be shared by a team.
//
//   GET  /                         the page
//   GET  /api/stories?list=front   front, new, ask or show: 30 stories; &refresh=1 skips the cache
//   GET  /api/stories/:id          a story and its comments, as text; marks it read
//   POST /api/stories/:id/save     saves it, or unsaves a saved one
//   GET  /api/saved                my saved stories
//   POST /api/stories/:id/summary  {model?}: a summary of the thread by a granted model
const WEB = "web:hn.algolia.com/api/v1:read";
const MODEL = /^inference:model\/([^:]+):invoke$/;
const LISTS = {
  front: "/search?tags=front_page&hitsPerPage=30",
  new: "/search_by_date?tags=story&hitsPerPage=30",
  ask: "/search_by_date?tags=ask_hn&hitsPerPage=30",
  show: "/search_by_date?tags=show_hn&hitsPerPage=30",
};
const LIST_TTL = 5 * 60 * 1000;
const ITEM_TTL = 10 * 60 * 1000;
const SUMMARY_TTL = 60 * 60 * 1000;
const MAX_COMMENTS = 200;
const PROMPT_CHARS = 6000;

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(`
      CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, fetched_at INTEGER NOT NULL);
      CREATE TABLE IF NOT EXISTS reads (user TEXT NOT NULL, story TEXT NOT NULL, at INTEGER NOT NULL, PRIMARY KEY (user, story));
      CREATE TABLE IF NOT EXISTS saved (user TEXT NOT NULL, story TEXT NOT NULL, title TEXT NOT NULL, url TEXT,
        at INTEGER NOT NULL, PRIMARY KEY (user, story));
      CREATE TABLE IF NOT EXISTS summaries (story TEXT PRIMARY KEY, model TEXT NOT NULL, backend TEXT, text TEXT NOT NULL,
        at INTEGER NOT NULL);`);
  }

  get sql() {
    return this.ctx.storage.sql;
  }

  // The granted models by name.
  get models() {
    return Object.fromEntries(
      Object.entries(this.grants).flatMap(([c, grant]) => (MODEL.test(c) ? [[MODEL.exec(c)[1], grant]] : [])),
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    const user = request.headers.get("x-kodo-user") ?? "anonymous";
    if (request.method === "GET" && parts.length === 0) {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          // Links open Hacker News and the stories; nothing else is loaded.
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'; frame-ancestors 'none'",
        },
      });
    }
    if (parts[0] !== "api") return json({ error: "not found" }, 404);
    if (request.method === "GET" && parts[1] === "stories" && parts.length === 2) {
      return this.list(user, url.searchParams.get("list") ?? "front", url.searchParams.get("refresh") === "1");
    }
    if (request.method === "GET" && parts[1] === "saved" && parts.length === 2) {
      return json({ saved: this.sql.exec("SELECT story AS id, title, url, at FROM saved WHERE user = ? ORDER BY at DESC", user).toArray() });
    }
    const id = parts[2];
    if (parts[1] !== "stories" || !/^\d{1,12}$/.test(id ?? "")) return json({ error: "not found" }, 404);
    if (request.method === "GET" && parts.length === 3) return this.story(user, id);
    if (request.method === "POST" && parts[3] === "save" && parts.length === 4) return this.toggleSave(user, id);
    if (request.method === "POST" && parts[3] === "summary" && parts.length === 4) {
      const body = await request.json().catch(() => ({}));
      return this.summarise(id, body?.model);
    }
    return json({ error: "not found" }, 404);
  }

  // Reads a path of the HN API, from the cache while it is fresh. If Hacker
  // News cannot be reached, a stale copy is better than nothing.
  async read(path, ttl) {
    const [cached] = this.sql.exec("SELECT body, fetched_at FROM cache WHERE key = ?", path).toArray();
    if (cached && Date.now() - cached.fetched_at < ttl) return { data: JSON.parse(cached.body), fetchedAt: cached.fetched_at };
    const grant = this.grants[WEB];
    if (!grant) throw new Unavailable(403, `this cell has no grant for ${WEB}`);
    let res;
    try {
      res = await grant.fetch(path, { headers: { accept: "application/json" } });
    } catch (err) {
      res = { ok: false, status: 502, text: async () => String(err) };
    }
    if (!res.ok) {
      if (cached) return { data: JSON.parse(cached.body), fetchedAt: cached.fetched_at, stale: true };
      const detail = await res.text();
      throw new Unavailable(res.status === 403 ? 403 : 502, `Hacker News answered ${res.status}: ${detail.slice(0, 200)}`);
    }
    const text = await res.text();
    const now = Date.now();
    this.sql.exec("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", path, text, now);
    await this.schedulePrune();
    return { data: JSON.parse(text), fetchedAt: now };
  }

  async list(user, name, refresh) {
    if (!LISTS[name]) return json({ error: "list must be front, new, ask or show" }, 400);
    try {
      const { data, fetchedAt, stale } = await this.read(LISTS[name], refresh ? 0 : LIST_TTL);
      const read = new Set(this.sql.exec("SELECT story FROM reads WHERE user = ?", user).toArray().map((r) => r.story));
      const saved = new Set(this.sql.exec("SELECT story FROM saved WHERE user = ?", user).toArray().map((r) => r.story));
      const stories = (data.hits ?? []).map((h) => ({
        id: h.objectID,
        title: h.title ?? "(untitled)",
        url: safeUrl(h.url),
        domain: domain(h.url),
        points: h.points ?? 0,
        comments: h.num_comments ?? 0,
        author: h.author,
        at: (h.created_at_i ?? 0) * 1000,
        read: read.has(h.objectID),
        saved: saved.has(h.objectID),
      }));
      return json({ list: name, stories, fetchedAt, stale: Boolean(stale), models: Object.keys(this.models) });
    } catch (err) {
      return failure(err);
    }
  }

  async story(user, id) {
    try {
      const { data, fetchedAt, stale } = await this.read(`/items/${id}`, ITEM_TTL);
      this.sql.exec("INSERT OR IGNORE INTO reads VALUES (?, ?, ?)", user, id, Date.now());
      const comments = [];
      const walk = (node, depth) => {
        for (const c of node.children ?? []) {
          if (comments.length >= MAX_COMMENTS) return;
          if (c.text) comments.push({ id: String(c.id), author: c.author, at: (c.created_at_i ?? 0) * 1000, depth, text: toText(c.text) });
          walk(c, depth + 1);
        }
      };
      walk(data, 0);
      const [summary] = this.sql.exec("SELECT model, backend, text, at FROM summaries WHERE story = ?", id).toArray();
      return json({
        story: {
          id: String(data.id),
          title: data.title ?? "(untitled)",
          url: safeUrl(data.url),
          domain: domain(data.url),
          points: data.points ?? 0,
          author: data.author,
          at: (data.created_at_i ?? 0) * 1000,
          text: data.text ? toText(data.text) : null,
          saved: this.sql.exec("SELECT 1 FROM saved WHERE user = ? AND story = ?", user, id).toArray().length > 0,
        },
        comments,
        // How many there are in all; at most 200 are shown.
        total: countComments(data),
        summary: summary ?? null,
        models: Object.keys(this.models),
        fetchedAt,
        stale: Boolean(stale),
      });
    } catch (err) {
      return failure(err);
    }
  }

  async toggleSave(user, id) {
    if (this.sql.exec("SELECT 1 FROM saved WHERE user = ? AND story = ?", user, id).toArray().length) {
      this.sql.exec("DELETE FROM saved WHERE user = ? AND story = ?", user, id);
      return json({ saved: false });
    }
    try {
      const { data } = await this.read(`/items/${id}`, ITEM_TTL);
      this.sql.exec("INSERT INTO saved VALUES (?, ?, ?, ?, ?)", user, id, data.title ?? "(untitled)", safeUrl(data.url), Date.now());
      return json({ saved: true });
    } catch (err) {
      return failure(err);
    }
  }

  // Asks a granted model for a summary of the thread: the story and as many
  // comments as fit, top-level ones first. Kept for an hour.
  async summarise(id, requested) {
    const models = this.models;
    const model = requested ?? Object.keys(models)[0];
    if (!models[model]) {
      return json({ error: model ? `no grant for inference:model/${model}:invoke` : "no model is granted to this cell" }, 403);
    }
    const [cached] = this.sql.exec("SELECT model, backend, text, at FROM summaries WHERE story = ?", id).toArray();
    if (cached && cached.model === model && Date.now() - cached.at < SUMMARY_TTL) return json(cached);
    let data;
    try {
      ({ data } = await this.read(`/items/${id}`, ITEM_TTL));
    } catch (err) {
      return failure(err);
    }
    const top = (data.children ?? []).filter((c) => c.text);
    const replies = top.flatMap((c) => (c.children ?? []).filter((r) => r.text));
    let thread = "";
    for (const c of [...top, ...replies]) {
      const line = `- ${c.author}: ${toText(c.text).replace(/\s+/g, " ")}\n`;
      if (thread.length + line.length > PROMPT_CHARS) break;
      thread += line;
    }
    const res = await models[model].fetch("/chat/completions", {
      method: "POST",
      body: JSON.stringify({
        max_tokens: 400,
        messages: [
          {
            role: "system",
            content:
              "You summarise Hacker News discussions for a busy reader. In plain text, give one sentence on what the story is about, " +
              "then four to six short bullet points with the main arguments, agreements and disagreements in the comments.",
          },
          {
            role: "user",
            content: `Title: ${data.title}\nURL: ${data.url ?? "(none)"}\n${data.text ? `Text: ${toText(data.text)}\n` : ""}\nComments:\n${thread || "(none yet)"}`,
          },
        ],
      }),
    });
    const answer = await res.json().catch(() => ({}));
    if (!res.ok) {
      // 429: the owner or the workspace is over budget.
      return json({ error: answer.error?.message ?? answer.error ?? `the model answered ${res.status}` }, res.status);
    }
    const summary = { model, backend: answer.model ?? null, text: answer.choices?.[0]?.message?.content?.trim() ?? "", at: Date.now() };
    this.sql.exec("INSERT OR REPLACE INTO summaries VALUES (?, ?, ?, ?, ?)", id, summary.model, summary.backend, summary.text, summary.at);
    return json(summary);
  }

  // Drops cached pages and summaries older than a day, hourly while there
  // are any.
  async schedulePrune() {
    if (this.ctx.storage.kv.get("prune")) return;
    const at = Date.now() + 60 * 60 * 1000;
    await this.setAlarm(at);
    this.ctx.storage.kv.put("prune", at);
  }

  async onAlarm() {
    const old = Date.now() - 24 * 60 * 60 * 1000;
    this.sql.exec("DELETE FROM cache WHERE fetched_at < ?", old);
    this.sql.exec("DELETE FROM summaries WHERE at < ?", old);
    this.ctx.storage.kv.delete("prune");
    if (this.sql.exec("SELECT count(*) AS n FROM cache").one().n) await this.schedulePrune();
  }
}

class Unavailable extends Error {
  constructor(status, message) {
    super(message);
    this.status = status;
  }
}

function failure(err) {
  if (err instanceof Unavailable) return json({ error: err.message }, err.status);
  throw err;
}

function json(value, status = 200) {
  return Response.json(value, { status });
}

function safeUrl(u) {
  try {
    const url = new URL(u);
    return url.protocol === "https:" || url.protocol === "http:" ? url.href : null;
  } catch {
    return null;
  }
}

function domain(u) {
  try {
    return new URL(u).hostname.replace(/^www\./, "");
  } catch {
    return null;
  }
}

function countComments(node) {
  return (node.children ?? []).reduce((n, c) => n + (c.text ? 1 : 0) + countComments(c), 0);
}

// HN's comment HTML as plain text: paragraphs become blank lines, links
// their address, entities characters. The page shows it as text, never as
// HTML, so nothing in a comment runs on the cell's origin.
function toText(html) {
  return String(html)
    .replace(/<p>/gi, "\n\n")
    .replace(/<a\s[^>]*href="([^"]*)"[^>]*>.*?<\/a>/gi, "$1")
    .replace(/<[^>]+>/g, "")
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCodePoint(parseInt(h, 16)))
    .replace(/&#(\d+);/g, (_, d) => String.fromCodePoint(Number(d)))
    .replace(/&quot;/g, '"')
    .replace(/&apos;/g, "'")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&")
    .trim();
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>HN Reader</title>
<style>
  :root { color-scheme: light dark; --accent: #ff6600; --muted: #828282; --line: rgba(127,127,127,.25); --bad: #b91c1c; }
  body { font: 15px/1.45 Verdana, system-ui, sans-serif; max-width: 70rem; margin: 0 auto; padding: 0 1rem 2rem; }
  header { display: flex; gap: 1rem; align-items: center; background: var(--accent); color: #000; padding: .4rem .7rem; margin: 0 -1rem 1rem; }
  header strong { margin-right: .5rem; } header button { background: none; border: 0; font: inherit; cursor: pointer; color: #000; padding: 0; }
  header button[aria-pressed="true"] { color: #fff; font-weight: bold; }
  main { display: grid; grid-template-columns: minmax(0, 1fr) minmax(0, 1.2fr); gap: 1.5rem; }
  @media (max-width: 50rem) { main { grid-template-columns: 1fr; } }
  ol { margin: 0; padding-left: 2rem; } ol li { padding: .3rem 0; }
  .meta, .muted { color: var(--muted); font-size: .8rem; }
  a { color: inherit; } .read > a.title { color: var(--muted); }
  button.link { background: none; border: 0; padding: 0; color: var(--muted); cursor: pointer; font: inherit; font-size: .8rem; text-decoration: underline; }
  #story h2 { font-size: 1.15rem; margin: 0 0 .25rem; }
  .comment { border-left: 2px solid var(--line); padding: .2rem 0 .5rem .6rem; margin: .3rem 0; white-space: pre-wrap; overflow-wrap: anywhere; }
  #summary { white-space: pre-wrap; background: rgba(255,102,0,.08); border-radius: .4rem; padding: .6rem .8rem; margin: .75rem 0; }
  #error { color: var(--bad); min-height: 1.2em; }
  .primary { background: var(--accent); color: #000; border: 0; padding: .3rem .7rem; border-radius: .3rem; cursor: pointer; font: inherit; }
</style>
</head>
<body>
<header>
  <strong>HN Reader</strong>
  <button data-list="front">top</button><button data-list="new">new</button><button data-list="ask">ask</button><button data-list="show">show</button><button data-list="saved">saved</button>
  <span id="fetched" class="muted" style="margin-left:auto;color:#000"></span>
</header>
<p id="error" role="alert"></p>
<main>
  <ol id="stories"></ol>
  <section id="story" aria-live="polite"><p class="muted">Pick a story to read its comments.</p></section>
</main>
<script>
const $ = (id) => document.getElementById(id);
const show = (e) => { $("error").textContent = e ? String(e.message ?? e) : ""; };
const el = (tag, props = {}, ...kids) => { const n = Object.assign(document.createElement(tag), props); n.append(...kids); return n; };
const ago = (ms) => { const m = Math.round((Date.now() - ms) / 60000); return m < 60 ? m + " min ago" : m < 1440 ? Math.round(m / 60) + " h ago" : Math.round(m / 1440) + " d ago"; };
let current = "", models = [];

async function call(method, path, body) {
  const res = await fetch(path, { method, headers: body ? { "content-type": "application/json" } : {}, body: body ? JSON.stringify(body) : undefined });
  const data = await res.json();
  if (!res.ok) throw new Error(data.error);
  return data;
}

function link(story) {
  return el("a", { className: "title", href: story.url ?? "https://news.ycombinator.com/item?id=" + story.id, target: "_blank", rel: "noopener noreferrer", textContent: story.title });
}

async function load(list) {
  // The list on show again: fetch it afresh.
  const refresh = list === current && $("stories").children.length ? "&refresh=1" : "";
  current = list;
  document.querySelectorAll("header button").forEach((b) => b.setAttribute("aria-pressed", String(b.dataset.list === list)));
  try {
    if (list === "saved") {
      const { saved } = await call("GET", "/api/saved");
      $("stories").replaceChildren(...saved.map((s) => el("li", {}, link(s), " ", el("button", { className: "link", textContent: "comments", onclick: () => open(s.id) }))));
      $("fetched").textContent = saved.length + " saved";
    } else {
      const data = await call("GET", "/api/stories?list=" + list + refresh);
      models = data.models;
      $("stories").replaceChildren(...data.stories.map((s) => el("li", { id: "s" + s.id, className: s.read ? "read" : "" }, link(s), s.domain ? el("span", { className: "meta", textContent: " (" + s.domain + ")" }) : "",
        el("div", { className: "meta" }, s.points + " points by " + s.author + " " + ago(s.at) + " | ",
          el("button", { className: "link", textContent: s.comments + " comments", onclick: () => open(s.id) }), " | ",
          el("button", { className: "link", textContent: s.saved ? "unsave" : "save", onclick: async (e) => { const r = await call("POST", "/api/stories/" + s.id + "/save"); e.target.textContent = r.saved ? "unsave" : "save"; } })))));
      $("fetched").textContent = (data.stale ? "offline copy from " : "updated ") + ago(data.fetchedAt);
    }
    show();
  } catch (e) { show(e); }
}

async function open(id) {
  $("story").replaceChildren(el("p", { className: "muted", textContent: "Loading…" }));
  try {
    const { story, comments, total, summary, models: granted } = await call("GET", "/api/stories/" + id);
    const summaryBox = el("div", { id: "summary", hidden: !summary, textContent: summary ? summary.text : "" });
    const summarise = el("button", { className: "primary", textContent: summary ? "Summarise again" : "Summarise the thread", hidden: !granted.length,
      onclick: async () => {
        summarise.disabled = true; summaryBox.hidden = false; summaryBox.textContent = "Asking " + granted[0] + "…";
        try { const s = await call("POST", "/api/stories/" + id + "/summary", {}); summaryBox.textContent = s.text + "\\n\\n— " + s.model + (s.backend ? " (" + s.backend + ")" : ""); }
        catch (e) { summaryBox.textContent = e.message; } finally { summarise.disabled = false; }
      } });
    $("story").replaceChildren(
      el("h2", {}, link(story)),
      el("div", { className: "meta", textContent: story.points + " points by " + story.author + " " + ago(story.at) + " · " + total + " comments" + (total > comments.length ? ", the first " + comments.length + " shown" : "") }),
      story.text ? el("p", { className: "comment", textContent: story.text }) : "",
      summarise, summaryBox,
      ...comments.map((c) => el("div", { className: "comment", style: "margin-left:" + Math.min(c.depth, 6) * 1.1 + "rem" },
        el("div", { className: "meta", textContent: c.author + " " + ago(c.at) }), c.text)));
    document.getElementById("s" + id)?.classList.add("read");
  } catch (e) { $("story").replaceChildren(el("p", { id: "error", textContent: e.message })); }
}

document.querySelectorAll("header button").forEach((b) => (b.onclick = () => load(b.dataset.list)));
load("front");
</script>
</body>
</html>
`;
