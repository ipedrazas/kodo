// Headers the router sets after checking the request: the cell id from the
// hostname, and the verified caller as JSON. The router drops every x-kodo-*
// header a client sends.
export const CELL_HEADER = "x-kodo-cell";
export const CALLER_HEADER = "x-kodo-caller";

export function text(status: number, message: string): Response {
  return new Response(`${message}\n`, {
    status,
    headers: { "content-type": "text/plain; charset=utf-8" },
  });
}

export async function sha256Hex(data: ArrayBuffer | ArrayBufferView): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", data);
  return [...new Uint8Array(hash)].map((b) => b.toString(16).padStart(2, "0")).join("");
}
