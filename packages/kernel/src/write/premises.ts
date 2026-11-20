// An op's premises at the write (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md «写入的
// 前提»; 04-contract §5; 09-event-format §5.7 the premise blocks): «判定顺序» step 5, the checks on
// the current state, and what the head records of each declaration.
//
// - The target: its table's row or entity (by ID or by key), there and visible (`not_found`), not
//   the op's own (`premise_self`), not one of another premise of the op once resolved
//   (`premise_duplicate_target`: one item has one declaration in force for one target), pointed at
//   by at most the limit of declarations in force once this one is recorded (`too_large`,
//   `premise_fan_in`): those it supersedes, and those this request's earlier ops superseded or
//   cleared, not counted.
// - The version seen: given (a version of the target, `not_this_target` otherwise), or the same
//   fallback as an op's (`premise_ver_fallback`; `read_first` without one).
// - The state when written: by the criterion, `premiseDelta(seen, now, scope)` empty or not, "now"
//   being the target before this request (a change by an op of this request is the detection's).
//   Changed: `since` is the first operation of the last stretch of versions all differing from the
//   one seen, so that a late declaration reads as one made at the version seen and judged op by op
//   since; its reason is that operation's (02-integrity «什么算前提变了»). A target revoked: changed,
//   reason `revoke`.
// - The range: `whole` on a row; `given`; `row_time`, the depending row's own business time (the
//   op's interval, or its time field), aligned to the target's granularity; else `from_now`.
// - The cover beyond the op's own items (`premise_covers`): the row's items in effect at the version
//   the op saw and still in effect after it, only when every field of the op took effect; a
//   clearing covers them whatever became of its fields.

