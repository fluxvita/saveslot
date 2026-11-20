// `sql` run on PGlite (04-contract §10 `sql`; 04-contract-types §4.4; 11-restricted-sql.md): the
// result as the contract shapes it (columns with type and unit, a row an array, quantities as
// decimal text, two columns of one name both there), the values of the call (parameters by the type
// of their use, the time a call is made at, `FOR VALID_TIME`), the pages, and what a query can and
// cannot read of the tenant's tables.

import {
  createOpsContext,
  loadRsql,
  readBufferOf,
  sql as sqlOp,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";
import {
  buildTenant,
  LEDGER,
  MARK,
  NOW,
  refusal,
  runSql,
  TENANT,
  USER,
} from "./testing/sql-tenant.fixture.ts";

let s: ReusableStore;
beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-sqlexec-");
  await buildTenant(s);
}, 300_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

type Params = {
  sql: string;
  params?: unknown[];
  max_rows?: number;
  at?: string;
  position?: string;
};
const run = (p: Params, o: Parameters<typeof runSql>[2] = {}) => runSql(s, p, o);
const rows = async (sql: string, params?: unknown[], more: Partial<Params> = {}) =>
  (await run({ sql, ...(params !== undefined ? { params } : {}), ...more })).result.rows;
const refused = (p: Params, o?: Parameters<typeof runSql>[2]) => refusal(run(p, o));

describe("the result", () => {
  it("is a column description and an array per row, with the type and the unit of each column", async () => {
    const r = (
      await run({
        sql: "SELECT category, sum(distance) AS km, count(*) AS n, min(date) AS first, bool_or(paid) AS paid FROM spend GROUP BY category ORDER BY 1",
      })
    ).result;
    expect(r.columns).toEqual([
      { name: "category", type: "enum" },
      { name: "km", type: "quantity", unit: "km" },
      { name: "n", type: "integer" },
      { name: "first", type: "date" },
      { name: "paid", type: "boolean" },
    ]);
    expect(r.rows).toEqual([
      ["food", "4.5", "3", "2026-11-01", true],
      ["rent", "1.2", "1", "2026-11-03", null],
    ]);
    expect(r.sv).toEqual({ ledger: 1 });
  });

  it("gives each type as the contract writes it", async () => {
    expect(
      await rows(
        "SELECT date, distance, note, pieces, rate, paid, at FROM spend WHERE note = 'lunch'",
      ),
    ).toEqual([["2026-11-01", "1.5", "lunch", "2", "0.5", true, "2026-11-01T04:00:00.000Z"]]);
  });

  it("keeps two columns of one name, and takes the names from the description", async () => {
    const r = (await run({ sql: "SELECT 1 AS x, 2 AS x, 'a' AS y" })).result;
    expect(r.columns.map((c) => c.name)).toEqual(["x", "x", "y"]);
    expect(r.rows).toEqual([["1", "2", "a"]]);
  });

  it("is empty with no table read, and says no slot", async () => {
    const r = (await run({ sql: "SELECT 1 + 1 AS two" })).result;
    expect(r).toMatchObject({ sv: {}, rows: [["2"]] });
  });

  it("gives a decimal in its canonical text and a large integer as text", async () => {
    expect(
      await rows("SELECT CAST(1 AS numeric) / 4 AS q, 9007199254740993 AS big, 0.50 AS half"),
    ).toEqual([["0.25", "9007199254740993", "0.5"]]);
  });

  it("reads every column of every row of a page, including a null", async () => {
    expect(await rows("SELECT note, pieces FROM spend ORDER BY note NULLS LAST")).toEqual([
      ["Café", "1"],
      ["fixed", null],
      ["lunch", "2"],
      [null, null],
    ]);
  });
});

