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
//
// Opening checks what the local mode's opening checks (`openLocalTenant`): the anchor and the log's
// end, and the kernel's `openTenant`; a tenant that does not serve is closed again and not kept.
//
// Closing is never thrown at anyone: a use waiting for a close gets its own outcome, not the close's.
// What goes wrong is reported (`onCloseFailure`): the reads not written and the high water not moved
// are best-effort (§7, §8) and the storage closes anyway; a storage that did not close is kept, and
// closed again before the tenant is opened anew, by the next use, exclusive or closeAll. While it
// stays open, those are refused with `close_failed`: on PGlite a second opening would meet its lock.
//
// `closeAll` is for stopping: it refuses uses and exclusives from then on, waits for the ones in
// progress, and returns once every tenant is closed.
//
// The pool keeps a small record for each tenant used since it started, open or not: bounded by the
// deployment's tenants, and not worth the races of dropping one a use may be waiting on.

import {
  type AnchorStore,
  type OpenTenantStop,
  openTenant,
  readTail,
  type StorageBackend,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import type { ControlPlane, TenantId, UserId } from "./control-plane.ts";
import { closeLocalTenant } from "./local-tenant.ts";

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
  /**
   * Told what went wrong closing a tenant, which the pool throws at no one. By default written to
   * standard error: the tenant's ID, what failed and the error's code, nothing of its data.
   */
  readonly onCloseFailure?: (tenant: TenantId, what: CloseFailure, error: unknown) => void;
}

/** What went wrong closing a tenant: its reads not written, its high water not moved, its storage not closed. */
export type CloseFailure = "reads_not_flushed" | "high_water_not_advanced" | "close_failed";

/** Why a tenant cannot be lent. Stable codes; no user data. */
export type TenantPoolFailure =
  /** No such tenant in the directory. */
  | "unknown_tenant"
  /** Registered, its creation not finished. */
  | "tenant_creating"
  /** The tenant's storage has no events. */
  | "tenant_empty"
  /** The tenant's storage did not close and is still open: it cannot be opened again yet. */
  | "close_failed"
  /** The pool is closed (closeAll). */
  | "pool_closed"
  | OpenTenantStop;

export class TenantPoolError extends Error {
  override readonly name = "TenantPoolError";
  readonly code: TenantPoolFailure;
  constructor(code: TenantPoolFailure, message: string) {
    super(message);
    this.code = code;
  }
}

interface Slot {
  /** The opening in progress or done; none while closed. */
  opening?: Promise<OpenTenant> | undefined;
  uses: number;
  idle?: ReturnType<typeof setTimeout> | undefined;
  /** A close in progress: a use waits for it before opening the tenant again. */
  closing?: Promise<void> | undefined;
  /** Set while an `exclusive` holds the tenant: uses wait for it. */
  gate?: Promise<void> | undefined;
  /** Called when the last use ends, for an `exclusive` or a `closeAll` waiting on them. */
  drained?: (() => void) | undefined;
  /** A storage whose close failed: closed again before the tenant is opened anew. */
  unclosed?: TenantStore | undefined;
}

const codeOf = (e: unknown): string => {
  const code = (e as { code?: unknown } | null)?.code;
  return typeof code === "string" ? code : e instanceof Error ? e.name : "error";
};

const reportToStderr = (tenant: TenantId, what: CloseFailure, error: unknown): void => {
  console.error(`saveslot tenant pool: ${what} for ${tenant}: ${codeOf(error)}`);
};

export class TenantPool {
  readonly options: TenantPoolOptions;
  readonly #slots = new Map<TenantId, Slot>();
  #closed = false;