import type {
  BizPoint,
  CompiledBaseTable,
  DateStr,
  EntityId,
  FieldId,
  Instant,
  OpNumber,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { type PremiseScope, premiseDelta, stateAt, type TargetState } from "../delta/index.ts";
import type { ItemRef, Judgement, Limit, RowState } from "../judge/index.ts";
import { valueToken } from "../judge/state.ts";
import { decodeColumns, type NormalizedField, type NormalizedPremise } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { dateInZone, type Interval, type IntervalSet, nextDay, startOfDay } from "../time/index.ts";
import { entitiesByKey } from "./keys.ts";
import { rowTable, rowVersions } from "./reads.ts";

/** How many declarations in force may point at one target (02-integrity «上限»). */
let fanInLimit = 1000;
/** Tests only: a small limit, to reach it. */
export function premiseFanInLimitForTests(n: number): void {
  fanInLimit = n;
}

export type PremiseRange = "whole" | "from_now" | "row_time" | "given";

/** A premise as the head records it (09 §5.7 `ops/<i>/premises/<j>`, `premise_valid/<j>`). */
export interface ResolvedPremise {
  readonly table: TableId;
  readonly target: { readonly row: RowId } | { readonly entity: EntityId };
  readonly fields?: readonly FieldId[];
  readonly ver: {
    readonly op: OpNumber;
    readonly restore_count: number;
    readonly basis: "explicit" | "fallback";
  };
  readonly range: PremiseRange;
  readonly valid?:
    | { readonly at: BizPoint; readonly deps?: readonly ItemRef[] }
    | {
        readonly during: { readonly from: BizPoint; readonly to?: BizPoint };
        readonly deps?: readonly ItemRef[];
      };
  readonly state: "current" | "changed";
  readonly reason?: string;
  readonly since?: OpNumber;
}

/** A refusal at step 5, as the pipeline throws it. */
export interface PremiseRefusal {
  readonly code:
    | "not_found"
    | "invalid_argument"
    | "too_large"
    | "not_this_target"
    | "not_in_this_version";
  readonly reason?: string;
  readonly param: string;
  readonly detail?: Readonly<Record<string, unknown>>;
}

/** The fallback a premise without `ver` takes: the pipeline's (04-contract §2 «兜底»). */
export type VerFallback = (
  target: string,
  verTable: string,
  premise: number,
) => Promise<
  | { readonly found: number; readonly restoreCount?: number; readonly origin: unknown }
  | { readonly refused: unknown }
>;

export interface PremiseContext {
  readonly op: OpNumber;
  /** The slot's name, as a refusal names a table. */
  readonly slotName: string;
  /**
   * The declarations in force on a target once this op's premise on it is recorded, besides it
   * (`fanInAfter`, with what this request recorded before it): counted toward the limit.
   */
  readonly fanIn: (target: string) => Promise<number>;
  /** Whether an earlier op of this request created the entity a key names (with `as`: not yet). */
  readonly createdHere: (table: TableId, key: Readonly<Record<FieldId, unknown>>) => boolean;
  readonly index: number;
  readonly tableOf: (id: TableId) => CompiledBaseTable | undefined;
  /** The op's own target. */
  readonly self: string;
  readonly restore: number;
  readonly zone: string;
  /** The entry time and day (`ctx.now`, `ctx.today`). */
  readonly now: Instant;
  readonly today: DateStr;
  readonly fallback: VerFallback;
}

const valuesOf = (key: Readonly<Record<FieldId, NormalizedField>>) =>
  Object.fromEntries(Object.entries(key).map(([f, x]) => [f, x.value])) as never;

const verTableOf = (t: CompiledBaseTable) => `${t.physical.table}__ver`;

/** The target's ID, or a refusal: its table's row or entity, by ID or by key. */
async function targetOf(
  tx: ReadTx,
  p: NormalizedPremise,
  t: CompiledBaseTable,
  at: string,
): Promise<string | PremiseRefusal> {
  let id: string | undefined;
  if (p.target.kind === "entity_key") {
    const held = await entitiesByKey(tx, t, valuesOf(p.target.key));
    id = held[0];
  } else id = p.target.kind === "row" ? p.target.row : p.target.entity;
  // Not there, or a row of another table: the same answer (04-contract «不存在与不可见报同一个错误»).
  if (id === undefined || (await rowTable(tx, id)) !== t.id)
    return { code: "not_found", reason: t.time.type === "state" ? "entity" : "row", param: at };
  return id;
}

/**
 * The version each premise of the request rests on, for its request key (04-contract §14 «例外一»):
 * given, or what the fallback gives now. One that cannot be resolved yet (no such target, no
 * fallback) is left out: the request is refused at step 5 all the same. In request order.
 */
export async function premiseVersForKey(
  tx: ReadTx,
  ops: readonly { readonly index: number; readonly premises?: readonly NormalizedPremise[] }[],
  tableOf: (id: TableId) => CompiledBaseTable | undefined,
  fallback: (
    target: string,
    verTable: string,
  ) => Promise<{ found: number; restoreCount?: number } | undefined>,
  restore: number,
): Promise<string[]> {
  const out: string[] = [];
  for (const o of ops) {
    for (const [j, p] of (o.premises ?? []).entries()) {
      if (p.ver !== undefined) {
        out.push(`${o.index}/${j}:v${p.ver.op}.${p.ver.restoreCount}`);
        continue;
      }
      const t = tableOf(p.table);
      if (t === undefined) continue;
      const id = await targetOf(tx, p, t, "");
      if (typeof id !== "string") continue;
      const f = await fallback(id, verTableOf(t));
      if (f !== undefined) out.push(`${o.index}/${j}:v${f.found}.${f.restoreCount ?? restore}`);
    }
  }
  return out;
}

/** An item as an edge keys it: event, field ID or `existence`, k. */
export const itemKey = (x: ItemRef): string => `${x.event}/${x.target}/${x.k}`;

/** What this request's earlier ops recorded, as apply will keep it (`premise_edges`), in op order. */
export interface RecordedHere {
  /** Each declaration's edges: the item, the target, the op index and declaration. */
  readonly edges: { readonly item: string; readonly target: string; i: number; j: number }[];
  /** Each clearing's entries: the item and the op index. */
  readonly clears: { readonly item: string; readonly i: number }[];
}

/**
 * The declarations in force on `target` once declaration `mine` of op `mine.i` (request operation
 * `op`) is recorded, besides it: the edges as apply keeps them (apply/premises.ts: for an item and
 * a target, the latest declaration covering it; a declaration before a clearing entry on the item
 * void there), the stored ones, then this request's earlier ops', then `mine` on the items it
 * covers. A declaration counts while some item still has it. What it supersedes, and what an
 * earlier op of the request superseded or cleared, does not count; a declaration whose depending
 * row is revoked, or whose write has not taken effect, still does (02-integrity «上限»).
 */
export async function fanInAfter(
  tx: ReadTx,
  op: OpNumber,
  target: string,
  here: RecordedHere,
  mine: { readonly i: number; readonly items: readonly string[] },
): Promise<number> {
  const r = await tx.query<{
    item_event: unknown;
    field_id: string;
    k: unknown;
    decl_op: unknown;
    decl_op_index: unknown;
    decl_index: unknown;
    c_op: unknown;
    c_index: unknown;
  }>(
    `SELECT e.item_event, e.field_id, e.k, e.decl_op, e.decl_op_index, e.decl_index,
       c.decl_op AS c_op, c.decl_op_index AS c_index
     FROM premise_edges e
     LEFT JOIN premise_edges c ON c.target = '*' AND c.item_event = e.item_event
       AND c.field_id = e.field_id AND c.k = e.k
     WHERE e.target = $1`,
    [target],
  );
  type Order = readonly [number, number];
  const later = (a: Order, b: Order) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);
  const edge = new Map<string, { order: Order; decl: string }>();
  const clear = new Map<string, Order>();
  for (const x of r.rows) {
    const item = `${x.item_event}/${x.field_id}/${x.k}`;
    const order: Order = [Number(x.decl_op), Number(x.decl_op_index)];
    edge.set(item, { order, decl: `${order[0]}/${order[1]}/${x.decl_index}` });
    if (x.c_op !== null) clear.set(item, [Number(x.c_op), Number(x.c_index)]);
  }
  // This request's: after every stored one, in op order.
  for (const e of here.edges)
    if (e.target === target) edge.set(e.item, { order: [op, e.i], decl: `${op}/${e.i}/${e.j}` });
  for (const c of here.clears) clear.set(c.item, [op, c.i]);
  for (const item of mine.items) edge.set(item, { order: [op, mine.i], decl: "mine" });
  const inForce = new Set<string>();
  for (const [item, e] of edge) {
    const c = clear.get(item);
    if (c === undefined || !later(c, e.order)) inForce.add(e.decl);
  }
  inForce.delete("mine");
  return inForce.size;
}

