// `pending` (04-contract §10 `pending`; 04-contract-types §4.8) through the real write path: the
// list, the detail of conflict and awaiting items, and the read it records. Two references:
// - the receipt of the write that opened the item: item_ver, the unit and spans, the write behind
//   the value in effect (`by`), the merge base, the impact, the candidate's or proposal's values
//   (on the unit existence: by, the merge base's seq and exists, the impact);
// - `query` at the same moment: the side in effect (and an awaiting item's current) piece by
//   piece, a piece with values having one row with them, a piece without none.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending,
  query,
  readBufferOf,
  write,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  DRAFT,
  itemEntries,
  SLOT,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const fields = [
  { id: "f2", name: "b", type: "text", required: true, description: "b" },
  { id: "f3", name: "c", type: "text", description: "c" },
];
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "rows",
      kind: "base",
      description: "rows",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields,
    },
    {
      id: "t5",
      name: "pairs",
      kind: "base",
      description: "two fields judged together",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t5_v1" },
      fields,
      together: [["f2", "f3"]],
    },
    {
      id: "t2",
      name: "entities",
      kind: "base",
      description: "entities over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t2_v1" },
      fields,
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
  return `2026-11-05T0${Math.floor(minute / 60) % 10}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const ctx = (o: { actor?: string; task?: string | null; visibility?: unknown } = {}) =>
  createOpsContext({
    tenant: TENANT,
    actor: o.actor ?? USER,
    trigger: null,
    task: o.task ?? null,
    visibility: (o.visibility ?? { kind: "all" }) as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: clock(),
    confirmation: null,
  });
type Receipt = Awaited<ReturnType<typeof write>>;
const w = (ops: Record<string, unknown>[], actor = USER): Promise<Receipt> =>
  write(s.store, ctx({ actor }), { sv: 1, ops });
const p = (params: Record<string, unknown>, o: Parameters<typeof ctx>[0] = {}) =>
  pending(s.store, ctx(o), params) as Promise<Record<string, unknown> & { items?: Item[] }>;
type Item = {
  id: string;
  type: string;
  status: string;
  slot: string;
  target?: unknown;
  opened_at: string;
};
async function refused(params: unknown, o: Parameters<typeof ctx>[0] = {}) {
  try {
    await pending(s.store, ctx(o), params);
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { code: x.code, ...(x.detail ?? {}) };
  }
  throw new Error("not refused");
}

beforeAll(async () => {
  s = await openReusable("saveslot-pending-", { buffered: true });
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
}, T);

const ver = (r: Receipt) => r.ops[0]?.ver as string;
const target = (r: Receipt) => r.ops[0]?.target as { row?: string; entity?: string };

/** A conflict on a timeless row: 9, then 9.5 in effect, then 10 written on the first version. */
async function rowConflict() {
  const a = await w([{ intent: "insert", table: "rows", set: { b: "9" } }]);
  const row = target(a).row as string;
  const b = await w(
    [{ intent: "update", table: "rows", row, ver: ver(a), set: { b: "9.5" } }],
    OTHER,
  );
  const c = await w([{ intent: "update", table: "rows", row, ver: ver(a), set: { b: "10" } }]);
  return { a, b, c, row };
}

/** A conflict on an entity: from 11-01, 11-10 on changed, a stale write over [11-05, 11-15). */
async function entityConflict() {
  const a = await w([
    { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
  ]);
  const entity = target(a).entity as string;
  const b = await w(
    [
      {
        intent: "update",
        table: "entities",
        entity,
        ver: ver(a),
        valid_from: "2026-11-10",
        set: { b: "y" },
      },
    ],
    OTHER,
  );
  const c = await w([
    {
      intent: "update",
      table: "entities",
      entity,
      ver: ver(a),
      valid_from: "2026-11-05",
      valid_to: "2026-11-15",
      set: { b: "z" },
    },
  ]);
  return { a, b, c, entity };
}

/** An awaiting item on an entity: a write over a change point (11-10) without acknowledging it. */
async function entityAwaiting() {
  const a = await w([
    { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
  ]);
  const entity = target(a).entity as string;
  const b = await w([
    {
      intent: "update",
      table: "entities",
      entity,
      ver: ver(a),
      valid_from: "2026-11-10",
      set: { b: "y" },
    },
  ]);
  const c = await w([
    {
      intent: "update",
      table: "entities",
      entity,
      ver: ver(b),
      valid_from: "2026-11-05",
      valid_to: "2026-11-15",
      set: { b: "z" },
    },
  ]);
  return { a, b, c, entity };
}

/** An awaiting item on a timeless row: undoing a write together with a later one. */
async function rowAwaiting() {
  const a = await w([{ intent: "insert", table: "rows", set: { b: "1" } }]);
  const row = target(a).row as string;
  const x = await w([{ intent: "update", table: "rows", row, ver: ver(a), set: { b: "2" } }]);
  const y = await w(
    [{ intent: "update", table: "rows", row, ver: ver(x), set: { b: "3" } }],
    OTHER,
  );
  const c = await w([{ table: "rows", row, revert: { undo: x.seq, include_later: true } }]);
  return { a, x, y, c, row };
}

/** Actor objects as their IDs, where a case names principals by ID only. */
const ids = (v: unknown): unknown =>
  Array.isArray(v)
    ? v.map(ids)
    : v !== null && typeof v === "object"
      ? "kind" in v && "id" in v && "name" in v
        ? (v as { id: string }).id
        : Object.fromEntries(Object.entries(v).map(([k, x]) => [k, ids(x)]))
      : v;

type Part = {
  result: string;
  item?: string;
  after?: unknown;
  effective?: unknown;
  by?: { seq: number; actor: unknown };
  previous?: unknown;
  impact?: unknown;
  valid?: { valid_from: string | null; valid_to: string | null };
};

/** The receipt's parts that went to an item, by field name. */
function partsOf(r: Receipt, item: string): [string, Part][] {
  const out: [string, Part][] = [];
  for (const op of r.ops)
    for (const [f, v] of Object.entries(op.fields as Record<string, Part | Part[]>))
      for (const x of Array.isArray(v) ? v : [v]) if (x.item === item) out.push([f, x]);
  return out;
}

/** Joins touching intervals (the receipt gives parts; the item, spans). */
function joined(xs: { valid_from: string | null; valid_to: string | null }[]) {
  const out: { valid_from: string | null; valid_to: string | null }[] = [];
  for (const x of [...xs].sort((a, b) =>
    String(a.valid_from).localeCompare(String(b.valid_from)),
  )) {
    const last = out.at(-1);
    if (last !== undefined && last.valid_to === x.valid_from) last.valid_to = x.valid_to;
    else out.push({ valid_from: x.valid_from, valid_to: x.valid_to });
  }
  return out;
}

/** The detail and the opening receipt agree on every part they share. */
async function agrees(r: Receipt, kind: "conflict" | "awaiting_confirmation") {
  const ref = r.pending.find((x) => x.type === kind);
  expect(ref?.item_ver).toBeDefined();
  const id = ref?.id as string;
  // Nothing renamed or revoked since: the receipt's actors as of its write are the detail's now.
  const d = (await p({ id })) as Record<string, unknown>;
  expect(d["item_ver"]).toBe(ref?.item_ver);
  const parts = partsOf(r, id);
  expect(parts.length).toBeGreaterThan(0);
  const t = d["target"] as {
    unit: string[];
    spans?: { valid_from: string; valid_to: string | null }[];
  };
  // On the unit existence the receipt files the part under the field written; the item, "*".
  const existence = t.unit.includes("*");
  if (!existence) expect([...t.unit].sort()).toEqual([...new Set(parts.map(([f]) => f))].sort());
  const valid = parts.flatMap(([, x]) => (x.valid !== undefined ? [x.valid] : []));
  if (valid.length > 0)
    expect(
      (t.spans ?? []).map((x) => ({ valid_from: x.valid_from, valid_to: x.valid_to })),
    ).toEqual(joined(valid));
  if (kind === "awaiting_confirmation") {
    for (const [, x] of parts) expect(d["impact"]).toEqual(x.impact ?? {});
    const proposal = d["proposal"] as { seq: number; set?: Record<string, unknown> };
    expect(proposal.seq).toBe(r.seq);
    if (proposal.set !== undefined)
      for (const [f, x] of parts)
        if (x.after !== undefined) expect(proposal.set[f]).toEqual(x.after);
    return d;
  }
  const eff = d["effective"] as {
    seq: number;
    actor: unknown;
    values?: Record<string, unknown>;
    spans?: { seq?: number; values: Record<string, unknown> | null }[];
  };
  const cands = d["candidates"] as {
    index: number;
    seq: number;
    values?: Record<string, unknown>;
  }[];
  const mine = cands.find((c) => c.seq === r.seq);
  expect(mine).toBeDefined();
  const impacts = (d["candidate_impact"] ?? {}) as Record<string, unknown>;
  for (const [f, x] of parts) {
    expect(x.by).toEqual({ seq: eff.seq, actor: eff.actor });
    if (existence) {
      // The receipt gives no row values and no spans for the merge base on this unit.
      const prev = d["previous"] as { seq: number; exists: boolean };
      expect(x.previous).toEqual({ seq: prev.seq, exists: prev.exists });
      expect(x.impact).toEqual(impacts[String(mine?.index)]);
      continue;
    }
    const value =
      eff.values !== undefined
        ? eff.values[f]
        : (eff.spans ?? []).find((y) => y.seq === eff.seq)?.values?.[f];
    expect(x.effective).toEqual(value);
    expect(x.previous).toEqual(d["previous"]);
    expect(x.impact).toEqual(impacts[String(mine?.index)]);
    if (x.after !== undefined) expect(mine?.values?.[f]).toEqual(x.after);
  }
  return d;
}

describe("the detail and the receipt that opened the item", () => {
  it(
    "agree on a conflict on a timeless row",
    async () => {
      const { c } = await rowConflict();
      const d = await agrees(c, "conflict");
      expect(d).toMatchObject({ type: "conflict", status: "open", reason: "stale_write" });
    },
    T,
  );

  it(
    "agree on a conflict on an entity",
    async () => {
      const { c } = await entityConflict();
      await agrees(c, "conflict");
    },
    T,
  );

  it(
    "agree on an awaiting item on an entity",
    async () => {
      const { c } = await entityAwaiting();
      const d = await agrees(c, "awaiting_confirmation");
      expect(d).toMatchObject({
        reason: "overwrites_change_point",
        decisions: ["confirm", "reject"],
      });
    },
    T,
  );

  it(
    "agree on an awaiting item on a timeless row",
    async () => {
      const { c, x } = await rowAwaiting();
      const d = await agrees(c, "awaiting_confirmation");
      expect(d["proposal"]).toMatchObject({ revert: { undo: x.seq, include_later: true } });
    },
    T,
  );
});

describe("the detail and the receipt, filling a gap and joining", () => {
  it(
    "agree on an awaiting item filling a gap left by a revoke",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      const v = await w([
        {
          intent: "revoke",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-05",
          valid_to: "2026-11-08",
        },
      ]);
      const c = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(v),
          valid_from: "2026-11-03",
          valid_to: "2026-11-10",
          set: { b: "z" },
        },
      ]);
      const d = await agrees(c, "awaiting_confirmation");
      expect(d["impact"]).toMatchObject({ filled_gaps: [{ revoked_by: v.seq }] });
    },
    T,
  );

  it(
    "gives a later stale write joined to the conflict, and the item's version after it",
    async () => {
      const { a, b, c, row } = await rowConflict();
      const id = c.pending[0]?.id as string;
      const j = await w(
        [{ intent: "update", table: "rows", row, ver: ver(a), set: { b: "11" } }],
        OTHER,
      );
      expect(j.pending).toEqual([{ id, type: "conflict", reason: "stale_write", merged: true }]);
      const d = ids(await p({ id })) as Record<string, unknown>;
      expect(d["item_ver"]).toBe(`iv_${id.slice(3)}.${j.seq}.0`);
      expect(d["effective"]).toEqual({
        seq: b.seq,
        actor: OTHER,
        values: { b: "9.5" },
        exists: true,
      });
      expect(
        (d["candidates"] as { index: number; seq: number; values: unknown }[]).map((x) => [
          x.index,
          x.seq,
          x.values,
        ]),
      ).toEqual([
        [0, c.seq, { b: "10" }],
        [1, j.seq, { b: "11" }],
      ]);
    },
    T,
  );
});

describe("a join on an entity", () => {
  it(
    "widens the item's spans to the joined candidate's",
    async () => {
      const { a, c, entity } = await entityConflict();
      const id = c.pending[0]?.id as string;
      const before = (await p({ id }))["target"] as { spans: unknown[] };
      const j = await w(
        [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: ver(a),
            valid_from: "2026-11-12",
            valid_to: "2026-11-20",
            set: { b: "q" },
          },
        ],
        OTHER,
      );
      expect(j.pending).toEqual([expect.objectContaining({ id, merged: true })]);
      const after = (await p({ id }))["target"] as {
        spans: { valid_from: string; valid_to: string | null }[];
      };
      expect(after.spans).not.toEqual(before.spans);
      expect(after.spans.map((x) => [x.valid_from, x.valid_to])).toEqual([
        ["2026-11-05", "2026-11-20"],
      ]);
    },
    T,
  );
});

describe("the detail", () => {
  it(
    "gives a conflict's whole contents",
    async () => {
      const { a, b, c, row } = await rowConflict();
      const id = c.pending[0]?.id as string;
      await likeQueryRow(ids(await p({ id })) as Record<string, unknown>, "rows", row);
      expect(ids(await p({ id }))).toEqual({
        id,
        type: "conflict",
        item_ver: c.pending[0]?.item_ver,
        status: "open",
        slot: "ledger",
        reason: "stale_write",
        opened_at: expect.any(String),
        opened_by: USER,
        decisions: ["keep_effective", "take_candidate", "take_previous"],
        target: { table: "ledger.rows", row, unit: ["b"] },
        effective: { seq: b.seq, actor: OTHER, values: { b: "9.5" }, exists: true },
        candidates: [
          {
            index: 0,
            seq: c.seq,
            actor: USER,
            intent: "update",
            ver: ver(a),
            values: { b: "10" },
            cause: "stale_write",
          },
        ],
        previous: { seq: a.seq, exists: true, values: { b: "9" } },
        reverted_by_previous: [{ seq: b.seq, actor: OTHER, fields: ["b"] }],
      });
    },
    T,
  );

  it(
    "counts as reading an open item's version, a closed one's not",
    async () => {
      const { b, c, row } = await rowConflict();
      const id = c.pending[0]?.id as string;
      const d = await p({ id }, { actor: OTHER });
      const read = readBufferOf(s.store).entries().at(-1);
      expect(read).toMatchObject({
        operation: "pending",
        slot: SLOT,
        table: "t1",
        shape: `{"item":"${id}"}`,
        rows: [],
        lastRead: [{ kind: "item", target: id, op: c.seq, restoreCount: 0 }],
      });
      expect(d["item_ver"]).toBe(`iv_${id.slice(3)}.${c.seq}.0`);
      // Having read it, the other connection's write over it supersedes it.
      const x = await w(
        [{ intent: "update", table: "rows", row, ver: ver(b), set: { b: "11" } }],
        OTHER,
      );
      expect(x.superseded).toEqual([{ item: id, type: "conflict", reason: "overwritten" }]);
      const closed = ids(await p({ id }, { actor: OTHER })) as Record<string, unknown>;
      expect(closed).toMatchObject({
        status: "superseded",
        decisions: [],
        superseded: { reason: "overwritten", by: x.seq, at: expect.any(String) },
      });
      expect(readBufferOf(s.store).entries().at(-1)?.lastRead).toEqual([]);
    },
    T,
  );

  it(
    "refuses an ID that is not an item's, a job's (not in this version), an unknown or invisible item",
    async () => {
      const { c } = await rowConflict();
      const id = c.pending[0]?.id as string;
      expect(await refused({ id: "x" })).toEqual({
        code: "invalid_argument",
        reason: "malformed",
        param: "id",
      });
      expect(await refused({ id: `jb_${"1".repeat(16)}` })).toMatchObject({
        code: "not_in_this_version",
      });
      const none = { code: "not_found", reason: "item", param: "id" };
      expect(await refused({ id: `pi_${"9".repeat(16)}` })).toEqual(none);
      const other = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t2" }] }] };
      expect(await refused({ id }, { visibility: other })).toEqual(none);
      expect(await refused({ id, status: "open" })).toMatchObject({
        reason: "malformed",
        param: "status",
      });
    },
    T,
  );
});

describe("the list", () => {
  it(
    "lists open items, longest pending first, with their targets; listing reads no item",
    async () => {
      const r = await rowConflict();
      const e = await entityConflict();
      const l = await p({});
      expect(l["total"]).toBe(2);
      expect(ids(l["items"])).toEqual([
        {
          id: r.c.pending[0]?.id,
          type: "conflict",
          status: "open",
          slot: "ledger",
          target: { table: "ledger.rows", row: r.row, unit: ["b"] },
          reason: "stale_write",
          opened_at: expect.any(String),
          opened_by: USER,
        },
        expect.objectContaining({
          id: e.c.pending[0]?.id,
          target: expect.objectContaining({
            table: "ledger.entities",
            entity: e.entity,
            unit: ["b"],
          }),
        }),
      ]);
      expect(readBufferOf(s.store).entries().at(-1)).toMatchObject({
        operation: "pending",
        lastRead: [],
      });
    },
    T,
  );

  it(
    "filters by type, status and slot; knows types no item has yet",
    async () => {
      const r = await rowConflict();
      await entityAwaiting();
      expect((await p({ type: "awaiting_confirmation" })).items?.map((x) => x.type)).toEqual([
        "awaiting_confirmation",
      ]);
      expect((await p({ type: "flagged" }))["total"]).toBe(0);
      expect((await p({ type: "schema_change" }))["total"]).toBe(0);
      expect((await p({ slot: "LEDGER" }))["total"]).toBe(2);
      // Superseded: by a write of the one that opened it (its receipt gave it whole).
      await w([{ intent: "update", table: "rows", row: r.row, ver: ver(r.b), set: { b: "12" } }]);
      expect((await p({}))["total"]).toBe(1);
      expect((await p({ status: "superseded" })).items?.map((x) => x.id)).toEqual([
        r.c.pending[0]?.id,
      ]);
      expect((await p({ status: "all" }))["total"]).toBe(2);
    },
    T,
  );

  it(
    "pages; a later page lists the items opened up to the first page, in their state now",
    async () => {
      const r1 = await rowConflict();
      const r2 = await entityConflict();
      const p1 = await p({ limit: 1 });
      expect(p1.items?.map((x) => x.id)).toEqual([r1.c.pending[0]?.id]);
      await entityAwaiting();
      const p2 = await p({ limit: 1, position: p1["next_position"] });
      expect(p2.items?.map((x) => x.id)).toEqual([r2.c.pending[0]?.id]);
      expect(p2).not.toHaveProperty("next_position");
    },
    T,
  );

  it(
    "shows nothing out of the visible range; refuses bad filters",
    async () => {
      await rowConflict();
      const other = { kind: "scoped", slots: [{ slot: SLOT, tables: [{ table: "t2" }] }] };
      expect((await p({}, { visibility: other }))["total"]).toBe(0);
      expect(await refused({ slot: "health" })).toEqual({
        code: "not_found",
        reason: "slot",
        param: "slot",
      });
      for (const [params, param] of [
        [{ type: "nope" }, "type"],
        [{ status: "closed" }, "status"],
        [{ limit: 0 }, "limit"],
        [{ slot: "" }, "slot"],
        [{ detail: true }, "detail"],
      ] as const)
        expect(await refused(params)).toEqual({
          code: "invalid_argument",
          reason: "malformed",
          param,
        });
    },
    T,
  );
});

type Sp = {
  valid_from: string;
  valid_to: string | null;
  values: Record<string, unknown> | null;
  seq?: number;
};
const spansOf = (d: Record<string, unknown>, k: string) =>
  ((d[k] as { spans?: Sp[] }).spans ?? []).map((x) => [
    x.valid_from,
    x.valid_to,
    x.values,
    x.seq ?? null,
  ]);

/**
 * A side of the detail (`effective`, or an awaiting item's `current`) is what `query` reads over the
 * item's spans at the same moment: a piece with values has exactly one row over it with those
 * values (a field empty in the row is null in both); a piece without values has no row over it.
 */
async function likeQuery(
  d: Record<string, unknown>,
  table: string,
  entity: string,
  side: "effective" | "current" = "effective",
) {
  const r = await query(s.store, ctx({ actor: OTHER }), {
    table,
    valid_during: ["2026-10-01", null],
    coalesce: false,
    clip: false,
  });
  const rows = r.rows.filter((x) => x.entity === entity);
  for (const sp of (d[side] as { spans: Sp[] }).spans) {
    const over = rows.filter(
      (x) =>
        (x.valid_from as string) <= sp.valid_from &&
        (x.valid_to === null || (sp.valid_to !== null && sp.valid_to <= (x.valid_to as string))),
    );
    if (sp.values === null) {
      expect({ sp, over: over.length }).toEqual({ sp, over: 0 });
      continue;
    }
    expect({ sp, over: over.length }).toEqual({ sp, over: 1 });
    for (const [f, v] of Object.entries(sp.values))
      expect({ sp, f, v: ((over[0]?.values ?? {}) as Record<string, unknown>)[f] }).toEqual({
        sp,
        f,
        v,
      });
  }
}

/**
 * The same on an event or timeless table: `exists` is whether `query` (revoked rows left out) has
 * the row, and the values given are the row's.
 */
async function likeQueryRow(
  d: Record<string, unknown>,
  table: string,
  row: string,
  side: "effective" | "current" = "effective",
) {
  const r = await query(s.store, ctx({ actor: OTHER }), { table });
  const here = r.rows.filter((x) => x.row === row);
  const x = d[side] as { values?: Record<string, unknown>; exists?: boolean };
  if (x.exists !== undefined) expect({ exists: x.exists }).toEqual({ exists: here.length === 1 });
  if (x.values !== undefined) {
    expect(here.length).toBe(1);
    for (const [f, v] of Object.entries(x.values))
      expect({ f, v: ((here[0]?.values ?? {}) as Record<string, unknown>)[f] }).toEqual({ f, v });
  }
}

/** Revoked pieces in the detail are those the item's entries record as revoked, and only those. */
async function likeEntries(d: Record<string, unknown>) {
  const id = d["id"] as string;
  const e = (await s.store.read((tx) => itemEntries(tx, [id]))).get(id);
  const revokedInEntries = (e?.current ?? [])
    .filter((b) => b["revoked"] === true)
    .map((b) => (b["valid"] as { from?: string } | undefined)?.from ?? null);
  const spans = (d["effective"] as { spans?: Sp[] }).spans ?? [];
  const revokedInDetail = spans
    .filter((x) => x.values === null && x.seq !== undefined)
    .map((x) => x.valid_from);
  expect(revokedInDetail).toEqual(revokedInEntries);
}

describe("the side in effect read from the row", () => {
  /** x from 11-01 (op a), y from 11-10 (op b), [11-05, 11-08) revoked (op v), z over [11-03, 11-25) on a's version. */
  async function existenceConflict() {
    const a = await w([
      {
        intent: "insert",
        table: "entities",
        valid_from: "2026-11-01",
        valid_to: "2026-11-20",
        set: { b: "x" },
      },
    ]);
    const entity = target(a).entity as string;
    const b = await w(
      [
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-10",
          valid_to: "2026-11-20",
          set: { b: "y" },
        },
      ],
      OTHER,
    );
    const v = await w(
      [
        {
          intent: "revoke",
          table: "entities",
          entity,
          ver: ver(b),
          valid_from: "2026-11-05",
          valid_to: "2026-11-08",
        },
      ],
      OTHER,
    );
    const c = await w([
      {
        intent: "update",
        table: "entities",
        entity,
        ver: ver(a),
        valid_from: "2026-11-03",
        valid_to: "2026-11-25",
        set: { b: "z" },
      },
    ]);
    return { a, b, v, c, entity };
  }

  it(
    "on the unit existence: each piece's write, revoked holes, a never-written piece; as query reads it",
    async () => {
      const { a, b, v, c, entity } = await existenceConflict();
      // The parts the receipt shares with the detail on this unit agree.
      const d = await agrees(c, "conflict");
      expect((d["target"] as { unit: string[] }).unit).toEqual(["*"]);
      const row = (x: string) => ({ b: x, c: null });
      expect(spansOf(d, "effective")).toEqual([
        ["2026-11-03", "2026-11-05", row("x"), a.seq],
        ["2026-11-05", "2026-11-08", null, v.seq],
        ["2026-11-08", "2026-11-10", row("x"), a.seq],
        ["2026-11-10", "2026-11-20", row("y"), b.seq],
        ["2026-11-20", "2026-11-25", null, null],
      ]);
      // The top: the latest write among the pieces, never the candidate's own.
      expect(d["effective"]).toMatchObject({ seq: v.seq, exists: true });
      expect((d["previous"] as { spans: unknown[] }).spans.length).toBeGreaterThan(0);
      await likeQuery(d, "entities", entity);
      await likeEntries(d);
    },
    T,
  );

  it(
    "a candidate over several pieces in effect: its range, and each piece with the write that gave it, in order",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      const at = (from: string, to: string, b: string, ver: string) =>
        w(
          [
            {
              intent: "update",
              table: "entities",
              entity,
              ver,
              valid_from: from,
              valid_to: to,
              set: { b },
            },
          ],
          OTHER,
        );
      const b1 = await at("2026-11-05", "2026-11-07", "y", ver(a));
      const b2 = await at("2026-11-10", "2026-11-12", "q", ver(b1));
      const c = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-01",
          valid_to: "2026-11-15",
          set: { b: "z" },
        },
      ]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      expect(
        (d["candidates"] as { valid: { valid_from: string; valid_to: string | null } }[]).map(
          (x) => [x.valid.valid_from, x.valid.valid_to],
        ),
      ).toEqual([["2026-11-01", "2026-11-15"]]);
      expect(spansOf(d, "effective").map((x) => [x[0], x[1], x[3]])).toEqual([
        ["2026-11-01", "2026-11-05", a.seq],
        ["2026-11-05", "2026-11-07", b1.seq],
        ["2026-11-07", "2026-11-10", a.seq],
        ["2026-11-10", "2026-11-12", b2.seq],
        ["2026-11-12", "2026-11-15", a.seq],
      ]);
      await likeQuery(d, "entities", entity);
    },
    T,
  );

  it(
    "a field unit's never-written piece is in effective's spans, without a write",
    async () => {
      const a = await w([
        {
          intent: "insert",
          table: "entities",
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "x" },
        },
      ]);
      const entity = target(a).entity as string;
      const b = await w(
        [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: ver(a),
            valid_from: "2026-11-05",
            valid_to: "2026-11-10",
            set: { b: "y" },
          },
        ],
        OTHER,
      );
      const c = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-01",
          valid_to: "2026-11-10",
          set: { b: "z" },
        },
      ]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      const spans = spansOf(d, "effective");
      expect(spans.map((x) => x[0])).toEqual([...spans.map((x) => x[0])].sort());
      expect(spans).toContainEqual(["2026-11-05", "2026-11-10", { b: "y" }, b.seq]);
      await likeQuery(d, "entities", entity);
    },
    T,
  );

  it(
    "a field group's awaiting item: each piece of current gives both fields, no overlaps",
    async () => {
      const a = await w([
        { intent: "insert", table: "pairs", valid_from: "2026-11-01", set: { b: "x", c: "1" } },
      ]);
      const entity = target(a).entity as string;
      const b = await w([
        {
          intent: "update",
          table: "pairs",
          entity,
          ver: ver(a),
          valid_from: "2026-11-08",
          set: { b: "y" },
        },
      ]);
      const c1 = await w([
        {
          intent: "update",
          table: "pairs",
          entity,
          ver: ver(b),
          valid_from: "2026-11-12",
          set: { c: "2" },
        },
      ]);
      const c = await w([
        {
          intent: "update",
          table: "pairs",
          entity,
          ver: ver(c1),
          valid_from: "2026-11-05",
          valid_to: "2026-11-15",
          set: { b: "z", c: "3" },
        },
      ]);
      const id = c.pending.find((x) => x.type === "awaiting_confirmation")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      const pieces = spansOf(d, "current");
      for (const [i, x] of pieces.entries()) {
        expect(Object.keys(x[2] as object).sort()).toEqual(["b", "c"]);
        if (i > 0) expect(x[0]).toBe(pieces[i - 1]?.[1]);
      }
      expect(pieces.map((x) => x[2])).toEqual([
        { b: "x", c: "1" },
        { b: "y", c: "1" },
        { b: "y", c: "2" },
      ]);
    },
    T,
  );

  it(
    "after a refresh, the detail gives the new side in effect",
    async () => {
      const { row } = await rowConflict();
      const id = (await p({})).items?.[0]?.id as string;
      const base = (await p({ id }))["effective"];
      const r = await w(
        [
          {
            intent: "update",
            table: "rows",
            row,
            ver: `v${(base as { seq: number }).seq}.0`,
            set: { b: "9.6" },
          },
        ],
        OTHER,
      );
      expect(r.pending).toEqual([expect.objectContaining({ id, refreshed: true })]);
      const d = ids(await p({ id })) as Record<string, unknown>;
      expect(d["effective"]).toEqual({
        seq: r.seq,
        actor: OTHER,
        values: { b: "9.6" },
        exists: true,
      });
      expect(d["item_ver"]).toBe(`iv_${id.slice(3)}.${r.seq}.0`);
    },
    T,
  );

  it(
    "after a join: previous as of the merge base, each candidate's own impact, the read on the item's current version",
    async () => {
      const { a, c, entity } = await entityConflict();
      const id = c.pending[0]?.id as string;
      const j = await w(
        [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: ver(a),
            valid_from: "2026-11-08",
            valid_to: "2026-11-20",
            set: { b: "q" },
          },
        ],
        OTHER,
      );
      const d = ids(await p({ id }, { actor: OTHER })) as Record<string, unknown>;
      expect(d["previous"]).toMatchObject({ seq: a.seq, exists: true });
      expect(
        spansOf(d, "previous").every((x) => JSON.stringify(x[2]) === JSON.stringify({ b: "x" })),
      ).toBe(true);
      const impact = d["candidate_impact"] as Record<
        string,
        { overwritten: { valid: { valid_from: string } }[] }
      >;
      expect(Object.keys(impact).sort()).toEqual(["0", "1"]);
      expect(impact["0"]?.overwritten.map((x) => x.valid.valid_from)).not.toEqual(
        impact["1"]?.overwritten.map((x) => x.valid.valid_from),
      );
      const cands = d["candidates"] as {
        index: number;
        valid: { valid_from: string; valid_to: string | null };
      }[];
      expect(cands.map((x) => [x.index, x.valid.valid_from, x.valid.valid_to])).toEqual([
        [0, "2026-11-05", "2026-11-15"],
        [1, "2026-11-08", "2026-11-20"],
      ]);
      expect(readBufferOf(s.store).entries().at(-1)?.lastRead).toEqual([
        { kind: "item", target: id, op: j.seq, restoreCount: 0 },
      ]);
    },
    T,
  );
});

describe("pieces, givers and the merge base", () => {
  const upd = (table: string, entity: string, ver_: string, extra: Record<string, unknown>) =>
    ({ intent: "update", table, entity, ver: ver_, ...extra }) as Record<string, unknown>;

  it(
    "a piece whose cells two writes gave names the later one",
    async () => {
      const a = await w([
        { intent: "insert", table: "pairs", valid_from: "2026-11-01", set: { b: "x", c: "1" } },
      ]);
      const entity = target(a).entity as string;
      const b = await w(
        [upd("pairs", entity, ver(a), { valid_from: "2026-11-05", set: { c: "2" } })],
        OTHER,
      );
      const c = await w([
        upd("pairs", entity, ver(a), {
          valid_from: "2026-11-05",
          valid_to: "2026-11-10",
          set: { b: "z", c: "3" },
        }),
      ]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      // b from a, c from b on the same piece: the piece is b's.
      expect(spansOf(d, "effective")).toEqual([
        ["2026-11-05", "2026-11-10", { b: "x", c: "2" }, b.seq],
      ]);
      await likeQuery(d, "pairs", entity);
    },
    T,
  );

  it(
    "equal values side by side from two writes stay two pieces",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      // From 11-05: y, then x again (acknowledged): x on both sides of 11-05, from two writes.
      const y = await w(
        [upd("entities", entity, ver(a), { valid_from: "2026-11-05", set: { b: "y" } })],
        OTHER,
      );
      const b = await w(
        [
          {
            ...upd("entities", entity, ver(y), { valid_from: "2026-11-05", set: { b: "x" } }),
            acknowledge: ["overwrite"],
          },
        ],
        OTHER,
      );
      const c = await w([
        upd("entities", entity, ver(a), {
          valid_from: "2026-11-01",
          valid_to: "2026-11-10",
          set: { b: "z" },
        }),
      ]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      expect(spansOf(d, "effective").map((x) => [x[0], x[1], x[2], x[3]])).toEqual([
        ["2026-11-01", "2026-11-05", { b: "x" }, a.seq],
        ["2026-11-05", "2026-11-10", { b: "x" }, b.seq],
      ]);
      await likeQuery(d, "entities", entity);
    },
    T,
  );

  it(
    "an awaiting item refreshed: current is the row as of the new version",
    async () => {
      const { b, c, entity } = await entityAwaiting();
      const id = c.pending.find((x) => x.type === "awaiting_confirmation")?.id as string;
      const before = ids(await p({ id })) as Record<string, unknown>;
      await likeQuery(before, "entities", entity, "current");
      // Another connection, which never read the item, writes inside its spans.
      const r = await w(
        [
          upd("entities", entity, ver(b), {
            valid_from: "2026-11-12",
            valid_to: "2026-11-14",
            set: { b: "q" },
          }),
        ],
        OTHER,
      );
      expect(r.pending).toEqual([expect.objectContaining({ id, refreshed: true })]);
      const after = ids(await p({ id })) as Record<string, unknown>;
      expect(after["item_ver"]).toBe(`iv_${id.slice(3)}.${r.seq}.0`);
      expect(spansOf(after, "current").map((x) => x[2])).toContainEqual({ b: "q" });
      await likeQuery(after, "entities", entity, "current");
    },
    T,
  );

  it(
    "a join lowering the merge base: previous as of the lower one",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      const b = await w([
        upd("entities", entity, ver(a), { valid_from: "2026-11-01", set: { b: "y" } }),
      ]);
      const c = await w(
        [upd("entities", entity, ver(b), { valid_from: "2026-11-01", set: { b: "w" } })],
        OTHER,
      );
      // A stale write on b's version opens the item, merge base b.
      const s1 = await w([
        upd("entities", entity, ver(b), { valid_from: "2026-11-01", set: { b: "s" } }),
      ]);
      const id = s1.pending.find((x) => x.type === "conflict")?.id as string;
      expect(ids(await p({ id }))).toMatchObject({ previous: { seq: b.seq } });
      // One on a's version joins it and lowers the merge base to a.
      await w(
        [upd("entities", entity, ver(a), { valid_from: "2026-11-01", set: { b: "t" } })],
        OTHER,
      );
      const d = ids(await p({ id })) as Record<string, unknown>;
      expect(d["previous"]).toMatchObject({ seq: a.seq, exists: true });
      expect(spansOf(d, "previous").map((x) => x[2])).toEqual([{ b: "x" }]);
      expect(c.seq).toBeGreaterThan(b.seq);
    },
    T,
  );
});

describe("a revoke undone on an entity", () => {
  it(
    "the piece it reopened is the write that gave the value, not the restore",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      const v = await w(
        [
          {
            intent: "revoke",
            table: "entities",
            entity,
            ver: ver(a),
            valid_from: "2026-11-05",
            valid_to: "2026-11-08",
          },
        ],
        OTHER,
      );
      const r = await w([{ table: "entities", entity, revert: { undo: v.seq } }], OTHER);
      const c = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-03",
          valid_to: "2026-11-10",
          set: { b: "z" },
        },
      ]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const d = ids(await p({ id })) as Record<string, unknown>;
      const pieces = spansOf(d, "effective");
      expect(pieces.every((x) => x[3] === a.seq)).toBe(true);
      expect(pieces.some((x) => x[3] === r.seq)).toBe(false);
      await likeQuery(d, "entities", entity);
    },
    T,
  );
});

describe("existence on a timeless row", () => {
  it(
    "revoked, then restored, and a stale revoke: exists, the row, and the write behind it",
    async () => {
      const a = await w([{ intent: "insert", table: "rows", set: { b: "1" } }]);
      const row = target(a).row as string;
      const u = await w(
        [{ intent: "update", table: "rows", row, ver: ver(a), set: { b: "2" } }],
        OTHER,
      );
      // A stale revoke on a's version: a candidate on existence; the row is in effect, by u.
      const c = await w([{ intent: "revoke", table: "rows", row, ver: ver(a) }]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const live = ids(await p({ id })) as Record<string, unknown>;
      expect((live["target"] as { unit: string[] }).unit).toEqual(["*"]);
      expect(live["effective"]).toEqual({
        seq: u.seq,
        actor: OTHER,
        values: { b: "2", c: null, __proto__: null },
        exists: true,
      });
      await likeQueryRow(live, "rows", row);
      // Revoked by another connection: the item is refreshed; effective is the revoke.
      const v = await w([{ intent: "revoke", table: "rows", row, ver: ver(u) }], OTHER);
      const gone = ids(await p({ id })) as Record<string, unknown>;
      expect(gone["effective"]).toEqual({ seq: v.seq, actor: OTHER, exists: false });
      await likeQueryRow(gone, "rows", row);
      // The revoke undone: on a timeless row the restore is what gives the row now.
      const r = await w([{ table: "rows", row, revert: { undo: v.seq } }], OTHER);
      const back = ids(await p({ id })) as Record<string, unknown>;
      expect(back["effective"]).toMatchObject({ seq: r.seq, exists: true });
      await likeQueryRow(back, "rows", row);
    },
    T,
  );
});

describe("impact: gaps filled and values overwritten", () => {
  it(
    "a value cleared to null is overwritten, not a gap filled; detail and receipt agree",
    async () => {
      const a = await w([
        {
          intent: "insert",
          table: "entities",
          valid_from: "2026-11-01",
          set: { b: "x", c: "1" },
        },
      ]);
      const entity = target(a).entity as string;
      // c cleared to null from 11-05: a value, and a change point at 11-05.
      const cleared = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(a),
          valid_from: "2026-11-05",
          set: { c: null },
        },
      ]);
      // c over [11-01, 11-10) without acknowledging: awaiting, overwriting the cleared value too.
      const c = await w([
        {
          intent: "update",
          table: "entities",
          entity,
          ver: ver(cleared),
          valid_from: "2026-11-01",
          valid_to: "2026-11-10",
          set: { c: "9" },
        },
      ]);
      const d = await agrees(c, "awaiting_confirmation");
      const impact = d["impact"] as {
        overwritten?: { value: unknown; seq: number }[];
        filled_gaps?: unknown[];
      };
      expect(impact.filled_gaps).toBeUndefined();
      expect(impact.overwritten?.map((x) => [x.value, x.seq])).toContainEqual([null, cleared.seq]);
    },
    T,
  );
});

describe("an item over the whole time", () => {
  it(
    "a whole-entity revoke as a candidate: its spans, open at both ends, in the list and the detail",
    async () => {
      const a = await w([
        { intent: "insert", table: "entities", valid_from: "2026-11-01", set: { b: "x" } },
      ]);
      const entity = target(a).entity as string;
      await w(
        [
          {
            intent: "update",
            table: "entities",
            entity,
            ver: ver(a),
            valid_from: "2026-11-05",
            set: { b: "y" },
          },
        ],
        OTHER,
      );
      // A revoke of the whole entity on a's version: a candidate on existence, over the whole time.
      const c = await w([{ intent: "revoke", table: "entities", entity, ver: ver(a) }]);
      const id = c.pending.find((x) => x.type === "conflict")?.id as string;
      const whole = [{ valid_from: null, valid_to: null }];
      const listed = (await p({})).items?.find((x) => x.id === id);
      expect(listed?.target).toMatchObject({ unit: ["*"], spans: whole });
      const d = await agrees(c, "conflict");
      expect(d["target"]).toMatchObject({ unit: ["*"], spans: whole });
      // The pieces cover it from an open start: x from 11-01, y from 11-05, nothing before 11-01.
      expect(spansOf(d, "effective").map((x) => [x[0], x[1], x[2]])).toEqual([
        [null, "2026-11-01", null],
        ["2026-11-01", "2026-11-05", { b: "x", c: null }],
        ["2026-11-05", null, { b: "y", c: null }],
      ]);
    },
    T,
  );
});

describe("the list: totals, order and slots", () => {
  it(
    "gives the total with a limit, and lists items opened in one request by ID",
    async () => {
      const a1 = await w([{ intent: "insert", table: "rows", set: { b: "1" } }]);
      // Another value: the same request again would be a replay of the first.
      const a2 = await w([{ intent: "insert", table: "rows", set: { b: "1b" } }]);
      const r1 = target(a1).row as string;
      const r2 = target(a2).row as string;
      await w(
        [
          { intent: "update", table: "rows", row: r1, ver: ver(a1), set: { b: "2" } },
          { intent: "update", table: "rows", row: r2, ver: ver(a2), set: { b: "2" } },
        ],
        OTHER,
      );
      const c = await w([
        { intent: "update", table: "rows", row: r1, ver: ver(a1), set: { b: "3" } },
        { intent: "update", table: "rows", row: r2, ver: ver(a2), set: { b: "3" } },
      ]);
      const opened = c.pending.map((x) => x.id).sort();
      expect(opened.length).toBe(2);
      const l = await p({ limit: 1 });
      expect(l["total"]).toBe(2);
      expect(l.items?.map((x) => x.id)).toEqual([opened[0]]);
      expect((await p({})).items?.map((x) => x.id)).toEqual(opened);
    },
    T,
  );

  it(
    "filters by slot with two slots",
    async () => {
      await rowConflict();
      const OTHER_SLOT = `sl_${"5".repeat(16)}`;
      const compiled = {
        ...COMPILED,
        tables: [{ ...COMPILED.tables[0], id: "t9", physical: { table: "t_t9_v1" } }],
      };
      const events = JSON.parse(
        JSON.stringify(
          createSlotEvents({
            compiled: compiled as never,
            changes: [
              {
                target: { slot: true },
                change: "create_slot",
                class: "create",
                compatible_with_old_writes: true,
                destructive: false,
                auto: true,
              },
              {
                target: { table: "t9" },
                change: "add_table",
                class: "create",
                compatible_with_old_writes: true,
                destructive: false,
                auto: true,
              },
            ] as never,
          }),
        )
          .replaceAll(SLOT, OTHER_SLOT)
          .replaceAll(DRAFT, `d_${"2".repeat(16)}`)
          .replaceAll('"ledger"', '"ledger2"'),
      );
      await s.store.write(async (tx) => {
        const op = await appendOperation(tx, {
          actor: USER as never,
          now: clock() as never,
          events,
        });
        await applyEvents(tx, eventsOf(op));
      });
      const a = await w([{ intent: "insert", table: "ledger2.rows", set: { b: "9" } }]);
      const row = target(a).row as string;
      await w(
        [{ intent: "update", table: "ledger2.rows", row, ver: ver(a), set: { b: "9.5" } }],
        OTHER,
      );
      await w([{ intent: "update", table: "ledger2.rows", row, ver: ver(a), set: { b: "10" } }]);
      expect((await p({}))["total"]).toBe(2);
      expect(
        (await p({ slot: "ledger2" })).items?.map((x) => (x as { slot: string }).slot),
      ).toEqual(["ledger2"]);
      expect((await p({ slot: "ledger" })).items?.map((x) => (x as { slot: string }).slot)).toEqual(
        ["ledger"],
      );
    },
    T,
  );
});
