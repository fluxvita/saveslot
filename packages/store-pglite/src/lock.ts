// The single-writer lock of a PGlite tenant directory (02-architecture §7).
//
// Method chosen by experiment 8 (docs/zh-CN/process/experiments/exp-8-single-writer-lock.md):
// an operating-system lock on `<dir>/saveslot.lock`, through the prebuilt addon
// fs-native-extensions (flock(LOCK_EX | LOCK_NB) on macOS, fcntl(F_OFD_SETLK) on Linux). The
// kernel drops the lock when the process dies, so no stale lock needs cleaning; the lock belongs
// to the open file description, so a second open in the same process is refused too. Node's
// standard library has no flock.
//
// The lock does not name its holder. Ownership is named by the owner file (owner.ts).

/// <reference path="./fs-native-extensions.d.ts" />

import { closeSync, constants, openSync } from "node:fs";
import { join } from "node:path";
import type fsxModule from "fs-native-extensions";
import { PgliteStoreError } from "./errors.ts";

let addon: Promise<typeof fsxModule> | undefined;

/**
 * The addon, loaded when a lock is first taken rather than when this module is: it has prebuilds for
 * glibc only, and a command that takes no lock (`--version`, `--help`, a server profile's) runs on a
 * platform without one, such as musl.
 */
function lockAddon(): Promise<typeof fsxModule> {
  addon ??= import("fs-native-extensions").then((m) => m.default);
  return addon;
}

export interface DirLockHandle {
  /**
   * Releases the lock. Called after the database is closed, or after the store gave the tenant up
   * (`lost`: another opener holds the directory now; the lock must not disturb it).
   */
  release(opts?: { readonly lost?: boolean }): Promise<void>;
}

/** A way to hold a tenant directory exclusively. Pluggable for experiment 8 and tests. */
export interface DirLock {
  readonly name: string;
  /** Takes the lock or throws a PgliteStoreError with code "store_locked". */
  acquire(dir: string): Promise<DirLockHandle>;
}

export const LOCK_FILE = "saveslot.lock";

export const osFileLock: DirLock = {
  name: "os-file-lock",
  async acquire(dir) {
    const fsx = await lockAddon();
    const path = join(dir, LOCK_FILE);
    const fd = openSync(path, constants.O_RDWR | constants.O_CREAT, 0o600);
    let locked: boolean;
    try {
      locked = fsx.tryLock(fd);
    } catch (e) {
      closeSync(fd);
      throw e;
    }
    if (!locked) {
      closeSync(fd);
      throw new PgliteStoreError(
        "store_locked",
        `the storage at ${dir} is open in another process or another store`,
      );
    }
    let released = false;
    return {
      async release() {
        if (released) return;
        released = true;
        try {
          fsx.unlock(fd);
        } finally {
          closeSync(fd);
        }
      },
    };
  },
};
