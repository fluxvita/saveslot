// From selected rows to the rows a query gives back (04-contract §4, §7, §10 `query`; 04-contract-types
// §3, §4.1, §4.3): marks, merging adjacent segments, clipping to the interval asked, the order, the
// page and its cursor.
//
// Order: the fields asked for, then the default keys, which end in the row's identity so the order
// is total (event tables: time field descending, then row ID; state tables: entity ID, then
// `valid_from`; timeless tables: the latest change descending, then row ID). Nulls come last in
// either direction. Text compares by code point (the "C" collation on UTF-8). A cursor carries the
// keys of the last row of its page, and the next page starts after them.

import { createHash } from "node:crypto";
import type {
  BizPoint,
  CompiledBaseField,
  CompiledTable,
  DateStr,
  FieldValue,
  ItemId,
} from "@fluxvita/saveslot-contract-core";
import {
  canonicalize,
  isDate,
  isInstant,
  type PremiseReason,
} from "@fluxvita/saveslot-contract-core";
import {
  compare,
  get,
  has,
  isDenseArray,
  isObj,
  keysOf,
  type Rational,
  rationalOf,
} from "../request/index.ts";
import { valueOut } from "../time/index.ts";
import { intervalOf } from "./interval.ts";
import type { QueryPlan } from "./params.ts";
import type { Flag, RowFacts, SelectedRow, Span } from "./select.ts";
import {
  invalid,
  type Marks,
  type PremiseChangedMark,
  ReadError,
  type Row,
  type Values,
} from "./types.ts";
import { meetsCondition } from "./versions.ts";

// --- marks ---------------------------------------------------------------------------------------

/** Whether a flag's spans reach the segment `[from, to)` (no spans: the whole row). */
export function spansMeet(
  spans: readonly Span[] | undefined,
  from: string,
  to: string | null,
): boolean {
  if (spans === undefined) return true;
  return spans.some(
    (s) => (s.to === null || s.to > from) && (to === null || startsBefore(s.from, to)),
  );
}

/** Whether a span starting at `from` (null: open at the start, before every point) starts before `to`. */
const startsBefore = (from: string | null, to: string): boolean => from === null || from < to;

/** Spans by start, one open at the start first. */
const byStart = (a: { from: string | null }, b: { from: string | null }): number =>
  a.from === null ? (b.from === null ? 0 : -1) : b.from === null ? 1 : cmpText(a.from, b.from);

/** A mark's span while rows are cut and merged: `[from, to)`, either end absent when open. */
interface MarkSpan {
  readonly from?: BizPoint;
  readonly to?: BizPoint;
}
interface WorkMark {
  readonly item: ItemId;
  readonly fields: readonly string[];
  readonly spans?: readonly MarkSpan[];
}
/**
 * A changed premise on a row while rows are cut and merged: its declaration, and what it covers on
 * the row (a field, on a stretch of a state table), until the rows are shown.
 */
interface WorkPremise {
  readonly decl: string;
  readonly covers: readonly {
    readonly field: string;
    readonly from: string | null;
    readonly to: string | null;
  }[];
}
/** `Marks` with their spans as `MarkSpan`s, and premises as `WorkPremise`s, until shown. */
type WorkMarks = Omit<
  Marks,
  "disputed" | "awaiting" | "premise_changed" | "premise_changed_total"
> & {
  readonly disputed?: readonly WorkMark[];
  readonly awaiting?: readonly WorkMark[];
  readonly premise?: readonly WorkPremise[];
};

/** The marks as shown: each span an `Interval` (04-contract-types §3 `Marks`). */
function shownMarks(m: WorkMarks | undefined, byDate: boolean): Marks | undefined {
  if (m === undefined) return undefined;
  const out = (xs?: readonly WorkMark[]) =>
    xs?.map(({ spans, ...x }) =>
      spans === undefined
        ? x
        : { ...x, spans: spans.map((y) => intervalOf(y.from ?? null, y.to, byDate)) },
    );
  const { disputed, awaiting, premise: _p, ...rest } = m;
  return {
    ...rest,
    ...(disputed !== undefined ? { disputed: out(disputed) } : {}),
    ...(awaiting !== undefined ? { awaiting: out(awaiting) } : {}),
  } as Marks;
}

