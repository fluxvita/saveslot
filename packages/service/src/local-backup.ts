// The local mode's backup before a storage format upgrade (02-architecture §8 «格式版本、导出、导入与
// 恢复», «升级前的备份»): an upgrade cannot be undone (an older version refuses the newer format), so
// before the first step the tenant's data directory and `<home>/control/` are copied next to the
// home, as `<home name>.format-<from>-backup/`, with `data/` and `control/` in it.
//
// The backend calls this with PGlite shut down and the data directory's lock held (store-pglite
// `beforeUpgrade`), so the copy is of the store as it is and nothing writes it meanwhile. The copy
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
import {
  chmodSync,
  closeSync,
  constants,
  copyFileSync,
  existsSync,
  fsyncSync,
  lstatSync,
  mkdirSync,
  openSync,
  readdirSync,
  readFileSync,
  renameSync,
  rmSync,
  statfsSync,
  statSync,
  writeFileSync,
} from "node:fs";
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

export type LocalBackupErrorCode = "no_space" | "backup_differs" | "copy_failed";

export class LocalBackupError extends Error {
  override readonly name = "LocalBackupError";
  readonly code: LocalBackupErrorCode;
  /** With `backup_differs`: what differs. */
  readonly differs: readonly BackupDiffers[];
  constructor(
    code: LocalBackupErrorCode,
    message: string,
    opts: { readonly differs?: readonly BackupDiffers[]; readonly cause?: unknown } = {},
  ) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.code = code;
    this.differs = opts.differs ?? [];
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
  readonly freeBytes?: (path: string) => number;
  /** @internal Tests only: called after each file is copied, with its path in the backup. */
  readonly afterCopy?: (path: string) => void;
}

/**
 * The backend's `beforeUpgrade` for a local home: makes (or reuses) the backup, or with `skip`
 * only says there is none. Throws `LocalBackupError` when the upgrade must not go on.
 */
export function localBackupBeforeUpgrade(
  o: LocalBackupOptions,
): (ahead: UpgradeAheadOf) => Promise<void> {
  return async (ahead) => {
    const fields = { from: ahead.from, to: ahead.to };
    if (o.skip === true) {
      o.onEvent?.("upgrade_backup_skipped", fields);
      return;
    }
    const control = controlDir(o.home);
    const record = {
      format: 1,
      from: ahead.from,
      to: ahead.to,
      log_end: ahead.marks.logEnd,
      reads_end: ahead.marks.readsEnd,
      control: treeDigest(control),
    };
    const done = upgradeBackupDir(o.home, ahead.from);
    const partial = `${done}.partial`;
    rmSync(partial, { recursive: true, force: true });
    if (existsSync(done)) {
      const differs = compare(join(done, BACKUP_RECORD), record);
      if (differs.length > 0) {
        throw new LocalBackupError(
          "backup_differs",
          `a backup is already at ${done}, of other data than this (${differs.join(", ")} differ): move it away, or go back to it first`,
          { differs },
        );
      }
      o.onEvent?.("upgrade_backup_reused", fields);
      return;
    }
    const dataBytes = treeBytes(ahead.dir);
    const backupBytes = dataBytes + treeBytes(control);
    // The backup, and as much again as the data directory for the upgrade itself (its new
    // indexes, rows rewritten and the WAL of the step), on whichever file systems they are on.
    const freeOf = o.freeBytes ?? freeBytes;
    const parent = dirname(done);
    const needs =
      statSync(parent).dev === statSync(ahead.dir).dev
        ? [{ path: parent, bytes: backupBytes + dataBytes }]
        : [
            { path: parent, bytes: backupBytes },
            { path: ahead.dir, bytes: dataBytes },
          ];
    for (const n of needs) {
      const free = freeOf(n.path);
      if (free < n.bytes) {
        throw new LocalBackupError(
          "no_space",
          `not enough free space for the backup and the upgrade: ${n.bytes} bytes needed on the file system of ${n.path}, ${free} free`,
        );
      }
    }
    try {
      mkdirSync(partial, { mode: 0o700 });
      copyTree(ahead.dir, join(partial, "data"), o.afterCopy);
      copyTree(control, join(partial, "control"), o.afterCopy);
      writeFileSync(join(partial, BACKUP_RECORD), `${JSON.stringify(record)}\n`, { mode: 0o600 });
      fsyncFile(join(partial, BACKUP_RECORD));
      fsyncDirectory(partial);
      renameSync(partial, done);
      fsyncDirectory(parent);
    } catch (e) {
      throw new LocalBackupError(
        "copy_failed",
        `the backup could not be made at ${partial}: ${(e as Error).message}`,
        { cause: e },
      );
    }
    o.onEvent?.("upgrade_backup_made", { ...fields, bytes: backupBytes });
  };
}

/** What differs between the record kept at `file` and `now`. */
function compare(file: string, now: Record<string, unknown>): BackupDiffers[] {
  let kept: Record<string, unknown>;
  try {
    kept = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
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

/** The files under `root`, by their paths from it, sorted. */
function filesOf(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string) => {
    for (const name of readdirSync(dir).sort()) {
      const p = join(dir, name);
      const st = lstatSync(p);
      if (st.isDirectory()) walk(p);
      else if (st.isFile()) out.push(relative(root, p));
      else throw new Error(`${p} is neither a file nor a directory`);
    }
  };
  walk(root);
  return out;
}

/** SHA-256 of every file under `root`: its path and its content, in path order. */
export function treeDigest(root: string): string {
  const h = createHash("sha256");
  for (const f of filesOf(root)) {
    const body = readFileSync(join(root, f));
    h.update(`${f}\0${body.length}\0`);
    h.update(body);
  }
  return h.digest("hex");
}

function treeBytes(root: string): number {
  let n = 0;
  for (const f of filesOf(root)) n += statSync(join(root, f)).size;
  return n;
}

function freeBytes(path: string): number {
  const s = statfsSync(path);
  return Number(s.bavail) * Number(s.bsize);
}

/** Copies `from` to `to` (new), each file and directory with its mode, each fsynced. */
function copyTree(from: string, to: string, afterCopy?: (path: string) => void): void {
  mkdirSync(to, { mode: statSync(from).mode & 0o777 });
  for (const name of readdirSync(from).sort()) {
    const src = join(from, name);
    const dst = join(to, name);
    const st = lstatSync(src);
    if (st.isDirectory()) {
      copyTree(src, dst, afterCopy);
    } else if (st.isFile()) {
      copyFileSync(src, dst, constants.COPYFILE_EXCL);
      chmodSync(dst, st.mode & 0o777);
      fsyncFile(dst);
      afterCopy?.(dst);
    } else {
      throw new Error(`${src} is neither a file nor a directory`);
    }
  }
  fsyncDirectory(to);
}

function fsyncFile(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncDirectory(path: string): void {
  fsyncFile(path);
}