describe("what it reads", () => {
  it("is the current rows: a revoked row and the old value of a corrected one are not in it", async () => {
    const all = await rows("SELECT note FROM spend");
    expect(JSON.stringify(all)).not.toContain(MARK);
    expect(all.map((x) => x[0]).sort()).toEqual([null, "Café", "fixed", "lunch"].sort());
  });

  it("is a state table's segments as they are now, merged, with the system columns", async () => {
    expect(
      await rows(
        "SELECT entity_id IS NOT NULL AS has, category, amount, valid_from, valid_to FROM budgets",
      ),
    ).toEqual([[true, "food", "100", "2026-11-01", "2026-11-10"]]);
  });

  it("is a time clause's segments: as of a day, and over an interval, which meet and are not cut", async () => {
    expect(
      await rows("SELECT category, amount FROM budgets FOR VALID_TIME AS OF '2026-11-12'"),
    ).toEqual([["food", "150"]]);
    expect(
      await rows(
        "SELECT category, amount, valid_from, valid_to FROM budgets FOR VALID_TIME FROM '2026-10-10' TO '2026-11-15' ORDER BY 1, 3",
      ),
    ).toEqual([
      ["food", "100", "2026-11-01", "2026-11-10"],
      ["food", "150", "2026-11-10", "2026-11-20"],
      ["rent", "50", "2026-10-01", "2026-10-15"],
    ]);
  });

  it("is a state table by the instant at the instant of the call, or the one asked for", async () => {
    expect(await rows("SELECT guest FROM rooms")).toEqual([]);
    expect(
      await rows("SELECT guest FROM rooms", undefined, { at: "2026-11-01T11:00:00Z" }),
    ).toEqual([["ann"]]);
    expect(
      await rows("SELECT guest FROM rooms FOR VALID_TIME AS OF '2026-11-01T11:00:00Z'"),
    ).toEqual([["ann"]]);
  });

  it("is a derived table's stored rows, but nothing of its internal columns", async () => {
    // (the health tenant has one: see sql-health.test.ts)
    expect(await refused({ sql: "SELECT partition_id FROM spend" })).toMatchObject({
      code: "sql_rejected",
      reason: "unknown_name",
    });
  });

  it("joins tables of one slot and reads a subquery's table", async () => {
    expect(
      await rows(
        "SELECT s.note FROM spend s JOIN budgets b ON b.category = s.category WHERE s.pieces IS NOT NULL ORDER BY 1",
      ),
    ).toEqual([["lunch"]]);
    expect(
      await rows(
        "SELECT key FROM settings WHERE key IN (SELECT category FROM budgets) OR key = 'a'",
      ),
    ).toEqual([["a"]]);
  });
});