/**
 * A flag's business time as the marks give it (04-contract-types §3: `spans`): the item's spans
 * within the row's interval `[from, to)`, cut to it, adjacent ones joined; undefined on a row
 * without one (event and timeless tables) or a flag without spans.
 */
function markSpans(
  spans: readonly Span[] | undefined,
  from: string | undefined,
  to: string | null | undefined,
): MarkSpan[] | undefined {
  if (spans === undefined) return undefined;
  const lo = from;
  const hi = to ?? null;
  const cut = spans
    .filter(
      (s) =>
        lo === undefined ||
        ((s.to === null || s.to > lo) && (hi === null || startsBefore(s.from, hi))),
    )
    .map((s) => ({
      // Cut to the row: a start before the row's (or open) becomes the row's.
      from: lo === undefined || (s.from !== null && s.from > lo) ? s.from : lo,
      to: hi === null ? s.to : s.to === null || s.to > hi ? hi : s.to,
    }))
    .sort(byStart);
  const out: { from: string | null; to: string | null }[] = [];
  for (const s of cut) {
    const last = out.at(-1);
    // Overlapping or touching: one span. An open start meets every span before it.
    if (last !== undefined && last.to !== null && (s.from === null || last.to >= s.from)) {
      if (s.to === null || s.to > last.to) last.to = s.to;
    } else if (last !== undefined && last.to === null) {
      // The last span already runs on: it takes this one in.
    } else out.push({ ...s });
  }
  return out.map((s) => ({
    ...(s.from !== null ? { from: s.from as BizPoint } : {}),
    ...(s.to !== null ? { to: s.to as BizPoint } : {}),
  }));
}

/** A mark's spans as `Span`s, to cut again. */
const asSpans = (xs: readonly MarkSpan[]): Span[] =>
  xs.map((x) => ({ from: x.from ?? null, to: x.to ?? null }));

