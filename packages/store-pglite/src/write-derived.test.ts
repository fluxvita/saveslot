// Derived tables refreshed by the write pipeline on PGlite (K5; 06-derived.md «刷新范围与写入准入»;
// 09-event-format.md §4.2 step 6, §5.7 `write.derived`; 04-contract.md §5.4, §14): a write, each
// decision of `resolve` that writes, and `undo` change a table a rule reads, and the derived tables
// are refreshed in the same operation; the receipt gives the derived changes the first time and
// counts the derived writes on a replay; a rule failing on the data fails the whole write; nothing is
// refused for admission; and the log replayed from an empty storage gives every table again.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  derivedLayout,
  evaluateRule,
  eventsOf,
  KERNEL_TABLES,
  loadRsql,
  type ReadTx,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import { derivedSchema, rule } from "@fluxvita/saveslot-kernel/rsql-testing";
import {
  createSlotEvents,
  queryInTx,
  resolveInTx,
  SLOT,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { PgliteBackend } from "./backend.ts";
import { openReusable, type ReusableStore, snapshot } from "./testing/reusable-store.fixture.ts";

const T = 120_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

type Schema = ReturnType<typeof derivedSchema>;
type Derived = Extract<Schema["tables"][number], { kind: "derived" }>;

const RULES = [
  [
    "t9",
    "weekly",
    "SELECT date_trunc('week', date::timestamp)::date AS week, sum(distance) AS total, count(*) AS runs FROM runs GROUP BY 1",
    ["week", "total", "runs"],
    "bucketed",
  ],
  [
    "t10",
    "by_route",
    "SELECT route AS route, count(*) AS runs FROM runs GROUP BY 1",
    ["route", "runs"],
    "none",
  ],
  ["t11", "all_runs", "SELECT sum(distance) AS total FROM runs", ["total"], "none"],
  // A sum of integers past 64 bits fails on the data (the case of rule_eval_failed).
  ["t12", "all_laps", "SELECT sum(laps) AS laps FROM runs", ["laps"], "none"],
  // A result past 18 integer digits from any pace: fails on decoding, not in the database.
  [
    "t13",
    "pace_scaled",
    "SELECT sum(pace * 4000000000 * 4000000000) AS scaled FROM runs",
    ["scaled"],
    "none",
  ],
] as const;
type DerivedId = (typeof RULES)[number][0];
const DERIVED_IDS = RULES.map((r) => r[0]);

let schema: Schema;
let s: ReusableStore;
const roots: string[] = [];
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return `2026-11-10T${String(8 + Math.floor(minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`;
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};

beforeAll(async () => {
  await loadRsql();
  const derived = RULES.map(([id, name, sql, fields, td], i): Derived => {
    const t = derivedSchema(rule(sql, fields, td)).tables.find((x) => x.id === "t9") as Derived;
    return {
      ...t,
      id,
      name,
      physical: { table: `d_${id}_v1` },
      rule: { ...t.rule, id: `r${i + 1}` as Derived["rule"]["id"] },
    } as Derived;
  });
  const base = derivedSchema(rule(RULES[0][2], RULES[0][3], RULES[0][4]));
  schema = {
    ...base,
    slot: SLOT,
    tables: [...base.tables.filter((t) => t.kind === "base"), ...derived],
  } as Schema;
  s = await openReusable("saveslot-write-derived-");
}, T);

afterAll(async () => {
  await s?.close();
  for (const r of roots) rmSync(r, { recursive: true, force: true });
}, T);

beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
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
      now: "2026-11-10T04:00:00.000Z",
      confirmation: null,
    }),
  );
  const change = (target: Record<string, unknown>, kind: string) => ({
    target,
    change: kind,
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  });
  const events = createSlotEvents({
    compiled: schema as never,
    changes: [
      change({ slot: true }, "create_slot"),
      ...schema.tables.map((t) =>
        change({ table: t.id }, t.kind === "base" ? "add_table" : "add_derived_table"),
      ),
    ] as never,
  });
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-10T04:00:30.000Z" as never,
      events,
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);

// --- calls ---------------------------------------------------------------------------------------

