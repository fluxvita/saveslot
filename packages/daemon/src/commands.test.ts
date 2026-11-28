// The service commands with real processes (06-cli §3 steps 2–3, §4.1, §6.2): init and its
// refusals, start in the background and again, status, stop and the cases where stop sends no
// signal, and what the background log holds.
//
// `init` here makes the home's tenant storage with the test backend, which copies it from the run's
// template (useInitBackendForTests, restored in afterAll); one case makes it without the switch,
// as the product does, and has the service open it in a child process.

import { spawn } from "node:child_process";
import {
  chmodSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  realpathSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, afterEach, beforeAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import {
  CLOCK_BEHIND_MS,
  type CommandIO,
  clockBehind,
  logFile,
  looksSynced,
  serviceCommand,
  status,
} from "./commands.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { homeTemplate } from "./home-copy.fixture.ts";
import { httpRequest } from "./http-driver.fixture.ts";
import { useInitBackendForTests } from "./init-backend.ts";
import { health } from "./local-request.ts";
import { lockDir, pidFile, runService, socketFile } from "./service.ts";

vi.setConfig({ testTimeout: 180_000, hookTimeout: 180_000 });

/** This package's version, as the service reports it: never a version written down here. */
const VERSION = (
  JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  }
).version;

const root = mkdtempSync(join(tmpdir(), "ssc-"));
let n = 0;
const started: string[] = [];

afterEach(async () => {
  // Whatever a case left running is stopped.
  for (const h of started.splice(0)) await run("stop", h);
});
afterAll(() => rmSync(root, { recursive: true, force: true }));
beforeAll(() => useInitBackendForTests(testBackend()));
afterAll(() => useInitBackendForTests(undefined));

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

