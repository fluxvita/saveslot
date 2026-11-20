// The segments of a state table as a reader sees them (11-restricted-sql.md «时间» «SQL 看到的段»;
// kernel `mergedSegments`): adjacent segments of one entity that hold the same values are one.
// Physical tables are built here by hand, so that every cut is the one the case says (a write makes
// cuts of its own, not ones a case can pick), and the generator is run on PGlite.

import { PGlite } from "@electric-sql/pglite";
import { mergedSegments, SESSION_SETTINGS } from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

type CompiledBaseTable = Parameters<typeof mergedSegments>[0];

const DAY: CompiledBaseTable = {
  id: "t1",
  name: "budgets",
  kind: "base",
  description: "by the day",
  time: { type: "state", granularity: "date" },
  physical: { table: "t_t1_v1" },
  fields: [
    { id: "f1", name: "category", type: "text", description: "kind" },
    { id: "f2", name: "amount", type: "integer", description: "how much" },
    { id: "f3", name: "at", type: "zoned_datetime", description: "when" },
  ],
} as unknown as CompiledBaseTable;

const INSTANT: CompiledBaseTable = {
  ...DAY,
  id: "t2",
  physical: { table: "t_t2_v1" },
  time: { type: "state", granularity: "instant" },
  fields: [],
} as unknown as CompiledBaseTable;

let db: PGlite;

beforeAll(async () => {
  db = await PGlite.create();
  for (const s of SESSION_SETTINGS) await db.exec(s);
  await db.exec(`
    CREATE TABLE "t_t1_v1" (
      entity_id text NOT NULL, valid_from date NOT NULL, valid_to date,
      "f_f1" text COLLATE "C", "f_f2" bigint, "f_f3" timestamptz, "f_f3__zone" text,
      PRIMARY KEY (entity_id, valid_from));
    CREATE TABLE "t_t2_v1" (
      entity_id text NOT NULL, valid_from timestamptz NOT NULL, valid_to timestamptz,
      PRIMARY KEY (entity_id, valid_from))`);
}, 120_000);
afterAll(async () => {
  await db?.close();
});

type Seg = [
  entity: string,
  from: string,
  to: string | null,
  cat: string | null,
  amount: number | null,
  at?: [string, string],
];

/** Loads the segments and gives what a reader sees, as `entity from–to category amount`. */
async function seen(segs: Seg[]): Promise<string[]> {
  await db.exec(`DELETE FROM "t_t1_v1"`);
  for (const [e, f, t, c, a, at] of segs) {
    await db.query(`INSERT INTO "t_t1_v1" VALUES ($1, $2, $3, $4, $5, $6, $7)`, [
      e,
      f,
      t,
      c,
      a,
      at?.[0] ?? null,
      at?.[1] ?? null,
    ]);
  }
  const r = await db.query<{
    entity_id: string;
    valid_from: Date;
    valid_to: Date | null;
    f_f1: string | null;
    f_f2: unknown;
  }>(
    `SELECT entity_id, valid_from::text AS valid_from, valid_to::text AS valid_to, "f_f1", "f_f2"::text AS "f_f2"
     FROM (${mergedSegments(DAY)}) m ORDER BY entity_id, valid_from`,
  );
  return r.rows.map(
    (x) => `${x.entity_id} ${x.valid_from}–${x.valid_to ?? ""} ${x.f_f1 ?? "∅"} ${x.f_f2 ?? "∅"}`,
  );
}

