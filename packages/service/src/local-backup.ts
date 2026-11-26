// The local mode's backup before a storage format upgrade (02-architecture §8 «格式版本、导出、导入与
// 恢复», «升级前的备份»): an upgrade cannot be undone (an older version refuses the newer format), so
// before the first step the tenant's data directory and `<home>/control/` are copied next to the
// home, as `<home name>.format-<from>-backup/`, with `data/` and `control/` in it.
//
// The backend calls this with PGlite shut down and the data directory's lock held (store-pglite
// `beforeUpgrade`), so the copy is of the store as it is and nothing writes it meanwhile. Every
// file call is awaited, one after another: the service's event loop is not held while a large
// directory is copied (`/health` answers, a stop is heard). The copy
// is made under `<…>-backup.partial/`, every file and directory fsynced, then renamed into place and
// the parent fsynced: a crash half way leaves a `.partial`, never taken for a backup, removed at the
// next try.
//
// A backup already in place is reused when it is of this very state: `backup.json` in it records
// the ends of what the store holds that only grow (the log's last event and its header hash, the
// largest `n` of `read_log`) and a digest of `control/`. Equal: the upgrade after it failed or
// stopped, and the backup is still the store's state before the upgrade. Different, or no record:
// an older version used the data since, and the backup is not overwritten (`backup_differs`).

import { createHash } from "node:crypto";
import { constants } from "node:fs";
import {
  chmod,
  copyFile,
  lstat,
  mkdir,
  open,
  readdir,
  readFile,
  rename,
  rm,
  stat,
  statfs,
  writeFile,
} from "node:fs/promises";
import { basename, dirname, join, relative, resolve } from "node:path";
import type { TenantRef, TenantStore } from "@fluxvita/saveslot-kernel";
import { controlDir } from "./local-control-plane.ts";

/** The record a backup keeps of the state it was made of. */
export const BACKUP_RECORD = "backup.json";

/** Where the backup before upgrading from format `from` goes: next to the home. */
export const upgradeBackupDir = (home: string, from: number): string => {
  const h = resolve(home);
  return join(dirname(h), `${basename(h)}.format-${from}-backup`);
};

/** The ends a store gives before its upgrade (store-pglite `UpgradeAhead`). */
export interface UpgradeMarks {
  readonly logEnd: { readonly seq: number; readonly hash: string } | null;
  readonly readsEnd: number | null;
}

/** What the backend says before upgrading (store-pglite `UpgradeAhead`). */
export interface UpgradeAheadOf {
  readonly dir: string;
  readonly from: number;
  readonly to: number;
  readonly marks: UpgradeMarks;
}

/**
 * A backend the local tenant opens with: the storage port's, and the hook before an upgrade
 * (store-pglite `PgliteBackend`).
 */
export interface LocalStorageBackend {
  open(
    tenant: TenantRef,
    opts: {
      readonly create?: boolean;
      readonly beforeUpgrade?: (ahead: UpgradeAheadOf) => Promise<void>;
    },
  ): Promise<TenantStore>;
}

/** What differs between a backup in place and the store now. */
export type BackupDiffers = "log" | "reads" | "control" | "record";

/**
 * Why there is no backup: not enough space; one in place of other data; a symbolic link in the data
 * directory or `control/` (not followed, not copied as a link: a backup stands on its own, and
 * neither PGlite nor the home makes one); the copy failed (with its error's code).
 */
export type LocalBackupErrorCode = "no_space" | "backup_differs" | "link" | "copy_failed";

export class LocalBackupError extends Error {
  override readonly name = "LocalBackupError";
  readonly code: LocalBackupErrorCode;
  /** With `backup_differs`: what differs. */
  readonly differs: readonly BackupDiffers[];
  /** With `copy_failed`: the file system error's code (`EACCES`, `ENOSPC`, …), when it has one. */
  readonly errno: string | undefined;
  constructor(
    code: LocalBackupErrorCode,
    message: string,
    opts: {
      readonly differs?: readonly BackupDiffers[];
      readonly errno?: string;
      readonly cause?: unknown;
    } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.differs = opts.differs ?? [];
    this.errno = opts.errno;
  }
}

/** What the backup reports, for the service's log (never a stored value). */
export type BackupEvent =
  | "upgrade_backup_made"
  | "upgrade_backup_reused"
  | "upgrade_backup_skipped";

