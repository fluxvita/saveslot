// The test clock (02-architecture §11 «评测对实现的要求»; 06-cli §3 «分步做»): a service started
// with `evalClock` takes every "now" from it, moves it forward on `POST /v1/eval/clock`, shows it
// in /health and `saveslot status`, and marks its home so that the home serves one run only.

import {
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock } from "@fluxvita/saveslot-store-pglite";
import { afterAll, describe, expect, it, vi } from "vitest";
import { testBackend } from "../../store-pglite/src/testing/test-backend.fixture.ts";
import { serviceCommand, status } from "./commands.ts";
import { LEDGER } from "./contract-suite.fixture.ts";
import { homeTemplate } from "./home-copy.fixture.ts";
import { httpDriver, httpRequest } from "./http-driver.fixture.ts";
import { mcpClient } from "./mcp-driver.fixture.ts";
import { evalMarkFile, evalResultsFile, runService } from "./service.ts";

vi.setConfig({ testTimeout: 60_000, hookTimeout: 60_000 });

const root = mkdtempSync(join(tmpdir(), "ssd-eval-"));
let n = 0;
afterAll(() => rmSync(root, { recursive: true, force: true }));

const START = "2026-11-10T09:00:00+08:00";
const START_MS = Date.parse(START);
const HOUR = 3_600_000;

/** A home as `saveslot init` makes it, made once; each case takes a copy (home-copy.fixture.ts). */
const template = homeTemplate(join(root, "template"), (home) =>
  initLocalHome({
    home,
    backend: testBackend(),
    lock: osFileLock,
    now: "2026-11-01T00:00:00.000Z",
  }),
);

/** A home of its own, as `saveslot init` makes it; with its user session. */
async function newHome(): Promise<{ home: string; session: string }> {
  const home = await template.copy(join(root, String(n++)));
  return { home, session: readFileSync(sessionFile(home), "utf8").trim() };
}

const run = (home: string, evalClock?: string) =>
  runService({
    home,
    version: "t",
    signals: false,
    readsFlushMs: 50,
    log: () => {},
    ...(evalClock !== undefined ? { evalClock } : {}),
  });

const advance = (home: string, token: string, body: unknown) =>
  httpRequest(home, {
    method: "POST",
    path: "/v1/eval/clock",
    token,
    body: JSON.stringify(body),
  });

const healthOf = async (home: string) =>
  JSON.parse((await httpRequest(home, { method: "GET", path: "/health" })).body) as Record<
    string,
    unknown
  >;

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

