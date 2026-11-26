// The local mode's one tenant, opened when the service starts and kept open while it runs
// (docs/zh-CN/spec/02-architecture.md §5 控制面存储, §7 进程模型, §8 租户存储与锚点存储).
//
// Opening: read `control/tenant.json` for the tenant ID, drop a `log.reconcile` scratch storage a
// crash left (`<home>/tmp/reconcile/<tenant>`), open the anchor store (`control/anchor.json`)
// and the tenant storage (the caller's backend, without `create`), read the anchor and the log's
// end, and decide with the kernel's `openTenant` steps 1–3 whether the tenant serves. Reconciling
// deletion entries and running tasks that fell due come later (their place is marked below).
//
// Closing: move the high water up to the log's end (§8: before closing the tenant), then close the
// storage.
//
// The store is opened once per process and not reopened on any request path: reopening the
// database's Wasm instance in a long-running process is what the process model avoids (§7).

import { dirname } from "node:path";
import type { AnchorStore, RestorePoint, TenantStore } from "@fluxvita/saveslot-kernel";
import {
  abortImportOnOpen,
  createOpsContext,
  finishImport,
  flushReads,
  type InternalOperation,
  importEventInLog,
  type OpsContext,
  openTenant,
  readTail,
  restorePoint,
} from "@fluxvita/saveslot-kernel";
import type { TenantId, UserId } from "./control-plane.ts";
import {
  type LocalBackupOptions,
  type LocalStorageBackend,
  localBackupBeforeUpgrade,
} from "./local-backup.ts";
import {
  LocalControlPlane,
  LocalTenantError,
  type LocalTenantFailure,
  type TenantDirectory,
} from "./local-control-plane.ts";
import {
  discardLocalStaging,
  fsyncDirectory,
  removeImportLeftovers,
  repairLocalSwap,
} from "./local-import.ts";
import { discardLocalScratch } from "./reconcile.ts";

// The local control plane's files and their reading, kept importable from here.
export {
  anchorFile,
  controlDir,
  LocalControlPlane,
  LocalTenantError,
  type LocalTenantFailure,
  readTenantDirectory,
  type TenantDirectory,
  tenantFile,
} from "./local-control-plane.ts";

/** The open local tenant. */
export interface LocalTenant {
  readonly tenant: TenantId;
  readonly user: UserId;
  readonly store: TenantStore;
  readonly anchor: AnchorStore;
  /** The data directory the tenant was opened from. */
  readonly dataDir: string;
  /**
   * The restore count and point when it was opened: an import or a restore opens the tenant again,
   * so a request that began before one sees another here when it is served.
   */
  readonly restorePoint: RestorePoint;
}

export type OpenLocalTenantResult =
  | { readonly ok: true; readonly tenant: LocalTenant }
  /** The storage is closed again; nothing of the tenant serves. */
  | { readonly ok: false; readonly failure: LocalTenantFailure };

/**
 * Opens the local tenant, in the data directory the tenant directory records, and decides whether
 * it serves. The storage is opened without `create`: a data directory that is gone, or holds no
 * storage, stops the service (`store_not_found`, thrown as the backend throws it) and nothing is
 * made in its place; storage without the tenant's genesis stops it as `tenant_empty`. Other errors
 * of the storage itself (locked, another format version, durability not applied) are thrown as
 * the backend throws them.
 */