/** The item marks of a row with their spans cut to the row's interval `[from, to)`. */
function cutMarks(
  m: WorkMarks | undefined,
  from: string,
  to: string | null,
): WorkMarks | undefined {
  if (m === undefined) return undefined;
  const cut = <T extends { spans?: readonly MarkSpan[] }>(xs?: readonly T[]) => {
    const kept = (xs ?? []).flatMap((x) => {
      if (x.spans === undefined) return [x];
      const spans = markSpans(asSpans(x.spans), from, to) ?? [];
      return spans.length === 0 ? [] : [{ ...x, spans }];
    });
    return kept.length === 0 ? undefined : kept;
  };
  const { disputed: _d, awaiting: _a, premise: _p, ...rest } = m;
  const disputed = cut(m.disputed);
  const awaiting = cut(m.awaiting);
  // A premise: what it covers on the cut row; none left, it goes.
  const premise = (m.premise ?? []).flatMap((p) => {
    const covers = p.covers.filter((c) => spansMeet([c], from, to));
    return covers.length === 0 ? [] : [{ ...p, covers }];
  });
  const out: WorkMarks = {
    ...rest,
    ...(disputed !== undefined ? { disputed } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(premise.length > 0 ? { premise } : {}),
  };
  return Object.keys(out).length === 0 ? undefined : out;
}

/**
 * Whether a state segment `[from, to)` is corrected (04-contract §7): a value of a field read comes
 * from a correction there (the version table's cells of intent `correct`, as of the state read).
 */
export function correctedWithin(
  spans:
    | readonly { readonly field: string; readonly from: string; readonly to: string | null }[]
    | undefined,
  read: ReadonlySet<string>,
  from: string,
  to: string | null,
): boolean {
  return (spans ?? []).some(
    (c) => read.has(c.field) && (c.to === null || c.to > from) && (to === null || c.from < to),
  );
}

function marksOf(plan: QueryPlan, r: SelectedRow, facts: RowFacts): WorkMarks | undefined {
  const t = plan.table;
  const name = new Map(t.fields.map((f) => [f.id as string, f.name]));
  const read = new Set<string>(plan.fields.map((f) => f.id));
  const out: {
    disputed?: { item: never; fields: string[]; spans?: MarkSpan[] }[];
    awaiting?: { item: never; fields: string[]; spans?: MarkSpan[] }[];
    flagged?: { item: never; reason: "duplicate_keys" }[];
    corrected?: true;
    revoked?: { seq: never };
    dangling_ref?: { field: string; state: "revoked" }[];
  } = {};
  for (const f of facts.flags.get(r.id) ?? ([] as Flag[])) {
    // Only where the value read would change with it (04-contract §7).
    const existence = f.fields.includes("existence");
    if (plan.fieldsGiven && !existence && !f.fields.some((x) => read.has(x))) continue;
    if (r.validFrom !== undefined && !spansMeet(f.spans, r.validFrom, r.validTo ?? null)) continue;
    if (f.flag === "flagged") {
      out.flagged = [...(out.flagged ?? []), { item: f.item as never, reason: "duplicate_keys" }];
      continue;
    }
    const spans =
      r.validFrom === undefined ? undefined : markSpans(f.spans, r.validFrom, r.validTo);
    const list = out[f.flag] ?? [];
    out[f.flag] = list;
    list.push({
      item: f.item as never,
      fields: f.fields.map((x) => (x === "existence" ? "*" : (name.get(x) ?? x))),
      ...(spans !== undefined ? { spans } : {}),
    });
  }
  // corrected: an event or timeless row ever corrected; a state table's segment where a value
  // read comes from a correction (04-contract §7).
  if (r.validFrom === undefined) {
    if (facts.corrected.has(r.id)) out.corrected = true;
  } else {
    if (correctedWithin(facts.correctSpans.get(r.id), read, r.validFrom, r.validTo ?? null))
      out.corrected = true;
  }
  const revokedBy = facts.revokedBy.get(r.id);
  if (r.revoked && revokedBy !== undefined) out.revoked = { seq: revokedBy as never };
  // dangling_ref: a ref field read whose value names a target revoked since (04-contract §7).
  for (const f of t.fields) {
    if (f.type !== "ref" || (plan.fieldsGiven && !read.has(f.id))) continue;
    const v = r.values[f.id];
    if (typeof v === "string" && facts.revokedTargets?.has(v) === true) {
      out.dangling_ref = [...(out.dangling_ref ?? []), { field: f.name, state: "revoked" }];
    }
  }
  // Changed premises: those covering a value on this segment (02-integrity «标记出现在哪一行»);
  // with `fields` given, only those covering a field read (04-contract §7).
  const byDecl = new Map<string, WorkPremise["covers"][number][]>();
  for (const c of facts.premises?.covers.get(r.id) ?? []) {
    if (r.validFrom !== undefined && !spansMeet([c], r.validFrom, r.validTo ?? null)) continue;
    const list = byDecl.get(c.decl) ?? [];
    list.push({ field: c.field, from: c.from, to: c.to });
    byDecl.set(c.decl, list);
  }
  const premise = [...byDecl]
    .filter(([, cs]) => !plan.fieldsGiven || cs.some((c) => read.has(c.field)))
    .map(([decl, covers]) => ({ decl, covers }));
  return Object.keys(out).length === 0 && premise.length === 0
    ? undefined
    : ({ ...out, ...(premise.length > 0 ? { premise } : {}) } as WorkMarks);
}

/**
 * The marks of a merged row: each item's mark once, its spans those of the segments together
 * (the item's spans within the merged row), `corrected` when any segment's is.
 */
function unionMarks(a: WorkMarks | undefined, b: WorkMarks | undefined): WorkMarks | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const items = <T extends { item: string; spans?: readonly MarkSpan[] }>(
    x?: readonly T[],
    y?: readonly T[],
  ) => {
    const out: T[] = [...(x ?? [])];
    for (const m of y ?? []) {
      const i = out.findIndex((o) => o.item === m.item);
      if (i < 0) out.push(m);
      else {
        const o = out[i] as T;
        if (o.spans !== undefined || m.spans !== undefined) {
          const spans =
            markSpans(asSpans([...(o.spans ?? []), ...(m.spans ?? [])]), undefined, undefined) ??
            [];
          out[i] = { ...o, spans };
        }
      }
    }
    return out.length === 0 ? undefined : out;
  };
  const disputed = items(a.disputed, b.disputed);
  const awaiting = items(a.awaiting, b.awaiting);
  const flagged = items(a.flagged, b.flagged);
  const premise = new Map<string, WorkPremise>();
  for (const p of [...(a.premise ?? []), ...(b.premise ?? [])]) {
    const o = premise.get(p.decl);
    premise.set(p.decl, o === undefined ? p : { ...o, covers: [...o.covers, ...p.covers] });
  }
  return {
    ...(premise.size > 0 ? { premise: [...premise.values()] } : {}),
    ...(disputed !== undefined ? { disputed } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(flagged !== undefined ? { flagged } : {}),
    ...(a.corrected === true || b.corrected === true ? { corrected: true as const } : {}),
  };
}

/**
 * The changed premises of a row as shown (04-contract-types §3 `Marks.premise_changed`): the latest
 * `since` first (of one `since`, the later declaration first), at most 10, the total when there
 * are more. `fields` are this row's fields covered. A premise on a table the caller cannot see still
 * shows, as what is of this row only (`hidden`, `since`, `fields`): that the row rests on something
 * that changed matters to whoever reads it; which table, row and fields, and how, are not told.
 * A table a schema switch dropped (`schema_switched`) is not one the caller cannot see: to a caller
 * whose range takes it in (the whole slot, or the table by its ID) it is told whole, named as the
 * last version having it defined it (05 §4.2: "dropped in the schema switch of #n"); to any other it
 * is `hidden`, as a table out of range: a range narrowed to the tables left is not one that saw it.
 */
function shownPremises(
  plan: QueryPlan,
  facts: RowFacts,
  list: readonly WorkPremise[],
): Pick<Marks, "premise_changed" | "premise_changed_total"> {
  const p = facts.premises;
  if (p === undefined) return {};
  const slot = plan.named.slot;
  const visible = new Map(slot.tables.map((t) => [t.id as string, t]));
  const marks: { order: readonly number[]; mark: PremiseChangedMark }[] = [];
  for (const w of list) {
    const d = p.decls.get(w.decl);
    // Changed ones only (`premiseFacts` asks for no other; a changed one has both).
    if (d === undefined || d.state !== "changed" || d.since === null || d.reason === null) continue;
    const covered = new Set(w.covers.map((c) => c.field));
    const fields = plan.table.fields.filter((f) => covered.has(f.id)).map((f) => f.name);
    const reason = d.reason as PremiseReason;
    const since = d.since as never;
    const former = p.formerTables.get(d.targetTable);
    // The catalog keeps a table's definition without its physical tables, which naming needs not.
    const target: CompiledTable | undefined =
      visible.get(d.targetTable) ??
      (reason === "schema_switched" &&
      former !== undefined &&
      former.slot === slot.slot &&
      !slot.compiled.tables.some((x) => x.id === d.targetTable) &&
      (slot.rangeTables === undefined || slot.rangeTables.has(d.targetTable))
        ? (former.table as CompiledTable)
        : undefined);
    const order = [d.since, d.op, -d.opIndex, -d.index];
    if (target === undefined || target.kind !== "base") {
      // Only what is of this row: that something it rests on changed, and since when (an operation
      // number, as its own versions show); not how (`deleted` would tell of a deletion there).
      marks.push({ order, mark: { hidden: true, since, fields } });
      continue;
    }
    const names = new Map(target.fields.map((f) => [f.id as string, f.name]));
    marks.push({
      order,
      mark: {
        premise: {
          table: `${slot.name}.${target.name}`,
          ...(target.time.type === "state"
            ? { entity: d.target as never }
            : { row: d.target as never }),
        },
        ...(d.fields !== null ? { premise_fields: d.fields.map((f) => names.get(f) ?? f) } : {}),
        seen: `v${d.seen.op}.${d.seen.restoreCount}`,
        reason,
        since,
        fields,
        declared: {
          seq: d.op as never,
          actor: p.actors.get(d.declarer) ?? { kind: "user", id: d.declarer, name: d.declarer },
        },
      },
    });
  }
  if (marks.length === 0) return {};
  // The latest since first; then the latest declaring operation; within it in op order.
  marks.sort((a, b) => {
    for (let i = 0; i < a.order.length; i++) {
      const x = (b.order[i] as number) - (a.order[i] as number);
      if (x !== 0) return x;
    }
    return 0;
  });
  return {
    premise_changed: marks.slice(0, 10).map((x) => x.mark),
    ...(marks.length > 10 ? { premise_changed_total: marks.length } : {}),
  };
}

// --- rows ----------------------------------------------------------------------------------------

/** A row with what ordering and the read record need besides what it shows. */
export interface ShownRow {
  readonly row: Row;
  readonly id: string;
  readonly ver: number;
  /** Every field's value, by field ID (merged segments: the first's), for the order keys. */
  readonly values: Readonly<Record<string, FieldValue>>;
  readonly keys: readonly (string | boolean | number | null)[];
}

const dayBefore = (d: string): DateStr => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, day - 1);
  return t.toISOString().slice(0, 10) as DateStr;
};

