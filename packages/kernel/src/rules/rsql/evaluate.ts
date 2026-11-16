// Evaluating a derived rule (docs/zh-CN/spec/03-data-model/11-restricted-sql.md «处理步骤» 7–8;
// 06-derived.md): the rule's ID-bound text (09-event-format §7 `rule.sql`) rewritten into a query
// over the physical tables, and the decoding of its result into derived rows. Pure: it gives SQL
// and parameters; the caller runs them in its own transaction.
//
// Rewriting:
//
// - The bound text is parsed and checked again (./derived.ts checkedBoundRule) and printed from
//   the tree for evaluation (./print.ts `evaluate`): divisors in NULLIF, guarded quotients, and for
//   a whole aggregate the count of its input rows.
// - The logical table (06 «规则读的是逻辑表»: the rows not revoked) is a common table expression
//   named by the table ID, put in front: `WITH "t1" AS (SELECT row_id, "f_f1" AS "f1", … FROM
//   "t_t1_v1" WHERE NOT revoked)`. The bound text names only that table and its columns, never an
//   alias or a table expression of its own (this version compiles neither WITH, JOIN nor subqueries),
//   so nothing in it can shadow or be shadowed by that name.
// - Results come back as text and are decoded here (09 §1.3), rounded to each field's precision
//   (10-types-and-units «精度与舍入»). Quotients are computed to GUARD_SCALE places first (see
//   there for why that rounding equals rounding the exact quotient for stored values).
// - A whole aggregate (no group key) with no input row has no derived row: it is an emptied
//   partition, like a group that lost its last row (06 «刷新范围»).
//
// This version evaluates rules over event and timeless tables. Rules that depend on "today" are
// computed at read time (a later version); `saveslot_date` needs the internal date column, not yet
// built: both are refused when a slot is created and are an internal error here.

