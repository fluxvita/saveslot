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
  DateStr,
  FieldValue,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize, isInstant } from "@fluxvita/saveslot-contract-core";
import {
  compare,
  get,
  isDenseArray,
  isObj,
  keysOf,
  type Rational,
  rationalOf,
} from "../request/index.ts";
import type { QueryPlan } from "./params.ts";
import type { Flag, RowFacts, SelectedRow, Span } from "./select.ts";
import { type Interval, invalid, type Marks, ReadError, type Row, type Values } from "./types.ts";
import { meetsCondition } from "./versions.ts";

// --- marks ---------------------------------------------------------------------------------------

/** Whether a flag's spans reach the segment `[from, to)` (no spans: the whole row). */
export function spansMeet(
  spans: readonly Span[] | undefined,
  from: string,
  to: string | null,
): boolean {
  if (spans === undefined) return true;
  return spans.some((s) => (s.to === null || s.to > from) && (to === null || s.from < to));
}

/** A flag's business time as the marks give it (04-contract-types §3: `valid`). */
function markInterval(spans: readonly Span[] | undefined): Interval | undefined {
  const [s] = spans ?? [];
  if (s === undefined) return undefined;
  return s.to === null
    ? { from: s.from as BizPoint }
    : { from: s.from as BizPoint, to: s.to as BizPoint };
}

function marksOf(plan: QueryPlan, r: SelectedRow, facts: RowFacts): Marks | undefined {
  const t = plan.table;
  const name = new Map(t.fields.map((f) => [f.id as string, f.name]));
  const read = new Set<string>(plan.fields.map((f) => f.id));
  const out: {
    disputed?: { item: never; fields: string[]; valid?: Interval }[];
    awaiting?: { item: never; fields: string[]; valid?: Interval }[];
    flagged?: { item: never; reason: "duplicate_keys" }[];
    corrected?: true;
    revoked?: { seq: never };
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
    const valid = markInterval(f.spans);
    const list = out[f.flag] ?? [];
    out[f.flag] = list;
    list.push({
      item: f.item as never,
      fields: f.fields.map((x) => (x === "existence" ? "*" : (name.get(x) ?? x))),
      ...(valid !== undefined ? { valid } : {}),
    });
  }
  // corrected: an event or timeless row ever corrected; a state table's segment where a value
  // read comes from a correction (04-contract §7).
  if (r.validFrom === undefined) {
    if (facts.corrected.has(r.id)) out.corrected = true;
  } else {
    const vf = r.validFrom;
    const vt = r.validTo ?? null;
    const hit = (facts.correctSpans.get(r.id) ?? []).some(
      (c) => read.has(c.field) && (c.to === null || c.to > vf) && (vt === null || c.from < vt),
    );
    if (hit) out.corrected = true;
  }
  const revokedBy = facts.revokedBy.get(r.id);
  if (r.revoked && revokedBy !== undefined) out.revoked = { seq: revokedBy as never };
  return Object.keys(out).length === 0 ? undefined : (out as Marks);
}

/**
 * The marks of a merged row: each item's mark once (with its own interval), `corrected` when any
 * segment's is.
 */
function unionMarks(a: Marks | undefined, b: Marks | undefined): Marks | undefined {
  if (a === undefined) return b;
  if (b === undefined) return a;
  const items = <T extends { item: string }>(x?: readonly T[], y?: readonly T[]) => {
    const out = [...(x ?? [])];
    for (const m of y ?? []) if (!out.some((o) => o.item === m.item)) out.push(m);
    return out.length === 0 ? undefined : out;
  };
  const disputed = items(a.disputed, b.disputed);
  const awaiting = items(a.awaiting, b.awaiting);
  const flagged = items(a.flagged, b.flagged);
  return {
    ...(disputed !== undefined ? { disputed } : {}),
    ...(awaiting !== undefined ? { awaiting } : {}),
    ...(flagged !== undefined ? { flagged } : {}),
    ...(a.corrected === true || b.corrected === true ? { corrected: true as const } : {}),
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
  type Seg = { r: SelectedRow; marks: Marks | undefined };
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
        return {
          ...s,
          r: {
            ...s.r,
            validFrom: [vf, from].sort(cmpText)[1] as string,
            validTo: to === null ? vt : vt === null || vt > to ? to : vt,
          },
        };
      });
    }
  }

  const byId = new Map(t.fields.map((f) => [f.id as string, f]));
  const date = t.time.type === "state" && t.time.granularity === "date";
  return segs.map(({ r, marks }) => {
    const ver = facts.ver.get(r.id);
    if (ver === undefined) throw new ReadError("internal", `no version of ${r.id}`);
    const values: Record<string, FieldValue> = Object.create(null);
    for (const f of plan.fields) values[f.name] = r.values[f.id] ?? null;
    let entityKey: Values | undefined;
    if (t.time.type === "state" && t.entity_key !== undefined) {
      const k: Record<string, FieldValue> = Object.create(null);
      for (const id of t.entity_key) {
        const f = byId.get(id) as CompiledBaseField;
        k[f.name] = r.values[id] ?? null;
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
      ...(marks !== undefined ? { marks } : {}),
    };
    return { row, id: r.id, ver, values: r.values };
  });
}

// --- order ---------------------------------------------------------------------------------------

type KeyType = "number" | "text" | "plain" | "boolean" | "count";

interface KeySpec {
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

function keyType(f: CompiledBaseField): KeyType {
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

function keyValue(v: FieldValue | undefined): string | boolean | null {
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
}

export function encodePosition(identity: string, p: Position): string {
  return Buffer.from(
    JSON.stringify({ v: 1, q: identity, s: p.seq, t: p.at, r: p.restoreCount, k: p.keys }),
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
  if (!isObj(o) || [...keysOf(o)].sort().join(",") !== "k,q,r,s,t,v" || get(o, "v") !== 1)
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
  return { seq, at, restoreCount: r, keys };
}