const valueKey = (v: FieldValue | undefined) => canonicalize((v ?? null) as never);

/**
 * The rows shown, not yet ordered. On a state table read over an interval, in this order (04-contract
 * §4): the segments the field conditions kept (all of each entity's, not only those meeting the
 * interval) are merged where adjacent with the same values read and the same marks; those meeting
 * the interval are kept; the `valid_from` / `valid_to` conditions apply to them; then `clip`.
 */
export function shownRows(
  plan: QueryPlan,
  selected: readonly SelectedRow[],
  facts: RowFacts,
  restoreCount: number,
): Omit<ShownRow, "keys">[] {
  const t = plan.table;
  const qualified = `${plan.named.slot.name}.${t.name}`;
  const state = plan.kind === "state";
  type Seg = { r: SelectedRow; marks: WorkMarks | undefined };
  let segs: Seg[] = selected.map((r) => ({ r, marks: marksOf(plan, r, facts) }));

  if (state && plan.time.kind === "during") {
    segs.sort((a, b) =>
      a.r.id === b.r.id
        ? cmpText(a.r.validFrom as string, b.r.validFrom as string)
        : cmpText(a.r.id, b.r.id),
    );
    if (plan.coalesce) {
      // Adjacent segments of an entity with the same values read, whatever their marks: marks
      // read at each page never change how rows are cut (04-contract §15). The merged row carries
      // every segment's marks.
      const merged: Seg[] = [];
      for (const s of segs) {
        const last = merged.at(-1);
        if (
          last !== undefined &&
          last.r.id === s.r.id &&
          last.r.validTo === s.r.validFrom &&
          plan.fields.every((f) => valueKey(last.r.values[f.id]) === valueKey(s.r.values[f.id]))
        ) {
          merged[merged.length - 1] = {
            r: { ...last.r, validTo: s.r.validTo ?? null },
            marks: unionMarks(last.marks, s.marks),
          };
        } else merged.push(s);
      }
      segs = merged;
    }
    const { from: a, to: b } = plan.time;
    segs = segs.filter((x) => {
      const vt = x.r.validTo ?? null;
      return (vt === null || vt > a) && (b === null || (x.r.validFrom as string) < b);
    });
    const onInterval = plan.where.filter((c) => typeof c.column === "string");
    segs = segs.filter((x) => onInterval.every((c) => meetsCondition(c, x.r)));
    if (plan.clip) {
      const { from, to } = plan.time;
      segs = segs.map((s) => {
        const vf = s.r.validFrom as string;
        const vt = s.r.validTo ?? null;
        const validFrom = [vf, from].sort(cmpText)[1] as string;
        const validTo = to === null ? vt : vt === null || vt > to ? to : vt;
        // The marks' spans within the clipped row; an item no longer meeting it goes.
        return { marks: cutMarks(s.marks, validFrom, validTo), r: { ...s.r, validFrom, validTo } };
      });
    }
  }

  const byId = new Map(t.fields.map((f) => [f.id as string, f]));
  const date = t.time.type === "state" && t.time.granularity === "date";
  return segs.map(({ r, marks }) => {
    const ver = facts.ver.get(r.id);
    if (ver === undefined) throw new ReadError("internal", `no version of ${r.id}`);
    const values: Record<string, Values[string]> = Object.create(null);
    for (const f of plan.fields) values[f.name] = valueOut(r.values[f.id] ?? null);
    let entityKey: Values | undefined;
    if (t.time.type === "state" && t.entity_key !== undefined) {
      const k: Record<string, Values[string]> = Object.create(null);
      for (const id of t.entity_key) {
        const f = byId.get(id) as CompiledBaseField;
        k[f.name] = valueOut(r.values[id] ?? null);
      }
      entityKey = k;
    }
    const row: Row = {
      table: qualified,
      ...(state ? { entity: r.id as never } : { row: r.id as never }),
      ...(entityKey !== undefined ? { entity_key: entityKey } : {}),
      ver: `v${ver}.${restoreCount}`,
      values,
      ...(state
        ? {
            valid_from: r.validFrom as BizPoint,
            valid_to: (r.validTo ?? null) as BizPoint | null,
            ...(date && r.validTo !== null && r.validTo !== undefined
              ? { valid_to_inclusive: dayBefore(r.validTo) }
              : {}),
          }
        : {}),
      ...(() => {
        const all: Marks = {
          ...(shownMarks(marks, date) ?? {}),
          ...(marks?.premise !== undefined ? shownPremises(plan, facts, marks.premise) : {}),
        };
        return Object.keys(all).length > 0 ? { marks: all } : {};
      })(),
    };
    return { row, id: r.id, ver, values: r.values };
  });
}