import { createHash } from "node:crypto";
import {
  type CompiledBaseTable,
  type CompiledDerivedField,
  type CompiledDerivedTable,
  type CompiledSchema,
  canonicalize,
  type FieldId,
  type FieldValue,
  type JcsValue,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import type { Analysis, DeclaredField } from "./analyze.ts";
import { checkedBoundRule } from "./derived.ts";
import type { Expr, RuleStatement } from "./ir.ts";
import { INPUTS, printRule } from "./print.ts";
import { RSQL_VERSION } from "./whitelist.ts";

/** A query for the caller to run: `$n` placeholders, parameters in order. */
export interface RuleQuery {
  readonly sql: string;
  readonly params: readonly (string | boolean | null)[];
}

/** One derived row: its values by field ID (09 §1.3), and its group key in the rule's key order. */
export interface DerivedRow {
  readonly values: Readonly<Record<FieldId, FieldValue>>;
  /** The values of `rule.scope.key`, in that order; empty for a whole aggregate. */
  readonly key: readonly FieldValue[];
}

export interface RuleEvaluation {
  readonly table: TableId;
  /** Every partition of the rule on the current base data. */
  readonly all: RuleQuery;
  /** The partition with this group key (values in `rule.scope.key` order); at most one row. */
  partition(key: readonly FieldValue[]): RuleQuery;
  /** A result row of either query; undefined when it stands for no derived row. */
  decode(row: Readonly<Record<string, unknown>>): DerivedRow | undefined;
  /** The base table the rule reads. */
  readonly base: TableId;
  /**
   * The rule's members: every row of the base table the rule reads after WHERE, with the group key
   * it falls in (the key of the same expressions, decoded alike). A group HAVING drops has members
   * but no derived row.
   */
  readonly members: RuleQuery;
  /** The members among these base rows only (`members` restricted to the row IDs given). */
  membersAmong(rows: readonly string[]): {
    readonly sql: string;
    readonly params: readonly [readonly string[]];
  };
  /** A row of `members`: its group key (in `rule.scope.key` order) and its row ID. */
  decodeMember(row: Readonly<Record<string, unknown>>): {
    readonly key: readonly FieldValue[];
    readonly row: string;
  };
}

const TABLE_ID = /^t[1-9][0-9]{0,8}$/;
const FIELD_ID = /^f[1-9][0-9]{0,8}$/;

/** The SQL type a key parameter is cast to, by derived field type. */
const KEY_TYPE: Readonly<Record<CompiledDerivedField["type"], string | undefined>> = {
  text: "text",
  enum: "text",
  ref: "text",
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: undefined,
};

/** Whether the tree calls `saveslot_date`. */
function callsSaveslotDate(x: unknown): boolean {
  if (Array.isArray(x)) return x.some(callsSaveslotDate);
  if (x === null || typeof x !== "object") return false;
  const o = x as Record<string, unknown>;
  if (o["k"] === "func" && o["name"] === "saveslot_date") return true;
  return Object.values(o).some(callsSaveslotDate);
}

/** An integer constant's value: `n` or `-n` (a prefix minus over a constant). */
function intConstant(e: Expr | undefined): number | undefined {
  if (e === undefined) return undefined;
  if (e.k === "int") return Number(e.text);
  if (e.k === "op" && e.op === "-" && e.args.length === 1) {
    const n = intConstant(e.args[0]);
    return n === undefined ? undefined : -n;
  }
  return undefined;
}

/**
 * An upper bound of the decimal places of an expression's value, or undefined when there is none.
 * `scaleOf` gives a column's places (a field's declared scale, 0 for an integer field), undefined
 * for a column of no number type.
 *
 * - a decimal constant: the places it is written with; an integer constant, NULL: 0;
 * - `+`, `-`, `%`, `mod`: the larger of the two; `*`: their sum (numeric multiplication is
 *   exact); `/`, `avg`: none;
 * - `round(x, n)` / `trunc(x, n)` with a constant n: n (0 when below 0); with x alone, `floor`,
 *   `ceil`, `sign`, `EXTRACT`: 0; a cast to `numeric(p, s)`: s; `abs`, a prefix minus, any other
 *   cast: the argument's;
 * - `CASE`, `COALESCE`, `GREATEST`, `LEAST`, `NULLIF`: the largest of the results (a `WHEN`
 *   condition is not a result);
 * - anything else: none.
 *
 * This version takes a decimal or quantity group key only when the bound is within the scale
 * inferred for it: the database groups by the value as computed, the partition is keyed by the
 * value rounded to the field's precision, and the two must agree.
 */
export function placesBound(
  e: Expr,
  scaleOf: (c: Expr & { k: "col" }) => number | undefined,
): number | undefined {
  const b = (x: Expr) => placesBound(x, scaleOf);
  const most = (xs: readonly (Expr | undefined)[]) => {
    let m = 0;
    for (const x of xs) {
      const v = x === undefined ? 0 : b(x);
      if (v === undefined) return undefined;
      m = Math.max(m, v);
    }
    return m;
  };
  switch (e.k) {
    case "col":
      return scaleOf(e);
    case "int":
    case "null":
      return 0;
    case "num":
      return (e.text.split(".")[1] ?? "").length;
    case "cast":
      if (e.to.t === "numeric") return e.to.scale ?? b(e.arg);
      if (e.to.t === "bigint") return 0;
      return undefined;
    case "op": {
      const [x, y] = e.args;
      if (x === undefined) return undefined;
      if (y === undefined) return e.op === "-" || e.op === "+" ? b(x) : undefined;
      if (e.op === "+" || e.op === "-" || e.op === "%") return most([x, y]);
      if (e.op === "*") {
        const l = b(x);
        const r = b(y);
        return l === undefined || r === undefined ? undefined : l + r;
      }
      return undefined;
    }
    case "func": {
      const [x, n] = e.args;
      switch (e.name) {
        // The result's places are pinned, whatever the argument's.
        case "round":
        case "trunc": {
          if (x === undefined) return undefined;
          if (n === undefined) return 0;
          const k = intConstant(n);
          return k === undefined ? undefined : Math.max(0, k);
        }
        case "floor":
        case "ceil":
        case "sign":
          return x === undefined ? undefined : 0;
        case "abs":
          return x === undefined ? undefined : b(x);
        case "mod":
          return e.args.length === 2 ? most(e.args) : undefined;
        default:
          return undefined;
      }
    }
    case "extract":
      return 0;
    case "coalesce":
    case "greatest":
    case "least":
      return most(e.args);
    case "nullif":
      return b(e.l);
    case "case":
      return most([...e.whens.map((w) => w.result), e.else]);
    default:
      return undefined;
  }
}

/** Why this version does not evaluate a derived table's rule, or undefined when it does. */
export type EvaluationRefusal =
  | { readonly kind: "today" }
  | { readonly kind: "saveslot_date" }
  | { readonly kind: "decimal_key"; readonly field: FieldId };

/**
 * A rule's result this version cannot represent, by the data (11-restricted-sql «确定性» 6): a date
 * outside 0001-01-01 – 9999-12-31, a decimal with more than 18 integer digits. Not a kernel fault:
 * the write whose refresh meets it is refused (`rule_eval_failed`).
 */
export class RuleEvaluationError extends Error {
  readonly code = "rule_eval_failed";
  readonly reason: "date_out_of_range" | "number_out_of_range";
  readonly field: FieldId;
  constructor(field: FieldId, reason: RuleEvaluationError["reason"], message: string) {
    super(message);
    this.field = field;
    this.reason = reason;
  }
}

/** Integer digits a decimal or quantity value may have (10-types-and-units «字段类型与取值范围»). */
const DECIMAL_INTEGER_DIGITS = 18;

const internal = (what: string): never => {
  throw new Error(`derived rule evaluation: ${what}`);
};

/** The field as the compiler would declare it again from its compiled form. */
function declared(f: CompiledDerivedField): DeclaredField {
  switch (f.type) {
    case "decimal":
      return {
        name: f.name,
        type: "decimal",
        scale: f.precision.scale,
        rounding: f.precision.rounding,
      };
    case "quantity":
      return {
        name: f.name,
        unit: f.unit,
        scale: f.precision.scale,
        rounding: f.precision.rounding,
      };
    default:
      return { name: f.name };
  }
}

/** The logical table of a base table: its rows not revoked, columns named by ID. */
function logicalTable(t: CompiledBaseTable): string {
  if (t.time.type === "state") internal("a rule reading a state table is computed at read time");
  const name = t.physical.table;
  if (!TABLE_ID.test(t.id) || !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name))
    internal(`not a physical table name: ${JSON.stringify(name)}`);
  const cols = t.fields.map((f) => {
    if (!FIELD_ID.test(f.id)) internal(`not a field ID: ${JSON.stringify(f.id)}`);
    return `"f_${f.id}" AS "${f.id}"`;
  });
  return `"${t.id}" AS (SELECT row_id, ${cols.join(", ")} FROM "${name}" WHERE NOT revoked)`;
}

