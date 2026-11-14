// The local service process (02-architecture §7, §8; 06-cli §3, §4.1, §8.1), run as real child
// processes where the process is what is tested (the home lock, SIGKILL, SIGTERM, permissions),
// in-process where a store is needed by hand (opening refusals, a DB Worker that dies).
//
// Opening a new data directory costs seconds, so one template home is made once and each case
// copies it; checks that fit one start share it.

import { type ChildProcess, spawn } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { anchorFileText, createLocalHome } from "@fluxvita/saveslot-service/testing";
import { osFileLock, PgliteBackend, type PgliteTenantStore } from "@fluxvita/saveslot-store-pglite";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { main } from "./main.ts";
import { lockDir, pidFile, runService, socketFile } from "./service.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const BIN = new URL("./bin.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "ssd-"));
const template = join(root, "t");
let n = 0;

beforeAll(async () => {
  await createLocalHome(template, new PgliteBackend());
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A copy of the template home. */
function home(): string {
  const h = join(root, String(n++));
  cpSync(template, h, { recursive: true });
  return h;
}

interface Child {
  readonly proc: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
}

function start(h: string): Child {
  const proc = spawn(process.execPath, ["--conditions=source", BIN, "--home", h], {
    stdio: ["ignore", "ignore", "pipe"],
  });
  let err = "";
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => {
    err += c;
  });
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.on("exit", (code, signal) => resolve({ code, signal })),
  );
  return { proc, exit, stderr: () => err };
}

function health(h: string): Promise<{ status: number; body: Record<string, unknown> } | undefined> {
  return new Promise((resolve) => {
    const req = request({ socketPath: socketFile(h), path: "/health" }, (res) => {
      let body = "";
      res.setEncoding("utf8");
      res.on("data", (c: string) => {
        body += c;
      });
      res.on("end", () => resolve({ status: res.statusCode ?? 0, body: JSON.parse(body) }));
    });
    req.on("error", () => resolve(undefined));
    req.end();
  });
}

/** Health once its state is one of `states`. */
async function until(h: string, states: readonly string[]) {
  for (let i = 0; i < 400; i++) {
    const r = await health(h);
    if (r !== undefined && states.includes(String(r.body["state"]))) return r.body;
    await new Promise((r) => setTimeout(r, 50));
  }
  throw new Error(`no health in ${states.join("/")}`);
}

const highWater = (h: string) =>
  Object.values(
    JSON.parse(readFileSync(join(h, "control", "anchor.json"), "utf8")).tenants as Record<
      string,
      { highWater: number }
    >,
  )[0]?.highWater;