export async function openLocalTenant(o: {
  readonly home: string;
  readonly backend: LocalStorageBackend;
  /**
   * The backup before a format upgrade (local-backup.ts): made unless `skip`; what it does goes to
   * `onEvent`.
   */
  readonly backup?: Omit<LocalBackupOptions, "home">;
  /** Told when an import's leftover next to the data directory could not be removed. */
  readonly onLeftover?: (path: string, error: unknown) => void;
  /** @internal Tests only: fsyncs a directory (`fsyncDirectory` otherwise). */
  readonly fsyncDir?: (path: string) => void;
}): Promise<OpenLocalTenantResult> {
  const fsyncDir = o.fsyncDir ?? fsyncDirectory;
  const control = new LocalControlPlane(o.home);
  let dir: TenantDirectory;
  try {
    dir = await control.directory();
  } catch (e) {
    if (e instanceof LocalTenantError) return { ok: false, failure: e.code };
    throw e;
  }
  const anchor = control.anchors;
  // Killed between an import's two renames: the second one finished first (local-import.ts).
  repairLocalSwap(dir.dataDir, (await anchor.read(dir.tenant)).importInProgress, fsyncDir);
  const store = await o.backend.open(
    { kind: "pglite", dir: dir.dataDir },
    { beforeUpgrade: localBackupBeforeUpgrade({ ...o.backup, home: o.home }) },
  );
  try {
    // A `log.reconcile` scratch storage a crash left (02-architecture §3). Only once the store is
    // open, so this process holds the home's one writer: another process opening the same home is
    // refused there, and never deletes the scratch storage from under a run of the one that holds
    // it. No run is going on in this process yet.
    await discardLocalScratch(o.home, dir.tenant);
    const [tail, first] = await Promise.all([
      store.read((tx) => readTail(tx)),
      anchor.read(dir.tenant),
    ]);
    if (tail === undefined) {
      await store.close();
      return { ok: false, failure: "tenant_empty" };
    }
    let a = first;
    // The import's re-entry (§8 «重入»): with its event in the log the swap happened, and the
    // import is finished; without it, the staging directory goes and the marker is cleared.
    if (a.importInProgress !== undefined) {
      const importId = a.importInProgress;
      const decision = await openTenant({
        importInProgress: importId,
        importEventInLog: await store.read((tx) => importEventInLog(tx)),
        restoreInProgress: a.restoreInProgress,
        logEnd: tail.seq,
        highWater: a.highWater,
      });
      if (decision.kind === "import_finish") {
        // The swap's renames durable before ⑥ (§8), whether this opening renamed or the import
        // was stopped after its renames and before its own fsync.
        fsyncDir(dirname(dir.dataDir));
        await finishImport({ store, anchor, tenant: dir.tenant, importId });
      } else if (decision.kind === "import_abort") {
        await abortImportOnOpen({
          anchor,
          tenant: dir.tenant,
          importId,
          discardStaging: async () => discardLocalStaging(dir.dataDir, importId),
        });
      }
      a = await anchor.read(dir.tenant);
    }
    const end = (await store.read((tx) => readTail(tx)))?.seq ?? tail.seq;
    const decision = await openTenant({
      importInProgress: a.importInProgress,
      restoreInProgress: a.restoreInProgress,
      logEnd: end,
      highWater: a.highWater,
    });
    if (decision.kind !== "serve") {
      await store.close();
      return {
        ok: false,
        failure: decision.kind === "not_implemented" ? decision.what : "import_in_progress",
      };
    }
    // What imports left next to the data directory, now that none is in progress.
    removeImportLeftovers(dir.dataDir, undefined, o.onLeftover);
    // `openTenant` steps 4 and 5 (reconcile deletion entries with the log, run tasks that fell
    // due) come here with the deletion flows.
    const point = await store.read((tx) => restorePoint(tx));
    return {
      ok: true,
      tenant: {
        tenant: dir.tenant,
        user: dir.user,
        store,
        anchor,
        dataDir: dir.dataDir,
        restorePoint: point,
      },
    };
  } catch (e) {
    await store.close().catch(() => {});
    throw e;
  }
}

/** The context of an operation the local user session calls, with the idempotency windows given. */
export function localUserContext(
  t: LocalTenant,
  o: {
    readonly now: string;
    readonly task?: string | null;
    readonly windows?: { readonly requestKey: number; readonly idempotencyKey: number };
  },
): OpsContext {
  return createOpsContext({
    tenant: t.tenant,
    actor: t.user,
    trigger: null,
    task: o.task ?? null,
    visibility: { kind: "all" },
    idempotency_window: o.windows?.requestKey ?? 86_400_000,
    idempotency_key_window: o.windows?.idempotencyKey ?? 86_400_000,
    now: o.now,
    confirmation: null,
  });
}

/** The context of a local internal operation: `system`, the task's name, the time given. */
function systemContext(
  t: Pick<LocalTenant, "tenant">,
  trigger: InternalOperation,
  now: string,
): OpsContext {
  return createOpsContext({
    tenant: t.tenant,
    actor: "system",
    trigger,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 0,
    idempotency_key_window: 0,
    now,
    confirmation: null,
  });
}

/** The tenant's log end: the newest event's seq and recorded time; undefined for an empty log. */
export async function localLogEnd(
  t: LocalTenant,
): Promise<{ readonly seq: number; readonly at: string } | undefined> {
  const tail = await t.store.read((tx) => readTail(tx));
  return tail === undefined ? undefined : { seq: tail.seq, at: tail.at };
}

/** Writes the tenant's buffered reads (the internal operation `flushReads`); how many were written. */
export async function flushLocalReads(
  t: LocalTenant,
  now: string = new Date().toISOString(),
): Promise<number> {
  return (await flushReads(t.store, systemContext(t, "flushReads", now))).flushed;
}

/**
 * Closes the tenant (`closeTenant`, 02-architecture §4): writes the buffered reads, moves the high
 * water up to the log's end, then closes the storage. Both first steps are best-effort (the high
 * water never decides whether a write succeeded, §8; a read lost is within the loss window, §7): a
 * failure is returned for the caller to log, and the storage closes regardless.
 */
export async function closeLocalTenant(
  // No data directory or restore point: a server tenant is closed here too (tenant-pool.ts).
  t: Pick<LocalTenant, "tenant" | "user" | "store" | "anchor">,
  now: string = new Date().toISOString(),
): Promise<{ readsError?: unknown; highWaterError?: unknown }> {
  let readsError: unknown;
  try {
    await flushReads(t.store, systemContext(t, "closeTenant", now));
  } catch (e) {
    readsError = e;
  }
  let highWaterError: unknown;
  try {
    const tail = await t.store.read((tx) => readTail(tx));
    if (tail !== undefined) await t.anchor.advanceHighWater(t.tenant, tail.seq);
  } catch (e) {
    highWaterError = e;
  }
  await t.store.close();
  return {
    ...(readsError === undefined ? {} : { readsError }),
    ...(highWaterError === undefined ? {} : { highWaterError }),
  };
}

/** A read that touches the storage's worker: fails once the worker is gone. */
export async function probeLocalTenant(t: LocalTenant): Promise<void> {
  await t.store.read((tx) => tx.query("SELECT 1"));
}
