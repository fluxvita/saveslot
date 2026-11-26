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
// An import or a restore holds its tenant with `exclusive` and `refuse`: from taking the gate to its
// end, uses are refused at once with that code (`importing`, `restoring`) rather than queued, and
// another exclusive with `busy`, which names the holder. These are this process's gate; `import_in_progress` and
// `restore_in_progress` are the anchor's markers, which any opening sees (§8).
//
// Opening takes up an import a crash left (§8 «重入»), as the kernel's `openTenant` decides it: with
// the anchor's import marker, the import's event in the log says it was swapped in, and the import
// is finished (`finishImport`); without it, the staging database is discarded and the marker cleared
// (`abortImportOnOpen`); then the decision is taken again. Once finished, the staging database the
// directory names is the one the swap replaced, and is discarded as one with no marker (below). Discarding is the host's
// (`discardStaging`); when it fails with the marker there, this opening is refused with
// `staging_not_discarded`, not kept, and the next use tries again.
//
// A staging database with no marker is discarded on every opening. That is safe because the server
// mode's import takes the tenant with `exclusive(..., { refuse: "importing" })` before it makes the
// staging database and holds it through ⑥, the swap included: while an import is under way nothing
// in this process opens the tenant, and v1 runs one process per control database (02 §7), so
// one seen on opening was left by a crash before ④, or is the database a swap replaced (⑤ records it
// there) that a crash or a failed drop left, or is a refused import's staging database (dropped after
// the refusal's answer, recorded until then). One whose drop is still under way is left to that drop
// by the server's `discardStaging` (`inFlight: "leave"`), so the opening does not wait for it.
// Without the marker the tenant's data is whole: a discard that fails is reported
// (`onDiscardFailure`), the tenant serves, and the next opening tries again. The empty log (`tenant_empty`) is checked after the marker, as §4 orders them.
//
// Opening drops the tenant's `log.reconcile` scratch storage a crash left (§3), before it opens the
// tenant's storage: no run can be going on then, since a run holds a use. Dropping is the host's
// (`discardScratch`); when it fails, the failure is reported (`onScratchDiscardFailure`) and the
// tenant serves: the scratch storage is not the tenant's data, the next opening tries again, and a
// run drops one left over before it makes its own.
//
// `closeAll` is for stopping: it refuses uses and exclusives from then on, waits for the ones in
// progress, and returns once every tenant is closed.
//
// The pool keeps a small record for each tenant used since it started, open or not: bounded by the
// deployment's tenants, and not worth the races of dropping one a use may be waiting on.
//
// At most `maxOpen` tenants hold a database connection at once (02-architecture §7 «连接»;
// 01-positioning «技术选型»): open, opening, closing, or kept unclosed after a close that failed. A use
// that needs a tenant opened takes a place first. With none free it waits in line, first come first
// served: the tenant unused for longest among those idle (open, no use, no exclusive, not closing)
// is closed for it, as an idle tenant is (reads written, high water moved up); with none idle, it
// waits until a place comes back, for at most OPEN_WAIT_MS, then is refused with `pool_full`. The
// connections the pool does not see (a tenant being made, an import's two, the cell's maintenance
// database) are not counted: the deployment's connection budget leaves room for them. A database
// that refuses the connection itself as too many (SQLSTATE 53300) is refused with `pool_full` too.

