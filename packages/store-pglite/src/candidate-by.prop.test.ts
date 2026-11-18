// Who gave what a candidate met (04-contract-types §5.1 `FieldResult.by`, §4.8
// `ConflictDetail.effective`) over random histories on PGlite: for every candidate of every op of
// the last request, the receipt's `by` and `effective`, the item's details and the version table
// agree, and a replay gives the first receipt again. The version table's side is worked out here
// from the cells read with SQL, by the spec's sentences, not by the kernel's function:
// - a stretch the unit's fields have cells on: the write the latest of those cells comes from, with
//   the cells' values;
// - a stretch without a value (05-time «无值区间»: no field contribution in effect there, a clear
//   counting as one; in the cells, no field cell not marked `no_value`): the latest of the revoke
//   whose existence cell is there and the operations that gave `no_value` cells (an undo's
//   write-back). On a
//   table with required fields this is also checked against the older reading (a required field
//   without a valued cell), stretch by stretch: the two must agree there;
// - any other stretch (never written there) gives none, and a part with none has no `by`.
// The receipt's `effective` is the target field's value on the earliest stretch its `by` gave
// (null on existence). The cells are those the request left (01-objects «不过期»: the receipt's
// `effective`, `current_ver` and the item's contents are the request's end too).
// Histories: an insert, then writes (some clearing a field), interval and whole revokes, undos
// (some including later writes, some with an intent), decisions on conflict items, by two
// principals; the last request writes from an older version, sometimes with a second op on the same
// row. Every write along the way is checked too: a part on a state table has its interval, and
// nothing is refused as internal or throws. Tables: a
// timeless one, state ones with one and two required fields, one with none, one by the instant.
// `PROP_SEED` fixes the seed, `PROP_RUNS` the histories per table.

import {
  appendOperation,
  applyEvents,
  createOpsContext,
  createTenant,
  eventsOf,
  pending,
  readBufferOf,
} from "@fluxvita/saveslot-kernel";
import {
  COMPILED_V1,
  createSlotEvents,
  resolveInTx,
  writeInTx,
} from "@fluxvita/saveslot-kernel/testing";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 600_000;
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
const OTHER = `ci_${"2".repeat(26)}`;
const SEED =
  process.env["PROP_SEED"] === undefined
    ? Date.now() % 1_000_000
    : Number(process.env["PROP_SEED"]);
const RUNS = Number(process.env["PROP_RUNS"] ?? 100);