/** PostgreSQL's numeric text rounded to `scale` places, in the canonical form (09 §1.2). */
export function roundDecimalText(
  text: string,
  scale: number,
  mode: "half_up" | "half_even",
): `${number}` {
  const m = /^(-?)([0-9]+)(?:\.([0-9]+))?$/.exec(text);
  if (m === null) return internal(`not a decimal: ${JSON.stringify(text)}`);
  const neg = m[1] === "-";
  const frac = m[3] ?? "";
  const kept = frac.slice(0, scale).padEnd(scale, "0");
  const rest = frac.slice(scale);
  let q = BigInt(`${m[2]}${kept}`);
  // Away from zero above half; at exactly half, half_up goes away from zero, half_even to even.
  const first = rest.charAt(0);
  const half = first === "5" && /^0*$/.test(rest.slice(1));
  if (first > "5" || (first === "5" && !half) || (half && (mode === "half_up" || q % 2n === 1n)))
    q += 1n;
  if (q === 0n) return "0";
  const digits = q.toString().padStart(scale + 1, "0");
  const int = digits.slice(0, digits.length - scale);
  const f = digits.slice(digits.length - scale).replace(/0+$/, "");
  return `${neg ? "-" : ""}${int}${f === "" ? "" : `.${f}`}` as `${number}`;
}

/** A result cell decoded as the field's value (09 §1.3). */
export function decodeValue(f: CompiledDerivedField, v: unknown): FieldValue {
  if (v === null || v === undefined) return null;
  switch (f.type) {
    case "boolean":
      if (typeof v !== "boolean") return internal(`${f.id}: not a boolean`);
      return v;
    case "integer": {
      const s = String(v);
      if (!/^-?(0|[1-9][0-9]*)$/.test(s)) return internal(`${f.id}: not an integer`);
      return s as `${number}`;
    }
    case "decimal":
    case "quantity": {
      const d = roundDecimalText(String(v), f.precision.scale, f.precision.rounding);
      if ((d.replace(/^-/, "").split(".")[0] as string).length > DECIMAL_INTEGER_DIGITS) {
        throw new RuleEvaluationError(
          f.id,
          "number_out_of_range",
          `${f.id}: more than ${DECIMAL_INTEGER_DIGITS} integer digits`,
        );
      }
      return f.type === "decimal" ? d : { value: d, unit: f.unit.code };
    }
    case "date": {
      const s = String(v);
      // ISO text of a date within 0001–9999; beyond, the database writes more year digits or BC.
      if (/^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(s)) return s as FieldValue;
      if (/^[0-9]{4,}-[0-9]{2}-[0-9]{2}( BC)?$/.test(s)) {
        throw new RuleEvaluationError(
          f.id,
          "date_out_of_range",
          `${f.id}: ${s} is not a date of 0001–9999`,
        );
      }
      return internal(`${f.id}: not a date: ${s}`);
    }
    case "text":
    case "enum":
    case "ref":
      if (typeof v !== "string") return internal(`${f.id}: not text`);
      return v;
    case "zoned_datetime":
      return internal(`${f.id}: a zoned_datetime derived field`);
  }
}

