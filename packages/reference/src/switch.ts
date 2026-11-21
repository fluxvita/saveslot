// A schema switch in the reference evaluator (03-data-model/07-schema-evolution.md «确定性转换怎么重放»;
// 09-event-format.md §5.5 `schema.switched`): at the switch the evaluation of a row or entity is
// carried into the new version's shape item by item. Only values move: every item keeps its
// status, interval, sources, corroboration and revert registrations; operations before the switch
// were judged on the old version and are not judged again (a conversion may make two values equal,
// which changes no status). Then a constant `backfill` gives a value where the converted row or
// entity, as it exists, breaks the new definition of a field: no value where it is required, or a
// value past a bound or not among the enum values (on a state table too, 07 «确定性转换怎么重放»).
//
// The conversions are a closed set, those a switch rebuilding a table has in this version: the
// identity, a unit of the same dimension (value × old factor ÷ new factor), a precision (rounded to
// the new scale by the new rounding), a field dropped. A value is converted only when it is one: an
// explicit null (`"value": null`), `no_value` and `uncovered` are carried as they are. Expressions
// (`migrate`, an expression `backfill`) are not here. Nothing here imports the kernel: the decimal
// arithmetic is this file's own, so the comparison checks the kernel's.

import type { FieldId, FieldValue, OpNumber, Seq } from "@fluxvita/saveslot-contract-core";
import { ALL, complement, type IvSet, isEmpty, normalize, subtract, union } from "./interval.ts";
import type { Evaluation, FieldSegment, ItemContent, ItemResult, TableSchema } from "./model.ts";

export type Rounding = "half_up" | "half_even";

/** A number's shape: its unit's factor to the dimension's base unit (a quantity), its precision. */
export interface NumberShape {
  /** The unit code (a quantity); absent for a decimal or an integer. */
  readonly unit?: string;
  /** The unit's factor to its dimension's base unit, as exact decimal text. */
  readonly factor?: string;
  readonly scale: number;
  readonly rounding: Rounding;
}

/** How one field's values cross the switch. */
export type Conversion =
  | { readonly kind: "identity" }
  /** A unit of the same dimension or a precision changed: converted, then rounded (10 «精度与舍入»). */
  | { readonly kind: "number"; readonly from: NumberShape; readonly to: NumberShape }
  /** The field is gone: its items and segments too. */
  | { readonly kind: "drop" };

/** A field's constraints in the new version, as far as a constant `backfill` is judged by them. */
export interface Constraint {
  readonly required?: boolean;
  /** Bounds as exact decimal text, in the field's new unit. */
  readonly min?: string;
  readonly max?: string;
  readonly values?: readonly string[];
}

/** A switch as the reference applies it to one row or entity. */
export interface SwitchSpec {
  /** The operation and event of `schema.switched`: a constant's contribution is the switch's own. */
  readonly op: OpNumber;
  readonly event: Seq;
  /** The table as the new version defines it. */
  readonly schema: TableSchema;
  /** By field; absent: the identity. */
  readonly conversions?: Readonly<Partial<Record<FieldId, Conversion>>>;
  /** The new version's constraints, by field (what a constant fills where broken). */
  readonly constraints?: Readonly<Partial<Record<FieldId, Constraint>>>;
  /** The constant `backfill`, by field, as a value of the new version. */
  readonly backfill?: Readonly<Partial<Record<FieldId, FieldValue>>>;
}

/**
 * Where a constant gave a value, by field: on an event or timeless table the row (`[ALL]`), on a
 * state table the stretches of business time (09 §5.5 `backfill_rows/*`, `backfill/*`).
 */
export type BackfillPositions = Readonly<Partial<Record<FieldId, IvSet>>>;

export interface Switched {
  readonly evaluation: Evaluation;
  readonly backfilled: BackfillPositions;
}

// --- exact decimals ------------------------------------------------------------------------------