export interface LocalBackupOptions {
  readonly home: string;
  /** No backup: the upgrade goes on without one, and `upgrade_backup_skipped` says so. */
  readonly skip?: boolean;
  readonly onEvent?: (
    event: BackupEvent,
    fields: Readonly<Record<string, string | number>>,
  ) => void;
  /** @internal Tests only: the free bytes of the file system `path` is on (statfs otherwise). */
  readonly freeBytes?: (path: string) => number | Promise<number>;
  /**
   * @internal Tests only: awaited after each file is copied, with its path in the backup (to fail
   * half way, or to hold the copy there).
   */
  readonly afterCopy?: (path: string) => void | Promise<void>;
  /**
   * The service is stopping: the copy halts after the file in hand, leaving `.partial` (removed at
   * the next try), and the upgrade does not begin.
   */
  readonly signal?: AbortSignal;
  /** @internal Tests only: awaited just before `.partial` is renamed to the backup's name. */
  readonly beforeRename?: () => void | Promise<void>;
}

/**
 * The backend's `beforeUpgrade` for a local home: makes (or reuses) the backup, or with `skip`
 * only says there is none. Space for the upgrade itself is checked on every path, the backup's as
 * well where one is made. Throws `LocalBackupError` when the upgrade must not go on.
 */
export function localBackupBeforeUpgrade(
  o: LocalBackupOptions,
): (ahead: UpgradeAheadOf) => Promise<void> {
  return async (ahead) => {
    try {
      await backUp(o, ahead);
    } catch (e) {
      if (e instanceof LocalBackupError) throw e;
      const errno = errnoOf(e);
      throw new LocalBackupError(
        "copy_failed",
        `the backup could not be made: ${(e as Error).message}`,
        { cause: e, ...(errno !== undefined ? { errno } : {}) },
      );
    }
  };
}

async function backUp(o: LocalBackupOptions, ahead: UpgradeAheadOf): Promise<void> {
  const fields = { from: ahead.from, to: ahead.to };
  const control = controlDir(o.home);
  const done = upgradeBackupDir(o.home, ahead.from);
  const partial = `${done}.partial`;
  const parent = dirname(done);
  const freeOf = async (path: string) => (o.freeBytes ?? freeBytes)(path);
  // The upgrade itself (its new indexes, the rows it rewrites, its WAL): as much again as the data
  // directory, on its file system, whatever is done about the backup.
  const dataBytes = await treeBytes(ahead.dir);
  const room = async (needs: readonly { path: string; bytes: number }[]) => {
    for (const n of needs) {
      const free = await freeOf(n.path);
      if (free < n.bytes) {
        throw new LocalBackupError(
          "no_space",
          `not enough free space for the backup and the upgrade: ${n.bytes} bytes needed on the file system of ${n.path}, ${free} free`,
        );
      }
    }
  };
  // A copy a crash left is never a backup: gone first, whatever follows.
  await rm(partial, { recursive: true, force: true });
  if (o.skip === true) {
    await room([{ path: ahead.dir, bytes: dataBytes }]);
    o.onEvent?.("upgrade_backup_skipped", fields);
    return;
  }
  const record = {
    format: 1,
    from: ahead.from,
    to: ahead.to,
    log_end: ahead.marks.logEnd,
    reads_end: ahead.marks.readsEnd,
    control: await treeDigest(control),
  };
  if (await exists(done)) {
    const differs = await compare(join(done, BACKUP_RECORD), record);
    if (differs.length > 0) {
      throw new LocalBackupError(
        "backup_differs",
        `a backup is already at ${done}, of other data than this (${differs.join(", ")} differ): move it away, or go back to it first`,
        { differs },
      );
    }
    await room([{ path: ahead.dir, bytes: dataBytes }]);
    o.onEvent?.("upgrade_backup_reused", fields);
    return;
  }
  const backupBytes = dataBytes + (await treeBytes(control));
  await room(
    (await stat(parent)).dev === (await stat(ahead.dir)).dev
      ? [{ path: parent, bytes: backupBytes + dataBytes }]
      : [
          { path: parent, bytes: backupBytes },
          { path: ahead.dir, bytes: dataBytes },
        ],
  );
  await mkdir(partial, { mode: 0o700 });
  const each = async (path: string) => {
    await o.afterCopy?.(path);
    o.signal?.throwIfAborted();
  };
  await copyTree(ahead.dir, join(partial, "data"), each);
  await copyTree(control, join(partial, "control"), each);
  o.signal?.throwIfAborted();
  // The record before the rename: a backup under its own name always has one.
  await writeFile(join(partial, BACKUP_RECORD), `${JSON.stringify(record)}\n`, { mode: 0o600 });
  await fsyncPath(join(partial, BACKUP_RECORD));
  await fsyncPath(partial);
  await o.beforeRename?.();
  await rename(partial, done);
  await fsyncPath(parent);
  o.onEvent?.("upgrade_backup_made", { ...fields, bytes: backupBytes });
}