// --- order ---------------------------------------------------------------------------------------

export type KeyType = "number" | "text" | "plain" | "boolean" | "count";

export interface KeySpec {
  readonly type: KeyType;
  readonly dir: "asc" | "desc";
}

/** Code point order (UTF-8 byte order, the "C" collation). */
export function cmpText(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  for (let i = 0; i < Math.min(x.length, y.length); i++) {
    const d = ((x[i] as string).codePointAt(0) ?? 0) - ((y[i] as string).codePointAt(0) ?? 0);
    if (d !== 0) return d < 0 ? -1 : 1;
  }
  return x.length === y.length ? 0 : x.length < y.length ? -1 : 1;
}

export function keyType(f: CompiledBaseField): KeyType {
  switch (f.type) {
    case "integer":
    case "decimal":
    case "quantity":
      return "number";
    case "date":
    case "zoned_datetime":
      return "plain"; // fixed-width ASCII forms: compare as strings
    case "boolean":
      return "boolean";
    default:
      return "text";
  }
}

export function keyValue(v: FieldValue | undefined): string | boolean | null {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean" || typeof v === "string") return v;
  if ("instant" in v) return v.instant;
  return v.value;
}

/** The keys rows are ordered by: the order asked for, then the default keys. */
export function keySpecs(plan: QueryPlan): KeySpec[] {
  const asked = plan.order.map((o) => ({ type: keyType(o.field), dir: o.dir }));
  const t = plan.table;
  if (plan.kind === "state")
    return [...asked, { type: "text", dir: "asc" }, { type: "plain", dir: "asc" }];
  if (plan.kind === "event" && t.time.type === "event") {
    const tf = t.fields.find((f) => t.time.type === "event" && f.id === t.time.field);
    return [
      ...asked,
      { type: keyType(tf as CompiledBaseField), dir: "desc" },
      { type: "text", dir: "asc" },
    ];
  }
  return [...asked, { type: "count", dir: "desc" }, { type: "text", dir: "asc" }];
}

