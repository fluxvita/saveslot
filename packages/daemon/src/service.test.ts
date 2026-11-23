// The local service process (02-architecture §7, §8; 06-cli §3, §4.1, §8.1), run as real child
// processes where the process is what is tested (the home lock, SIGKILL, SIGTERM, permissions),
// in-process where a store is needed by hand (opening refusals, a DB Worker that dies).
//
// Opening a new data directory costs seconds, so one template home is made once and each case
// copies it; checks that fit one start share it.

import { type ChildProcess, spawn } from "node:child_process";
import {
  chmodSync,
  cpSync,
  existsSync,
  linkSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { request } from "node:http";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  Credentials,
  initLocalHome,
  newToken,
  sessionFile,
  tokenHash,
} from "@fluxvita/saveslot-service";
import { anchorFileText, createLocalHome } from "@fluxvita/saveslot-service/testing";
import { osFileLock, type PgliteTenantStore } from "@fluxvita/saveslot-store-pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { serviceCommand } from "./commands.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { httpDriver } from "./http-driver.fixture.ts";
import { main } from "./main.ts";
import { lastFailureFile, lockDir, pidFile, runService, socketFile } from "./service.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const BIN = new URL("./bin.ts", import.meta.url).pathname;
const root = mkdtempSync(join(tmpdir(), "ssd-"));
const template = join(root, "t");
let n = 0;

beforeAll(async () => {
  await createLocalHome(template, testBackend());
});

afterAll(() => rmSync(root, { recursive: true, force: true }));

/** A copy of the template home, at `h` or a new path. */
function home(h = join(root, String(n++))): string {
  cpSync(template, h, { recursive: true });
  // A copy makes its directories with the default mode: the home and its control files are set
  // back as init makes them (directories 0700, files 0600).
  chmodSync(h, 0o700);
  chmodSync(join(h, "control"), 0o700);
  for (const f of ["credentials.json", "tenant.json"]) chmodSync(join(h, "control", f), 0o600);
  return h;
}

interface Child {
  readonly proc: ChildProcess;
  readonly exit: Promise<{ code: number | null; signal: NodeJS.Signals | null }>;
  readonly stderr: () => string;
  /** Whether it has exited. */
  readonly gone: () => boolean;
}

/** Every process a case started: one still running when the case ends, however it ended, is killed. */
const children = new Set<Child>();

afterEach(async () => {
  const left = [...children].filter((c) => !c.gone());
  children.clear();
  for (const c of left) c.proc.kill("SIGKILL");
  await Promise.all(left.map((c) => c.exit));
});

function start(h: string): Child {
  // Wasm code GC off, as the test forks have it (vitest.config.ts, nodejs/node#66366).
  const proc = spawn(
    process.execPath,
    ["--no-wasm-code-gc", "--conditions=source", BIN, "--home", h],
    {
      stdio: ["ignore", "ignore", "pipe"],
    },
  );
  let err = "";
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => {
    err += c;
  });
  let gone = false;
  const exit = new Promise<{ code: number | null; signal: NodeJS.Signals | null }>((resolve) =>
    proc.on("exit", (code, signal) => {
      gone = true;
      resolve({ code, signal });
    }),
  );
  const child = { proc, exit, stderr: () => err, gone: () => gone };
  children.add(child);
  return child;
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

/**
 * Health once its state is one of `states`, from the process `p` started. No fixed bound: a start
 * after a crash is slow under load, and how slow grows with the load. It waits while `p` runs,
 * and gives up at once when `p` exits; the case's own timeout bounds a process that hangs.
 */
