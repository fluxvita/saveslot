// `log.reconcile` in the service (docs/zh-CN/spec/04-contract.md, the operation table; 02-architecture.md
// §3, §7 "对拍"): the kernel's `reconcileLog` run against a tenant's live storage and a scratch
// storage the host makes for it, one run per tenant at a time.
//
// One run per tenant: a second call while one runs in this process is refused at once with
// `rate_limited` (`busy`), not queued. The live storage is borrowed for the whole run (in the server
// mode through the tenant pool's `use`, so an import's or a restore's `exclusive` waits for it). Only
// the kernel's last part (§7 ③) makes writes wait, and only on PGlite, whose reads and writes share
// one queue; on PostgreSQL that part is one read snapshot and writes need not queue.
//
// The scratch storage is not in the tenant's storage (§3): a database of the tenant's cell named
// after the tenant (`<tenant>_reconcile`) in the server mode, a directory under the home
// (`<home>/tmp/reconcile/<tenant>`) in the local mode. A run discards one left over before making it
// afresh, and discards its own after, whether it succeeded or failed; opening the tenant discards one
// a crash left (the pool's `discardScratch`, `openLocalTenant`).

import { mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import {
  type ReconcileOptions,
  type ReconcileResult,
  reconcileLog,
  type StorageBackend,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { ContractError } from "./contract-error.ts";
import type { ControlPlane, TenantId } from "./control-plane.ts";
import { SCRATCH_SUFFIX } from "./server-control-plane.ts";
import { databaseOf } from "./server-tenant.ts";

/** Where a tenant's scratch storage is made and how it is dropped: the host's. */
export interface ReconcileScratch {
  /** Makes the tenant's scratch storage, empty, and opens it. */
  open(tenant: TenantId): Promise<TenantStore>;
  /** Drops the tenant's scratch storage; nothing when there is none. */
  discard(tenant: TenantId): Promise<void>;
}

/** Lends the tenant's live storage to `fn` and keeps it open until `fn` ends. */
export type BorrowLive = <T>(fn: (live: TenantStore) => Promise<T>) => Promise<T>;

/** Seconds a refused call is told to wait: a run's length is not known beforehand. */
export const RECONCILE_RETRY_AFTER = 60;

export interface TenantReconcilerOptions {
  readonly scratch: ReconcileScratch;
  /**
   * Told that a run's scratch storage was not dropped after the run; the next run or opening of the
   * tenant drops it. By default written to standard error: the tenant's ID and the error's code.
   */
  readonly onDiscardFailure?: (tenant: TenantId, error: unknown) => void;
  /** The kernel's batch and page sizes; a test gives small ones. */
  readonly batch?: number;
  readonly page?: number;
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.name : "error";
};

/**
 * The runs of `log.reconcile` in one process. "One run per tenant" holds per instance, and a
 * tenant's scratch storage has one fixed name: a host makes one instance for its home (the local
 * mode) or its server (the server mode) and gives every call that one.
 */
export class TenantReconciler {
  readonly options: TenantReconcilerOptions;
  readonly #running = new Set<TenantId>();

  constructor(o: TenantReconcilerOptions) {
    this.options = o;
  }

  /** Runs `log.reconcile` for the tenant; refused with `rate_limited` (`busy`) while one runs. */
  async reconcile(
    tenant: TenantId,
    borrow: BorrowLive,
    o: { readonly onPhase?: ReconcileOptions["onPhase"] } = {},
  ): Promise<ReconcileResult> {
    if (this.#running.has(tenant)) {
      throw new ContractError("rate_limited", "log.reconcile is already running for this tenant", {
        reason: "busy",
        retry_after: RECONCILE_RETRY_AFTER,
      });
    }
    this.#running.add(tenant);
    try {
      return await borrow((live) => this.#run(tenant, live, o.onPhase));
    } finally {
      this.#running.delete(tenant);
    }
  }

  async #run(
    tenant: TenantId,
    live: TenantStore,
    onPhase: ReconcileOptions["onPhase"],
  ): Promise<ReconcileResult> {
    const { scratch, batch, page } = this.options;
    await scratch.discard(tenant);
    try {
      const store = await scratch.open(tenant);
      try {
        return await reconcileLog({
          live,
          scratch: store,
          ...(batch === undefined ? {} : { batch }),
          ...(page === undefined ? {} : { page }),
          ...(onPhase === undefined ? {} : { onPhase }),
        });
      } finally {
        await store.close().catch(() => {});
      }
    } finally {
      // Not the run's failure: the next run or opening drops it.
      await scratch.discard(tenant).catch((e: unknown) => this.#report(tenant, e));
    }
  }

  #report(tenant: TenantId, error: unknown): void {
    try {
      (
        this.options.onDiscardFailure ??
        ((t, e) =>
          console.error(`saveslot log.reconcile: scratch not discarded for ${t}: ${codeOf(e)}`))
      )(tenant, error);
    } catch {
      // A report that fails is not the run's failure.
    }
  }
}

/** The server mode's scratch database of a tenant: in the tenant's cell, named after the tenant. */
export const scratchDatabaseOf = (tenant: TenantId): string =>
  `${databaseOf(tenant)}${SCRATCH_SUFFIX}`;

/**
 * The server mode's scratch storage: a database of the tenant's cell, made through the backend; the
 * host drops it (`discard`, as it gives the pool's `discardScratch`).
 */
export function serverReconcileScratch(o: {
  readonly control: ControlPlane;
  readonly backend: StorageBackend;
  readonly discard: (tenant: TenantId) => Promise<void>;
}): ReconcileScratch {
  return {
    open: async (tenant) => {
      const entry = await o.control.tenant(tenant);
      if (entry === undefined || entry.ref.kind !== "postgres") {
        throw new Error("log.reconcile: the tenant has no database in a cell");
      }
      return o.backend.open(
        { kind: "postgres", cell: entry.ref.cell, database: scratchDatabaseOf(tenant) },
        { create: true },
      );
    },
    discard: o.discard,
  };
}

/** The local mode's scratch directory of a tenant. */
export const scratchDirOf = (home: string, tenant: TenantId): string =>
  join(home, "tmp", "reconcile", tenant);

/** Removes the local mode's scratch directory of a tenant; nothing when there is none. */
export const discardLocalScratch = (home: string, tenant: TenantId): Promise<void> =>
  rm(scratchDirOf(home, tenant), { recursive: true, force: true });

/** The local mode's scratch storage: a directory under the home, 0700 as the home's own. */
export function localReconcileScratch(o: {
  readonly home: string;
  readonly backend: StorageBackend;
}): ReconcileScratch {
  return {
    open: async (tenant) => {
      await mkdir(join(o.home, "tmp", "reconcile"), { recursive: true, mode: 0o700 });
      return o.backend.open(
        { kind: "pglite", dir: scratchDirOf(o.home, tenant) },
        { create: true },
      );
    },
    discard: (tenant) => discardLocalScratch(o.home, tenant),
  };
}
