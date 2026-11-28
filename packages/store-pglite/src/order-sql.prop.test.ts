// `query`'s order in SQL against `cmpKeys` (04-contract «`query`», the default order; §15; kernel
// read/order-sql.ts):
// random rows of keys of every type a query orders by, nulls among them, put in the database as
// a table would hold them, then
//
// 1. `ORDER BY orderBySql(keys)` gives the rows in `cmpKeys`'s order (equal keys in either order);
// 2. `WHERE afterKeysSql(keys, k)` keeps exactly the rows `cmpKeys` puts strictly after `k`, for
//    `k` one of the rows' keys or keys of its own;
// 3. `WHERE rowAfterSql(keys, k)`, on keys all ascending and never null (a state table's primary
//    key), keeps the same rows.
//
// The values are drawn from small pools as well as wide ranges, so that keys tie: numbers equal in
// value but written apart (`1`, `1.0`, `1.00`), text whose code point order is not its UTF-16 order
// (a character beyond the BMP against U+FFFF), instants in the same millisecond written with
// another offset, dates over four-digit years, both booleans. Every key's direction is drawn, and
// two properties hold every key ascending and every key descending.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { TenantStore } from "@fluxvita/saveslot-kernel";
import {
  afterKeysSql,
  cmpKeys,
  type KeySpec,
  type KeyValue,
  orderBySql,
  Params,
  rowAfterSql,
  type SqlKey,
  type SqlKeyType,
} from "@fluxvita/saveslot-kernel/testing";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { testBackend } from "./testing/test-backend.fixture.ts";

const RUNS = propRuns(200);
/** `PROP_SEED` fixes the seed. */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const seeded = SEED !== undefined ? { seed: SEED } : {};

/** A key's value: as the column holds it (SQL text) and as `rowKeys` gives it. */
interface Cell {
  readonly sql: string | boolean | null;
  readonly key: KeyValue;
}

/** The key type `cmpKeys` compares with, for each SQL type. */
const KEY_TYPE: Readonly<Record<SqlKeyType, KeySpec["type"]>> = {
  numeric: "number",
  bigint: "count",
  text: "text",
  date: "plain",
  timestamptz: "plain",
  boolean: "boolean",
};

const NULL: Cell = { sql: null, key: null };

/** A decimal written with trailing zeros or not; the key is its canonical form. */
const numeric: fc.Arbitrary<Cell> = fc
  .record({
    neg: fc.boolean(),
    int: fc.oneof(fc.integer({ min: 0, max: 3 }), fc.bigInt({ min: 0n, max: 10n ** 20n })),
    frac: fc.oneof(
      fc.constant(""),
      fc.constantFrom("5", "25", "05", "1"),
      fc.stringMatching(/^[0-9]{1,4}$/),
    ),
    zeros: fc.integer({ min: 0, max: 2 }),
  })
  .map(({ neg, int, frac, zeros }) => {
    const intText = String(int);
    const written = frac === "" && zeros === 0 ? intText : `${intText}.${frac}${"0".repeat(zeros)}`;
    const kept = frac.replace(/0+$/, "");
    const zero = /^0*$/.test(intText.replace(/^0+/, "")) && kept === "";
    const canonical = zero ? "0" : `${neg ? "-" : ""}${intText}${kept === "" ? "" : `.${kept}`}`;
    return { sql: `${neg ? "-" : ""}${written}`, key: canonical };
  });

const bigint: fc.Arbitrary<Cell> = fc
  .oneof(fc.integer({ min: -3, max: 3 }), fc.integer({ min: -1_000_000, max: 1_000_000 }))
  .map((n) => ({ sql: String(n), key: n }));

/** Code point order differs from UTF-16 order on "￿" against a character beyond the BMP. */
const TEXTS = ["", "a", "A", "ab", "b", "é", "é", "￿", "\u{1f600}", "\u{10000}", "", "Z", " "];
const text: fc.Arbitrary<Cell> = fc
  .oneof(
    fc.constantFrom(...TEXTS),
    fc
      .string({ unit: "binary", maxLength: 4 })
      // PostgreSQL text holds neither NUL nor a lone surrogate (not UTF-8).
      .filter((s) => !s.includes("\u0000") && !/[\ud800-\udfff]/u.test(s)),
  )
  .map((s) => ({ sql: s, key: s }));

const DAY = 86_400_000;
const date: fc.Arbitrary<Cell> = fc
  .oneof(
    fc.integer({ min: 0, max: 3 }).map((d) => Date.UTC(2026, 0, 1) + d * DAY),
    fc.integer({ min: Date.UTC(1, 0, 1), max: Date.UTC(9999, 11, 31) }),
  )
  .map((ms) => {
    const d = new Date(ms).toISOString().slice(0, 10);
    return { sql: d, key: d };
  });

