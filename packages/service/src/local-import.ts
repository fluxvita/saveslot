// Import into the local mode's one tenant (docs/zh-CN/spec/02-architecture.md §8 «格式版本、导出、导入
// 与恢复» steps ①–⑥ and «重入»; 04-contract §17 `import`; 04-contract-types `ImportResult`).
//
// The tenant's storage is a directory, `D` (the data directory the tenant directory records). An
// import replays the file into a staging directory next to it, `D.import-<import ID>` (on the same
// file system, so that a rename is one step), and swaps it in by two renames (⑤): `D` to
// `D.replaced-<import ID>`, then the staging directory to `D`. The names carry the import ID, the
// one the anchor's marker holds from ④ on, so that opening can tell each directory by its name:
//
// - no `D`, the marker's import ID, and `D.import-<that ID>` there: killed between the two
//   renames. Opening finishes the second rename before anything else (`repairLocalSwap`), and the
//   kernel's re-entry then sees the import's event in the log and finishes the import (⑥);
// - a staging directory of no import in progress (killed before ④, or after a roll back cleared
//   the marker): removed on opening; `D.replaced-…` with no import in progress (the import
//   finished, the old directory not yet removed): removed too. It held the genesis event only.
//
// While an import runs, the tenant serves nothing: `LocalTenantGate` refuses uses with
// `unavailable` (`importing`) and another import with `rate_limited` (`busy`), and the import waits
// for the uses in progress before it closes the tenant for the swap.

import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { basename, dirname, join } from "node:path";
import type { ImportResult } from "@fluxvita/saveslot-contract";
import {
  type AnchorStore,
  appendImportEvent,
  type ImportId,
  ImportRejected,
  importContractError,
  importIntoStaging,
  newImportId,
  type ReadTx,
  readTail,
  runImport,
  type StorageBackend,
  type TenantStore,
} from "@fluxvita/saveslot-kernel";
import { ContractError } from "./contract-error.ts";
import type { TenantId, UserId } from "./control-plane.ts";

/** An import ID as the kernel makes it (`newImportId`): `im_` and 16 Crockford characters. */
const IMPORT_ID = /^im_[0-9A-HJKMNP-TV-Z]{16}$/;

/** The staging directory of import `id` next to data directory `dataDir`. */
export const stagingDirOf = (dataDir: string, id: ImportId): string => `${dataDir}.import-${id}`;

/** Where the data directory goes while import `id` swaps its staging directory in. */
export const replacedDirOf = (dataDir: string, id: ImportId): string => `${dataDir}.replaced-${id}`;

/** The directories next to `dataDir` an import made, by kind and import ID. */
function importDirsOf(
  dataDir: string,
): Array<{ kind: "import" | "replaced"; id: string; path: string }> {
  const parent = dirname(dataDir);
  const prefix = `${basename(dataDir)}.`;
  let names: string[];
  try {
    names = readdirSync(parent);
  } catch {
    return [];
  }
  const found: Array<{ kind: "import" | "replaced"; id: string; path: string }> = [];
  for (const n of names) {
    if (!n.startsWith(prefix)) continue;
    const rest = n.slice(prefix.length);
    for (const kind of ["import", "replaced"] as const) {
      const id = rest.startsWith(`${kind}-`) ? rest.slice(kind.length + 1) : undefined;
      if (id !== undefined && IMPORT_ID.test(id)) found.push({ kind, id, path: join(parent, n) });
    }
  }
  return found;
}

/**
 * Before the tenant's storage is opened: killed between the swap's two renames, the data directory
 * is gone and the staging directory of the import in progress is there; the second rename is
 * finished. Anything else is left as it is. Returns whether it renamed.
 */
export function repairLocalSwap(
  dataDir: string,
  importInProgress: ImportId | undefined,
  fsyncDir: (path: string) => void = fsyncDirectory,
): boolean {
  if (importInProgress === undefined || existsSync(dataDir)) return false;
  const staging = stagingDirOf(dataDir, importInProgress);
  if (!existsSync(staging)) return false;
  renameSync(staging, dataDir);
  // Durable before the re-entry's step ⑥ is (§8: ⑤ before ⑥).
  fsyncDir(dirname(dataDir));
  return true;
}

