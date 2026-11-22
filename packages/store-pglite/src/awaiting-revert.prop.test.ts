// An awaiting revert proposal shows what confirming it does (05-time «高影响写入»; 04-write-and-read
// «撤回某次写入（undo）»; 09 §5.8 `scope_valid`, `impact`), over random histories on PGlite: undos
// of earlier writes (most without `acknowledge`, so that they await), writes and revokes that
// refresh the items, and confirmations with the item version just read. On every confirmation:
// - the item's interval comes from its confirmation judged now and its impact from its undo judged
//   again now (the confirmation does not judge high impact ①): the two list the same entries;
// - the confirmation's write covers exactly the item's spans (state tables);
// - the item's impact names exactly the later writes whose result a reader sees changes once it
//   is confirmed, each with the fields whose result changes (a revoke as "*"), worked out here
//   from the cells before and after: piece by piece and field by field, the value, or on a state
//   table that the stretch has none (a revoke and a gap alike), or on an event or timeless table
//   that the row is revoked; a write giving a result that changes is named, in the undo's record
//   or not, and one whose contribution goes while the result stays the same is not.
// An item that has nothing left to do is closed (`nothing_to_revert`): it can then be neither
// confirmed nor rejected. Each table's histories start from fixed ones that widen, narrow or empty
// an item, or hide another field's write as a stretch loses its value (every run reaches those),
// each then replayed from the log into an empty store: the
// items, flags and tables are the same; random ones follow. Reads are by a third principal, which
// never writes: a writer that had read an item would supersede it instead of refreshing it.
// `PROP_SEED` fixes the seed, `PROP_RUNS` the histories per table.
//
// Reads here are by a third principal that never writes, so two guarantees are not this test's but
// the fixed cases' in write-items.test.ts: an awaiting undo that its undo, judged again, can no
// longer do closes as nothing_to_revert ("a timeless row revoked under an awaiting undo …", and the
// guard on confirming one that would write nothing); and a writer that had read the item and
// leaves it nothing to do supersedes it as overwritten ("a writer that had read a revert proposal
// …", "the proposer, who has read its own proposal …", "a request whose first op …", "… and
// widens it …").

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending,
  type ReadTx,
  readBufferOf,
  readEvents,
  readTail,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  revertEntriesOf,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { copyLog } from "./testing/copy-log.fixture.ts";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 600_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const THIRD = `ci_${"3".repeat(26)}`;
const SEED =
  process.env["PROP_SEED"] === undefined
    ? Date.now() % 1_000_000
    : Number(process.env["PROP_SEED"]);
const RUNS = Number(process.env["PROP_RUNS"] ?? 60);

