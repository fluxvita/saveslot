// Premises over random histories on PGlite, against a direct reading of 02-integrity «写入的前提»
// («什么算前提变了», «检测»; 02-architecture §11 «来源键与前提的性质»):
//
// - the recorded change of marks is the criterion recomputed: after every operation, every
//   declaration in force has the state, since and reason that walking the target's versions gives,
//   from the version it saw on: current while the declared fields (and business time) hold the
//   value seen, changed at the first operation after which they do not, with that operation's
//   reason, current again once they hold it again. A declaration made late starts at the version
//   it saw: its state when written is that walk up to the operation before it.
// - a current declaration's range holds the value seen (checked again directly).
//
// The oracle reads only what apply left: the version table's cells (raw columns, compared as
// text, day by day), the operations' intents and entry days, and which declarations are in force
// (`premise_edges`). It does not use premiseDelta, targetDelta or the detection's code. The write
// path takes `premises` only behind kernel's test switch.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import {
  acceptPremisesForTests,
  COMPILED_V1,
  createSlotEvents,
  premiseFanInLimitForTests,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import fc from "fast-check";
import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 600_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const COMPILED = {
  ...COMPILED_V1,
  tables: [
    {
      id: "t1",
      name: "releases",
      kind: "base",
      description: "releases",
      time: { type: "none" },
      physical: { table: "t_t1_v1" },
      fields: [
        { id: "f1", name: "name", type: "text", required: true, description: "name" },
        { id: "f2", name: "date", type: "date", description: "release day" },
      ],
    },
    {
      id: "t2",
      name: "tasks",
      kind: "base",
      description: "tasks",
      time: { type: "none" },
      physical: { table: "t_t2_v1" },
      fields: [
        { id: "f3", name: "title", type: "text", required: true, description: "title" },
        { id: "f4", name: "due", type: "date", description: "due" },
      ],
    },
    {
      id: "t3",
      name: "budgets",
      kind: "base",
      description: "budgets over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t3_v1" },
      fields: [
        { id: "f5", name: "category", type: "text", required: true, description: "category" },
        { id: "f6", name: "amount", type: "integer", description: "amount" },
      ],
      entity_key: ["f5"],
    },
    {
      id: "t4",
      name: "plans",
      kind: "base",
      description: "plans over time",
      time: { type: "state", granularity: "date" },
      physical: { table: "t_t4_v1" },
      fields: [{ id: "f7", name: "label", type: "text", required: true, description: "label" }],
    },
    {
      id: "t5",
      name: "logs",
      kind: "base",
      description: "a log by day",
      time: { type: "event", field: "f8" },
      physical: { table: "t_t5_v1" },
      fields: [
        { id: "f8", name: "day", type: "date", required: true, description: "day" },
        { id: "f9", name: "text", type: "text", description: "text" },
      ],
    },
  ],
};
const CHANGES = [
  { target: { slot: true }, change: "create_slot" },
  ...["t1", "t2", "t3", "t4", "t5"].map((t) => ({ target: { table: t }, change: "add_table" })),
].map((c) => ({
  ...c,
  class: "create",
  compatible_with_old_writes: true,
  destructive: false,
  auto: true,
}));

let s: ReusableStore;
let minute = 0;
let ids = 0;
const now = () => {
  minute++;
  return new Date(Date.UTC(2026, 10, 5, 1) + 60_000 * minute).toISOString();
};
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") => {
  ids++;
  const n = String(ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0");
  return `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${n}`;
};
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: now(),
    confirmation: null,
  });

