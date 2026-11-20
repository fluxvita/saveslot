// The time limit of a `sql` call (11-restricted-sql.md «处理步骤» 8; 02-architecture §7): the kernel
// sets `statement_timeout` for the transaction on a backend that enforces one, and a statement the
// database stops for it is `sql_timeout`.
//
// The case that runs the limit for real needs PostgreSQL: PGlite has no statement timeout, so on
// it that case is skipped, and the refusal's shape is checked against an error made like
// PostgreSQL's (`sqlState` 57014, the ports' convention) instead. The real case: a limit of 1 ms, and a statement the
// whitelist accepts that takes far longer (the 8-way product of a table of several rows, with a
// string built on each row: some tens of milliseconds on a laptop, against a limit of 1), so that the outcome does not depend on the machine's
// speed. 8 is the most table references a statement may have.

import { createOpsContext, loadRsql, sql as sqlOp } from "@fluxvita/saveslot-kernel";
import { sqlInTx } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { TEST_BACKEND } from "../../test-backend/src/index.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import { buildTenant, NOW, refusal, runSql, TENANT, USER } from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqltimeout-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: NOW,
    confirmation: null,
  });

/** Whether the store under test enforces a statement timeout (PostgreSQL does, PGlite does not). */
const enforces = () => (s.store as { enforcesStatementTimeout?: boolean }).enforcesStatementTimeout;

const SLOW = `SELECT sum(length(s0.note || s1.note || s2.note || s3.note || s4.note || s5.note || s6.note || s7.note)) FROM ${Array.from({ length: 8 }, (_, i) => `spend s${i}`).join(", ")}`;

describe("a statement the database stops for its time limit", () => {
  it("is `sql_timeout` with the time it ran, and nothing of the database's own words", async () => {
    const stopped = Object.assign(new Error("canceling statement due to statement timeout"), {
      sqlState: "57014",
    });
    const run = s.store.read((tx) =>
      sqlInTx(
        {
          query: (text, p) => {
            // The caller's statement is the one with the positional columns.
            if (text.startsWith("SELECT CAST(") || text.includes('AS "c1"')) throw stopped;
            return tx.query(text, p);
          },
        },
        {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { sql: "SELECT note FROM spend" },
          read: `rd_${"1".repeat(16)}` as never,
        },
      ),
    );
    const e = await refusal(run);
    expect(e).toMatchObject({ code: "sql_timeout" });
    expect(typeof e["elapsed_ms"]).toBe("number");
    expect(JSON.stringify(e)).not.toContain("canceling statement");
  });
});

describe.skipIf(TEST_BACKEND !== "postgres")(
  "on PostgreSQL (skipped on PGlite: it has no statement timeout to run into)",
  () => {
    it("a slow statement past a limit of 1 ms is `sql_timeout`, and the store is usable after", async () => {
      expect(enforces()).toBe(true);
      const t0 = performance.now();
      const e = await refusal(sqlOp(s.store, ctx(), { sql: SLOW }, { timeoutMs: 1 }));
      const took = performance.now() - t0;
      expect(e).toMatchObject({ code: "sql_timeout" });
      expect(Number(e["elapsed_ms"])).toBeGreaterThanOrEqual(1);
      // Stopped at the limit, not run to the end: seconds, never the minutes of the full product.
      expect(took).toBeLessThan(30_000);
      // The limit was set for that transaction only: the next call runs.
      const next = await runSql(s, { sql: "SELECT count(*) FROM spend" });
      expect(next.result.rows).toHaveLength(1);
    });
  },
);

describe.skipIf(TEST_BACKEND === "postgres")("on PGlite", () => {
  it("has no statement timeout: the kernel does not set one, and says nothing of it", async () => {
    expect(enforces()).not.toBe(true);
    const r = await runSql(s, { sql: "SELECT count(*) FROM spend" });
    expect(r.statements.map((x) => x.text).join("\n")).not.toContain("statement_timeout");
  });
});

describe("one deadline for the whole call", () => {
  /** A call on a clock the statements move: the main statement takes 6 s, each identity statement 3 s. */
  async function onClock(sql: string, timeoutMs: number) {
    let time = 0;
    const texts: string[] = [];
    const out = s.store.read((tx) =>
      sqlInTx(
        {
          query: (text, p) => {
            texts.push(text);
            if (text.startsWith("SELECT CAST(")) time += 6000;
            else if (/^SELECT DISTINCT/.test(text)) time += 3000;
            return tx.query(text, p);
          },
        },
        {
          actor: USER as never,
          task: null,
          now: NOW as never,
          visibility: { kind: "all" },
          params: { sql },
          read: `rd_${"3".repeat(16)}` as never,
          timeoutMs,
          clock: () => time,
        },
      ),
    );
    const limits = () =>
      texts.flatMap((t) => {
        const m = /^SET LOCAL statement_timeout = (\d+)$/.exec(t);
        return m === null ? [] : [Number(m[1])];
      });
    return { out, limits, texts };
  }
  const THREE =
    "SELECT (SELECT count(*) FROM budgets) AS a, (SELECT count(*) FROM settings) AS b FROM spend";

  it("gives each statement what is left of it, not a limit of its own", async () => {
    const { out, limits } = await onClock(THREE, 20_000);
    await out;
    // Before the main statement, and before each of the three tables' statements.
    expect(limits()).toEqual([20_000, 14_000, 11_000, 8_000]);
  });

  it("is `sql_timeout` when the statements of the record find it spent, before one more is sent", async () => {
    const { out, limits, texts } = await onClock(THREE, 10_000);
    expect(await refusal(out)).toMatchObject({ code: "sql_timeout" });
    // 10 s, 4 s, 1 s left; then nothing was left for the third, and it was not sent.
    expect(limits()).toEqual([10_000, 4_000, 1_000]);
    expect(texts.filter((t) => /^SELECT DISTINCT/.test(t))).toHaveLength(2);
  });
});

describe("the cost of the read record", () => {
  it("is no statement at all for a level of a join: the product is not run again", async () => {
    const r = await runSql(s, { sql: "SELECT 1 FROM spend a, spend b, spend c, spend d LIMIT 1" });
    expect(r.statements.filter((x) => /^SELECT DISTINCT/.test(x.text))).toEqual([]);
    expect(r.entry.coarse).toEqual(["t1"]);
    expect(r.entry.rows).toEqual([]);
  });

  it("is one statement for a level of one table, as before", async () => {
    const r = await runSql(s, { sql: "SELECT note FROM spend LIMIT 1" });
    expect(r.statements.filter((x) => /^SELECT DISTINCT/.test(x.text))).toHaveLength(1);
    expect(r.entry.coarse).toEqual([]);
  });
});