const text = (id: string, name: string, required?: true) => ({
  id,
  name,
  type: "text",
  description: name,
  ...(required ? { required } : {}),
});
const TABLES = {
  entities: { id: "t1", kind: "state", fields: [text("f2", "b", true), text("f3", "c")] },
  loose: { id: "t2", kind: "state", fields: [text("f2", "b"), text("f3", "c")] },
  rows: { id: "t3", kind: "none", fields: [text("f2", "b", true), text("f3", "c")] },
} as const;
type TableName = keyof typeof TABLES;
const COMPILED = {
  ...COMPILED_V1,
  tables: Object.entries(TABLES).map(([name, t]) => ({
    id: t.id,
    name,
    kind: "base",
    description: name,
    time: t.kind === "state" ? { type: "state", granularity: "date" } : { type: "none" },
    physical: { table: `t_${t.id}_v1` },
    fields: t.fields,
  })),
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
let tick = 0;
let ids = 0;
const now = () => new Date(Date.UTC(2026, 10, 6) + ++tick * 50).toISOString();
const newId = (kind: "row" | "entity" | "source" | "item" | "partition") =>
  `${{ row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" }[kind]}${String(++ids).padStart(kind === "row" || kind === "entity" ? 26 : 16, "0")}`;
const J = (x: unknown) => JSON.stringify(x);

// biome-ignore lint/suspicious/noExplicitAny: receipts and refusals are read as plain JSON here.
type Any = any;

const windows = { requestKey: 600_000, idempotencyKey: 86_400_000 };
async function send(params: unknown, actor: string): Promise<Any> {
  try {
    return await s.store.write((tx) =>
      writeInTx(tx, {
        actor: actor as never,
        task: null,
        now: now(),
        windows,
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    );
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown>; message?: string };
    if (x.code === undefined) return { thrown: String(x.message ?? e) };
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}
async function decide(params: unknown): Promise<Any> {
  try {
    return await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: THIRD as never,
        task: null,
        now: now(),
        windows,
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    );
  } catch (e) {
    const x = e as { code?: string; detail?: Record<string, unknown>; message?: string };
    if (x.code === undefined) return { thrown: String(x.message ?? e) };
    return { refused: x.code, ...(x.detail ?? {}) };
  }
}
const ctxOf = (actor: string) =>
  createOpsContext({
    tenant: TENANT,
    actor,
    trigger: null,
    task: null,
    visibility: { kind: "all" },
    idempotency_key_window: 86_400_000,
    idempotency_window: 600_000,
    now: now(),
    confirmation: null,
  });
const detailOf = async (id: string): Promise<Any> => pending(s.store, ctxOf(THIRD), { id });

async function fresh() {
  await s.reset();
  readBufferOf(s.store).take();
  await createTenant(
    s.store,
    createOpsContext({ ...(ctxOf(USER) as object), now: "2026-11-05T00:00:00.000Z" } as never),
  );
  await s.store.write(async (tx) => {
    const op = await appendOperation(tx, {
      actor: USER as never,
      now: "2026-11-05T00:00:30.000Z" as never,
      events: createSlotEvents({ compiled: COMPILED as never, changes: CHANGES as never }),
    });
    await applyEvents(tx, eventsOf(op));
  });
}

// --- intervals ----------------------------------------------------------------------------------

/** A stretch of business time: null ends are open. */
type Iv = { readonly from: string | null; readonly to: string | null };
const ivOf = (x: Any): Iv => ({ from: x?.valid_from ?? null, to: x?.valid_to ?? null });
/** Sorted, touching and overlapping stretches joined. */
function merged(xs: readonly Iv[]): Iv[] {
  const sorted = [...xs].sort((a, b) =>
    a.from === b.from ? 0 : a.from === null ? -1 : b.from === null ? 1 : a.from < b.from ? -1 : 1,
  );
  const out: Iv[] = [];
  for (const x of sorted) {
    const last = out.at(-1);
    // x.from <= last.to: they touch or overlap.
    if (last !== undefined && (last.to === null || x.from === null || x.from <= last.to)) {
      // biome-ignore lint/complexity/useMathMinMax: dates and instants as text, not numbers.
      const to = last.to === null || x.to === null ? null : last.to > x.to ? last.to : x.to;
      out[out.length - 1] = { from: last.from, to };
    } else out.push(x);
  }
  return out;
}

/** A cell still open: the operation that gave it, and its stretch (the whole time off the time line). */
type Cell = {
  readonly op: number | null;
  readonly field: string;
  readonly iv: Iv;
  readonly revoked: boolean;
  /**
   * The cell gives no value: the stretch has none and this cell says who left it so (02-architecture
   * §8), or the cell is a write-back of "no value", which reads empty as a field never written does
   * and gives no result (04-write-and-read «撤回某次写入（undo）»: listed by what a reader sees).
   */
  readonly noValue: boolean;
  readonly value: unknown;
};
async function cellsOf(table: TableName, id: string, inTx?: ReadTx): Promise<Cell[]> {
  const t = TABLES[table];
  const time =
    t.kind === "state"
      ? "v.valid_from::text AS vf, v.valid_to::text AS vt"
      : "NULL AS vf, NULL AS vt";
  const run = <X>(f: (tx: ReadTx) => Promise<X>) => (inTx ? f(inTx) : s.store.read(f));
  const r = await run((tx) =>
    tx.query<{
      vf: string | null;
      vt: string | null;
      op: unknown;
      field_id: string;
      revoked: boolean | null;
      no_value: boolean | null;
      f_f2: unknown;
      f_f3: unknown;
      no_value_item: boolean | null;
    }>(
      `SELECT ${time}, v.field_id, v.revoked, v.no_value, v.f_f2, v.f_f3,
         (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS op,
         EXISTS (SELECT 1 FROM content c WHERE c.seq = v.src_event
                 AND c.path = 'fields/' || v.field_id || '/' || v.src_k::text
                 AND c.body LIKE '%"no_value":true%') AS no_value_item
       FROM "t_${t.id}_v1__ver" v WHERE v.row_id = $1 AND v.rec_to IS NULL`,
      [id],
    ),
  );
  return r.rows.map((x) => ({
    op: x.op == null ? null : Number(x.op),
    field: x.field_id,
    iv: { from: x.vf, to: x.vt },
    revoked: x.revoked === true,
    // The cell's own item is a write-back of "no value": on a state table the stretch may still have
    // a value (another field's), and a timeless row keeps no no-value flag on its cells at all.
    noValue: x.no_value === true || x.no_value_item === true,
    value: x.field_id === "f2" ? x.f_f2 : x.field_id === "f3" ? x.f_f3 : null,
  }));
}

const FIELD_NAMES: Readonly<Record<string, string>> = { f2: "b", f3: "c" };

/** The pieces of the timeline the cells of `sets` cut it into (state tables). */
function piecesOf(sets: readonly (readonly Cell[])[]): Iv[] {
  const points = [
    ...new Set(
      sets
        .flat()
        .flatMap((c) => [c.iv.from, c.iv.to])
        .filter((x): x is string => x !== null),
    ),
  ].sort();
  const ends = [null, ...points, null];
  return ends.slice(0, -1).map((from, i) => ({ from, to: ends[i + 1] ?? null }));
}
const covers = (c: Cell, g: Iv) =>
  (c.iv.from === null || (g.from !== null && c.iv.from <= g.from)) &&
  (c.iv.to === null || (g.to !== null && g.to <= c.iv.to));

/**
 * What a reader sees of a field on a piece, from the cells, and the cells that give it. State
 * tables: a stretch has a value when some field cell there is not a no-value cell; without one,
 * every field reads "no value" (a revoke and a gap alike), given by the revoke cells there. Event
 * and timeless tables: a revoked row reads "revoked", given by its revoke cell; else the value.
 */
function readOf(state: boolean, cells: readonly Cell[], g: Iv, f: string) {
  const here = cells.filter((c) => covers(c, g));
  const cell = here.find((c) => c.field === f);
  if (state) {
    const valued = here.some((c) => c.field !== "existence" && !c.noValue);
    if (!valued) {
      return {
        token: "no value",
        givers: here.filter((c) => c.field === "existence" && c.revoked),
        hole: true,
      };
    }
    return {
      token: cell === undefined || cell.noValue ? "none" : J(cell.value),
      givers: cell && !cell.noValue ? [cell] : [],
      hole: false,
    };
  }
  const revoke = here.find((c) => c.field === "existence" && c.revoked);
  if (revoke !== undefined) return { token: "revoked", givers: [revoke], hole: true };
  if (cell === undefined || cell.noValue) return { token: "none", givers: [], hole: false };
  return { token: J(cell.value), givers: [cell], hole: false };
}

/**
 * The later writes whose result a reader sees changes from `before` to `after`, with the fields
 * (or "*" for a revoke) of each: the cells giving a result that changes.
 */
function changedWrites(
  state: boolean,
  before: readonly Cell[],
  after: readonly Cell[],
  since: number,
  owner: (op: number) => number,
): Map<number, string[]> {
  const out = new Map<number, Set<string>>();
  const pieces = state ? piecesOf([before, after]) : [{ from: null, to: null }];
  for (const g of pieces) {
    for (const f of ["f2", "f3"]) {
      const was = readOf(state, before, g, f);
      if (was.token === readOf(state, after, g, f).token) continue;
      for (const c of was.givers) {
        if (c.op === null) continue;
        const op = owner(c.op);
        if (op <= since) continue;
        const xs = out.get(op) ?? new Set<string>();
        xs.add(c.field === "existence" ? "*" : (FIELD_NAMES[c.field] as string));
        out.set(op, xs);
      }
    }
  }
  return new Map([...out].map(([op, xs]) => [op, [...xs].sort()]));
}

function rng(seed: number) {
  let a = seed >>> 0;
  return () => {
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
const IVS: readonly [string, string][] = [
  ["2026-11-01", "open"],
  ["2026-11-05", "2026-11-10"],
  ["2026-11-05", "open"],
  ["2026-11-10", "2026-11-15"],
  ["2026-11-01", "2026-11-10"],
  ["2026-11-10", "open"],
  ["2026-11-15", "2026-11-20"],
];

// --- fixed histories: each run begins with them ----------------------------------------------------

/**
 * A step of a fixed history: a write (`$n` in an undo is the n-th step's operation; `ver: "$n"` the
 * version it left), or the confirmation of the item step `of` opened.
 */
type Step =
  | { readonly actor: string; readonly op: Record<string, unknown> }
  | { readonly confirm: number }
  /** take_previous on a copy, on the conflict item the step `previous` opened. */
  | { readonly previous: number };
/** The A history of the reproduction: an undo of a whole revoke's undo widened by a refresh. */
const WIDENED: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-20", set: { b: "b0" } },
  },
  { actor: USER, op: { intent: "revoke", ver: "$0" } },
  { actor: USER, op: { intent: "correct", revert: { undo: "$1" }, ver: "$1" } },
  {
    actor: USER,
    op: { intent: "revoke", ver: "$2", valid_from: "2026-11-05", valid_to: "2026-11-10" },
  },
  { actor: OTHER, op: { intent: "correct", revert: { undo: "$2" }, ver: "$3" } },
  { actor: USER, op: { revert: { undo: "$3" }, ver: "$3" } },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$5",
      valid_from: "2026-10-20",
      valid_to: "2026-10-25",
      set: { b: "early" },
    },
  },
  { confirm: 4 },
];
/** An undo narrowed: another principal corrects part of what it would take back. */
const NARROWED: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-20", set: { b: "b0" } },
  },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-15",
      set: { b: "b1" },
    },
  },
  { actor: OTHER, op: { revert: { undo: "$1" }, ver: "$1" } },
  {
    actor: USER,
    op: {
      intent: "correct",
      ver: "$1",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b3" },
    },
  },
  { confirm: 2 },
];
/** An undo emptied: all of what it would take back corrected. */
const EMPTIED: readonly Step[] = [
  { actor: USER, op: { intent: "insert", valid_from: "2026-11-01", set: { b: "b0" } } },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b1" },
    },
  },
  { actor: USER, op: { revert: { undo: "$1" }, ver: "$1" } },
  {
    actor: OTHER,
    op: {
      intent: "correct",
      ver: "$1",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b3" },
    },
  },
  { confirm: 2 },
];

