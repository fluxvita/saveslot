// The compilation rules of the document that creates a slot, on a document whose form is already
// read (./document.ts). Each finding is a detail with its position; all are collected, in document
// order. Rules and their places in the spec:
//
// - names: 03-data-model/10-types-and-units.md «字段类型与取值范围» (名字, 名字不分 ASCII 大小写唯一)
// - descriptions: 04-contract «schema_draft» (description_missing), 10 «字段类型与取值范围» (500 code
//   points), 04-contract §8 入口一侧 (untrusted_marker)
// - types and per-type keys: 07-schema-evolution.md «文档结构» 字段 row; 10 type table; 09 §7
// - units and precision: 10 «单位词表», «精度与舍入»
// - time, keys, groups: 07 «文档结构» (事件类表, 状态类表, 来源键, 字段组, 疑似重复 rows), 07 «字段组»;
//   09 §7 table keys
// - ref: 07 «类型» (same slot), 07 «从未被写入的表上改结构» (ref.target matches the time type),
//   07 «表间关系» (refs are between base tables)
// - derived tables: 07 «文档结构» 派生表 row (rule, field declarations); keys only base tables or
//   base fields take: 04-contract «schema_draft» (key_not_applicable, external_key_table_kind)

import type {
  DocDerivedTable,
  DocField,
  DocSlot,
  DocTable,
  SchemaDetail,
  SchemaDetailCode,
} from "./model.ts";
import { FIELD_TYPE_SET } from "./model.ts";
import { unitCandidates, unitOf } from "./units.ts";

/** ASCII case folding: names are unique without ASCII case (10 «名字不分 ASCII 大小写唯一»). */
export const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

const NAME = /^[A-Za-z][A-Za-z0-9_]{0,62}$/;
/** Field names reserved by the write and query parameters and the restricted SQL system columns. */
const RESERVED_FIELDS = new Set(["valid", "valid_from", "valid_to", "row_id", "entity_id"]);
/** Boundary markers of the surfaces' untrusted text (04-contract §8). */
const MARKERS = ["<untrusted-data-", "</untrusted-data-"];

const codePoints = (s: string): number => [...s].length;

/** Keys only some field types take (07 «文档结构» 字段 row; 09 §7 base table fields). */
const KEY_TYPES: Readonly<Record<string, readonly string[]>> = {
  min: ["integer", "decimal", "quantity"],
  max: ["integer", "decimal", "quantity"],
  values: ["enum"],
  unit: ["quantity"],
  scale: ["decimal", "quantity"],
  rounding: ["decimal", "quantity"],
  ref: ["ref"],
};

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

/** Compares two canonical decimals. */
function compareDecimal(a: string, b: string): number {
  const frac = (s: string) => s.split(".")[1]?.length ?? 0;
  const scale = Math.max(frac(a), frac(b));
  const big = (s: string) => {
    const [i = "0", f = ""] = s.split(".");
    const neg = i.startsWith("-");
    const v = BigInt(`${i.replace("-", "")}${f.padEnd(scale, "0")}`);
    return neg ? -v : v;
  };
  const x = big(a);
  const y = big(b);
  return x < y ? -1 : x > y ? 1 : 0;
}

/** `UTC`, or an Area/Location name: offsets and short names without a `/` are not IANA names. */
const TIME_ZONE_SHAPE = /^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Whether a time zone name is accepted (07 «文档结构», slot row). Provisional: of the IANA shape
 * and accepted by the runtime's `Intl.DateTimeFormat`, including aliases and other letter cases,
 * kept as written. Normalizing names and pinning the time zone database come with the read path
 * (02-architecture §8 business tables).
 */
export function isTimeZone(name: string): boolean {
  if (!TIME_ZONE_SHAPE.test(name)) return false;
  try {
    new Intl.DateTimeFormat("en-US", { timeZone: name });
    return true;
  } catch {
    return false;
  }
}

class Findings {
  readonly list: SchemaDetail[] = [];
  add(path: string, code: SchemaDetailCode, extra: Partial<SchemaDetail> = {}): void {
    this.list.push({ path, code, ...extra });
  }
}

