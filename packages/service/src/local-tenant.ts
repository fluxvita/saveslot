// The local mode's one tenant, opened when the service starts and kept open while it runs
// (docs/zh-CN/spec/02-architecture.md §5 控制面存储, §7 进程模型, §8 租户存储与锚点存储).
//
// Opening: read `control/tenant.json` for the tenant ID, open the anchor store (`control/anchor.json`)
// and the tenant storage (the caller's backend, without `create`), read the anchor and the log's
// end, and decide with the kernel's `openTenant` steps 1–3 whether the tenant serves. Reconciling
// deletion entries and running tasks that fell due come later (their place is marked below).
//
// Closing: move the high water up to the log's end (§8: before closing the tenant), then close the
// storage.
//
// The store is opened once per process and not reopened on any request path: reopening the
// database's Wasm instance in a long-running process is what the process model avoids (§7).

import type { AnchorStore, StorageBackend, TenantStore } from "@fluxvita/saveslot-kernel";
import {
  createOpsContext,
  flushReads,
  type InternalOperation,
  type OpsContext,
  openTenant,
  readTail,
} from "@fluxvita/saveslot-kernel";
import type { TenantId, UserId } from "./control-plane.ts";
import {
  LocalControlPlane,
  LocalTenantError,
  type LocalTenantFailure,
  type TenantDirectory,
} from "./local-control-plane.ts";

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
  readonly backend: StorageBackend;
}): Promise<OpenLocalTenantResult> {
  const control = new LocalControlPlane(o.home);
  let dir: TenantDirectory;
  try {
    dir = await control.directory();
  } catch (e) {
    if (e instanceof LocalTenantError) return { ok: false, failure: e.code };
    throw e;
  }
  const anchor = control.anchors;
  const store = await o.backend.open({ kind: "pglite", dir: dir.dataDir }, {});
  try {
    const [tail, a] = await Promise.all([
      store.read((tx) => readTail(tx)),
      anchor.read(dir.tenant),
    ]);
    if (tail === undefined) {
      await store.close();
      return { ok: false, failure: "tenant_empty" };
    }
    const decision = await openTenant({
      importInProgress: a.importInProgress,
      restoreInProgress: a.restoreInProgress,
      logEnd: tail.seq,
      highWater: a.highWater,
    });
    if (decision.kind !== "serve") {
      await store.close();
      return { ok: false, failure: decision.what };
    }
    // `openTenant` steps 4 and 5 (reconcile deletion entries with the log, run tasks that fell
    // due) come here with the deletion flows.
    return { ok: true, tenant: { tenant: dir.tenant, user: dir.user, store, anchor } };
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
function systemContext(t: LocalTenant, trigger: InternalOperation, now: string): OpsContext {
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
  t: LocalTenant,
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