/** A timeless row: undoing a restore would hide a later write (undo_hides_later): it awaits. */
const LATER: readonly Step[] = [
  { actor: USER, op: { intent: "insert", set: { b: "b0" } } },
  { actor: USER, op: { intent: "revoke", ver: "$0" } },
  { actor: USER, op: { revert: { undo: "$1" }, ver: "$1" } },
  { actor: OTHER, op: { intent: "update", ver: "$2", set: { c: "c2" } } },
  { actor: USER, op: { revert: { undo: "$2" }, ver: "$3" } },
  { confirm: 4 },
];

/**
 * An undo whose write-back leaves a stretch without a value (b, required, filled a hole there),
 * hiding a later write of another field that has the same value on both sides of the stretch and
 * no change point of its own: c goes with the stretch, and the impact names that write.
 */
const HIDDEN: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-05", set: { b: "b0" } },
  },
  {
    actor: OTHER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b1" },
    },
  },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$1",
      valid_from: "2026-11-01",
      valid_to: "2026-11-10",
      set: { c: "c2" },
    },
  },
  { actor: OTHER, op: { revert: { undo: "$1" }, ver: "$2" } },
  { confirm: 3 },
];

/** A conflict item whose merge base has no value on a stretch: going back hides c written there. */
const PREVIOUS_HIDES: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-05", set: { b: "b0" } },
  },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b1" },
    },
  },
  {
    actor: OTHER,
    op: {
      intent: "update",
      ver: "$1",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { c: "c3" },
    },
  },
  {
    actor: OTHER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b2" },
    },
  },
  { previous: 3 },
];
/** A later write puts the merge base's value back: going back changes nothing there. */
const PREVIOUS_SAME: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-10", set: { b: "b0" } },
  },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b1" },
    },
  },
  {
    actor: OTHER,
    op: {
      intent: "update",
      ver: "$0",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b2" },
    },
  },
  {
    actor: USER,
    op: {
      intent: "update",
      ver: "$1",
      valid_from: "2026-11-05",
      valid_to: "2026-11-10",
      set: { b: "b0" },
      acknowledge: ["overwrite"],
    },
  },
  { previous: 2 },
];
/** A conflict on existence: going back lifts the revoke in effect. */
const PREVIOUS_EXISTENCE: readonly Step[] = [
  {
    actor: USER,
    op: { intent: "insert", valid_from: "2026-11-01", valid_to: "2026-11-10", set: { b: "b0" } },
  },
  {
    actor: USER,
    op: { intent: "revoke", ver: "$0", valid_from: "2026-11-05", valid_to: "2026-11-10" },
  },
  {
    actor: OTHER,
    op: { intent: "revoke", ver: "$0", valid_from: "2026-11-05", valid_to: "2026-11-10" },
  },
  { previous: 2 },
];

