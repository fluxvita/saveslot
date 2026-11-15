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

import { readFile } from "node:fs/promises";
import { join } from "node:path";
import type {
  AnchorStore,
  OpenTenantStop,
  StorageBackend,
  TenantStore,
} from "@fluxvita/saveslot-kernel";
import {
  createOpsContext,
  flushReads,
  type InternalOperation,
  type OpsContext,
  openTenantDecision,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { openFileAnchorStore } from "@fluxvita/saveslot-kernel/anchor-file";

type TenantId = `tn_${string}`;
type UserId = `u_${string}`;

/** 01-objects «标识的写法»: a prefix and 26 Crockford base-32 characters. */
const CROCKFORD_26 = "[0-9A-HJKMNP-TV-Z]{26}";
const TENANT_ID = new RegExp(`^tn_${CROCKFORD_26}$`);
const USER_ID = new RegExp(`^u_${CROCKFORD_26}$`);

/** Paths under the service's home directory (06-cli §3 «分步做»). */
export const controlDir = (home: string): string => join(home, "control");
export const tenantFile = (home: string): string => join(controlDir(home), "tenant.json");
export const anchorFile = (home: string): string => join(controlDir(home), "anchor.json");

/** The local tenant directory: the one user and their tenant. */
export interface TenantDirectory {
  readonly user: UserId;
  readonly tenant: TenantId;
}

/** Why the local tenant cannot be opened or cannot serve. Stable codes, no paths, no user data. */
export type LocalTenantFailure =
  /** No readable `control/tenant.json`: the home was not initialized. */
  | "not_initialized"
  /** `control/tenant.json` is not of its form. */
  | "tenant_directory_corrupt"
  /** The tenant storage has no events: not created. */
  | "tenant_empty"
  | OpenTenantStop;

export class LocalTenantError extends Error {
  override readonly name = "LocalTenantError";
  readonly code: LocalTenantFailure;
  constructor(code: LocalTenantFailure, message: string) {
    super(message);
    this.code = code;
  }
}

/**
 * Reads `control/tenant.json`: `{"format": 1, "user": "u_…", "tenant": "tn_…"}`, exactly these
 * keys. The file is written by `saveslot init` (not in this package yet).
 */
export async function readTenantDirectory(home: string): Promise<TenantDirectory> {
  let text: string;
  try {
    text = await readFile(tenantFile(home), "utf8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") {
      throw new LocalTenantError("not_initialized", "the home has no tenant directory");
    }
    throw e;
  }
  const corrupt = () =>
    new LocalTenantError("tenant_directory_corrupt", "the tenant directory is not of its form");
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    throw corrupt();
  }
  if (v === null || typeof v !== "object" || Array.isArray(v)) throw corrupt();
  const o = v as Record<string, unknown>;
  const keys = Object.keys(o).sort();
  if (keys.join(",") !== "format,tenant,user" || o["format"] !== 1) throw corrupt();
  const user = o["user"];
  const tenant = o["tenant"];
  if (typeof user !== "string" || !USER_ID.test(user)) throw corrupt();
  if (typeof tenant !== "string" || !TENANT_ID.test(tenant)) throw corrupt();
  return { user: user as UserId, tenant: tenant as TenantId };
}

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
 * Opens the local tenant and decides whether it serves. Errors of the storage itself (locked,
 * another format version, durability not applied) are thrown as the backend throws them.
 */
export async function openLocalTenant(o: {
  readonly home: string;
  readonly dataDir: string;
  readonly backend: StorageBackend;
}): Promise<OpenLocalTenantResult> {
  let dir: TenantDirectory;
  try {
    dir = await readTenantDirectory(o.home);
  } catch (e) {
    if (e instanceof LocalTenantError) return { ok: false, failure: e.code };
    throw e;
  }
  const anchor = openFileAnchorStore(anchorFile(o.home));
  const store = await o.backend.open({ kind: "pglite", dir: o.dataDir }, {});
  try {
    const [tail, a] = await Promise.all([
      store.read((tx) => readTail(tx)),
      anchor.read(dir.tenant),
    ]);
    if (tail === undefined) {
      await store.close();
      return { ok: false, failure: "tenant_empty" };
    }
    const decision = openTenantDecision({
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