/** A home the `init` command made, once; the cases that are not about init take a copy. */
const template = homeTemplate(join(root, "template"), async (home) => {
  expect((await run("init", home)).code).toBe(0);
});
const copied = () => template.copy(join(root, String(n++)));

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

  it("without the tests' backend, makes the home as the product does, and the service opens it in its own process", async () => {
    // A backend that counts what it is asked to open, set and then unset: once unset, init must not
    // use it.
    let asked = 0;
    const counted = testBackend();
    const open = counted.open.bind(counted);
    counted.open = (...a: Parameters<typeof open>) => {
      asked++;
      return open(...a);
    };
    useInitBackendForTests(counted);
    useInitBackendForTests(undefined);
    try {
      const h = await initialized();
      expect(asked).toBe(0);
      expect((await run("start", h)).code).toBe(0);
      expect((await health(socketFile(h)))?.state).toBe("ready");
      const st = await run("status", h);
      expect(st.code).toBe(0);
      expect(st.out).toContain("ready");
      expect((await run("stop", h)).code).toBe(0);
    } finally {
      useInitBackendForTests(testBackend());
    }
  });

  it("names a folder a sync service keeps", () => {
    expect(looksSynced("/Users/a/Library/Mobile Documents/com~apple~CloudDocs/s")).toBe(true);
    expect(looksSynced("/Users/a/Library/CloudStorage/Dropbox/s")).toBe(true);
    expect(looksSynced("/home/a/Dropbox/s")).toBe(true);
    expect(looksSynced("/home/a/.saveslot/data")).toBe(false);
    expect(looksSynced("/home/a/Dropboxes/s")).toBe(false);
  });

  it("--help: what the command does, exit 0, nothing done", async () => {
    for (const c of ["init", "start", "stop", "status"] as const) {
      const h = join(root, `help-${c}`);
      const r = await run(c, h, "--help");
      expect(r.code, c).toBe(0);
      expect(r.out, c).toContain(`usage: saveslot ${c}`);
      expect(existsSync(h), c).toBe(false);
    }
  });

  it("an unknown option is a usage error (2)", async () => {
    const r = await run("init", join(root, "x"), "--nope");
    expect(r.code).toBe(2);
  });

  const recorded = (h: string) =>
    JSON.parse(readFileSync(join(h, "control", "tenant.json"), "utf8")).data_dir as unknown;

  it("--data-dir puts the data elsewhere, normalized, and the service opens it there", async () => {
    const h = join(root, String(n++));
    const data = join(root, `data-${n++}`);
    // Written with `..` and a trailing slash; recorded as the plain absolute path.
    const written = `${root}/a/../${data.slice(root.length + 1)}/`;
    const r = await run("init", h, "--data-dir", written);
    expect(r.code).toBe(0);
    expect(recorded(h)).toBe(data);
    expect(existsSync(join(h, "data"))).toBe(false);
    expect((await run("start", h)).code).toBe(0);
    expect((await run("status", h)).out).toContain(`data      ${data}\n`);
  });

  it("--data-dir onto another home's store of an older format: refused, 5, nothing changed there or in the home", async () => {
    // The other home, its store of the kernel's format; then init with a version one format later.
    const other = join(root, String(n++));
    expect((await run("init", other)).code).toBe(0);
    const data = join(other, "data");
    const tail = async () => {
      const st = await testBackend().open({ kind: "pglite", dir: data }, {});
      try {
        const r = await st.read((tx) =>
          tx.query<{ seq: unknown; header_hash: string }>(
            "SELECT seq, header_hash FROM events ORDER BY seq DESC LIMIT 1",
          ),
        );
        return { format: st.formatVersion, end: r.rows[0] };
      } finally {
        await st.close();
      }
    };
    const before = await tail();
    const h = join(root, String(n++));
    useInitBackendForTests(
      testBackend({
        formatUpgrade: {
          format: before.format + 1,
          steps: [{ from: before.format, sql: "CREATE TABLE up_x (x int);" }],
        },
      }),
    );
    let r: Awaited<ReturnType<typeof run>>;
    try {
      r = await run("init", h, "--data-dir", data);
    } finally {
      useInitBackendForTests(testBackend());
    }
    expect(r.code).toBe(5);
    expect(r.err).toContain(`the data directory ${data} is not empty; nothing was changed`);
    expect(await tail()).toEqual(before);
    expect(existsSync(join(h, "control"))).toBe(false);
    expect(existsSync(join(h, "credentials"))).toBe(false);
  });

  it("--data-dir onto a directory with anything in it: refused; onto an empty one: used", async () => {
    const h = join(root, String(n++));
    const full = join(root, `full-${n++}`);
    mkdirSync(full);
    writeFileSync(join(full, "notes.txt"), "mine\n");
    expect((await run("init", h, "--data-dir", full)).code).toBe(5);
    expect(readdirSync(full)).toEqual(["notes.txt"]);
    const empty = join(root, `empty-${n++}`);
    mkdirSync(empty, { mode: 0o755 });
    expect((await run("init", h, "--data-dir", empty)).code).toBe(0);
    expect(statSync(empty).mode & 0o777).toBe(0o700);
    // The default one too: a home not initialized whose data/ holds something.
    const d = join(root, String(n++));
    mkdirSync(d, { mode: 0o700 });
    mkdirSync(join(d, "data"), { mode: 0o700 });
    writeFileSync(join(d, "data", "x"), "x");
    expect((await run("init", d)).code).toBe(5);
  });

  it("--data-dir resolves a relative directory against the current one; the default written another way is not recorded", async () => {
    const cwd = process.cwd();
    const h = join(root, String(n++));
    try {
      process.chdir(root);
      expect((await run("init", h, "--data-dir", `rel-${n}`)).code).toBe(0);
    } finally {
      process.chdir(cwd);
    }
    // The current directory as the process sees it (on macOS the temporary folder is a link).
    expect(recorded(h)).toBe(join(realpathSync(root), `rel-${n}`));

    const d = join(root, String(n++));
    expect((await run("init", d, "--data-dir", `${join(d, "data")}/`)).code).toBe(0);
    expect(recorded(d)).toBeUndefined();
  });

  // The mode bits are what is checked: as root every directory can be read anyway, and the owner
  // check passes; these cases need a user the bits bind.
  const asRoot = process.getuid?.() === 0;
  const modeOf = (p: string) => (statSync(p).mode & 0o777).toString(8);

  it.skipIf(asRoot)(
    "init makes the data directory 0700, put elsewhere or not, whatever the umask lets through",
    async () => {
      const was = process.umask(0o022);
      try {
        const h = join(root, String(n++));
        const data = join(root, `data-${n++}`);
        expect((await run("init", h, "--data-dir", data)).code).toBe(0);
        expect(modeOf(data)).toBe("700");
        const d = join(root, String(n++));
        expect((await run("init", d)).code).toBe(0);
        expect(modeOf(join(d, "data"))).toBe("700");
      } finally {
        process.umask(was);
      }
    },
  );

  it.skipIf(asRoot)(
    "a data directory put elsewhere and open to others: the service does not start, and says why",
    async () => {
      const h = join(root, String(n++));
      const data = join(root, `data-${n++}`);
      expect((await run("init", h, "--data-dir", data)).code).toBe(0);
      chmodSync(data, 0o755);
      const r = await run("start", h);
      expect(r.code).not.toBe(0);
      expect(r.err).toContain("(data_dir_permissions)");
      expect(r.err).toContain("data directory");
      chmodSync(data, 0o700);
      expect((await run("start", h)).code).toBe(0);
    },
  );

  it.skipIf(asRoot)(
    "the default data directory left as an older init made it (0755): not checked, the service starts",
    async () => {
      const h = join(root, String(n++));
      expect((await run("init", h)).code).toBe(0);
      chmodSync(join(h, "data"), 0o755);
      expect((await run("start", h)).code).toBe(0);
    },
  );

  it("--data-dir with --rotate-session, or empty, is a usage error (2) and makes nothing", async () => {
    const h = join(root, String(n++));
    expect((await run("init", h, "--data-dir", "/tmp/x", "--rotate-session")).code).toBe(2);
    expect((await run("init", h, "--data-dir", "")).code).toBe(2);
    expect(existsSync(h)).toBe(false);
  });
});