/** An instant at milliseconds, written as UTC or with a +08:00 offset; the key is UTC text. */
const timestamptz: fc.Arbitrary<Cell> = fc
  .record({
    ms: fc.oneof(
      fc.integer({ min: 0, max: 2 }).map((d) => Date.UTC(2026, 10, 15, 4) + d),
      fc.integer({ min: Date.UTC(1000, 0, 1), max: Date.UTC(9999, 11, 31) }),
    ),
    offset: fc.boolean(),
  })
  .map(({ ms, offset }) => {
    const utc = new Date(ms).toISOString();
    const sql = offset ? `${new Date(ms + 8 * 3_600_000).toISOString().slice(0, -1)}+08:00` : utc;
    return { sql, key: utc };
  });

const boolean: fc.Arbitrary<Cell> = fc.boolean().map((b) => ({ sql: b, key: b }));

const CELLS: Readonly<Record<SqlKeyType, fc.Arbitrary<Cell>>> = {
  numeric,
  bigint,
  text,
  date,
  timestamptz,
  boolean,
};

const TYPES = Object.keys(CELLS) as SqlKeyType[];

interface Sample {
  readonly types: readonly SqlKeyType[];
  readonly dirs: readonly ("asc" | "desc")[];
  readonly rows: readonly (readonly Cell[])[];
  /** The keys to take the rows after: one of the rows' (by index), or keys of its own. */
  readonly after: number | readonly Cell[];
}

const cellOf = (t: SqlKeyType): fc.Arbitrary<Cell> =>
  fc.oneof({ arbitrary: fc.constant(NULL), weight: 1 }, { arbitrary: CELLS[t], weight: 4 });

const sample = (dir: fc.Arbitrary<"asc" | "desc">): fc.Arbitrary<Sample> =>
  fc.array(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 4 }).chain((types) =>
    fc.record({
      types: fc.constant(types),
      dirs: fc.array(dir, { minLength: types.length, maxLength: types.length }),
      rows: fc.array(fc.tuple(...types.map(cellOf)), { minLength: 1, maxLength: 30 }),
      after: fc.oneof(fc.nat({ max: 29 }), fc.tuple(...types.map(cellOf))),
    }),
  );

const DIR = fc.constantFrom<"asc" | "desc">("asc", "desc");

let root: string;
let store: TenantStore;

beforeAll(async () => {
  root = mkdtempSync(join(tmpdir(), "saveslot-order-sql-"));
  store = await testBackend().open({ kind: "pglite", dir: join(root, "tenant") }, { create: true });
});

afterAll(async () => {
  await store?.close();
  rmSync(root, { recursive: true, force: true });
});

/** The sample's rows as a VALUES list, and its keys over the list's columns. */
function table(s: Sample, p: Params): { from: string; keys: SqlKey[]; specs: KeySpec[] } {
  // Text in a collation other than "C" (the test database's default is "C"): the order must not
  // depend on the column's own collation, so the "C" in orderBySql / afterKeysSql is what holds it.
  const cast = (t: SqlKeyType) => (t === "text" ? '::text COLLATE "und-x-icu"' : `::${t}`);
  const rows = s.rows.map(
    (r, i) =>
      `(${p.add(i, "::int")}, ${r.map((c, j) => p.add(c.sql, cast(s.types[j] as SqlKeyType))).join(", ")})`,
  );
  const names = s.types.map((_, j) => `k${j}`);
  const specs = s.types.map((t, j) => ({ type: KEY_TYPE[t], dir: s.dirs[j] as "asc" | "desc" }));
  const keys = s.types.map((t, j) => ({
    expr: `v.${names[j]}`,
    type: t,
    spec: specs[j] as KeySpec,
  }));
  return { from: `(VALUES ${rows.join(", ")}) AS v(i, ${names.join(", ")})`, keys, specs };
}

const keysOf = (r: readonly Cell[]): KeyValue[] => r.map((c) => c.key);

async function check(s: Sample): Promise<void> {
  // 1. ORDER BY against cmpKeys: the SQL order, read as keys, never goes backwards, and agrees
  //    with cmpKeys's own sort position by position (equal keys may be in either order).
  const p = new Params();
  const t = table(s, p);
  const ordered = await store.read((tx) =>
    tx.query<{ i: number }>(`SELECT v.i FROM ${t.from} ORDER BY ${orderBySql(t.keys)}`, p.list),
  );
  const bySql = ordered.rows.map((r) => keysOf(s.rows[r.i] as Cell[]));
  const byCmp = s.rows.map(keysOf).sort((a, b) => cmpKeys(t.specs, a, b));
  expect(bySql.length).toBe(s.rows.length);
  for (let i = 0; i < bySql.length; i++) {
    expect(cmpKeys(t.specs, bySql[i] as KeyValue[], byCmp[i] as KeyValue[]), `position ${i}`).toBe(
      0,
    );
    if (i > 0)
      expect(
        cmpKeys(t.specs, bySql[i - 1] as KeyValue[], bySql[i] as KeyValue[]),
      ).toBeLessThanOrEqual(0);
  }

  // 2. The rows after some keys: exactly those cmpKeys puts after them.
  const after = typeof s.after === "number" ? (s.rows[s.after % s.rows.length] as Cell[]) : s.after;
  const q = new Params();
  const u = table(s, q);
  const where = afterKeysSql(u.keys, keysOf(after), q);
  const kept = await store.read((tx) =>
    tx.query<{ i: number }>(`SELECT v.i FROM ${u.from} WHERE ${where} ORDER BY v.i`, q.list),
  );
  const expected = s.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => cmpKeys(u.specs, keysOf(r), keysOf(after)) > 0)
    .map(({ i }) => i);
  expect(kept.rows.map((r) => r.i)).toEqual(expected);
}