async function until(h: string, states: readonly string[], p: Child) {
  for (;;) {
    const r = await health(h);
    if (r !== undefined && states.includes(String(r.body["state"]))) return r.body;
    if (p.gone())
      throw new Error(`no health in ${states.join("/")}: the process exited\n${p.stderr()}`);
    await new Promise((r) => setTimeout(r, 50));
  }
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
    const ready = await until(h, ["ready"], a);
    expect(Object.keys(ready).sort()).toEqual(["pid", "since", "state", "version", "writer_lock"]);
    expect(ready).toMatchObject({ state: "ready", pid: a.proc.pid, version: "0.0.0" });
    expect(readFileSync(pidFile(h), "utf8")).toBe(`${a.proc.pid}\n`);
    expect(statSync(join(h, "run")).mode & 0o777).toBe(0o700);
    expect(statSync(socketFile(h)).mode & 0o777).toBe(0o600);
    expect(statSync(pidFile(h)).mode & 0o777).toBe(0o600);

    // A second process on the same home: refused by the home's lock, before touching anything.
    const b = start(h);
    expect(await b.exit).toEqual({ code: 1, signal: null });
    expect(b.stderr()).toMatch(/not_started reason=already_running/);
    expect(await until(h, ["ready"], a)).toMatchObject({ pid: a.proc.pid });

    // Killed: the kernel drops both locks; the socket and pid files stay behind.
    a.proc.kill("SIGKILL");
    expect(await a.exit).toEqual({ code: null, signal: "SIGKILL" });
    expect(existsSync(socketFile(h))).toBe(true);
    expect(existsSync(pidFile(h))).toBe(true);

    // A new process takes the lock, replaces the stale socket and pid, opens the tenant (crash
    // recovery is the store's), and serves.
    const c = start(h);
    expect(await until(h, ["ready"], c)).toMatchObject({ state: "ready", pid: c.proc.pid });
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

  it("comes back after each of three SIGKILLs in a row: a slot's derived table is read and refreshed, a document's rules compile", async () => {
    // A process started after one that did not exit cleanly loads the restricted SQL parser
    // when it opens the tenant, as the first one did, and serves the derived tables as before.
    const h = join(root, `crash-${n++}`);
    await initLocalHome({
      home: h,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    const session = readFileSync(sessionFile(h), "utf8").trim();
    const call = (op: Parameters<ReturnType<typeof httpDriver>>[1], params: unknown) =>
      httpDriver(() => h)(session, op, params as never);
    const withRule = (slot: string, table: string) => ({
      ...LEDGER,
      slot,
      tables: [
        { ...LEDGER.tables[0], name: table },
        {
          name: `${table}_by_day`,
          kind: "derived",
          description: "notes a day",
          rule: {
            sql: `SELECT date AS day, count(note) AS notes FROM ${table} GROUP BY 1`,
            time_dependency: "bucketed",
          },
          fields: [
            { name: "day", description: "the day" },
            { name: "notes", description: "notes that day" },
          ],
        },
      ],
    });
    const insert = (table: string, note: string) =>
      call("write", {
        sv: 1,
        ops: [{ intent: "insert", table, set: { date: "2026-11-02", note } }],
      });
    const notes = async (table: string) =>
      (
        (await call("query", { table })) as {
          result: { rows: { values: unknown; input_marks: unknown }[] };
        }
      ).result.rows.map((r) => [r.values, (r.input_marks as { disputed: number }).disputed]);

    let p = start(h);
    expect(await until(h, ["ready"], p)).toMatchObject({ pid: p.proc.pid });
    expect(await call("schema_draft", { document: withRule("ledger", "expenses") })).toMatchObject({
      result: { outcome: "applied" },
    });
    expect(await insert("expenses", "tea")).toMatchObject({ result: { status: "saved" } });
    for (let i = 0; i < 3; i++) {
      p.proc.kill("SIGKILL");
      expect(await p.exit).toEqual({ code: null, signal: "SIGKILL" });
      p = start(h);
      expect(await until(h, ["ready"], p), `restart ${i}`).toMatchObject({ pid: p.proc.pid });
    }
    // The derived table as before; a write refreshes it; a new document's rule compiles.
    expect(await notes("expenses_by_day")).toEqual([[{ day: "2026-11-02", notes: "1" }, 0]]);
    expect(await insert("expenses", "bun")).toMatchObject({
      result: {
        derived: [
          {
            table: "ledger.expenses_by_day",
            key: { day: "2026-11-02" },
            field: "notes",
            before: "1",
            after: "2",
          },
        ],
      },
    });
    expect(await notes("expenses_by_day")).toEqual([[{ day: "2026-11-02", notes: "2" }, 0]]);
    expect(await call("schema_draft", { document: withRule("health", "meals") })).toMatchObject({
      result: { outcome: "applied" },
    });
    p.proc.kill("SIGTERM");
    expect(await p.exit).toEqual({ code: 0, signal: null });
    // Four starts, three of them through crash recovery: slower than one start under a full
    // run's load.
  }, 240_000);

  it("does not serve when the anchor says the log went back, and still stops cleanly", async () => {
    const h = home();
    writeFileSync(join(h, "control", "anchor.json"), anchorFileText({ highWater: 5 }));
    const p = start(h);
    expect(await until(h, ["failed"], p)).toMatchObject({
      state: "failed",
      reason: "log_behind_high_water",
      pid: p.proc.pid,
    });
    p.proc.kill("SIGTERM");
    // Stopped cleanly, and non-zero: the service had failed.
    expect(await p.exit).toEqual({ code: 1, signal: null });
    expect(highWater(h)).toBe(5);
  });
});

describe("the service in process", () => {
  it("rolls back an import found in progress whose event is not in the log, then serves", async () => {
    // 02-architecture §8 «重入»: the marker without the import's event in the log is an import
    // stopped before its swap; the staging storage goes and the marker is cleared.
    const h = home();
    writeFileSync(
      join(h, "control", "anchor.json"),
      anchorFileText({ highWater: 1, importInProgress: "im_1" }),
    );
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([s.state, s.reason]).toEqual(["ready", undefined]);
    const entry = Object.values(
      JSON.parse(readFileSync(join(h, "control", "anchor.json"), "utf8")).tenants as Record<
        string,
        Record<string, unknown>
      >,
    )[0];
    expect(entry?.["importInProgress"]).toBeUndefined();
    await s.stop();
  });

  it.each([
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
    expect(s.served).toBe(false);
    // The tenant's storage was closed again: another opener can take it.
    const store = await testBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
    await store.close();
    await s.stop();
    // A service that failed exits non-zero, though it was stopped.
    expect(await s.exited).toEqual({ code: 1, reason });
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

  it("its home moved away and another service at that path: losing the storage, it exits without removing or writing anything there", async () => {
    // Someone moves the home of a running service away and makes a new home at the old path. The
    // new service opens the storage at the same path; the old one finds it taken
    // (ownership_lost) at its next write and exits. The files at the path are the new service's:
    // the old one leaves them, and writes no failure there for `status` to show.
    // Both homes are copies of one template: one tenant, and the session below in both, so that
    // the old service, which checks a session against the credentials file at the home's path,
    // takes the call made after the move.
    const token = newToken("session");
    const withSession = (at: string) => {
      home(at);
      Credentials.create(at, tokenHash(token));
    };
    const h = join(root, `moved-${n++}`);
    withSession(h);
    const quiet = { version: "t", signals: false, log: () => {} } as const;
    const old = await runService({ home: h, ...quiet, probeMs: 50, readsFlushMs: 50 });
    expect(old.state).toBe("ready");
    const moved = `${h}-moved`;
    renameSync(h, moved);
    withSession(h);
    const now = await runService({ home: h, ...quiet });
    try {
      expect(now.state).toBe("ready");
      const socket = statSync(socketFile(h)).ino;
      const pid = statSync(pidFile(h)).ino;
      const anchorFile = join(h, "control", "anchor.json");
      const anchorText = () => (existsSync(anchorFile) ? readFileSync(anchorFile, "utf8") : null);
      const anchor = anchorText();
      // A read through the old service's socket (it moved with its home): its record is
      // flushed in a write, which finds the storage at the home's path taken.
      await httpDriver(() => moved)(token, "catalog", {});
      expect(await old.exited).toEqual({ code: 1, reason: "ownership_lost" });
      expect(statSync(socketFile(h)).ino).toBe(socket);
      expect(statSync(pidFile(h)).ino).toBe(pid);
      expect(existsSync(lastFailureFile(h))).toBe(false);
      expect(anchorText()).toBe(anchor);
      // And the new service still answers there.
      expect((await health(h))?.body).toMatchObject({ state: "ready" });
    } finally {
      await now.stop();
    }
    // Its own it removes, as before; `status` shows no failure of the old service.
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    expect(existsSync(lastFailureFile(h))).toBe(false);
    let said = "";
    const io = { out: (l: string) => (said += `${l}\n`), err: (l: string) => (said += `${l}\n`) };
    await serviceCommand("status", ["--home", h], io);
    expect(said).not.toContain("ownership_lost");
  });

  it("a socket left under a process's own name: removed at start when nothing answers on it, kept when something does", async () => {
    const h = home();
    const run = join(h, "run");
    mkdirSync(run, { mode: 0o700 });
    // A stale one: a socket file no process listens on (closing a listener unlinks only the
    // path it was bound at, so the link stays).
    const gone = createServer();
    await new Promise<void>((r) => gone.listen(join(run, "x.sock"), r));
    linkSync(join(run, "x.sock"), join(run, "99999.sock"));
    await new Promise<void>((r) => gone.close(() => r()));
    const live = createServer((c) => c.end());
    await new Promise<void>((r) => live.listen(join(run, "88888.sock"), r));
    try {
      const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
      expect(s.state).toBe("ready");
      expect(existsSync(join(run, "99999.sock"))).toBe(false);
      expect(existsSync(join(run, "88888.sock"))).toBe(true);
      // Its own name is not left: the socket is at run/saveslot.sock only.
      expect(existsSync(join(run, `${process.pid}.sock`))).toBe(false);
      await s.stop();
    } finally {
      await new Promise<void>((r) => live.close(() => r()));
    }
  });

  it("a socket at the path that a live service answers on: not taken over, though the lock is free", async () => {
    const h = home();
    mkdirSync(join(h, "run"), { mode: 0o700 });
    const other = createServer((c) => c.end());
    await new Promise<void>((r) => other.listen(socketFile(h), r));
    try {
      const ino = statSync(socketFile(h)).ino;
      const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
      expect(await s.exited).toEqual({ code: 1, reason: "already_running" });
      expect(statSync(socketFile(h)).ino).toBe(ino);
      expect(existsSync(pidFile(h))).toBe(false);
      expect(existsSync(lastFailureFile(h))).toBe(false);
      // The lock was given back.
      const again = await osFileLock.acquire(lockDir(h));
      await again.release();
    } finally {
      await new Promise<void>((r) => other.close(() => r()));
    }
  });

  // One case each (each its own copy of the template home): together they took half the test
  // time limit, and a full run in parallel went past it.
  const credentialCases: [string, string, (h: string) => void][] = [
    [
      "credentials.json readable by others",
      "credentials_permissions",
      (h) => chmodSync(join(h, "control", "credentials.json"), 0o644),
    ],
    [
      "control/ open to others",
      "credentials_permissions",
      (h) => chmodSync(join(h, "control"), 0o755),
    ],
    ["the home open to others", "credentials_permissions", (h) => chmodSync(h, 0o777)],
    [
      "credentials/ open to others",
      "credentials_permissions",
      (h) => {
        mkdirSync(join(h, "credentials"), { mode: 0o777 });
        chmodSync(join(h, "credentials"), 0o777);
      },
    ],
    [
      "the session file readable by others",
      "credentials_permissions",
      (h) => {
        mkdirSync(join(h, "credentials"), { mode: 0o700 });
        writeFileSync(join(h, "credentials", "session"), "x\n", { mode: 0o644 });
      },
    ],
    [
      "credentials.json a link to a file elsewhere, itself private",
      "credentials_permissions",
      (h) => {
        const real = join(h, "elsewhere.json");
        renameSync(join(h, "control", "credentials.json"), real);
        symlinkSync(real, join(h, "control", "credentials.json"));
      },
    ],
    [
      "credentials.json not of its form",
      "credentials_corrupt",
      (h) => writeFileSync(join(h, "control", "credentials.json"), "{}", { mode: 0o600 }),
    ],
  ];
  for (const [what, reason, spoil] of credentialCases) {
    it(`does not serve with credentials open to others, or not of their form: ${what}`, async () => {
      const h = home();
      spoil(h);
      const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
      expect([s.state, s.reason]).toEqual(["failed", reason]);
      await s.stop();
    });
  }

  it("removes the temporary files a killed write left in control/ and credentials/", async () => {
    const h = home();
    mkdirSync(join(h, "credentials"), { mode: 0o700 });
    const stale = [
      join(h, "control", `.saveslot-${"a".repeat(32)}.tmp`),
      join(h, "credentials", `.saveslot-${"b".repeat(32)}.tmp`),
    ];
    for (const f of stale) writeFileSync(f, "left behind\n", { mode: 0o600 });
    const other = join(h, "control", "keep.tmp");
    writeFileSync(other, "not ours\n", { mode: 0o600 });
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    try {
      expect(s.state).toBe("ready");
      expect(stale.map((f) => existsSync(f))).toEqual([false, false]);
      expect(existsSync(other)).toBe(true);
    } finally {
      await s.stop();
    }
  });

  it("does not serve an empty tenant storage", async () => {
    const h = join(root, String(n++));
    cpSync(join(template, "control"), join(h, "control"), { recursive: true });
    const created = await testBackend().open(
      { kind: "pglite", dir: join(h, "data") },
      { create: true },
    );
    await created.close();
    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([s.state, s.reason]).toEqual(["failed", "tenant_empty"]);
    await s.stop();
  });

  it("opens the data directory init recorded; that directory gone, it stops and makes nothing", async () => {
    const h = join(root, `elsewhere-${n++}`);
    const data = join(root, `data-${n++}`);
    await initLocalHome({
      home: h,
      dataDir: data,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    expect(JSON.parse(readFileSync(join(h, "control", "tenant.json"), "utf8")).data_dir).toBe(data);
    expect(existsSync(join(h, "data"))).toBe(false);

    const s = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect(s.state).toBe("ready");
    await s.stop();

    const moved = `${data}-moved`;
    renameSync(data, moved);
    const gone = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect([gone.state, gone.reason]).toEqual(["failed", "store_not_found"]);
    // Failed before it served: under a start-at-login job it exits 0 (./main.ts `--supervised`).
    expect([s.served, gone.served]).toEqual([true, false]);
    await gone.stop();
    expect(existsSync(data)).toBe(false);
    expect(existsSync(join(h, "data"))).toBe(false);

    // A relative data directory is refused before the home is made.
    const relative = join(root, `relative-${n++}`);
    await expect(
      initLocalHome({
        home: relative,
        dataDir: "data",
        backend: testBackend(),
        lock: osFileLock,
        now: new Date().toISOString(),
      }),
    ).rejects.toThrow(TypeError);
    expect(existsSync(relative)).toBe(false);

    // Back in its place, it serves again.
    renameSync(moved, data);
    const back = await runService({ home: h, version: "t", signals: false, log: () => {} });
    expect(back.state).toBe("ready");
    await back.stop();
  });

  it("reports the store's own refusal: the data directory held by another opener", async () => {
    const h = home();
    const other = await testBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
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
    const store = await testBackend().open({ kind: "pglite", dir: join(h, "data") }, {});
    await store.close();
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    await started;
  });

  it("opens the tenant with fsync passed to the host (the backend's default, not the tests')", async () => {
    const s = await runService({ home: home(), version: "t", signals: false, log: () => {} });
    try {
      expect(s.state).toBe("ready");
      const store = s.tenant?.store as PgliteTenantStore | undefined;
      if (store === undefined) throw new Error("no open tenant");
      const settings = await store.read((tx) =>
        tx.query<{ name: string; setting: string }>(
          "SELECT name, setting FROM pg_settings WHERE name IN ('fsync', 'wal_sync_method') ORDER BY name",
        ),
      );
      expect(settings.rows).toEqual([
        { name: "fsync", setting: "on" },
        { name: "wal_sync_method", setting: "fsync" },
      ]);
      // Opening commits the ownership epoch; with "host-fsync" that commit reached the host.
      expect((await store.hostSyncStats()).wal).toBeGreaterThan(0);
    } finally {
      await s.stop();
    }
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
    // Failed while serving: the one failure a start-at-login job starts it again for.
    expect(s.served).toBe(true);
    expect(lines.filter((l) => / ready$/.test(l))).toHaveLength(1);
    expect(existsSync(socketFile(h))).toBe(false);
    expect(existsSync(pidFile(h))).toBe(false);
    const again = await osFileLock.acquire(lockDir(h));
    await again.release();
  });

  it("/health says the writer lock is held; log.end gives the newest event's seq and recorded time", async () => {
    const h = join(root, `log-end-${n++}`);
    const genesis = "2026-11-18T08:00:00.000Z";
    await initLocalHome({ home: h, backend: testBackend(), lock: osFileLock, now: genesis });
    const session = readFileSync(sessionFile(h), "utf8").trim();
    // Later records at a clock set ahead: the log's end moves to that time.
    const at = "2030-01-01T00:00:00.000Z";
    const s = await runService({
      home: h,
      version: "t",
      signals: false,
      clock: () => at,
      log: () => {},
    });
    try {
      const body = (await health(h))?.body;
      expect(body).toMatchObject({ state: "ready", writer_lock: "held" });
      expect(Object.keys(body ?? {}).sort()).toEqual([
        "pid",
        "since",
        "state",
        "version",
        "writer_lock",
      ]);
      const call = httpDriver(() => h);
      expect(await call(session, "log.end", {} as never)).toEqual({
        result: { seq: 1, recorded_at: genesis },
      });
      expect(
        await call(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never),
      ).toMatchObject({ result: { outcome: "applied" } });
      const end = (await call(session, "log.end", {} as never)) as {
        result: { seq: number; recorded_at: string };
      };
      expect(end.result.recorded_at).toBe(at);
      expect(end.result.seq).toBeGreaterThan(1);
    } finally {
      await s.stop();
    }
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