type Receipt = {
  readonly seq: number;
  readonly ops: readonly { readonly target: { readonly row?: string }; readonly ver?: string }[];
  readonly derived: readonly {
    table: string;
    key: Record<string, unknown>;
    field: string;
    before: unknown;
    after: unknown;
  }[];
  readonly derived_total: number;
  readonly pending: readonly { readonly id: string; type: string; item_ver?: string }[];
  readonly replayed?: true;
  readonly omitted?: readonly string[];
};

/** Sends `params` through the pipeline; the error, if refused. */
async function send(params: unknown): Promise<Receipt & Record<string, unknown>> {
  try {
    return (await s.store.write((tx) =>
      writeInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

type Resolution = { write?: Receipt; replayed?: true } & Record<string, unknown>;
async function resolve(params: unknown): Promise<Resolution> {
  try {
    return (await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: USER as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    )) as never;
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown> };
    if (x.code === undefined) throw e;
    return { refused: x.code, ...(x.detail ?? {}) } as never;
  }
}

const km = (v: string) => ({ value: v, unit: "km" });
const run = (date: string, distance: string, route = "park", more: Record<string, unknown> = {}) =>
  send({
    sv: 1,
    ops: [
      { intent: "insert", table: "runs", set: { date, distance: km(distance), route, ...more } },
    ],
  });
const update = (row: string, ver: string, set: Record<string, unknown>) =>
  send({ sv: 1, ops: [{ intent: "update", table: "runs", row, ver, set }] });
const rowOf = (r: Receipt) => r.ops[0]?.target.row as string;
const verOf = (r: Receipt) => r.ops[0]?.ver as string;
const itemVer = (r: Receipt, id: string) => r.pending.find((p) => p.id === id)?.item_ver as string;

async function eventsOfOp(op: number) {
  return s.store.read(async (tx) =>
    (await readEvents(tx, op, (await readTail(tx))?.seq ?? op)).map((e) => ({
      type: e.header["type"] as string,
      op: Number(e.header["op"]),
      seq: Number(e.header["seq"]),
      blocks: Object.fromEntries(
        [...e.blocks].flatMap(([p, b]) => (b.state === "present" ? [[p, b.value]] : [])),
      ) as Record<string, unknown>,
    })),
  );
}
const derivedWritesOf = async (op: number) =>
  (await eventsOfOp(op)).filter((e) => e.op === op && e.type === "write.derived");
const tailSeq = () => s.store.read(async (tx) => (await readTail(tx))?.seq ?? 0);

// --- the derived tables against their rules ------------------------------------------------------

const derivedOf = (id: DerivedId) => schema.tables.find((t) => t.id === id) as Derived;

/** A derived table as stored and as its rule gives it over the base rows, by group key. */
async function compare(tx: ReadTx, id: DerivedId) {
  const e = evaluateRule(schema, id);
  const want = new Map<string, unknown>();
  for (const r of (await tx.query<Record<string, unknown>>(e.all.sql)).rows) {
    const d = e.decode(r);
    if (d !== undefined) want.set(JSON.stringify(d.key), d.values);
  }
  const l = derivedLayout(derivedOf(id));
  const cols = l.fields.map(({ field, column }) =>
    field.type === "boolean"
      ? `"${column}" AS "${field.id}"`
      : `CAST("${column}" AS text) AS "${field.id}"`,
  );
  const rows = (
    await tx.query<Record<string, unknown>>(`SELECT ${cols.join(", ")} FROM "${l.table}"`)
  ).rows;
  const got = new Map<string, unknown>();
  for (const r of rows) {
    const d = e.decode({ ...r, inputs: "1" });
    if (d === undefined) throw new Error("a stored row that decodes to none");
    got.set(JSON.stringify(d.key), d.values);
  }
  expect(rows.length).toBe(got.size);
  return { got: [...got].sort(), want: [...want].sort() };
}

/** Every derived table equals its rule; returns the number of derived rows, by table. */
async function expectRefreshed(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  await s.store.read(async (tx) => {
    for (const id of DERIVED_IDS) {
      const c = await compare(tx, id);
      expect(c.got, id).toEqual(c.want);
      out[id] = c.got.length;
    }
  });
  return out;
}

/** The derived row of `id` with key `key` (JSON of the decoded key), its values. */
async function derivedRow(id: DerivedId, key: unknown[]) {
  return s.store.read(async (tx) => {
    const c = await compare(tx, id);
    return c.got.find(([k]) => k === JSON.stringify(key))?.[1];
  });
}

// --- cases ---------------------------------------------------------------------------------------

describe("a write to a table a rule reads refreshes its derived tables in the same operation", () => {
  it(
    "inserts, an update, a revoke: each derived table equals its rule after each, with write.derived in the operation",
    async () => {
      const a = await run("2026-11-02", "5");
      expect(a).not.toHaveProperty("refused");
      expect(await expectRefreshed()).toEqual({ t9: 1, t10: 1, t11: 1, t12: 1, t13: 1 });
      expect((await derivedWritesOf(a.seq)).length).toBe(5);
      const b = await run("2026-11-10", "3", "river");
      expect(await expectRefreshed()).toEqual({ t9: 2, t10: 2, t11: 1, t12: 1, t13: 1 });
      // A new week and a new route: their partitions; the whole aggregate's total; all_laps and
      // pace_scaled stay null (no laps, no pace), no write.
      expect(
        (await derivedWritesOf(b.seq))
          .map((e) => (e.blocks["target"] as { table: string }).table)
          .sort(),
      ).toEqual(["t10", "t11", "t9"]);
      const u = await update(rowOf(a), verOf(a), { distance: km("8") });
      expect(u).not.toHaveProperty("refused");
      expect(await expectRefreshed()).toEqual({ t9: 2, t10: 2, t11: 1, t12: 1, t13: 1 });
      // The route did not change: by_route gets no write.
      expect(
        (await derivedWritesOf(u.seq))
          .map((e) => (e.blocks["target"] as { table: string }).table)
          .sort(),
      ).toEqual(["t11", "t9"]);
      // A revoke changes the row's existence only, no field: still a base change.
      const v = await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "runs", row: rowOf(b), ver: verOf(b) }],
      });
      expect(v).not.toHaveProperty("refused");
      expect(await expectRefreshed()).toEqual({ t9: 1, t10: 1, t11: 1, t12: 1, t13: 1 });
      expect((await derivedWritesOf(v.seq)).length).toBeGreaterThan(0);
    },
    T,
  );

  it(
    "the receipt: derived changes by field the first time; on a replay none, the derived writes counted, derived_values omitted",
    async () => {
      await run("2026-11-02", "5");
      const params = {
        sv: 1,
        idempotency_key: "second-run",
        ops: [
          {
            intent: "insert",
            table: "runs",
            set: { date: "2026-11-03", distance: km("2"), route: "park" },
          },
        ],
      };
      const first = await send(params);
      // weekly: total and runs of one row (two entries, one derived write); by_route: runs;
      // all_runs: total. all_laps: unchanged.
      const weekly = first.derived.filter((d) => d.table === "health.weekly");
      expect(weekly.map((d) => d.field).sort()).toEqual(["runs", "total"]);
      expect(
        weekly.every((d) => JSON.stringify(d.key) === JSON.stringify({ week: "2026-11-02" })),
      ).toBe(true);
      expect(weekly.find((d) => d.field === "runs")).toMatchObject({ before: "1", after: "2" });
      expect(first.derived.map((d) => `${d.table}.${d.field}`).sort()).toEqual([
        "health.all_runs.total",
        "health.by_route.runs",
        "health.weekly.runs",
        "health.weekly.total",
      ]);
      expect(first.derived_total).toBe(4);
      expect(first).not.toHaveProperty("omitted");
      const writes = await derivedWritesOf(first.seq);
      expect(writes.length).toBe(3);
      // Each reads the state the operation's own events left: the last event before them.
      const own = (await eventsOfOp(first.seq)).filter((e) => e.op === first.seq);
      const lastBefore = own.filter((e) => e.type !== "write.derived").at(-1)?.seq;
      expect(Math.min(...writes.map((e) => e.seq))).toBe((lastBefore as number) + 1);
      expect(writes.map((e) => (e.blocks["target"] as { read_pos: number }).read_pos)).toEqual(
        writes.map(() => lastBefore),
      );
      expect(
        writes.filter((e) => (e.blocks["target"] as { table: string }).table === "t9").length,
      ).toBe(1);

      const again = await send(params);
      expect(again).toMatchObject({
        replayed: true,
        seq: first.seq,
        derived: [],
        derived_total: 3,
      });
      expect(again.omitted).toContain("derived_values");
    },
    T,
  );

  it(
    "more than 20 derived changes: 20 shown, the total counts them all",
    async () => {
      // Each run on its own week: a weekly partition each (two fields), plus by_route and all_runs.
      const ops = Array.from({ length: 12 }, (_, i) => ({
        intent: "insert",
        table: "runs",
        set: {
          date: `2026-0${1 + Math.floor(i / 4)}-${String(1 + 7 * (i % 4)).padStart(2, "0")}`,
          distance: km("1"),
          route: "park",
        },
      }));
      const r = await send({ sv: 1, ops });
      expect(r).not.toHaveProperty("refused");
      expect(r.derived).toHaveLength(20);
      expect(r.derived_total).toBe(12 * 2 + 1 + 1);
      await expectRefreshed();
    },
    T,
  );

  it(
    "no refusal for admission: a request of many ops into a table rules read, and many such requests, all saved",
    async () => {
      // The refresh recomputes whole rules; its cost does not depend on the request's size, so no
      // write is refused for admission (04-contract §5.4 «写入准入»).
      for (let k = 0; k < 3; k++) {
        const ops = Array.from({ length: 200 }, (_, i) => ({
          intent: "insert",
          table: "runs",
          set: {
            date: `2026-11-${String(1 + (i % 28)).padStart(2, "0")}`,
            distance: km(String(1 + (i % 9))),
            route: i % 2 === 0 ? "park" : "river",
          },
        }));
        const r = await send({ sv: 1, ops });
        expect(r).not.toHaveProperty("refused");
      }
      await expectRefreshed();
    },
    T,
  );

  it(
    "a rule failing on the data fails the whole write: validation_failed (rule_eval_failed), nothing kept",
    async () => {
      const big = "9223372036854775807";
      const a = await run("2026-11-02", "1", "park", { laps: big });
      expect(a).not.toHaveProperty("refused");
      const before = await tailSeq();
      const snap = await s.store.read(snapshot);
      const r = await run("2026-11-03", "1", "park", { laps: big });
      expect(r).toMatchObject({
        refused: "validation_failed",
        reason: "write",
        details: [{ code: "rule_eval_failed" }],
      });
      expect(await tailSeq()).toBe(before);
      expect(await s.store.read(snapshot)).toEqual(snap);
    },
    T,
  );

  it(
    "a result the event format cannot represent fails the write the same way: rule_eval_failed, nothing kept",
    async () => {
      await run("2026-11-02", "1");
      const before = await tailSeq();
      const snap = await s.store.read(snapshot);
      // 1 × 4e9 × 4e9: 20 integer digits.
      const r = await run("2026-11-03", "1", "park", { pace: "1" });
      expect(r).toMatchObject({
        refused: "validation_failed",
        reason: "write",
        details: [{ code: "rule_eval_failed" }],
      });
      expect(await tailSeq()).toBe(before);
      expect(await s.store.read(snapshot)).toEqual(snap);
    },
    T,
  );

  it(
    "the receipt lists changes of values: a derived row appearing with only null fields besides its key has no entry; derived_total by entries, on a replay by derived writes",
    async () => {
      // all_laps and pace_scaled get a row each (no laps, no pace: null), with no entry.
      const params = {
        sv: 1,
        idempotency_key: "first-run",
        ops: [
          {
            intent: "insert",
            table: "runs",
            set: { date: "2026-11-02", distance: km("5"), route: "park" },
          },
        ],
      };
      const first = await send(params);
      expect(first.derived.map((d) => `${d.table}.${d.field}`).sort()).toEqual([
        "health.all_runs.total",
        "health.by_route.runs",
        "health.weekly.runs",
        "health.weekly.total",
      ]);
      expect(first.derived_total).toBe(4);
      const writes = await derivedWritesOf(first.seq);
      expect(writes.map((e) => (e.blocks["target"] as { table: string }).table).sort()).toEqual([
        "t10",
        "t11",
        "t12",
        "t13",
        "t9",
      ]);
      expect(await derivedRow("t12", [])).toEqual({ f1: null });
      const again = await send(params);
      expect(again).toMatchObject({ replayed: true, derived: [], derived_total: 5 });
    },
    T,
  );
});

