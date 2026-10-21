// One to-do list: its items in the object's own SQLite database, a JSON API
// and a page. It records who added an item from x-kodo-email when a kodo
// kernel in front of it sets that header, and "someone" otherwise.
export class Todos {
  constructor(state, _env) {
    this.sql = state.storage.sql;
    this.sql.exec(`CREATE TABLE IF NOT EXISTS items (
      id INTEGER PRIMARY KEY AUTOINCREMENT,
      text TEXT NOT NULL,
      done INTEGER NOT NULL DEFAULT 0,
      by TEXT NOT NULL,
      at INTEGER NOT NULL
    )`);
  }

  async fetch(request) {
    const { pathname } = new URL(request.url);
    const item = pathname.match(/^\/api\/items\/(\d+)$/);
    if (pathname === "/" && request.method === "GET") {
      return new Response(PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/api/items" && request.method === "GET") {
      return Response.json(this.items());
    }
    if (pathname === "/api/items" && request.method === "POST") {
      const { text } = await request.json().catch(() => ({}));
      if (typeof text !== "string" || !text.trim() || text.length > 500) {
        return Response.json({ error: "text: 1 to 500 characters" }, { status: 400 });
      }
      const by = request.headers.get("x-kodo-email") ?? "someone";
      this.sql.exec("INSERT INTO items (text, by, at) VALUES (?, ?, ?)", text.trim(), by, Date.now());
      return Response.json(this.items(), { status: 201 });
    }
    if (item && request.method === "PATCH") {
      this.sql.exec("UPDATE items SET done = 1 - done WHERE id = ?", Number(item[1]));
      return Response.json(this.items());
    }
    if (item && request.method === "DELETE") {
      this.sql.exec("DELETE FROM items WHERE id = ?", Number(item[1]));
      return Response.json(this.items());
    }
    return Response.json({ error: "not found" }, { status: 404 });
  }

  items() {
    return this.sql
      .exec("SELECT id, text, done, by, at FROM items ORDER BY id")
      .toArray()
      .map((row) => ({ ...row, done: row.done === 1 }));
  }
}

// The page calls the API by relative URLs, so it works at /lists/<name>/
// under celld and at the root of a kodo cell's hostname.
const PAGE = `<!doctype html>
<html lang="en">
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>To-do</title>
<style>
  :root { color-scheme: light dark; font-family: system-ui, sans-serif; }
  body { max-width: 32rem; margin: 2rem auto; padding: 0 1rem; }
  form { display: flex; gap: .5rem; }
  input[type=text] { flex: 1; padding: .4rem; }
  ul { list-style: none; padding: 0; }
  li { display: flex; align-items: center; gap: .5rem; padding: .3rem 0; }
  li.done span { text-decoration: line-through; opacity: .6; }
  small { opacity: .6; margin-left: auto; }
</style>
<h1>To-do</h1>
<form id="add"><input type="text" name="text" placeholder="Add an item" autocomplete="off" required><button>Add</button></form>
<ul id="items"></ul>
<script>
  const list = document.getElementById("items");
  function render(items) {
    list.replaceChildren(...items.map((item) => {
      const li = document.createElement("li");
      li.className = item.done ? "done" : "";
      const box = Object.assign(document.createElement("input"), { type: "checkbox", checked: item.done });
      box.onchange = () => call("PATCH", "api/items/" + item.id);
      const text = Object.assign(document.createElement("span"), { textContent: item.text });
      const by = Object.assign(document.createElement("small"), { textContent: item.by });
      const del = Object.assign(document.createElement("button"), { textContent: "×", title: "Delete" });
      del.onclick = () => call("DELETE", "api/items/" + item.id);
      li.append(box, text, by, del);
      return li;
    }));
  }
  async function call(method, path, body) {
    const res = await fetch(path, {
      method,
      headers: body ? { "content-type": "application/json" } : {},
      body: body && JSON.stringify(body),
    });
    if (res.ok) render(await res.json());
  }
  document.getElementById("add").onsubmit = async (event) => {
    event.preventDefault();
    const input = event.target.text;
    await call("POST", "api/items", { text: input.value });
    input.value = "";
  };
  call("GET", "api/items");
</script>
</html>
`;
