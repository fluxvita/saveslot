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
} from "@fluxvita/saveslot-kernel";
import { PgliteStoreError } from "./errors.ts";
import { fsyncPath, fsyncTree } from "./fsutil.ts";
import { type DirLock, type DirLockHandle, osFileLock } from "./lock.ts";
import { newToken, readOwnerToken, writeOwner } from "./owner.ts";
import type {
  Durability,
  Envelope,
  HostSyncStats,
  OpenResult,
  QueryReply,
  Reply,
  Request,
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
}

const WORKER_URL = new URL(
  `./db-worker${import.meta.url.endsWith(".ts") ? ".ts" : ".js"}`,
  import.meta.url,
);

function fromWire(e: WireError): Error {
  if (e.code) return new PgliteStoreError(e.code, e.message);
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

  constructor(opts: PgliteBackendOptions = {}) {
    this.#durability = opts.durability ?? "host-fsync";
    this.#lock = opts.lock ?? osFileLock;
    this.#contrib = opts.contrib ?? [];
  }

  async open(
    tenant: TenantRef,
    opts: { readonly create?: boolean } = {},
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
      const r = await worker.call<OpenResult>({
        kind: "open",
        params: {
          pgdata,
          durability: this.#durability,
          sessionSettings: SESSION_SETTINGS,
          supportedFormat: STORAGE_FORMAT_VERSION,
          metaKeys: META_KEYS,
          contrib: this.#contrib,
        },
      });
      writeOwner(dir, { token, startedAt, epoch: r.epoch });
      return new PgliteTenantStore({ dir, token, worker, lock, ...r });
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
      params: {
        pgdata: creating,
        durability: this.#durability,
        sessionSettings: SESSION_SETTINGS,
        ddl: formatV1Ddl(),
        metaRows: [
          [META_KEYS.storageFormat, String(STORAGE_FORMAT_VERSION)],
          [META_KEYS.ownershipEpoch, "0"],
          [META_KEYS.sessionSettings, JSON.stringify(SESSION_SETTINGS)],
        ],
      },
    });
    // PGlite copies initdb's result into the directory without syncing it; sync it all here.
    fsyncTree(creating);
    renameSync(creating, join(dir, PGDATA_DIR));
    fsyncPath(dir);
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
  #state: State = "open";
  #tail: Promise<unknown> = Promise.resolve();
  #closed: Promise<void> | undefined;

  constructor(init: {
    dir: string;
    token: string;
    worker: WorkerClient;
    lock: DirLockHandle;
    formatVersion: number;
    epoch: number;
  }) {
    this.dir = init.dir;
    this.#token = init.token;
    this.#worker = init.worker;
    this.#lock = init.lock;
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

  async purgeResidue(): Promise<void> {
    throw new Error("purgeResidue is not implemented in v1 P0: its method is set by experiment 7");
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
    return result;
  }
}
