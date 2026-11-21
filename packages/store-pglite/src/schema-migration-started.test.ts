// apply of `schema.migration_started` (09-event-format §5.5; 08-schema-migration «状态机»), on
// hand-made operations: the migration's row, `started`, and nothing built; a log at odds with
// itself stops apply. The path that logs the event (a confirmed draft rebuilding tables) is closed
// in this version, so the event is written here by hand. Fictional names.

import {
  applyEvents,
  createOpsContext,
  createTenant,
  schemaDraft,
} from "@fluxvita/saveslot-kernel";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const MIGRATION = `m_${"5".repeat(16)}`;

const EXPENSES = {
  name: "expenses",
  kind: "base",
  description: "one row per expense",
  time: { type: "none" },
  fields: [{ name: "note", type: "text", description: "what for" }],
};

let s: ReusableStore;
let minute = 0;
const now = () => `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: now(),
    confirmation: null,
  });
// biome-ignore lint/suspicious/noExplicitAny: results read as JSON
type Any = any;
const rows = async (q: string) =>
  (await s.store.read((tx) => tx.query(q))).rows as Record<string, unknown>[];
/**
 * Applies one hand-made `schema.migration_started` as the member of an operation it is: the header
 * of the draft's `schema.compiled` (a member event of the slot) with its type and position changed;
 * the error apply stops with, if it does. Not appended: the log takes an operation only from its
 * head event, and the head that brings this one (a confirmation) is closed in this version.
 */
const run = (target: Record<string, unknown>) =>
  s.store
    .write(async (tx) => {
      const r = await tx.query<{ header: string; seq: unknown }>(
        "SELECT header, (SELECT max(seq) FROM events) AS seq FROM events WHERE type = 'schema.compiled' ORDER BY seq DESC LIMIT 1",
      );
      const x = r.rows[0] as { header: string; seq: unknown };
      const seq = Number(x.seq) + 1;
      const header = { ...JSON.parse(x.header), type: "schema.migration_started", seq };
      await applyEvents(tx, [
        {
          seq: seq as never,
          header,
          blocks: new Map([["target", { state: "present", value: target }]]),
        },
      ] as never);
    })
    .then(
      () => "applied",
      (e: Error) => e.message,
    );
const started = (draft: string, from: number, to: number, id = MIGRATION) => ({
  migration_id: id,
  draft_id: draft,
  from_version: from,
  to_version: to,
});

let slotId: string;
let draftId: string;
beforeAll(async () => {
  s = await openReusable("saveslot-schema-migration-started-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  minute = 0;
  await createTenant(s.store, ctx());
  slotId = (
    (await schemaDraft(s.store, ctx(), {
      document: {
        slot: "ledger",
        base_version: null,
        timezone: "Asia/Shanghai",
        tables: [EXPENSES],
      },
    })) as Any
  ).slot_id;
  // A pending draft at version 2 rebuilding the table (a required field added waits).
  draftId = (await rebuilding("ledger")).draft;
}, T);

/** A draft adding a required field to the slot's table at version 1: pending, rebuilding it. */
async function rebuilding(slot: string, table = "t1"): Promise<Any> {
  const d = (await schemaDraft(s.store, ctx(), {
    document: {
      slot,
      base_version: 1,
      timezone: "Asia/Shanghai",
      tables: [
        {
          ...EXPENSES,
          id: table,
          fields: [
            { ...EXPENSES.fields[0], id: "f1" },
            {
              name: "amount",
              type: "integer",
              required: true,
              description: "how much",
              backfill: { const: 0 },
            },
          ],
        },
      ],
    },
  })) as Any;
  expect(d).toMatchObject({ outcome: "pending", target_sv: 2 });
  return d;
}

describe("schema.migration_started", () => {
  it(
    "records the migration, started; the slot stays at its version and nothing is built",
    async () => {
      const tables = async () =>
        (await rows("SELECT tablename FROM pg_tables WHERE tablename LIKE 't\\_%' ORDER BY 1")).map(
          (r) => r["tablename"],
        );
      const before = await tables();
      expect(await run(started(draftId, 1, 2))).toBe("applied");
      expect(await rows("SELECT * FROM migrations")).toEqual([
        {
          id: MIGRATION,
          slot_id: slotId,
          draft_id: draftId,
          from_sv: 1,
          target_sv: 2,
          state: "started",
        },
      ]);
      expect(await rows("SELECT current_sv FROM slots")).toEqual([{ current_sv: 1 }]);
      expect(await rows("SELECT sv, state FROM schema_versions ORDER BY sv")).toEqual([
        { sv: 1, state: "current" },
        { sv: 2, state: "pending" },
      ]);
      expect(await tables()).toEqual(before);
    },
    T,
  );

  it(
    "stops on a log at odds with itself: another starting version, a draft not pending there, a migration running",
    async () => {
      const odds = /inconsistent|migration m_/;
      expect(await run(started(draftId, 2, 3))).toMatch(odds);
      expect(await run(started(`d_${"9".repeat(16)}`, 1, 2))).toMatch(odds);
      expect(await run(started(draftId, 1, 2))).toBe("applied");
      expect(await run(started(draftId, 1, 2, `m_${"6".repeat(16)}`))).toMatch(odds);
      expect(await rows("SELECT id FROM migrations")).toEqual([{ id: MIGRATION }]);
    },
    T,
  );

  it(
    "stops on a version that rebuilds no table: only a rebuilding version has a migration (09 §4.5)",
    async () => {
      // A rename instead, version 3, superseding the draft at 2: it rebuilds nothing.
      const d = (await schemaDraft(s.store, ctx(), {
        document: {
          slot: "ledger",
          base_version: 1,
          timezone: "Asia/Shanghai",
          tables: [
            { ...EXPENSES, id: "t1", fields: [{ ...EXPENSES.fields[0], id: "f1", name: "memo" }] },
          ],
        },
      })) as Any;
      expect(d).toMatchObject({ outcome: "pending", target_sv: 3 });
      expect(await run(started(d.draft, 1, 3))).toMatch(
        /inconsistent.*rebuilds no table|rebuilds no table/,
      );
      expect(await rows("SELECT id FROM migrations")).toEqual([]);
    },
    T,
  );

  it(
    "stops on a migration ID already recorded, in another slot: not the storage's key violation",
    async () => {
      expect(await run(started(draftId, 1, 2))).toBe("applied");
      await schemaDraft(s.store, ctx(), {
        document: {
          slot: "other",
          base_version: null,
          timezone: "Asia/Shanghai",
          tables: [EXPENSES],
        },
      });
      const other = await rebuilding("other", "t2");
      const r = await run(started(other.draft, 1, 2));
      expect(r).toMatch(/already recorded/);
      expect(r).not.toMatch(/duplicate key|unique/i);
      expect(await rows("SELECT id, draft_id FROM migrations")).toEqual([
        { id: MIGRATION, draft_id: draftId },
      ]);
    },
    T,
  );
});