function description(d: string | undefined, at: string, out: Findings): void {
  const p = `${at}/description`;
  if (d === undefined || d.trim() === "") out.add(p, "description_missing");
  else {
    if (codePoints(d) > 500) out.add(p, "out_of_bounds");
    if (MARKERS.some((m) => d.includes(m))) out.add(p, "untrusted_marker");
  }
}

/** The fields of a table by folded name (the first one of a name). */
export function fieldsByName(t: DocTable): Map<string, DocField> {
  const m = new Map<string, DocField>();
  for (const f of t.fields) if (!m.has(fold(f.name))) m.set(fold(f.name), f);
  return m;
}

type AnyTable = DocTable | DocDerivedTable;

const TABLES = new WeakMap<DocSlot, ReadonlyMap<string, AnyTable>>();

/** The tables of the document by folded name (the first one of a name); built once per document. */
export function tablesByName(doc: DocSlot): ReadonlyMap<string, AnyTable> {
  let m = TABLES.get(doc);
  if (m === undefined) {
    const built = new Map<string, AnyTable>();
    for (const t of doc.tables) if (!built.has(fold(t.name))) built.set(fold(t.name), t);
    TABLES.set(doc, built);
    m = built;
  }
  return m;
}

/**
 * The table a `ref.table` names: a table name of this document, or a qualified name whose slot is
 * this one. `cross_slot` for another slot's table; undefined when no table has the name.
 */
export function refTable(doc: DocSlot, name: string): AnyTable | "cross_slot" | undefined {
  const dot = name.indexOf(".");
  let table = name;
  if (dot >= 0) {
    if (fold(name.slice(0, dot)) !== fold(doc.slot)) return "cross_slot";
    table = name.slice(dot + 1);
  }
  return tablesByName(doc).get(fold(table));
}

function field(f: DocField, doc: DocSlot, seen: Set<string>, out: Findings): void {
  const at = f.path;
  if (!NAME.test(f.name) || RESERVED_FIELDS.has(fold(f.name)))
    out.add(`${at}/name`, "reserved_name");
  if (seen.has(fold(f.name))) out.add(`${at}/name`, "duplicate_name");
  seen.add(fold(f.name));
  description(f.description, at, out);
  if (!FIELD_TYPE_SET.has(f.type)) {
    out.add(`${at}/type`, "unknown_type");
    return;
  }
  for (const [k, types] of Object.entries(KEY_TYPES)) {
    if (f.keys.has(k) && !types.includes(f.type)) out.add(`${at}/${k}`, "key_not_applicable");
  }
  const numeric = f.type === "integer" || f.type === "decimal" || f.type === "quantity";
  if (numeric) {
    let inRange = true;
    for (const k of ["min", "max"] as const) {
      const v = f[k];
      if (v === undefined) continue;
      const [int = ""] = v.replace("-", "").split(".");
      const ok =
        f.type === "integer"
          ? !v.includes(".") && BigInt(v) >= INT64_MIN && BigInt(v) <= INT64_MAX
          : int.length <= 18;
      if (!ok) out.add(`${at}/${k}`, "out_of_bounds");
      inRange &&= ok;
    }
    // Compared only within the type's range: one finding on `max`, not two.
    if (inRange && f.min !== undefined && f.max !== undefined && compareDecimal(f.min, f.max) > 0) {
      out.add(`${at}/max`, "out_of_bounds");
    }
  }
  if ((f.type === "decimal" || f.type === "quantity") && f.scale !== undefined) {
    if (f.scale < 0 || f.scale > 12) out.add(`${at}/scale`, "out_of_bounds");
  }
  if (f.type === "enum" && f.values !== undefined) {
    if (f.values.length === 0 || f.values.length > 200) out.add(`${at}/values`, "out_of_bounds");
    const vs = new Set<string>();
    f.values.forEach((v, i) => {
      if (v === "" || codePoints(v) > 64) out.add(`${at}/values/${i}`, "out_of_bounds");
      // Enum values are case-sensitive (10 type table).
      if (vs.has(v)) out.add(`${at}/values/${i}`, "duplicate_entry");
      vs.add(v);
    });
  }
  if (f.type === "quantity" && f.unit !== undefined && unitOf(f.unit) === undefined) {
    out.add(`${at}/unit`, "unit_unknown", { allowed_units: unitCandidates(f.unit) });
  }
  if (f.type === "ref" && f.ref !== undefined) {
    const target = refTable(doc, f.ref.table);
    if (target === "cross_slot") out.add(`${at}/ref/table`, "cross_slot_ref");
    else if (target === undefined) out.add(`${at}/ref/table`, "unknown_reference");
    // References are between base tables (07 «表间关系»).
    else if (target.kind === "derived") out.add(`${at}/ref/table`, "key_not_applicable");
    else {
      // A row is referenced on an event or timeless table, an entity on a state table.
      const state = target.time.type === "state";
      if ((f.ref.target === "entity") !== state) out.add(`${at}/ref/target`, "key_not_applicable");
    }
  }
}