/** A key value as a query parameter. */
function keyParam(v: FieldValue): string | boolean | null {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if ("value" in v) return v.value;
  return internal("a key value of no key type");
}

interface Checked {
  readonly derived: CompiledDerivedTable;
  readonly stmt: RuleStatement;
  readonly a: Analysis;
  /** The derived field of each output column. */
  readonly outputs: readonly FieldId[];
  /** The group key fields in `rule.scope.key` order. */
  readonly key: readonly CompiledDerivedField[];
  readonly refusal: EvaluationRefusal | undefined;
}

/** The derived table's rule checked again from its bound text, against its compiled definition. */
function checkRule(schema: CompiledSchema, table: TableId): Checked {
  const derived = schema.tables.find(
    (t): t is CompiledDerivedTable => t.kind === "derived" && t.id === table,
  );
  if (derived === undefined) return internal(`no derived table ${table}`);
  const rule = derived.rule;
  if (rule.rsql !== RSQL_VERSION) internal(`rule of ${rule.rsql}`);
  const bases = schema.tables.filter((t): t is CompiledBaseTable => t.kind === "base");
  const { stmt, analysis: a } = checkedBoundRule({
    sql: rule.sql,
    declaredTimeDependency: rule.time_dependency,
    fields: derived.fields.map(declared),
    slot: { name: schema.name },
    tables: bases,
    derivedTables: schema.tables.filter((t) => t.kind === "derived").map((t) => t.name),
    path: `tables/${table}/rule/sql`,
  });
  // The checked rule agrees with the compiled definition it was printed for. Outputs are taken by
  // position as f1…fn: a table whose field IDs are not exactly that is not evaluated.
  if (a.fields.length !== derived.fields.length) internal("fields differ");
  derived.fields.forEach((f, i) => {
    if (f.id !== `f${i + 1}`)
      internal(`derived field IDs are not f1…f${derived.fields.length} in order`);
  });
  derived.fields.forEach((f, i) => {
    const r = a.fields[i];
    if (
      r === undefined ||
      r.type !== f.type ||
      ("unit" in r ? r.unit.code : undefined) !== ("unit" in f ? f.unit.code : undefined) ||
      ("precision" in r ? r.precision.scale : undefined) !==
        ("precision" in f ? f.precision.scale : undefined) ||
      ("precision" in r ? r.precision.rounding : undefined) !==
        ("precision" in f ? f.precision.rounding : undefined)
    )
      internal(`field ${f.id} differs from its compiled definition`);
  });
  const outputs = a.outputs.map((i): FieldId => `f${i + 1}`);
  const key: readonly CompiledDerivedField[] =
    rule.scope.kind === "tenant"
      ? []
      : rule.scope.key.map(
          (id) => derived.fields.find((f) => f.id === id) ?? internal(`no key field ${id}`),
        );
  if ((rule.scope.kind === "tenant") !== (a.groupKey.length === 0))
    internal("scope and group key differ");
  let refusal: EvaluationRefusal | undefined;
  if (rule.time_dependency === "now") refusal = { kind: "today" };
  else if (callsSaveslotDate(stmt)) refusal = { kind: "saveslot_date" };
  else {
    for (const f of key) {
      const target = stmt.targets[outputs.indexOf(f.id)];
      if (target === undefined) return internal(`key field ${f.id} is not an output`);
      if (f.type !== "decimal" && f.type !== "quantity") continue;
      const bound = placesBound(target.expr, (c) => {
        const col = a.columnOf(c);
        if (col.kind !== "field") return undefined;
        const bf = col.field;
        if (bf.type === "integer") return 0;
        return bf.type === "decimal" || bf.type === "quantity" ? bf.precision.scale : undefined;
      });
      if (bound === undefined || bound > f.precision.scale) {
        refusal = { kind: "decimal_key", field: f.id };
        break;
      }
    }
  }
  return { derived, stmt, a, outputs, key, refusal };
}

