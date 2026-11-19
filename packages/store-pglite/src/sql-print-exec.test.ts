// What the database does with the text `sql` prints (11-restricted-sql.md «名字», 02-architecture §7:
// on PGlite the syntax-tree whitelist is the only defence). The front end's round trips re-analyse
// the printed text with the same analyser, which cannot see how PostgreSQL resolves names: it
// compares quoted names exactly, the analyser by ASCII case-folding. So the printed text is
// EXECUTED here, on a store whose kernel tables hold marker rows, under the fixed session settings,
// and what comes back must be what the caller's own query defines, never a kernel table, the system
// catalog, or a function applied to a row (`s.concat` is `concat(s)` when `s` has no such column).
//
// Few of the inputs here tell a fixed analyser from an unfixed one: the analyser refuses the
// dangerous input first, so it never reaches the printer. What guards the printer is the structural
// assertion in the kernel's tests (every column written qualified by a generated alias, every output
// column with an AS, aliases unique); this file shows that what is printed runs, and runs as defined.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  checkSql,
  loadRsql,
  printQuery,
  SESSION_SETTINGS,
  type SqlSlot,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import type { PgliteTenantStore } from "./backend.ts";
import { testBackend } from "./testing/test-backend.fixture.ts";

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, 120_000);

const RUNS: SqlSlot["tables"][number] = {
  id: "t1",
  name: "runs",
  kind: "base",
  description: "one run per row",
  time: { type: "none" },
  physical: { table: "t_t1_v1" },
  fields: [{ id: "f1", name: "laps", type: "integer", required: true, description: "laps" }],
} as unknown as SqlSlot["tables"][number];

const slot: SqlSlot = { slot: "sl_a", name: "health", timezone: "UTC", sv: 1, tables: [RUNS] };

const MARK = "MARKER_";
let store: PgliteTenantStore;

beforeAll(async () => {
  await loadRsql();
  const root = mkdtempSync(join(tmpdir(), "saveslot-sqlexec-"));
  roots.push(root);
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
  await store.write(async (tx) => {
    await tx.exec(
      `INSERT INTO principals (id, kind, name, scopes, slots, state, registered_seq)
       VALUES ('p_${MARK}id', 'user', '${MARK}name', '${MARK}scopes', NULL, 'active', 1)`,
    );
    await tx.exec(
      `INSERT INTO slots (id, name, timezone, current_sv) VALUES ('sl_${MARK}id', '${MARK}slot', 'UTC', 1)`,
    );
    // Decoys named like a slot's table, with a column the caller cannot see (the visible table has
    // `laps` only) holding a marker: one where the printed name `runs` is looked up through the
    // search path, one where the slot's own schema is.
    await tx.exec(
      `CREATE TABLE public.runs (laps int, secret text);
       INSERT INTO public.runs VALUES (1, '${MARK}runs_hidden');
       CREATE SCHEMA health;
       CREATE TABLE health.runs (laps int, secret text);
       INSERT INTO health.runs VALUES (7, '${MARK}runs_hidden')`,
    );
  });
}, 120_000);
afterAll(async () => {
  await store?.close();
}, 120_000);

/** What the printed text gives: `refused` before the database, or the rows (or the database's error). */
async function run(sql: string, params: unknown[] = []) {
  const r = checkSql({ sql, params, slots: [slot], context: "S" });
  if (!r.ok) return { refused: r.error.reason };
  const text = printQuery(r.analysis.query);
  try {
    // The session settings are the connection's (the same list the store applies on opening).
    expect(SESSION_SETTINGS.length).toBeGreaterThan(0);
    const rows = await store.read((tx) => tx.query(text, params as never[]));
    return { text, rows: rows.rows };
  } catch (e) {
    return { text, error: String(e) };
  }
}

