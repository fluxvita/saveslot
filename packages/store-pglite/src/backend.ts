// PGlite implementation of the tenant storage port (02-architecture §7, §8).
//
// Directory layout of a tenant `dir`:
//   saveslot.lock    single-writer lock (lock.ts)
//   saveslot.owner   current opener's token and ownership epoch (owner.ts)
//   pgdata/          the PGlite data directory
//   pgdata.creating/ only while a new storage is being created; moved to pgdata/ when complete
//
// Threads: the PGlite instance lives in a dedicated DB Worker (db-worker.ts). This class runs on
// the caller's thread and keeps one FIFO queue per store: reads and writes take turns in it, so
// exactly one transaction is open at a time. A transaction callback runs here; each `tx.query` /
// `tx.exec` is one message to the worker's transaction session; when the callback returns the
// store sends COMMIT, when it throws the store sends ROLLBACK and rethrows.

import { existsSync, mkdirSync, renameSync, rmSync } from "node:fs";
import { join, resolve } from "node:path";
import { Worker } from "node:worker_threads";
import {
  formatV1Ddl,
  META_KEYS,
  OLDEST_UPGRADABLE_FORMAT,
  type PurgeOutcome,
  type QueryResult,
  type ReadTx,
  SESSION_SETTINGS,
  type SnapshotRef,
  type SqlValue,
  STORAGE_FORMAT_VERSION,
  type StorageBackend,
  type TenantRef,
  type TenantStore,
  type Tx,
  UPGRADE_STEPS,
  type UpgradeStep,
} from "@fluxvita/saveslot-kernel";
import { PgliteStoreError } from "./errors.ts";
import { fsyncPath, fsyncTree } from "./fsutil.ts";
import { type DirLock, type DirLockHandle, osFileLock } from "./lock.ts";
import { newToken, readOwnerToken, writeOwner } from "./owner.ts";
import type {
  AnalyzeMode,
  AnalyzeReply,
  CreateParams,
  Durability,
  Envelope,
  HostSyncStats,
  MaintainReply,
  MaintainStep,
  OpenResult,
  QueryReply,
  Reply,
  Request,
  UpgradeReply,
  WireError,
} from "./protocol.ts";

export const PGDATA_DIR = "pgdata";
const CREATING_DIR = "pgdata.creating";

export interface PgliteBackendOptions {
  /**
   * How commits reach stable storage. "host-fsync" (default) is the configuration under test in
   * experiment 1, group B; "pglite-default" is PGlite's own default (fsync off), group A, and is
   * for experiments and tests only. See durability.ts.
   */
  readonly durability?: Durability;
  /** Single-writer lock. Default: the operating-system file lock chosen by experiment 8. */
  readonly lock?: DirLock;
  /** PGlite contrib extensions to load (e.g. "amcheck"); diagnostics and experiments only. */
  readonly contrib?: readonly string[];
  /**
   * WAL since the last checkpoint, in bytes, past which a write is followed by a checkpoint
   * (db-worker.ts `checkpoint`). Default 64 MiB; lower in tests.
   */
  readonly checkpointAfterBytes?: number;
  /**
   * When the planner's statistics are gathered, at open and after each write: when they are stale
   * (default), or every time ("always": tests looking for a query whose order is not fixed).
   */
  readonly analyze?: AnalyzeMode;
  /**
   * Tests only: the residue clean-up's steps as sent, given the steps it would send (a test leaves
   * one out to show that the deleted text is then still on disk).
   */
  readonly purgeSteps?: (steps: readonly MaintainStep[]) => readonly MaintainStep[];
  /**
   * Tests only: the format this backend takes for the kernel's, and the upgrade steps to it, in
   * place of STORAGE_FORMAT_VERSION and UPGRADE_STEPS (a test's own format, steps and failures).
   */
  readonly formatUpgrade?: {
    readonly format: number;
    readonly steps: readonly UpgradeStep[];
    /** Awaited before each step, once `upgrade_step` is told: holds a step where a test wants it. */
    readonly beforeStep?: (from: number) => Promise<void>;
  };
  /**
   * Where the store reports what it does on its own, outside any call (never a path): a
   * checkpoint that failed (`checkpoint_failed`, the error's code), and the statistics gathered
   * (`analyzed`, how long, at open or after a write) or not (`analyze_failed`, the code). The
   * service writes them to its log.
   */
  readonly onEvent?: (event: StoreEvent, fields: Readonly<Record<string, string | number>>) => void;
}

