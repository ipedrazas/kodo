// A cell is served at <cell-id>.g.<domain>. The cell id is one DNS label.
const CELL_HOST = /^([a-z0-9](?:[a-z0-9-]{0,61}[a-z0-9])?)\.g\.[a-z0-9.-]+$/;

// Returns the cell id for a cell hostname, or null for any other host.
export function cellFromHost(host: string): string | null {
  const match = CELL_HOST.exec(host.toLowerCase().replace(/:\d+$/, ""));
  return match ? match[1] : null;
}

export function isCellId(id: string): boolean {
  return cellFromHost(`${id}.g.x`) === id;
}
