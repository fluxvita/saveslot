// Derived rules' bound text run on PGlite (03-data-model/11-restricted-sql.md «类型», «确定性»): the
// compiler's types are the types PostgreSQL gives. For every generated rule of this version's
// subset that compiles, its ID-bound text (09-event-format §7 `rule.sql`) is executed against tables
// laid out by the fields' physical column types:
//
// 1. on empty tables, it plans: no "function or operator does not exist / is not unique" or any
//    other error, and each output column's type (the result's type OID) is the one the analysis
//    inferred (integer → int8, decimal and quantity → numeric, date, text for text, enum and ref,
//    boolean);
// 2. on rows holding edge values (NULLs, 64-bit extremes, empty and non-ASCII text, far dates), it
//    evaluates without error, except the evaluation errors 11 «确定性» 6 names as data-dependent:
//    division by zero (rewritten to NULL with the physical text, not done here), 64-bit and numeric
//    overflow, a date out of range.
//
// The generator reaches each form whose type PostgreSQL resolves differently from a plain reading
// in a minimum share of rules. The bound text is run as printed (tables "t1", columns "f1"…), with
// saveslot_date / saveslot_today / saveslot_now standing in as SQL functions: the rewriting to
// physical names and columns comes with derived evaluation.

import { PGlite } from "@electric-sql/pglite";
import {
  compileDerivedRule,
  type DerivedRuleResult,
  loadRsql,
  SESSION_SETTINGS,
} from "@fluxvita/saveslot-kernel";
import {
  FORMS,
  fc,
  generatedRule,
  propRuns,
  rule,
  TABLES,
} from "@fluxvita/saveslot-kernel/rsql-testing";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";

vi.setConfig({ testTimeout: 300_000 });

/** Physical column types by field type. */
const COLUMN: Readonly<Record<string, string>> = {
  text: 'text COLLATE "C"',
  enum: 'text COLLATE "C"',
  ref: 'text COLLATE "C"',
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: "timestamptz",
};

/** Result type OIDs by derived field type. */
const OID: Readonly<Record<string, number>> = {
  integer: 20,
  decimal: 1700,
  quantity: 1700,
  date: 1082,
  text: 25,
  enum: 25,
  ref: 25,
  boolean: 16,
};

/** Data-dependent evaluation errors (11 «确定性» 6): division by zero, overflow, a date out of range. */
const DATA_ERRORS = new Set(["22012", "22003", "22008"]);

const runs = TABLES.find((t) => t.id === "t1") as (typeof TABLES)[number];

function createTable(schema: string): string {
  const cols = runs.fields.map((f) => `"${f.id}" ${COLUMN[f.type]}`);
  return `CREATE TABLE ${schema}."t1" ("row_id" text COLLATE "C", ${cols.join(", ")})`;
}

/** f1 date, f2 distance, f3 duration, f4 feeling, f5 route, f6 laps, f7 pace, f8 started, f9 shoe, f10 race, f11 uphill. */
const EDGE_ROWS = [
  "('r1', NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL, NULL)",
  "('r2', '2026-11-14', 12.34, 55.5, 'a b', 'park', 3, 5.123, '2026-11-14 07:00:00+08', 'shoe', true, 1.25)",
  "('r3', '9999-12-31', 99999999999.99, 0.0, '', 'river', 9223372036854775807, 99999.999, '9999-12-31 23:00:00Z', '', false, 0)",
  "('r4', '0001-01-01', -0.01, 0.1, '说😀%,a', 'park', -9223372036854775808, -0.001, '1970-01-01 00:00:00Z', 'x', true, 99.99)",
  "('r5', '1970-01-01', 0, 0, ',', 'river', 0, 0, '2000-02-29 12:00:00Z', NULL, NULL, 0)",
];

let db: PGlite;

beforeAll(async () => {
  await loadRsql();
  db = await PGlite.create();
  for (const s of SESSION_SETTINGS) await db.exec(s);
  await db.exec(`
    CREATE SCHEMA s_empty;
    CREATE SCHEMA s_edge;
    ${createTable("s_empty")};
    ${createTable("s_edge")};
    INSERT INTO s_edge."t1" VALUES ${EDGE_ROWS.join(", ")};
    CREATE FUNCTION public.saveslot_date(timestamptz) RETURNS date LANGUAGE sql IMMUTABLE
      AS $$ SELECT ($1 AT TIME ZONE 'UTC')::date $$;
    CREATE FUNCTION public.saveslot_today() RETURNS date LANGUAGE sql IMMUTABLE
      AS $$ SELECT DATE '2026-11-14' $$;
    CREATE FUNCTION public.saveslot_now() RETURNS timestamptz LANGUAGE sql IMMUTABLE
      AS $$ SELECT TIMESTAMPTZ '2026-11-14 12:00:00Z' $$;
  `);
});

afterAll(async () => {
  await db.close();
});

async function run(schema: string, sql: string) {
  await db.exec(`SET search_path TO ${schema}, public`);
  return db.query(sql);
}

const errorCode = (e: unknown) => (e as { code?: unknown }).code;

describe("bound rules on PGlite", () => {
  it("plan with the inferred types, and evaluate on edge rows with only data-dependent errors", async () => {
    let checked = 0;
    const reached = new Map<string, number>();
    const samples: { sql: string; r: DerivedRuleResult & { ok: true } }[] = [];
    // Compile first (synchronous), then run each on PGlite.
    fc.assert(
      fc.property(generatedRule, (g) => {
        const r = compileDerivedRule(rule(g.sql, g.fields, g.timeDependency));
        if (r.ok) samples.push({ sql: g.sql, r });
      }),
      { numRuns: propRuns(300) },
    );
    expect(samples.length).toBeGreaterThan(0);
    for (const { sql, r } of samples) {
      const bound = r.rule.sql;
      const where = `${sql}\n→ ${bound}`;
      let fields: readonly { name: string; dataTypeID: number }[];
      try {
        fields = (await run("s_empty", bound)).fields;
      } catch (e) {
        // A constant folded when planning may still overflow: no types to check then.
        if (DATA_ERRORS.has(String(errorCode(e)))) continue;
        throw new Error(`${where}\n→ ${String(errorCode(e))} ${(e as Error).message}`);
      }
      checked++;
      expect(
        fields.map((f) => [f.name, f.dataTypeID]),
        where,
      ).toEqual(
        fields.map((f) => {
          const field = r.fields[Number(f.name.slice(1)) - 1];
          return [f.name, OID[field?.type ?? ""]];
        }),
      );
      try {
        await run("s_edge", bound);
      } catch (e) {
        if (!DATA_ERRORS.has(String(errorCode(e))))
          throw new Error(`${where}\n→ ${String(errorCode(e))} ${(e as Error).message}`);
      }
      for (const f of FORMS) {
        if (f.reached(sql, bound)) reached.set(f.name, (reached.get(f.name) ?? 0) + 1);
      }
    }
    // Rules whose types were checked: nearly all compiled ones.
    expect(checked / samples.length).toBeGreaterThanOrEqual(0.9);
    if (process.env["RSQL_FORMS"] !== undefined)
      console.log(
        `compiled ${samples.length}, types checked ${checked}\n` +
          FORMS.map((f) => `${f.name} ${((reached.get(f.name) ?? 0) / checked).toFixed(3)}`).join(
            "\n",
          ),
      );
    for (const f of FORMS) {
      expect({ form: f.name, share: (reached.get(f.name) ?? 0) / checked >= 0.02 }).toEqual({
        form: f.name,
        share: true,
      });
    }
  });
});
