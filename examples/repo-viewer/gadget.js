import { Gadget } from "kodo";

// Repo viewer: a kodo gadget that shows the README, latest commits and basic
// facts of the GitHub repositories its owner has granted it. It never sees a
// GitHub token: each grant, e.g. github:repo/acme/api:read, arrives as a
// binding in this.grants, and the Gatekeeper makes the call with the owner's
// token. Answers are cached in the cell's own SQLite database for a minute.
//
//   GET /                          the page
//   GET /api/repos                 the repositories this cell may read
//   GET /api/repos/:owner/:repo    one repository: facts, README, commits
//   POST /api/refresh              forget the cache
const GRANT = /^github:repo\/([^/]+)\/([^/]+):read$/;
const CACHE_MS = 60_000;

export class App extends Gadget {
  constructor(ctx, env) {
    super(ctx, env);
    ctx.storage.sql.exec(
      "CREATE TABLE IF NOT EXISTS cache (key TEXT PRIMARY KEY, body TEXT NOT NULL, at INTEGER NOT NULL)",
    );
  }

  async fetch(request) {
    const url = new URL(request.url);
    const parts = url.pathname.split("/").filter(Boolean);
    if (request.method === "GET" && parts.length === 0) {
      return new Response(PAGE, {
        headers: {
          "content-type": "text/html; charset=utf-8",
          "content-security-policy": "default-src 'self'; script-src 'unsafe-inline'; style-src 'unsafe-inline'",
        },
      });
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "repos" && parts.length === 2) {
      return Response.json({ repos: this.repos(), viewer: request.headers.get("x-kodo-email") });
    }
    if (request.method === "GET" && parts[0] === "api" && parts[1] === "repos" && parts.length === 4) {
      return this.repo(parts[2], parts[3]);
    }
    if (request.method === "POST" && url.pathname === "/api/refresh") {
      this.ctx.storage.sql.exec("DELETE FROM cache");
      return new Response(null, { status: 204 });
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  // The repositories this cell holds a read grant for.
  repos() {
    return Object.keys(this.grants)
      .map((capability) => capability.match(GRANT))
      .filter(Boolean)
      .map(([capability, owner, repo]) => ({ owner, repo, capability }));
  }

  async repo(owner, repo) {
    const grant = this.grants[`github:repo/${owner}/${repo}:read`];
    if (!grant) {
      return Response.json({ error: `this cell has no grant to read ${owner}/${repo}` }, { status: 403 });
    }
    const key = `${owner}/${repo}`;
    const cached = this.ctx.storage.sql.exec("SELECT body, at FROM cache WHERE key = ?", key).toArray()[0];
    if (cached && Date.now() - cached.at < CACHE_MS) {
      return new Response(cached.body, { headers: { "content-type": "application/json", "x-cache": "hit" } });
    }

    const [facts, readme, commits] = await Promise.all([
      grant.fetch(""),
      grant.fetch("/readme", { headers: { accept: "application/vnd.github.raw+json" } }),
      grant.fetch("/commits?per_page=5"),
    ]);
    if (!facts.ok) {
      // The Gatekeeper's denials and GitHub's errors both arrive as JSON.
      const error = await facts.json().catch(() => ({}));
      return Response.json(
        { error: error.error ?? error.message ?? `GitHub answered ${facts.status}`, decision: facts.headers.get("x-kodo-decision") },
        { status: facts.status },
      );
    }
    const repoInfo = await facts.json();
    const body = JSON.stringify({
      name: repoInfo.full_name,
      description: repoInfo.description,
      private: repoInfo.private,
      stars: repoInfo.stargazers_count,
      openIssues: repoInfo.open_issues_count,
      defaultBranch: repoInfo.default_branch,
      readme: readme.ok ? await readme.text() : null,
      commits: commits.ok
        ? (await commits.json()).map((c) => ({
            sha: c.sha.slice(0, 7),
            message: c.commit.message.split("\n")[0],
            author: c.commit.author?.name,
            date: c.commit.author?.date,
          }))
        : [],
      fetchedAt: new Date().toISOString(),
    });
    this.ctx.storage.sql.exec("INSERT OR REPLACE INTO cache VALUES (?, ?, ?)", key, body, Date.now());
    return new Response(body, { headers: { "content-type": "application/json", "x-cache": "miss" } });
  }
}

const PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>Repo viewer</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 56rem; margin: 2rem auto; padding: 0 1rem; }
  h1 { font-size: 1.4rem; margin: 0 0 .25rem; }
  h2 { font-size: 1.05rem; margin: 1.5rem 0 .5rem; }
  .muted { color: var(--muted); }
  nav { display: flex; gap: .5rem; flex-wrap: wrap; margin: 1rem 0; }
  nav button[aria-pressed=true] { font-weight: 600; }
  pre { white-space: pre-wrap; border: 1px solid var(--line); padding: 1rem; border-radius: 6px; max-height: 28rem; overflow: auto; }
  ul { padding-left: 1.2rem; }
  code { font-size: .9em; }
  #error { color: #b91c1c; min-height: 1.5em; }
</style>
</head>
<body>
<h1>Repo viewer</h1>
<p class="muted">Reads only the repositories this cell's owner granted it, through the kodo Gatekeeper.</p>
<nav id="repos"></nav>
<p id="error" role="alert"></p>
<section id="repo" hidden>
  <h2 id="name"></h2>
  <p id="facts" class="muted"></p>
  <h2>Latest commits</h2>
  <ul id="commits"></ul>
  <h2>README</h2>
  <pre id="readme"></pre>
</section>
<script>
const $ = (id) => document.getElementById(id);
const show = (e) => { $("error").textContent = e ? String(e.message ?? e) : ""; };

async function open(owner, repo) {
  for (const b of $("repos").children) b.setAttribute("aria-pressed", b.dataset.repo === owner + "/" + repo);
  show();
  try {
    const res = await fetch("/api/repos/" + owner + "/" + repo);
    const r = await res.json();
    if (!res.ok) throw new Error(r.error);
    $("name").textContent = r.name;
    $("facts").textContent = [r.description, (r.private ? "private" : "public"), r.stars + " stars",
      r.openIssues + " open issues", "default branch " + r.defaultBranch].filter(Boolean).join(" · ");
    $("commits").replaceChildren(...r.commits.map((c) => {
      const li = document.createElement("li");
      const code = document.createElement("code");
      code.textContent = c.sha;
      li.append(code, " " + c.message + " — " + (c.author ?? "") + ", " + new Date(c.date).toLocaleDateString());
      return li;
    }));
    $("readme").textContent = r.readme ?? "No README.";
    $("repo").hidden = false;
  } catch (e) { show(e); $("repo").hidden = true; }
}

(async () => {
  const { repos } = await (await fetch("/api/repos")).json();
  if (!repos.length) {
    show("This cell has no repositories yet. Its owner grants them with PUT /api/workspaces/<ws>/cells/<cell>/grants.");
    return;
  }
  $("repos").replaceChildren(...repos.map(({ owner, repo }) => {
    const b = document.createElement("button");
    b.textContent = owner + "/" + repo;
    b.dataset.repo = owner + "/" + repo;
    b.onclick = () => open(owner, repo);
    return b;
  }));
  open(repos[0].owner, repos[0].repo);
})();
</script>
</body>
</html>
`;
