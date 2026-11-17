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
afterAll(() => {
  for (const r of roots) {
    try {
      chmodSync(join(r, "home", "control"), 0o700);
    } catch {}
    rmSync(r, { recursive: true, force: true });
  }
});

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
      const started = start(home, c.io);
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
