// `query`'s parameters, checked and normalized (docs/zh-CN/spec/04-contract.md §1, §4, §10 `query`;
// 04-contract-types.md §4.3): the table, the fields, the conditions, the order, the business time
// and the evaluation time, the page. The caller's objects are read by their own keys only, as for
// writes; names, values and business time by the same rules as in writes (`request`).
//
// Comparison values are kept exact: a decimal, integer or quantity value is a rational in the
// field's unit, never rounded to the field's scale (rounding would move it across stored values).

import type {
  BizPoint,
  CompiledBaseField,
  CompiledBaseTable,
  Instant,
} from "@fluxvita/saveslot-contract-core";
import {
  decimalText,
  divide,
  fold,
  get,
  has,
  instantText,
  isDenseArray,
  isJsonNumber,
  isObj,
  keysOf,
  multiply,
  nearest,
  normalizeValue,
  type Obj,
  parseDateTime,
  parseDecimal,
  type Rational,
  rationalOf,
  validDate,
} from "../request/index.ts";
import { unitOf } from "../schema/index.ts";
import { dateInZone, nextDay, startOfDay } from "../time/index.ts";
import type { NamedTable } from "./slots.ts";
import { invalid, notImplemented, ReadError, type ReadWarning } from "./types.ts";

export type TableKind = "event" | "state" | "timeless";

export type WhereOp = "=" | "!=" | "<" | "<=" | ">" | ">=" | "in" | "contains" | "is_null";
const OPS: ReadonlySet<string> = new Set([
  "=",
  "!=",
  "<",
  "<=",
  ">",
  ">=",
  "in",
  "contains",
  "is_null",
]);
const ORDERED = new Set(["integer", "decimal", "quantity", "date", "zoned_datetime"]);

/** A comparison value, normalized for its column. */
export type Literal =
  | { readonly kind: "text"; readonly value: string } // text, enum, ref; a date; an interval point
  | { readonly kind: "boolean"; readonly value: boolean }
  | { readonly kind: "instant"; readonly value: Instant } // zoned date-times compare by instant
  | { readonly kind: "number"; readonly value: Rational }; // in the field's unit, exact

export type Condition =
  | {
      readonly column: CompiledBaseField | "valid_from" | "valid_to";
      readonly op: "=" | "!=" | "<" | "<=" | ">" | ">=" | "contains";
      readonly value: Literal;
    }
  | {
      readonly column: CompiledBaseField | "valid_from" | "valid_to";
      readonly op: "in";
      readonly values: readonly Literal[];
    }
  | {
      readonly column: CompiledBaseField | "valid_from" | "valid_to";
      readonly op: "is_null";
      readonly isNull: boolean;
    };

export type BusinessTime =
  /** No time given: state tables read the point `point` (the evaluation time, or its day). */
  | { readonly kind: "now"; readonly point: BizPoint }
  | { readonly kind: "at"; readonly point: BizPoint }
  | { readonly kind: "during"; readonly from: BizPoint; readonly to: BizPoint | null };

export interface QueryPlan {
  readonly named: NamedTable;
  readonly table: CompiledBaseTable;
  readonly kind: TableKind;
  /** The fields given back, in the table's order. */
  readonly fields: readonly CompiledBaseField[];
  /** Whether `fields` was given (marks only for fields read, 04-contract §7). */
  readonly fieldsGiven: boolean;
  readonly where: readonly Condition[];
  readonly order: readonly { readonly field: CompiledBaseField; readonly dir: "asc" | "desc" }[];
  readonly time: BusinessTime;
  readonly clip: boolean;
  readonly coalesce: boolean;
  readonly includeRevoked: boolean;
  readonly limit: number;
  /** The page to continue (./rows.ts `Position`), as given. */
  readonly position: string | undefined;
  /** The evaluation time (`at`, or the entry's "now"). */
  readonly at: Instant;
  readonly task: string | null;
  readonly warnings: readonly ReadWarning[];
}

const KEYS = new Set([
  "table",
  "where",
  "order",
  "fields",
  "valid_at",
  "valid_during",
  "clip",
  "coalesce",
  "at",
  "include_revoked",
  "detail",
  "limit",
  "position",
  "task",
]);
export const DEFAULT_LIMIT = 20;
export const MAX_LIMIT = 200;
const MAX_TASK_CHARS = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export function kindOf(t: CompiledBaseTable): TableKind {
  return t.time.type === "state" ? "state" : t.time.type === "event" ? "event" : "timeless";
}

/** A field by name, without case; `unknown_field` with the nearest names (aliases first). */
function fieldNamed(t: CompiledBaseTable, name: unknown, param: string): CompiledBaseField {
  if (typeof name !== "string" || name === "") throw invalid("malformed", param);
  const f = t.fields.find((x) => fold(x.name) === fold(name));
  if (f === undefined) {
    throw new ReadError("unknown_field", `unknown field ${JSON.stringify(name)}`, {
      param,
      name,
      nearest: nearest(
        name,
        t.fields.map((x) => ({ name: x.name, aliases: x.aliases ?? [] })),
      ),
    });
  }
  return f;
}

