// The host fsync hook on a real PGlite (durability.ts, `installHostFsync`; 02-architecture §8):
// - opened after a crash, PostgreSQL syncs the data directory in two walks, and each file now
//   reaches the host once, not twice;
// - the files clean in one instance are not in the next, in the same process on the same
//   directory, the first closed before the next opens: each file's first fsync in an instance
//   reaches the host;
// - a power loss, simulated: each file as of its last host fsync, the files never synced as the
//   instance found them. Every commit acknowledged before it is there after recovery, so no fsync
//   that had to reach the host was skipped. Checkpoints in the workload put the data files and
//   the commit log through the hook, not only the WAL; a recycled WAL segment does not occur
//   (max_wal_size is 64 MB), and the image is built by path, which a rename would defeat.
// The host fsync is a spy given through `nodeFs`'s test option: it syncs, then records.

import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  fstatSync,
  fsyncSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, relative } from "node:path";
import { createInterface } from "node:readline";
import { PGlite } from "@electric-sql/pglite";
import { afterAll, describe, expect, it } from "vitest";
import { hostSyncStats, nodeFs, startParams } from "./durability.ts";

const T = 180_000;
const root = mkdtempSync(join(tmpdir(), "saveslot-host-fsync-crash-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), T);
let n = 0;

const WRITER = join(import.meta.dirname, "testing", "crash-writer.fixture.ts");

/** The data directory `dir` after a process that wrote `tables` tables in it was killed. */
async function crashed(dir: string, tables: number): Promise<void> {
  const child: ChildProcess = spawn(
    process.execPath,
    // Wasm code GC off, as the test forks have it (vitest.config.ts, nodejs/node#66366).
    ["--no-wasm-code-gc", "--conditions=source", "--no-warnings", WRITER, dir, String(tables)],
    { stdio: ["ignore", "pipe", "inherit"] },
  );
  const gone = new Promise<void>((r) => child.once("exit", () => r()));
  try {
    await new Promise<void>((resolve, reject) => {
      createInterface({ input: child.stdout as NodeJS.ReadableStream }).once("line", (l) =>
        l === "ready" ? resolve() : reject(new Error(l)),
      );
      child.once("exit", (code) => reject(new Error(`the writer exited (${code})`)));
    });
  } finally {
    child.kill("SIGKILL");
    await gone;
  }
}

/** The host fsyncs of one instance: how many times each regular file's host path was synced. */
function spy(onSync?: (fd: number, path: string) => void) {
  const synced = new Map<string, number>();
  return {
    synced,
    hostFsync(fd: number, path: string) {
      fsyncSync(fd);
      if (fstatSync(fd).isFile()) synced.set(path, (synced.get(path) ?? 0) + 1);
      onSync?.(fd, path);
    },
  };
}

const open = (dir: string, hostFsync: (fd: number, path: string) => void) =>
  PGlite.create({
    fs: nodeFs(dir, "host-fsync", { hostFsync }),
    startParams: startParams("host-fsync"),
  });

describe("opened after a crash", () => {
  it(
    "each file reaches the host once, not twice; in the next instance in this process, each again once",
    async () => {
      const dir = join(root, `c${n++}`);
      await crashed(dir, 3);

      const one = spy();
      const skippedBefore = hostSyncStats().skipped;
      const first = await open(dir, one.hostFsync);
      const synced = [...one.synced.keys()];
      // Every file of the walks reached the host, and the second walk's fsyncs were skipped: about
      // one host fsync a file, where there were two. A file recovery writes (the WAL, pg_control,
      // the catalogs and tables the log touches) is dirty again, and synced again at its end.
      const total = [...one.synced.values()].reduce((a, b) => a + b, 0);
      expect(synced.length).toBeGreaterThan(900);
      expect(total).toBeLessThan(synced.length * 1.2);
      expect(hostSyncStats().skipped - skippedBefore).toBeGreaterThan(synced.length * 0.8);

      // Closed; then another process opens the directory and is killed, writing no table: the
      // next opening recovers again, and syncs the data directory again.
      await expect(first.close()).resolves.toBeUndefined();
      await crashed(dir, 0);
      // The same directory again, in this process: nothing is clean in the new instance, so
      // each file the first one synced reaches the host again.
      const two = spy();
      const second = await open(dir, two.hostFsync);
      try {
        const there = synced.filter((p) => existsSync(p));
        expect(there.length).toBeGreaterThan(900);
        expect(there.filter((p) => !two.synced.has(p))).toEqual([]);
      } finally {
        await second.close();
      }
    },
    T,
  );
});

describe("a power loss, simulated", () => {
  it(
    "every acknowledged commit is there after recovery from the files as they were last synced",
    async () => {
      const dir = join(root, `p${n++}`);
      // A data directory, closed cleanly: what the instance under test finds.
      await (await open(dir, (fd) => fsyncSync(fd))).close();
      const found = join(root, `found${n++}`);
      cpSync(dir, found, { recursive: true });

      // Each regular file's bytes when a host fsync of it returned.
      const lastSynced = new Map<string, Buffer>();
      const s = spy((fd, path) => {
        if (fstatSync(fd).isFile()) lastSynced.set(path, readFileSync(path));
      });
      const pg = await open(dir, s.hostFsync);
      const acknowledged: number[] = [];
      try {
        await pg.exec("CREATE TABLE notes (id int PRIMARY KEY)");
        for (let i = 1; i <= 30; i++) {
          await pg.query("INSERT INTO notes VALUES ($1)", [i]);
          acknowledged.push(i);
          // Checkpoints sync the data files and the commit log: some changed since the last one,
          // some not.
          if (i === 10 || i === 20) await pg.exec("CHECKPOINT");
        }

        // The power goes: what is on the disk is the directory as found, each file synced since
        // as it was then. A file made since and never synced is not there.
        const image = join(root, `image${n++}`);
        cpSync(found, image, { recursive: true });
        for (const [path, bytes] of lastSynced) {
          const to = join(image, relative(dir, path));
          mkdirSync(dirname(to), { recursive: true });
          writeFileSync(to, bytes);
        }
        const synced = [...lastSynced.keys()].map((p) => relative(dir, p));
        expect(synced.some((p) => p.startsWith("pg_wal/"))).toBe(true);
        expect(synced.some((p) => p.startsWith("base/"))).toBe(true);
        expect(synced.some((p) => p.startsWith("pg_xact/"))).toBe(true);

        const after = await PGlite.create({ dataDir: image });
        try {
          const r = await after.query<{ id: number }>("SELECT id FROM notes ORDER BY id");
          expect(r.rows.map((x) => x.id)).toEqual(acknowledged);
        } finally {
          await after.close();
        }
      } finally {
        await pg.close();
      }
    },
    T,
  );
});
