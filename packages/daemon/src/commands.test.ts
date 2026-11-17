// The service commands with real processes (06-cli §3 steps 2–3, §4.1, §6.2): init and its
// refusals, start in the background and again, status, stop and the cases where stop sends no
// signal, and what the background log holds.

import { spawn } from "node:child_process";
import { mkdtempSync, readFileSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { type CommandIO, logFile, looksSynced, serviceCommand } from "./commands.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { httpRequest } from "./http-driver.fixture.ts";
import { health } from "./local-request.ts";
import { lockDir, pidFile, socketFile } from "./service.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "ssc-"));
let n = 0;
const started: string[] = [];

afterEach(async () => {
  // Whatever a case left running is stopped.
  for (const h of started.splice(0)) await run("stop", h);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function run(name: "init" | "start" | "stop" | "status", home: string, ...args: string[]) {
  const out: string[] = [];
  const err: string[] = [];
  const io: CommandIO = { out: (l) => out.push(l), err: (l) => err.push(l) };
  const code = await serviceCommand(name, ["--home", home, ...args], io);
  if (name === "start" && code === 0) started.push(home);
  return { code, out: out.join("\n"), err: err.join("\n") };
}

async function initialized(): Promise<string> {
  const h = join(root, String(n++));
  const r = await run("init", h);
  expect(r.code).toBe(0);
  return h;
}

const alive = (pid: number) => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

describe("init", () => {
  it("makes the home; again, or while the service runs, refuses with 5 and changes nothing", async () => {
    const h = await initialized();
    const token = readFileSync(sessionFile(h), "utf8");
    expect(statSync(sessionFile(h)).mode & 0o777).toBe(0o600);

    const again = await run("init", h);
    expect(again.code).toBe(5);
    expect(again.err).toContain("initialized already");

    expect((await run("start", h)).code).toBe(0);
    const running = await run("init", h, "--rotate-session");
    expect(running.code).toBe(5);
    expect(running.err).toContain("running");
    expect(readFileSync(sessionFile(h), "utf8")).toBe(token);

    expect((await run("stop", h)).code).toBe(0);
    expect((await run("init", h, "--rotate-session")).code).toBe(0);
    expect(readFileSync(sessionFile(h), "utf8")).not.toBe(token);
  });

  it("names a folder a sync service keeps", () => {
    expect(looksSynced("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/s")).toBe(true);
    expect(looksSynced("/Users/a/Library/CloudStorage/Dropbox/s")).toBe(true);
    expect(looksSynced("/home/a/Dropbox/s")).toBe(true);
    expect(looksSynced("/home/a/.saveslot/data")).toBe(false);
    expect(looksSynced("/home/a/Dropboxes/s")).toBe(false);
  });

  it("an unknown option is a usage error (2)", async () => {
    const r = await run("init", join(root, "x"), "--data-dir", "/tmp/elsewhere");
    expect(r.code).toBe(2);
  });
});

describe("start, status, stop", () => {
  it("starts in the background, says so again, stops; stop again finds nothing running", async () => {
    const h = await initialized();
    const first = await run("start", h);
    expect(first.code).toBe(0);
    const ready = await health(socketFile(h));
    expect(ready?.state).toBe("ready");
    const pid = ready?.pid as number;
    expect(first.out).toContain(`pid ${pid}`);
    expect(Number(readFileSync(pidFile(h), "utf8"))).toBe(pid);

    const second = await run("start", h);
    expect(second.code).toBe(0);
    expect(second.out).toContain("running already");
    expect((await health(socketFile(h)))?.pid).toBe(pid);

    const st = await run("status", h);
    expect(st.code).toBe(0);
    expect(st.out).toContain("ready");
    expect(st.out).toContain("pending   0");

    const stopped = await run("stop", h);
    expect(stopped.code).toBe(0);
    expect(stopped.out).toContain(`pid ${pid}`);
    expect(alive(pid)).toBe(false);
    expect(await health(socketFile(h))).toBeUndefined();

    const none = await run("stop", h);
    expect(none.code).toBe(0);
    expect(none.out).toContain("not running");
    expect((await run("status", h)).code).toBe(7);
  });

  it("with the service answering, status takes no lock, and stop takes it only after the process exited", async () => {
    const h = await initialized();
    expect((await run("start", h)).code).toBe(0);
    const pid = (await health(socketFile(h)))?.pid as number;
    // Each time the lock is taken: whether the service process was still there.
    const takenWhileAlive: boolean[] = [];
    const realAcquire = osFileLock.acquire.bind(osFileLock);
    const spy = vi.spyOn(osFileLock, "acquire").mockImplementation((dir) => {
      takenWhileAlive.push(alive(pid));
      return realAcquire(dir);
    });
    try {
      expect((await run("status", h)).code).toBe(0);
      expect(takenWhileAlive).toEqual([]);

      const r = await run("stop", h);
      expect(r.code).toBe(0);
      expect(alive(pid)).toBe(false);
      expect(takenWhileAlive).toEqual([false]);
    } finally {
      spy.mockRestore();
    }
  });

  it("status gives the data directory the home records", async () => {
    const h = await initialized();
    const data = join(root, `data-${n++}`);
    renameSync(join(h, "data"), data);
    const directory = join(h, "control", "tenant.json");
    writeFileSync(
      directory,
      `${JSON.stringify({ ...JSON.parse(readFileSync(directory, "utf8")), data_dir: data })}\n`,
    );
    expect((await run("start", h)).code).toBe(0);
    const st = await run("status", h);
    expect(st.code).toBe(0);
    expect(st.out).toContain(`data      ${data}\n`);
  });

  it("start refuses a home not initialized (5)", async () => {
    const r = await run("start", join(root, "none"));
    expect(r.code).toBe(5);
    expect(r.err).toContain("saveslot init");
  });

  it("stop removes a pid file left when the lock is free", async () => {
    const h = await initialized();
    writeFileSync(pidFile(h), "999999\n");
    const r = await run("stop", h);
    expect(r.code).toBe(0);
    expect(() => statSync(pidFile(h))).toThrow();
  });

  it("stop sends no signal when the lock is held and the service does not answer (7)", async () => {
    const h = await initialized();
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      const lock = await osFileLock.acquire(lockDir(h));
      try {
        writeFileSync(pidFile(h), `${bystander.pid}\n`);
        const r = await run("stop", h);
        expect(r.code).toBe(7);
        expect(r.err).toContain("no signal");
        expect(alive(bystander.pid as number)).toBe(true);
      } finally {
        await lock.release();
      }
    } finally {
      bystander.kill("SIGKILL");
    }
  });

  it("stop sends no signal when the pid file names another process than the one answering (7)", async () => {
    const h = await initialized();
    expect((await run("start", h)).code).toBe(0);
    const bystander = spawn(process.execPath, ["-e", "setTimeout(() => {}, 60000)"]);
    try {
      writeFileSync(pidFile(h), `${bystander.pid}\n`);
      const r = await run("stop", h);
      expect(r.code).toBe(7);
      expect(alive(bystander.pid as number)).toBe(true);
      expect((await health(socketFile(h)))?.state).toBe("ready");
    } finally {
      bystander.kill("SIGKILL");
      // Put the pid file right so that afterEach can stop the service.
      writeFileSync(pidFile(h), `${(await health(socketFile(h)))?.pid}\n`);
    }
  });
});

describe("the background log", () => {
  it("is 0600 and holds no token and no written value", async () => {
    const h = await initialized();
    const token = readFileSync(sessionFile(h), "utf8").trim();
    expect((await run("start", h)).code).toBe(0);
    const value = "zebra-4711-written-value";
    const draft = await httpRequest(h, {
      method: "POST",
      path: "/v1/drafts",
      token,
      body: JSON.stringify({ document: LEDGER }),
    });
    expect(draft.status).toBe(200);
    const w = await httpRequest(h, {
      method: "POST",
      path: "/v1/writes",
      token,
      body: JSON.stringify({
        sv: 1,
        ops: [
          { intent: "insert", table: "ledger.expenses", set: { date: "2026-11-16", note: value } },
        ],
      }),
    });
    expect(w.status).toBe(200);
    const q = await httpRequest(h, {
      method: "POST",
      path: "/v1/query",
      token,
      body: JSON.stringify({ table: "ledger.expenses" }),
    });
    expect(q.body).toContain(value);
    expect((await run("stop", h)).code).toBe(0);

    expect(statSync(logFile(h)).mode & 0o777).toBe(0o600);
    const log = readFileSync(logFile(h), "utf8");
    expect(log).toContain("ready");
    expect(log).toContain("stopped");
    for (const secret of [value, token, token.slice(4), "ledger", "expenses"]) {
      expect(log).not.toContain(secret);
    }
  });
});