/** Queries whose analysis takes the caller's names as theirs: what is executed must too. */
const OWN: readonly { name: string; sql: string; rows: unknown[] }[] = [
  {
    name: "a CTE spelled with capitals, referenced in lower case (the kernel's principals)",
    sql: `WITH "Principals" AS (SELECT 'x' AS id, 'y' AS scopes) SELECT id, scopes FROM principals`,
    rows: [{ id: "x", scopes: "y" }],
  },
  {
    name: "a CTE spelled like a system catalog table",
    sql: `WITH "Pg_class" AS (SELECT 'x' AS relname) SELECT relname FROM pg_class`,
    rows: [{ relname: "x" }],
  },
  {
    name: "a CTE spelled like pg_settings",
    sql: `WITH "Pg_settings" AS (SELECT 'x' AS name, 'y' AS setting) SELECT name, setting FROM pg_settings`,
    rows: [{ name: "x", setting: "y" }],
  },
  {
    name: "a column spelled like a function, read as s.concat",
    sql: `SELECT s.concat FROM (SELECT 1 AS "Concat") s`,
    rows: [{ concat: 1 }],
  },
  {
    name: "a column spelled like to_json",
    sql: `SELECT s.to_json FROM (SELECT 1 AS "To_json") s`,
    rows: [{ to_json: 1 }],
  },
  {
    name: "a column spelled like quote_literal",
    sql: `SELECT s.quote_literal FROM (SELECT 'a' AS "Quote_literal") s`,
    rows: [{ quote_literal: "a" }],
  },
  {
    name: "a table alias in capitals, referenced in lower case",
    sql: `SELECT x FROM (SELECT 1 AS x) AS "R" WHERE r.x > 0`,
    rows: [{ x: 1 }],
  },
  {
    name: "an output column in capitals, ordered by in lower case",
    sql: `SELECT x AS "Y" FROM (SELECT 1 AS x) AS t ORDER BY y`,
    rows: [{ y: 1 }],
  },
  {
    name: "a window defined in lower case, used in capitals",
    sql: `SELECT count(*) OVER "W" AS n FROM (SELECT 1 AS x) AS t WINDOW w AS ()`,
    rows: [{ n: 1 }],
  },
  {
    name: "a column alias list in capitals",
    sql: `SELECT a FROM (SELECT 1) AS t ("A")`,
    rows: [{ a: 1 }],
  },
];

/**
 * Queries that name the kernel's tables or the catalog: refused, or executed with nothing of theirs.
 * These are refused by the analyser before the database is reached, with or without the printer's
 * structure, so they guard the analyser's refusal and do not tell a fixed printer from a broken one;
 * the cases below them do.
 */
const THEIRS: readonly { name: string; sql: string }[] = [
  { name: "the kernel's table", sql: `SELECT id, scopes FROM principals` },
  { name: "the catalog", sql: `SELECT relname FROM pg_class` },
  { name: "pg_settings", sql: `SELECT name, setting FROM pg_settings` },
  {
    name: "to_json of a row of a CTE that shadows the kernel's table by spelling",
    sql: `WITH "Principals" AS (SELECT 1 AS "id") SELECT p.to_json FROM principals p`,
  },
  {
    name: "concat of a row of a CTE that shadows it",
    sql: `WITH "Principals" AS (SELECT 1 AS "id") SELECT p.concat FROM principals p`,
  },
  {
    name: "quote_literal of a row of a CTE that shadows it",
    sql: `WITH "Slots" AS (SELECT 1 AS "id") SELECT p.quote_literal FROM slots p`,
  },
  {
    name: "a catalog CTE with a function-style column",
    sql: `WITH "Pg_class" AS (SELECT 1 AS x) SELECT c.to_json FROM pg_class c`,
  },
];

/** The functions that apply to a whole row when a column of that name is not there (`s.f` is `f(s)`). */
const ROW_FUNCTIONS = [
  "to_json",
  "row_to_json",
  "concat",
  "quote_literal",
  "json_agg",
  "pg_typeof",
  "pg_column_size",
] as const;

/**
 * `q.f` where the innermost table called `q` has no column `f` and an outer one called `q` has:
 * PostgreSQL stays at the innermost and reads `f(q)`, applying a function to a whole row. The
 * analyser must not go outwards; the inner item is a subquery, a CTE or a slot table.
 */
const INNER: readonly { name: string; sql: (f: string) => string }[] = [
  {
    name: "an inner subquery",
    sql: (f) =>
      `SELECT (SELECT s.${f} FROM (SELECT 'MARKER_inner' AS x, 2 AS y) s) AS v FROM (SELECT 1 AS ${f}) s`,
  },
  {
    name: "an inner CTE",
    sql: (f) =>
      `WITH s AS (SELECT 'MARKER_inner' AS x, 2 AS y) SELECT (SELECT s.${f} FROM s) AS v FROM (SELECT 1 AS ${f}) s`,
  },
  {
    name: "an inner slot table, with a decoy table of the name that has a hidden column",
    sql: (f) => `SELECT (SELECT r.${f} FROM runs r) AS v FROM (SELECT 'a' AS ${f}) r`,
  },
];

