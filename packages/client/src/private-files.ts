// Files only this user may read: `profiles.json` in the home, a server profile's credentials in
// `credentials/` (06-cli §2 «用户会话凭证»). The rules of `credentials/session` (./credentials.ts):
// the directories 0700 and the files 0600, this user's, none a symbolic link, checked on every
// read and before every write; a file is opened without following a link and checked on the open
// descriptor. A write goes to a temporary file of its own in the same directory, opened
// exclusively at 0600, synced, renamed over the file, and the directory synced: a process killed
// on the way leaves the old file whole, or only a temporary file, which the next write removes.

import { randomBytes } from "node:crypto";
import { constants, type Stats } from "node:fs";
import { lstat, mkdir, open, readdir, rename, unlink } from "node:fs/promises";
import { join } from "node:path";
import { CredentialError } from "./credentials.ts";

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

/** Refuses what is a link, not of its kind, another user's, or open to group or others. */
export function checkPrivate(path: string, s: Stats, kind: "directory" | "file"): void {
  if (s.isSymbolicLink()) {
    throw new CredentialError("permissions", `${path} is a symbolic link`, path);
  }
  if (kind === "directory" ? !s.isDirectory() : !s.isFile()) {
    throw new CredentialError("permissions", `${path} is not a ${kind}`, path);
  }
  const owner = uid();
  if (owner !== undefined && s.uid !== owner) {
    throw new CredentialError("permissions", `${path} is not owned by the current user`, path);
  }
  if ((s.mode & 0o077) !== 0) {
    const want = kind === "directory" ? "700" : "600";
    throw new CredentialError(
      "permissions",
      `${path} has mode ${(s.mode & 0o777).toString(8)}, open to others; run chmod ${want} ${path}`,
      path,
    );
  }
}

/** EACCES and EPERM as the `permissions` refusal; anything else rethrown. */
function unreadable(e: unknown, path: string): never {
  const code = (e as NodeJS.ErrnoException).code;
  if (code === "EACCES" || code === "EPERM") {
    throw new CredentialError("permissions", `${path} cannot be read by the current user`, path);
  }
  throw e;
}

async function lstatOrMissing(path: string): Promise<Stats | undefined> {
  try {
    return await lstat(path);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    unreadable(e, path);
  }
}

/** Checks each directory that exists; true when all of them do. */
async function directoriesThere(dirs: readonly string[]): Promise<boolean> {
  for (const dir of dirs) {
    const s = await lstatOrMissing(dir);
    if (s === undefined) return false;
    checkPrivate(dir, s, "directory");
  }
  return true;
}

/**
 * The text of `file`, read after checking `dirs` (outermost first) and the file; undefined when
 * the file does not exist, and then nothing is checked: nothing is read (a home that is not
 * private, without the file, does not stop a command that reads nothing from it). Past
 * `maxBytes`: the `malformed` refusal.
 */
export async function readPrivateFile(
  dirs: readonly string[],
  file: string,
  maxBytes: number,
): Promise<string | undefined> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    handle = await open(file, constants.O_RDONLY | constants.O_NOFOLLOW | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    if (code === "ENOENT") return undefined;
    // O_NOFOLLOW on a link: ELOOP (Linux, macOS) or EMLINK (FreeBSD).
    if (code === "ELOOP" || code === "EMLINK") {
      throw new CredentialError("permissions", `${file} is a symbolic link`, file);
    }
    unreadable(e, file);
  }
  try {
    if (!(await directoriesThere(dirs))) return undefined;
    checkPrivate(file, await handle.stat(), "file");
    const buf = Buffer.alloc(maxBytes + 1);
    const { bytesRead } = await handle.read(buf, 0, buf.length, 0);
    if (bytesRead > maxBytes) {
      throw new CredentialError("malformed", `${file} is larger than it can be`, file);
    }
    return buf.subarray(0, bytesRead).toString("utf8");
  } finally {
    await handle.close();
  }
}

/** Syncs a directory, so that a rename or an unlink in it is on disk. */
async function syncDirectory(dir: string): Promise<void> {
  const h = await open(dir, constants.O_RDONLY);
  try {
    await h.sync();
  } finally {
    await h.close();
  }
}

/** Makes each missing directory at 0700 and checks each one. */
export async function privateDirectories(dirs: readonly string[]): Promise<void> {
  for (const dir of dirs) {
    if ((await lstatOrMissing(dir)) === undefined) {
      try {
        await mkdir(dir, { mode: 0o700 });
      } catch (e) {
        if ((e as NodeJS.ErrnoException).code !== "EEXIST") unreadable(e, dir);
      }
    }
    checkPrivate(dir, (await lstatOrMissing(dir)) as Stats, "directory");
  }
}

/**
 * Writes `text` to `name` in the last of `dirs`, made and checked first: a temporary file of its
 * own (`.<name>.<16 hex>.tmp`, exclusive, 0600), synced, renamed over the file, the directory
 * synced. Temporary files of `name` left by an earlier write are removed first.
 */
export async function writePrivateFile(
  dirs: readonly string[],
  name: string,
  text: string,
): Promise<void> {
  await privateDirectories(dirs);
  const dir = dirs[dirs.length - 1] as string;
  const file = join(dir, name);
  const existing = await lstatOrMissing(file);
  if (existing !== undefined) checkPrivate(file, existing, "file");
  const left = new RegExp(`^\\.${name.replace(/[.]/g, "\\.")}\\.[0-9a-f]{16}\\.tmp$`);
  for (const entry of await readdir(dir)) {
    if (left.test(entry)) await unlink(join(dir, entry)).catch(() => {});
  }
  const temp = join(dir, `.${name}.${randomBytes(8).toString("hex")}.tmp`);
  const h = await open(
    temp,
    constants.O_WRONLY | constants.O_CREAT | constants.O_EXCL | constants.O_NOFOLLOW,
    0o600,
  );
  try {
    await h.writeFile(text, "utf8");
    await h.sync();
  } catch (e) {
    await h.close();
    await unlink(temp).catch(() => {});
    throw e;
  }
  await h.close();
  try {
    await rename(temp, file);
  } catch (e) {
    await unlink(temp).catch(() => {});
    throw e;
  }
  await syncDirectory(dir);
}

/** Removes `file` from `dir` and syncs the directory; false when it was not there. */
export async function removePrivateFile(dir: string, file: string): Promise<boolean> {
  try {
    await unlink(join(dir, file));
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return false;
    throw e;
  }
  await syncDirectory(dir);
  return true;
}