describe("the test clock", () => {
  it("starts at the moment given, runs, moves forward on request; writes and reads are recorded by it", async () => {
    const { home, session } = await newHome();
    const s = await run(home, START);
    try {
      expect(s.state).toBe("ready");
      expect(existsSync(evalMarkFile(home))).toBe(true);
      const h = await healthOf(home);
      const clock = h["eval_clock"] as { now: string; started_at: string };
      expect(clock.started_at).toBe(new Date(START_MS).toISOString());
      expect(Date.parse(clock.now) - START_MS).toBeGreaterThanOrEqual(0);
      expect(Date.parse(clock.now) - START_MS).toBeLessThan(60_000);

      const call = httpDriver(() => home);
      expect(
        await call(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never),
      ).toMatchObject({ result: { outcome: "applied" } });
      const first = (await call(session, "log.end", {} as never)) as {
        result: { recorded_at: string };
      };
      expect(Date.parse(first.result.recorded_at) - START_MS).toBeLessThan(60_000);

      // A connection reads; its read is written (flushed) at the clock's moment.
      const issued = (await call(session, "connections.issue", {
        name: "Eval host",
        scopes: ["saveslot.read", "saveslot.write"],
      } as never)) as { result: { token: string } };
      const token = issued.result.token;

      // Only the user session moves it; a connection may not.
      const refused = await advance(home, token, { advance: "PT2H" });
      expect(refused.status).toBe(403);
      expect(JSON.parse(refused.body).error).toMatchObject({
        code: "insufficient_scope",
        required_scope: "user_session",
      });
      // Forward only, as a duration.
      for (const bad of ["-PT1H", "PT0S", "2 hours", "P1M", "PT", 7200]) {
        const r = await advance(home, session, { advance: bad });
        expect([bad, r.status]).toEqual([bad, 400]);
      }
      const moved = await advance(home, session, { advance: "PT2H" });
      expect(moved.status).toBe(200);
      const now = Date.parse(JSON.parse(moved.body).now);
      expect(now - START_MS).toBeGreaterThanOrEqual(2 * HOUR);
      expect(now - START_MS).toBeLessThan(2 * HOUR + 60_000);

      expect(await call(token, "query", { table: "ledger.expenses" } as never)).toMatchObject({
        result: {},
      });
      await sleep(300);
      const reads = (await call(session, "reads.list", {} as never)) as {
        result: { reads: { at: string }[] };
      };
      expect(reads.result.reads.length).toBeGreaterThan(0);
      for (const r of reads.result.reads) {
        expect(Date.parse(r.at) - START_MS).toBeGreaterThanOrEqual(2 * HOUR);
      }

      expect(
        await call(token, "write", {
          sv: 1,
          ops: [
            {
              table: "ledger.expenses",
              intent: "insert",
              set: { date: "2026-11-10", note: "taxi" },
            },
          ],
        } as never),
      ).toMatchObject({ result: {} });
      const second = (await call(session, "log.end", {} as never)) as {
        result: { recorded_at: string };
      };
      expect(Date.parse(second.result.recorded_at) - START_MS).toBeGreaterThanOrEqual(2 * HOUR);

      // `saveslot status` says so, first.
      const out: string[] = [];
      expect(await status(home, { out: (l) => out.push(l), err: () => {} })).toBe(0);
      expect(out.join("\n").split("\n")[0]).toMatch(
        /^eval clock: 2026-11-10T03:00:\d\d\.\d{3}Z \(not the system clock: an evaluation run\)$/,
      );
    } finally {
      await s.stop();
    }
  });

  it("the MCP text says how long an item has been open by the test clock", async () => {
    const { home, session } = await newHome();
    const s = await run(home, START);
    try {
      const call = httpDriver(() => home);
      await call(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never);
      const issue = async (name: string) =>
        (
          (await call(session, "connections.issue", {
            name,
            scopes: ["saveslot.read", "saveslot.write"],
          } as never)) as { result: { token: string } }
        ).result.token;
      const a = await issue("Eval A");
      const b = await issue("Eval B");
      const put = (token: string, op: Record<string, unknown>) =>
        call(token, "write", {
          sv: 1,
          ops: [{ table: "ledger.expenses", ...op }],
        } as never) as Promise<{
          result: {
            status: string;
            ops: { target: { row: string }; ver: string }[];
            pending: { id: string }[];
          };
        }>;
      const first = await put(a, { intent: "insert", set: { date: "2026-11-10", note: "a" } });
      const row = first.result.ops[0]?.target.row as string;
      const ver = first.result.ops[0]?.ver as string;
      await put(b, { intent: "update", row, ver, set: { note: "b" } });
      // A writes over what it read: a conflict item, opened now (by the test clock).
      const stale = await put(a, { intent: "update", row, ver, set: { note: "c" } });
      expect(stale.result.status).toBe("pending");
      const item = stale.result.pending[0]?.id as string;
      expect((await advance(home, session, { advance: "PT2H" })).status).toBe(200);
      const client = await mcpClient(home, a, "legacy");
      try {
        const r = (await client.callTool({
          name: "saveslot_pending",
          arguments: { id: item },
        })) as {
          content: { type: string; text: string }[];
        };
        expect(r.content[0]?.text).toMatch(/ opened 2 h ago \(/);
      } finally {
        await client.close();
      }
    } finally {
      await s.stop();
    }
  });

  it("writes each MCP tool call's contract result to the evaluation results, without a token; the tool result itself is text", async () => {
    const { home, session } = await newHome();
    const s = await run(home, START);
    try {
      const call = httpDriver(() => home);
      await call(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never);
      const issued = (await call(session, "connections.issue", {
        name: "Eval A",
        scopes: ["saveslot.read", "saveslot.write"],
      } as never)) as { result: { token: string; id: string } };
      const token = issued.result.token;
      const pasted = `slt_${"P".repeat(43)}`;
      const client = await mcpClient(home, token, "legacy");
      try {
        const r = (await client.callTool({
          name: "saveslot_query",
          arguments: { table: "ledger.expenses", task: pasted },
        })) as Record<string, unknown>;
        expect(r).not.toHaveProperty("structuredContent");
        const refused = (await client.callTool({
          name: "saveslot_query",
          arguments: { table: "nowhere" },
        })) as Record<string, unknown>;
        expect(refused["isError"]).toBe(true);
      } finally {
        await client.close();
      }
      const file = evalResultsFile(home);
      expect(statSync(file).mode & 0o777).toBe(0o600);
      const text = readFileSync(file, "utf8");
      for (const secret of [token, pasted, session]) expect(text).not.toContain(secret);
      const lines = text
        .trimEnd()
        .split("\n")
        .map((l) => JSON.parse(l) as Record<string, unknown>);
      expect(lines).toHaveLength(2);
      expect(lines[0]).toMatchObject({
        connection: issued.result.id,
        tool: "saveslot_query",
        arguments: { table: "ledger.expenses", task: "slt_REDACTED" },
        result: { table: "ledger.expenses", rows: [] },
      });
      expect(Date.parse(String(lines[0]?.["t"])) - START_MS).toBeLessThan(60_000);
      expect(lines[1]).toMatchObject({
        tool: "saveslot_query",
        result: { error: { code: "unknown_table" } },
      });
    } finally {
      await s.stop();
    }
  });

  it("makes the evaluation results anew at the start: a link left at the path is removed, not followed", async () => {
    const { home } = await newHome();
    const outside = join(root, `outside-${n++}.txt`);
    writeFileSync(outside, "kept\n");
    mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
    symlinkSync(outside, evalResultsFile(home));
    const s = await run(home, START);
    try {
      expect(s.state).toBe("ready");
      expect(readFileSync(outside, "utf8")).toBe("kept\n");
      const st = lstatSync(evalResultsFile(home));
      expect(st.isSymbolicLink()).toBe(false);
      expect(st.isFile()).toBe(true);
      expect(st.mode & 0o777).toBe(0o600);
      expect(st.size).toBe(0);
    } finally {
      await s.stop();
    }
  });

  it("does not exist without --eval-clock: no route, nothing in /health or status", async () => {
    const { home, session } = await newHome();
    const s = await run(home);
    try {
      expect((await advance(home, session, { advance: "PT2H" })).status).toBe(404);
      expect(await healthOf(home)).not.toHaveProperty("eval_clock");
      const out: string[] = [];
      await status(home, { out: (l) => out.push(l), err: () => {} });
      expect(out.join("\n")).not.toContain("eval clock");
      expect(existsSync(evalMarkFile(home))).toBe(false);
      expect(existsSync(evalResultsFile(home))).toBe(false);
    } finally {
      await s.stop();
    }
  });

  it("a home a run has used serves no second start: without the clock (autostart too), nor with it", async () => {
    const { home } = await newHome();
    const first = await run(home, START);
    expect(first.state).toBe("ready");
    await first.stop();
    for (const clock of [undefined, START]) {
      const again = await run(home, clock);
      expect([again.state, again.reason]).toEqual(["failed", "eval_dir_refused"]);
      expect(await again.exited).toEqual({ code: 1, reason: "eval_dir_refused" });
    }
  });

  it("is refused over a log that holds more than the tenant's genesis, and leaves no mark", async () => {
    const { home, session } = await newHome();
    const plain = await run(home);
    const call = httpDriver(() => home);
    await call(session, "schema_draft", { document: { ...LEDGER, slot: "ledger" } } as never);
    await plain.stop();
    const s = await run(home, START);
    expect([s.state, s.reason]).toEqual(["failed", "eval_clock_refused"]);
    await s.stop();
    expect(existsSync(evalMarkFile(home))).toBe(false);
    // Still the user's: it starts as before.
    const after = await run(home);
    expect(after.state).toBe("ready");
    await after.stop();
  });

  it("is refused behind the log's end: a home made on the system clock, the test clock earlier", async () => {
    // As `saveslot init` makes a home: its genesis at this computer's time, later than START.
    const home = join(root, String(n++));
    await initLocalHome({
      home,
      backend: testBackend(),
      lock: osFileLock,
      now: new Date().toISOString(),
    });
    const s = await run(home, START);
    expect([s.state, s.reason]).toEqual(["failed", "eval_clock_refused"]);
    await s.stop();
    expect(existsSync(evalMarkFile(home))).toBe(false);
    // A start at or after the genesis is taken.
    const later = await run(home, new Date(Date.now() + HOUR).toISOString());
    expect(later.state).toBe("ready");
    await later.stop();
  });

  it("takes only an RFC 3339 moment with its offset", async () => {
    const { home } = await newHome();
    for (const bad of ["2026-11-10", "2026-11-10T09:00:00", "tomorrow"]) {
      const s = await run(home, bad);
      expect([s.state, s.reason]).toEqual(["failed", "eval_clock_invalid"]);
    }
    expect(existsSync(evalMarkFile(home))).toBe(false);
    const err: string[] = [];
    expect(
      await serviceCommand("start", ["--home", home, "--eval-clock", "2026-11-10"], {
        out: () => {},
        err: (l) => err.push(l),
      }),
    ).toBe(2);
    expect(err.join("\n")).toContain("--eval-clock");
  });
});
