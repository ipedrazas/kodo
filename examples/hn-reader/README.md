# HN Reader

A kodo gadget for reading Hacker News: the front page, new, Ask HN and Show HN, threads with their comments, stories saved for later, and a summary of a thread by a model. It shows two capabilities together: reading a public API with no credentials, and calling a model.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App`, with its page |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `hn-reader` version `1.0.0`, declaring `web:hn.algolia.com/api/v1:read` and `inference:model/*:invoke` |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

- Stories come from the [Algolia HN API](https://hn.algolia.com/api) through the grant `web:hn.algolia.com/api/v1:read`: one call for a list of 30, one for a story with its whole comment tree. The Gatekeeper makes the call; the gadget has no network.
- Pages are cached in the cell's database, lists for five minutes and threads for ten, so most page loads make no call at all. Clicking the list you are on fetches it afresh. If Hacker News cannot be reached, the last copy is served and marked as such.
- Comments arrive as HTML. The gadget turns them into plain text (paragraphs, link addresses) and the page shows them as text, so nothing from a comment can run on the cell's origin.
- With a model granted, e.g. `inference:model/default:invoke`, "Summarise the thread" sends the story and as many comments as fit in 6,000 characters to the model. The summary is kept for an hour, and the tokens count against the owner's and the workspace's budgets.
- What each person has read and saved is kept per person, so a shared cell works for a team.
- An hourly alarm drops cached pages and summaries older than a day.

```
browser ─► <cell>.g.<domain> ─► kernel ─► hn-reader ── cache, reads, saved, summaries (SQLite)
                                  │ grants["web:hn.algolia.com/api/v1:read"].fetch("/search?tags=front_page")
                                  │ grants["inference:model/default:invoke"].fetch("/chat/completions")
                                  ▼
                              Gatekeeper ─► https://hn.algolia.com/api/v1/...   (public addresses only)
                                         └► inference gateway ─► the model
```

## Deploy it

You need a fleet with a Gatekeeper that allows reading `hn.algolia.com` (`GATEKEEPER_WEB_ALLOW`; hiddenfield.dev's does) and, for summaries, the inference gateway. On hiddenfield.dev, with the cookie jar from `test/e2e/lib.sh`'s `login`:

```sh
kubectl -n kodo apply -k examples/hn-reader
kubectl -n kodo wait blueprint/hn-reader-1.0.0 --for=condition=Published

curl -b jar -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"blueprint":"hn-reader"}' https://app.hiddenfield.dev/api/workspaces/team/cells
curl -b jar -X PUT -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"grants":["web:hn.algolia.com/api/v1:read","inference:model/default:invoke"]}' \
  https://app.hiddenfield.dev/api/workspaces/team/cells/<cell>/grants
```

Open `https://<cell>.g.hiddenfield.dev/`. Without the model grant the reader works and offers no summaries.

## API

| Method | Path | |
| --- | --- | --- |
| GET | `/api/stories?list=front` | `front`, `new`, `ask` or `show`: `{stories, fetchedAt, stale, models}`; `&refresh=1` skips the cache |
| GET | `/api/stories/:id` | `{story, comments: [{author, depth, text}], total, summary}`; marks the story read |
| POST | `/api/stories/:id/save` | Saves the story, or unsaves it: `{saved}` |
| GET | `/api/saved` | Your saved stories |
| POST | `/api/stories/:id/summary` | `{model?}`: a summary by a granted model, `{model, backend, text, at}` |