/** Rows and keys of its own, every key ascending and never null: a state table's primary key. */
const ascendingNoNull: fc.Arbitrary<Sample> = fc
  .array(fc.constantFrom(...TYPES), { minLength: 1, maxLength: 3 })
  .chain((types) =>
    fc.record({
      types: fc.constant(types),
      dirs: fc.constant(types.map(() => "asc" as const)),
      rows: fc.array(fc.tuple(...types.map((t) => CELLS[t])), { minLength: 1, maxLength: 30 }),
      after: fc.oneof(fc.nat({ max: 29 }), fc.tuple(...types.map((t) => CELLS[t]))),
    }),
  );

/** `WHERE rowAfterSql(keys, k)`: exactly the rows cmpKeys puts strictly after `k`. */
async function checkRow(s: Sample): Promise<void> {
  const after = typeof s.after === "number" ? (s.rows[s.after % s.rows.length] as Cell[]) : s.after;
  const q = new Params();
  const u = table(s, q);
  const where = rowAfterSql(u.keys, keysOf(after), q);
  const kept = await store.read((tx) =>
    tx.query<{ i: number }>(`SELECT v.i FROM ${u.from} WHERE ${where} ORDER BY v.i`, q.list),
  );
  const expected = s.rows
    .map((r, i) => ({ r, i }))
    .filter(({ r }) => cmpKeys(u.specs, keysOf(r), keysOf(after)) > 0)
    .map(({ i }) => i);
  expect(kept.rows.map((r) => r.i)).toEqual(expected);
}

describe("query's order in SQL is cmpKeys's", () => {
  it("a row comparison after keys ascending and never null keeps the rows cmpKeys puts after them", async () => {
    await fc.assert(fc.asyncProperty(ascendingNoNull, checkRow), { numRuns: RUNS, ...seeded });
  });

  it("every key's direction drawn", async () => {
    await fc.assert(fc.asyncProperty(sample(DIR), check), { numRuns: RUNS, ...seeded });
  });

  it("every key ascending", async () => {
    await fc.assert(fc.asyncProperty(sample(fc.constant("asc")), check), {
      numRuns: RUNS,
      ...seeded,
    });
  });

  it("every key descending", async () => {
    await fc.assert(fc.asyncProperty(sample(fc.constant("desc")), check), {
      numRuns: RUNS,
      ...seeded,
    });
  });

  // The ties and orders the drawn samples must not depend on chance to meet.
  it("fixed cases: equal numbers written apart, code points beyond the BMP, the same millisecond, nulls", async () => {
    const n = (sql: string, key: string): Cell => ({ sql, key });
    for (const dir of ["asc", "desc"] as const) {
      await check({
        types: ["numeric", "text"],
        dirs: [dir, "asc"],
        rows: [
          [n("1.00", "1"), n("b", "b")],
          [n("1", "1"), n("a", "a")],
          [NULL, n("c", "c")],
          [n("-0.50", "-0.5"), n("￿", "￿")],
          [n("10", "10"), n("\u{1f600}", "\u{1f600}")],
        ],
        after: 0,
      });
      await check({
        types: ["text"],
        dirs: [dir],
        rows: [[n("￿", "￿")], [n("\u{1f600}", "\u{1f600}")], [NULL], [n("", "")]],
        after: 0,
      });
      await check({
        types: ["timestamptz", "bigint"],
        dirs: [dir, dir],
        rows: [
          [n("2026-11-15T04:00:00.001Z", "2026-11-15T04:00:00.001Z"), { sql: "2", key: 2 }],
          [n("2026-11-15T12:00:00.001+08:00", "2026-11-15T04:00:00.001Z"), { sql: "1", key: 1 }],
          [NULL, { sql: "3", key: 3 }],
          [n("2026-11-15T04:00:00.000Z", "2026-11-15T04:00:00.000Z"), NULL],
        ],
        after: 1,
      });
      await check({
        types: ["boolean", "date"],
        dirs: [dir, dir],
        rows: [
          [{ sql: true, key: true }, n("0999-01-02", "0999-01-02")],
          [{ sql: false, key: false }, n("9999-12-31", "9999-12-31")],
          [NULL, NULL],
          [{ sql: false, key: false }, NULL],
        ],
        after: [NULL, NULL],
      });
    }
  });
});
