// Experiment 8 lock candidates (pre-dev-w0-experiments, experiment 8), all behind the store's
// DirLock interface so the full store can run on each of them.
//
//   A   operating-system file lock through a prebuilt native addon (the store's default lock):
//       flock(LOCK_EX|LOCK_NB) on macOS, fcntl(F_OFD_SETLK) on Linux.
//   A2  variant of A without any addon: an EXCLUSIVE transaction held open in Node's built-in
//       SQLite (node:sqlite), which takes POSIX fcntl locks on the file.
//   B   exclusive creation of a lock file, with a heartbeat and an expiry.
//   C   bind-and-listen on a unix socket in the directory; a refused connection means stale.

import {
  closeSync,
  futimesSync,
  openSync,
  readFileSync,
  renameSync,
  statSync,
  unlinkSync,
  writeSync,
} from "node:fs";
import { connect, createServer, type Server } from "node:net";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { type DirLock, osFileLock, PgliteStoreError } from "@fluxvita/saveslot-store-pglite";

const locked = (dir: string) =>
  new PgliteStoreError("store_locked", `the storage at ${dir} is held by another opener`);

const A: DirLock = { ...osFileLock, name: "A" };

const A2: DirLock = {
  name: "A2",
  async acquire(dir) {
    const db = new DatabaseSync(join(dir, "saveslot.lock.sqlite"));
    try {
      db.exec("PRAGMA busy_timeout = 0");
      db.exec("BEGIN EXCLUSIVE");
    } catch (e) {
      db.close();
      if (/locked|busy/i.test(String(e))) throw locked(dir);
      throw e;
    }
    return {
      async release() {
        try {
          db.exec("ROLLBACK");
        } finally {
          db.close();
        }
      },
    };
  },
};

/** B's timing. A holder that has not touched the file for STALE_MS is presumed dead. */
export const B_HEARTBEAT_MS = 200;
export const B_STALE_MS = 750;

const B: DirLock = {
  name: "B",
  async acquire(dir) {
    const path = join(dir, "saveslot.lock.b");
    const token = `${process.pid}-${Math.random().toString(36).slice(2)}`;
    const tryCreate = () => {
      const fd = openSync(path, "wx", 0o600);
      writeSync(fd, token);
      return fd;
    };
    let fd: number;
    try {
      fd = tryCreate();
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code !== "EEXIST") throw e;
      let age: number;
      try {
        age = Date.now() - statSync(path).mtimeMs;
      } catch {
        age = Number.POSITIVE_INFINITY;
      }
      if (age <= B_STALE_MS) throw locked(dir);
      // Stale: move it aside, then create ours. Two contenders racing here can both succeed.
      try {
        renameSync(path, `${path}.stale.${token}`);
        unlinkSync(`${path}.stale.${token}`);
      } catch {}
      try {
        fd = tryCreate();
      } catch (e2) {
        if ((e2 as NodeJS.ErrnoException).code === "EEXIST") throw locked(dir);
        throw e2;
      }
    }
    const timer = setInterval(() => {
      const t = new Date();
      try {
        futimesSync(fd, t, t);
      } catch {}
    }, B_HEARTBEAT_MS);
    timer.unref();
    return {
      async release(opts) {
        clearInterval(timer);
        closeSync(fd);
        if (opts?.lost) return;
        try {
          if (readFileSync(path, "utf8") === token) unlinkSync(path);
        } catch {}
      },
    };
  },
};

const inUse = (e: unknown) =>
  ["EADDRINUSE", "EEXIST"].includes(String((e as NodeJS.ErrnoException).code));

const C: DirLock = {
  name: "C",
  async acquire(dir) {
    const path = join(dir, "saveslot.sock");
    const listen = () =>
      new Promise<Server>((resolve, reject) => {
        const s = createServer((c) => c.destroy());
        s.once("error", reject);
        s.listen(path, () => {
          s.off("error", reject);
          s.unref();
          resolve(s);
        });
      });
    const alive = () =>
      new Promise<boolean>((resolve) => {
        const c = connect(path);
        c.once("connect", () => {
          c.destroy();
          resolve(true);
        });
        c.once("error", () => resolve(false));
      });
    let server: Server;
    try {
      server = await listen();
    } catch (e) {
      // Linux reports EADDRINUSE for an existing socket path; macOS (through libuv) EEXIST.
      if (!inUse(e)) throw e;
      if (await alive()) throw locked(dir);
      // Stale socket file: remove it and bind again. Racy by construction (see the report).
      try {
        unlinkSync(path);
      } catch {}
      try {
        server = await listen();
      } catch (e2) {
        if (inUse(e2)) throw locked(dir);
        throw e2;
      }
    }
    return {
      release: () => new Promise<void>((r) => server.close(() => r())),
    };
  },
};

export const CANDIDATES: Record<string, DirLock> = { A, A2, B, C };

export function candidate(name: string): DirLock {
  const c = CANDIDATES[name];
  if (!c)
    throw new Error(`unknown candidate ${name}; one of ${Object.keys(CANDIDATES).join(", ")}`);
  return c;
}
