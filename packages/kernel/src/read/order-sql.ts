// `query`'s order in SQL (04-contract "默认排序", §15): the ORDER BY of a page and the condition
// "after these keys" of a later one, written so that the database puts rows in the order `cmpKeys`
// (./rows.ts) does, key by key: numbers exactly, text by code point (the "C" collation, UTF-8 byte
// order), dates and instants by time (their text forms are fixed width, so the same order), false
// before true, and nulls last whichever the direction.

import type { CompiledBaseField } from "@fluxvita/saveslot-contract-core";
import { column } from "../store/layout.ts";
import type { QueryPlan } from "./params.ts";

/** How `cmpKeys` (./rows.ts) compares a key. Defined here, the module ./rows.ts and ./select.ts both use. */
export type KeyType = "number" | "text" | "plain" | "boolean" | "count";

export interface KeySpec {
  readonly type: KeyType;
  readonly dir: "asc" | "desc";
}

/** Where a statement's parameters go (./select.ts `Params`): each added, its placeholder back. */
export interface Params {
  add(v: string | number | boolean | null, cast?: string): string;
}

/** The SQL type a key's column is compared as. */
export type SqlKeyType = "numeric" | "bigint" | "text" | "date" | "timestamptz" | "boolean";

/** A key as SQL orders it: the column (or expression), its type and its direction. */
export interface SqlKey {
  readonly expr: string;
  readonly type: SqlKeyType;
  readonly spec: KeySpec;
}

/** A key's value as `rowKeys` gives it. */
export type KeyValue = string | boolean | number | null;

const operand = (k: SqlKey): string => (k.type === "text" ? `${k.expr} COLLATE "C"` : k.expr);

const CAST: Readonly<Record<SqlKeyType, string>> = {
  numeric: "::numeric",
  bigint: "::bigint",
  text: "",
  date: "::date",
  timestamptz: "::timestamptz",
  boolean: "::boolean",
};

function literal(k: SqlKey, v: string | boolean | number, p: Params): string {
  if (k.type === "boolean") {
    if (typeof v !== "boolean") throw new TypeError(`not a boolean key: ${JSON.stringify(v)}`);
    return p.add(v, CAST.boolean);
  }
  if (typeof v === "boolean") throw new TypeError(`a boolean for a ${k.type} key`);
  const text = String(v);
  return k.type === "text" ? `${p.add(text)} COLLATE "C"` : p.add(text, CAST[k.type]);
}

/** `ORDER BY`'s list for the keys, nulls last in both directions. */
export function orderBySql(keys: readonly SqlKey[]): string {
  return keys.map((k) => `${operand(k)} ${k.spec.dir.toUpperCase()} NULLS LAST`).join(", ");
}

/** The key equal to `v` (a null key only to null). */
function equalSql(k: SqlKey, v: KeyValue, p: Params): string {
  return v === null ? `${k.expr} IS NULL` : `${operand(k)} = ${literal(k, v, p)}`;
}

/** The key after `v` in its direction: nulls come after every value, nothing after a null. */
function laterSql(k: SqlKey, v: KeyValue, p: Params): string | undefined {
  if (v === null) return undefined;
  const op = k.spec.dir === "asc" ? ">" : "<";
  return `(${operand(k)} ${op} ${literal(k, v, p)} OR ${k.expr} IS NULL)`;
}

/**
 * The rows whose keys come strictly after `after`, as `cmpKeys(keys, after) > 0`: for some key, every
 * key before it equal and that key later. `FALSE` when nothing can come after (every key null).
 */
export function afterKeysSql(
  keys: readonly SqlKey[],
  after: readonly KeyValue[],
  p: Params,
): string {
  if (after.length !== keys.length)
    throw new TypeError(`${after.length} key values for ${keys.length} keys`);
  const alternatives: string[] = [];
  for (let i = 0; i < keys.length; i++) {
    const later = laterSql(keys[i] as SqlKey, after[i] ?? null, p);
    if (later === undefined) continue;
    const equal = keys.slice(0, i).map((k, j) => equalSql(k, after[j] ?? null, p));
    alternatives.push(`(${[...equal, later].join(" AND ")})`);
  }
  return alternatives.length === 0 ? "FALSE" : `(${alternatives.join(" OR ")})`;
}

/**
 * The rows whose keys come strictly after `after`, where every key is ascending and never null (a
 * state table's primary key: the entity, then `valid_from`): one row comparison, which the
 * database reads as a range of the key's index. `afterKeysSql` gives the same rows there, but its
 * alternatives make the database scan the index from the start and filter.
 */
export function rowAfterSql(
  keys: readonly SqlKey[],
  after: readonly KeyValue[],
  p: Params,
): string {
  if (after.length !== keys.length)
    throw new TypeError(`${after.length} key values for ${keys.length} keys`);
  const values = keys.map((k, i) => {
    const v = after[i] ?? null;
    if (k.spec.dir !== "asc" || v === null)
      throw new TypeError("a row comparison needs keys ascending and values never null");
    return literal(k, v, p);
  });
  return `ROW(${keys.map((k) => k.expr).join(", ")}) > ROW(${values.join(", ")})`;
}

/** The SQL type a field's column orders as (03-data-model/11-restricted-sql.md «类型»). */
export function sqlKeyType(f: CompiledBaseField): SqlKeyType {
  switch (f.type) {
    case "integer":
    case "decimal":
    case "quantity":
      return "numeric";
    case "boolean":
      return "boolean";
    case "date":
      return "date";
    case "zoned_datetime":
      return "timestamptz"; // the instant column: zoned date-times order by instant
    default:
      return "text";
  }
}

/**
 * A query's keys over its business table, as `keySpecs` / `rowKeys` (./rows.ts) give them: the
 * order asked for, then the default order (04-contract "默认排序"): an event table's time
 * descending and its row ID; a state table's entity ID and `valid_from`. Not for timeless tables,
 * whose default order is by `ver`, not a column there.
 */
export function queryKeys(plan: QueryPlan, specs: readonly KeySpec[]): SqlKey[] {
  const t = plan.table;
  const asked = plan.order.map((o) => ({ expr: column(o.field), type: sqlKeyType(o.field) }));
  let defaults: { expr: string; type: SqlKeyType }[];
  if (plan.kind === "state" && t.time.type === "state")
    defaults = [
      { expr: "entity_id", type: "text" },
      { expr: "valid_from", type: t.time.granularity === "date" ? "date" : "timestamptz" },
    ];
  else if (plan.kind === "event" && t.time.type === "event") {
    const id = t.time.field;
    const f = t.fields.find((x) => x.id === id) as CompiledBaseField;
    defaults = [
      { expr: column(f), type: sqlKeyType(f) },
      { expr: "row_id", type: "text" },
    ];
  } else throw new TypeError(`no SQL keys for a ${plan.kind} table`);
  const all = [...asked, ...defaults];
  if (all.length !== specs.length) throw new TypeError("the keys and their specs disagree");
  return all.map((k, i) => ({ ...k, spec: specs[i] as KeySpec }));
}
