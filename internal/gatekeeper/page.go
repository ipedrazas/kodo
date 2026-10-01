package gatekeeper

// connectionsPage is served at app.<domain>/gatekeeper/: the user's
// connections to external services, and a form to add a token. Tokens go
// straight to the Gatekeeper, never through a fleet.
const connectionsPage = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>kodo connections</title>
<style>
  :root { color-scheme: light dark; --muted: #6b7280; --line: #d1d5db; }
  body { font: 15px/1.5 system-ui, sans-serif; max-width: 52rem; margin: 2rem auto; padding: 0 1rem; }
  header { display: flex; justify-content: space-between; align-items: baseline; }
  h1 { font-size: 1.4rem; margin: 0; }
  h2 { font-size: 1.05rem; margin: 2rem 0 .5rem; }
  .muted { color: var(--muted); }
  table { width: 100%; border-collapse: collapse; }
  th, td { text-align: left; padding: .4rem .5rem; border-bottom: 1px solid var(--line); }
  input, select, button { font: inherit; padding: .25rem .5rem; }
  form { display: flex; gap: .5rem; flex-wrap: wrap; align-items: center; }
  input[type=password] { flex: 1; min-width: 16rem; }
  #error { color: #b91c1c; min-height: 1.5em; }
</style>
</head>
<body>
<header>
  <h1>Connections</h1>
  <span><span id="who" class="muted"></span> · <a href="/">Cells</a></span>
</header>
<p class="muted">Gadgets never see these tokens. A gadget can use a connection only through a capability you grant to one of your cells, and every call is recorded.</p>
<p id="error" role="alert"></p>

<table>
  <thead><tr><th>Service</th><th>Account</th><th>Connected</th><th></th></tr></thead>
  <tbody id="connections"><tr><td colspan="4" class="muted">Loading…</td></tr></tbody>
</table>

<h2>Connect</h2>
<form id="connect">
  <select id="provider" aria-label="Service"></select>
  <input id="token" type="password" required autocomplete="off" placeholder="Token" aria-label="Token">
  <button>Connect</button>
</form>
<p class="muted">For GitHub, use a fine-grained personal access token with read-only access to the repositories your gadgets need.</p>

<script>
const $ = (id) => document.getElementById(id);
const api = async (method, path, body) => {
  const res = await fetch("/gatekeeper/api" + path, {
    method,
    headers: body ? { "content-type": "application/json" } : {},
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = res.status === 204 ? null : await res.json();
  if (!res.ok) throw new Error(data?.error ?? res.status);
  return data;
};
const show = (err) => { $("error").textContent = err ? String(err.message ?? err) : ""; };
const cell = (text) => { const td = document.createElement("td"); td.textContent = text; return td; };

async function load() {
  try {
    const data = await api("GET", "/connections");
    $("who").textContent = data.user.email || data.user.user;
    $("provider").replaceChildren(...data.providers.sort().map((p) => new Option(p, p)));
    const rows = data.connections.map((c) => {
      const tr = document.createElement("tr");
      const button = document.createElement("button");
      button.textContent = "Disconnect";
      button.onclick = async () => {
        try { await api("DELETE", "/connections/" + c.provider); show(); load(); } catch (e) { show(e); }
      };
      const td = document.createElement("td");
      td.append(button);
      tr.append(cell(c.provider), cell(c.account), cell(new Date(c.connectedAt).toLocaleString()), td);
      return tr;
    });
    if (!rows.length) {
      const tr = document.createElement("tr");
      const td = cell("No connections yet.");
      td.colSpan = 4;
      td.className = "muted";
      tr.append(td);
      rows.push(tr);
    }
    $("connections").replaceChildren(...rows);
  } catch (e) { show(e); }
}

$("connect").onsubmit = async (event) => {
  event.preventDefault();
  try {
    await api("PUT", "/connections/" + $("provider").value, { token: $("token").value });
    $("token").value = "";
    show();
    load();
  } catch (e) { show(e); }
};
load();
</script>
</body>
</html>
`
