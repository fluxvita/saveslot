// The server mode's open tenants, in one process (docs/zh-CN/spec/02-architecture.md §5, §7 进程模型,
// §8): a tenant's storage is opened when a request first needs it, through the control plane's
// routing, and kept open while it is used; closed when it has gone unused for a while, after its
// buffered reads are written and its high water moved up to the log's end (§8).
//
// A tenant is lent, never handed over: `use` runs a function with the open tenant and does not close
// it meanwhile. `exclusive` waits for the uses in progress, holds new ones back, closes the tenant
// and runs its function (an import's swap, a restore); the next use opens it again, reading its
// entry from the control plane afresh. Only an `active` tenant opens; one `creating` does not serve
// and is not kept. One process: no affinity across processes (v1).

import type { AnchorStore, StorageBackend, TenantStore } from "@fluxvita/saveslot-kernel";
import type { ControlPlane, TenantId, UserId } from "./control-plane.ts";

/** A tenant lent by the pool, as the local mode's `LocalTenant`. */
export interface OpenTenant {
  readonly tenant: TenantId;
  readonly owner: UserId;
  readonly store: TenantStore;
  readonly anchor: AnchorStore;
}

export interface TenantPoolOptions {
  readonly control: ControlPlane;
  readonly backend: StorageBackend;
  /** How long a tenant stays open after its last use ends, in milliseconds. */
  readonly idleMs: number;
  readonly now?: () => string;
}

export class TenantPool {
  readonly options: TenantPoolOptions;

  constructor(o: TenantPoolOptions) {
    this.options = o;
  }

  /** Runs `fn` with the tenant open; it is not closed while `fn` runs. */
  async use<T>(_tenant: TenantId, _fn: (t: OpenTenant) => Promise<T>): Promise<T> {
    throw new Error("TenantPool.use: not implemented");
  }

  /** Waits for the uses in progress, holds new ones back, closes the tenant, then runs `fn`. */
  async exclusive<T>(_tenant: TenantId, _fn: () => Promise<T>): Promise<T> {
    throw new Error("TenantPool.exclusive: not implemented");
  }

  /** Closes every open tenant (writing their reads and moving their high water first). */
  async closeAll(): Promise<void> {
    throw new Error("TenantPool.closeAll: not implemented");
  }
}
