# Daybreak — make time for your people

A kodo gadget for finding time with friends: members add the times they are free, see each other's free time and the windows they share, and propose meetings in them. Accepting a meeting takes that time out of both people's free time; cancelling it gives it back.

It is a port of [Applet.one's Daybreak](https://github.com/applet-one/examples/tree/main/daybreak), and most of that app is not needed here. Daybreak on Applet.one has accounts, password hashing, sessions, login rate limits, friend requests and an operator procedure for password resets. On kodo the gateway logs people in, the kernel tells the gadget who is calling, and the cell's shares say who belongs, so this gadget is one file with no secrets in it.

| File | What |
| --- | --- |
| [`gadget.js`](gadget.js) | The gadget: one module that exports `App`, with its page |
| [`blueprint.yaml`](blueprint.yaml) | Blueprint `daybreak` version `1.0.1`; it needs no capabilities |
| [`kustomization.yaml`](kustomization.yaml) | The Blueprint and a ConfigMap with the gadget's source |

## How it works

| Applet.one Daybreak | kodo Daybreak |
| --- | --- |
| One app, many accounts | One cell is one circle of friends; start another cell for another circle |
| Register, log in, log out | The gateway's login; the gadget reads `x-kodo-user` and `x-kodo-email` |
| Friend requests by email | The cell's owner shares the cell with a friend as `editor`; they are a member from their first visit |
| Password reset by an operator | Your identity provider's |
| Times in Europe/Berlin | Times are stored as instants and shown in each person's browser time zone |

- A member is anyone who has opened the cell: its owner, or someone it is shared with. A `viewer` share lets someone see the circle's free time without changing anything; the kernel refuses their writes before the gadget sees them.
- Free time comes in quarter hours, up to 12 hours at a time and 60 days ahead. Times that overlap or touch are merged.
- "Free together" lists where your free time meets each other member's. Proposing a meeting needs both of you to be free for all of it; accepting checks again, since either may have given the time to something else, and then reserves it for both.
- Everything lives in the cell's SQLite database. A daily alarm deletes free time that has passed and old meetings.

```
alice (owner) ──┐                         ┌── members, free time, meetings (SQLite)
bob (editor) ───┼─► <cell>.g.<domain> ─► kernel ─► daybreak
carol (viewer) ─┘   gateway login          │ x-kodo-user, x-kodo-email, x-kodo-role
dan ──────────────► 403 (not shared)       └ daily alarm: clear the past
```

## Deploy it

You need a fleet (on hiddenfield.dev: `task k3s:up`), a workspace and a login. These steps use hiddenfield.dev and the cookie jar from `test/e2e/lib.sh`'s `login`; a browser session works the same.

```sh
kubectl -n kodo apply -k examples/daybreak
kubectl -n kodo wait blueprint/daybreak-1.0.1 --for=condition=Published

# As alice: create the circle and share it with bob.
curl -b jar -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"blueprint":"daybreak"}' https://app.hiddenfield.dev/api/workspaces/team/cells
curl -b jar -X PUT -H "Origin: https://app.hiddenfield.dev" -H 'content-type: application/json' \
  -d '{"role":"editor"}' https://app.hiddenfield.dev/api/workspaces/team/cells/<cell>/shares/bob@hiddenfield.dev
```

Both of you open `https://<cell>.g.hiddenfield.dev/`, add when you are free, and propose a meeting from "Free together". `task k3s:examples-test` does the same through the gateway.

## API

| Method | Path | Body | |
| --- | --- | --- | --- |
| GET | `/api/state` | | `{me, members: [{email, me, free}], windows: [{with, start, end}], meetings}` |
| POST | `/api/slots` | `{start, end}` (epoch ms) | Adds free time |
| DELETE | `/api/slots/:id` | | Removes your free time |
| POST | `/api/meetings` | `{with, start, end, title}` | Proposes a meeting to a member |
| POST | `/api/meetings/:id/accept` | | The recipient accepts; the time is reserved for both |
| POST | `/api/meetings/:id/decline` | | |
| POST | `/api/meetings/:id/cancel` | | Withdraws a pending meeting you proposed, or cancels an accepted one |

Every write answers with the new state, or `{"error"}`.
