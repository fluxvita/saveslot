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
// - `sql`'s `marks_summary.premise_changed` over tasks, read row by row and read whole, is the
//   number of task rows the oracle finds marked.
// - each task row's timeline gives premises on exactly the ops that sent `premises` for it (a
//   declaring write, a restatement, a clearing: an entry each, several of one request each its
//   own), as many as sent; read a page of one at a time, the same entries.
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
  history,
  loadRsql,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import {
  acceptPremisesForTests,
  COMPILED_V1,
  createSlotEvents,
  premiseFanInLimitForTests,
  queryInTx,
  resolveInTx,
  sqlInTx,
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
/** A decision through the pipeline; its write's receipt, if it wrote (none when refused). */
async function decide(params: unknown): Promise<(Receipt & Record<string, unknown>) | undefined> {
  try {
    const r = (await s.store.write((tx) =>
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
    )) as unknown as { write?: Receipt & Record<string, unknown> };
    return r.write;
  } catch (e) {
    if ((e as { code?: string }).code === undefined) throw e;
    return undefined;
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
  await loadRsql();
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
 * The changed premises each task's values rest on, as the oracle reads them (02-integrity «标记出现在
 * 哪一行»), by row: the givers of the task's cells in effect, carried references followed to their
 * ends in the sources table; the declarations whose edge for their target is on one of those items,
 * not voided by a later clearing entry (picked here as `inForce` picks them), changed. Neither
 * the marks' code nor its queries. Tasks get no corroboration here (asserted): none to add.
 */
async function expectedMarks(carriedTo?: { n: number }): Promise<Map<string, string[]>> {
  const { cells, sources, edges, decls, corroborated } = await s.store.read(async (tx) => ({
    cells: (
      await tx.query<{ row_id: string; field_id: string; e: unknown; f: string; k: unknown }>(
        `SELECT row_id, field_id, src_event AS e, src_field AS f, src_k AS k FROM t_t2_v1__ver
         WHERE rec_to IS NULL AND field_id <> 'existence' AND src_event IS NOT NULL`,
      )
    ).rows,
    sources: (
      await tx.query<{ e: unknown; f: string; k: unknown; ce: unknown; cf: string; ck: unknown }>(
        `SELECT event_seq AS e, field_id AS f, k, carried_event AS ce, carried_field AS cf,
                carried_k AS ck
         FROM base_sources`,
      )
    ).rows,
    edges: (
      await tx.query<{
        e: unknown;
        f: string;
        k: unknown;
        target: string;
        op: unknown;
        i: unknown;
        j: unknown;
      }>(
        `SELECT item_event AS e, field_id AS f, k, target, decl_op AS op, decl_op_index AS i,
                decl_index AS j
         FROM premise_edges`,
      )
    ).rows,
    decls: (
      await tx.query<{
        op: unknown;
        i: unknown;
        j: unknown;
        target: string;
        state: string;
        reason: string | null;
        since: unknown;
      }>(
        `SELECT op, op_index AS i, decl_index AS j, target_row AS target, state, reason, since
         FROM premise_decls`,
      )
    ).rows,
    corroborated: Number(
      (
        await tx.query<{ n: unknown }>(
          `SELECT count(*) AS n FROM base_sources b JOIN t_t2_v1__ver v ON v.row_id = b.row_id
           WHERE b.status = 'corroborated'`,
        )
      ).rows[0]?.n,
    ),
  }));
  expect(corroborated).toBe(0);
  const key = (e: unknown, f: string, k: unknown) => `${e}/${f}/${k}`;
  const carried = new Map<string, string[]>();
  for (const x of sources) {
    const from = key(x.e, x.f, x.k);
    const list = carried.get(from) ?? [];
    if (x.ce !== null) list.push(key(x.ce, x.cf, x.ck));
    carried.set(from, list);
  }
  const ends = (item: string, seen = new Set<string>()): string[] => {
    if (seen.has(item)) return [];
    seen.add(item);
    const next = carried.get(item) ?? [];
    return next.length === 0 ? [item] : next.flatMap((n) => ends(n, seen));
  };
  const later = (a: readonly number[], b: readonly number[]) =>
    (a[0] as number) > (b[0] as number) || (a[0] === b[0] && (a[1] as number) > (b[1] as number));
  const cleared = new Map<string, number[]>();
  for (const e of edges)
    if (e.target === "*") cleared.set(key(e.e, e.f, e.k), [Number(e.op), Number(e.i)]);
  const live = new Map<string, string[]>();
  for (const e of edges) {
    if (e.target === "*") continue;
    const at = [Number(e.op), Number(e.i)];
    const c = cleared.get(key(e.e, e.f, e.k));
    if (c !== undefined && later(c, at)) continue;
    const list = live.get(key(e.e, e.f, e.k)) ?? [];
    list.push(`${e.op}/${e.i}/${e.j}`);
    live.set(key(e.e, e.f, e.k), list);
  }
  const byKey = new Map(decls.map((d) => [`${d.op}/${d.i}/${d.j}`, d]));
  const NAME: Record<string, string> = { f3: "title", f4: "due" };
  const out = new Map<string, string[]>();
  const rows = new Set(cells.map((c) => c.row_id));
  for (const row of rows) {
    const fields = new Map<string, Set<string>>();
    // Declarations found on an item a write-back carries, not on the cell's own giver.
    const carriedDecls = new Set<string>();
    for (const c of cells.filter((x) => x.row_id === row))
      for (const item of ends(key(c.e, c.f, c.k)))
        for (const d of live.get(item) ?? []) {
          const set = fields.get(d) ?? new Set<string>();
          set.add(NAME[c.field_id] ?? c.field_id);
          fields.set(d, set);
          if (item !== key(c.e, c.f, c.k)) carriedDecls.add(d);
        }
    if (carriedTo !== undefined)
      for (const d of carriedDecls) if (byKey.get(d)?.state === "changed") carriedTo.n++;
    const marks = [...fields]
      .flatMap(([d, fs]) => {
        const x = byKey.get(d);
        if (x === undefined || x.state !== "changed") return [];
        return [
          JSON.stringify([Number(x.op), x.target, Number(x.since), x.reason, [...fs].sort()]),
        ];
      })
      .sort();
    if (marks.length > 0) out.set(row, marks);
  }
  return out;
}

/** Tasks read row by row, and read whole (a subquery reading the outer query's columns). */
const ONE_BY_ONE = "SELECT title FROM tasks";
const WHOLE =
  "SELECT title FROM tasks t WHERE EXISTS (SELECT 1 FROM releases r WHERE r.name <> t.title)";
/** `sql`'s `marks_summary.premise_changed` of `statement`. */
const summed = async (statement: string): Promise<unknown> =>
  (
    (await s.store.read((tx) =>
      sqlInTx(tx, {
        actor: USER as never,
        task: null,
        now: now() as never,
        visibility: { kind: "all" },
        params: { sql: statement },
        read: "rd_0000000000000000" as never,
      }),
    )) as unknown as { result: { marks_summary: Record<string, unknown> } }
  ).result.marks_summary["premise_changed"];

/** The changed premises each task carries as a query reads it, in `expectedMarks`'s terms. */
async function readMarks(): Promise<Map<string, string[]>> {
  const r = (await s.store.read((tx) =>
    queryInTx(tx, {
      actor: USER as never,
      task: null,
      now: now() as never,
      visibility: { kind: "all" },
      params: { table: "tasks", limit: 200 },
      read: "rd_0000000000000000" as never,
    }),
  )) as unknown as {
    result: {
      rows: {
        row: string;
        marks?: {
          premise_changed?: {
            premise: { row?: string; entity?: string };
            since: number;
            reason: string;
            fields: string[];
            declared: { seq: number };
          }[];
          premise_changed_total?: number;
        };
      }[];
    };
  };
  const out = new Map<string, string[]>();
  for (const x of r.result.rows) {
    const list = x.marks?.premise_changed;
    if (list === undefined) continue;
    expect(x.marks?.premise_changed_total).toBeUndefined();
    out.set(
      x.row,
      list
        .map((m) =>
          JSON.stringify([
            m.declared.seq,
            m.premise.row ?? m.premise.entity,
            m.since,
            m.reason,
            [...m.fields].sort(),
          ]),
        )
        .sort(),
    );
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
  | { k: "again" }
  /** A dependent row's own writes: from its version now, perhaps resting on a release. */
  | { k: "taskEdit"; dep: number; title: number; r: number; on: boolean }
  /** From its first version, resting on a release: a candidate when the title changed since, taken. */
  | { k: "taskStale"; dep: number; title: number; r: number }
  /** An undo of one of its earlier writes: held when it takes later ones back, confirmed. */
  | { k: "taskUndo"; dep: number; pick: number }
  /** One request of several ops on one dependent row: a declaring write, a restatement, a clearing. */
  | { k: "several"; dep: number; title: number; r: number; r2: number; clear: boolean };

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
    weight: 6,
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
  {
    weight: 5,
    arbitrary: fc.record({
      k: fc.constant("taskEdit" as const),
      dep: fc.nat(5),
      title: fc.nat(2),
      r: fc.nat(2),
      on: fc.boolean(),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("taskStale" as const),
      dep: fc.nat(5),
      title: fc.nat(2),
      r: fc.nat(2),
    }),
  },
  {
    weight: 4,
    arbitrary: fc.record({
      k: fc.constant("taskUndo" as const),
      dep: fc.nat(5),
      pick: fc.nat(2),
    }),
  },
  {
    weight: 2,
    arbitrary: fc.record({
      k: fc.constant("several" as const),
      dep: fc.nat(5),
      title: fc.nat(2),
      r: fc.nat(2),
      r2: fc.nat(2),
      clear: fc.boolean(),
    }),
  },
);

const TITLES = ["t", "u", "w"];

/**
 * A fixed sample run first in every run: a declaration resting on a release's version before the
 * current one (late), its target then changed, the dependent row restated and cleared. It does not
 * hang on the generator meeting the case.
 */
const EARLY_LATE: Step[] = [
  { k: "declare", on: "release", r: 0, fields: true, back: 1, range: 0 },
  { k: "release", r: 0, field: "date", value: 2 },
  { k: "taskEdit", dep: 1, title: 1, r: 0, on: false },
  { k: "restate", dep: 1, r: 0, back: 0, fallback: false },
  { k: "clear", dep: 1 },
  { k: "release", r: 0, field: "name", value: 1 },
];

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
        // Declarations resting on a version no longer current, of the random samples; and of the
        // fixed one (EARLY_LATE), which makes one every run.
        late: 0,
        lateFixed: 0,
        matched: 0,
        // Restatements by the fallback sent again: replayed, or taken anew.
        replayed: 0,
        resent: 0,
        // Task rows carrying a mark, summed over the operations.
        marked: 0,
        // Of them, a mark found through a carried reference (a candidate taken, a proposal
        // confirmed, an undo's write-back).
        viaCarried: 0,
        // Decisions on items opened on dependent rows.
        decided: 0,
        // Timeline entries of a restatement, and of a clearing (premises, no field).
        timelineRestated: 0,
        timelineCleared: 0,
        // Receipts with a premise_affected.
        affected: 0,
        // Of them, with marks taken off (matched > 0). Counted, not bounded: 1 or 2 in 25 samples,
        // so none in a run is likely (the fixed cases hold matched).
        affectedMatched: 0,
      };
      await fc.assert(
        fc.asyncProperty(fc.array(step, { minLength: 6, maxLength: 24 }), async (steps) => {
          const fixed = JSON.stringify(steps) === JSON.stringify(EARLY_LATE);
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
            // A second version at once: a declaration with `back` then rests on one no longer
            // current (late), from the first step on.
            const w = await ok({
              ops: [
                {
                  intent: "update",
                  table: "releases",
                  row: r.target.row,
                  ver: r.ver,
                  set: { date: DATES[(n + 1) % DATES.length] },
                },
              ],
            });
            releases.push({ row: r.target.row, vers: [r.ver, w.ops[0]?.ver as string] });
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
          const deps: { row: string; ver: string; first: string; ops: number[] }[] = [];
          /**
           * By task row, the operations that sent `premises` for it: for each, how many, op by op
           * in request order. A replay sends nothing new.
           */
          const declaredOn = new Map<string, Map<number, number[]>>();
          const sentPremises = (row: string, w: Record<string, unknown>, n: number) => {
            if (w["refused"] !== undefined || w["replayed"] === true) return;
            const m = declaredOn.get(row) ?? new Map<number, number[]>();
            m.set(w["seq"] as number, [...(m.get(w["seq"] as number) ?? []), n]);
            declaredOn.set(row, m);
          };
          // One dependent row from the start, resting on the first release: the steps on
          // dependent rows have one to work on at once.
          {
            const x = releases[0] as (typeof releases)[number];
            const d = await ok({
              ops: [
                {
                  intent: "insert",
                  table: "tasks",
                  set: { title: "t" },
                  premises: [{ table: "releases", row: x.row, ver: x.vers.at(-1) }],
                },
              ],
            });
            sentPremises(d.ops[0]?.target.row as string, d as never, 1);
            deps.push({
              row: d.ops[0]?.target.row as string,
              ver: d.ops[0]?.ver as string,
              first: d.ops[0]?.ver as string,
              ops: [d.seq],
            });
          }
          /**
           * The item a write on a dependent row opened, decided at once (a candidate taken, a
           * proposal confirmed): the decision's write, checked as the step's operation.
           */
          // The oracle's marks right before the operation checked (none at the start of a sample).
          let before = new Map<string, string[]>();
          const decided = async (
            w: object,
            decision: "take_candidate" | "confirm",
            dep: { ver: string; ops: number[] },
          ) => {
            const pending = (w as { pending?: { id: string; item_ver?: string }[] }).pending;
            const it = (pending ?? []).find((x) => x.item_ver !== undefined);
            if (it === undefined) return undefined;
            // The write that opened the item is not checked on its own: what is before the
            // decision is what it left.
            before = await expectedMarks();
            const d = await decide({
              id: it.id,
              decision,
              item_ver: it.item_ver,
              idempotency_key: `decide-${it.id}`,
            });
            if (d === undefined) return undefined;
            dep.ver = d.ops[0]?.ver as string;
            dep.ops.push(d.seq);
            stats.decided++;
            return d;
          };
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
              if (r["refused"] === undefined) sentPremises(r.ops[0]?.target.row as string, r, 1);
              if (r["refused"] === undefined)
                deps.push({
                  row: r.ops[0]?.target.row as string,
                  ver: r.ops[0]?.ver as string,
                  first: r.ops[0]?.ver as string,
                  ops: [r.seq],
                });
              if (r["refused"] === undefined && ver !== x.vers.at(-1)) {
                if (fixed) stats.lateFixed++;
                else stats.late++;
              }
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
              sentPremises(dep.row, r, 1);
            } else if (st.k === "again") {
              if (last === undefined) continue;
              const row = (last.body as { ops: { row: string }[] }).ops[0]?.row as string;
              r = await restated(last.body, last.release);
              sentPremises(row, r, 1);
            } else if (st.k === "taskEdit" || st.k === "taskStale") {
              const i = st.dep % Math.max(1, deps.length);
              const dep = deps[i];
              if (dep === undefined) continue;
              const x = releases[st.r] as (typeof releases)[number];
              const on = st.k === "taskStale" || st.on;
              r = await send({
                ops: [
                  {
                    intent: "update",
                    table: "tasks",
                    row: dep.row,
                    ver: st.k === "taskStale" ? dep.first : dep.ver,
                    set: { title: TITLES[st.title] },
                    ...(on
                      ? { premises: [{ table: "releases", row: x.row, ver: x.vers.at(-1) }] }
                      : {}),
                  },
                ],
              });
              if (on) sentPremises(dep.row, r, 1);
              if (r["refused"] === undefined) {
                if ((r as { status?: string }).status !== "pending")
                  dep.ver = r.ops[0]?.ver as string;
                dep.ops.push(r.seq);
                r = (await decided(r, "take_candidate", dep)) ?? r;
              }
            } else if (st.k === "taskUndo") {
              const dep = deps[st.dep % Math.max(1, deps.length)];
              // Its latest writes the likelier: an undo of one of the last three.
              const target =
                dep?.ops[
                  (dep?.ops.length ?? 0) - 1 - (st.pick % Math.max(1, dep?.ops.length ?? 1))
                ];
              if (dep === undefined || target === undefined) continue;
              r = await send({ ops: [{ table: "tasks", row: dep.row, revert: { undo: target } }] });
              if (r["refused"] === undefined) {
                if ((r as { status?: string }).status !== "pending")
                  dep.ver = r.ops[0]?.ver as string;
                dep.ops.push(r.seq);
                r = (await decided(r, "confirm", dep)) ?? r;
              }
            } else if (st.k === "several") {
              const dep = deps[st.dep % Math.max(1, deps.length)];
              if (dep === undefined) continue;
              const x = releases[st.r] as (typeof releases)[number];
              const y = releases[st.r2] as (typeof releases)[number];
              const rest = (z: typeof x) => [{ table: "releases", row: z.row, ver: z.vers.at(-1) }];
              r = await send({
                ops: [
                  {
                    intent: "update",
                    table: "tasks",
                    row: dep.row,
                    ver: dep.ver,
                    set: { title: TITLES[st.title] },
                    premises: rest(x),
                  },
                  { intent: "update", table: "tasks", row: dep.row, premises: rest(y) },
                  ...(st.clear
                    ? [{ intent: "update", table: "tasks", row: dep.row, premises: [] }]
                    : []),
                ],
              });
              sentPremises(dep.row, r, 1);
              sentPremises(dep.row, r, 1);
              if (st.clear) sentPremises(dep.row, r, 0);
              if (r["refused"] === undefined && r["replayed"] !== true) {
                if ((r as { status?: string }).status !== "pending")
                  dep.ver = r.ops[0]?.ver as string;
                dep.ops.push(r.seq);
              }
            } else {
              const dep = deps[st.dep % Math.max(1, deps.length)];
              if (dep === undefined) continue;
              r = await send({
                ops: [
                  { intent: "update", table: "tasks", row: dep.row, ver: dep.ver, premises: [] },
                ],
              });
              sentPremises(dep.row, r, 0);
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
            // The marks a query reads on every task: what the oracle finds (as a sorted list).
            const carried = { n: 0 };
            const want = await expectedMarks(carried);
            stats.viaCarried += carried.n;
            expect({ after: r.seq, marks: Object.fromEntries(await readMarks()) }).toEqual({
              after: r.seq,
              marks: Object.fromEntries(want),
            });
            stats.marked += want.size;
            // sql over tasks, row by row and the table read whole: the rows the oracle marks.
            for (const statement of [ONE_BY_ONE, WHOLE])
              expect({ after: r.seq, statement, premise_changed: await summed(statement) }).toEqual(
                { after: r.seq, statement, premise_changed: want.size },
              );
            // The receipt's premise_affected: the rows a mark changed at this operation now shows
            // on, by reason; the rows that showed one before whose declaration is current now.
            type Mark = [number, string, number, string, string[]];
            const parse = (m: Map<string, string[]>) =>
              [...m].flatMap(([row, xs]) => xs.map((x) => ({ row, m: JSON.parse(x) as Mark })));
            const states = new Map(
              (
                await s.store.read((tx) =>
                  tx.query<{ op: unknown; target: string; state: string }>(
                    "SELECT op, target_row AS target, state FROM premise_decls",
                  ),
                )
              ).rows.map((x) => [`${x.op} ${x.target}`, x.state]),
            );
            const marked = parse(want).filter((x) => x.m[2] === r.seq);
            const taken = parse(before).filter(
              (x) => states.get(`${x.m[0]} ${x.m[1]}`) === "current",
            );
            const byReason: Record<string, number> = {};
            for (const reason of new Set(marked.map((x) => x.m[3])))
              byReason[reason] = new Set(
                marked.filter((x) => x.m[3] === reason).map((x) => x.row),
              ).size;
            const rows = (xs: { row: string }[]) => new Set(xs.map((x) => x.row)).size;
            const got = (r as { premise_affected?: Record<string, unknown> }).premise_affected;
            expect({
              after: r.seq,
              premise_affected:
                got === undefined
                  ? undefined
                  : {
                      count: got["count"],
                      matched: got["matched"],
                      by_reason: got["by_reason"],
                    },
            }).toEqual({
              after: r.seq,
              premise_affected:
                marked.length === 0 && taken.length === 0
                  ? undefined
                  : { count: rows(marked), matched: rows(taken), by_reason: byReason },
            });
            if (got !== undefined) stats.affected++;
            if (((got?.["matched"] as number | undefined) ?? 0) > 0) stats.affectedMatched++;
            before = want;
          }
          // Each task row's timeline: premises on the operations that sent them, as many as sent.
          for (const dep of deps) {
            const t = (await history(s.store, ctx(), {
              table: "tasks",
              row: dep.row,
              mode: "timeline",
              limit: 200,
            })) as unknown as {
              next_position?: string;
              entries: { seq: number; intent: string; fields: object; premises?: unknown[] }[];
            };
            expect(t.next_position).toBeUndefined();
            // By (operation, op index): the entries of one operation come by op index from the
            // last, so reversed they are in request order.
            const got = new Map<number, number[]>();
            for (const e of [...t.entries].reverse())
              if (e.premises !== undefined)
                got.set(e.seq, [...(got.get(e.seq) ?? []), e.premises.length]);
            expect({ row: dep.row, premises: [...got].sort((a, b) => a[0] - b[0]) }).toEqual({
              row: dep.row,
              premises: [...(declaredOn.get(dep.row) ?? [])].sort((a, b) => a[0] - b[0]),
            });
            // Read a page of one at a time: the same entries, none lost.
            const one: unknown[] = [];
            let position: string | undefined;
            do {
              const p = (await history(s.store, ctx(), {
                table: "tasks",
                row: dep.row,
                mode: "timeline",
                limit: 1,
                ...(position !== undefined ? { position } : {}),
              })) as unknown as { next_position?: string; entries: unknown[] };
              one.push(...p.entries);
              position = p.next_position;
            } while (position !== undefined);
            expect({ row: dep.row, entries: one }).toEqual({ row: dep.row, entries: t.entries });
            for (const e of t.entries)
              if (e.premises !== undefined && Object.keys(e.fields).length === 0) {
                if (e.premises.length > 0) stats.timelineRestated++;
                else stats.timelineCleared++;
              }
          }
          stats.samples++;
        }),
        {
          numRuns: Number(process.env["PROP_RUNS"] ?? 25),
          examples: [[EARLY_LATE]],
          ...(process.env["PROP_SEED"] ? { seed: Number(process.env["PROP_SEED"]) } : {}),
          ...(process.env["PROP_PATH"]
            ? { path: process.env["PROP_PATH"], endOnFailure: true }
            : {}),
        },
      );
      // The generator reaches every kind of conclusion: a degenerate one would pass vacuously.
      expect(stats.checked).toBeGreaterThan(stats.samples * 3);
      expect(stats.changed).toBeGreaterThan(0);
      // The fixed sample's late declaration, every run; the random ones' floor only guards against
      // a generator gone degenerate. With each release at two versions from the start and declare
      // at weight 6, four runs of 25 gave 27, 15, 18 and 23 (a mean of about 21; before, about 6,
      // and a run with none was seen): none in a run has odds well under one in a million.
      expect(stats.lateFixed).toBe(1);
      expect(stats.late).toBeGreaterThan(0);
      expect(stats.marked).toBeGreaterThan(0);
      expect(stats.affected).toBeGreaterThan(0);
      expect(stats.timelineRestated).toBeGreaterThan(0);
      expect(stats.timelineCleared).toBeGreaterThan(0);
      const out = process.env["PREMISE_STATS"];
      if (out !== undefined)
        (await import("node:fs")).writeFileSync(out, `${JSON.stringify(stats)}\n`);
    },
    T,
  );
});