/** `num / 10^scale`. */
interface Dec {
  readonly num: bigint;
  readonly scale: number;
}

function parse(text: string): Dec {
  const m = /^(-?)(\d+)(?:\.(\d+))?$/.exec(text);
  if (m === null) throw new Error(`not decimal text: ${text}`);
  const frac = m[3] ?? "";
  const n = BigInt(`${m[2]}${frac}`);
  return { num: m[1] === "-" ? -n : n, scale: frac.length };
}

function text(d: Dec): string {
  const neg = d.num < 0n;
  const digits = (neg ? -d.num : d.num).toString().padStart(d.scale + 1, "0");
  const int = digits.slice(0, digits.length - d.scale);
  const frac = d.scale === 0 ? "" : digits.slice(digits.length - d.scale).replace(/0+$/, "");
  const out = `${int}${frac === "" ? "" : `.${frac}`}`;
  return neg && out !== "0" ? `-${out}` : out;
}

/** `a × p ÷ q` rounded to `scale` places by `rounding` (half_up: away from zero at exactly half). */
function scaled(a: Dec, p: Dec, q: Dec, scale: number, rounding: Rounding): Dec {
  // a × p ÷ q × 10^scale = (a.num × p.num × 10^(q.scale + scale)) ÷ (q.num × 10^(a.scale + p.scale))
  let num = a.num * p.num * 10n ** BigInt(q.scale + scale);
  let den = q.num * 10n ** BigInt(a.scale + p.scale);
  if (den < 0n) {
    num = -num;
    den = -den;
  }
  const neg = num < 0n;
  const abs = neg ? -num : num;
  let r = abs / den;
  const twice = (abs % den) * 2n;
  if (twice > den || (twice === den && (rounding === "half_up" || r % 2n === 1n))) r += 1n;
  return { num: neg ? -r : r, scale };
}

function compare(a: string, b: string): number {
  const x = parse(a);
  const y = parse(b);
  const s = Math.max(x.scale, y.scale);
  const l = x.num * 10n ** BigInt(s - x.scale);
  const r = y.num * 10n ** BigInt(s - y.scale);
  return l < r ? -1 : l > r ? 1 : 0;
}

// --- values and items ----------------------------------------------------------------------------

const ONE: Dec = { num: 1n, scale: 0 };

/** A number value (decimal text, or a quantity's) as the new shape has it. */
function convertNumber(value: string, from: NumberShape, to: NumberShape): string {
  const p = from.factor !== undefined && to.factor !== undefined ? parse(from.factor) : ONE;
  const q = from.factor !== undefined && to.factor !== undefined ? parse(to.factor) : ONE;
  return text(scaled(parse(value), p, q, to.scale, to.rounding));
}

/** A field value across a conversion; null stays null (it is no value to convert). */
export function convertValue(value: FieldValue, c: Conversion): FieldValue {
  if (value === null || c.kind !== "number") return value;
  if (typeof value === "string") return convertNumber(value, c.from, c.to);
  if (typeof value === "object" && "unit" in value) {
    return {
      ...value,
      value: convertNumber(value.value, c.from, c.to),
      unit: c.to.unit ?? value.unit,
    } as FieldValue;
  }
  throw new Error(`not a number value: ${JSON.stringify(value)}`);
}

function convertContent(content: ItemContent, c: Conversion): ItemContent {
  if (content.kind !== "value") return content;
  return { kind: "value", value: convertValue(content.value, c) };
}

/**
 * An item across the switch: on a dropped field none; on a field converted, its value converted;
 * on existence, and with any other content (`no_value`, `uncovered`), as it was. Everything else
 * about the item is kept.
 */
export function switchItem<
  T extends { readonly target: FieldId | "existence"; readonly content: ItemContent },
>(item: T, spec: SwitchSpec): T | undefined {
  if (item.target === "existence") return item;
  const c = spec.conversions?.[item.target] ?? { kind: "identity" };
  if (c.kind === "drop") return undefined;
  return c.kind === "identity" ? item : { ...item, content: convertContent(item.content, c) };
}