/** The log replayed into it: the items, flags and tables must come out the same (K12). */
let replica: ReusableStore;

beforeAll(async () => {
  s = await openReusable("saveslot-awaiting-revert-");
  replica = await openReusable("saveslot-awaiting-revert-replica-");
}, T);
afterAll(async () => {
  await s?.close();
  await replica?.close();
}, T);

/** The items, their flags and the tables of `table`, every row as JSON text, sorted. */
async function itemsAndTables(store: ReusableStore["store"], table: TableName) {
  const t = TABLES[table];
  const big = (_: string, v: unknown) => (typeof v === "bigint" ? String(v) : v);
  const out: Record<string, string[]> = {};
  for (const name of ["pending_items", "flags", `t_${t.id}_v1`, `t_${t.id}_v1__ver`]) {
    const r = await store.read((tx) => tx.query(`SELECT * FROM "${name}"`));
    out[name] = r.rows.map((x) => JSON.stringify(x, big)).sort();
  }
  return out;
}

/** The store's whole log replayed into the emptied replica; what it then holds. */
async function replayed(table: TableName) {
  await replica.reset();
  await replica.store.write(async (tx) => {
    await copyLog(s.store, tx);
    const last = (await readTail(tx))?.seq ?? 0;
    await applyEvents(tx, await readEvents(tx, 1, last));
  });
  return itemsAndTables(replica.store, table);
}