import {
  type AnchorStore,
  abortImportOnOpen,
  finishImport,
  importEventInLog,
  type OpenTenantDecision,
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
  /** At most this many tenants hold a connection at once; absent, no bound. */
  readonly maxOpen?: number;
  /** Tests only: how long a use waits for a place (OPEN_WAIT_MS otherwise). */
  readonly openWaitMs?: number;
  /**
   * Told that a use was refused with `pool_full`: it waited `wait`, or the database refused the
   * connection as too many (`database`). The tenant's ID only.
   */
  readonly onFull?: (tenant: TenantId, why: "wait" | "database") => void;
  readonly now?: () => string;
  /**
   * Told what went wrong closing a tenant, which the pool throws at no one. By default written to
   * standard error: the tenant's ID, what failed and the error's code, nothing of its data.
   */
  readonly onCloseFailure?: (tenant: TenantId, what: CloseFailure, error: unknown) => void;
  /**
   * Drops an import's staging database of the tenant and clears it from the directory; nothing
   * when it is gone. Called when the tenant opens and an import left one (§8 «重入»).
   */
  readonly discardStaging: (tenant: TenantId, staging: string) => Promise<void>;
  /**
   * Told that a staging database with no import marker could not be discarded on opening; the
   * tenant serves anyway. By default written to standard error: the tenant's ID and the error's code.
   */
  readonly onDiscardFailure?: (tenant: TenantId, error: unknown) => void;
  /**
   * Drops the tenant's `log.reconcile` scratch storage; nothing when there is none. Called when the
   * tenant opens, for one a crash left (§3).
   */
  readonly discardScratch: (tenant: TenantId) => Promise<void>;
  /**
   * Told that a `log.reconcile` scratch storage could not be dropped on opening; the tenant serves
   * anyway. By default written to standard error: the tenant's ID and the error's code.
   */
  readonly onScratchDiscardFailure?: (tenant: TenantId, error: unknown) => void;
}

/** What an `exclusive` that refuses tells the uses arriving meanwhile. */
export type ExclusiveRefusal = "importing" | "restoring";

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
  /**
   * Every place is held and none came free within OPEN_WAIT_MS, or the database refused the
   * connection as too many: retry shortly.
   */
  | "pool_full"
  /** An import holds the tenant in this process (not the anchor's `import_in_progress`). */
  | "importing"
  /** A restore holds the tenant in this process (not the anchor's `restore_in_progress`). */
  | "restoring"
  /**
   * An exclusive that refuses holds the tenant: another one is not queued. The error's `holder`
   * says which (`importing`, `restoring`).
   */
  | "busy"
  /**
   * An import's staging database could not be discarded on opening, with the import's marker there:
   * the import is not rolled back yet; the next use tries again.
   */
  | "staging_not_discarded"
  | OpenTenantStop;

export class TenantPoolError extends Error {
  override readonly name = "TenantPoolError";
  readonly code: TenantPoolFailure;
  /** With `busy`: what the exclusive holding the tenant refuses its uses with. */
  readonly holder?: ExclusiveRefusal;
  constructor(code: TenantPoolFailure, message: string, o: { holder?: ExclusiveRefusal } = {}) {
    super(message);
    this.code = code;
    if (o.holder !== undefined) this.holder = o.holder;
  }
}

/** How long a use waits for a place among the `maxOpen` before it is refused with `pool_full`. */
export const OPEN_WAIT_MS = 5_000;

/** The SQLSTATE with which PostgreSQL refuses a connection past its `max_connections`. */
const TOO_MANY_CONNECTIONS = "53300";