describe("resolve and undo refresh the derived tables too", () => {
  /** 5 then 6 in effect; a write of 7 seeing the first version: a conflict item. */
  async function disputed() {
    const a = await run("2026-11-02", "5");
    const row = rowOf(a);
    const b = await update(row, verOf(a), { distance: km("6") });
    const c = await update(row, verOf(a), { distance: km("7") });
    const item = c.pending.find((p) => p.type === "conflict")?.id as string;
    expect(item).toBeDefined();
    return { a, b, c, row, item };
  }
  const weekTotal = async () => (await derivedRow("t9", ["2026-11-02"])) as unknown[] | undefined;
  /** The receipt's entries when the week's total and the whole total go from `from` to `to` km. */
  const totals = (from: string, to: string) => [
    { table: "health.all_runs", key: {}, field: "total", before: km(from), after: km(to) },
    {
      table: "health.weekly",
      key: { week: "2026-11-02" },
      field: "total",
      before: km(from),
      after: km(to),
    },
  ];
  const entries = (r: Receipt) =>
    [...r.derived].sort((a, b) => (a.table < b.table ? -1 : a.table > b.table ? 1 : 0));

  it(
    "take_candidate: the candidate's value in effect, the derived rows refreshed; a repeat gives the derived writes counted, derived_values omitted",
    async () => {
      const { c, item } = await disputed();
      const before = await weekTotal();
      await expectRefreshed();
      const params = { id: item, decision: "take_candidate", item_ver: itemVer(c, item) };
      const r = await resolve(params);
      expect(r).toMatchObject({ decision: "take_candidate", status: "resolved" });
      await expectRefreshed();
      expect(await weekTotal()).not.toEqual(before);
      const w = r.write as Receipt;
      expect(w.derived.map((d) => `${d.table}.${d.field}`).sort()).toEqual([
        "health.all_runs.total",
        "health.weekly.total",
      ]);
      expect(w.derived_total).toBe(2);
      expect(w).not.toHaveProperty("omitted");
      const writes = await derivedWritesOf(w.seq);
      expect(writes.length).toBe(2);

      const again = await resolve(params);
      expect(again).toMatchObject({ replayed: true });
      expect(again.write).toMatchObject({ seq: w.seq, derived: [], derived_total: writes.length });
      expect(again.write?.omitted).toContain("derived_values");
    },
    T,
  );

  it(
    "take_previous: back to the merge base's value, the derived rows refreshed",
    async () => {
      const { c, item } = await disputed();
      const before = await weekTotal();
      const r = await resolve({ id: item, decision: "take_previous", item_ver: itemVer(c, item) });
      expect(r).toMatchObject({ decision: "take_previous", status: "resolved" });
      await expectRefreshed();
      expect(await weekTotal()).not.toEqual(before);
      // 6 in effect, back to the merge base's 5.
      expect(entries(r.write as Receipt)).toEqual(totals("6", "5"));
      expect((r.write as Receipt).derived_total).toBe(2);
      expect((await derivedWritesOf((r.write as Receipt).seq)).length).toBe(2);
    },
    T,
  );

  it(
    "undo: the undone write's value gone, the derived rows refreshed",
    async () => {
      const a = await run("2026-11-02", "5");
      const b = await update(rowOf(a), verOf(a), { distance: km("6") });
      const before = await weekTotal();
      const u = await send({
        sv: 1,
        ops: [{ table: "runs", row: rowOf(a), revert: { undo: b.seq } }],
      });
      expect(u).not.toHaveProperty("refused");
      expect(u.pending).toEqual([]);
      await expectRefreshed();
      expect(await weekTotal()).not.toEqual(before);
      expect(entries(u)).toEqual(totals("6", "5"));
      expect((await derivedWritesOf(u.seq)).length).toBe(2);
    },
    T,
  );

  it(
    "confirm: an undo taking back a later write awaits confirmation, unchanged; confirmed, the derived rows refreshed",
    async () => {
      // The only way to an awaiting item on a table a kept rule reads: a rule over a state table is
      // computed at read time and kept nowhere, and outside state tables only an undo taking back
      // later writes (include_later) awaits confirmation.
      const a = await run("2026-11-02", "5");
      const b = await update(rowOf(a), verOf(a), { distance: km("6") });
      const c = await update(rowOf(a), verOf(b), { distance: km("7") });
      const u = await send({
        sv: 1,
        ops: [{ table: "runs", row: rowOf(a), revert: { undo: b.seq, include_later: true } }],
      });
      const item = u.pending.find((p) => p.type === "awaiting_confirmation")?.id as string;
      expect(item).toBeDefined();
      expect(await derivedWritesOf(u.seq)).toEqual([]);
      const before = await weekTotal();
      await expectRefreshed();
      const r = await resolve({ id: item, decision: "confirm", item_ver: itemVer(u, item) });
      expect(r).toMatchObject({ decision: "confirm", status: "resolved" });
      await expectRefreshed();
      expect(await weekTotal()).not.toEqual(before);
      // 7 (c's) in effect; b and the later c taken back: a's 5.
      expect(entries(r.write as Receipt)).toEqual(totals("7", "5"));
      expect((await derivedWritesOf((r.write as Receipt).seq)).length).toBe(2);
      void c;
    },
    T,
  );
});

