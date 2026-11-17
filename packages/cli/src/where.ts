// `saveslot query --where` and `--where-json` (docs/zh-CN/spec/06-cli.md §4.7): the conditions of
// the contract's `query` (04-contract-types §4.3 `where`), written on the command line.
//
// - `--where '<field><op><value>'`: one condition per option. The field is a name as the spec
//   allows one (07-schema-evolution «名字»: a letter, then letters, digits and underscores, at most
//   63), or `valid_from` / `valid_to`; the operator is one of `= != < <= > >=`, the longest that
//   matches, with or without spaces around it; the value is the rest, trimmed. A value beginning
//   with `"` is a JSON string (to keep spaces at its ends, or to write escapes). Nothing else is
//   the shorthand's: `in`, `contains`, `is_null` and anything complex go in `--where-json`.
// - The value is made by the field's type, from the table's catalog (the field found as the service
//   finds it, without regard to ASCII case): integer and decimal as
//   canonical decimal text (no limit on size; the service judges the type), a quantity as
//   `{value, unit}` with its unit written after the number (`5km`, `5 km`; no unit is a usage
//   error), a boolean as `true` / `false`; every other type, and a field the catalog does not
//   have, as the string written (the service answers `unknown_field` for a name it does not know).
// - `--where-json`: one condition object, or an array of them, as the contract writes them; only
//   checked to be JSON of that shape here, its content is the service's to judge.
// - The two may be given together: one list, the `--where` conditions first.
// Lookups of operators and types are by Map.

import type { FieldType } from "@fluxvita/saveslot-client";
import { TEXTS } from "./texts.ts";
import { UsageError } from "./usage.ts";

export type Condition = { field: string; op: string; value?: unknown };

/** The shorthand's operators, longest first so that `<=` is not read as `<`. */
const OPERATORS: ReadonlyMap<string, string> = new Map([
  ["<=", "<="],
  [">=", ">="],
  ["!=", "!="],
  ["=", "="],
  ["<", "<"],
  [">", ">"],
]);
const FIELD = /^[A-Za-z][A-Za-z0-9_]{0,62}/;
const DECIMAL = /^[+-]?[0-9]+(?:\.[0-9]+)?$/;

/**
 * A name as the service matches it: ASCII letters folded to lower case, nothing else (04-contract
 * §1: names are unique and resolved without regard to ASCII case). The map of a table's fields is
 * keyed so, and looked up so; the condition keeps the name as written.
 */
export const foldName = (n: string): string => n.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A field's type and unit, as the table's catalog gives them. */
export interface FieldInfo {
  readonly type: FieldType;
  readonly unit?: string;
}

/** Canonical decimal text of a number as written: no sign but `-`, no leading or trailing zeros. */
export function canonicalDecimal(s: string): string {
  const negative = s.startsWith("-");
  const [whole = "0", fraction = ""] = s.replace(/^[+-]/, "").split(".");
  const w = whole.replace(/^0+(?=[0-9])/, "");
  const f = fraction.replace(/0+$/, "");
  const text = f === "" ? w : `${w}.${f}`;
  return negative && text !== "0" ? `-${text}` : text;
}

/** The value of one condition, by the field's type. */
function valueFor(raw: string, info: FieldInfo | undefined, which: number): unknown {
  switch (info?.type) {
    case "integer":
    case "decimal":
      if (!DECIMAL.test(raw)) throw new UsageError(TEXTS.whereNotNumber(which));
      return canonicalDecimal(raw);
    case "quantity": {
      const m = /^([+-]?[0-9]+(?:\.[0-9]+)?)\s*(\S.*)?$/.exec(raw);
      if (m === null) throw new UsageError(TEXTS.whereNotNumber(which));
      if (m[2] === undefined) throw new UsageError(TEXTS.whereUnitMissing(which));
      return { value: canonicalDecimal(m[1] as string), unit: m[2] };
    }
    case "boolean":
      if (raw === "true") return true;
      if (raw === "false") return false;
      throw new UsageError(TEXTS.whereNotBoolean(which));
    default:
      return raw;
  }
}

/** One `--where`, the `which`-th (from 1). */
export function parseCondition(
  text: string,
  fields: ReadonlyMap<string, FieldInfo>,
  which: number,
): Condition {
  const s = text.trim();
  const field = FIELD.exec(s)?.[0];
  if (field === undefined) throw new UsageError(TEXTS.whereNoField(which));
  const rest = s.slice(field.length).trimStart();
  const op = [...OPERATORS.keys()].find((o) => rest.startsWith(o));
  if (op === undefined) throw new UsageError(TEXTS.whereNoOperator(which, field.length + 1));
  let raw = rest.slice(op.length).trim();
  if (raw === "") throw new UsageError(TEXTS.whereNoValue(which));
  if (raw.startsWith('"')) {
    let v: unknown;
    try {
      v = JSON.parse(raw);
    } catch {
      throw new UsageError(TEXTS.whereBadString(which));
    }
    if (typeof v !== "string") throw new UsageError(TEXTS.whereBadString(which));
    raw = v;
  }
  return {
    field,
    op: OPERATORS.get(op) as string,
    value: valueFor(raw, fields.get(foldName(field)), which),
  };
}

/** The `--where-json` options: each one condition object or an array of them. */
export function parseConditionsJson(texts: readonly string[]): unknown[] {
  return texts.flatMap((text, i) => {
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      throw new UsageError(TEXTS.whereJsonBad(i + 1));
    }
    const list = Array.isArray(v) ? v : [v];
    if (list.some((x) => typeof x !== "object" || x === null || Array.isArray(x))) {
      throw new UsageError(TEXTS.whereJsonBad(i + 1));
    }
    return list;
  });
}