/**
 * fsyncs a directory, so that the renames in it are durable. Node's fsync is F_FULLFSYNC on macOS
 * (libuv), fsync elsewhere.
 */
export function fsyncDirectory(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/**
 * Once the tenant opened and no import is in progress any more: removes what imports left next to
 * the data directory (staging directories, replaced data directories). One that cannot be removed
 * is told to `onLeftover` and left for the next opening: the tenant opens all the same. Returns how
 * many were removed.
 */
export function removeImportLeftovers(
  dataDir: string,
  importInProgress: ImportId | undefined,
  onLeftover?: (path: string, error: unknown) => void,
): number {
  let removed = 0;
  for (const d of importDirsOf(dataDir)) {
    if (d.id === importInProgress) continue;
    try {
      rmSync(d.path, { recursive: true, force: true });
      removed++;
    } catch (e) {
      try {
        onLeftover?.(d.path, e);
      } catch {
        // A report that fails is not the opening's failure.
      }
    }
  }
  return removed;
}

/** The staging directory of import `id` removed; nothing when it is gone. */
export function discardLocalStaging(dataDir: string, id: ImportId): void {
  rmSync(stagingDirOf(dataDir, id), { recursive: true, force: true });
}

/**
 * The local tenant's gate for an import: uses run while no import holds the tenant; an import
 * waits for the uses in progress, then holds it until it ends.
 */
export class LocalTenantGate {
  #importing = false;
  #uses = 0;
  #drained: (() => void) | undefined;

  /** Whether an import holds the tenant now. */
  get importing(): boolean {
    return this.#importing;
  }

  /** Runs `fn` as a use of the tenant; refused with `importing` while an import holds it. */
  async use<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#importing) throw importingError();
    this.#uses++;
    try {
      return await fn();
    } finally {
      this.#uses--;
      if (this.#uses === 0) this.#drained?.();
    }
  }

  /** Runs `fn` holding the tenant, once the uses in progress ended; another import is `busy`. */
  async exclusive<T>(fn: () => Promise<T>): Promise<T> {
    if (this.#importing) {
      throw new ContractError("rate_limited", "an import of this tenant is in progress", {
        reason: "busy",
        retry_after: IMPORT_BUSY_RETRY_AFTER,
      });
    }
    this.#importing = true;
    try {
      if (this.#uses > 0) {
        await new Promise<void>((resolve) => {
          this.#drained = resolve;
        });
      }
      this.#drained = undefined;
      return await fn();
    } finally {
      this.#importing = false;
    }
  }
}

/**
 * Seconds to wait before importing again while an import holds the tenant (04-contract-types
 * `rate_limited.retry_after`): an import of a small tenant takes seconds.
 */
export const IMPORT_BUSY_RETRY_AFTER = 5;

export const importingError = (): ContractError =>
  new ContractError("unavailable", "the tenant is being imported into", { reason: "importing" });

/** What the import needs of the open tenant it replaces. */
export interface ImportTarget {
  readonly tenant: TenantId;
  readonly store: TenantStore;
  readonly anchor: AnchorStore;
  readonly dataDir: string;
  /** Closes the tenant's storage before the swap (the daemon stops serving it). */
  readonly close: () => Promise<void>;
}

const NOT_IMPORTED: ImportResult["not_imported"] = ["read_log", "credentials", "external_files"];

/**
 * Imports the export file in `body` into the local tenant, which must be empty, the user's
 * session calling. Errors as the contract gives them (`ContractError`): `import_rejected`,
 * `too_large` (`import_line`); `invalid_argument` (`tenant_not_empty`) as the kernel throws it.
 * The target's storage is closed at the swap; the caller opens the tenant again either way once
 * this settles (`target.close` called or not).
 */
export async function importLocalTenant(o: {
  readonly backend: StorageBackend;
  readonly target: ImportTarget;
  readonly user: UserId;
  readonly body: AsyncIterable<Uint8Array>;
  readonly now: string;
  /** Told when the replaced data directory could not be removed; the import stands. */
  readonly onLeftover?: (path: string, error: unknown) => void;
  /**
   * How long the body may give nothing before the import is refused (`import_rejected`,
   * `incomplete`) and rolled back; default {@link IMPORT_BODY_IDLE_MS}.
   */
  readonly bodyIdleMs?: number;
  /** Aborted, an import still reading its body is refused as above (a stopping service). */
  readonly signal?: AbortSignal;
  /** @internal Tests only: the directory operations, to stop the import between them. */
  readonly fs?: {
    readonly rename?: typeof renameSync;
    readonly rm?: (path: string) => void;
    readonly fsyncDir?: (path: string) => void;
  };
}): Promise<ImportResult> {
  const t = o.target;
  const rename = o.fs?.rename ?? renameSync;
  const fsyncDir = o.fs?.fsyncDir ?? fsyncDirectory;
  const rm = o.fs?.rm ?? ((path: string) => rmSync(path, { recursive: true, force: true }));
  // Checked first, so that a tenant not empty costs no replay; `runImport` checks it again.
  const [tail, a] = await Promise.all([
    t.store.read((tx) => readTail(tx)),
    t.anchor.read(t.tenant),
  ]);
  const anchorEmpty =
    a.deletions.length === 0 &&
    a.restoreCount === 0 &&
    a.restoreInProgress === undefined &&
    a.importInProgress === undefined;
  if (tail?.seq !== 1 || !anchorEmpty) {
    throw new ContractError("invalid_argument", "the tenant is not empty", {
      reason: "tenant_not_empty",
    });
  }
  // A staging directory an earlier crash left is gone already: opening the tenant removed it.
  const importId = newImportId();
  const stagingDir = stagingDirOf(t.dataDir, importId);
  // ①–③ into the staging directory; a failure removes it. The staging storage stays open for
  // `runImport`'s check before ④ and is closed before the swap renames its directory.
  let result: Omit<ImportResult, "restore_count">;
  let restoreCount: number;
  let importedUpto: number;
  let staging: TenantStore | undefined;
  let stagingOpen = false;
  const closeStaging = async () => {
    if (!stagingOpen) return;
    stagingOpen = false;
    await staging?.close();
  };
  try {
    staging = await o.backend.open({ kind: "pglite", dir: stagingDir }, { create: true });
    stagingOpen = true;
    const staged = await importIntoStaging({
      staging,
      body: bodyWithin(o.body, o.bodyIdleMs ?? IMPORT_BODY_IDLE_MS, o.signal),
    });
    const disabledBefore = await staging.read(countDisabled);
    const ev = await appendImportEvent(staging, {
      user: o.user,
      tenant: t.tenant,
      manifest: staged.manifest,
      now: o.now as never,
    });
    const [disabledAfter, slots, removed] = await staging.read(
      async (tx) =>
        [await countDisabled(tx), await count(tx, "slots"), await countRemoved(tx)] as const,
    );
    restoreCount = ev.restoreCount;
    importedUpto = ev.importedUpto;
    result = {
      tenant_id: t.tenant,
      previous_tenant_id: staged.manifest.tenant_id,
      events: staged.events,
      seq: ev.seq,
      principals_disabled: disabledAfter - disabledBefore,
      slots,
      removed,
      // An import refuses a file holding a deletion event until apply knows them (`replay_failed`),
      // so it carries no deletion still pending and tombstones none.
      pending_deletions: { executed: 0, carried: 0 },
      exported_at: staged.manifest.exported_at,
      not_imported: NOT_IMPORTED,
    };
  } catch (e) {
    await closeStaging().catch(() => {});
    rm(stagingDir);
    throw asContractError(e);
  }

  // ④–⑥. Before ④ a failure removes the staging directory; from ④ on (the marker is this import's)
  // it is the re-entry's, and the tenant is closed if the swap has not closed it yet: with the
  // marker there it may not serve (§8), and the host's opening it again takes the import up.
  const replacedDir = replacedDirOf(t.dataDir, importId);
  let swapped: TenantStore | undefined;
  let targetClosed = false;
  const closeTarget = async () => {
    if (targetClosed) return;
    targetClosed = true;
    await t.close();
  };
  try {
    const finished = await runImport({
      target: t.store,
      anchor: t.anchor,
      tenant: t.tenant,
      importId,
      staging,
      // Step ③'s import event and the file's last event it follows.
      importSeq: result.seq,
      importedUpto,
      swap: async () => {
        await closeStaging();
        await closeTarget();
        rename(t.dataDir, replacedDir);
        rename(stagingDir, t.dataDir);
        // ⑤ durable before ⑥ writes the anchor (§8): a power loss must not keep the anchor and
        // lose the renames.
        fsyncDir(dirname(t.dataDir));
        swapped = await o.backend.open({ kind: "pglite", dir: t.dataDir }, {});
        return swapped;
      },
    });
    restoreCount = finished.restoreCount;
  } catch (e) {
    await closeStaging().catch(() => {});
    const now = await t.anchor.read(t.tenant).catch(() => undefined);
    if (now !== undefined && now.importInProgress !== importId) {
      rm(stagingDir);
    } else {
      // The marker is this import's, or the anchor did not answer: the opening that follows
      // finishes the import, rolls it back, or (no marker) removes the staging directory as an
      // import's leftover.
      await closeTarget().catch(() => {});
    }
    throw asContractError(e);
  } finally {
    await swapped?.close().catch(() => {});
  }

  // The data directory the import replaced: the genesis event only. Removed as far as it goes.
  try {
    rm(replacedDir);
  } catch (e) {
    o.onLeftover?.(replacedDir, e);
  }
  return { ...result, restore_count: restoreCount };
}

/** How long an import's body may give nothing (a client that stalled) before the import is refused. */
export const IMPORT_BODY_IDLE_MS = 60_000;

/**
 * The request body, each chunk awaited for at most `idleMs` and not past `signal`'s abort. A body
 * that stalls, ends in an error (the client went away) or is aborted is the file cut short: the
 * import is refused as `import_rejected` (`incomplete`) before ④, and nothing of it is kept. The
 * error says nothing of the file's content.
 */
async function* bodyWithin(
  body: AsyncIterable<Uint8Array>,
  idleMs: number,
  signal: AbortSignal | undefined,
): AsyncGenerator<Uint8Array> {
  const it = body[Symbol.asyncIterator]();
  const cut = (why: string) => new ImportRejected("incomplete", `the request body ${why}`);
  // The body is never ended here: `return()` on a request's iterator destroys the request, and its
  // connection with it, before the refusal is answered on it. The HTTP surface answers, then closes
  // the connection (api.ts `send`).
  for (;;) {
    let timer: NodeJS.Timeout | undefined;
    let onAbort: (() => void) | undefined;
    let next: IteratorResult<Uint8Array>;
    try {
      next = await Promise.race([
        it.next(),
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(cut(`gave nothing for ${idleMs} ms`)), idleMs);
          if (signal !== undefined) {
            onAbort = () => reject(cut("was abandoned: the service is stopping"));
            if (signal.aborted) onAbort();
            else signal.addEventListener("abort", onAbort, { once: true });
          }
        }),
      ]);
    } catch (e) {
      throw e instanceof ImportRejected ? e : cut("did not arrive whole");
    } finally {
      clearTimeout(timer);
      if (onAbort !== undefined) signal?.removeEventListener("abort", onAbort);
    }
    if (next.done === true) return;
    yield next.value;
  }
}

/**
 * The import's own errors as the contract gives them; `internal` and any other error pass as they
 * are (the surface gives an internal error its incident and keeps its message out).
 */
function asContractError(e: unknown): unknown {
  const c = importContractError(e);
  if (c === undefined || c.code === "internal") return e;
  const { code, ...detail } = c;
  return new ContractError(code, "the import was refused", detail);
}

const count = async (tx: ReadTx, table: "slots"): Promise<number> =>
  Number((await tx.query<{ n: unknown }>(`SELECT count(*) AS n FROM ${table}`)).rows[0]?.n ?? 0);

const countDisabled = async (tx: ReadTx): Promise<number> =>
  Number(
    (
      await tx.query<{ n: unknown }>(
        "SELECT count(*) AS n FROM principals WHERE state = 'disabled'",
      )
    ).rows[0]?.n ?? 0,
  );

const countRemoved = async (tx: ReadTx): Promise<number> =>
  Number(
    (
      await tx.query<{ n: unknown }>(
        "SELECT count(*) AS n FROM content WHERE removed_by IS NOT NULL",
      )
    ).rows[0]?.n ?? 0,
  );