/** A row's key values, in `keySpecs` order. */
export function rowKeys(
  plan: QueryPlan,
  s: Omit<ShownRow, "keys">,
): (string | boolean | number | null)[] {
  // Each row's (each segment's) own values: never another segment's of the same entity.
  const selected = s.values;
  const asked = plan.order.map((o) => keyValue(selected[o.field.id]));
  const t = plan.table;
  if (plan.kind === "state") return [...asked, s.id, (s.row.valid_from as string) ?? null];
  if (plan.kind === "event" && t.time.type === "event") {
    const id = t.time.field;
    return [...asked, keyValue(selected[id]), s.id];
  }
  return [...asked, s.ver, s.id];
}

const rationals = new Map<string, Rational>();
const rational = (s: string): Rational => {
  let r = rationals.get(s);
  if (r === undefined) {
    r = rationalOf(s);
    if (rationals.size > 10_000) rationals.clear();
    rationals.set(s, r);
  }
  return r;
};

function cmpOne(t: KeyType, a: string | boolean | number, b: string | boolean | number): number {
  switch (t) {
    case "number":
      return compare(rational(a as string), rational(b as string));
    case "text":
      return cmpText(a as string, b as string);
    case "boolean":
      return a === b ? 0 : a === false ? -1 : 1;
    case "count":
      return (a as number) - (b as number);
    default:
      return a < b ? -1 : a > b ? 1 : 0;
  }
}