const bool = (o: Obj, key: string, dflt: boolean): boolean => {
  if (!has(o, key)) return dflt;
  const v = get(o, key);
  if (typeof v !== "boolean") throw invalid("malformed", key);
  return v;
};

/**
 * `clip` / `coalesce`: only for a state table read over an interval (04-contract §4); elsewhere they
 * are refused, not ignored.
 */
function intervalOnly(
  params: Obj,
  key: string,
  dflt: boolean,
  kind: TableKind,
  time: BusinessTime,
): boolean {
  if (!has(params, key)) return dflt;
  if (kind !== "state") throw invalid("not_state_table", key);
  if (time.kind !== "during") throw invalid("malformed", key);
  return bool(params, key, dflt);
}

/**
 * A business time point at `param` for a granularity, as writes read one (04-contract §4 «日期与
 * 时刻的换算»): a date table given an instant takes its day in the slot's zone (`time_truncated`);
 * an instant table given a date is `granularity`, unless `dayStart` (an event table's zoned time
 * field: the natural day) takes the day's first instant.
 */
export function bizPoint(
  v: unknown,
  param: string,
  g: "date" | "instant",
  zone: string,
  warnings: ReadWarning[],
  dayStart = false,
): BizPoint {
  if (typeof v !== "string") throw invalid("malformed", param);
  if (validDate(v)) {
    if (g === "date") return v;
    if (dayStart) return instantText(startOfDay(v, zone));
    throw invalid("granularity", param, {
      example: {
        valid_during: [instantText(startOfDay(v, zone)), instantText(startOfDay(nextDay(v), zone))],
      },
    });
  }
  const p = parseDateTime(v, zone, false);
  if (!p.ok) throw invalid("malformed", param);
  if (p.assumed) warnings.push({ code: "timezone_assumed", param, timezone: zone });
  if (g === "instant") return instantText(p.epochMs);
  const day = dateInZone(p.epochMs, zone);
  if (!validDate(day)) throw invalid("malformed", param);
  warnings.push({ code: "time_truncated", param, from: instantText(p.epochMs), to: day });
  return day;
}

/** The granularity of a table's business time: a state table's, an event table's time field's. */
function granularityOf(t: CompiledBaseTable): "date" | "instant" | undefined {
  if (t.time.type === "state") return t.time.granularity;
  if (t.time.type === "event") {
    const id = t.time.field;
    const f = t.fields.find((x) => x.id === id);
    return f?.type === "date" ? "date" : "instant";
  }
  return undefined;
}

/** A value normalized by the field's write rules; any problem is `malformed` at `param`. */
function written(
  f: CompiledBaseField,
  v: unknown,
  param: string,
  zone: string,
  warnings: ReadWarning[],
) {
  const r = normalizeValue(f, v, { op: 0, name: f.name, zone });
  if (!r.ok) {
    const extra: Record<string, unknown> = {};
    if (f.type === "enum") extra["allowed_values"] = f.values;
    if (f.type === "zoned_datetime")
      extra["example"] = { value: "2026-11-10T12:00:00+08:00[Asia/Shanghai]" };
    throw invalid("malformed", param, extra);
  }
  // A date-time with neither an offset nor a zone was read in the slot's: say so (04-contract §1).
  // With an offset nothing is assumed: comparisons are by instant.
  if (f.type === "zoned_datetime" && typeof v === "string") {
    const p = parseDateTime(v, zone, true);
    if (p.ok && p.assumed) warnings.push({ code: "timezone_assumed", param, timezone: zone });
  }
  return r.value;
}

/** An exact number in the field's unit; a quantity's unit converted exactly (not rounded). */
function exactNumber(f: CompiledBaseField, v: unknown, param: string): Rational {
  let text: unknown = v;
  let factor: Rational | undefined;
  if (f.type === "quantity") {
    if (!isObj(v) || keysOf(v).some((k) => k !== "value" && k !== "unit"))
      throw invalid("malformed", param);
    const unit = get(v, "unit");
    if (typeof unit !== "string") throw invalid("malformed", param);
    const u = unitOf(unit);
    if (u === undefined) throw invalid("malformed", param);
    if (u.code !== f.unit.code) {
      if (
        u.dimension !== f.unit.dimension ||
        u.to_base === undefined ||
        f.unit.to_base === undefined
      )
        throw invalid("malformed", param);
      factor = divide(rationalOf(u.to_base), rationalOf(f.unit.to_base));
    }
    text = get(v, "value");
  }
  const t = decimalText(text);
  if (!t.ok) throw invalid("malformed", param);
  // Integer digits as for writes, with room for a unit conversion.
  const p = parseDecimal(t.text, 30);
  if (!p.ok) throw invalid("malformed", param);
  return factor === undefined ? p.value : multiply(p.value, factor);
}