describe("a resolution whose write fails a rule on the data", () => {
  const MAX = 9223372036854775807n;
  /** Another run whose laps leave `room` below the 64-bit maximum. */
  const fill = (room: bigint) => run("2026-11-09", "1", "river", { laps: String(MAX - room) });
  const refusedUnchanged = async (act: () => Promise<Resolution>) => {
    const before = await tailSeq();
    const snap = await s.store.read(snapshot);
    expect(await act()).toMatchObject({
      refused: "validation_failed",
      reason: "write",
      details: [{ code: "rule_eval_failed" }],
    });
    expect(await tailSeq()).toBe(before);
    expect(await s.store.read(snapshot)).toEqual(snap);
  };

  it(
    "take_candidate taking sum(laps) past 64 bits: rule_eval_failed, nothing kept, the item still open; keep_effective then resolves it",
    async () => {
      const a = await run("2026-11-02", "5", "park", { laps: "0" });
      await fill(1n);
      const b = await update(rowOf(a), verOf(a), { laps: "1" });
      expect(b).not.toHaveProperty("refused");
      const c = await update(rowOf(a), verOf(a), { laps: "100" });
      const item = c.pending.find((p) => p.type === "conflict")?.id as string;
      expect(item).toBeDefined();
      const ver = itemVer(c, item);
      await refusedUnchanged(() =>
        resolve({ id: item, decision: "take_candidate", item_ver: ver }),
      );
      const kept = await resolve({ id: item, decision: "keep_effective", item_ver: ver });
      expect(kept).toMatchObject({ decision: "keep_effective", status: "resolved" });
      await expectRefreshed();
    },
    T,
  );

  it(
    "confirm taking sum(laps) past 64 bits: rule_eval_failed, nothing kept; reject then resolves it",
    async () => {
      const a = await run("2026-11-02", "5", "park", { laps: "7" });
      const b = await update(rowOf(a), verOf(a), { laps: "1" });
      const c = await update(rowOf(a), verOf(b), { laps: "2" });
      expect(c).not.toHaveProperty("refused");
      // 2 in effect; taking back b and the later c gives 7 again, 5 past the maximum.
      await fill(2n);
      const u = await send({
        sv: 1,
        ops: [{ table: "runs", row: rowOf(a), revert: { undo: b.seq, include_later: true } }],
      });
      const item = u.pending.find((p) => p.type === "awaiting_confirmation")?.id as string;
      expect(item).toBeDefined();
      const ver = itemVer(u, item);
      await refusedUnchanged(() => resolve({ id: item, decision: "confirm", item_ver: ver }));
      const rejected = await resolve({ id: item, decision: "reject", item_ver: ver });
      expect(rejected).toMatchObject({ decision: "reject", status: "resolved" });
      await expectRefreshed();
    },
    T,
  );
});

