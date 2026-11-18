// `saveslot start` (06-cli §3 step 3, §6.2) where it meets another process starting at the same
// moment, and a home it cannot use: it waits for the other, and it never throws.

import { chmodSync, existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { start, stop } from "./commands.ts";
import { health } from "./local-request.ts";
import { lockDir, runDir, runService, socketFile } from "./service.ts";
import { TEXTS } from "./texts.ts";

/** Running as root, whom the permission bits do not bind (see the case that uses it). */
const AS_ROOT = process.getuid?.() === 0;

const T = 120_000;
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const roots: string[] = [];
// Each home holds a store (some 40 MB in a thousand files) and the removal is synchronous: under the
// load of the whole suite it can take longer than the default hook timeout.
afterAll(() => {
  for (const r of roots) {
    try {
      chmodSync(join(r, "home", "control"), 0o700);
    } catch {}
    rmSync(r, { recursive: true, force: true });
  }
}, T);

async function freshHome(): Promise<string> {
  const root = mkdtempSync(join(tmpdir(), "saveslot-start-"));
  roots.push(root);
  const home = join(root, "home");
  await initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: new Date().toISOString(),
  });
  return home;
}

function capture() {
  const out: string[] = [];
  const err: string[] = [];
  return { out, err, io: { out: (l: string) => out.push(l), err: (l: string) => err.push(l) } };
}

describe("start, while another process is starting the service", () => {
  it(
    "its own process loses the home's lock: it waits for the one that has it",
    async () => {
      const home = await freshHome();
      // The other process: holds the lock now, listens only later.
      const held = await osFileLock.acquire(lockDir(home));
      const c = capture();
      let onStarted = 0;
      const started = start(home, c.io, {
        onStarted: () => {
          onStarted += 1;
        },
      });
      // Its own process gives up on the lock (the service logs why) …
      const log = join(runDir(home), "saveslot.log");
      const until = Date.now() + 60_000;
      while (!(existsSync(log) && readFileSync(log, "utf8").includes("already_running"))) {
        if (Date.now() > until) throw new Error("the spawned service did not give up");
        await sleep(50);
      }
      await sleep(500);
      expect(await health(socketFile(home))).toBeUndefined();
      // … and only then does the other start listening.
      await held.release();
      const other = await runService({ home, version: "0.0.0", signals: false, log: () => {} });
      try {
        expect(await started).toBe(0);
        expect(c.out.join("\n")).toContain(`pid ${process.pid}`);
        // The service answering is the other's: this call did not start it.
        expect(onStarted).toBe(0);
        expect(c.err).toEqual([]);
      } finally {
        await other.stop();
      }
    },
    T,
  );
});

describe("start on a home it cannot use: a code and an exit, never a throw or a path", () => {
  it(
    "the home is a file",
    async () => {
      const root = mkdtempSync(join(tmpdir(), "saveslot-start-"));
      roots.push(root);
      const home = join(root, "home");
      writeFileSync(home, "not a directory");
      const c = capture();
      expect(await start(home, c.io)).toBe(7);
      expect(c.err).toEqual([TEXTS.startHomeUnusable("enotdir")]);
      expect(c.err[0]).not.toContain(root);
    },
    T,
  );

  // Root reads control/ whatever its mode: this case is of a user the bits bind, skipped as root.
  it.skipIf(AS_ROOT)(
    "control/ cannot be read",
    async () => {
      const home = await freshHome();
      chmodSync(join(home, "control"), 0o000);
      const c = capture();
      const code = await start(home, c.io);
      chmodSync(join(home, "control"), 0o700);
      expect(code).toBe(7);
      expect(c.err).toEqual([TEXTS.startHomeUnusable("eacces")]);
      expect(c.err[0]).not.toContain(home);
      expect(await health(socketFile(home))).toBeUndefined();
    },
    T,
  );

  it(
    "run/ is a file",
    async () => {
      const home = await freshHome();
      rmSync(runDir(home), { recursive: true, force: true });
      writeFileSync(runDir(home), "not a directory");
      const c = capture();
      expect(await start(home, c.io)).toBe(7);
      expect(c.err).toEqual([TEXTS.startHomeUnusable("eexist")]);
      expect(c.err[0]).not.toContain(home);
      await stop(home, { out: () => {}, err: () => {} }).catch(() => {});
    },
    T,
  );
});

describe("start on a store of another storage format: what to do, said and logged", () => {
  /**
   * The home's store with its storage format version set to `v` (02-architecture §8; `meta`'s
   * `storage_format`). This saveslot's format is 2: 1 is an older, development one, 3 a newer one.
   */
  async function withFormat(home: string, v: number) {
    const store = await testBackend().open({ kind: "pglite", dir: join(home, "data") }, {});
    try {
      await store.write((tx) =>
        tx.query("UPDATE meta SET value = $1 WHERE key = $2", [String(v), "storage_format"]),
      );
    } finally {
      await store.close();
    }
  }

  for (const [label, v, text, said] of [
    ["an older, development format", 1, TEXTS.startFormatTooOld, "initialize the store anew"],
    ["a newer format", 3, TEXTS.startFormatTooNew, "newer"],
  ] as const) {
    it(
      `a store of ${label}: exit 7, the text for it, and the backend's words in the log`,
      async () => {
        const home = await freshHome();
        await withFormat(home, v);
        const c = capture();
        expect(await start(home, c.io)).toBe(7);
        expect(c.err).toEqual([text]);
        const log = readFileSync(join(runDir(home), "saveslot.log"), "utf8");
        expect(log).toContain(said);
        await stop(home, { out: () => {}, err: () => {} }).catch(() => {});
      },
      T,
    );
  }
});

describe("start, asked to stop while it waits (a signal to setup)", () => {
  it(
    "no longer waits for the service: 1; one it started is said once, one running already is not",
    async () => {
      const home = await freshHome();
      try {
        const asked = new AbortController();
        asked.abort();
        expect(await start(home, capture().io, { stop: asked.signal })).toBe(1);
        // The process it spawned is left to start; once ready, a start finds it running.
        const until = Date.now() + 60_000;
        while ((await health(socketFile(home)))?.state !== "ready") {
          if (Date.now() > until) throw new Error("the spawned service did not get ready");
          await sleep(100);
        }
        let onStarted = 0;
        expect(
          await start(home, capture().io, {
            onStarted: () => {
              onStarted += 1;
            },
          }),
        ).toBe(0);
        expect(onStarted).toBe(0);
        // Stopped, and started by this call: said once.
        expect(await stop(home, capture().io)).toBe(0);
        expect(
          await start(home, capture().io, {
            onStarted: () => {
              onStarted += 1;
            },
          }),
        ).toBe(0);
        expect(onStarted).toBe(1);
      } finally {
        await stop(home, capture().io);
      }
    },
    T,
  );
});
