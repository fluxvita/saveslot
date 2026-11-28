// The disk a local store takes per row (#59): a guard against it growing, not a target. A fixed
// load of personal data (five event tables, about 10,000 rows, in requests of 200 ops each with a
// short user message as evidence, and two derived tables) is written into a new store, and the
// database's growth over the load, divided by the rows, must stay under BYTES_PER_ROW. Measured at
// about 5.9 KB a row (#59, 33,800 rows of the same shape); the bound leaves a tenth over that.
// Lower it when a change makes the store smaller. The WAL is not counted: it is bounded on its own
// (`max_wal_size`, durability.ts).

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createOpsContext, createTenant, schemaDraft, write } from "@fluxvita/saveslot-kernel";
import { afterAll, describe, expect, it } from "vitest";
import { testBackend } from "./testing/test-backend.fixture.ts";

/** The bound, in bytes per row. */
const BYTES_PER_ROW = 6_656; // 6.5 KiB

const T = 600_000;
const TENANT = `tn_${"5".repeat(26)}`;
const USER = `u_${"6".repeat(26)}`;

const f = (name: string, type: string, required = false) => ({
  name,
  type,
  ...(required ? { required: true } : {}),
  description: name,
});
const event = (name: string, fields: ReturnType<typeof f>[]) => ({
  name,
  kind: "base",
  description: name,
  time: { type: "event", field: "day" },
  fields: [f("day", "date", true), ...fields],
});
const DOCUMENT = {
  slot: "me",
  base_version: null,
  timezone: "UTC",
  tables: [
    event("meals", [f("dish", "text", true), f("kcal", "integer"), f("note", "text")]),
    event("activity", [f("steps", "integer", true), f("active_min", "integer")]),
    event("sleep", [f("hours", "integer", true), f("quality", "text")]),
    event("nutrition", [f("protein_g", "integer"), f("water_ml", "integer")]),
    event("workouts", [f("kind", "text", true), f("minutes", "integer")]),
    {
      name: "kcal_by_day",
      kind: "derived",
      description: "calories a day",
      rule: {
        sql: "SELECT day, sum(kcal) AS kcal, count(*) AS n FROM meals GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "day", description: "day" },
        { name: "kcal", description: "kcal" },
        { name: "n", description: "meals" },
      ],
    },
    {
      name: "workouts_by_month",
      kind: "derived",
      description: "workouts a month",
      rule: {
        sql: "SELECT date_trunc('month', day::timestamp)::date AS month, count(*) AS n, sum(minutes) AS minutes FROM workouts GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "month", description: "month" },
        { name: "n", description: "workouts" },
        { name: "minutes", description: "minutes" },
      ],
    },
  ],
};

const day = (i: number) =>
  new Date(Date.UTC(2016, 0, 1) + i * 86_400_000).toISOString().slice(0, 10);
const DISHES = ["oatmeal", "salad", "rice and fish", "noodles", "sandwich", "soup", "omelette"];
/** Each table, how many rows, and row i. 10,100 rows in all. */
const LOAD: [string, number, (i: number) => Record<string, unknown>][] = [
  [
    "meals",
    6_000,
    (i) => ({
      day: day(Math.floor(i / 5.4)),
      dish: DISHES[i % 7],
      kcal: 300 + (i % 500),
      note: i % 4 === 0 ? `with friends ${i % 13}` : null,
    }),
  ],
  [
    "activity",
    1_100,
    (i) => ({ day: day(i), steps: 4000 + ((i * 37) % 9000), active_min: 20 + (i % 70) }),
  ],
  [
    "sleep",
    1_100,
    (i) => ({ day: day(i), hours: 5 + (i % 4), quality: ["good", "fair", "poor"][i % 3] }),
  ],
  [
    "nutrition",
    1_100,
    (i) => ({ day: day(i), protein_g: 50 + (i % 60), water_ml: 1500 + (i % 9) * 100 }),
  ],
  [
    "workouts",
    800,
    (i) => ({
      day: day(Math.floor(i * 1.37)),
      kind: ["run", "swim", "gym", "yoga"][i % 4],
      minutes: 20 + (i % 50),
    }),
  ],
];
const BATCH = 200;

let request = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: new Date(Date.UTC(2026, 10, 5) + ++request * 1000).toISOString(),
    confirmation: null,
  });

const roots: string[] = [];
afterAll(() => {
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

describe("the disk a local store takes per row", () => {
  it(
    `a fixed load of personal data takes at most ${BYTES_PER_ROW} bytes a row`,
    async () => {
      const root = mkdtempSync(join(tmpdir(), "saveslot-size-budget-"));
      roots.push(root);
      const store = await testBackend().open(
        { kind: "pglite", dir: join(root, "tenant") },
        { create: true },
      );
      try {
        await createTenant(store, ctx());
        const draft = (await schemaDraft(store, ctx(), { document: DOCUMENT })) as { sv?: number };
        const sv = draft.sv ?? 1;
        const size = () =>
          store.read(async (tx) => {
            const r = await tx.query<{ n: unknown }>(
              "SELECT pg_database_size(current_database())::bigint AS n",
            );
            return Number(r.rows[0]?.n);
          });
        const before = await size();
        let rows = 0;
        for (const [table, count, row] of LOAD) {
          for (let at = 0; at < count; at += BATCH) {
            const ops = Array.from({ length: Math.min(BATCH, count - at) }, (_, j) => ({
              intent: "insert",
              table: `me.${table}`,
              set: row(at + j),
            }));
            const r = (await write(store, ctx(), {
              sv,
              evidence: [
                {
                  kind: "user_message",
                  text: `log ${table} for ${day(at)} and after (${ops.length})`,
                },
              ],
              ops,
            })) as { status?: string };
            expect(r.status).toBe("saved");
            rows += ops.length;
          }
        }
        expect(rows).toBe(10_100);
        const grown = (await size()) - before;
        const perRow = Math.round(grown / rows);
        // By table, for the message when it fails.
        const byTable = await store.read(async (tx) => {
          const r = await tx.query<{ name: string; total: unknown }>(
            `SELECT c.relname AS name, pg_total_relation_size(c.oid)::bigint AS total FROM pg_class c
             WHERE c.relnamespace = 'public'::regnamespace AND c.relkind = 'r'
             ORDER BY 2 DESC LIMIT 6`,
          );
          return r.rows
            .map((x) => `${x.name} ${Math.round(Number(x.total) / 1024)} KiB`)
            .join(", ");
        });
        console.log(`size budget: ${perRow} bytes a row over ${rows} rows (${byTable})`);
        // A measure that read nothing would pass any bound.
        expect(perRow, byTable).toBeGreaterThan(1_000);
        expect(perRow, `${perRow} bytes a row; largest tables: ${byTable}`).toBeLessThanOrEqual(
          BYTES_PER_ROW,
        );
      } finally {
        await store.close();
      }
    },
    T,
  );
});