describe("status: the clock against the log's end (log.end, with the user session)", () => {
  const END = "2026-11-18T12:00:00.000Z";
  const at = (ms: number) => Date.parse(END) + ms;
  const quietIO = () => {
    const out: string[] = [];
    return { out, io: { out: (l: string) => out.push(l), err: () => {} } satisfies CommandIO };
  };

  it("clockBehind: exactly the limit, none; a second more, a warning; after the end or no end, none", () => {
    expect(CLOCK_BEHIND_MS).toBe(5 * 60_000);
    expect(clockBehind(END, at(-CLOCK_BEHIND_MS))).toBeUndefined();
    expect(clockBehind(END, at(-CLOCK_BEHIND_MS - 1_000))).toBe(CLOCK_BEHIND_MS + 1_000);
    expect(clockBehind(END, at(60_000))).toBeUndefined();
    expect(clockBehind(undefined, at(-3_600_000))).toBeUndefined();
    expect(clockBehind("not a time", at(-3_600_000))).toBeUndefined();
  });

  /** A home with a session file whose socket answers /health and /v1/log/end as given. */
  async function standIn(logEnd: { status: number; body?: unknown }, session = true) {
    const h = join(root, String(n++));
    mkdirSync(join(h, "run"), { recursive: true, mode: 0o700 });
    if (session) {
      mkdirSync(join(h, "credentials"), { recursive: true, mode: 0o700 });
      chmodSync(h, 0o700);
      writeFileSync(sessionFile(h), `sls_${"s".repeat(43)}\n`, { mode: 0o600 });
    }
    const asked: string[] = [];
    const server = createServer((req, res) => {
      asked.push(`${req.url} ${req.headers["authorization"] ?? ""}`);
      if (req.url === "/health") {
        return res.writeHead(200, { "content-type": "application/json" }).end(
          JSON.stringify({
            state: "ready",
            version: VERSION,
            pid: 4242,
            since: "2026-11-18T00:00:00Z",
            writer_lock: "held",
          }),
        );
      }
      if (req.url === "/v1/log/end") {
        return res
          .writeHead(logEnd.status, { "content-type": "application/json" })
          .end(JSON.stringify(logEnd.body ?? { error: { code: "unauthenticated" } }));
      }
      res.writeHead(404).end();
    });
    await new Promise<void>((r) => server.listen(socketFile(h), r));
    return { h, asked, close: () => new Promise((r) => server.close(r)) };
  }

  it.each([
    [
      "5 minutes and a second behind: a warning",
      { status: 200, body: { seq: 9, recorded_at: END } },
      true,
      -CLOCK_BEHIND_MS - 1_000,
      "5 minutes behind",
    ],
    [
      "exactly 5 minutes behind: none",
      { status: 200, body: { seq: 9, recorded_at: END } },
      true,
      -CLOCK_BEHIND_MS,
      undefined,
    ],
    [
      "an end written with an offset: the time as parsed, written again in UTC",
      { status: 200, body: { seq: 9, recorded_at: "2026-11-18T20:00:00+08:00" } },
      true,
      -10 * 60_000,
      "10 minutes behind",
    ],
    [
      "an end written as RFC 2822 (V8 takes it): the time as parsed, written again in UTC",
      { status: 200, body: { seq: 9, recorded_at: "Wed, 18 Nov 2026 12:00:00 GMT" } },
      true,
      -10 * 60_000,
      "10 minutes behind",
    ],
    ["the log is empty (null): none", { status: 200, body: null }, true, -3_600_000, undefined],
    ["the session refused: none, no error", { status: 401 }, true, -3_600_000, undefined],
    [
      "no session to read: none, no error",
      { status: 200, body: { seq: 9, recorded_at: END } },
      false,
      -3_600_000,
      undefined,
    ],
  ])("%s", async (_, logEnd, session, offset, said) => {
    const s = await standIn(logEnd, session);
    try {
      const q = quietIO();
      expect(await status(s.h, q.io, { now: () => at(offset) })).toBe(0);
      const out = q.out.join("\n");
      expect(out).toContain("lock      the home's single-writer lock, held by pid 4242");
      if (said === undefined) expect(out).not.toContain("warning");
      else
        expect(out).toContain(`warning: this computer's clock is ${said} the log's end (${END})`);
      // Nothing of the service's string is written as it came.
      expect(out).not.toContain("+08:00");
      expect(out).not.toContain("GMT");
      // Asked with the session, as the pending count is.
      if (session) expect(s.asked).toContain(`/v1/log/end Bearer sls_${"s".repeat(43)}`);
    } finally {
      await s.close();
    }
  });

  it("against the service: the log's end is the genesis's recorded time; a clock behind it, warned", async () => {
    const h = join(root, String(n++));
    await initLocalHome({ home: h, backend: testBackend(), lock: osFileLock, now: END });
    const svc = await runService({
      home: h,
      version: VERSION,
      signals: false,
      log: () => {},
    });
    try {
      const behind = quietIO();
      expect(await status(h, behind.io, { now: () => at(-10 * 60_000) })).toBe(0);
      expect(behind.out.join("\n")).toContain(
        `warning: this computer's clock is 10 minutes behind the log's end (${END})`,
      );
      const after = quietIO();
      expect(await status(h, after.io, { now: () => at(60_000) })).toBe(0);
      expect(after.out.join("\n")).not.toContain("warning");
    } finally {
      await svc.stop();
    }
  });
});