type Receipt = {
  seq: number;
  ops: {
    target: { row?: string; entity?: string };
    ver: string;
    premises?: unknown[];
    premise_covered?: number;
  }[];
  warnings?: Record<string, unknown>[];
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
        params: { sv: 1, ...(params as object) },
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
const ok = async (params: unknown): Promise<Receipt> => {
  const r = await send(params);
  expect(r["refused"]).toBeUndefined();
  return r;
};

const release = async (name: string, date: string) =>
  (await ok({ ops: [{ intent: "insert", table: "releases", set: { name, date } }] })).ops[0] as {
    target: { row: string };
    ver: string;
  };

beforeAll(async () => {
  s = await openReusable("saveslot-premises-prop-");
  acceptPremisesForTests(true);
}, T);
afterAll(async () => {
  acceptPremisesForTests(false);
  await s?.close();
}, T);
beforeEach(async () => {
  await s.reset();
  readBufferOf(s.store).take();
  ids = 0;
  await createTenant(s.store, ctx());
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}, T);
afterEach(() => premiseFanInLimitForTests(1000));

// --- the oracle -----------------------------------------------------------------------------------

const DAYS = (() => {
  const out: string[] = [];
  for (let t = Date.UTC(2026, 8, 25); t <= Date.UTC(2027, 0, 10); t += 86_400_000)
    out.push(new Date(t).toISOString().slice(0, 10));
  return out;
})();
const TABLES: Record<string, { ver: string; fields: string[]; state: boolean }> = {
  t1: { ver: "t_t1_v1__ver", fields: ["f1", "f2"], state: false },
  t3: { ver: "t_t3_v1__ver", fields: ["f5", "f6"], state: true },
};
type Cell = {
  field_id: string;
  vf: string | null;
  vt: string | null;
  revoked: boolean | null;
  no_value: boolean | null;
} & Record<string, unknown>;

/** A target's cells at version position `v`, its value columns as text. */
async function cellsAt(table: string, row: string, v: number): Promise<readonly Cell[]> {
  const t = TABLES[table] as (typeof TABLES)[string];
  const cols = t.fields.map((f) => `"f_${f}"::text AS "${f}"`).join(", ");
  const span = t.state ? "valid_from::text AS vf, valid_to::text AS vt" : "NULL AS vf, NULL AS vt";
  return (
    await s.store.read((tx) =>
      tx.query<Cell>(
        `SELECT field_id, ${span}, revoked, no_value, ${cols} FROM ${t.ver}
         WHERE row_id = $1 AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)`,
        [row, v],
      ),
    )
  ).rows;
}

/** A target at one point (a day; a row has one): presence and each field's value as text. */
type At = { presence: "live" | "revoked" | "absent"; values: Record<string, string | null> };
function at(table: string, cells: readonly Cell[], day: string | null): At {
  const t = TABLES[table] as (typeof TABLES)[string];
  const covers = (c: Cell) =>
    day === null || ((c.vf ?? "") <= day && (c.vt === null || day < c.vt));
  const here = cells.filter(covers);
  const revoked = here.some((c) => c.field_id === "existence" && c.revoked === true);
  const values: Record<string, string | null> = {};
  for (const f of t.fields) {
    const c = here.find((x) => x.field_id === f);
    values[f] = c === undefined || c.no_value === true ? null : ((c[f] as string | null) ?? null);
  }
  // A row is there once it has a cell; an entity on a day where some field has a value.
  const live = t.state ? t.fields.some((f) => values[f] !== null) : cells.length > 0;
  return { presence: revoked ? "revoked" : live ? "live" : "absent", values };
}

/** A declaration in force as the oracle reads it. */
type Decl = {
  op: number;
  op_index: number;
  decl_index: number;
  table: string;
  target: string;
  fields: string[] | null;
  days: string[] | null;
  seen: number;
  state: string;
  reason: string | null;
  since: number | null;
};

/** Whether the declared fields and days differ between two positions (02-integrity «什么算前提变了»). */
function differs(d: Decl, a: readonly Cell[], b: readonly Cell[]): boolean {
  const t = TABLES[d.table] as (typeof TABLES)[string];
  for (const day of d.days ?? [null]) {
    const x = at(d.table, a, day);
    const y = at(d.table, b, day);
    // A revoke on either side counts whatever was declared; any other difference in presence
    // only for the whole row (on fields it shows through their values).
    if (
      x.presence !== y.presence &&
      (d.fields === null || x.presence === "revoked" || y.presence === "revoked")
    )
      return true;
    for (const f of d.fields ?? t.fields) if (x.values[f] !== y.values[f]) return true;
  }
  return false;
}

/** The days the declaration's range covers, within the window; none for a row. */
async function daysOf(table: string, range: string, valid: string | null, op: number) {
  if (!(TABLES[table] as (typeof TABLES)[string]).state) return null;
  let from: string;
  let to: string | null = null;
  if (valid !== null) {
    const v = JSON.parse(valid) as { at?: string; during?: { from: string; to?: string } };
    if (v.at !== undefined) return [v.at];
    from = v.during?.from as string;
    to = v.during?.to ?? null;
  } else {
    expect(range).toBe("from_now");
    from = (await ctxOf(op)).today;
  }
  return DAYS.filter((x) => x >= from && (to === null || x < to));
}
const ctxOf = async (op: number) =>
  JSON.parse(
    (
      await s.store.read((tx) =>
        tx.query<{ body: string }>("SELECT body FROM content WHERE seq = $1 AND path = 'ctx'", [
          op,
        ]),
      )
    ).rows[0]?.body ?? "{}",
  ) as { today: string };

/** The reason of operation `v` on a target that it changed (02-integrity, the table of reasons). */
async function reasonAt(d: Decl, v: number): Promise<string> {
  const t = TABLES[d.table] as (typeof TABLES)[string];
  const intents = new Set(
    (
      await s.store.read((tx) =>
        tx.query<{ intent: string }>(
          `SELECT DISTINCT intent FROM ${t.ver} WHERE row_id = $1 AND rec_from = $2`,
          [d.target, v],
        ),
      )
    ).rows.map((x) => x.intent),
  );
  if (intents.has("revoke")) return "revoke";
  if (!t.state) return intents.has("correct") ? "correct" : "update";
  if (intents.has("correct")) return "correct";
  // Retroactive when a day before that operation's entry day changed.
  const today = (await ctxOf(v)).today;
  const before = await cellsAt(d.table, d.target, v - 1);
  const after = await cellsAt(d.table, d.target, v);
  const past = (d.days ?? []).some(
    (day) => day < today && differs({ ...d, days: [day] }, before, after),
  );
  return past ? "retroactive" : "plan_changed";
}

/** The versions of a target (operations that changed a cell of it). */
const versionsOf = async (table: string, row: string) =>
  (
    await s.store.read((tx) =>
      tx.query<{ v: unknown }>(
        `SELECT DISTINCT rec_from AS v FROM ${(TABLES[table] as (typeof TABLES)[string]).ver}
         WHERE row_id = $1 ORDER BY 1`,
        [row],
      ),
    )
  ).rows.map((x) => Number(x.v));

/**
 * The declarations in force, picked here from the rows of `premise_edges` (not with the detection's
 * query): one is in force while some item's edge for its target is still its own (the latest
 * declaration covering the item) and no clearing entry on that item comes after it, by
 * (operation, op index).
 */
async function inForce(): Promise<Decl[]> {
  const { decls, edges } = await s.store.read(async (tx) => ({
    decls: (
      await tx.query<Record<string, unknown>>(
        `SELECT op::int, op_index, decl_index, target_table, target_row, fields, range_kind, valid,
                seen_op::int, state, reason, since::int
         FROM premise_decls ORDER BY 1, 2, 3`,
      )
    ).rows,
    edges: (
      await tx.query<{
        item_event: unknown;
        field_id: string;
        k: unknown;
        target: string;
        decl_op: unknown;
        decl_op_index: unknown;
        decl_index: unknown;
      }>(
        "SELECT item_event, field_id, k, target, decl_op, decl_op_index, decl_index FROM premise_edges",
      )
    ).rows,
  }));
  const item = (e: (typeof edges)[number]) => `${e.item_event}/${e.field_id}/${e.k}`;
  const later = (a: readonly [number, number], b: readonly [number, number]) =>
    a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const cleared = new Map<string, [number, number]>();
  for (const e of edges)
    if (e.target === "*") cleared.set(item(e), [Number(e.decl_op), Number(e.decl_op_index)]);
  const live = new Set<string>();
  for (const e of edges) {
    if (e.target === "*") continue;
    const at: [number, number] = [Number(e.decl_op), Number(e.decl_op_index)];
    const c = cleared.get(item(e));
    if (c !== undefined && later(c, at)) continue;
    live.add(`${e.target} ${at[0]}/${at[1]}/${Number(e.decl_index)}`);
  }
  const out: Decl[] = [];
  for (const x of decls) {
    if (!live.has(`${x["target_row"]} ${x["op"]}/${x["op_index"]}/${x["decl_index"]}`)) continue;
    const table = x["target_table"] as string;
    out.push({
      op: x["op"] as number,
      op_index: x["op_index"] as number,
      decl_index: x["decl_index"] as number,
      table,
      target: x["target_row"] as string,
      fields: x["fields"] === null ? null : (JSON.parse(x["fields"] as string) as string[]),
      days: await daysOf(
        table,
        x["range_kind"] as string,
        x["valid"] as string | null,
        x["op"] as number,
      ),
      seen: x["seen_op"] as number,
      state: x["state"] as string,
      reason: (x["reason"] as string | null) ?? null,
      since: (x["since"] as number | null) ?? null,
    });
  }
  return out;
}

/**
 * What a declaration's state, reason and since are after operation `upTo`, by walking its target's
 * versions from the one it saw: current while the range holds the value seen, changed at the first
 * version after which it does not (that version's reason), current again when it holds it again.
 */
async function walked(d: Decl, upTo: number) {
  const seen = await cellsAt(d.table, d.target, d.seen);
  let now = { state: "current", reason: null as string | null, since: null as number | null };
  for (const v of (await versionsOf(d.table, d.target)).filter((x) => x > d.seen && x <= upTo)) {
    const there = differs(d, seen, await cellsAt(d.table, d.target, v));
    if (now.state === "current" && there)
      now = { state: "changed", reason: await reasonAt(d, v), since: v };
    else if (now.state === "changed" && !there)
      now = { state: "current", reason: null, since: null };
  }
  return now;
}

// --- the histories ---------------------------------------------------------------------------------

type Step =
  | { k: "release"; r: number; field: "name" | "date"; value: number }
  | { k: "revoke"; r: number }
  | { k: "undo"; pick: number }
  | { k: "budget"; cat: number; amount: number; from: number; len: number | null }
  | {
      k: "declare";
      on: "release" | "budget";
      r: number;
      fields: boolean;
      back: number;
      range: number;
    }
  | { k: "restate"; dep: number; r: number; back: number; fallback: boolean }
  | { k: "clear"; dep: number }
  /** The last restatement by the fallback, sent again as it was. */
  | { k: "again" };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant("release" as const),
      r: fc.nat(2),
      field: fc.constantFrom("name" as const, "date" as const),
      value: fc.nat(2),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("revoke" as const), r: fc.nat(2) }) },
  { weight: 2, arbitrary: fc.record({ k: fc.constant("undo" as const), pick: fc.nat(20) }) },
  {
    weight: 3,
    arbitrary: fc.record({
      k: fc.constant("budget" as const),
      cat: fc.nat(1),
      amount: fc.nat(2),
      from: fc.nat(60),
      len: fc.option(fc.integer({ min: 1, max: 30 }), { nil: null }),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant("declare" as const),
      on: fc.constantFrom("release" as const, "budget" as const),
      r: fc.nat(2),
      fields: fc.boolean(),
      back: fc.nat(3),
      range: fc.nat(2),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("restate" as const),
      dep: fc.nat(5),
      r: fc.nat(2),
      back: fc.nat(3),
      fallback: fc.boolean(),
    }),
  },
  { weight: 1, arbitrary: fc.record({ k: fc.constant("clear" as const), dep: fc.nat(5) }) },
  { weight: 4, arbitrary: fc.record({ k: fc.constant("again" as const) }) },
);

