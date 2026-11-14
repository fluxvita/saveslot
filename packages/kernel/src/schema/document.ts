// The form of the schema document that creates a slot (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式», «文档结构»): which keys there are, their JSON types, the keys v1 does not
// support. Rules about the values (names, references, ranges) are ./validate.ts.
//
// Keys only a change to an existing slot has (`id`, `rename_to`, `drop_tables`, `drop_fields`,
// `migrate`, `backfill`) are unknown keys here: refused, never ignored, so a misspelt key is not
// silently dropped.

import type { CompileError, DocField, DocSlot, DocTable, DocTime } from "./model.ts";

type Obj = Record<string, unknown>;

export const isObject = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v);

const TOP_KEYS = ["slot", "base_version", "timezone", "tables"];
const TABLE_KEYS = [
  "name",
  "kind",
  "description",
  "time",
  "fields",
  "entity_key",
  "external_key",
  "together",
  "duplicate_keys",
];
const FIELD_KEYS = [
  "name",
  "type",
  "description",
  "required",
  "min",
  "max",
  "values",
  "unit",
  "scale",
  "rounding",
  "ref",
];
/** Keys a field of a type must have. */
const NEEDS: Readonly<Record<string, string>> = { enum: "values", quantity: "unit", ref: "ref" };

/** Reserved for official schemas, not in v1 (07 «文档结构» 官方 schema; «改动分类» end). */
const OFFICIAL = ["extends", "compatibility"];

const arr = (v: unknown): readonly unknown[] => (Array.isArray(v) ? v : []);
const objs = (v: unknown): [Obj, number][] =>
  arr(v).flatMap((x, i): [Obj, number][] => (isObject(x) ? [[x, i]] : []));

/**
 * The first key v1 does not support, in document order: `extends` / `compatibility` on the
 * document or a table, `reextract` on a field. Looks only where the containers have the right type.
 */
export function unsupportedKey(doc: Obj): CompileError | undefined {
  const at = (param: string): CompileError => ({ code: "not_in_this_version", param });
  for (const k of OFFICIAL) if (k in doc) return at(k);
  for (const [t, i] of objs(doc["tables"])) {
    for (const k of OFFICIAL) if (k in t) return at(`tables/${i}/${k}`);
    for (const [f, j] of objs(t["fields"])) {
      if ("reextract" in f) return at(`tables/${i}/fields/${j}/reextract`);
    }
  }
  return undefined;
}

/**
 * The first thing in v1 that this compiler does not compile yet, in document order: a draft that
 * changes a slot (`base_version` not null), a derived table, aliases.
 */
export function notYet(doc: Obj): CompileError | undefined {
  const at = (what: string, param: string): CompileError => ({
    code: "not_implemented",
    what,
    param,
  });
  const bv = doc["base_version"];
  if (bv !== null && bv !== undefined && typeof bv === "number") {
    return at("a draft changing a slot", "base_version");
  }
  for (const [t, i] of objs(doc["tables"])) {
    if (t["kind"] === "derived") return at("a derived table", `tables/${i}`);
    if ("aliases" in t) return at("aliases", `tables/${i}/aliases`);
    for (const [f, j] of objs(t["fields"])) {
      if ("aliases" in f) return at("aliases", `tables/${i}/fields/${j}/aliases`);
    }
  }
  return undefined;
}

/** A form error, thrown to stop at the first one. */
class FormError extends Error {
  readonly reason: "missing" | "malformed";
  readonly param: string;
  constructor(reason: "missing" | "malformed", param: string) {
    super(`${reason} ${param}`);
    this.reason = reason;
    this.param = param;
  }
}

const malformed = (param: string) => new FormError("malformed", param);

function object(v: unknown, at: string, allowed: readonly string[], required: readonly string[]) {
  if (!isObject(v)) throw malformed(at);
  const prefix = at === "" ? "" : `${at}/`;
  for (const k of Object.keys(v)) if (!allowed.includes(k)) throw malformed(`${prefix}${k}`);
  for (const k of required) if (!(k in v)) throw new FormError("missing", `${prefix}${k}`);
  return v;
}

/** A string, well-formed Unicode: a lone surrogate cannot be encoded into the log (09 §1.2). */
function string(v: unknown, at: string): string {
  if (typeof v !== "string" || !v.isWellFormed()) throw malformed(at);
  return v;
}

function strings(v: unknown, at: string): string[] {
  if (!Array.isArray(v)) throw malformed(at);
  return v.map((x, i) => string(x, `${at}/${i}`));
}

function groups(v: unknown, at: string): string[][] {
  if (!Array.isArray(v)) throw malformed(at);
  return v.map((g, i) => strings(g, `${at}/${i}`));
}

const DECIMAL_TEXT = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?$/;

/** Canonical text of a decimal written without an exponent (09 §1.2): no trailing zeros, no `-0`. */
function canonical(text: string): string {
  const s = text.includes(".") ? text.replace(/0+$/, "").replace(/\.$/, "") : text;
  return s === "-0" ? "0" : s;
}

/**
 * `min` / `max`: a decimal string, or a JSON number that is a safe integer. A bound with a fraction
 * is written as a string: once parsed, a JSON number no longer tells what the caller wrote.
 */