/**
 * Why this version does not evaluate derived table `table` of `schema` (a slot holding it is not
 * created), or undefined when it does: a rule depending on today (computed at read time),
 * `saveslot_date` (the internal date column), a decimal or quantity group key that may have more
 * places than its scale (placesBound).
 */
export function evaluationRefusal(
  schema: CompiledSchema,
  table: TableId,
): EvaluationRefusal | undefined {
  return checkRule(schema, table).refusal;
}

/**
 * The evaluation of derived table `table` of `schema`. Throws when the table's rule is one this
 * version does not evaluate (evaluationRefusal): a slot holding it is not created, so here that is
 * an internal error.
 */
export function evaluateRule(schema: CompiledSchema, table: TableId): RuleEvaluation {
  const { derived, stmt, a, outputs, key, refusal } = checkRule(schema, table);
  if (refusal !== undefined) internal(`not evaluated in this version: ${refusal.kind}`);
  const whole = a.groupKey.length === 0;

  const body = printRule(stmt, {
    table: a.table.id,
    column: (e) => {
      const col = a.columnOf(e);
      return col.kind === "field"
        ? col.field.id
        : (col.name as "row_id" | "entity_id" | "valid_from" | "valid_to");
    },
    outputs,
    groupKey: a.groupKey,
    hints: a.hints,
    evaluate: true,
  });
  const cols = derived.fields.map((f) => {
    if (!FIELD_ID.test(f.id)) internal(`not a field ID: ${JSON.stringify(f.id)}`);
    return f.type === "boolean" ? `"r"."${f.id}"` : `CAST("r"."${f.id}" AS text) AS "${f.id}"`;
  });
  if (whole) cols.push(`"r"."${INPUTS}"`);
  const head = `WITH ${logicalTable(a.table)} SELECT ${cols.join(", ")} FROM (${body}) AS "r"`;
  const membersBody = printRule(stmt, {
    table: a.table.id,
    column: (e) => {
      const col = a.columnOf(e);
      return col.kind === "field"
        ? col.field.id
        : (col.name as "row_id" | "entity_id" | "valid_from" | "valid_to");
    },
    outputs,
    groupKey: a.groupKey,
    hints: a.hints,
    evaluate: true,
    members: true,
  });
  const keyCols = key.map((f) =>
    f.type === "boolean" ? `"m"."${f.id}"` : `CAST("m"."${f.id}" AS text) AS "${f.id}"`,
  );
  const members = `WITH ${logicalTable(a.table)} SELECT ${[...keyCols, `"m"."row_id"`].join(", ")} FROM (${membersBody}) AS "m"`;

  return {
    table,
    base: a.table.id,
    members: { sql: members, params: [] },
    membersAmong: (rows) => ({
      sql: `${members} WHERE "m"."row_id" = ANY($1)`,
      params: [[...rows]],
    }),
    decodeMember(row) {
      const id = row["row_id"];
      if (typeof id !== "string") return internal("a member without its row ID");
      return { key: key.map((f) => decodeValue(f, row[f.id])), row: id };
    },
    all: { sql: head, params: [] },
    partition(values) {
      if (values.length !== key.length) internal("key of another length");
      if (whole) return { sql: head, params: [] };
      const conds = key.map((f, i) => {
        const t = KEY_TYPE[f.type] ?? internal(`key field ${f.id} of type ${f.type}`);
        return `"r"."${f.id}" IS NOT DISTINCT FROM CAST($${i + 1} AS ${t})`;
      });
      return { sql: `${head} WHERE ${conds.join(" AND ")}`, params: values.map(keyParam) };
    },
    decode(row) {
      if (whole) {
        const n = String(row[INPUTS]);
        if (!/^[0-9]+$/.test(n)) internal("no input count");
        if (n === "0") return undefined;
      }
      const values: Record<FieldId, FieldValue> = {};
      for (const f of derived.fields) {
        if (!Object.hasOwn(row, f.id)) internal(`no column ${f.id}`);
        values[f.id] = decodeValue(f, row[f.id]);
      }
      return { values, key: key.map((f) => values[f.id] as FieldValue) };
    },
  };
}

/** The checksum of one derived row (09 §5.13): SHA-256 of the JCS of its values by field ID. */
export function rowChecksum(values: Readonly<Record<FieldId, FieldValue>>): string {
  return createHash("sha256")
    .update(canonicalize(values as unknown as JcsValue))
    .digest("hex");
}
