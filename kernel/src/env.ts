import type { Cell } from "./cell";

export interface Env {
  LOADER: WorkerLoader;
  BUNDLES: R2Bucket;
  CELLS: R2Bucket;
  CELL: DurableObjectNamespace<Cell>;
  GADGET_CALL_TIMEOUT_MS: string;
  GADGET_CPU_MS: string;
  // Set to "1" only through .dev.vars, which celld dev reads and celld deploy
  // does not, so the /_dev routes never reach a fleet.
  KERNEL_DEV?: string;
}