/** The scope a premise declared, for `premiseDelta`. */
function scopeOf(r: ResolvedPremise, t: CompiledBaseTable, ctx: PremiseContext): PremiseScope {
  const fields = r.fields !== undefined ? { fields: r.fields } : {};
  if (t.time.type !== "state") return fields;
  if (r.valid !== undefined) {
    if ("at" in r.valid) return { ...fields, range: { at: r.valid.at } };
    return { ...fields, range: { from: r.valid.during.from, to: r.valid.during.to ?? null } };
  }
  // From now on: the target's granularity's now.
  const from = t.time.granularity === "date" ? ctx.today : ctx.now;
  return { ...fields, range: { from, to: null } };
}

/** The reason of the operation that changed a premise (02-integrity «什么算前提变了»). */
export async function reasonOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  since: OpNumber,
  before: TargetState,
  after: TargetState,
  scope: PremiseScope,
): Promise<string> {
  const r = await tx.query<{ intent: string }>(
    `SELECT DISTINCT intent FROM "${verTableOf(t)}" WHERE row_id = $1 AND rec_from = $2`,
    [id, since],
  );
  const intents = new Set(r.rows.map((x) => x.intent));
  if (intents.has("revoke")) return "revoke";
  if (intents.has("deletion") || intents.has("deletion_cancelled")) return "deleted";
  if (t.time.type !== "state") return intents.has("correct") ? "correct" : "update";
  if (intents.has("correct")) return "correct";
  // A state table: what changed before the entry time of that operation is retroactive; only
  // after it, a change of plan; both, retroactive.
  // That operation's entry time, as its head recorded it (`ctx.today` on a date table).
  const ctxRow = await tx.query<{ body: string | null }>(
    "SELECT body FROM content WHERE seq = $1 AND path = 'ctx'",
    [since],
  );
  const c = JSON.parse(ctxRow.rows[0]?.body ?? "{}") as { now?: string; today?: string };
  const nowThen = (t.time.granularity === "date" ? c.today : c.now) ?? "";
  const changed = premiseDelta(before, after, { ...scope });
  const past = changed.some(
    (d) => d.comparable && (d.stretches ?? []).some((s) => s.from < nowThen),
  );
  return past ? "retroactive" : "plan_changed";
}

