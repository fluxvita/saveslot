// Marks that name who gave a value (04-contract «标记»): `corrected` on a state entity's piece is
// whether a correction gave the value read there, and `revoked.seq` the revoke's operation — both
// from the contribution behind the cell (its `src_event`), not from when the cell was last cut,
// which another write's cut changes. In query's first page, its later pages and history's as_of.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  history,
  query,
  readBufferOf,
  write,
} from "@fluxvita/saveslot-kernel";
import { COMPILED_V1, createSlotEvents } from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "spend",
      kind: "base",
      description: "events by day",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "date", type: "date", required: true, description: "day" },
        { id: "f2", name: "note", type: "text", description: "free text" },
        {
          id: "f3",
          name: "distance",
          type: "quantity",
          description: "how far",
          unit: { code: "km", dimension: "length", to_base: "1000" },
          precision: { scale: 2, rounding: "half_up" },
        },
      ],
    },
    {
      id: "t2",
      name: "budgets",
      kind: "base",
      description: "by the day",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f1", name: "category", type: "text", required: true, description: "kind" },
        { id: "f2", name: "amount", type: "integer", description: "how much" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...COMPILED.tables.map((t) => ({ target: { table: t.id }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
const clock = () => {
  minute++;
  return `2026-11-05T03:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const ctx = (
  o: { actor?: string; now?: string; task?: string | null; visibility?: unknown } = {},
) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.actor ?? USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: o.now ?? clock(),
    confirmation: null,
  });
type Receipt = Awaited<ReturnType<typeof write>>;
const w = (params: Record<string, unknown>, actor = USER): Promise<Receipt> =>
  write(s.store, ctx({ actor }), { sv: 1, ...params });
const h = (params: Record<string, unknown>, o: Parameters<typeof ctx>[0] = {}) =>
  history(s.store, ctx(o), params) as unknown as Promise<Record<string, unknown>>;

let row: string;
let entity: string;
const ops: Record<string, number> = {};

beforeAll(async () => {
  s = await openReusable("saveslot-history-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  minute = 0;
  await createTenant(
    s.store,
    createOpsContext({
      tenant: TENANT,
      actor: USER,
      trigger: null,
      task: null,
      visibility: { kind: "all" },
      idempotency_key_window: 86_400_000,
      idempotency_window: 600_000,
      now: "2026-11-05T00:00:00.000Z",
      confirmation: null,
    }),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
  const ins = await w({
    evidence: [{ kind: "user_message", text: "ran 1 km on the 1st" }],
    ops: [
      {
        intent: "insert",
        table: "spend",
        set: { date: "2026-11-01", note: "a", distance: { value: "1", unit: "km" } },
      },
    ],
  });
  row = ins.ops[0]?.target.row as string;
  ops["insert"] = ins.seq;
  ops["update"] = (
    await w({ ops: [{ intent: "update", table: "spend", row, set: { note: "b" } }] })
  ).seq;
  ops["correct"] = (
    await w({
      ops: [
        { intent: "correct", table: "spend", row, set: { distance: { value: "2000", unit: "m" } } },
      ],
    })
  ).seq;
  ops["revoke"] = (await w({ ops: [{ intent: "revoke", table: "spend", row }] })).seq;
  const b = await w({
    ops: [
      {
        intent: "insert",
        table: "budgets",
        set: { category: "food", amount: 100 },
        valid_from: "2026-11-01",
      },
    ],
  });
  entity = b.ops[0]?.target.entity as string;
  ops["budget"] = b.seq;
  ops["raise"] = (
    await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          set: { amount: 150 },
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
        },
      ],
    })
  ).seq;
  readBufferOf(s.store).take();
}, T);

describe("corrected: a correction's value, cut later by another write", () => {
  /** 1 from 11-01; corrected to 2 from 11-01; then 3 from 11-10, which cuts the corrected cell. */
  async function cut() {
    const e = await w({
      ops: [
        {
          intent: "insert",
          table: "budgets",
          set: { category: "rent", amount: 1 },
          valid_from: "2026-11-01",
        },
      ],
    });
    const en = e.ops[0]?.target.entity as string;
    await w({
      ops: [
        {
          intent: "correct",
          table: "budgets",
          entity: en,
          set: { amount: 2 },
          valid_from: "2026-11-01",
        },
      ],
    });
    const u = await w({
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity: en,
          set: { amount: 3 },
          valid_from: "2026-11-10",
        },
      ],
    });
    return { en, u };
  }
  const marked = (
    rows: { valid_from?: string; values: Record<string, unknown>; marks?: { corrected?: true } }[],
  ) => rows.map((x) => [x.valid_from, x.values["amount"], x.marks?.corrected === true]);
  // The piece the update cut keeps the correction's value: marked. The update's own piece: not.
  const expected = [
    ["2026-11-01", "2", true],
    ["2026-11-10", "3", false],
  ];
  const over = { table: "budgets", valid_during: ["2026-11-01", null], coalesce: false };

  it(
    "in query's first page",
    async () => {
      const { en } = await cut();
      const q = await query(s.store, ctx(), over);
      expect(marked(q.rows.filter((x) => x.entity === en) as never)).toEqual(expected);
    },
    T,
  );

  it(
    "in a later page of query (read as of the first page's operation)",
    async () => {
      const { en } = await cut();
      // Ordered so the cut piece comes on the second page.
      const params = {
        ...over,
        // Only this entity's pieces (the fixture's entity has larger amounts).
        where: [{ field: "amount", op: "<=", value: 3 }],
        order: [{ field: "amount", dir: "desc" }],
        limit: 1,
      };
      const p1 = await query(s.store, ctx(), params);
      const p2 = await query(s.store, ctx(), { ...params, position: p1.next_position });
      expect(marked([...p1.rows, ...p2.rows].filter((x) => x.entity === en) as never)).toEqual([
        expected[1],
        expected[0],
      ]);
    },
    T,
  );

  it(
    "in history's as_of",
    async () => {
      const { en, u } = await cut();
      const r = (await h({ table: "budgets", entity: en, mode: "as_of", as_of: u.seq })) as {
        rows: {
          valid_from?: string;
          values: Record<string, unknown>;
          marks?: { corrected?: true };
        }[];
      };
      expect(marked(r.rows)).toEqual(expected);
    },
    T,
  );
});

describe("revoked.seq: the revoke's operation", () => {
  it(
    "in query's first page, a later page and history's as_of",
    async () => {
      const a = await w({
        ops: [{ intent: "insert", table: "spend", set: { date: "2026-11-02", note: "x" } }],
      });
      const r = a.ops[0]?.target.row as string;
      const v = await w({ ops: [{ intent: "revoke", table: "spend", row: r }] });
      // Another write after it: the revoke stays the revoke's.
      await w({
        ops: [{ intent: "insert", table: "spend", set: { date: "2026-11-03", note: "y" } }],
      });
      const seqOf = (rows: { row?: string; marks?: { revoked?: { seq: number } } }[]) =>
        rows.filter((x) => x.row === r).map((x) => x.marks?.revoked?.seq);
      const params = {
        table: "spend",
        include_revoked: true,
        where: [{ field: "note", op: "in", value: ["x", "y", "a"] }],
      };
      expect(seqOf((await query(s.store, ctx(), params)).rows as never)).toEqual([v.seq]);
      const p1 = await query(s.store, ctx(), {
        ...params,
        order: [{ field: "note", dir: "desc" }],
        limit: 1,
      });
      const p2 = await query(s.store, ctx(), {
        ...params,
        order: [{ field: "note", dir: "desc" }],
        limit: 1,
        position: p1.next_position,
      });
      expect(seqOf(p2.rows as never)).toEqual([v.seq]);
      const at = (await h({ table: "spend", row: r, mode: "as_of", as_of: v.seq })) as {
        rows: { row?: string; marks?: { revoked?: { seq: number } } }[];
      };
      expect(at.rows.map((x) => x.marks?.revoked?.seq)).toEqual([v.seq]);
    },
    T,
  );
});
