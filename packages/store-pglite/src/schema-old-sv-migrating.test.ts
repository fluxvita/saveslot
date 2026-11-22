// Writes while a migration runs (08-schema-migration.md «状态机»; 07-schema-evolution.md «原则» 4;
// 04-contract §2): the version migrated from is still the current one, so a write at it, or at an
// earlier version with nothing incompatible since, is taken as before; the version migrated to is
// no version yet, and a write at it is refused as any version not in effect. The migration is begun
// by a hand-made `schema.migration_started` (the path that logs it, a confirmed draft rebuilding a
// table, opens with building a version); end to end it comes with that. Fictional names.

import {
  applyEvents,
  createOpsContext,
  createTenant,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const MIGRATION = `m_${"5".repeat(16)}`;

const PAIRS = {
  name: "pairs",
  kind: "base",
  description: "two texts",
  time: { type: "none" },
  fields: [
    { name: "a", type: "text", description: "first" },
    { name: "b", type: "text", description: "second" },
  ],
};

let s: ReusableStore;
let minute = 0;
const ctx = (task: string | null = null) =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
async function answer(f: () => Promise<unknown>): Promise<Any> {
  try {
    return await f();
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
}
const rows = async (q: string) =>
  (await s.store.read((tx) => tx.query(q))).rows as Record<string, unknown>[];
const draft = (document: unknown): Promise<Any> =>
  schemaDraft(s.store, ctx("schema"), { document });
const w = (params: unknown): Promise<Any> => write(s.store, ctx("w"), params);
/** `pairs` at `base` with field `a` as given. */
const pairs = (base: number, a: Record<string, unknown>, more: Record<string, unknown>[] = []) => ({
  slot: "ledger",
  base_version: base,
  timezone: "Asia/Shanghai",
  tables: [
    {
      ...PAIRS,
      id: "t1",
      fields: [{ ...PAIRS.fields[0], id: "f1", ...a }, { ...PAIRS.fields[1], id: "f2" }, ...more],
    },
  ],
});

/**
 * Applies one hand-made `schema.migration_started` as the member of an operation (the header of the
 * draft's `schema.compiled` with its type and position changed). Not appended: the log takes an
 * operation only from its head event, and the head that brings this one is not open yet.
 */
const begin = (draftId: string, from: number, to: number) =>
  s.store.write(async (tx) => {
    const r = await tx.query<{ header: string; seq: unknown }>(
      "SELECT header, (SELECT max(seq) FROM events) AS seq FROM events WHERE type = 'schema.compiled' ORDER BY seq DESC LIMIT 1",
    );
    const x = r.rows[0] as { header: string; seq: unknown };
    const seq = Number(x.seq) + 1;
    await applyEvents(tx, [
      {
        seq: seq as never,
        header: { ...JSON.parse(x.header), type: "schema.migration_started", seq },
        blocks: new Map([
          [
            "target",
            {
              state: "present",
              value: {
                migration_id: MIGRATION,
                draft_id: draftId,
                from_version: from,
                to_version: to,
              },
            },
          ],
        ]),
      },
    ] as never);
  });

beforeAll(async () => {
  s = await openReusable("saveslot-schema-old-sv-migrating-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  await draft({ slot: "ledger", base_version: null, timezone: "Asia/Shanghai", tables: [PAIRS] });
  // Version 2: a description (automatic). Version 3 waits: a required field added rebuilds the table.
  expect(await draft(pairs(1, { description: "the first" }))).toMatchObject({ outcome: "applied" });
  const d = await draft(
    pairs(2, { description: "the first" }, [
      { name: "c", type: "text", required: true, description: "third", backfill: { const: "-" } },
    ]),
  );
  expect(d).toMatchObject({ outcome: "pending", target_sv: 3 });
  await begin(d.draft, 2, 3);
  expect(await rows("SELECT state, from_sv, target_sv FROM migrations")).toEqual([
    { state: "started", from_sv: 2, target_sv: 3 },
  ]);
}, T);

describe("writes while a migration runs", () => {
  it(
    "at the version migrated from, and at an earlier one with nothing incompatible since: taken",
    async () => {
      expect(
        await w({ sv: 2, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
      ).toMatchObject({ sv: 2, status: "saved" });
      expect(
        await w({ sv: 1, ops: [{ intent: "insert", table: "pairs", set: { b: "B" } }] }),
      ).toMatchObject({ sv: 1, status: "saved" });
      // Into the current version's table, as before the migration.
      expect(await rows(`SELECT f_f1, f_f2 FROM "t_t1_v1" ORDER BY f_f1 NULLS LAST`)).toEqual([
        { f_f1: "A", f_f2: null },
        { f_f1: null, f_f2: "B" },
      ]);
      // The slot stays at the version migrated from.
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 2 }]);
    },
    T,
  );

  it(
    "at the version migrated to: no version in effect yet, refused as malformed",
    async () => {
      expect(
        await answer(() =>
          w({ sv: 3, ops: [{ intent: "insert", table: "pairs", set: { a: "A" } }] }),
        ),
      ).toEqual({ code: "invalid_argument", reason: "malformed", param: "sv" });
    },
    T,
  );
});