interface Slot {
  /** The opening in progress or done; none while closed. */
  opening?: Promise<OpenTenant> | undefined;
  /** The opening has resolved: the tenant is open. */
  open?: boolean | undefined;
  /** It holds one of the `maxOpen` places: from before it is opened until its connection is gone. */
  place?: boolean | undefined;
  /** A place being waited for, shared by the uses of this tenant that need it. */
  placing?: Promise<void> | undefined;
  /** When its last use ended (monotonic): the idle tenant unused for longest is closed first. */
  lastUsed: number;
  uses: number;
  idle?: ReturnType<typeof setTimeout> | undefined;
  /** A close in progress: a use waits for it before opening the tenant again. */
  closing?: Promise<void> | undefined;
  /** Set while an `exclusive` holds the tenant: uses wait for it. */
  gate?: Promise<void> | undefined;
  /** Set while an `exclusive` that refuses holds it: uses are refused with it, not queued. */
  refuse?: ExclusiveRefusal | undefined;
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

const reportDiscardToStderr = (tenant: TenantId, error: unknown): void => {
  console.error(`saveslot tenant pool: staging_not_discarded for ${tenant}: ${codeOf(error)}`);
};

const reportScratchDiscardToStderr = (tenant: TenantId, error: unknown): void => {
  console.error(`saveslot tenant pool: scratch_not_discarded for ${tenant}: ${codeOf(error)}`);
};

/** A use waiting in line for a place. */
interface Waiter {
  readonly tenant: TenantId;
  readonly resolve: () => void;
  readonly reject: (e: TenantPoolError) => void;
  readonly timer: ReturnType<typeof setTimeout>;
}

export class TenantPool {
  readonly options: TenantPoolOptions;
  readonly #slots = new Map<TenantId, Slot>();
  #closed = false;
  /** The places held. */
  #held = 0;
  /** The uses waiting for a place, in the order they came. */
  readonly #line: Waiter[] = [];
  /** Idle tenants being closed to free a place. */
  #evicting = 0;

  constructor(o: TenantPoolOptions) {
    this.options = o;
  }

  #now(): string {
    return this.options.now?.() ?? new Date().toISOString();
  }