const DATES = ["2026-12-01", "2026-11-20", "2026-12-15"];
const NAMES = ["v2", "v2.1", "v3"];
const AMOUNTS = [5000, 3000, 4000];
const day = (n: number) => DAYS[5 + n] as string;

describe("premises over random histories (in force: state, since, reason as the criterion walks them)", () => {
  it(
    "after every operation, every declaration in force is as walking its target's versions gives",
    async () => {
      const stats = {
        samples: 0,
        ops: 0,
        checked: 0,
        changed: 0,
        late: 0,
        matched: 0,
        // Restatements by the fallback sent again: replayed, or taken anew.
        replayed: 0,
        resent: 0,
      };
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 6, maxLength: 16 }), async (steps) => {
          await s.reset();
          readBufferOf(s.store).take();
          ids = 0;
          await createTenant(s.store, ctx());
          await s.store.write(async (tx) => {
            const op = await appendOperation(tx, {
              actor: USER as never,
              now: "2026-11-05T00:00:30.000Z" as never,
              events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
            });
            await applyEvents(tx, eventsOf(op));
          });
          const releases: { row: string; vers: string[]; gone?: boolean }[] = [];
          for (const [n, d] of DATES.entries()) {
            const r = await release(NAMES[n] as string, d);
            releases.push({ row: r.target.row, vers: [r.ver] });
          }
          const budgets: { entity: string; vers: string[] }[] = [];
          for (const cat of ["food", "rent"]) {
            const b = await ok({
              ops: [
                {
                  intent: "update",
                  table: "budgets",
                  entity_key: { category: cat },
                  set: { amount: 5000 },
                  valid_from: "2026-10-01",
                },
              ],
            });
            budgets.push({
              entity: b.ops[0]?.target.entity as string,
              vers: [b.ops[0]?.ver as string],
            });
          }
          const deps: { row: string; ver: string }[] = [];
          const done: number[] = [];
          // The restatements by the fallback sent so far, as sent; the last one, and its target.
          const sent = new Set<string>();
          let last: { body: unknown; release: string } | undefined;
          /** A restatement by the fallback: a replay rests on the version now. */
          const restated = async (body: unknown, release: string) => {
            const r = await send(body);
            if (r["refused"] !== undefined) return r;
            const key = JSON.stringify(body);
            // The receipt's premise as written: its ver in the token's writing ("v<op>.<restores>").
            const premise = r.ops[0]?.premises?.[0] as { ver: string } | undefined;
            expect(premise).toBeDefined();
            const rests = Number(/^v(\d+)\./.exec(premise?.ver ?? "")?.[1]);
            if (r["replayed"] === true) {
              stats.replayed++;
              expect(rests).toBe((await versionsOf("t1", release)).at(-1));
            } else if (sent.has(key)) stats.resent++;
            sent.add(key);
            last = { body, release };
            return r;
          };
          for (const st of steps) {
            let r: (Receipt & Record<string, unknown>) | undefined;
            if (st.k === "release") {
              const x = releases[st.r] as (typeof releases)[number];
              if (x.gone) continue;
              r = await send({
                ops: [
                  {
                    intent: "update",
                    table: "releases",
                    row: x.row,
                    ver: x.vers.at(-1),
                    set: { [st.field]: st.field === "date" ? DATES[st.value] : NAMES[st.value] },
                  },
                ],
              });
              if (r["refused"] === undefined) x.vers.push(r.ops[0]?.ver as string);
            } else if (st.k === "revoke") {
              const x = releases[st.r] as (typeof releases)[number];
              if (x.gone) continue;
              r = await send({
                ops: [{ intent: "revoke", table: "releases", row: x.row, ver: x.vers.at(-1) }],
              });
              if (r["refused"] === undefined) {
                x.gone = true;
                x.vers.push(r.ops[0]?.ver as string);
              }
            } else if (st.k === "undo") {
              const target = done[st.pick % Math.max(1, done.length)];
              if (target === undefined) continue;
              const row = releases.find((x) => x.vers.some((v) => v.startsWith(`v${target}.`)));
              if (row === undefined) continue;
              r = await send({
                ops: [{ table: "releases", row: row.row, revert: { undo: target } }],
              });
              if (r["refused"] === undefined) {
                delete row.gone;
                row.vers.push(r.ops[0]?.ver as string);
              }
            } else if (st.k === "budget") {
              const x = budgets[st.cat] as (typeof budgets)[number];
              r = await send({
                ops: [
                  {
                    intent: "update",
                    table: "budgets",
                    entity: x.entity,
                    ver: x.vers.at(-1),
                    set: { amount: AMOUNTS[st.amount] },
                    valid_from: day(st.from),
                    ...(st.len !== null ? { valid_to: day(st.from + st.len) } : {}),
                  },
                ],
              });
              if (r["refused"] === undefined) x.vers.push(r.ops[0]?.ver as string);
            } else if (st.k === "declare") {
              const pool =
                st.on === "release"
                  ? releases.map((x) => ({
                      table: "releases",
                      key: "row",
                      id: x.row,
                      vers: x.vers,
                    }))
                  : budgets.map((x) => ({
                      table: "budgets",
                      key: "entity",
                      id: x.entity,
                      vers: x.vers,
                    }));
              const x = pool[st.r % pool.length] as (typeof pool)[number];
              const ver = x.vers[Math.max(0, x.vers.length - 1 - st.back)];
              const range =
                st.on === "budget"
                  ? [{}, { valid_at: day(20) }, { valid_during: [day(10), day(40)] }][st.range]
                  : {};
              const fields = st.fields ? { fields: [st.on === "release" ? "date" : "amount"] } : {};
              r = await send({
                ops: [
                  {
                    intent: "insert",
                    table: "tasks",
                    set: { title: "t" },
                    premises: [{ table: x.table, [x.key]: x.id, ver, ...fields, ...range }],
                  },
                ],
              });
              if (r["refused"] === undefined)
                deps.push({ row: r.ops[0]?.target.row as string, ver: r.ops[0]?.ver as string });
              if (r["refused"] === undefined && ver !== x.vers.at(-1)) stats.late++;
            } else if (st.k === "restate") {
              const dep = deps[st.dep % Math.max(1, deps.length)];
              const x = releases[st.r] as (typeof releases)[number];
              if (dep === undefined) continue;
              const ver = x.vers[Math.max(0, x.vers.length - 1 - st.back)];
              // Without `ver`, the premise rests on the fallback: the caller's own latest write of
              // the release, its latest version here (one caller writes everything).
              const body = {
                ops: [
                  {
                    intent: "update",
                    table: "tasks",
                    row: dep.row,
                    ver: dep.ver,
                    premises: [{ table: "releases", row: x.row, ...(st.fallback ? {} : { ver }) }],
                  },
                ],
              };
              // A restatement sent again is not taken for the first one once its premise rests on
              // another version (04-contract §14 «例外一»).
              r = st.fallback ? await restated(body, x.row) : await send(body);
            } else if (st.k === "again") {
              if (last === undefined) continue;
              r = await restated(last.body, last.release);
            } else {
              const dep = deps[st.dep % Math.max(1, deps.length)];
              if (dep === undefined) continue;
              r = await send({
                ops: [
                  { intent: "update", table: "tasks", row: dep.row, ver: dep.ver, premises: [] },
                ],
              });
            }
            // A replay (the same request again, 04-contract §14) appends nothing: nothing to check.
            if (r === undefined || r["refused"] !== undefined || r["replayed"] === true) continue;
            done.push(r.seq);
            stats.ops++;
            // Every declaration in force, after this operation.
            for (const d of await inForce()) {
              const want = await walked(d, r.seq);
              expect({
                decl: [d.op, d.op_index, d.decl_index],
                after: r.seq,
                state: d.state,
                reason: d.reason,
                since: d.since,
              }).toEqual({ decl: [d.op, d.op_index, d.decl_index], after: r.seq, ...want });
              // Current: the range holds the value seen (checked directly).
              if (d.state === "current")
                expect(
                  differs(
                    d,
                    await cellsAt(d.table, d.target, d.seen),
                    await cellsAt(d.table, d.target, r.seq),
                  ),
                ).toBe(false);
              stats.checked++;
              if (d.state === "changed") stats.changed++;
              if (
                d.state === "current" &&
                d.since === null &&
                (await versionsOf(d.table, d.target)).some((v) => v > d.seen && v <= r.seq)
              )
                stats.matched++;
            }
          }
          stats.samples++;
        }),
        {
          numRuns: Number(process.env["PROP_RUNS"] ?? 25),
          ...(process.env["PROP_SEED"] ? { seed: Number(process.env["PROP_SEED"]) } : {}),
          ...(process.env["PROP_PATH"]
            ? { path: process.env["PROP_PATH"], endOnFailure: true }
            : {}),
        },
      );
      // The generator reaches every kind of conclusion: a degenerate one would pass vacuously.
      expect(stats.checked).toBeGreaterThan(stats.samples * 3);
      expect(stats.changed).toBeGreaterThan(0);
      expect(stats.late).toBeGreaterThan(0);
      const out = process.env["PREMISE_STATS"];
      if (out !== undefined)
        (await import("node:fs")).writeFileSync(out, `${JSON.stringify(stats)}\n`);
    },
    T,
  );
});