/**
 * A list of field names: each a field of the table and listed once. Returns the fields found, by
 * position.
 */
function names(
  list: readonly string[],
  at: string,
  byName: ReadonlyMap<string, DocField>,
  out: Findings,
  seen: Set<string> = new Set(),
): (DocField | undefined)[] {
  return list.map((n, i) => {
    const f = byName.get(fold(n));
    if (f === undefined) out.add(`${at}/${i}`, "unknown_reference");
    else if (seen.has(fold(n))) out.add(`${at}/${i}`, "duplicate_entry");
    seen.add(fold(n));
    return f;
  });
}

function table(t: DocTable, doc: DocSlot, out: Findings): void {
  const at = t.path;
  const byName = fieldsByName(t);
  if (t.keys.has("rule")) out.add(`${at}/rule`, "key_not_applicable");
  if (t.fields.length === 0) out.add(`${at}/fields`, "out_of_bounds", { min: "1" });
  const seen = new Set<string>();
  for (const f of t.fields) field(f, doc, seen, out);

  if (t.time.type === "event") {
    // The event time is a date or a zoned date-time, and every row has one.
    const f = byName.get(fold(t.time.field));
    if (f === undefined) out.add(`${at}/time/field`, "unknown_reference");
    else if ((f.type !== "date" && f.type !== "zoned_datetime") || !f.required) {
      out.add(`${at}/time/field`, "key_not_applicable");
    }
  }
  const state = t.time.type === "state";

  if (t.entity_key !== undefined) {
    const p = `${at}/entity_key`;
    if (!state) out.add(p, "key_not_applicable");
    else {
      if (t.entity_key.length === 0) out.add(p, "out_of_bounds");
      names(t.entity_key, p, byName, out).forEach((f, i) => {
        if (f !== undefined && !f.required) out.add(`${p}/${i}`, "entity_key_not_required");
      });
    }
  }

  const grouped = new Set((t.together ?? []).flat().map(fold));
  if (t.external_key !== undefined) {
    const p = `${at}/external_key`;
    if (state) out.add(p, "external_key_table_kind");
    else {
      if (t.external_key.length === 0 || t.external_key.length > 4) out.add(p, "out_of_bounds");
      names(t.external_key, p, byName, out).forEach((f, i) => {
        if (f === undefined) return;
        if (!["text", "enum", "integer"].includes(f.type)) {
          out.add(`${p}/${i}`, "external_key_field_type");
        }
        if (grouped.has(fold(f.name))) out.add(`${p}/${i}`, "external_key_in_together");
      });
    }
  }

  if (t.together !== undefined) {
    // A field in at most one group: its conflict unit is one.
    const inGroup = new Set<string>();
    t.together.forEach((g, i) => {
      const p = `${at}/together/${i}`;
      if (g.length < 2) out.add(p, "out_of_bounds");
      names(g, p, byName, out, inGroup);
    });
  }

  if (t.duplicate_keys !== undefined) {
    const p = `${at}/duplicate_keys`;
    if (state) out.add(p, "key_not_applicable");
    else {
      t.duplicate_keys.forEach((g, i) => {
        if (g.length === 0) out.add(`${p}/${i}`, "out_of_bounds");
        names(g, `${p}/${i}`, byName, out);
      });
    }
  }
}

/** Keys only base fields take. */
const BASE_FIELD_KEYS = ["required", "min", "max", "values", "ref"];
/** Keys only base tables take; `external_key` has its own code. */
const BASE_TABLE_KEYS = ["time", "entity_key", "together", "duplicate_keys"];

