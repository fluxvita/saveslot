// A version's events in the shape of the next version (07-schema-evolution «确定性转换怎么重放»;
// 09-event-format §5.9 for the deletion blocks). One family of pure functions: an item of a base
// write, a stretch of a deletion result, a restated judgement. Each changes only values, and only
// values that are there: `null`, `no_value` and `uncovered` pass as they are; sources, intervals,
// `deps`, existence and the outcome of a result are never touched.
//
// A field the new version dropped takes its items with it. A field the new version added has no
// item in an old write: its value comes only from the switch's backfill positions.
// Two old values that become one new value are left as they are: they are compared at the next
// operation after the switch, not here.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  ConstBackfill,
  FieldId,
  FieldItemBlock,
  FieldValue,
  RestatedBlock,
  ResultExistenceBlock,
  ResultFieldBlock,
  ResultTargetBlock,
  SourcesBlock,
  SpanBlock,
} from "@fluxvita/saveslot-contract-core";
import { convertValue, type NumberShape } from "../values/index.ts";

/** A value through a field's map: the value as the new version has it, or why it cannot be. */
export type ConvertResult =
  | { readonly ok: true; readonly value: FieldValue }
  | { readonly ok: false; readonly why: "out_of_range" | "unit_dimension" };

/** What happens to a field's values between two versions of a table. */
export type FieldMap =
  | { readonly op: "keep" }
  | { readonly op: "drop" }
  | { readonly op: "convert"; readonly from: NumberShape; readonly to: NumberShape };

/** A table between two versions: each field of the old version, and the fields the new one adds. */
export interface TableMap {
  readonly fields: ReadonlyMap<FieldId, FieldMap>;
  readonly added: readonly { readonly field: FieldId; readonly backfill?: ConstBackfill }[];
}

const KEEP: FieldMap = { op: "keep" };
const DROP: FieldMap = { op: "drop" };

const shapeOf = (f: CompiledBaseField): NumberShape | undefined =>
  f.type === "quantity"
    ? { unit: f.unit, ...f.precision }
    : f.type === "decimal"
      ? { ...f.precision }
      : undefined;

/**
 * A field's values change only when its unit changes or its scale goes down. A larger scale, or a
 * new rounding at the same scale, leaves every stored value as it is (each already has at most the
 * old scale's digits).
 */
function fieldMapOf(from: CompiledBaseField, to: CompiledBaseField): FieldMap {
  const a = shapeOf(from);
  const b = shapeOf(to);
  if (a === undefined || b === undefined) return KEEP;
  const unitChanged = a.unit !== undefined && b.unit !== undefined && a.unit.code !== b.unit.code;
  if (!unitChanged && b.scale >= a.scale) return KEEP;
  return { op: "convert", from: a, to: b };
}

/** The map of a base table from one version's definition to the next (fields matched by ID). */
export function tableMapOf(from: CompiledBaseTable, to: CompiledBaseTable): TableMap {
  const next = new Map(to.fields.map((f) => [f.id, f] as const));
  const before = new Set(from.fields.map((f) => f.id));
  const fields = new Map<FieldId, FieldMap>();
  for (const f of from.fields) {
    const g = next.get(f.id);
    fields.set(f.id, g === undefined ? DROP : fieldMapOf(f, g));
  }
  const added = to.fields
    .filter((g) => !before.has(g.id))
    .map((g) =>
      g.backfill !== undefined && "const" in g.backfill
        ? { field: g.id, backfill: g.backfill }
        : { field: g.id },
    );
  return { fields, added };
}

/** One value through a field's map. Only a present value is converted; `null` stays `null`. */
export function convertFieldValue(m: FieldMap, v: FieldValue): ConvertResult {
  if (m.op !== "convert" || v === null) return { ok: true, value: v };
  // A decimal is its canonical text; a quantity is `{value, unit}` in the field's unit.
  const text =
    typeof v === "string" ? v : typeof v === "object" && "unit" in v ? v.value : undefined;
  if (text === undefined) return { ok: true, value: v };
  const r = convertValue(text, m.from, m.to);
  if (!r.ok) return r;
  if (typeof v === "string") return { ok: true, value: r.value };
  return {
    ok: true,
    value: { value: r.value, unit: m.to.unit?.code ?? (v as { unit: string }).unit },
  };
}

const mapOf = (t: TableMap, field: FieldId): FieldMap => t.fields.get(field) ?? KEEP;

/** A conversion that could not be made, and where. */
export interface ConvertFailure {
  readonly ok: false;
  readonly field: FieldId;
  readonly why: "out_of_range" | "unit_dimension";
}

// --- 1. an item of a base write: `fields/<f>/<k>` with its `sources/<f>/<k>` and `span/<f>/<k>` ---

export interface ItemIn {
  readonly item: FieldItemBlock;
  readonly sources?: SourcesBlock;
  readonly span?: SpanBlock;
}

export type ItemOut = { readonly ok: true; readonly x: ItemIn | null } | ConvertFailure;

/** `x: null`: the field was dropped, and the item with it. */
export function convertItem(t: TableMap, field: FieldId, x: ItemIn): ItemOut {
  const m = mapOf(t, field);
  if (m.op === "drop") return { ok: true, x: null };
  if (!("value" in x.item) || x.item.value === undefined) return { ok: true, x };
  const r = convertFieldValue(m, x.item.value);
  if (!r.ok) return { ok: false, field, why: r.why };
  return r.value === x.item.value
    ? { ok: true, x }
    : { ok: true, x: { ...x, item: { ...x.item, value: r.value } } };
}

// --- 2. a stretch of a deletion result: `results/<k>` -------------------------------------------

export interface ResultIn {
  readonly target: ResultTargetBlock;
  readonly fields: readonly {
    readonly field: FieldId;
    readonly j: number;
    readonly block: ResultFieldBlock;
  }[];
  readonly existence?: ResultExistenceBlock;
}

export type ResultOut = { readonly ok: true; readonly r: ResultIn } | ConvertFailure;

/** Dropped fields' stretches go; `target` (outcome included) and `existence` are kept as they are. */
export function convertResult(t: TableMap, r: ResultIn): ResultOut {
  const fields: ResultIn["fields"][number][] = [];
  for (const e of r.fields) {
    const m = mapOf(t, e.field);
    if (m.op === "drop") continue;
    const v = convertFieldValue(m, e.block.value);
    if (!v.ok) return { ok: false, field: e.field, why: v.why };
    fields.push(v.value === e.block.value ? e : { ...e, block: { ...e.block, value: v.value } });
  }
  return { ok: true, r: { ...r, fields } };
}

// --- 3. a restated judgement: `restated/<k>` -----------------------------------------------------

export type RestatedOut = { readonly ok: true; readonly r: RestatedBlock | null } | ConvertFailure;

/** `r: null`: a field contribution of a dropped field. Existence judgements are kept as they are. */
export function convertRestated(t: TableMap, r: RestatedBlock): RestatedOut {
  if (!("field" in r)) return { ok: true, r };
  const m = mapOf(t, r.field);
  if (m.op === "drop") return { ok: true, r: null };
  if (r.value === undefined) return { ok: true, r };
  const v = convertFieldValue(m, r.value);
  if (!v.ok) return { ok: false, field: r.field, why: v.why };
  return { ok: true, r: v.value === r.value ? r : { ...r, value: v.value } };
}
