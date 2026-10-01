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
  // Identity settings; see config.ts. Normally set at deploy time instead.
  OIDC_ISSUER?: string;
  OIDC_AUDIENCE?: string;
  OIDC_JWKS_URL?: string;
  ADMIN_TOKEN_SHA256?: string;
  // Gatekeeper settings; see config.ts. Normally set at deploy time instead.
  GATEKEEPER_URL?: string;
  GATEKEEPER_KEY?: string;
  FLEET_ID?: string;
}
