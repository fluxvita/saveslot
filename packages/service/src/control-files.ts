// Files of the local control plane and of the credentials directory (docs/zh-CN/spec/02-architecture.md
// §5 «本机控制面用文件»; 06-cli.md §2, §8.2): owned by the user running saveslot, files at 0600 and
// their directories at 0700, never symbolic links, checked on every read and before every write;
// written to a temporary file in the same directory, fsynced, renamed over the file, then the
// directory fsynced. Only the service process (or `init` and `rotateSession`, holding the home's
// lock) writes them.
//
// A temporary file left by a process killed before its rename may hold a token: it has a random
// name of its own form, and is removed at the next start (`removeStaleTemps`, under the lock).

import { randomBytes } from "node:crypto";
import {
  closeSync,
  fsyncSync,
  lstatSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
  type Stats,
  writeSync,
} from "node:fs";
import { lstat, mkdir, readFile } from "node:fs/promises";
import { dirname, join } from "node:path";

/** A control file or directory that is not this user's, is open to others, or is a link. */
export class ControlFileError extends Error {
  override readonly name = "ControlFileError";
  /** `permissions`: owner, mode or kind not as required. */
  readonly code: "permissions";
  readonly path: string;
  constructor(path: string, message: string) {
    super(message);
    this.code = "permissions";
    this.path = path;
  }
}

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

function checkStats(path: string, s: Stats, mode: 0o600 | 0o700): void {
  if (s.isSymbolicLink()) throw new ControlFileError(path, `${path} is a symbolic link`);
  if (mode === 0o700 ? !s.isDirectory() : !s.isFile()) {
    throw new ControlFileError(path, `${path} is not a ${mode === 0o700 ? "directory" : "file"}`);
  }
  const owner = uid();
  if (owner !== undefined && s.uid !== owner) {
    throw new ControlFileError(path, `${path} is not owned by the user running saveslot`);
  }
  if ((s.mode & 0o777) !== mode) {
    throw new ControlFileError(
      path,
      `${path} has mode ${(s.mode & 0o777).toString(8)}; it must be ${mode.toString(8)}`,
    );
  }
}

/**
 * Fails unless `path` is a file (0600) or directory (0700) of this user, not a link. A missing
 * path is thrown as `ENOENT`.
 */
export async function checkMode(path: string, mode: 0o600 | 0o700): Promise<void> {
  checkStats(path, await lstat(path), mode);
}

/** As `checkMode`; a missing path passes. */
export async function checkModeIfPresent(path: string, mode: 0o600 | 0o700): Promise<void> {
  try {
    await checkMode(path, mode);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code !== "ENOENT") throw e;
  }
}

/** A directory at 0700, made if missing; an existing one must already be 0700 and this user's. */
export async function ensureDir(path: string): Promise<void> {
  await mkdir(path, { recursive: true, mode: 0o700 });
  await checkMode(path, 0o700);
}

/** Reads a file after checking it and its directory; undefined when it does not exist. */
export async function readPrivate(path: string): Promise<string | undefined> {
  await checkMode(dirname(path), 0o700);
  try {
    await checkMode(path, 0o600);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw e;
  }
  return readFile(path, "utf8");
}

const TEMP = /^\.saveslot-[0-9a-f]{32}\.tmp$/;

/**
 * Writes `text` to `path` (0600) durably: its directory checked (this user's, 0700, not a link),
 * then a temporary file of a random name, fsync, rename, directory fsync.
 */
export function writePrivate(path: string, text: string): void {
  const dir = dirname(path);
  checkStats(dir, lstatSync(dir), 0o700);
  const tmp = join(dir, `.saveslot-${randomBytes(16).toString("hex")}.tmp`);
  const fd = openSync(tmp, "wx", 0o600);
  try {
    writeSync(fd, text);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, path);
  const d = openSync(dir, "r");
  try {
    fsyncSync(d);
  } finally {
    closeSync(d);
  }
}

/** Removes the temporary files `writePrivate` left in `dirs` (missing ones skipped); how many. */
export function removeStaleTemps(dirs: readonly string[]): number {
  let n = 0;
  for (const dir of dirs) {
    let names: string[];
    try {
      names = readdirSync(dir);
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") continue;
      throw e;
    }
    for (const name of names) {
      if (!TEMP.test(name)) continue;
      rmSync(join(dir, name), { force: true });
      n++;
    }
  }
  return n;
}
