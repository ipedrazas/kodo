// The page at the root of app.<domain>, where a login lands. It is a small
// client of the API until the shell UI arrives: who you are, your cells in a
// workspace, creating a cell from a Blueprint, sharing it, and granting it
// capabilities. ?workspace=<ws>&cell=<id> opens on one cell, so a gadget
// missing a grant can send its owner here.
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
  tr.details td { border-bottom: 1px solid var(--line); padding: .2rem .5rem .8rem; }
  tr.main td { border-bottom: 0; }
  tr.focus td { background: rgba(250, 204, 21, .15); }
  .grants { display: flex; flex-wrap: wrap; gap: .35rem; margin: .25rem 0 .5rem; }
  .grant { font: 13px ui-monospace, monospace; border: 1px solid var(--line); border-radius: 1rem; padding: .05rem .5rem; }
  .grant button { border: 0; background: none; padding: 0 0 0 .3rem; cursor: pointer; color: var(--muted); }
  .grant-form input { font: 13px ui-monospace, monospace; min-width: 22rem; }
  .label { font-size: .85rem; color: var(--muted); margin-right: .25rem; }
  .hint { font-size: .85rem; }
  [hidden] { display: none !important; }
</style>
</head>
<body>
<header>
  <h1>kodo</h1>
  <span><span id="who" class="muted"></span> · <a href="/gatekeeper/" id="approvals">Approvals and connections</a> · <a href="/logout">Log out</a></span>
</header>
<p id="error" role="alert"></p>

<h2>Workspace</h2>
<form id="workspace-form">
  <input id="workspace" name="workspace" required pattern="[a-z0-9]([a-z0-9-]*[a-z0-9])?" aria-label="Workspace">
  <button>Show cells</button>
</form>

<h2>Your cells</h2>
<table>
  <thead><tr><th>Cell</th><th>Blueprint</th><th>Owner</th><th>Shared with</th></tr></thead>
  <tbody id="cells"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
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
// Capabilities each Blueprint version declares, by "name version".
const declared = {};
const params = new URLSearchParams(location.search);
let focusCell = params.get("cell");

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

async function capabilities(blueprint, version) {
  const key = blueprint + " " + version;
  if (!declared[key]) {
    const { versions } = await call("GET", "/blueprints/" + blueprint);
    for (const v of versions) declared[blueprint + " " + v.version] = v.capabilities ?? [];
  }
  return declared[key] ?? [];
}

async function loadCells() {
  const ws = $("workspace").value;
  localStorage.setItem("kodo.workspace", ws);
  const rows = $("cells");
  try {
    const { cells } = await call("GET", "/workspaces/" + ws + "/cells");
    rows.replaceChildren();
    if (!cells.length) rows.append(el("tr")).append(el("td", "No cells yet.", { colSpan: 4, className: "muted" }));
    for (const cell of cells) {
      const owned = cell.owner.user === me.user;
      const tr = rows.appendChild(el("tr", undefined, { className: owned ? "main" : "", id: "cell-" + cell.id }));
      const link = el("a", cell.id, { href: "https://" + cell.id + "." + cellDomain + "/", target: "_blank" });
      tr.append(el("td")); tr.lastChild.append(link);
      tr.append(el("td", cell.blueprint + " " + cell.version));
      tr.append(el("td", owned ? "you" : cell.owner.email));
      tr.append(el("td", Object.entries(cell.shares).map(([e, r]) => e + " (" + r + ")").join(", ") || "—"));
      if (owned) rows.append(await details(ws, cell));
      if (cell.id === focusCell) {
        for (const r of [tr, tr.nextSibling]) r?.classList.add("focus");
        tr.scrollIntoView({ block: "center" });
        tr.nextSibling?.querySelector(".grant-form input")?.focus();
        focusCell = null;
      }
    }
    show();
  } catch (err) {
    rows.replaceChildren();
    show(err);
  }
}

// A concrete example of a declared capability with wildcards.
function example(capability) {
  if (capability.startsWith("inference:")) return capability.replace("*", "default");
  if (capability.startsWith("github:")) return capability.replace("*", "acme").replace("*", "api");
  return capability.split("*").join("name");
}

// What the owner can do with a cell: its grants, and sharing it.
async function details(ws, cell) {
  const tr = el("tr", undefined, { className: "details" });
  const td = tr.appendChild(el("td", undefined, { colSpan: 4 }));
  const base = "/workspaces/" + ws + "/cells/" + cell.id;
  const setGrants = async (grants) => {
    try { await call("PUT", base + "/grants", { grants }); show(); loadCells(); } catch (err) { show(err); }
  };

  const grants = td.appendChild(el("div", undefined, { className: "grants" }));
  grants.append(el("span", "Grants", { className: "label" }));
  if (!cell.grants.length) grants.append(el("span", "none", { className: "muted" }));
  for (const g of cell.grants) {
    const chip = grants.appendChild(el("span", g, { className: "grant" }));
    chip.append(el("button", "✕", { title: "Take back " + g, onclick: () => setGrants(cell.grants.filter((x) => x !== g)) }));
  }
  const offered = (await capabilities(cell.blueprint, cell.version)).filter((c) => !cell.grants.includes(c));
  if (offered.length) {
    // A declared capability with a * is a template: the owner names the
    // concrete resource, e.g. inference:model/default:invoke.
    const form = td.appendChild(el("form", undefined, { className: "grant-form" }));
    form.append(el("span", "Grant", { className: "label" }));
    const pick = form.appendChild(el("select", undefined, { ariaLabel: "Declared capability" }));
    for (const c of offered) pick.append(el("option", c));
    const input = form.appendChild(el("input", undefined, { required: true, value: offered[0], ariaLabel: "Capability to grant" }));
    form.append(el("button", "Grant"));
    const hint = form.appendChild(el("span", "", { className: "muted hint" }));
    const explain = () => {
      const open = input.value.includes("*");
      hint.textContent = open ? "replace each * with what to allow, e.g. " + example(input.value) : "";
      hint.className = "hint " + (open ? "muted" : "");
    };
    pick.onchange = () => { input.value = pick.value; explain(); input.focus(); };
    input.oninput = explain;
    explain();
    form.onsubmit = (ev) => {
      ev.preventDefault();
      if (input.value.includes("*")) { hint.className = "hint"; hint.style.color = "#b91c1c"; input.focus(); return; }
      setGrants([...cell.grants, input.value.trim()]);
    };
  }

  const share = td.appendChild(el("form"));
  share.append(el("span", "Share", { className: "label" }));
  const email = share.appendChild(el("input", undefined, { type: "email", placeholder: "email", required: true }));
  const role = share.appendChild(el("select"));
  role.append(el("option", "viewer"), el("option", "editor"), el("option", "revoke", { value: "" }));
  share.append(el("button", "Share"));
  share.onsubmit = async (ev) => {
    ev.preventDefault();
    try {
      const path = base + "/shares/" + encodeURIComponent(email.value);
      if (role.value) await call("PUT", path, { role: role.value });
      else await call("DELETE", path);
      show(); loadCells();
    } catch (err) { show(err); }
  };
  return tr;
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