/** What differs between the record kept at `file` and `now`. */
async function compare(file: string, now: Record<string, unknown>): Promise<BackupDiffers[]> {
  let kept: Record<string, unknown>;
  try {
    kept = JSON.parse(await readFile(file, "utf8")) as Record<string, unknown>;
  } catch {
    return ["record"];
  }
  if (kept === null || typeof kept !== "object" || kept["format"] !== 1) return ["record"];
  const differs: BackupDiffers[] = [];
  if (JSON.stringify(kept["log_end"]) !== JSON.stringify(now["log_end"])) differs.push("log");
  if (kept["reads_end"] !== now["reads_end"]) differs.push("reads");
  if (kept["control"] !== now["control"]) differs.push("control");
  if (kept["from"] !== now["from"]) differs.push("record");
  return differs;
}

/** A symbolic link where a file or a directory was to be: `link`. */
function linkFound(path: string): LocalBackupError {
  return new LocalBackupError(
    "link",
    `${path} is a symbolic link: a backup copies files and directories only; put the file or directory itself there`,
  );
}

/** The files under `root`, by their paths from it, sorted. */
async function filesOf(root: string): Promise<string[]> {
  const out: string[] = [];
  const walk = async (dir: string) => {
    for (const name of (await readdir(dir)).sort()) {
      const p = join(dir, name);
      const st = await lstat(p);
      if (st.isSymbolicLink()) throw linkFound(p);
      if (st.isDirectory()) await walk(p);
      else if (st.isFile()) out.push(relative(root, p));
      else throw new Error(`${p} is neither a file nor a directory`);
    }
  };
  if ((await lstat(root)).isSymbolicLink()) throw linkFound(root);
  await walk(root);
  return out;
}

/** SHA-256 of every file under `root`: its path and its content, in path order. */
export async function treeDigest(root: string): Promise<string> {
  const h = createHash("sha256");
  for (const f of await filesOf(root)) {
    const body = await readFile(join(root, f));
    h.update(`${f}\0${body.length}\0`);
    h.update(body);
  }
  return h.digest("hex");
}

async function treeBytes(root: string): Promise<number> {
  let n = 0;
  for (const f of await filesOf(root)) n += (await stat(join(root, f))).size;
  return n;
}

async function freeBytes(path: string): Promise<number> {
  const s = await statfs(path);
  return Number(s.bavail) * Number(s.bsize);
}

async function exists(path: string): Promise<boolean> {
  try {
    await lstat(path);
    return true;
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
}

/** Copies `from` to `to` (new), each file and directory with its mode, each fsynced, in order. */
async function copyTree(
  from: string,
  to: string,
  afterCopy?: (path: string) => void | Promise<void>,
): Promise<void> {
  const top = await lstat(from);
  if (top.isSymbolicLink()) throw linkFound(from);
  await mkdir(to, { mode: top.mode & 0o777 });
  for (const name of (await readdir(from)).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = await lstat(src);
    if (st.isSymbolicLink()) throw linkFound(src);
    if (st.isDirectory()) {
      await copyTree(src, dst, afterCopy);
    } else if (st.isFile()) {
      await copyFile(src, dst, constants.COPYFILE_EXCL);
      await chmod(dst, st.mode & 0o777);
      await fsyncPath(dst);
      await afterCopy?.(dst);
    } else {
      throw new Error(`${src} is neither a file nor a directory`);
    }
  }
  await fsyncPath(to);
}

/** fsyncs a file or a directory. */
async function fsyncPath(path: string): Promise<void> {
  const h = await open(path, constants.O_RDONLY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/** A file system error's code, when it has one (`EACCES`, `ENOSPC`, …). */
function errnoOf(e: unknown): string | undefined {
  const code = (e as NodeJS.ErrnoException | undefined)?.code;
  return typeof code === "string" && /^E[A-Z0-9]+$/.test(code) ? code : undefined;
}
