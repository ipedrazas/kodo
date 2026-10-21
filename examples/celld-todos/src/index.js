import { Todos } from "./todos.js";

export { Todos };

// /lists/<name>/... goes to the Todos object for <name>, with the prefix
// removed, so the object serves its page at / wherever it is mounted.
export default {
  async fetch(request, env) {
    const url = new URL(request.url);
    const match = url.pathname.match(/^\/lists\/([a-z0-9][a-z0-9-]{0,63})(\/.*)?$/);
    if (!match) return new Response("try /lists/groceries/\n", { status: 404 });
    if (!match[2]) return Response.redirect(`${url.origin}/lists/${match[1]}/`, 302);
    url.pathname = match[2];
    const list = env.LISTS.get(env.LISTS.idFromName(match[1]));
    return list.fetch(new Request(url, request));
  },
};