describe("merging adjacent segments", () => {
  it("joins a chain of adjacent segments holding the same values, ending where the last ends", async () => {
    expect(
      await seen([
        ["e1", "2026-11-01", "2026-11-10", "food", 100],
        ["e1", "2026-11-10", "2026-11-20", "food", 100],
        ["e1", "2026-11-20", "2026-12-01", "food", 100],
      ]),
    ).toEqual(["e1 2026-11-01–2026-12-01 food 100"]);
  });

  it("is open at the end when the last segment is", async () => {
    expect(
      await seen([
        ["e1", "2026-11-01", "2026-11-10", "food", 100],
        ["e1", "2026-11-10", null, "food", 100],
      ]),
    ).toEqual(["e1 2026-11-01– food 100"]);
  });

  it("does not join across a gap, nor across a different value", async () => {
    expect(
      await seen([
        ["e1", "2026-11-01", "2026-11-10", "food", 100],
        ["e1", "2026-11-11", "2026-11-20", "food", 100],
        ["e1", "2026-11-20", "2026-11-25", "food", 150],
        ["e1", "2026-11-25", null, "food", 100],
      ]),
    ).toEqual([
      "e1 2026-11-01–2026-11-10 food 100",
      "e1 2026-11-11–2026-11-20 food 100",
      "e1 2026-11-20–2026-11-25 food 150",
      "e1 2026-11-25– food 100",
    ]);
  });

  it("takes an empty field as a value: two empty ones are the same, an empty one and a set one are not", async () => {
    expect(
      await seen([
        ["e1", "2026-11-01", "2026-11-05", "food", null],
        ["e1", "2026-11-05", "2026-11-10", "food", null],
        ["e1", "2026-11-10", "2026-11-15", "food", 0],
        ["e1", "2026-11-15", "2026-11-20", null, 0],
      ]),
    ).toEqual([
      "e1 2026-11-01–2026-11-10 food ∅",
      "e1 2026-11-10–2026-11-15 food 0",
      "e1 2026-11-15–2026-11-20 ∅ 0",
    ]);
  });

  it("keeps entities apart", async () => {
    expect(
      await seen([
        ["e1", "2026-11-01", "2026-11-10", "food", 100],
        ["e2", "2026-11-10", "2026-11-20", "food", 100],
        ["e2", "2026-11-20", "2026-11-30", "food", 100],
      ]),
    ).toEqual(["e1 2026-11-01–2026-11-10 food 100", "e2 2026-11-10–2026-11-30 food 100"]);
  });

  it("takes a zoned date-time's zone as part of its value", async () => {
    const at: [string, string] = ["2026-11-01T00:00:00Z", "Asia/Shanghai"];
    const same = await seen([
      ["e1", "2026-11-01", "2026-11-10", "x", 1, at],
      ["e1", "2026-11-10", "2026-11-20", "x", 1, at],
    ]);
    expect(same).toEqual(["e1 2026-11-01–2026-11-20 x 1"]);
    const other = await seen([
      ["e1", "2026-11-01", "2026-11-10", "x", 1, at],
      ["e1", "2026-11-10", "2026-11-20", "x", 1, ["2026-11-01T00:00:00Z", "Europe/London"]],
    ]);
    expect(other).toHaveLength(2);
  });

  it("gives the same rows however a stretch is cut", async () => {
    const whole: Seg[] = [["e1", "2026-11-01", null, "food", 100]];
    const cut: Seg[] = [
      ["e1", "2026-11-01", "2026-11-03", "food", 100],
      ["e1", "2026-11-03", "2026-11-04", "food", 100],
      ["e1", "2026-11-04", "2026-11-09", "food", 100],
      ["e1", "2026-11-09", null, "food", 100],
    ];
    expect(await seen(cut)).toEqual(await seen(whole));
  });

  it("works on a table of no field at all (adjacent segments are the same)", async () => {
    await db.exec(`DELETE FROM "t_t2_v1"; INSERT INTO "t_t2_v1" VALUES
      ('e1', '2026-11-01T00:00:00Z', '2026-11-02T00:00:00Z'),
      ('e1', '2026-11-02T00:00:00Z', NULL)`);
    const r = await db.query<{ n: unknown }>(
      `SELECT count(*) AS n FROM (${mergedSegments(INSTANT)}) m`,
    );
    expect(Number(r.rows[0]?.n)).toBe(1);
  });
});