/**
 * Each premise of an op, checked and resolved; or the first refusal. `depValid` is the depending
 * row's own business time for `row_time` (none: from now on).
 */
export async function resolvePremises(
  tx: ReadTx,
  premises: readonly NormalizedPremise[],
  ctx: PremiseContext,
  depValid: (target: CompiledBaseTable) => ResolvedPremise["valid"] | undefined,
): Promise<
  | {
      resolved: ResolvedPremise[];
      fallbacks: { premise: number; found: number; restoreCount?: number; origin: unknown }[];
    }
  | PremiseRefusal
> {
  const out: ResolvedPremise[] = [];
  const fallbacks: { premise: number; found: number; restoreCount?: number; origin: unknown }[] =
    [];
  const seenTargets = new Map<string, number>();
  for (const [j, p] of premises.entries()) {
    const at = `ops/${ctx.index}/premises/${j}`;
    const t = ctx.tableOf(p.table) as CompiledBaseTable;
    // An entity an earlier op of this request created: a premise on a row this request creates,
    // which comes with `as` (02-integrity «能指向什么»).
    if (p.target.kind === "entity_key" && ctx.createdHere(t.id, valuesOf(p.target.key)))
      return { code: "not_in_this_version", reason: "parameter", param: at };
    const id = await targetOf(tx, p, t, at);
    if (typeof id !== "string") return id;
    if (id === ctx.self) return { code: "invalid_argument", reason: "premise_self", param: at };
    const first = seenTargets.get(id);
    if (first !== undefined)
      return {
        code: "invalid_argument",
        reason: "premise_duplicate_target",
        param: at,
        detail: { premises: [first, j] },
      };
    seenTargets.set(id, j);
    // The others in force on the target once this one is recorded.
    const n = await ctx.fanIn(id);
    if (n + 1 > fanInLimit)
      return {
        code: "too_large",
        reason: "premise_fan_in",
        param: at,
        detail: {
          target: {
            table: `${ctx.slotName}.${t.name}`,
            ...(t.time.type === "state" ? { entity: id } : { row: id }),
          },
          count: n,
        },
      };
    // The version seen.
    const versions = await rowVersions(tx, verTableOf(t), id);
    let ver: ResolvedPremise["ver"];
    if (p.ver !== undefined) {
      if (p.ver.restoreCount !== ctx.restore || !versions.has(p.ver.op))
        return { code: "not_this_target", param: `${at}/ver` };
      ver = { op: p.ver.op as OpNumber, restore_count: p.ver.restoreCount, basis: "explicit" };
    } else {
      const f = await ctx.fallback(id, verTableOf(t), j);
      if ("refused" in f) throw f.refused;
      ver = {
        op: f.found as OpNumber,
        restore_count: f.restoreCount ?? ctx.restore,
        basis: "fallback",
      };
      fallbacks.push({ premise: j, ...f });
    }
    const target = t.time.type === "state" ? { entity: id as EntityId } : { row: id as RowId };
    // The range.
    let range: PremiseRange;
    let valid: ResolvedPremise["valid"];
    if (t.time.type !== "state") range = "whole";
    else if (p.valid !== undefined) {
      range = "given";
      valid =
        "at" in p.valid
          ? { at: p.valid.at as BizPoint }
          : {
              during: {
                from: p.valid.during.from as BizPoint,
                ...(p.valid.during.to !== null ? { to: p.valid.during.to as BizPoint } : {}),
              },
            };
    } else {
      valid = depValid(t);
      range = valid === undefined ? "from_now" : "row_time";
    }
    const base: ResolvedPremise = {
      table: t.id,
      target,
      ...(p.fields !== undefined ? { fields: p.fields } : {}),
      ver,
      range,
      ...(valid !== undefined ? { valid } : {}),
      state: "current",
    };
    out.push(await stateWhenWritten(tx, t, id, base, versions, ctx));
  }
  return { resolved: out, fallbacks };
}

