// The page at the root of app.<domain>, where a login lands: your cells in
// a workspace, and creating one from a Blueprint. A cell's grants, shares
// and version are managed on the settings page; ?workspace=<ws>&cell=<id>,
// which gadgets missing a grant link to, forwards there.
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
  .label { font-size: .85rem; color: var(--muted); margin-right: .25rem; }
  .hint { font-size: .85rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>kodo</h1>
  <span><span id="who" class="muted"></span> · <a href="/chat/" id="chat">Chat with the agent</a> · <a href="/settings/">Settings</a> · <a href="/gatekeeper/" id="approvals">Approvals and connections</a> · <a href="/logout">Log out</a></span>
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
{
  // Links to a cell's grants, from before they moved to settings.
  const p = new URLSearchParams(location.search);
  if (p.get("cell")) location.replace("/settings/?" + new URLSearchParams({ workspace: p.get("workspace") || "team", cell: p.get("cell") }) + "#cells");
}
const cellDomain = location.hostname.replace(/^app\\./, "g.");
let me;
const params = new URLSearchParams(location.search);

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
      const owned = cell.owner.user === me.user;
      const tr = rows.appendChild(el("tr", undefined, { id: "cell-" + cell.id }));
      const link = el("a", cell.id, { href: "https://" + cell.id + "." + cellDomain + "/", target: "_blank" });
      tr.append(el("td")); tr.lastChild.append(link);
      tr.append(el("td", cell.blueprint + " " + cell.version));
      tr.append(el("td", owned ? "you" : cell.owner.email));
      tr.append(el("td", Object.entries(cell.shares).map(([e, r]) => e + " (" + r + ")").join(", ") || "—"));
      tr.append(el("td"));
      if (owned) {
        const grants = cell.grants.length ? cell.grants.length + (cell.grants.length === 1 ? " grant" : " grants") : "no grants";
        tr.lastChild.append(el("a", "Manage", { href: "/settings/?" + new URLSearchParams({ workspace: ws, cell: cell.id }) + "#cells" }), el("span", " · " + grants, { className: "muted hint" }));
      }
    }
    show();
  } catch (err) {
    rows.replaceChildren();
    show(err);
  }
}

// Calls waiting for the user's approval, from the Gatekeeper, if this
// deployment has one.
async function loadApprovals() {
  try {
    const res = await fetch("/gatekeeper/api/approvals?state=pending");
    if (!res.ok) return;
    const n = (await res.json()).approvals.length;
    $("approvals").textContent = n ? n + " waiting for approval" : "Approvals and connections";
    $("approvals").style.fontWeight = n ? "600" : "";
  } catch {
    // No Gatekeeper.
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
    $("workspace").value = params.get("workspace") || localStorage.getItem("kodo.workspace") || "team";
    loadCells();
    loadApprovals();
  } catch (err) { show(err); }
})();
</script>
</body>
</html>
`;