/** See PgliteBackendOptions `onEvent`. */
export type StoreEvent =
  | "checkpoint_failed"
  | "purge_failed"
  | "analyzed"
  | "analyze_failed"
  | "upgrading"
  | "upgrade_step"
  | "upgrade_backup"
  | "upgraded";

/**
 * What a local store is, just before its format is upgraded (see `BeforeUpgrade`): its tenant
 * directory, the formats, and the two ends of what it holds that only grow, as they are now.
 */
export interface UpgradeAhead {
  readonly dir: string;
  readonly from: number;
  readonly to: number;
  readonly marks: {
    /** The log's last event: its `seq` and its header hash (null for an empty log). */
    readonly logEnd: { readonly seq: number; readonly hash: string } | null;
    /** The largest `n` of `read_log` (null when nothing was read). */
    readonly readsEnd: number | null;
  };
}

/**
 * Called when an opened store is of an older format, before any step: with PGlite shut down and
 * the directory's lock still held, so that the directory can be copied as it is and nobody writes
 * it meanwhile. When it throws, the open fails with `upgrade_failed` (its error the cause) and
 * the store stays of its format; when it returns, the store is opened again and upgraded.
 */
export type BeforeUpgrade = (ahead: UpgradeAhead) => Promise<void>;

/** The default of `checkpointAfterBytes`: about what `max_wal_size` keeps (durability.ts). */
export const CHECKPOINT_AFTER_BYTES = 64 * 1024 * 1024;