describe("input marks reach a derived row through a real conflict", () => {
  it(
    "a conflict on distance: the week's row and the whole aggregate disputed 1, by_route (route only) none",
    async () => {
      await disputedRun();
      const read = async (table: string) =>
        (
          await s.store.read((tx) =>
            queryInTx(tx, {
              actor: USER as never,
              task: null,
              now: now() as never,
              visibility: { kind: "all" },
              params: { table },
              read: "rd_0000000000000000" as never,
            }),
          )
        ).result.rows.map(
          (r) => (r as { input_marks?: { disputed: number } }).input_marks?.disputed,
        );
      expect(await read("weekly")).toEqual([1]);
      expect(await read("all_runs")).toEqual([1]);
      expect(await read("by_route")).toEqual([0]);
    },
    T,
  );

  async function disputedRun() {
    const a = await run("2026-11-02", "5");
    await update(rowOf(a), verOf(a), { distance: km("6") });
    const c = await update(rowOf(a), verOf(a), { distance: km("7") });
    expect(c.pending.map((p) => p.type)).toContain("conflict");
  }
});

describe("the log replayed from an empty storage gives every table again", () => {
  it(
    "after writes, decisions and undos: base and derived tables, partitions, derived_reads and every materialized table equal",
    async () => {
      const a = await run("2026-11-02", "5");
      const b = await run("2026-11-10", "3", "river");
      const x = await update(rowOf(a), verOf(a), { distance: km("6") });
      const y = await update(rowOf(a), verOf(a), { distance: km("7") });
      const item = y.pending.find((p) => p.type === "conflict")?.id as string;
      await resolve({ id: item, decision: "take_candidate", item_ver: itemVer(y, item) });
      await send({ sv: 1, ops: [{ table: "runs", row: rowOf(a), revert: { undo: x.seq } }] });
      await send({
        sv: 1,
        ops: [{ intent: "revoke", table: "runs", row: rowOf(b), ver: verOf(b) }],
      });
      await run("2026-11-03", "2");
      await expectRefreshed();

      const root = mkdtempSync(join(tmpdir(), "saveslot-write-derived-replica-"));
      roots.push(root);
      const replica = await new PgliteBackend().open(
        { kind: "pglite", dir: join(root, "tenant") },
        { create: true },
      );
      try {
        const events = await s.store.read((tx) => tx.query("SELECT * FROM events ORDER BY seq"));
        const content = await s.store.read((tx) =>
          tx.query("SELECT * FROM content ORDER BY seq, path"),
        );
        await replica.write(async (tx) => {
          for (const rows of [
            ["events", events.rows],
            ["content", content.rows],
          ] as const) {
            for (const r of rows[1]) {
              const cols = Object.keys(r);
              await tx.query(
                `INSERT INTO ${rows[0]} (${cols.join(", ")}) VALUES (${cols.map((_, i) => `$${i + 1}`).join(", ")})`,
                Object.values(r) as never,
              );
            }
          }
          const last = (await readTail(tx))?.seq ?? 0;
          await applyEvents(tx, await readEvents(tx, 1, last));
        });
        // Materialized state and the slot's physical tables; local state (read records and the
        // like) is not rebuilt from the log.
        const KEEP = new Set(
          KERNEL_TABLES.filter((t) => t.class === "materialized").map((t) => t.name),
        );
        const KERNEL = new Set(KERNEL_TABLES.map((t) => t.name));
        const pick = (x: Record<string, string[]>) =>
          Object.fromEntries(Object.entries(x).filter(([k]) => KEEP.has(k) || !KERNEL.has(k)));
        const live = pick(await s.store.read(snapshot));
        expect(Object.keys(live)).toEqual(
          expect.arrayContaining(["partitions", "derived_reads", "t_t1_v1", "d_t9_v1", "d_t12_v1"]),
        );
        expect(live["partitions"]?.length).toBeGreaterThan(0);
        expect(live["derived_reads"]?.length).toBeGreaterThan(0);
        expect(pick(await replica.read(snapshot))).toEqual(live);
      } finally {
        await replica.close();
      }
    },
    T,
  );
});
