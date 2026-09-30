import type { Catalog } from "./catalog";
import type { Cell } from "./cell";
import type { Keys } from "./host";
import type { Workspace } from "./workspace";

export interface Env {
  LOADER: WorkerLoader;
  BUNDLES: R2Bucket;
  CELL: DurableObjectNamespace<Cell>;
  CATALOG: DurableObjectNamespace<Catalog>;
  WORKSPACE: DurableObjectNamespace<Workspace>;
  KEYS: DurableObjectNamespace<Keys>;
  GADGET_CALL_TIMEOUT_MS: string;
  GADGET_CPU_MS: string;
}
