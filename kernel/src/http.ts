// The router sets this header to the cell id taken from the hostname; any
// value a client sends is overwritten.
export const CELL_HEADER = "x-kodo-cell";

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