function literal(
  column: CompiledBaseField | "valid_from" | "valid_to",
  v: unknown,
  param: string,
  plan: {
    readonly zone: string;
    readonly g: "date" | "instant" | undefined;
    warnings: ReadWarning[];
  },
): Literal {
  if (typeof column === "string") {
    const g = plan.g as "date" | "instant";
    return { kind: "text", value: bizPoint(v, param, g, plan.zone, plan.warnings) };
  }
  const f = column;
  switch (f.type) {
    case "integer":
    case "decimal":
    case "quantity":
      return { kind: "number", value: exactNumber(f, v, param) };
    case "boolean":
      return { kind: "boolean", value: written(f, v, param, plan.zone, plan.warnings) as boolean };
    case "zoned_datetime":
      return {
        kind: "instant",
        value: (written(f, v, param, plan.zone, plan.warnings) as { instant: Instant }).instant,
      };
    default:
      return { kind: "text", value: written(f, v, param, plan.zone, plan.warnings) as string };
  }
}

function condition(
  t: CompiledBaseTable,
  c: unknown,
  param: string,
  ctx: {
    zone: string;
    g: "date" | "instant" | undefined;
    during: boolean;
    warnings: ReadWarning[];
  },
): Condition {
  if (!isObj(c)) throw invalid("malformed", param);
  for (const k of keysOf(c))
    if (k !== "field" && k !== "op" && k !== "value") throw invalid("malformed", `${param}/${k}`);
  if (!has(c, "field")) throw invalid("missing", `${param}/field`);
  if (!has(c, "op")) throw invalid("missing", `${param}/op`);
  const name = get(c, "field");
  let column: CompiledBaseField | "valid_from" | "valid_to";
  if (name === "valid_from" || name === "valid_to") {
    // Only on a state table read over an interval (04-contract §4).
    if (t.time.type !== "state" || !ctx.during) throw invalid("malformed", `${param}/field`);
    column = name;
  } else column = fieldNamed(t, name, `${param}/field`);
  const op = get(c, "op");
  if (typeof op !== "string" || !OPS.has(op)) throw invalid("malformed", `${param}/op`);
  const type = typeof column === "string" ? "interval" : column.type;
  const applies =
    op === "contains"
      ? type === "text"
      : ["<", "<=", ">", ">="].includes(op)
        ? ORDERED.has(type) || type === "interval"
        : true;
  if (!applies) throw invalid("operator_type", `${param}/op`);
  const at = `${param}/value`;
  if (op === "is_null") {
    const v = get(c, "value");
    if (typeof v !== "boolean") throw invalid(has(c, "value") ? "malformed" : "missing", at);
    return { column, op, isNull: v };
  }
  if (!has(c, "value")) throw invalid("missing", at);
  const v = get(c, "value");
  if (v === null) throw invalid("malformed", at);
  if (op === "in") {
    if (!isDenseArray(v) || v.length === 0) throw invalid("malformed", at);
    return {
      column,
      op,
      values: v.map((x, i) => {
        if (x === null) throw invalid("malformed", `${at}/${i}`);
        return literal(column, x, `${at}/${i}`, ctx);
      }),
    };
  }
  return { column, op: op as "=", value: literal(column, v, at, ctx) };
}