describe("start, status, stop", () => {
  it("starts in the background, says so again, stops; stop again finds nothing running", async () => {
    const h = await copied();
    const first = await run("start", h);
    expect(first.code).toBe(0);
    const ready = await health(socketFile(h));
    expect(ready?.state).toBe("ready");
    // service.low_memory at its default: the process was started with Node's option.
    expect(ready?.low_memory).toBe(true);
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
    expect(st.out).toContain(`  lock      the home's single-writer lock, held by pid ${pid}\n`);
    expect(st.out).toContain(
      "  memory    low (service.low_memory on: V8's baseline compiler only)\n",
    );
    expect(st.out).not.toContain("warning");

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
    const h = await copied();
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

  it("with service.low_memory off, the service starts without Node's option, and status says so", async () => {
    const h = await copied();
    writeFileSync(join(h, "config.toml"), "[service]\nlow_memory = false\n", { mode: 0o600 });
    expect((await run("start", h)).code).toBe(0);
    expect((await health(socketFile(h)))?.low_memory).toBe(false);
    const st = await run("status", h);
    expect(st.out).toContain("  memory    standard (service.low_memory off)\n");
    expect((await run("stop", h)).code).toBe(0);
  });

  it("status gives the data directory the home records", async () => {
    const h = await copied();
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
    const h = await copied();
    writeFileSync(pidFile(h), "999999\n");
    const r = await run("stop", h);
    expect(r.code).toBe(0);
    expect(() => statSync(pidFile(h))).toThrow();
  });

  it("stop sends no signal when the lock is held and the service does not answer (7)", async () => {
    const h = await copied();
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
    const h = await copied();
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
    const h = await copied();
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