/** Compares two key tuples; nulls last in either direction. */
export function cmpKeys(
  specs: readonly KeySpec[],
  a: readonly (string | boolean | number | null)[],
  b: readonly (string | boolean | number | null)[],
): number {
  for (let i = 0; i < specs.length; i++) {
    const s = specs[i] as KeySpec;
    const x = a[i] ?? null;
    const y = b[i] ?? null;
    if (x === null || y === null) {
      if (x === y) continue;
      return x === null ? 1 : -1;
    }
    const c = cmpOne(s.type, x, y);
    if (c !== 0) return s.dir === "asc" ? Math.sign(c) : -Math.sign(c);
  }
  return 0;
}

// --- position ------------------------------------------------------------------------------------
//
// A page's position (04-contract §13, §15): what the next page needs, unsigned. The service layer
// wraps it into the signed, expiring `cur_` handle the contract's `cursor` is, and unwraps it; the
// kernel never signs nor holds a key. The position fixes the page to the first page: its operation
// number (later pages read the state after it, so writes meanwhile neither drop nor repeat rows),
// its evaluation time, and the restore count; and it carries the keys of the last row given. It
// is foreign input: anything not of its shape is `malformed`; a position of another query is too;
// one from before a restore is `handle_expired` (`restored`). What it can read is decided by the
// call's own parameters and visible range, never by the position.

/** What a position belongs to: the query as normalized, without the page and the times it fixes. */
export function queryIdentity(plan: QueryPlan, given: { at: boolean }): string {
  const lit = (l: unknown): unknown =>
    isObj(l) && (l as { kind?: unknown }).kind === "number"
      ? {
          n: String((l as { value: Rational }).value.num),
          d: String((l as { value: Rational }).value.den),
        }
      : l;
  const identity = {
    table: plan.table.id,
    fields: plan.fields.map((f) => f.id),
    where: plan.where.map((c) => ({
      column: typeof c.column === "string" ? c.column : c.column.id,
      op: c.op,
      ...("value" in c ? { value: lit(c.value) } : {}),
      ...("values" in c ? { values: c.values.map(lit) } : {}),
      ...("isNull" in c ? { isNull: c.isNull } : {}),
    })),
    order: plan.order.map((o) => ({ field: o.field.id, dir: o.dir })),
    time: plan.time.kind === "now" ? null : plan.time,
    at: given.at ? plan.at : null,
    clip: plan.clip,
    coalesce: plan.coalesce,
    include_revoked: plan.includeRevoked,
  };
  return createHash("sha256")
    .update(canonicalize(identity as never))
    .digest("hex")
    .slice(0, 32);
}

export interface Position {
  /** The first page's operation number: later pages read the state after it. */
  readonly seq: number;
  /** The first page's evaluation time. */
  readonly at: string;
  readonly restoreCount: number;
  /** The keys of the last row given. */
  readonly keys: readonly (string | boolean | number | null)[];
  /**
   * What the first page resolved besides its point, when the call needs it again: `history`
   * `as_of`'s business time condition taken from a read (`{at}` or `{during}`).
   */
  readonly condition?: { readonly at?: string; readonly during?: readonly [string, string | null] };
  /**
   * `history` `changes`: the operation number the first page resolved `since` to (exclusive).
   * Later pages take it from here: `"my_last_read"` would otherwise move with the reads made since.
   */
  readonly since?: number;
}