// --- the constant backfill -----------------------------------------------------------------------

/** Whether a value breaks a field's constraint (null breaks only `required`). */
function breaks(value: FieldValue, k: Constraint): boolean {
  if (value === null) return k.required === true;
  const n =
    typeof value === "string"
      ? value
      : typeof value === "object" && "unit" in value
        ? value.value
        : undefined;
  if (k.values !== undefined && typeof value === "string" && !k.values.includes(value)) return true;
  if (n === undefined || !/^-?\d+(\.\d+)?$/.test(n)) return false;
  return (
    (k.min !== undefined && compare(n, k.min) < 0) || (k.max !== undefined && compare(n, k.max) > 0)
  );
}

/**
 * Where a field of the converted evaluation breaks its new constraint, within the row or entity as
 * it exists: an event or timeless row not revoked (`[ALL]`), or none; on a state table the stretches
 * where the entity exists and the field has no value, or a value breaking the constraint.
 */
function broken(ev: Evaluation, f: FieldId, k: Constraint): IvSet {
  if (!ev.exists) return [];
  const existing = ev.kind === "state" ? complement(ev.gaps) : [ALL];
  const segs = ev.fields[f] ?? [];
  const covered = union(...segs.map((s) => s.valid));
  // Where the field has no segment at all: no value (a field added has none).
  const none = subtract(existing, covered);
  const bad = segs.filter((s) => breaks(s.value, k)).map((s) => s.valid);
  const out = normalize([...(k.required === true ? none : []), ...union(...bad)]);
  return ev.kind === "state" ? subtract(out, ev.gaps) : out;
}

/**
 * The evaluation of a row or entity carried across the switch, and where a constant `backfill`
 * gave a value. Items and segments of dropped fields go; values are converted; a constant is an
 * item of the switch's own event on its field, in effect where the field was broken, and the
 * field's segments there are its.
 */
export function switchEvaluation(ev: Evaluation, spec: SwitchSpec): Switched {
  const items: ItemResult[] = [];
  for (const x of ev.items) {
    const y = switchItem(x, spec);
    if (y !== undefined) items.push(y);
  }
  const fields: Partial<Record<FieldId, readonly FieldSegment[]>> = {};
  for (const [f, segs] of Object.entries(ev.fields) as [FieldId, readonly FieldSegment[]][]) {
    const c = spec.conversions?.[f] ?? { kind: "identity" };
    if (c.kind === "drop") continue;
    fields[f] = segs.map((s) => ({ ...s, value: convertValue(s.value, c) }));
  }
  // Existence (`exists`, `gaps`) is carried as it is, whatever the new version makes required: a row
  // or entity exists by its writes and revokes, never by its required fields (a required field
  // constrains the rows that exist; a write leaving it empty is refused, `required_in_gap`).
  const converted: Evaluation = { ...ev, items, fields };
  const backfilled: Partial<Record<FieldId, IvSet>> = {};
  for (const [f, value] of Object.entries(spec.backfill ?? {}) as [FieldId, FieldValue][]) {
    const where = broken(converted, f, spec.constraints?.[f] ?? {});
    if (isEmpty(where)) continue;
    backfilled[f] = where;
    const by = { event: spec.event, target: f, k: 0 };
    items.push({
      ...by,
      op: spec.op,
      status: "applied",
      valid: where,
      content: { kind: "value", value },
      registrations: [],
    });
    // The field's segments: what the constant does not cover, then the constant's.
    const kept = (fields[f] ?? []).flatMap((s) => {
      const rest = subtract(s.valid, where);
      return isEmpty(rest) ? [] : [{ ...s, valid: rest }];
    });
    fields[f] = [...kept, { valid: where, value, by }];
  }
  return { evaluation: { ...converted, items, fields }, backfilled };
}