describe("the service process", () => {
  it("starts, refuses a second process, comes back after SIGKILL, and stops on SIGTERM", async () => {
    const h = home();
    const a = start(h);
    const ready = await until(h, ["ready"]);
    expect(Object.keys(ready).sort()).toEqual(["pid", "since", "state", "version"]);
    expect(ready).toMatchObject({ state: "ready", pid: a.proc.pid, version: "0.0.0" });
    expect(readFileSync(pidFile(h), "utf8")).toBe(`${a.proc.pid}\n`);
    expect(statSync(join(h, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(socketFile(h)).mode & 0o777).toBe(0o600);
    expect(statSync(pidFile(h)).mode & 0o777).toBe(0o600);

    // A second process on the same home: refused by the home's lock, before touching anything.
    const b = start(h);
    expect(await b.exit).toEqual({ code: 1, signal: null });
    expect(b.stderr()).toMatch(/not_started reason=already_running/);
    expect(await until(h, ["ready"])).toMatchObject({ pid: a.proc.pid });

    // Killed: the kernel drops both locks; the socket and pid files stay behind.
    a.proc.kill("SIGKILL");
    expect(await a.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(existsSync(socketFile(h))).toBe(true);
    expect(existsSync(pidFile(h))).toBe(true);

    // A new process takes the lock, replaces the stale socket and pid, opens the tenant (crash
    // recovery is the store's), and serves.
    const c = start(h);
    expect(await until(h, ["ready"])).toMatchObject({ state: "ready", pid: c.proc.pid });
    expect(readFileSync(pidFile(h), "utf8")).toBe(`${c.proc.pid}\n`);

    c.proc.kill("SIGTERM");
    expect(await c.exit).toEqual({ code: 0, signal: null });
    expect(c.stderr()).toMatch(/ ready\n/);
    expect(c.stderr()).toMatch(/ stopped code=0\n/);
    // Log lines name no path.
    expect(c.stderr()).not.toContain(h);
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    // The lock file is only a lock object: never removed.
    expect(existsSync(join(lockDir(h), "saveslot.lock"))).toBe(true);
    // The high water moved up to the log's end (the genesis event).
    expect(highWater(h)).toBe(1);
    // Released: the next process could take the home again.
    const again = await osFileLock.acquire(lockDir(h));
    await again.release();
  });

  it("does not serve when the anchor says the log went back, and still stops cleanly", async () => {
    const h = home();
    writeFileSync(join(h, "control", "anchor.json"), anchorFileText({ highWater: 5 }));
    const p = start(h);
    expect(await until(h, ["failed"])).toMatchObject({
      state: "failed",
      reason: "log_behind_high_water",
      pid: p.proc.pid,
    });
    p.proc.kill("SIGTERM");
    expect(await p.exit).toEqual({ code: 0, signal: null });
    expect(highWater(h)).toBe(5);
  });
});

describe("the service in process", () => {
  it.each([
    [
      "an import in progress",
      anchorFileText({ highWater: 1, importInProgress: "im_1" }),
      "import_in_progress",
    ],
    [
      "a restore in progress",
      anchorFileText({ highWater: 1, restoreInProgress: "rs_1" }),
      "restore_in_progress",
    ],
  ])("does not serve with %s", async (_, anchor, reason) => {
    const h = home();
    writeFileSync(join(h, "control", "anchor.json"), anchor);
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([s.state, s.reason]).toEqual(["failed", reason]);
    // The tenant's storage was closed again: another opener can take it.
    const store = await new PgliteBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
    await store.close();
    await s.stop();
    expect(await s.exited).toEqual({ code: 0 });
  });

  it("does not serve a home that was not initialized, or whose tenant directory is corrupt", async () => {
    const absent = await runService({
      home: join(root, "absent"),
      version: "t",
      signals: false,
      log: () => {},
    });
    expect(await absent.exited).toEqual({ code: 1, reason: "not_initialized" });
    expect(existsSync(join(root, "absent"))).toBe(false);

    const h = home();
    writeFileSync(join(h, "control", "tenant.json"), "{}");
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([s.state, s.reason]).toEqual(["failed", "tenant_directory_corrupt"]);
    await s.stop();
  });

  it("does not serve an empty tenant storage", async () => {
    const h = join(root, String(n++));
    cpSync(join(template, "control"), join(h, "control"), { recursive: true });
    const created = await new PgliteBackend().open(
      { kind: "pglite", dir: join(h, "data") },
      { create: true },
    );
    await created.close();
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([s.state, s.reason]).toEqual(["failed", "tenant_empty"]);
    await s.stop();
  });

  it("reports the store's own refusal: the data directory held by another opener", async () => {
    const h = home();
    const other = await new PgliteBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
    try {
      const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
      expect([s.state, s.reason]).toEqual(["failed", "store_locked"]);
      await s.stop();
    } finally {
      await other.close();
    }
  });

  it("a stop while the tenant opens closes the storage before releasing the home", async () => {
    const h = home();
    let listening!: (exited: Promise<unknown>) => void;
    const exited = new Promise<Promise<unknown>>((r) => {
      listening = r;
    });
    const started = runService({
      home: h,
      version: "t",
      signals: false,
      log: () => {},
      onListening: (svc) => {
        expect(svc.state).toBe("starting");
        listening(svc.exited);
        void svc.stop();
      },
    });
    // Only `exited`, not runService's own promise: the moment the service says it has exited, the
    // next process must find the home and the data directory free.
    expect(await await exited).toEqual({ code: 0 });
    const homeLock = await osFileLock.acquire(lockDir(h));
    await homeLock.release();
    const store = await new PgliteBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
    await store.close();
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    await started;
  });

  it("fails and exits 1 when the DB Worker dies, without reopening the database", async () => {
    const h = home();
    const lines: string[] = [];
    const s = await runService({
      home: h,
      version: "t",
      signals: false,
      probeMs: 50,
      log: (l) => lines.push(l),
    });
    expect(s.state).toBe("ready");
    const store = s.tenant?.store as PgliteTenantStore | undefined;
    if (store === undefined) throw new Error("no open tenant");
    await store.terminateWorker();
    expect(await s.exited).toEqual({ code: 1, reason: "worker_failed" });
    expect(s.state).toBe("failed");
    expect(lines.filter((l) => / ready$/.test(l))).toHaveLength(1);
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    const again = await osFileLock.acquire(lockDir(h));
    await again.release();
  });

  it("main refuses unknown arguments", async () => {
    const write = vi.spyOn(process.stderr, "write").mockImplementation(() => true);
    try {
      expect(await main(["--port", "1"])).toBe(2);
      expect(await main(["extra"])).toBe(2);
    } finally {
      write.mockRestore();
    }
  });
});
