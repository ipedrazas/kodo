// The page at the root of app.<domain>, where a login lands. It is a small
// client of the API until the shell UI arrives: who you are, your cells in a
// workspace, creating a cell from a Blueprint, and sharing it.
export const HOME_PAGE = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kodo</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 1.4rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); vertical-align: top; }
  input, select, button { font: inherit; padding: .25rem .5rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  #error { color: #b91c1c; min-height: 1.5em; }
</style>
</head>
<body>
<header>
  <h1>kodo</h1>
  <span><span id="who" class="muted"></span> · <a href="/logout">Log out</a></span>
</header>
<p id="error" role="alert"></p>

<h2>Workspace</h2>
<form id="workspace-form">
  <input id="workspace" name="workspace" required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" aria-label="Workspace">
  <button>Show cells</button>
</form>

<h2>Your cells</h2>
<table>
  <thead><tr><th>Cell</th><th>Blueprint</th><th>Owner</th><th>Shared with</th><th></th></tr></thead>
  <tbody id="cells"><tr><td colspan="5" class="muted">Loading…</td></tr></tbody>
</table>

<h2>New cell</h2>
<form id="create-form">
  <select id="blueprint" aria-label="Blueprint" required></select>
  <button>Create</button>
</form>

<script>
const $ = (id) => document.getElementById(id);
const cellDomain = location.hostname.replace(/^app\\./, "g.");
let me;

async function call(method, path, body) {
  const res = await fetch("/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.headers.get("content-type")?.includes("json") ? await res.json() : await res.text();
  if (!res.ok) throw new Error(data.error ?? data);
  return data;
}

function show(err) { $("error").textContent = err ? String(err.message ?? err) : ""; }

function el(tag, text, attrs = {}) {
  const e = document.createElement(tag);
  if (text !== undefined) e.textContent = text;
  Object.assign(e, attrs);
  return e;
}

async function loadCells() {
  const ws = $("workspace").value;
  localStorage.setItem("kodo.workspace", ws);
  const rows = $("cells");
  try {
    const { cells } = await call("GET", "/workspaces/" + ws + "/cells");
    rows.replaceChildren();
    if (!cells.length) rows.append(el("tr")).append(el("td", "No cells yet.", { colSpan: 5, className: "muted" }));
    for (const cell of cells) {
      const tr = rows.appendChild(el("tr"));
      const link = el("a", cell.id, { href: "https://" + cell.id + "." + cellDomain + "/", target: "_blank" });
      tr.append(el("td")); tr.lastChild.append(link);
      tr.append(el("td", cell.blueprint + " " + cell.version));
      tr.append(el("td", cell.owner.user === me.user ? "you" : cell.owner.email));
      tr.append(el("td", Object.entries(cell.shares).map(([e, r]) => e + " (" + r + ")").join(", ") || "—"));
      const actions = tr.appendChild(el("td"));
      if (cell.owner.user === me.user) {
        const form = actions.appendChild(el("form"));
        const email = form.appendChild(el("input", undefined, { type: "email", placeholder: "email", required: true }));
        const role = form.appendChild(el("select"));
        role.append(el("option", "viewer"), el("option", "editor"), el("option", "revoke", { value: "" }));
        form.append(el("button", "Share"));
        form.onsubmit = async (ev) => {
          ev.preventDefault();
          try {
            const path = "/workspaces/" + ws + "/cells/" + cell.id + "/shares/" + encodeURIComponent(email.value);
            if (role.value) await call("PUT", path, { role: role.value });
            else await call("DELETE", path);
            show(); loadCells();
          } catch (err) { show(err); }
        };
      }
    }
    show();
  } catch (err) {
    rows.replaceChildren();
    show(err);
  }
}

$("workspace-form").onsubmit = (ev) => { ev.preventDefault(); loadCells(); };
$("create-form").onsubmit = async (ev) => {
  ev.preventDefault();
  try {
    await call("POST", "/workspaces/" + $("workspace").value + "/cells", { blueprint: $("blueprint").value });
    loadCells();
  } catch (err) { show(err); }
};

(async () => {
  try {
    me = await call("GET", "/whoami");
    $("who").textContent = me.email || me.user;
    const { blueprints } = await call("GET", "/blueprints");
    for (const name of blueprints) $("blueprint").append(el("option", name));
    $("workspace").value = localStorage.getItem("kodo.workspace") || "team";
    loadCells();
  } catch (err) { show(err); }
})();
</script>
</body>
</html>
`;
