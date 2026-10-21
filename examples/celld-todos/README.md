# celld to-dos

A plain celld app: a Worker that routes `/lists/<name>/` to one `Todos` Durable Object per name, each with its items in its own SQLite database, a JSON API and a page. Nothing in it knows about kodo. [docs/celld-apps.md](../../docs/celld-apps.md) walks through running it on Kubernetes without kodo and with it.

| File | What |
| --- | --- |
| [`wrangler.jsonc`](wrangler.jsonc) | The Worker `todos`, binding `LISTS` to class `Todos` |
| [`src/index.js`](src/index.js) | The router: `/lists/<name>/...` to the object for `<name>`, without the prefix |
| [`src/todos.js`](src/todos.js) | Class `Todos`: `GET /`, `GET`/`POST /api/items`, `PATCH`/`DELETE /api/items/:id` |

## Run it with celld

```sh
celld dev examples/celld-todos        # needs esbuild on PATH
open http://127.0.0.1:9876/lists/groceries/
```

## Run it on kodo

```sh
go build -o bin/kodo ./cmd/kodo
bin/kodo publish examples/celld-todos --class Todos --name todos --version 0.1.0
```

Unlike the other examples, there is no `blueprint.yaml` here: this is a celld app, not a gadget, and `kodo publish` generates the gadget and its Blueprint from `wrangler.jsonc`. To see what it generates without applying it, add `--dry-run --out <dir>`.

Then create a cell from `todos` at `https://app.<domain>/` and open `https://<cell>.g.<domain>/`. Each item records who added it, from the `x-kodo-email` header the kernel sets.
