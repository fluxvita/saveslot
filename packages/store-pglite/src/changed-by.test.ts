// `changed_by` on a read row (04-contract-types §4.1 `Row`; 04-contract §6): the writer of the
// operation in the row's `ver`, taken from the operation's head event, given when it is not the
// caller. An operation whose other events carry another actor (`system`, as a derived refresh or
// an item the system opens would) still names the one who made the operation.

import {
  appendOperation,
  applyEvents,
  compileNewSlot,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  loadRsql,
  query,
  write,
} from "@fluxvita/saveslot-kernel";
import { createSlotEvents, SLOT } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "lunch",
      kind: "base",
      description: "one row per lunch",
      time: { type: "none" },
      fields: [{ name: "note", type: "text", required: true, description: "what" }],
    },
  ],
};

let s: ReusableStore;
let minute = 0;
const ctx = (actor: string) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T03:${String(++minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-changed-by-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  await createTenant(s.store, ctx(USER));
  const compiled = compileNewSlot({
    document: structuredClone(DOCUMENT),
    slotId: SLOT,
    nextTableNumber: 1,
    nextRuleNumber: 1,
    existingSlotNames: [],
  });
  if (!compiled.ok) throw new Error(JSON.stringify(compiled.error));
  const events = createSlotEvents({
    compiled: compiled.compiled as never,
    changes: compiled.changes as never,
  });
  (events[0] as { blocks: Record<string, unknown> }).blocks["draft"] = structuredClone(DOCUMENT);
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

type Rows = { rows: { row: string; ver: string; changed_by?: { kind: string; id: string } }[] };

describe("changed_by", () => {
  it(
    "names the operation's maker from its head event, though its other events carry system",
    async () => {
      const w = (await write(s.store, ctx(USER), {
        sv: 1,
        evidence: [{ kind: "user_message", text: "noodles, then tea" }],
        ops: [
          { intent: "insert", table: "ledger.lunch", set: { note: "noodles" } },
          { intent: "insert", table: "ledger.lunch", set: { note: "tea" } },
        ],
      })) as unknown as { seq: number };
      // The operation's events after its head, as the system's: a derived refresh or an item the
      // system opens would be.
      await s.store.write((tx) =>
        tx.query("UPDATE events SET actor = 'system' WHERE op = $1 AND seq <> $1", [
          w.seq,
        ] as never),
      );
      const others = await s.store.read((tx) =>
        tx.query<{ n: unknown }>(
          "SELECT count(*) AS n FROM events WHERE op = $1 AND actor = 'system'",
          [w.seq] as never,
        ),
      );
      expect(Number(others.rows[0]?.n)).toBeGreaterThan(0);

      // Its maker reads its own rows: nothing to say.
      const own = (await query(s.store, ctx(USER), { table: "ledger.lunch" })) as unknown as Rows;
      expect(own.rows).toHaveLength(2);
      for (const r of own.rows) expect(r.changed_by).toBeUndefined();
      // Another reads them: the maker, not the system.
      const seen = (await query(s.store, ctx(OTHER), { table: "ledger.lunch" })) as unknown as Rows;
      for (const r of seen.rows) expect(r.changed_by).toMatchObject({ kind: "user", id: USER });
      // As of that operation: the same.
      const asOf = (await history(s.store, ctx(OTHER), {
        mode: "as_of",
        table: "ledger.lunch",
        row: seen.rows[0]?.row,
        as_of: w.seq,
      })) as unknown as Rows;
      expect(asOf.rows[0]?.changed_by).toMatchObject({ kind: "user", id: USER });
    },
    T,
  );
});
