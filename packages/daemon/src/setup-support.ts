// What `saveslot setup` (06-cli §3.3) asks of the local home before it runs its steps: whether the
// home is initialized, and the lock that lets one `setup` run at a time.

import { constants } from "node:fs";
import { access, lstat, mkdir, readdir, stat } from "node:fs/promises";
import { dirname, join } from "node:path";
import { LocalTenantError, readTenantDirectory } from "@fluxvita/saveslot-service";
import { osFileLock, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";
import { runDir } from "./service.ts";
import { TEXTS } from "./texts.ts";

/** Whether `saveslot init` has run in `home` (its tenant directory is there and readable). */
export async function initialized(home: string): Promise<boolean> {
  try {
    await readTenantDirectory(home);
    return true;
  } catch (e) {
    if (e instanceof LocalTenantError && e.code === "not_initialized") return false;
    throw e;
  }
}

/** Where the lock of `setup` is: a directory of its own under `run/`, apart from the service's. */
export const setupLockDir = (home: string): string => join(runDir(home), "setup");

/**
 * Takes the lock of `setup` (06 §3.3 item 7), making the home and `run/` (0700) when they are not
 * there yet: held until `release`, or until the process ends. Undefined when another process
 * holds it.
 */
export async function setupLock(
  home: string,
): Promise<{ readonly release: () => Promise<void> } | undefined> {
  await mkdir(home, { recursive: true, mode: 0o700 });
  await mkdir(setupLockDir(home), { recursive: true, mode: 0o700 });
  try {
    const l = await osFileLock.acquire(setupLockDir(home));
    return { release: () => l.release() };
  } catch (e) {
    if (e instanceof PgliteStoreError && e.code === "store_locked") return undefined;
    throw e;
  }
}

/**
 * What makes `home` unusable as saveslot's home as it is, said with its path and how to put it
 * right (`init`, `setup`); undefined when nothing does. Looked at before anything is made in it:
 * - not there: the nearest directory above must be one this user can write (reached through a
 *   symbolic link or not: a home under a linked directory, such as a linked user directory, is
 *   fine; a link to a file or to nothing is said as such);
 * - a symbolic link: the home is a directory of its own (the link's target is to be named instead);
 * - something other than a directory, or another user's: in the way;
 * - a directory of another mode than 0700: chmod 700, saying whether it holds anything already;
 * - and, where there, its control/, credentials/ and run/ likewise: a link, a file, another
 *   user's, or another mode than 0700.
 */
export async function homeProblem(home: string): Promise<string | undefined> {
  const st = await lstat(home).catch((e: NodeJS.ErrnoException) => {
    // Not there, or something above it is not a directory: looked at from above.
    if (e.code === "ENOENT" || e.code === "ENOTDIR") return undefined;
    throw e;
  });
  if (st === undefined) {
    let above = dirname(home);
    for (;;) {
      const a = await lstat(above).catch(() => undefined);
      if (a !== undefined) {
        // Followed: the directory the link names is the one the home is made in.
        const to = await stat(above).catch((e: NodeJS.ErrnoException) => e.code ?? "EIO");
        if (typeof to === "string") {
          const why =
            to === "ENOENT"
              ? "points to nothing"
              : to === "ELOOP"
                ? "is one of a loop of links"
                : `cannot be followed (${to})`;
          return TEXTS.initAboveLink(home, above, why);
        }
        if (!to.isDirectory()) {
          return a.isSymbolicLink()
            ? TEXTS.initAboveLink(home, above, "points to something that is not a directory")
            : TEXTS.initInTheWay(above, "ENOTDIR");
        }
        const writable = await access(above, constants.W_OK | constants.X_OK).then(
          () => true,
          () => false,
        );
        return writable ? undefined : TEXTS.initParent(home, above);
      }
      if (dirname(above) === above) return undefined;
      above = dirname(above);
    }
  }
  if (st.isSymbolicLink()) return TEXTS.initLink(home);
  if (!st.isDirectory()) return TEXTS.initInTheWay(home, "EEXIST");
  const uid = typeof process.getuid === "function" ? process.getuid() : undefined;
  if (uid !== undefined && st.uid !== uid) return TEXTS.initOtherUser(home);
  const mode = st.mode & 0o777;
  if (mode !== 0o700) {
    const entries = await readdir(home).then(
      (x) => x.length,
      () => undefined,
    );
    return TEXTS.initHomeMode(home, mode.toString(8), entries);
  }
  // The directories saveslot keeps in it (06-cli §3 step 2), where there already: the same
  // checks, so that nothing is made when one of them is wrong (setup's lock is under run/).
  for (const name of SUBDIRS) {
    const path = join(home, name);
    const sub = await lstat(path).catch(() => undefined);
    if (sub === undefined) continue;
    if (sub.isSymbolicLink()) return TEXTS.initSubLink(path);
    if (!sub.isDirectory()) return TEXTS.initInTheWay(path, "EEXIST");
    if (uid !== undefined && sub.uid !== uid) return TEXTS.initOtherUser(path);
    const m = sub.mode & 0o777;
    if (m !== 0o700) return TEXTS.initSubMode(path, m.toString(8));
  }
  return undefined;
}

/** The directories under the home that saveslot makes 0700 and keeps its own. */
const SUBDIRS = ["control", "credentials", "run"] as const;