/** The declaration's state when written (09 §5.7 `state`, `reason`, `since`). */
async function stateWhenWritten(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  r: ResolvedPremise,
  versions: ReadonlySet<number>,
  ctx: PremiseContext,
): Promise<ResolvedPremise> {
  const later = [...versions].filter((v) => v > r.ver.op).sort((a, b) => a - b);
  if (later.length === 0) return r;
  const scope = scopeOf(r, t, ctx);
  const read = (v: number) => stateAt(tx, t, id, v, { decode: decodeColumns });
  const seen = await read(r.ver.op);
  // Each later version against the one seen: the last stretch all differing starts at `since`.
  const states: TargetState[] = [];
  for (const v of later) states.push(await read(v));
  const differs = states.map((s) => premiseDelta(seen, s, scope).length > 0);
  if (!differs.at(-1)) return r;
  let k = differs.length - 1;
  while (k > 0 && differs[k - 1]) k--;
  const since = later[k] as OpNumber;
  const before = k === 0 ? seen : (states[k - 1] as TargetState);
  const reason = await reasonOf(tx, t, id, since, before, states[k] as TargetState, scope);
  return { ...r, state: "changed", reason, since };
}

/**
 * The depending row's own business time (02-integrity «状态类表上的目标不给业务时间时»), aligned to
 * the target's granularity: a point (an event row's time field) or a stretch (a state table's
 * interval), with `deps` when another contribution gave it. None: from now on.
 */
export function alignedTo(
  t: CompiledBaseTable,
  own:
    | { readonly at: BizPoint }
    | { readonly during: { readonly from: BizPoint; readonly to: BizPoint | null } },
  zone: string,
): { at: BizPoint } | { during: { from: BizPoint; to?: BizPoint } } {
  const date = t.time.type === "state" && t.time.granularity === "date";
  const isDate = (p: BizPoint) => /^\d{4}-\d{2}-\d{2}$/.test(p);
  const toDate = (p: BizPoint) => (isDate(p) ? p : (dateInZone(Date.parse(p), zone) as BizPoint));
  const toInstant = (p: BizPoint) =>
    isDate(p) ? (new Date(startOfDay(p as DateStr, zone)).toISOString() as BizPoint) : p;
  if ("at" in own) {
    if (date) return { at: toDate(own.at) };
    if (!isDate(own.at)) return { at: own.at };
    // A day on an instant table: that day's bounds.
    return {
      during: {
        from: toInstant(own.at),
        to: toInstant(nextDay(own.at as DateStr) as BizPoint),
      },
    };
  }
  const { from, to } = own.during;
  if (date) {
    // Every day it meets: from the day of `from` to the day after the last instant before `to`.
    const last =
      to === null
        ? undefined
        : isDate(to)
          ? to
          : (() => {
              const d = toDate(to);
              return startOfDay(d as DateStr, zone) === Date.parse(to)
                ? d
                : (nextDay(d as DateStr) as BizPoint);
            })();
    return { during: { from: toDate(from), ...(last !== undefined ? { to: last } : {}) } };
  }
  return {
    during: {
      from: toInstant(from),
      ...(to !== null ? { to: toInstant(to) } : {}),
    },
  };
}

/**
 * Pieces run together into one stretch (their hull): more, not less. In any order (an op's items
 * come field by field, each with its own end); the earliest start and the latest end, open beating
 * any. None for no piece, or one open at the start: a write's interval always has a start (a given
 * one, or now), so that only comes of an existence write-back, never of what an op writes.
 */