/**
 * A derived table: its fields' names and descriptions as a base table's; a declared `type` only
 * `decimal`, a declared `unit` from `units@1`, a scale in 0–12. Its rule is compiled after these.
 */
function derivedTable(t: DocDerivedTable, out: Findings): void {
  const at = t.path;
  for (const k of BASE_TABLE_KEYS) if (t.keys.has(k)) out.add(`${at}/${k}`, "key_not_applicable");
  if (t.keys.has("external_key")) out.add(`${at}/external_key`, "external_key_table_kind");
  if (t.fields.length === 0) out.add(`${at}/fields`, "out_of_bounds", { min: "1" });
  const seen = new Set<string>();
  for (const f of t.fields) {
    const p = f.path;
    if (!NAME.test(f.name) || RESERVED_FIELDS.has(fold(f.name)))
      out.add(`${p}/name`, "reserved_name");
    if (seen.has(fold(f.name))) out.add(`${p}/name`, "duplicate_name");
    seen.add(fold(f.name));
    description(f.description, p, out);
    for (const k of BASE_FIELD_KEYS) if (f.keys.has(k)) out.add(`${p}/${k}`, "key_not_applicable");
    if (f.type !== undefined) {
      if (!FIELD_TYPE_SET.has(f.type)) out.add(`${p}/type`, "unknown_type");
      // Only a product or quotient of quantities is declared, as decimal (07 «文档结构»).
      else if (f.type !== "decimal") out.add(`${p}/type`, "key_not_applicable");
    }
    if (f.unit !== undefined) {
      if (f.type === "decimal") out.add(`${p}/unit`, "key_not_applicable");
      else if (unitOf(f.unit) === undefined)
        out.add(`${p}/unit`, "unit_unknown", { allowed_units: unitCandidates(f.unit) });
    }
    if (f.scale !== undefined && (f.scale < 0 || f.scale > 12))
      out.add(`${p}/scale`, "out_of_bounds");
  }
}

/**
 * How large a slot may be (values for now, 08-open-questions «接口的数值与细则»): slots in a
 * tenant, tables in a slot (base and derived together), fields in a table. Past them a document
 * is refused at once, before it is compiled or stored: a larger one took the one write transaction
 * for seconds and then failed in the store.
 */
export const SLOTS_MAX = 100;
export const TABLES_MAX = 100;
export const FIELDS_MAX = 200;

/** Every finding of the document, in document order. Empty when it compiles. */
export function validate(doc: DocSlot, existingSlotNames: readonly string[]): SchemaDetail[] {
  const out = new Findings();
  if (!NAME.test(doc.slot)) out.add("slot", "reserved_name");
  if (existingSlotNames.some((n) => fold(n) === fold(doc.slot))) out.add("slot", "duplicate_name");
  if (existingSlotNames.length >= SLOTS_MAX) {
    out.add("slot", "out_of_bounds", { max: String(SLOTS_MAX) });
  }
  if (!isTimeZone(doc.timezone)) out.add("timezone", "timezone_unknown");
  if (doc.tables.length > TABLES_MAX) {
    out.add("tables", "out_of_bounds", { max: String(TABLES_MAX) });
    // Each table past the bound is not looked at: the document is refused already.
    return out.list;
  }
  // A slot holds something to write to: at least one base table.
  if (!doc.tables.some((t) => t.kind !== "derived")) {
    out.add("tables", "out_of_bounds", { min: "1" });
  }
  const seen = new Set<string>();
  for (const t of doc.tables) {
    if (t.fields.length > FIELDS_MAX) {
      out.add(`${t.path}/fields`, "out_of_bounds", { max: String(FIELDS_MAX) });
      continue;
    }
    if (!NAME.test(t.name)) out.add(`${t.path}/name`, "reserved_name");
    if (seen.has(fold(t.name))) out.add(`${t.path}/name`, "duplicate_name");
    seen.add(fold(t.name));
    description(t.description, t.path, out);
    if (t.kind === "derived") derivedTable(t, out);
    else table(t, doc, out);
  }
  return out.list;
}