const WORKER_URL = new URL(
  `./db-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

function fromWire(e: WireError): Error {
  if (e.code) {
    return new PgliteStoreError(
      e.code,
      e.message,
      e.sqlState !== undefined ? { sqlState: e.sqlState } : {},
    );
  }
  if (e.sqlState) return new PgliteStoreError("query_failed", e.message, { sqlState: e.sqlState });
  return new Error(e.message);
}

/** Talks to one DB Worker. */
class WorkerClient {
  readonly #worker: Worker;
  readonly #pending = new Map<
    number,
    { resolve: (v: unknown) => void; reject: (e: Error) => void }
  >();
  #nextId = 1;
  #dead: Error | undefined;

  constructor() {
    this.#worker = new Worker(WORKER_URL);
    const fail = (err: Error) => {
      if (this.#dead) return;
      this.#dead = err;
      for (const p of this.#pending.values()) p.reject(err);
      this.#pending.clear();
    };
    this.#worker.on("message", (r: Reply) => {
      const p = this.#pending.get(r.id);
      if (!p) return;
      this.#pending.delete(r.id);
      if (r.ok) p.resolve(r.value);
      else p.reject(fromWire(r.error));
    });
    this.#worker.on("error", (e) =>
      fail(
        new PgliteStoreError("worker_failed", `the DB Worker failed: ${e.message}`, { cause: e }),
      ),
    );
    this.#worker.on("exit", (code) =>
      fail(new PgliteStoreError("worker_failed", `the DB Worker exited (code ${code})`)),
    );
  }

  get dead(): boolean {
    return this.#dead !== undefined;
  }

  call<T>(request: Request): Promise<T> {
    if (this.#dead) return Promise.reject(this.#dead);
    const id = this.#nextId++;
    return new Promise<T>((resolve, reject) => {
      this.#pending.set(id, { resolve: resolve as (v: unknown) => void, reject });
      this.#worker.postMessage({ id, request } satisfies Envelope);
    });
  }

  /** Stops the worker at once. PGlite is not shut down: like a crash, nothing more is written. */
  async terminate(): Promise<void> {
    await this.#worker.terminate();
  }
}

export class PgliteBackend implements StorageBackend {
  readonly #durability: Durability;
  readonly #lock: DirLock;
  readonly #contrib: readonly string[];
  readonly #checkpointAfterBytes: number;
  readonly #analyze: AnalyzeMode;
  readonly #format: number;
  readonly #upgradeSteps: readonly UpgradeStep[];
  readonly #beforeStep: ((from: number) => Promise<void>) | undefined;
  readonly #onEvent: PgliteBackendOptions["onEvent"];
  readonly #purgeSteps: PgliteBackendOptions["purgeSteps"];

  constructor(opts: PgliteBackendOptions = {}) {
    this.#durability = opts.durability ?? "host-fsync";
    this.#lock = opts.lock ?? osFileLock;
    this.#contrib = opts.contrib ?? [];
    this.#checkpointAfterBytes = opts.checkpointAfterBytes ?? CHECKPOINT_AFTER_BYTES;
    this.#analyze = opts.analyze ?? "stale";
    this.#format = opts.formatUpgrade?.format ?? STORAGE_FORMAT_VERSION;
    this.#upgradeSteps = opts.formatUpgrade?.steps ?? UPGRADE_STEPS;
    this.#beforeStep = opts.formatUpgrade?.beforeStep;
    this.#onEvent = opts.onEvent;
    this.#purgeSteps = opts.purgeSteps;
  }

  async open(
    tenant: TenantRef,
    opts: { readonly create?: boolean; readonly beforeUpgrade?: BeforeUpgrade } = {},
  ): Promise<PgliteTenantStore> {
    if (tenant.kind !== "pglite") {
      throw new TypeError(`PgliteBackend cannot open a ${tenant.kind} tenant`);
    }
    const dir = resolve(tenant.dir);
    if (opts.create) mkdirSync(dir, { recursive: true });
    else if (!existsSync(dir)) {
      throw new PgliteStoreError("store_not_found", `no storage at ${dir}`);
    }

    const lock = await this.#lock.acquire(dir);
    let worker: WorkerClient | undefined;
    try {
      const token = newToken();
      const startedAt = new Date().toISOString();
      // Name the new owner before touching the database, so that an opener that lost the lock
      // sees the takeover at its next check.
      writeOwner(dir, { token, startedAt, epoch: null });

      const pgdata = join(dir, PGDATA_DIR);
      worker = new WorkerClient();
      if (!existsSync(join(pgdata, "PG_VERSION"))) {
        if (existsSync(pgdata)) {
          throw new PgliteStoreError(
            "not_a_store",
            `${pgdata} exists but is not a PGlite database`,
          );
        }
        if (!opts.create) throw new PgliteStoreError("store_not_found", `no storage at ${dir}`);
        await this.#create(worker, dir);
      }
      const openParams = {
        pgdata,
        durability: this.#durability,
        sessionSettings: SESSION_SETTINGS,
        supportedFormat: this.#format,
        oldestFormat: OLDEST_UPGRADABLE_FORMAT,
        upgradeSteps: this.#upgradeSteps,
        metaKeys: META_KEYS,
        contrib: this.#contrib,
        checkpointAfterBytes: this.#checkpointAfterBytes,
        analyze: this.#analyze,
      };
      let r = await worker.call<OpenResult>({ kind: "open", params: openParams });
      reportAnalyzed(this.#onEvent, "open", r.analyzed);
      writeOwner(dir, { token, startedAt, epoch: r.epoch });
      let formatVersion = r.formatVersion;
      if (r.upgrade !== undefined) {
        // An older format: upgraded now, before the store is returned (and the service ready).
        // Under the directory's lock, owned: no other process writes it meanwhile.
        this.#onEvent?.("upgrading", { from: r.upgrade.from, to: r.upgrade.to });
        if (opts.beforeUpgrade !== undefined) {
          const { from, to } = r.upgrade;
          const marks = await readMarks(worker, r.epoch);
          // PGlite shut down cleanly (a checkpoint, nothing left in the WAL to replay), the
          // directory's lock kept: what the caller copies is the store as it is.
          await worker.call({ kind: "close" });
          await worker.terminate();
          worker = undefined;
          this.#onEvent?.("upgrade_backup", { from, to });
          try {
            await opts.beforeUpgrade({ dir, from, to, marks });
          } catch (e) {
            throw new PgliteStoreError(
              "upgrade_failed",
              `before upgrading storage format ${from} to ${to}: ${(e as Error).message}`,
              { cause: e },
            );
          }
          worker = new WorkerClient();
          r = await worker.call<OpenResult>({ kind: "open", params: openParams });
          writeOwner(dir, { token, startedAt, epoch: r.epoch });
          formatVersion = r.formatVersion;
          if (r.upgrade === undefined || r.upgrade.from !== from || r.upgrade.to !== to) {
            // Not possible under the lock held throughout; refused rather than upgraded unseen.
            throw new PgliteStoreError(
              "upgrade_failed",
              `the storage changed format while it was closed for the upgrade (from ${from})`,
            );
          }
        }
        const begun = performance.now();
        let analyzed: UpgradeReply["analyzed"];
        const target = r.upgrade.to;
        while (formatVersion < target) {
          this.#onEvent?.("upgrade_step", { from: formatVersion, to: formatVersion + 1 });
          await this.#beforeStep?.(formatVersion);
          const u = await worker.call<UpgradeReply>({ kind: "upgrade" });
          formatVersion = u.formatVersion;
          analyzed = u.analyzed;
        }
        this.#onEvent?.("upgraded", {
          from: r.upgrade.from,
          to: formatVersion,
          ms: Math.round(performance.now() - begun),
        });
        if (analyzed !== undefined) reportAnalyzed(this.#onEvent, "upgrade", analyzed);
      }
      return new PgliteTenantStore({
        dir,
        token,
        worker,
        lock,
        onEvent: this.#onEvent,
        purgeSteps: this.#purgeSteps,
        epoch: r.epoch,
        formatVersion,
      });
    } catch (e) {
      await worker?.terminate();
      await lock.release();
      throw e;
    }
  }

  /** Creates the storage in a scratch directory and moves it into place once complete. */
  async #create(worker: WorkerClient, dir: string): Promise<void> {
    const creating = join(dir, CREATING_DIR);
    rmSync(creating, { recursive: true, force: true });
    await worker.call({
      kind: "create",
      params: { pgdata: creating, ...creation(this.#durability, this.#format) },
    });
    // PGlite copies initdb's result into the directory without syncing it; sync it all here.
    fsyncTree(creating);
    renameSync(creating, join(dir, PGDATA_DIR));
    fsyncPath(dir);
  }
}

/** The two ends `UpgradeAhead` gives, read in one read transaction of the worker just opened. */
async function readMarks(worker: WorkerClient, epoch: number): Promise<UpgradeAhead["marks"]> {
  await worker.call({ kind: "begin", mode: "read", epoch });
  try {
    const log = await worker.call<QueryReply>({
      kind: "query",
      sql: "SELECT seq, header_hash FROM events ORDER BY seq DESC LIMIT 1",
      params: [],
    });
    const reads = await worker.call<QueryReply>({
      kind: "query",
      sql: "SELECT max(n) AS n FROM read_log",
      params: [],
    });
    const last = log.rows[0];
    const n = reads.rows[0]?.["n"];
    return {
      logEnd:
        last === undefined ? null : { seq: Number(last["seq"]), hash: String(last["header_hash"]) },
      readsEnd: n === null || n === undefined ? null : Number(n),
    };
  } finally {
    await worker.call({ kind: "commit" });
  }
}

/**
 * What a new storage is made from, but for where: the same for every storage made with one
 * durability. Whatever changes what a new storage holds is in here.
 */
export function creation(
  durability: Durability,
  format: number = STORAGE_FORMAT_VERSION,
): Omit<CreateParams, "pgdata"> {
  return {
    durability,
    sessionSettings: SESSION_SETTINGS,
    ddl: formatV1Ddl(),
    metaRows: [
      [META_KEYS.storageFormat, String(format)],
      [META_KEYS.ownershipEpoch, "0"],
      [META_KEYS.sessionSettings, JSON.stringify(SESSION_SETTINGS)],
    ],
  };
}

/**
 * Makes a new storage's data directory at `pgdata` (its parent there already), as opening with
 * `create` makes it, and nothing else: no lock, no owner, not opened, not synced to the host. For the test backend, which copies
 * one into each storage a test creates.
 */
export async function createPgdata(pgdata: string, durability: Durability): Promise<void> {
  const worker = new WorkerClient();
  try {
    await worker.call({ kind: "create", params: { pgdata, ...creation(durability) } });
  } finally {
    await worker.terminate();
  }
}

type State = "open" | "closing" | "closed" | "lost" | "failed";

class TxHandle implements Tx {
  readonly #store: PgliteTenantStore;
  #active = true;

  constructor(store: PgliteTenantStore) {
    this.#store = store;
  }

  end(): void {
    this.#active = false;
  }

  #check(): void {
    if (!this.#active) throw new Error("the transaction has already finished");
  }

  async query<R = Record<string, unknown>>(
    sql: string,
    params: readonly SqlValue[] = [],
  ): Promise<QueryResult<R>> {
    this.#check();
    const r = await this.#store._call<QueryReply>({ kind: "query", sql, params });
    return r as unknown as QueryResult<R>;
  }

  async exec(sql: string): Promise<void> {
    this.#check();
    await this.#store._call({ kind: "exec", sql });
  }
}

export class PgliteTenantStore implements TenantStore {
  readonly formatVersion: number;
  /** The ownership epoch this store took at open. */
  readonly epoch: number;
  readonly dir: string;
  readonly #token: string;
  readonly #worker: WorkerClient;
  readonly #lock: DirLockHandle;
  readonly #onEvent: PgliteBackendOptions["onEvent"];
  readonly #purgeSteps: PgliteBackendOptions["purgeSteps"];
  #state: State = "open";
  #tail: Promise<unknown> = Promise.resolve();
  #closed: Promise<void> | undefined;

  constructor(init: {
    dir: string;
    token: string;
    worker: WorkerClient;
    lock: DirLockHandle;
    onEvent: PgliteBackendOptions["onEvent"];
    purgeSteps?: PgliteBackendOptions["purgeSteps"];
    formatVersion: number;
    epoch: number;
  }) {
    this.#purgeSteps = init.purgeSteps;
    this.dir = init.dir;
    this.#token = init.token;
    this.#worker = init.worker;
    this.#lock = init.lock;
    this.#onEvent = init.onEvent;
    this.formatVersion = init.formatVersion;
    this.epoch = init.epoch;
  }

  /** @internal Used by TxHandle. */
  _call<T>(request: Request): Promise<T> {
    return this.#worker.call<T>(request).catch((e: unknown) => {
      if (e instanceof PgliteStoreError) {
        if (e.code === "ownership_lost") this.#abandon();
        else if (e.code === "worker_failed") this.#state = "failed";
      }
      throw e;
    });
  }

  write<T>(fn: (tx: Tx) => Promise<T>): Promise<T> {
    return this.#enqueue(() => this.#transaction("write", fn));
  }

  read<T>(fn: (tx: ReadTx) => Promise<T>): Promise<T> {
    return this.#enqueue(() => this.#transaction("read", fn));
  }

  /**
   * The in-place residue clean-up (02-architecture §7 «残留清理的做法»; the kernel port's
   * `purgeResidue`): each of `tables` rewritten, ANALYZE, the statistics rewritten, then the
   * write-ahead log (two checkpoints around a segment switch, and one more), and the check. Each
   * step is one request through the store's queue, so writes may come between two of them (what
   * they write holds no deleted text); before each, the owner is checked, as before a checkpoint.
   * There is no other session to wait for here (single-user mode). A name that is not one of the
   * store's tables is refused before any step runs. A step that fails ends the worker
   * (`worker_failed`): the instance may be broken, as after a failed checkpoint.
   */
  async purgeResidue(tables: readonly string[]): Promise<PurgeOutcome> {
    const names = [...new Set(tables)].sort();
    const known = new Set(
      await this.read(async (tx) =>
        (
          await tx.query<{ name: string }>(
            "SELECT relname AS name FROM pg_class WHERE relnamespace = 'public'::regnamespace AND relkind = 'r'",
          )
        ).rows.map((r) => r.name),
      ),
    );
    const unknown = names.filter((t) => !known.has(t));
    if (unknown.length > 0) {
      throw new Error(`purgeResidue: not tables of this store: ${unknown.join(", ")}`);
    }
    const steps: MaintainStep[] = [
      ...names.map((table) => ({ op: "rewrite" as const, table })),
      { op: "analyze" },
      { op: "rewrite_statistics" },
      { op: "checkpoint" },
      { op: "switch_wal" },
      { op: "checkpoint" },
      { op: "checkpoint" },
      { op: "check" },
    ];
    let last: MaintainReply = {};
    for (const step of this.#purgeSteps?.(steps) ?? steps)
      last = await this.#enqueue(() => this.#maintain(step));
    return last.notRemovable === 0 ? { ok: true } : { ok: false, why: "dead_not_removable" };
  }

  async snapshot(): Promise<SnapshotRef> {
    throw new Error("snapshot is not implemented: physical snapshots are not in v1");
  }

  /** fsync requests that reached the host so far (durability "host-fsync"). */
  hostSyncStats(): Promise<HostSyncStats> {
    return this._call<HostSyncStats>({ kind: "stats" });
  }

  /**
   * Stops the DB Worker at once, like a crash: PGlite is not shut down. The store becomes
   * unusable; `close()` then only releases the lock. For experiments (worker termination) and,
   * later, the timeout policy decided by experiment 2.
   */
  async terminateWorker(): Promise<void> {
    if (this.#state === "open") this.#state = "failed";
    await this.#worker.terminate();
  }

  close(): Promise<void> {
    if (this.#closed) return this.#closed;
    const wasOpen = this.#state === "open";
    if (wasOpen) this.#state = "closing";
    this.#closed = this.#tail
      .catch(() => {})
      .then(async () => {
        try {
          if (wasOpen && !this.#worker.dead) await this.#worker.call({ kind: "close" });
        } finally {
          await this.#worker.terminate();
          const lost = this.#state === "lost";
          if (!lost) this.#state = "closed";
          await this.#lock.release({ lost });
        }
      });
    return this.#closed;
  }

  #enqueue<T>(job: () => Promise<T>): Promise<T> {
    const run = this.#tail.then(job, job);
    this.#tail = run.catch(() => {});
    return run;
  }

  #ensureUsable(): void {
    switch (this.#state) {
      case "open":
        return;
      case "lost":
        throw new PgliteStoreError(
          "ownership_lost",
          "another opener took over this storage; this store gave it up",
        );
      case "failed":
        throw new PgliteStoreError("worker_failed", "the DB Worker has stopped; close the store");
      default:
        throw new PgliteStoreError("store_closed", "the store is closed");
    }
  }

  /** Gives the tenant up without touching the database again (02-architecture §7). */
  #abandon(): void {
    if (this.#state === "lost") return;
    this.#state = "lost";
    // No graceful close: a shutdown checkpoint would write pages over the new owner's database.
    void this.#worker.terminate();
  }

  #checkOwner(): void {
    if (readOwnerToken(this.dir) !== this.#token) {
      this.#abandon();
      throw new PgliteStoreError(
        "ownership_lost",
        `another opener took over the storage at ${this.dir}; this store gave it up`,
      );
    }
  }

  async #transaction<T>(mode: "read" | "write", fn: (tx: Tx) => Promise<T>): Promise<T> {
    this.#ensureUsable();
    if (mode === "write") this.#checkOwner();
    await this._call({ kind: "begin", mode, epoch: this.epoch });
    const tx = new TxHandle(this);
    let result: T;
    try {
      result = await fn(tx);
    } catch (e) {
      tx.end();
      if (this.#state === "open") await this._call({ kind: "rollback" }).catch(() => {});
      throw e;
    }
    tx.end();
    if (mode === "write") this.#checkOwner();
    await this._call({ kind: "commit" });
    // Queued behind this write, so the write's caller has its result before the checkpoint runs;
    // then the statistics, when stale, outside any transaction.
    if (mode === "write") {
      void this.#enqueue(() => this.#checkpoint()).catch(() => {});
      void this.#enqueue(() => this.#gatherStatistics()).catch(() => {});
    }
    return result;
  }

  /**
   * A checkpoint after a write, when the WAL since the last one is past the threshold (db-worker.ts
   * `checkpoint`). The owner is checked first: an instance that lost the storage must not write
   * its pages into the new owner's directory (02-architecture §7). A checkpoint that fails may
   * leave the instance broken (a failed fsync is a PANIC), so the worker is ended and the store is
   * failed, as when the worker dies; what was committed is on disk already.
   */
  async #checkpoint(): Promise<void> {
    if (this.#state !== "open") return;
    this.#checkOwner();
    try {
      await this.#worker.call({ kind: "checkpoint" });
    } catch (e) {
      const code = e instanceof PgliteStoreError ? (e.sqlState ?? e.code) : "unknown";
      this.#onEvent?.("checkpoint_failed", { code });
      if (this.#state === "open") this.#state = "failed";
      await this.#worker.terminate();
    }
  }

  /** One step of `purgeResidue`, the owner checked first; one that fails ends the worker. */
  async #maintain(step: MaintainStep): Promise<MaintainReply> {
    this.#ensureUsable();
    this.#checkOwner();
    try {
      return await this.#worker.call<MaintainReply>({ kind: "maintain", step });
    } catch (e) {
      const code = e instanceof PgliteStoreError ? (e.sqlState ?? e.code) : "unknown";
      this.#onEvent?.("purge_failed", { step: step.op, code });
      if (this.#state === "open") this.#state = "failed";
      await this.#worker.terminate();
      throw new PgliteStoreError("worker_failed", `the residue clean-up failed at ${step.op}`, {
        cause: e,
      });
    }
  }

  /**
   * The planner's statistics after a write, when stale (db-worker.ts `analyze`). The owner is
   * checked first, as for a checkpoint: ANALYZE writes pages. A failure, an interruption
   * included, is reported and nothing else: the write is committed, statistics are not data, and
   * the next check finds them stale again. A worker that died is failed by `_call`, as anywhere.
   */
  async #gatherStatistics(): Promise<void> {
    if (this.#state !== "open") return;
    this.#checkOwner();
    let r: AnalyzeReply | { readonly failed: string };
    try {
      r = await this._call<AnalyzeReply>({ kind: "analyze" });
    } catch (e) {
      r = {
        failed: e instanceof PgliteStoreError ? (e.sqlState ?? e.code) : "unknown",
      };
    }
    reportAnalyzed(this.#onEvent, "write", r);
  }
}

/** Reports an ANALYZE (`at` open or after a write) that ran or failed; nothing when none was due. */
function reportAnalyzed(
  onEvent: PgliteBackendOptions["onEvent"],
  at: "open" | "write" | "upgrade",
  r: AnalyzeReply | { readonly failed: string },
): void {
  if ("failed" in r) onEvent?.("analyze_failed", { at, code: r.failed });
  else if (r.ran) onEvent?.("analyzed", { at, ms: r.ms });
}