/** What the analyser and the database must agree on in the names of output columns. */
const OUTPUT_NAMES: readonly {
  name: string;
  sql: string;
  want: { refused: string } | { rows: unknown[] };
}[] = [
  {
    name: "a scalar subquery without AS, read by a name that is also an outer column",
    sql: `SELECT (SELECT laps FROM (SELECT (SELECT 'm' AS laps)) s) AS v FROM runs`,
    // PostgreSQL binds `laps` to the inner unnamed column; the analyser has no name for it and must
    // not go on to the outer table: the name is refused, with a hint to give the column an AS.
    want: { refused: "unknown_name" },
  },
  {
    name: "the same with the inner column named: the outer correlation still works",
    sql: `SELECT (SELECT n FROM (SELECT 1 AS n) s WHERE laps > 0) AS v FROM runs`,
    want: { rows: [{ v: 1 }] },
  },
  {
    name: "a star over a column of a scalar subquery",
    sql: `SELECT * FROM (SELECT (SELECT 1 AS x)) s`,
    want: { rows: [{ "?column?": 1 }] },
  },
  {
    name: "DISTINCT ON a bare name that is an output column and an input column: the output one",
    sql: `SELECT DISTINCT ON (laps) feeling AS laps, 0 AS x FROM (SELECT 1 AS laps, 10 AS feeling UNION ALL SELECT 2, 10 UNION ALL SELECT 3, 20) s ORDER BY laps`,
    // On the input column `laps` (1, 2, 3) there would be three rows, not two.
    want: {
      rows: [
        { laps: 10, x: 0 },
        { laps: 20, x: 0 },
      ],
    },
  },
  {
    name: "DISTINCT ON an output column's name that no input column has",
    sql: `SELECT DISTINCT ON (z) laps AS z FROM runs`,
    want: { rows: [{ z: 7 }] },
  },
  {
    name: "GROUP BY a bare name that is no column of this level, only an outer one",
    sql: `SELECT (SELECT max(k) AS laps FROM (SELECT 5 AS k) s GROUP BY laps) AS v FROM runs`,
    // `laps` is the output column here (an aggregate: no group key), not the outer table's column:
    // the database refuses it, and so must the analyser.
    want: { refused: "node" },
  },
  {
    name: "GROUP BY a bare name found nowhere at this level",
    sql: `SELECT (SELECT max(k) AS m FROM (SELECT 5 AS k) s GROUP BY laps) AS v FROM runs`,
    want: { refused: "unknown_name" },
  },
  {
    name: "GROUP BY a bare name that is an output column's name",
    sql: `SELECT k AS g, count(*) AS n FROM (SELECT 1 AS k UNION ALL SELECT 1) s GROUP BY g`,
    want: { rows: [{ g: 1, n: 2 }] },
  },
  {
    name: "JOIN ... ON naming a comma item before it in the same FROM: the outer one is meant",
    sql: `SELECT (SELECT count(*) FROM runs a, runs b JOIN runs c ON a.laps = c.laps) AS v FROM runs a`,
    want: { rows: [{ v: 1 }] },
  },
  {
    name: "slot.table.column where the FROM did not write the slot",
    sql: `SELECT health.runs.laps FROM runs`,
    want: { refused: "unknown_name" },
  },
  {
    name: "slot.table.column where the FROM wrote the slot",
    sql: `SELECT health.runs.laps FROM health.runs`,
    want: { rows: [{ laps: 7 }] },
  },
  {
    name: "a CAST over a scalar subquery, read by the name PostgreSQL would give it",
    sql: `SELECT (SELECT numeric FROM (SELECT CAST((SELECT 1 AS x) AS numeric(10, 2))) s) AS v FROM runs`,
    want: { refused: "unknown_name" },
  },
];

describe("the printed text, executed", () => {
  it.each(ROW_FUNCTIONS.flatMap((f) => INNER.map((i) => [`${f}: ${i.name}`, f, i] as const)))(
    "%s is refused, never run as a function of a row",
    async (_n, f, i) => {
      const r = await run(i.sql(f));
      expect(JSON.stringify(r)).not.toContain(MARK);
      expect(r).toEqual({ refused: "unknown_name" });
    },
  );

  it.each(OUTPUT_NAMES.map((c) => [c.name, c] as const))(
    "%s: the analyser and the database agree",
    async (_n, c) => {
      const r = await run(c.sql);
      expect(r).toMatchObject(c.want);
    },
  );

  it.each(OWN.map((c) => [c.name, c] as const))(
    "%s gives what the caller's query defines",
    async (_n, c) => {
      const r = await run(c.sql);
      expect(r).toMatchObject({ rows: c.rows });
    },
  );

  it.each(THEIRS.map((c) => [c.name, c] as const))(
    "%s reaches nothing of the kernel or the catalog",
    async (_n, c) => {
      const r = await run(c.sql);
      const seen = JSON.stringify(r);
      expect(seen).not.toContain(MARK);
      expect(seen).not.toMatch(/pg_catalog|pg_class|search_path|principals_pkey/);
      if ("rows" in r) {
        // Executed: the rows can only be the CTE's own.
        expect(r.rows.length).toBeLessThanOrEqual(1);
      }
    },
  );
});