const text = (id: string, name: string, required?: true) => ({
  id,
  name,
  type: "text",
  description: name,
  ...(required ? { required } : {}),
});
const TABLES = {
  rows: { id: "t1", kind: "none", fields: [text("f2", "b", true), text("f3", "c")] },
  entities: { id: "t2", kind: "state", fields: [text("f2", "b", true), text("f3", "c")] },
  pairs: {
    id: "t3",
    kind: "state",
    fields: [text("f2", "b", true), text("f3", "c"), text("f4", "d", true)],
  },
  loose: { id: "t4", kind: "state", fields: [text("f2", "b"), text("f3", "c")] },
  moments: {
    id: "t5",
    kind: "state",
    instant: true,
    fields: [text("f2", "b", true), text("f3", "c")],
  },
} as const;
type TableName = keyof typeof TABLES;
const COMPILED = {
  ...COMPILED_V1,
  tables: Object.entries(TABLES).map(([name, t]) => ({
    id: t.id,
    name,
    kind: "base",
    description: name,
    time:
      t.kind === "state"
        ? { type: "state", granularity: "instant" in t ? "instant" : "date" }
        : { type: "none" },
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

async function send(params: unknown, actor: string): Promise<Any> {
  try {
    return await s.store.write((tx) =>
      writeInTx(tx, {
        actor: actor as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
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

async function decide(params: unknown, actor: string): Promise<Any> {
  try {
    return await s.store.write((tx) =>
      resolveInTx(tx, {
        actor: actor as never,
        task: null,
        now: now(),
        windows: { requestKey: 600_000, idempotencyKey: 86_400_000 },
        visibility: { kind: "all" },
        params,
        newId,
        reads: readBufferOf(s.store),
      }),
    );
  } catch (e) {
    const x = e as { code?: string; message?: string };
    return x.code === undefined ? { thrown: String(x.message ?? e) } : { refused: x.code };
  }
}

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

async function fresh() {
  await s.reset();
  readBufferOf(s.store).take();
  await createTenant(
    s.store,
    createOpsContext({ ...(ctx() as object), now: "2026-11-05T00:00:00.000Z" } as never),
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

/** A cell as the version table holds it, read with SQL: who gave it and the value it holds. */
type Cell = {
  field: string;
  vf: string | null;
  vt: string | null;
  revoked: boolean;
  /** `__ver.no_value`: a state table's field cell saying the entity has no value there. */
  noValue: boolean;
  op: number | null;
  value: string | null;
};

const INSTANT = `'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'`;

/** The row's cells as the request left them (the latest operation's, still open). */
async function cellsOf(table: TableName, id: string): Promise<Cell[]> {
  const t = TABLES[table];
  const time =
    t.kind !== "state"
      ? "NULL AS vf, NULL AS vt"
      : "instant" in t
        ? `to_char(v.valid_from, ${INSTANT}) AS vf, to_char(v.valid_to, ${INSTANT}) AS vt`
        : "v.valid_from::text AS vf, v.valid_to::text AS vt";
  const r = await s.store.read((tx) =>
    tx.query<Record<string, unknown>>(
      `SELECT v.*, ${time}, (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS src_op
       FROM "t_${t.id}_v1__ver" v WHERE v.row_id = $1 AND v.rec_to IS NULL`,
      [id],
    ),
  );
  return r.rows.map((x) => {
    const field = x["field_id"] as string;
    const v = field === "existence" ? null : x[`f_${field}`];
    return {
      field,
      vf: x["vf"] as string | null,
      vt: x["vt"] as string | null,
      revoked: x["revoked"] === true,
      noValue: x["no_value"] === true,
      op: x["src_op"] == null ? null : Number(x["src_op"]),
      value: v == null ? null : String(v),
    };
  });
}

/** A stretch of the part as the cells say it: who gave its state, and the unit's values (null: none). */
type Stretch = {
  from: string | null;
  to: string | null;
  op: number | null;
  values: Record<string, string | null> | null;
};

/** The spec's rule over the cells, stretch by stretch over the part (one stretch off the time line). */
function stretchesOf(
  table: TableName,
  cells: readonly Cell[],
  unit: readonly string[],
  from: string | null,
  to: string | null,
  disagree: (what: string) => void,
): Stretch[] {
  const t = TABLES[table];
  const all = t.fields.map((f) => f.id as string);
  const fields = unit.includes("existence") ? all : unit;
  const required = t.fields.filter((f) => "required" in f).map((f) => f.id as string);
  const latest = (cs: readonly Cell[]) =>
    cs.reduce<number | null>(
      (m, c) => (c.op !== null && (m === null || c.op > m) ? c.op : m),
      null,
    );
  const nameOf = (f: string) => t.fields.find((x) => x.id === f)?.name as string;
  const valuesOf = (here: readonly Cell[]) =>
    Object.fromEntries(
      fields.map((f) => [nameOf(f), here.find((c) => c.field === f)?.value ?? null]),
    );
  const revokeOf = (cs: readonly Cell[]) => cs.find((c) => c.field === "existence" && c.revoked);
  if (t.kind !== "state") {
    const revoke = revokeOf(cells);
    if (revoke !== undefined) return [{ from, to, op: revoke.op, values: null }];
    const op = latest(
      unit.includes("existence") ? cells : cells.filter((c) => fields.includes(c.field)),
    );
    return [{ from, to, op, values: cells.length === 0 ? null : valuesOf(cells) }];
  }
  const points = new Set<string>();
  for (const c of cells)
    for (const p of [c.vf, c.vt])
      if (p !== null && (from === null || p > from) && (to === null || p < to)) points.add(p);
  const cuts = [from, ...[...points].sort(), to];
  const out: Stretch[] = [];
  for (let i = 0; i + 1 < cuts.length; i++) {
    const a = cuts[i] ?? null;
    const z = cuts[i + 1] ?? null;
    const here = cells.filter(
      (c) =>
        (c.vf === null || (a !== null && c.vf <= a)) &&
        (c.vt === null || (z !== null && z <= c.vt)),
    );
    const revoke = revokeOf(here);
    if (revoke !== undefined) {
      // The later of the revoke and a no_value cell beside it: what left it without a value last.
      out.push({
        from: a,
        to: z,
        op: latest([revoke, ...here.filter((c) => c.noValue)]),
        values: null,
      });
      continue;
    }
    // Has a value: a field cell not marked no_value (a cleared or never written field's cell
    // where the entity has a value is one); none: only no_value cells, the giver the latest.
    const none = !here.some((c) => c.field !== "existence" && !c.noValue);
    const giver = latest(here.filter((c) => c.noValue));
    if (required.length > 0) {
      // A required field cannot be cleared: here the older reading must give the same.
      const empty = required.filter((f) => !here.some((c) => c.field === f && c.value !== null));
      const old = empty.length > 0;
      const oldGiver = latest(here.filter((c) => empty.includes(c.field)));
      if (old !== none || (none && oldGiver !== giver)) {
        disagree(
          `\n[${a}, ${z}): no_value says ${none ? `none by ${giver}` : "a value"}, required fields ${old ? `none by ${oldGiver}` : "a value"}; cells ${J(here)}`,
        );
      }
    }
    if (none) {
      out.push({ from: a, to: z, op: giver, values: null });
      continue;
    }
    // The row has a value here: its unit's values, an unwritten field among them as null (no
    // giver when none of the unit's fields was written here).
    const op = latest(here.filter((c) => fields.includes(c.field)));
    out.push({ from: a, to: z, op, values: here.length === 0 ? null : valuesOf(here) });
  }
  return out;
}

const topOf = (xs: readonly { op: number | null }[]) =>
  xs.reduce<number | null>((m, x) => (x.op !== null && (m === null || x.op > m) ? x.op : m), null);
/** Values with keys in order, null fields dropped: the details may leave out a field without one. */
const norm = (v: Record<string, unknown> | null | undefined) =>
  v == null
    ? null
    : J(
        Object.keys(v)
          .sort()
          .filter((k) => v[k] !== null && v[k] !== undefined)
          .map((k) => [k, v[k]]),
      );

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

beforeAll(async () => {
  s = await openReusable("saveslot-candidate-by-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

describe.each(Object.keys(TABLES) as TableName[])(
  "%s: the receipt's by and effective, the details and the version table agree",
  (table) => {
    it(
      `on every candidate of random histories (seed ${SEED})`,
      async () => {
        const r = rng(SEED + Object.keys(TABLES).indexOf(table) * 7919);
        const pick = <X>(xs: readonly X[]): X => xs[Math.floor(r() * xs.length)] as X;
        const t = TABLES[table];
        const state = t.kind === "state";
        const instant = "instant" in t;
        const key = state ? "entity" : "row";
        const at = (d: string) => (instant && d !== "open" ? `${d}T08:00:00.000Z` : d);
        const span = (vf: string, vt: string) =>
          state ? { valid_from: at(vf), valid_to: at(vt) } : {};
        const names = t.fields.map((f) => f.name as string);
        const required = t.fields.filter((f) => "required" in f).map((f) => f.name as string);
        const optional = names.filter((n) => !required.includes(n));
        const faults: string[] = [];
        /** Candidates on items whose first span is open at the start (09 §5.8 `scope_valid`). */
        let openStart = 0;
        let candidates = 0;
        /** Candidates of the last request's second op. */
        let later = 0;
        let ops = 0;
        for (let h = 0; h < RUNS; h++) {
          if (h % 25 === 0) await fresh();
          const log: string[] = [];
          const fault = (what: string, more = "") =>
            faults.push(`${what} [history ${h}]\n${log.join("\n")}${more}`);
          // Distinct content per history and step: no request is a replay of another.
          const filled = (k: number) =>
            Object.fromEntries(
              (required.length > 0 ? required : ["b"]).map((n) => [n, `${n}${h}-${k}`]),
            );
          const [f0, t0] = pick(IVS);
          const ins = {
            intent: "insert",
            table,
            ...span(f0, t0),
            set: r() < 0.5 ? filled(0) : { ...filled(0), c: `c${h}-0` },
          };
          const e = await send({ sv: 1, ops: [ins] }, USER);
          log.push(`#${e.seq} USER ${J(ins)}`);
          if (e.ops === undefined) {
            fault(`the insert was not saved: ${J(e)}`);
            continue;
          }
          const id = (e.ops[0].target.entity ?? e.ops[0].target.row) as string;
          const vers: string[] = [e.ops[0].ver];
          const seqs: number[] = [e.seq];
          /** Who made each operation, by its number. */
          const madeBy = new Map<number, string>([[e.seq, USER]]);
          let cur = e.ops[0].ver as string;
          /** A state table's parts carry their interval (but a noop's). */
          const partsHaveIntervals = (res: Any, who: string) => {
            for (const o of res?.ops ?? [])
              for (const [name, given] of Object.entries((o.fields ?? {}) as Record<string, Any>))
                for (const q of (Array.isArray(given) ? given : [given]) as Any[])
                  if (state && q.result !== "noop" && q.valid === undefined)
                    fault(`${who} gives a part of ${name} without its interval`);
          };
          const steps = 2 + Math.floor(r() * 6);
          for (let k = 1; k <= steps; k++) {
            const actor = r() < 0.6 ? OTHER : USER;
            const ver = r() < 0.12 ? pick(vers) : cur;
            const x = r();
            const [vf, vt] = pick(IVS);
            const undone = pick(seqs);
            const op =
              x < 0.4
                ? {
                    intent: "update",
                    ver,
                    ...span(vf, vt),
                    set:
                      r() < 0.4
                        ? filled(k)
                        : r() < 0.8
                          ? { c: `c${h}-${k}` }
                          : { ...filled(k), c: `c${h}-${k}` },
                  }
                : x < 0.47 && optional.length > 0
                  ? { intent: "update", ver, ...span(vf, vt), set: { [pick(optional)]: null } }
                  : x < 0.65
                    ? r() < 0.25 || !state
                      ? { intent: "revoke", ver }
                      : { intent: "revoke", ver, ...span(vf, vt) }
                    : {
                        ...(state && r() < 0.3 ? { intent: pick(["update", "correct"]) } : {}),
                        revert: { undo: undone, ...(r() < 0.35 ? { include_later: true } : {}) },
                        ver,
                        acknowledge: ["overwrite"],
                      };
            const res = await send({ sv: 1, ops: [{ table, [key]: id, ...op }] }, actor);
            log.push(
              `#${res.seq ?? "-"} ${actor === USER ? "USER" : "OTHER"} ${J(op)} -> ${res.thrown ?? res.refused ?? res.status}`,
            );
            ops++;
            if (res.thrown !== undefined) fault(`a write threw: ${res.thrown}`);
            else if (res.refused === "internal")
              fault(`a write was refused as internal: ${J(res)}`);
            partsHaveIntervals(res, "a write");
            if (res.ops?.[0]?.ver) {
              cur = res.ops[0].ver;
              if (!vers.includes(cur)) vers.push(cur);
            }
            if (res.seq !== undefined && res.ops !== undefined) {
              seqs.push(res.seq);
              madeBy.set(res.seq, actor);
            }
            const item = (res.pending ?? []).find((q: Any) => q.type === "conflict");
            if (item !== undefined && r() < 0.5) {
              const decision = pick(["take_candidate", "take_previous", "keep_effective"]);
              const decider = r() < 0.5 ? OTHER : USER;
              const d = await decide(
                { id: item.id, decision, ...(item.item_ver ? { item_ver: item.item_ver } : {}) },
                decider,
              );
              log.push(
                `#${d.write?.seq ?? "-"} RESOLVE ${decision} -> ${d.thrown ?? d.refused ?? d.status}`,
              );
              if (d.thrown !== undefined) fault(`a decision threw: ${d.thrown}`);
              if (d.refused === "internal") fault("a decision was refused as internal");
              partsHaveIntervals(d.write, "a decision's write");
              for (const o of d.write?.ops ?? []) {
                if (o.ver) {
                  cur = o.ver;
                  if (!vers.includes(cur)) vers.push(cur);
                }
              }
              if (d.write?.seq !== undefined) {
                seqs.push(d.write.seq);
                madeBy.set(d.write.seq, decider);
              }
            }
          }
          // The last request: from an older version, sometimes with a second op on the same row.
          const older = vers.filter((v) => v !== cur);
          const ver = older.length > 0 ? pick(older) : cur;
          const [vf, vt] = pick(IVS);
          const y = r();
          const last =
            y < 0.12
              ? r() < 0.5 || !state
                ? { intent: "revoke", ver }
                : { intent: "revoke", ver, ...span(vf, vt) }
              : {
                  intent: "update",
                  ver,
                  ...span(vf, vt),
                  set:
                    y < 0.55
                      ? { c: `zz${h}` }
                      : y < 0.85
                        ? { b: `zz${h}` }
                        : { b: `zz${h}`, c: `zz${h}` },
                };
          const [wf, wt] = pick(IVS);
          const second =
            r() < 0.3
              ? [
                  {
                    table,
                    [key]: id,
                    intent: "update",
                    // Half of them from an older version too: their parts can be candidates.
                    ver: r() < 0.5 ? pick(vers) : cur,
                    ...span(wf, wt),
                    set: { c: `yy${h}` },
                  },
                ]
              : [];
          const actor = r() < 0.5 ? OTHER : USER;
          const params = {
            sv: 1,
            ops: [{ table, [key]: id, ...last }, ...second],
            idempotency_key: `k-${SEED}-${table}-${h}`,
          };
          const z = await send(params, actor);
          log.push(
            `#${z.seq ?? "-"} LAST ${J(params.ops)} -> ${z.thrown ?? z.refused ?? z.status}`,
          );
          if (z.thrown !== undefined) {
            fault(`the last write threw: ${z.thrown}`);
            continue;
          }
          if (z.seq !== undefined) madeBy.set(z.seq, actor);
          if (z.refused !== undefined) {
            if (z.refused === "internal") fault("the last write was refused as internal");
            continue;
          }
          partsHaveIntervals(z, "the last write");
          const cells = await cellsOf(table, id);
          const again = await send(params, actor);
          if (J(again.ops) !== J(z.ops))
            fault("the replay's ops differ", `\nFIRST ${J(z.ops)}\nAGAIN ${J(again.ops)}`);
          for (const [i, o] of (z.ops as Any[]).entries()) {
            for (const [name, given] of Object.entries(o.fields as Record<string, Any>)) {
              for (const p of (Array.isArray(given) ? given : [given]) as Any[]) {
                if (p.result !== "candidate") continue;
                candidates++;
                if (i > 0) later++;
                const d = (await pending(s.store, ctx(), { id: p.item })) as Any;
                const first = d.target.spans?.[0];
                if (first !== undefined && first.valid_from === null && first.valid_to !== null)
                  openStart++;
                const unit = (d.target.unit as string[]).map((u) =>
                  u === "*" ? "existence" : (t.fields.find((f) => f.name === u)?.id as string),
                );
                const from = state ? (p.valid.valid_from as string | null) : null;
                const to = state ? (p.valid.valid_to as string | null) : null;
                const disagree = (m: string) =>
                  fault("no_value and the required fields read a stretch differently", m);
                const want = stretchesOf(table, cells, unit, from, to, disagree);
                const top = topOf(want);
                const more = `\nOP ${i} PART ${name} ${J(p)}\nDETAIL ${J(d.effective)} target ${J(d.target)}\nCELLS ${J(cells)}\nEXPECTED ${J(want)}`;
                if ((p.by?.seq ?? null) !== top)
                  fault("the receipt's by is not the version table's", more);
                // effective: the target field's value on the earliest stretch `by` gave; none on
                // existence.
                const effective =
                  name === "*" || top === null
                    ? null
                    : (want.find((w) => w.op === top)?.values?.[name] ?? null);
                if ((p.effective ?? null) !== effective)
                  fault("the receipt's effective is not the value its by gave", more);
                if (!state) {
                  if ((d.effective.seq ?? null) !== top)
                    fault("the details' seq is not the version table's", more);
                  const w = want[0];
                  if (norm(d.effective.values) !== norm(w?.values))
                    fault("the details' values are not the version table's", more);
                  if (d.effective.exists !== (w?.values != null))
                    fault("the details' exists is not the version table's", more);
                  if (top !== null && d.effective.actor?.id !== madeBy.get(top))
                    fault("the details' actor did not make that operation", more);
                } else {
                  // Stretch by stretch: the detail span covering it (spans can be wider, joined).
                  const spans = (d.effective.spans ?? []) as Any[];
                  for (const w of want) {
                    const sp = spans.find(
                      (x) =>
                        (x.valid_from === null || (w.from !== null && x.valid_from <= w.from)) &&
                        (x.valid_to === null || (w.to !== null && w.to <= x.valid_to)),
                    );
                    const at = `\nSTRETCH ${J(w)}`;
                    if (sp === undefined) {
                      fault("no span of the details covers a stretch of the part", more + at);
                      continue;
                    }
                    if ((sp.seq ?? null) !== w.op)
                      fault("a span's seq is not the version table's", more + at);
                    if (norm(sp.values) !== norm(w.values))
                      fault("a span's values are not the version table's", more + at);
                  }
                  // Over the item's spans: the top seq and its actor, and whether any stretch has
                  // a value (both ways).
                  const overItem = ((d.target.spans ?? []) as Any[]).flatMap((x) =>
                    stretchesOf(table, cells, unit, x.valid_from, x.valid_to, disagree),
                  );
                  const itemTop = topOf(overItem);
                  if ((d.effective.seq ?? null) !== itemTop)
                    fault("the details' top seq is not the version table's", more);
                  if (itemTop !== null && d.effective.actor?.id !== madeBy.get(itemTop))
                    fault("the details' top actor did not make that operation", more);
                  if (d.effective.exists !== overItem.some((w) => w.values !== null))
                    fault("the details' exists is not the version table's", more);
                }
                if (
                  p.by !== undefined &&
                  d.effective.seq === p.by.seq &&
                  J(d.effective.actor) !== J(p.by.actor)
                )
                  fault("the details name another actor for the same operation", more);
              }
            }
          }
        }
        console.log(
          `${table}: seed ${SEED}, ${RUNS} histories, ${ops} writes, ${candidates} candidates (${later} of a second op), ${openStart} on items open at the start, ${faults.length} faults`,
        );
        expect(faults.slice(0, 3)).toEqual([]);
        expect(candidates).toBeGreaterThan(RUNS / 4);
      },
      T,
    );
  },
);