export function encodePosition(identity: string, p: Position): string {
  return Buffer.from(
    JSON.stringify({
      v: 1,
      q: identity,
      s: p.seq,
      t: p.at,
      r: p.restoreCount,
      k: p.keys,
      ...(p.condition !== undefined ? { c: p.condition } : {}),
      ...(p.since !== undefined ? { f: p.since } : {}),
    }),
    "utf8",
  ).toString("base64url");
}

/** A position, checked against the query, the restore count and the key types. */
export function decodePosition(
  text: string,
  param: string,
  check: {
    readonly identity: string;
    readonly specs: readonly KeySpec[];
    readonly restoreCount: number;
    readonly latest: number;
    /** Whether the call carries a business time condition (`as_of` only). */
    readonly condition?: true;
    /** Whether the call carries a resolved `since` (`changes` only). */
    readonly since?: true;
  },
): Position {
  const bad = () => invalid("malformed", param);
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 16_384) throw bad();
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  const shape = isObj(o) ? [...keysOf(o)].sort().join(",") : "";
  if (
    !isObj(o) ||
    (shape !== "k,q,r,s,t,v" && shape !== "c,k,q,r,s,t,v" && shape !== "f,k,q,r,s,t,v") ||
    get(o, "v") !== 1
  )
    throw bad();
  if (get(o, "q") !== check.identity) throw bad();
  const seq = get(o, "s");
  const at = get(o, "t");
  const r = get(o, "r");
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > check.latest)
    throw bad();
  // A real instant of the event format's form, not only its shape.
  if (typeof at !== "string" || !isInstant(at)) throw bad();
  if (typeof r !== "number" || !Number.isSafeInteger(r) || r < 0) throw bad();
  if (r !== check.restoreCount) {
    throw new ReadError("handle_expired", "the position is from before a restore", {
      reason: "restored",
      param,
    });
  }
  let since: number | undefined;
  if (has(o, "f")) {
    const f = get(o, "f");
    if (check.since !== true || typeof f !== "number" || !Number.isSafeInteger(f)) throw bad();
    if (f < 0 || f > check.latest) throw bad();
    since = f;
  } else if (check.since === true) throw bad();
  const k = get(o, "k");
  if (!isDenseArray(k) || k.length !== check.specs.length) throw bad();
  const keys = k.map((x, i) => {
    const t = (check.specs[i] as KeySpec).type;
    if (x === null) return null;
    if (t === "count") {
      if (typeof x !== "number" || !Number.isSafeInteger(x)) throw bad();
      return x;
    }
    if (t === "boolean") {
      if (typeof x !== "boolean") throw bad();
      return x;
    }
    if (typeof x !== "string" || x.length > 16_384) throw bad();
    // Canonical decimal text of a bounded length: never expanded from an exponent.
    if (t === "number" && (x.length > 64 || !/^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/.test(x)))
      throw bad();
    return x;
  });
  // A business time condition, only in a call that carries one: an `at` or `during` of real
  // dates or instants, a `during` of one kind and starting before it ends.
  const date = (x: unknown): x is string =>
    typeof x === "string" && /^\d{4}-\d{2}-\d{2}$/.test(x) && isDate(x);
  const instant = (x: unknown): x is string =>
    typeof x === "string" &&
    /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/.test(x) &&
    isInstant(x);
  const point = (x: unknown): x is string => date(x) || instant(x);
  let condition: Position["condition"];
  if (has(o, "c")) {
    if (check.condition !== true) throw bad();
    const c = get(o, "c");
    if (!isObj(c)) throw bad();
    const ck = [...keysOf(c)].sort().join(",");
    const cat = get(c, "at");
    const cd = get(c, "during");
    if (ck === "at" && point(cat)) condition = { at: cat };
    else if (
      ck === "during" &&
      isDenseArray(cd) &&
      cd.length === 2 &&
      point(cd[0]) &&
      (cd[1] === null || (date(cd[0]) === date(cd[1]) && point(cd[1]) && cd[0] < cd[1]))
    )
      condition = { during: [cd[0], cd[1] as string | null] };
    else throw bad();
  }
  return {
    seq,
    at,
    restoreCount: r,
    keys,
    ...(condition !== undefined ? { condition } : {}),
    ...(since !== undefined ? { since } : {}),
  };
}