  #slot(tenant: TenantId): Slot {
    let s = this.#slots.get(tenant);
    if (s === undefined) {
      s = { uses: 0, lastUsed: 0 };
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
      if (slot.gate !== undefined) {
        if (slot.refuse !== undefined) {
          throw new TenantPoolError(slot.refuse, `the tenant is held: ${slot.refuse}`);
        }
        await slot.gate;
      } else if (slot.closing !== undefined) await slot.closing;
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
      if (slot.opening === undefined && !slot.place) {
        // One place for the tenant, however many of its uses need it: the first waits, the others
        // wait with it. Nothing closes it meanwhile: it has uses.
        if (slot.placing === undefined) {
          const placing = this.#takePlace(tenant).then(() => {
            slot.place = true;
          });
          slot.placing = placing;
          void placing
            .finally(() => {
              if (slot.placing === placing) slot.placing = undefined;
            })
            .catch(() => {});
        }
        await slot.placing;
      }
      if (slot.opening === undefined) {
        const p = this.#open(tenant);
        slot.opening = p;
        p.then(
          () => {
            if (slot.opening === p) slot.open = true;
          },
          // A tenant that did not open is not kept, nor its place: the next use tries again.
          () => {
            if (slot.opening === p) slot.opening = undefined;
            this.#settle(slot);
          },
        );
      }
      return await fn(await slot.opening);
    } finally {
      slot.uses--;
      if (slot.uses === 0) {
        slot.lastUsed = performance.now();
        slot.drained?.();
        if (slot.opening !== undefined && slot.gate === undefined) {
          slot.idle = setTimeout(() => void this.#close(tenant), this.options.idleMs);
          slot.idle.unref?.();
          // Idle now: one a use in line may have the place of.
          this.#pump();
        }
      }
    }
  }

  /** Takes one of the `maxOpen` places: at once while one is free and no one is in line; else in line. */
  #takePlace(tenant: TenantId): Promise<void> {
    const max = this.options.maxOpen;
    if (max === undefined || (this.#line.length === 0 && this.#held < max)) {
      this.#held++;
      return Promise.resolve();
    }
    return new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => {
        const i = this.#line.indexOf(waiter);
        if (i >= 0) this.#line.splice(i, 1);
        this.#reportFull(tenant, "wait");
        reject(new TenantPoolError("pool_full", "every place for an open tenant is held"));
      }, this.options.openWaitMs ?? OPEN_WAIT_MS);
      const waiter: Waiter = { tenant, resolve, reject, timer };
      this.#line.push(waiter);
      this.#pump();
    });
  }

  /**
   * Gives the places that are free to the uses in line, in order; for those still waiting, closes
   * as many idle tenants (unused for longest first) as are not being closed already.
   */
  #pump(): void {
    const max = this.options.maxOpen;
    if (max === undefined) return;
    while (this.#line.length > 0 && this.#held < max) {
      const w = this.#line.shift() as Waiter;
      clearTimeout(w.timer);
      this.#held++;
      w.resolve();
    }
    while (this.#line.length > this.#evicting) {
      const victim = this.#idlest();
      if (victim === undefined) return;
      this.#evicting++;
      void this.#close(victim).finally(() => {
        this.#evicting--;
        this.#pump();
      });
    }
  }

  /** The idle tenant unused for longest: open, no use, no exclusive, not closing, holding a place. */
  #idlest(): TenantId | undefined {
    let found: [TenantId, Slot] | undefined;
    for (const [tenant, s] of this.#slots) {
      if (
        s.place === true &&
        s.open === true &&
        s.uses === 0 &&
        s.gate === undefined &&
        s.closing === undefined &&
        s.unclosed === undefined &&
        (found === undefined || s.lastUsed < found[1].lastUsed)
      ) {
        found = [tenant, s];
      }
    }
    return found?.[0];
  }

  /** Gives the tenant's place back once it holds no connection: not open, not closing, nothing unclosed. */
  #settle(slot: Slot): void {
    if (
      slot.place === true &&
      slot.opening === undefined &&
      slot.closing === undefined &&
      slot.unclosed === undefined
    ) {
      slot.place = false;
      this.#held--;
      this.#pump();
    }
  }

  #reportFull(tenant: TenantId, why: "wait" | "database"): void {
    try {
      this.options.onFull?.(tenant, why);
    } catch {
      // A report that fails is not the pool's failure.
    }
  }

  /**
   * Waits for the uses in progress, holds new ones back, closes the tenant, then runs `fn`. Not
   * reentrant: a `use` or `exclusive` of the same tenant inside `fn` waits for `fn`, for ever.
   * With `refuse`, from taking the gate to the end, uses are refused with it at once and another
   * exclusive with `busy` (its `holder` the `refuse` given here), rather than queued.
   */
  async exclusive<T>(
    tenant: TenantId,
    fn: () => Promise<T>,
    opts: { readonly refuse?: ExclusiveRefusal } = {},
  ): Promise<T> {
    this.#refuseClosed();
    const slot = this.#slot(tenant);
    while (slot.gate !== undefined) {
      if (slot.refuse !== undefined) {
        throw new TenantPoolError("busy", `the tenant is held: ${slot.refuse}`, {
          holder: slot.refuse,
        });
      }
      await slot.gate;
    }
    this.#refuseClosed();
    let release = () => {};
    slot.gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    slot.refuse = opts.refuse;
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
      slot.refuse = undefined;
      release();
    }
  }

  /**
   * For stopping: refuses uses and exclusives from now on, waits for the ones in progress, and
   * closes every tenant (writing its reads and moving its high water first); returns when all are.
   */
  async closeAll(): Promise<void> {
    this.#closed = true;
    // The uses in line get no place now.
    for (const w of this.#line.splice(0)) {
      clearTimeout(w.timer);
      w.reject(new TenantPoolError("pool_closed", "the pool is closed"));
    }
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

  #reportDiscard(tenant: TenantId, error: unknown): void {
    try {
      (this.options.onDiscardFailure ?? reportDiscardToStderr)(tenant, error);
    } catch {
      // A report that fails is not the pool's failure.
    }
  }

  #reportScratchDiscard(tenant: TenantId, error: unknown): void {
    try {
      (this.options.onScratchDiscardFailure ?? reportScratchDiscardToStderr)(tenant, error);
    } catch {
      // A report that fails is not the pool's failure.
    }
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
    slot.open = undefined;
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
    this.#settle(slot);
  }

  /** Opens the tenant as the directory routes it now, and checks that it serves. */
  async #open(tenant: TenantId): Promise<OpenTenant> {
    const { control, backend } = this.options;
    const entry = await control.tenant(tenant);
    if (entry === undefined) throw new TenantPoolError("unknown_tenant", "no such tenant");
    if (entry.state !== "active") {
      throw new TenantPoolError("tenant_creating", "the tenant's creation is not finished");
    }
    const staging = entry.staging;
    const discard = async () => {
      if (staging !== undefined) await this.options.discardStaging(tenant, staging);
    };
    await this.options.discardScratch(tenant).catch((e) => this.#reportScratchDiscard(tenant, e));
    const store = await backend.open(entry.ref, {}).catch((e: unknown) => {
      // Past the database's max_connections: as full as a pool with no place (the error carries
      // the backend's code and SQLSTATE; this package does not depend on the backend's error class).
      const { code, sqlState } = (e ?? {}) as { code?: unknown; sqlState?: unknown };
      if (code === "connection_failed" && sqlState === TOO_MANY_CONNECTIONS) {
        this.#reportFull(tenant, "database");
        throw new TenantPoolError("pool_full", "the database has no connection to give");
      }
      throw e;
    });
    try {
      const tail = await store.read((tx) => readTail(tx));
      const { decision, taken } = await takeUpImport({
        store,
        anchors: control.anchors,
        tenant,
        logEnd: tail?.seq ?? 0,
        discardStaging: discard,
      });
      if (taken !== "aborted" && staging !== undefined) {
        // No marker (any more): left by a crash before ④, or the database a swap replaced (see the
        // top of this file). Safe on every opening only because v1 runs one process per control
        // database (§7).
        await discard().catch((e) => this.#reportDiscard(tenant, e));
      }
      if (tail === undefined) throw new TenantPoolError("tenant_empty", "the tenant has no events");
      if (decision.kind !== "serve") {
        // An import's decision again, after it was taken up, is a marker that stayed.
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

/**
 * Takes up an import a crash or a failure left (02-architecture §8 «重入»), as the kernel's
 * `openTenant` decides it, on the tenant's storage as the directory routes it now: with the
 * anchor's import marker and the import's event in the log, the import is finished
 * (`finishImport`); with the marker and no event, the staging database is discarded
 * (`discardStaging`; its failure is `staging_not_discarded`) and the marker cleared
 * (`abortImportOnOpen`). Returns the decision taken again, and what was done: once `finished`, the
 * staging database the directory names is the one the swap replaced. The pool's opening and the
 * server mode's import both run it before anything else.
 */
export async function takeUpImport(o: {
  readonly store: TenantStore;
  readonly anchors: AnchorStore;
  readonly tenant: TenantId;
  /** The log's end, read from `store`. */
  readonly logEnd: number;
  readonly discardStaging: () => Promise<void>;
}): Promise<{ decision: OpenTenantDecision; taken?: "finished" | "aborted" }> {
  const decide = async () => {
    const a = await o.anchors.read(o.tenant);
    return openTenant({
      importInProgress: a.importInProgress,
      importEventInLog:
        a.importInProgress === undefined
          ? undefined
          : await o.store.read((tx) => importEventInLog(tx)),
      restoreInProgress: a.restoreInProgress,
      logEnd: o.logEnd,
      highWater: a.highWater,
    });
  };
  const decision = await decide();
  if (decision.kind === "import_finish") {
    await finishImport({
      store: o.store,
      anchor: o.anchors,
      tenant: o.tenant,
      importId: decision.importId,
    });
    return { decision: await decide(), taken: "finished" };
  }
  if (decision.kind === "import_abort") {
    await abortImportOnOpen({
      anchor: o.anchors,
      tenant: o.tenant,
      importId: decision.importId,
      discardStaging: async () => {
        try {
          await o.discardStaging();
        } catch (e) {
          throw new TenantPoolError(
            "staging_not_discarded",
            `an import's staging database was not discarded: ${codeOf(e)}`,
          );
        }
      },
    });
    return { decision: await decide(), taken: "aborted" };
  }
  return { decision };
}