export function hull(v: IntervalSet): { from: BizPoint; to: BizPoint | null } | undefined {
  if (v.length === 0 || v.some((x) => x.from === null)) return undefined;
  const from = v.map((x) => x.from as BizPoint).sort()[0] as BizPoint;
  const to = v.some((x) => x.to === null)
    ? null
    : (v
        .map((x) => x.to as BizPoint)
        .sort()
        .at(-1) as BizPoint);
  return { from, to };
}

/** A business time point from a time field's value: a date, or a zoned date-time's instant. */
export function pointOf(v: unknown): BizPoint | undefined {
  if (typeof v === "string") return v as BizPoint;
  if (
    v !== null &&
    typeof v === "object" &&
    typeof (v as { instant?: unknown }).instant === "string"
  )
    return (v as { instant: string }).instant as BizPoint;
  return undefined;
}

/**
 * The 出处项 of an item (01-objects «出处项»; 02-integrity «标记出现在哪一行» step 1): itself, or,
 * when it carries a value from others (a write-back of a revert, a taken candidate with the
 * same-valued candidates of its item, a return to the merge base), every item it carries from,
 * each followed to its end. In item order.
 */
export function sourceItemsOf(state: RowState, ref: ItemRef): ItemRef[] {
  const out = new Map<string, ItemRef>();
  const seen = new Set<string>();
  const walk = (at: ItemRef) => {
    const key = itemKey(at);
    if (seen.has(key)) return;
    seen.add(key);
    const x = state.items.find(
      (i) => i.event === at.event && i.target === at.target && i.k === at.k,
    );
    const next = x?.carried ?? [];
    if (next.length === 0) out.set(key, { event: at.event, target: at.target, k: at.k });
    for (const n of next) walk(n);
  };
  walk(ref);
  return [...out.values()].sort(byItem);
}

const byItem = (a: ItemRef, b: ItemRef) =>
  a.event - b.event || (a.target < b.target ? -1 : a.target > b.target ? 1 : 0) || a.k - b.k;

/**
 * The row's 出处项 in effect at the version the op saw and still in effect after it (09 §5.7
 * `premise_covers`): the contributions giving a field its value, carried references followed to
 * their ends (`sourceItemsOf`), and the corroborations still standing, on some stretch at both.
 * `seenAt` is what the op saw as judging takes it (`seenOf`): with its `ver` current, a
 * corroboration made since that version is seen. The op's own items are never among them (none is
 * in effect at the version it saw): they are covered by the event they are in.
 */

export function coveredItems(state: RowState, seenAt: Limit, after: Limit): ItemRef[] {
  const givers = (at: Limit) => {
    const out = new Map<string, ItemRef>();
    for (const f of state.table.fields) {
      for (const s of state.pieces()) {
        const st = state.fieldState(f, s, at);
        if (st.kind === "value")
          for (const src of sourceItemsOf(state, st.by)) out.set(itemKey(src), src);
      }
      // Corroborations still standing: the value they say is the value there.
      for (const x of state.items) {
        if (x.status !== "corroborated" || x.target !== f || !state.sees(x, at)) continue;
        if (x.content.kind !== "value") continue;
        const token = valueToken(x.content.value);
        const stands = state
          .piecesIn(x.valid)
          .some((s: Interval) => state.token(f, s, at) === token);
        if (stands)
          out.set(`${x.event}/${x.target}/${x.k}`, { event: x.event, target: x.target, k: x.k });
      }
    }
    return out;
  };
  const before = givers(seenAt);
  const now = givers(after);
  return [...before]
    .filter(([k]) => now.has(k))
    .map(([, x]) => x)
    .sort(byItem);
}

/** Whether every field of the op took effect (applied, corroborated or a no-op): its record. */
export const tookEffect = (j: Judgement): boolean =>
  !("items" in j.record) ||
  j.record.items.every((x) => x.status === "applied" || x.status === "corroborated");