  constructor(o: TenantPoolOptions) {
    this.options = o;
  }

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  #slot(tenant: TenantId): Slot {
    let s = this.#slots.get(tenant);
    if (s === undefined) {
      s = { uses: 0 };
      this.#slots.set(tenant, s);
    }
    return s;
  }

  /** Runs `fn` with the tenant open; it is not closed while `fn` runs. */
  async use<T>(tenant: TenantId, fn: (t: OpenTenant) => Promise<T>): Promise<T> {
    this.#refuseClosed();
    const slot = this.#slot(tenant);
    // An exclusive holding the tenant and a close in progress, until neither: an exclusive may begin
    // while a close is waited for, and a close may be an exclusive's. The old storage is closed
    // first: opening it again meanwhile would meet its single-writer lock.
    for (;;) {
      if (slot.gate !== undefined) await slot.gate;
      else if (slot.closing !== undefined) await slot.closing;
      else if (slot.unclosed !== undefined && slot.opening === undefined) {
        await this.#close(tenant);
        if (slot.unclosed !== undefined) {
          throw new TenantPoolError("close_failed", "the tenant's storage did not close");
        }
      } else break;
    }
    this.#refuseClosed();
    if (slot.idle !== undefined) {
      clearTimeout(slot.idle);
      slot.idle = undefined;
    }
    slot.uses++;
    try {
      if (slot.opening === undefined) {
        const p = this.#open(tenant);
        slot.opening = p;
        // A tenant that did not open is not kept: the next use tries again.
        p.catch(() => {
          if (slot.opening === p) slot.opening = undefined;
        });
      }
      return await fn(await slot.opening);
    } finally {
      slot.uses--;
      if (slot.uses === 0) {
        slot.drained?.();
        if (slot.opening !== undefined && slot.gate === undefined) {
          slot.idle = setTimeout(() => void this.#close(tenant), this.options.idleMs);
          slot.idle.unref?.();
        }
      }
    }
  }

  /**
   * Waits for the uses in progress, holds new ones back, closes the tenant, then runs `fn`. Not
   * reentrant: a `use` or `exclusive` of the same tenant inside `fn` waits for `fn`, for ever.
   */
  async exclusive<T>(tenant: TenantId, fn: () => Promise<T>): Promise<T> {
    this.#refuseClosed();
    const slot = this.#slot(tenant);
    while (slot.gate !== undefined) await slot.gate;
    this.#refuseClosed();
    let release = () => {};
    slot.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    try {
      if (slot.uses > 0) {
        await new Promise<void>((resolve) => {
          slot.drained = resolve;
        });
      }
      slot.drained = undefined;
      await this.#close(tenant);
      if (slot.unclosed !== undefined) {
        throw new TenantPoolError("close_failed", "the tenant's storage did not close");
      }
      return await fn();
    } finally {
      slot.gate = undefined;
      release();
    }
  }

  /**
   * For stopping: refuses uses and exclusives from now on, waits for the ones in progress, and
   * closes every tenant (writing its reads and moving its high water first); returns when all are.
   */
  async closeAll(): Promise<void> {
    this.#closed = true;
    await Promise.all(
      [...this.#slots].map(async ([tenant, slot]) => {
        while (slot.gate !== undefined) await slot.gate;
        if (slot.uses > 0) {
          await new Promise<void>((resolve) => {
            slot.drained = resolve;
          });
          slot.drained = undefined;
        }
        await this.#close(tenant);
      }),
    );
  }

  #refuseClosed(): void {
    if (this.#closed) throw new TenantPoolError("pool_closed", "the pool is closed");
  }

  #report(tenant: TenantId, what: CloseFailure, error: unknown): void {
    try {
      (this.options.onCloseFailure ?? reportToStderr)(tenant, what, error);
    } catch {
      // A report that fails is not the pool's failure.
    }
  }

  /**
   * Closes the tenant if it is open, after a close in progress: reads written, high water moved up,
   * storage closed; a storage kept from a close that failed is closed again first. Never rejects:
   * what fails is reported, and a storage that did not close is kept in `unclosed`.
   */
  async #close(tenant: TenantId): Promise<void> {
    const slot = this.#slots.get(tenant);
    if (slot === undefined) return;
    if (slot.idle !== undefined) {
      clearTimeout(slot.idle);
      slot.idle = undefined;
    }
    while (slot.closing !== undefined) await slot.closing;
    const opening = slot.opening;
    const unclosed = slot.unclosed;
    if (opening === undefined && unclosed === undefined) return;
    slot.opening = undefined;
    slot.unclosed = undefined;
    const closing = (async () => {
      if (unclosed !== undefined) {
        try {
          await unclosed.close();
        } catch (e) {
          slot.unclosed = unclosed;
          this.#report(tenant, "close_failed", e);
          return;
        }
      }
      const t = await opening?.catch(() => undefined);
      if (t === undefined) return;
      try {
        const r = await closeLocalTenant({ ...t, user: t.owner }, this.#now());
        if (r.readsError !== undefined) this.#report(tenant, "reads_not_flushed", r.readsError);
        if (r.highWaterError !== undefined) {
          this.#report(tenant, "high_water_not_advanced", r.highWaterError);
        }
      } catch (e) {
        slot.unclosed = t.store;
        this.#report(tenant, "close_failed", e);
      }
    })();
    slot.closing = closing;
    await closing;
    if (slot.closing === closing) slot.closing = undefined;
  }

  /** Opens the tenant as the directory routes it now, and checks that it serves. */
  async #open(tenant: TenantId): Promise<OpenTenant> {
    const { control, backend } = this.options;
    const entry = await control.tenant(tenant);
    if (entry === undefined) throw new TenantPoolError("unknown_tenant", "no such tenant");
    if (entry.state !== "active") {
      throw new TenantPoolError("tenant_creating", "the tenant's creation is not finished");
    }
    const store = await backend.open(entry.ref, {});
    try {
      const [tail, a] = await Promise.all([
        store.read((tx) => readTail(tx)),
        control.anchors.read(tenant),
      ]);
      if (tail === undefined) throw new TenantPoolError("tenant_empty", "the tenant has no events");
      const decision = await openTenant({
        importInProgress: a.importInProgress,
        restoreInProgress: a.restoreInProgress,
        logEnd: tail.seq,
        highWater: a.highWater,
      });
      if (decision.kind !== "serve") {
        // The import's re-entry comes with the server mode's import; until then a marker is reported
        // as it is, and the tenant does not serve.
        const what = decision.kind === "not_implemented" ? decision.what : "import_in_progress";
        throw new TenantPoolError(what, `the tenant does not serve: ${what}`);
      }
      // `openTenant` steps 4 and 5 come here with the deletion flows, as in the local mode.
      return { tenant, owner: entry.owner, store, anchor: control.anchors };
    } catch (e) {
      await store.close().catch(() => {});
      throw e;
    }
  }
}