function decimal(v: unknown, at: string): string {
  if (typeof v === "string") {
    if (!DECIMAL_TEXT.test(v)) throw malformed(at);
    return canonical(v);
  }
  if (typeof v === "number" && Number.isSafeInteger(v)) return canonical(String(v));
  throw malformed(at);
}

function time(v: unknown, at: string): DocTime {
  if (!isObject(v)) throw malformed(at);
  const type = v["type"];
  if (!("type" in v)) throw new FormError("missing", `${at}/type`);
  if (type === "none") {
    object(v, at, ["type"], ["type"]);
    return { type };
  }
  if (type === "event") {
    const t = object(v, at, ["type", "field"], ["type", "field"]);
    return { type, field: string(t["field"], `${at}/field`) };
  }
  if (type === "state") {
    const t = object(v, at, ["type", "granularity"], ["type", "granularity"]);
    const g = t["granularity"];
    if (g !== "date" && g !== "instant") throw malformed(`${at}/granularity`);
    return { type, granularity: g };
  }
  throw malformed(`${at}/type`);
}

function field(v: unknown, at: string): DocField {
  const f = object(v, at, FIELD_KEYS, ["name", "type"]);
  const type = string(f["type"], `${at}/type`);
  const need = Object.hasOwn(NEEDS, type) ? NEEDS[type] : undefined;
  if (need !== undefined && !(need in f)) throw new FormError("missing", `${at}/${need}`);
  const out: {
    -readonly [K in keyof DocField]: DocField[K];
  } = {
    path: at,
    name: string(f["name"], `${at}/name`),
    type,
    required: false,
    keys: new Set(Object.keys(f)),
  };
  if ("description" in f) out.description = string(f["description"], `${at}/description`);
  if ("required" in f) {
    if (typeof f["required"] !== "boolean") throw malformed(`${at}/required`);
    out.required = f["required"];
  }
  if ("min" in f) out.min = decimal(f["min"], `${at}/min`);
  if ("max" in f) out.max = decimal(f["max"], `${at}/max`);
  if ("values" in f) {
    out.values = strings(f["values"], `${at}/values`);
    // Writes compare the same string: NFC, no control characters, no surrounding white space
    // (10 type table, enum).
    out.values.forEach((x, i) => {
      if (x.normalize("NFC") !== x || /\p{Cc}/u.test(x) || /^\s|\s$/u.test(x)) {
        throw malformed(`${at}/values/${i}`);
      }
    });
  }
  if ("unit" in f) out.unit = string(f["unit"], `${at}/unit`);
  if ("scale" in f) {
    const s = f["scale"];
    if (typeof s !== "number" || !Number.isInteger(s)) throw malformed(`${at}/scale`);
    out.scale = s === 0 ? 0 : s;
  }
  if ("rounding" in f) {
    const r = f["rounding"];
    if (r !== "half_up" && r !== "half_even") throw malformed(`${at}/rounding`);
    out.rounding = r;
  }
  if ("ref" in f) {
    const r = object(f["ref"], `${at}/ref`, ["table", "target"], ["table", "target"]);
    const target = r["target"];
    if (target !== "row" && target !== "entity") throw malformed(`${at}/ref/target`);
    out.ref = { table: string(r["table"], `${at}/ref/table`), target };
  }
  return out;
}

function table(v: unknown, at: string): DocTable {
  const t = object(v, at, TABLE_KEYS, ["name", "kind", "time", "fields"]);
  // `derived` is stopped before the form is read (notYet).
  if (t["kind"] !== "base") throw malformed(`${at}/kind`);
  const fields = t["fields"];
  if (!Array.isArray(fields)) throw malformed(`${at}/fields`);
  const out: { -readonly [K in keyof DocTable]: DocTable[K] } = {
    path: at,
    name: string(t["name"], `${at}/name`),
    time: time(t["time"], `${at}/time`),
    fields: fields.map((f, i) => field(f, `${at}/fields/${i}`)),
  };
  if ("description" in t) out.description = string(t["description"], `${at}/description`);
  if ("entity_key" in t) out.entity_key = strings(t["entity_key"], `${at}/entity_key`);
  if ("external_key" in t) out.external_key = strings(t["external_key"], `${at}/external_key`);
  if ("together" in t) out.together = groups(t["together"], `${at}/together`);
  if ("duplicate_keys" in t)
    out.duplicate_keys = groups(t["duplicate_keys"], `${at}/duplicate_keys`);
  return out;
}

/** Reads the document's form, or the first form error in document order. */
export function readDocument(doc: Obj): DocSlot | CompileError {
  try {
    const d = object(doc, "", TOP_KEYS, TOP_KEYS);
    // A slot is created only from a draft without a base version (07 «并发»).
    if (d["base_version"] !== null) throw malformed("base_version");
    const tables = d["tables"];
    if (!Array.isArray(tables)) throw malformed("tables");
    return {
      slot: string(d["slot"], "slot"),
      timezone: string(d["timezone"], "timezone"),
      tables: tables.map((t, i) => table(t, `tables/${i}`)),
    };
  } catch (e) {
    if (e instanceof FormError) {
      return { code: "invalid_argument", reason: e.reason, param: e.param };
    }
    throw e;
  }
}