describe.each(Object.keys(TABLES) as TableName[])(
  "%s: an awaiting revert proposal shows what confirming it does",
  (table) => {
    it(
      `on every confirmation of random histories (seed ${SEED})`,
      async () => {
        const r = rng(SEED + Object.keys(TABLES).indexOf(table) * 7919);
        const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)] as X;
        const t = TABLES[table];
        const state = t.kind === "state";
        const key = state ? "entity" : "row";
        const span = (vf: string, vt: string) => (state ? { valid_from: vf, valid_to: vt } : {});
        const faults: string[] = [];
        const reached: Record<string, number> = {};
        const reach = (k: string) => {
          reached[k] = (reached[k] ?? 0) + 1;
        };
        const fixed =
          table === "entities"
            ? [
                WIDENED,
                NARROWED,
                EMPTIED,
                HIDDEN,
                PREVIOUS_HIDES,
                PREVIOUS_SAME,
                PREVIOUS_EXISTENCE,
              ]
            : table === "rows"
              ? [LATER]
              : [NARROWED];
        for (let h = 0; h < fixed.length + RUNS; h++) {
          // A fresh store for each fixed history (their requests repeat across them) and every 20.
          if (h < fixed.length || (h - fixed.length) % 20 === 0) await fresh();
          const log: string[] = [];
          const fault = (what: string, more = "") =>
            faults.push(`${what} [history ${h}]\n${log.join("\n")}${more}`);
          /** The items opened by undos: what they take back, and their spans when opened. */
          const open = new Map<
            string,
            { undone: number; proposal: number; spans: Iv[] | undefined }
          >();
          /** A confirmation's operation, and the undo it confirms. */
          const confirmed = new Map<number, number>();
          const seqs: number[] = [];
          const vers: string[] = [];
          let id: string | undefined;

          const write = async (op: Record<string, unknown>, actor: string) => {
            const params = {
              sv: 1,
              ops: [{ table, ...(id !== undefined ? { [key]: id } : {}), ...op }],
            };
            const res = await send(params, actor);
            log.push(
              `#${res.seq ?? "-"} ${actor === USER ? "USER" : "OTHER"} ${J(op)} -> ${res.thrown ?? res.refused ?? res.status}`,
            );
            if (res.thrown !== undefined) fault(`a write threw: ${res.thrown}`);
            else if (res.refused === "internal")
              fault(`a write was refused as internal: ${J(res)}`);
            if (res.ops === undefined) return res;
            id ??= (res.ops[0].target.entity ?? res.ops[0].target.row) as string;
            seqs.push(res.seq);
            vers.push(res.ops[0].ver ?? vers.at(-1));
            const undo = (op["revert"] as { undo?: number } | undefined)?.undo;
            for (const q of (res.pending ?? []) as Any[]) {
              // Opened here: not an item this write only refreshed (the receipt lists those too).
              if (q.type !== "awaiting_confirmation" || undo === undefined || q.refreshed === true)
                continue;
              if (open.has(q.id)) continue;
              const d = await detailOf(q.id);
              open.set(q.id, {
                undone: undo,
                proposal: res.seq,
                spans: state ? ((d.target.spans ?? []) as Any[]).map(ivOf) : undefined,
              });
            }
            if (h >= fixed.length) {
              for (const q of (res.pending ?? []) as Any[]) {
                if (q.type === "conflict" && r() < 0.4) await previousOnCopy(q.id);
              }
            }
            for (const x of (res.superseded ?? []) as Any[]) {
              if (!open.has(x.item)) continue;
              if (x.reason === "nothing_to_revert") {
                reach("closed: nothing to revert");
                // Closed: neither confirmed nor rejected now.
                const d = await detailOf(x.item);
                if (d.status !== "superseded") fault(`a closed item is ${d.status}`, ` ${J(d)}`);
                for (const decision of ["confirm", "reject"]) {
                  const c = await decide({ id: x.item, decision, item_ver: d.item_ver });
                  if (c.refused !== "item_closed")
                    fault(`${decision} on an item closed as nothing to revert`, `\n${J(c)}`);
                }
              }
              open.delete(x.item);
            }
            return res;
          };

          /**
           * take_previous on a conflict item, decided in a transaction that is then rolled back (it
           * leaves the store and the read buffer as they were: write-impact.test.ts): the writes it
           * lists in reverted_by_previous are exactly the later writes whose result a reader sees
           * change, worked out from the cells before and after, since the merge base.
           */
          const previousOnCopy = async (item: string) => {
            const d = await detailOf(item);
            if (d.type !== "conflict" || d.status !== "open") return;
            const since = d.previous.seq as number;
            const before = await cellsOf(table, id as string);
            const ROLLBACK = new Error("roll back");
            let after: Cell[] = [];
            let refused: Any;
            await s.store
              .write(async (tx) => {
                try {
                  await resolveInTx(tx, {
                    actor: THIRD as never,
                    task: null,
                    now: now(),
                    windows,
                    visibility: { kind: "all" },
                    params: { id: item, decision: "take_previous", item_ver: d.item_ver },
                    newId,
                    reads: readBufferOf(s.store),
                  });
                } catch (e) {
                  refused = e;
                  throw ROLLBACK;
                }
                after = await cellsOf(table, id as string, tx);
                throw ROLLBACK;
              })
              .catch((e: unknown) => {
                if (e !== ROLLBACK) throw e;
              });
            log.push(`#- THIRD take_previous on a copy ${item} -> ${refused?.code ?? "resolved"}`);
            if (refused !== undefined) {
              if (refused.code === undefined || refused.code === "internal")
                fault(`take_previous refused: ${String(refused.message ?? refused)}`);
              else reach(`take_previous refused: ${refused.code}`);
              return;
            }
            reach("take_previous on a copy");
            const want = changedWrites(state, before, after, since, (op) => op);
            const got = new Map<number, string[]>(
              ((d.reverted_by_previous ?? []) as Any[]).map((x) => [
                x.seq as number,
                [...(x.fields as string[])].sort(),
              ]),
            );
            const sorted = (m: Map<number, string[]>) => J([...m].sort(([a], [b]) => a - b));
            if (sorted(want) !== sorted(got))
              fault(
                "reverted_by_previous names other writes than those whose result changes",
                `\nWANT ${sorted(want)}\nGOT ${sorted(got)}\nBEFORE ${J(before)}\nAFTER ${J(after)}`,
              );
            else if (want.size > 0) reach("take_previous: writes named");
          };

          const confirm = async (item: string) => {
            const at = open.get(item);
            if (at === undefined) return;
            const d = await detailOf(item);
            if (d.status !== "open") {
              open.delete(item);
              return;
            }
            const spans = state ? merged(((d.target.spans ?? []) as Any[]).map(ivOf)) : undefined;
            const listed = new Set<number>(
              ((d.impact?.reverted ?? []) as Any[]).map((x) => x.seq as number),
            );
            // The item's interval comes from its confirmation judged now, its impact from its undo
            // judged again now: the two list the same revert entries.
            const both = await s.store.write((tx) => revertEntriesOf(tx, item));
            // The undo refused when judged again while the confirmation lists entries.
            const undoRefused = both !== undefined && both.undo === null && both.confirm !== null;
            if (both?.undo != null && both.confirm != null) {
              const key = (xs: readonly unknown[]) => J(xs.map((x) => J(x)).sort());
              if (key(both.undo) !== key(both.confirm))
                fault(
                  "the undo judged again and the confirmation list other revert entries",
                  `\nUNDO ${J(both.undo)}\nCONFIRM ${J(both.confirm)}`,
                );
              else reach("entries the same");
            } else
              reach(
                `entries not compared: ${both === undefined ? "no item" : both.undo === null ? "undo refused" : "confirmation refused"}`,
              );
            const beforeCells = await cellsOf(table, id as string);
            const c = await decide({ id: item, decision: "confirm", item_ver: d.item_ver });
            log.push(
              `#${c.write?.seq ?? "-"} THIRD confirm ${item} spans ${J(spans)} impact ${J([...listed])} -> ${c.thrown ?? c.refused ?? c.status}`,
            );
            open.delete(item);
            if (c.thrown !== undefined) return fault(`a confirmation threw: ${c.thrown}`);
            if (c.refused !== undefined) {
              if (c.refused === "internal")
                fault(`a confirmation was refused as internal: ${J(c)}`);
              else reach(`confirmation refused: ${c.refused}`);
              return;
            }
            reach("confirmed");
            confirmed.set(c.write?.seq as number, at.proposal);
            // An undo refused when judged again (its impact empty) while the confirmation writes
            // back is not a fault in itself: a write-back over a row revoked before and after
            // changes nothing a reader sees. What would be is checked below: the impact names the
            // writes whose result changes, whatever the undo judged again says.
            if (undoRefused) reach("undo refused, confirmation writes back");
            if (state && at.spans !== undefined && J(merged(at.spans)) !== J(spans))
              reach("confirmed after a refresh changed the spans");
            // What the confirmation wrote: every part of every field and existence.
            if (state) {
              const parts = Object.values((c.write?.ops?.[0]?.fields ?? {}) as Record<string, Any>)
                .flatMap((g) => (Array.isArray(g) ? g : [g]) as Any[])
                .filter((p) => p.result !== "noop" && p.valid !== undefined)
                .map((p) => ivOf(p.valid));
              if (J(merged(parts)) !== J(spans))
                fault(
                  "the confirmation wrote other than the item's spans",
                  `\nSPANS ${J(spans)}\nWROTE ${J(merged(parts))}\nWRITE ${J(c.write)}`,
                );
            }
            // The later writes whose result a reader sees changes are exactly those the impact
            // names, each with the fields whose result changes (04-write-and-read «撤回某次写入
            // （undo）»): worked out here from the cells before and after the confirmation.
            const afterCells = await cellsOf(table, id as string);
            const want = changedWrites(
              state,
              beforeCells,
              afterCells,
              at.undone,
              // The confirmation of the undo being undone is part of that operation, not a later
              // write; any other confirmation is a write of its own.
              (op) => (confirmed.get(op) === at.undone ? at.undone : op),
            );
            const got = new Map<number, string[]>(
              ((d.impact?.reverted ?? []) as Any[]).map((x) => [
                x.seq as number,
                [...(x.fields as string[])].sort(),
              ]),
            );
            const sorted = (m: Map<number, string[]>) => J([...m].sort(([a], [b]) => a - b));
            if (sorted(want) !== sorted(got))
              fault(
                "the impact names other writes than those whose result changes",
                `\nWANT ${sorted(want)}\nGOT ${sorted(got)}\nBEFORE ${J(beforeCells)}\nAFTER ${J(afterCells)}`,
              );
            else if ([...want.values()].some((xs) => xs.some((x) => x !== "*")))
              reach("a later field write named and gone");
          };

          if (h < fixed.length) {
            const steps = fixed[h] as readonly Step[];
            /** The items each step opened. */
            const opened: string[][] = [];
            const ref = (v: unknown, of: (n: number) => unknown) =>
              typeof v === "string" && v.startsWith("$") ? of(Number(v.slice(1))) : v;
            for (const step of steps) {
              if ("previous" in step) {
                const ids = opened[step.previous] ?? [];
                if (ids.length === 0) reach("fixed: no item for take_previous");
                for (const item of ids) await previousOnCopy(item);
                opened.push([]);
                continue;
              }
              if ("confirm" in step) {
                const item = opened[step.confirm]?.[0];
                if (item === undefined) reach("fixed: no open item to confirm");
                else await confirm(item);
                opened.push([]);
                continue;
              }
              const op = { ...step.op };
              if (op["ver"] !== undefined) op["ver"] = ref(op["ver"], (n) => vers[n]);
              const rv = op["revert"] as { undo: unknown } | undefined;
              if (rv !== undefined) op["revert"] = { ...rv, undo: ref(rv.undo, (n) => seqs[n]) };
              const res = await write(op, step.actor);
              opened.push(((res.pending ?? []) as Any[]).map((q) => q.id as string));
            }
            // Rebuilt from the log, the items, their flags and the tables are the live ones.
            const live = await itemsAndTables(s.store, table);
            const again = await replayed(table);
            if (J(again) !== J(live))
              fault(
                "the log replayed gives other items, flags or tables",
                `\nLIVE ${J(live)}\nREPLAYED ${J(again)}`,
              );
            else reach("replayed the same");
            continue;
          }

          const [f0, t0] = pick(IVS);
          await write({ intent: "insert", ...span(f0, t0), set: { b: `b${h}-0` } }, USER);
          if (id === undefined) continue;
          const steps = 3 + Math.floor(r() * 6);
          for (let k = 1; k <= steps; k++) {
            if (open.size > 0 && r() < 0.3) {
              await confirm(pick([...open.keys()]));
              continue;
            }
            const actor = r() < 0.5 ? OTHER : USER;
            const ver = r() < 0.25 ? pick(vers) : vers.at(-1);
            const [vf, vt] = pick(IVS);
            const x = r();
            const op =
              x < 0.35
                ? {
                    intent: pick(["update", "correct"]),
                    ver,
                    ...span(vf, vt),
                    set: r() < 0.5 ? { b: `b${h}-${k}` } : { c: `c${h}-${k}` },
                  }
                : x < 0.55
                  ? r() < 0.3 || !state
                    ? { intent: "revoke", ver }
                    : { intent: "revoke", ver, ...span(vf, vt) }
                  : {
                      ...(state && r() < 0.3 ? { intent: pick(["update", "correct"]) } : {}),
                      revert: { undo: pick(seqs), ...(r() < 0.3 ? { include_later: true } : {}) },
                      ver,
                      ...(r() < 0.2 ? { acknowledge: ["overwrite"] } : {}),
                    };
            await write(op, actor);
          }
          // Whatever is still open is confirmed at the end.
          for (const item of [...open.keys()]) await confirm(item);
        }
        console.log(
          `${table}: seed ${SEED}, ${RUNS} histories, ${J(reached)}, ${faults.length} faults`,
        );
        expect(faults.slice(0, 3)).toEqual([]);
        expect(reached["confirmed"] ?? 0).toBeGreaterThan(0);
        if (table === "entities") {
          // The fixed histories: a widened and a narrowed item confirmed, an emptied one closed
          // (so it has no open item when its confirmation comes).
          expect(
            reached["confirmed after a refresh changed the spans"] ?? 0,
          ).toBeGreaterThanOrEqual(2);
          expect(reached["closed: nothing to revert"] ?? 0).toBeGreaterThanOrEqual(1);
          // The three fixed take_previous histories, every run.
          expect(reached["take_previous on a copy"] ?? 0).toBeGreaterThanOrEqual(3);
          expect(reached["take_previous: writes named"] ?? 0).toBeGreaterThanOrEqual(2);
          // HIDDEN: a later write of another field, hidden as the stretch loses its value, named.
          expect(reached["a later field write named and gone"] ?? 0).toBeGreaterThanOrEqual(1);
        }
        expect(reached["fixed: no open item to confirm"] ?? 0).toBeLessThanOrEqual(
          table === "entities" ? 1 : 0,
        );
        // Every fixed history was replayed from the log.
        expect(reached["replayed the same"] ?? 0).toBe(fixed.length);
      },
      T,
    );
  },
);