describe("the values of the call", () => {
  it("are checked by the type of their use, and passed as values of that type", async () => {
    expect(await rows("SELECT note FROM spend WHERE pieces = $1", [2])).toEqual([["lunch"]]);
    expect(await rows("SELECT note FROM spend WHERE pieces = $1", ["2"])).toEqual([["lunch"]]);
    expect(await rows("SELECT note FROM spend WHERE note = $1", ["lunch"])).toEqual([["lunch"]]);
    expect(await rows("SELECT note FROM spend WHERE paid = $1", [true])).toEqual([["lunch"]]);
    expect(await rows("SELECT note FROM spend WHERE date = $1", ["2026-11-01"])).toEqual([
      ["lunch"],
    ]);
    expect(await rows("SELECT note FROM spend WHERE distance > $1", ["2.5"])).toEqual([[null]]);
    expect(
      await rows("SELECT note FROM spend WHERE at = $1", ["2026-11-01T12:00:00+08:00"]),
    ).toEqual([["lunch"]]);
    expect(await rows("SELECT note FROM spend WHERE pieces = $1", [null])).toEqual([]);
  });

  it.each([
    ["an integer given as text that is not", "SELECT note FROM spend WHERE pieces = $1", ["x"]],
    [
      "an integer out of 64 bits",
      "SELECT note FROM spend WHERE pieces = $1",
      ["9223372036854775808"],
    ],
    ["a fraction for an integer", "SELECT note FROM spend WHERE pieces = $1", [1.5]],
    ["a decimal with an exponent", "SELECT note FROM spend WHERE distance > $1", ["1e3"]],
    ["a date that is not one", "SELECT note FROM spend WHERE date = $1", ["2026-02-30"]],
    [
      "an instant without an offset",
      "SELECT note FROM spend WHERE at = $1",
      ["2026-11-01T12:00:00"],
    ],
    ["a number for a boolean", "SELECT note FROM spend WHERE paid = $1", [1]],
    ["a number for text", "SELECT note FROM spend WHERE note = $1", [1]],
    ["text with a NUL", "SELECT note FROM spend WHERE note = $1", ["a\0b"]],
  ])("refuse %s as a malformed parameter", async (_why, sql, params) => {
    expect(await refused({ sql, params })).toMatchObject({
      code: "invalid_argument",
      reason: "malformed",
      param: "params/0",
    });
  });

  it("must be as many as the statement has", async () => {
    expect(await refused({ sql: "SELECT $1 + 1", params: [] })).toMatchObject({
      code: "invalid_argument",
      reason: "malformed",
      param: "params",
    });
    expect(await refused({ sql: "SELECT 1 + 1", params: [1] })).toMatchObject({
      code: "invalid_argument",
      reason: "malformed",
    });
  });

  it("are the time a clause is read at, a date for a table by the day", async () => {
    expect(
      await rows("SELECT amount FROM budgets FOR VALID_TIME AS OF $1", ["2026-11-12"]),
    ).toEqual([["150"]]);
    expect(
      await refused({ sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF $1", params: [null] }),
    ).toMatchObject({ code: "invalid_argument", reason: "malformed" });
  });

  // An operand of FOR VALID_TIME as a parameter is read as a literal one is: what the literal gets,
  // the parameter gets, a value or the same refusal.
  it.each([
    [
      "an instant for a table by the day",
      "budgets",
      "'2026-11-12T00:00:00Z'",
      "2026-11-12T00:00:00Z",
    ],
    ["a day for a table by the instant", "rooms", "'2026-11-02'", "2026-11-02"],
    ["a day for a table by the day", "budgets", "'2026-11-12'", "2026-11-12"],
    [
      "an instant for a table by the instant",
      "rooms",
      "'2026-11-02T00:00:00Z'",
      "2026-11-02T00:00:00Z",
    ],
    ["text that is neither", "budgets", "'tomorrow'", "tomorrow"],
    ["an instant without an offset", "rooms", "'2026-11-02T00:00:00'", "2026-11-02T00:00:00"],
    ["a day that is not one", "budgets", "'2026-02-31'", "2026-02-31"],
  ])("gets what a literal gets: %s", async (_n, table, literal, value) => {
    const text = (operand: string) =>
      `SELECT 1 AS one FROM ${table} FOR VALID_TIME AS OF ${operand}`;
    const fromLiteral = await run({ sql: text(literal) }).then(
      (r) => ({ ok: r.result }),
      (e: { code: string; detail?: { reason?: string } }) => ({
        code: e.code,
        reason: e.detail?.reason,
      }),
    );
    const fromParam = await run({ sql: text("$1"), params: [value] }).then(
      (r) => ({ ok: r.result }),
      (e: { code: string; detail?: { reason?: string } }) => ({
        code: e.code,
        reason: e.detail?.reason,
      }),
    );
    if ("ok" in fromLiteral && "ok" in fromParam) {
      expect(fromParam.ok.rows).toEqual(fromLiteral.ok.rows);
      expect(fromParam.ok.warnings).toEqual(fromLiteral.ok.warnings);
    } else expect(fromParam).toEqual(fromLiteral);
  });

  it("an instant for a table by the day is its day, with a warning, as a literal gives it", async () => {
    const r = await run({
      sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF $1",
      params: ["2026-11-12T00:00:00Z"],
    });
    expect(r.result.rows).toEqual([["150"]]);
    expect(r.result.warnings).toEqual([
      expect.objectContaining({ code: "time_truncated", to: "2026-11-12" }),
    ]);
  });

  it("a day for a table by the instant is `granularity`, as a literal gives it", async () => {
    expect(
      await refused({
        sql: "SELECT guest FROM rooms FOR VALID_TIME AS OF $1",
        params: ["2026-11-02"],
      }),
    ).toMatchObject({ code: "invalid_argument", reason: "granularity" });
  });
});

describe("the time of the call", () => {
  it("is the entry instant, and its day in the slot's zone, for saveslot_now() and saveslot_today()", async () => {
    expect(await rows("SELECT saveslot_now() AS n, saveslot_today() AS d")).toEqual([
      [NOW, "2026-11-05"],
    ]);
    // 2026-11-05T20:00Z is 2026-11-06 04:00 in Asia/Shanghai.
    const late = await run(
      { sql: "SELECT saveslot_today() AS d FROM budgets LIMIT 1" },
      { now: "2026-11-05T20:00:00.000Z" },
    );
    expect(late.result.rows).toEqual([["2026-11-06"]]);
  });

  it("is `at` when the call gives it, for the clock functions and for a state table without a clause", async () => {
    const r = await rows(
      "SELECT saveslot_now() AS n, saveslot_today() AS d FROM settings LIMIT 1",
      undefined,
      {
        at: "2026-12-31T20:00:00Z",
      },
    );
    expect(r).toEqual([["2026-12-31T20:00:00.000Z", "2027-01-01"]]);
    expect(
      await rows("SELECT amount FROM budgets", undefined, { at: "2026-11-15T00:00:00Z" }),
    ).toEqual([["150"]]);
  });

  it("is a day written with days added, and an instant taken to its day with a warning", async () => {
    expect(
      await rows("SELECT amount FROM budgets FOR VALID_TIME AS OF saveslot_today() + 10"),
    ).toEqual([["150"]]);
    const r = (
      await run({
        sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF '2026-11-12T20:00:00+08:00'",
      })
    ).result;
    expect(r.rows).toEqual([["150"]]);
    expect(r.warnings).toEqual([
      { code: "time_truncated", param: "sql", from: "2026-11-12T12:00:00.000Z", to: "2026-11-12" },
    ]);
  });

  it("is refused where a table by the instant is given a day, or an interval does not run forward", async () => {
    expect(
      await refused({ sql: "SELECT guest FROM rooms FOR VALID_TIME AS OF '2026-11-01'" }),
    ).toMatchObject({
      code: "invalid_argument",
      reason: "granularity",
    });
    expect(
      await refused({
        sql: "SELECT amount FROM budgets FOR VALID_TIME FROM '2026-11-12' TO '2026-11-01'",
      }),
    ).toMatchObject({ code: "sql_rejected", reason: "runtime" });
    expect(await refused({ sql: "SELECT 1", at: "2026-11-01T00:00:00" })).toMatchObject({
      code: "invalid_argument",
      param: "at",
    });
  });

  it("reaches the end of the calendar as an error of the query, not of the database", async () => {
    expect(
      await refused({ sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF '9999-12-31' + 1" }),
    ).toMatchObject({
      code: "sql_rejected",
    });
  });
});

describe("what fails when it runs", () => {
  it("is a refusal that says what it is in fixed words, never the database's own", async () => {
    const overflow = await refused({ sql: "SELECT 9223372036854775807 + pieces FROM spend" });
    expect(overflow).toMatchObject({
      code: "sql_rejected",
      reason: "runtime",
      message: "a number is out of range",
    });
    const date = await refused({ sql: "SELECT date + 2147483647 FROM spend" });
    expect(date).toMatchObject({ code: "sql_rejected", reason: "runtime" });
  });

  it("divides by zero to NULL", async () => {
    expect(
      await rows(
        "SELECT CAST(pieces AS numeric) / (pieces - 2) AS a, pieces % (pieces - 2) AS b, mod(pieces, pieces - 2) AS c FROM spend WHERE pieces = 2",
      ),
    ).toEqual([[null, null, null]]);
  });
});

describe("pages", () => {
  const all = async () =>
    (await rows("SELECT date, note FROM spend ORDER BY date, note NULLS LAST")).map((x) => x[0]);

  it("holds max_rows rows and says where the next starts, on to the last", async () => {
    const seen: unknown[] = [];
    let position: string | undefined;
    let pages = 0;
    for (;;) {
      const p = await run({
        sql: "SELECT date, note FROM spend ORDER BY date, note NULLS LAST",
        max_rows: 3,
        ...(position !== undefined ? { position } : {}),
      });
      pages++;
      seen.push(...p.result.rows.map((x) => x[0]));
      position = p.result.next_position;
      if (position === undefined) break;
    }
    expect(pages).toBe(2);
    expect(seen).toEqual(await all());
  });

  it("is 100 rows a page and at most 1,000", async () => {
    expect(await refused({ sql: "SELECT 1", max_rows: 0 })).toMatchObject({
      code: "invalid_argument",
      param: "max_rows",
    });
    expect(await refused({ sql: "SELECT 1", max_rows: 1001 })).toMatchObject({
      code: "invalid_argument",
      param: "max_rows",
    });
    expect(await refused({ sql: "SELECT 1", max_rows: 1.5 })).toMatchObject({
      code: "invalid_argument",
      param: "max_rows",
    });
  });

  it("takes a position for the same statement only, and the first page's time on the later ones", async () => {
    const first = await run({ sql: "SELECT date FROM spend ORDER BY 1", max_rows: 2 });
    const position = first.result.next_position as string;
    expect(position).toBeDefined();
    expect(
      await refused({ sql: "SELECT date FROM spend ORDER BY 1 DESC", max_rows: 2, position }),
    ).toMatchObject({
      code: "invalid_argument",
      param: "position",
    });
    expect(
      await refused({ sql: "SELECT date FROM spend ORDER BY 1", position: "not a position" }),
    ).toMatchObject({
      code: "invalid_argument",
      param: "position",
    });
    // The first page was read at NOW; a later call is made later and still reads as at NOW.
    const later = await run(
      { sql: "SELECT saveslot_now() AS n FROM spend ORDER BY 1", max_rows: 1 },
      { now: "2026-11-05T06:00:00.000Z" },
    );
    const next = later.result.next_position as string;
    const second = await run(
      { sql: "SELECT saveslot_now() AS n FROM spend ORDER BY 1", max_rows: 1, position: next },
      { now: "2026-11-05T09:00:00.000Z" },
    );
    expect(second.result.rows).toEqual([["2026-11-05T06:00:00.000Z"]]);
  });

  it("is expired when an operation was written since the first page", async () => {
    const first = await run({ sql: "SELECT date FROM spend ORDER BY 1", max_rows: 2 });
    const position = first.result.next_position as string;
    await write(
      s.store,
      createOpsContext({
        tenant: TENANT,
        actor: USER,
        trigger: null,
        task: null,
        visibility: { kind: "all" },
        idempotency_window: 600_000,
        idempotency_key_window: 86_400_000,
        now: "2026-11-05T05:00:00.000Z",
        confirmation: null,
      }),
      { sv: 1, ops: [{ intent: "insert", table: "settings", set: { key: "c" } }] },
    );
    expect(
      await refused({ sql: "SELECT date FROM spend ORDER BY 1", max_rows: 2, position }),
    ).toMatchObject({
      code: "handle_expired",
      reason: "expired",
    });
    // Read again from the first page.
    expect(
      (await run({ sql: "SELECT date FROM spend ORDER BY 1", max_rows: 2 })).result.next_position,
    ).toBeDefined();
  });
});

describe("the call itself", () => {
  it("refuses a key it does not know, a missing statement and a statement that is not text", async () => {
    expect(await refused({ sql: "SELECT 1", limit: 5 } as never)).toMatchObject({
      code: "invalid_argument",
      param: "limit",
    });
    expect(await refused({} as never)).toMatchObject({
      code: "invalid_argument",
      reason: "missing",
      param: "sql",
    });
    expect(await refused({ sql: 5 } as never)).toMatchObject({
      code: "invalid_argument",
      param: "sql",
    });
    expect(await refused({ sql: "SELECT 1", params: "x" } as never)).toMatchObject({
      code: "invalid_argument",
      param: "params",
    });
    expect(await refused({ sql: "SELECT 1", params: [{}] } as never)).toMatchObject({
      code: "invalid_argument",
      param: "params/0",
    });
  });

  it("is recorded as a read of the slots it read, through the operation", async () => {
    readBufferOf(s.store).take();
    const ctx = createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: "t-1",
      visibility: { kind: "all" },
      idempotency_window: 600_000,
      idempotency_key_window: 86_400_000,
      now: NOW,
      confirmation: null,
    });
    const r = await sqlOp(s.store, ctx, { sql: "SELECT category FROM budgets" });
    expect(r.rows).toEqual([["food"]]);
    const [entry] = readBufferOf(s.store).entries();
    expect(entry).toMatchObject({
      operation: "sql",
      slot: LEDGER,
      sv: 1,
      table: "t3",
      task: "t-1",
      lastRead: [{ kind: "sv", target: LEDGER, op: 1, restoreCount: 0 }],
    });
    // Not a read of a row's version for the fallback: only the slot's `sv`.
    expect(entry?.lastRead.some((x) => x.kind === "ver")).toBe(false);
  });
});