/** Normalizes `query`'s parameters for the named table. */
export function queryPlan(
  params: Obj,
  named: NamedTable,
  input: { readonly now: Instant; readonly task: string | null },
): QueryPlan {
  for (const k of keysOf(params)) if (!KEYS.has(k)) throw invalid("malformed", k);
  if (named.table.kind === "derived") throw notImplemented("table", "reading a derived table");
  const t = named.table;
  const kind = kindOf(t);
  const zone = named.slot.timezone;
  const warnings: ReadWarning[] = [];

  // task: as for writes (well-formed, at most 256 code points, no control characters).
  let task = input.task;
  if (has(params, "task")) {
    const v = get(params, "task");
    if (
      typeof v !== "string" ||
      v === "" ||
      !v.isWellFormed() ||
      [...v].length > MAX_TASK_CHARS ||
      CONTROL.test(v)
    )
      throw invalid("malformed", "task");
    task = v;
  }

  if (has(params, "detail")) {
    const d = get(params, "detail");
    if (d === "detailed") throw notImplemented("detail", "detail: detailed");
    if (d !== "concise") throw invalid("malformed", "detail");
  }

  // Evaluation time.
  let at = input.now;
  if (has(params, "at")) {
    const v = get(params, "at");
    const p = typeof v === "string" ? parseDateTime(v, "UTC", false) : undefined;
    if (p === undefined || !p.ok || p.assumed) throw invalid("malformed", "at");
    at = instantText(p.epochMs);
  }

  // Business time.
  const g = granularityOf(t);
  const hasAt = has(params, "valid_at");
  const hasDuring = has(params, "valid_during");
  if (hasAt && hasDuring) throw invalid("mutually_exclusive", "valid_during");
  if ((hasAt || hasDuring) && kind === "timeless")
    throw invalid("no_time_table", hasAt ? "valid_at" : "valid_during");
  let time: BusinessTime;
  if (hasAt) {
    const v = get(params, "valid_at");
    if (kind === "event") {
      const field = t.fields.find((f) => t.time.type === "event" && f.id === t.time.field);
      throw invalid("event_table_valid_at", "valid_at", {
        example:
          typeof v === "string" && validDate(v)
            ? { valid_during: [v, nextDay(v)] }
            : { where: [{ field: field?.name, op: "=", value: v }] },
      });
    }
    time = { kind: "at", point: bizPoint(v, "valid_at", g as "date", zone, warnings) };
  } else if (hasDuring) {
    const v = get(params, "valid_during");
    if (!isDenseArray(v) || v.length !== 2) throw invalid("malformed", "valid_during");
    const dayStart = kind === "event";
    const from = bizPoint(v[0], "valid_during/0", g as "date", zone, warnings, dayStart);
    const to =
      v[1] === null
        ? null
        : bizPoint(v[1], "valid_during/1", g as "date", zone, warnings, dayStart);
    if (to !== null && !(from < to)) throw invalid("malformed", "valid_during/1");
    time = { kind: "during", from, to };
  } else {
    const ms = Date.parse(at);
    time = {
      kind: "now",
      point: g === "date" ? (dateInZone(ms, zone) as BizPoint) : (at as BizPoint),
    };
  }

  // Fields.
  let fields: readonly CompiledBaseField[] = t.fields;
  const fieldsGiven = has(params, "fields");
  if (fieldsGiven) {
    const v = get(params, "fields");
    if (!isDenseArray(v) || v.length === 0) throw invalid("malformed", "fields");
    const chosen = new Set<string>();
    v.forEach((x, i) => {
      const f = fieldNamed(t, x, `fields/${i}`);
      if (chosen.has(f.id)) throw invalid("malformed", `fields/${i}`);
      chosen.add(f.id);
    });
    fields = t.fields.filter((f) => chosen.has(f.id));
  }

  // Conditions.
  const where: Condition[] = [];
  if (has(params, "where")) {
    const v = get(params, "where");
    if (!isDenseArray(v)) throw invalid("malformed", "where");
    const ctx = { zone, g, during: time.kind === "during", warnings };
    v.forEach((c, i) => {
      where.push(condition(t, c, `where/${i}`, ctx));
    });
  }

  // Order.
  const order: { field: CompiledBaseField; dir: "asc" | "desc" }[] = [];
  if (has(params, "order")) {
    const v = get(params, "order");
    if (!isDenseArray(v)) throw invalid("malformed", "order");
    v.forEach((o, i) => {
      const at = `order/${i}`;
      if (!isObj(o)) throw invalid("malformed", at);
      for (const k of keysOf(o))
        if (k !== "field" && k !== "dir") throw invalid("malformed", `${at}/${k}`);
      if (!has(o, "field")) throw invalid("missing", `${at}/field`);
      const field = fieldNamed(t, get(o, "field"), `${at}/field`);
      const dir = has(o, "dir") ? get(o, "dir") : "asc";
      if (dir !== "asc" && dir !== "desc") throw invalid("malformed", `${at}/dir`);
      if (order.some((x) => x.field.id === field.id)) throw invalid("malformed", `${at}/field`);
      order.push({ field, dir });
    });
  }

  // Page.
  let limit = DEFAULT_LIMIT;
  if (has(params, "limit")) {
    const v = get(params, "limit");
    // A plain number, or a JSON number kept with its text (04-contract §1).
    const n = typeof v === "number" ? v : isJsonNumber(v) ? Number(v.text) : Number.NaN;
    if (!Number.isInteger(n) || n < 1 || n > MAX_LIMIT) throw invalid("malformed", "limit");
    limit = n;
  }
  let position: string | undefined;
  if (has(params, "position")) {
    const v = get(params, "position");
    if (typeof v !== "string" || v === "") throw invalid("malformed", "position");
    position = v;
  }

  return {
    named,
    table: t,
    kind,
    fields,
    fieldsGiven,
    where,
    order,
    time,
    clip: intervalOnly(params, "clip", false, kind, time),
    coalesce: intervalOnly(params, "coalesce", true, kind, time),
    includeRevoked: bool(params, "include_revoked", false),
    limit,
    position,
    at,
    task,
    warnings,
  };
}
