// Printing a checked rule as text (11-restricted-sql.md «处理步骤» 5: the ID-bound text kept as
// `rule.sql`, 09-event-format §7). The text is printed from the structured form, never copied from
// what the caller wrote:
//
// - identifiers come only from the compiled definition (table and field IDs, system columns), are
//   checked against their exact shape and always double-quoted; the caller's aliases and output
//   names are not printed (output columns are named by derived field ID);
// - functions, operators and type names come from the whitelist's fixed spellings;
// - numbers are printed after checking their digits; strings in single quotes with quotes doubled;
// - every compound expression is parenthesized, so the parser reads it back as the same tree;
// - values PostgreSQL would type as 32-bit integers (integer constants, `length`, `strpos`,
//   date − date) and `sum` of integers (numeric there) are printed inside `CAST(… AS bigint)`, so
//   that every integer is 64-bit as the analysis assumes (11 «类型»); constants in positions taking
//   only a 32-bit integer stay bare.
//
// The text is parsed and checked again whenever the rule is evaluated; tests check that printing
// and parsing back gives the same rule.
//
// For evaluation (./evaluate.ts) the same tree is printed with `evaluate` set: the kernel's
// rewriting (11 «处理步骤» 7) after the checks, so its output is not checked against the whitelist
// again. Divisors of `/`, `%` and `mod()` become `NULLIF(divisor, 0)`; the dividend of `/` and the
// argument of `avg` are cast to `numeric(1000, 45)`, so that PostgreSQL computes the quotient to at
// least 45 decimal places (GUARD_SCALE); a whole aggregate gets the count of its input rows as an
// extra column (INPUTS).

import type { FieldId, TableId } from "@fluxvita/saveslot-contract-core";
import type { PrintHints } from "./analyze.ts";
import type { CastTarget, Expr, RuleStatement } from "./ir.ts";

const TABLE_ID = /^t[1-9][0-9]{0,8}$/;
const FIELD_ID = /^f[1-9][0-9]{0,8}$/;
const SYSTEM = new Set(["row_id", "entity_id", "valid_from", "valid_to"]);
const INT = /^-?(0|[1-9][0-9]*)$/;
const NUM = /^-?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)$/;
const WORD = /^[a-z]+$/;

/**
 * Decimal places to which evaluation computes each quotient (`/`, `avg`). With a dividend of at most
 * 12 places and a divisor q of d places, an exact quotient that is not on a rounding boundary of at
 * most 13 places lies at least 10^-13 / Q from it (Q = |q|·10^d, an integer); PostgreSQL's quotient
 * is within 0.5·10^-G of the exact one, so rounding it to the field's scale equals rounding the
 * exact quotient whenever Q < 2·10^(G−13). With G = 45 that covers every stored value as a divisor
 * (at most 18 integer and 12 decimal digits: Q < 10^30) and any row count.
 */
export const GUARD_SCALE = 45;

/** The extra column of a whole aggregate in evaluation: how many rows it read. Not a field ID. */
export const INPUTS = "inputs";

const GUARD = `numeric(1000, ${GUARD_SCALE})`;

export interface PrintNames {
  readonly table: TableId;
  /** The field ID or system column a column reference resolves to. */
  readonly column: (
    e: Expr & { k: "col" },
  ) => FieldId | "row_id" | "entity_id" | "valid_from" | "valid_to";
  /** The derived field ID of each output column. */
  readonly outputs: readonly FieldId[];
  /** Output column positions of the group key. */
  readonly groupKey: readonly number[];
  readonly hints: PrintHints;
  /** Print for evaluation: guarded quotients, NULLIF divisors, the input count of a whole aggregate. */
  readonly evaluate?: boolean;
  /**
   * Print the rule's members instead (with `evaluate`): the group key expressions and the row ID
   * of every row the rule reads after WHERE, without aggregating; no GROUP BY, no HAVING.
   */
  readonly members?: boolean;
}

function ident(s: string, shape: (s: string) => boolean): string {
  if (!shape(s)) throw new Error(`not an identifier to print: ${JSON.stringify(s)}`);
  return `"${s}"`;
}

function cast(t: CastTarget): string {
  switch (t.t) {
    case "numeric":
      return t.precision !== undefined && t.scale !== undefined
        ? `numeric(${t.precision}, ${t.scale})`
        : "numeric";
    case "bigint":
      return "bigint";
    case "date":
      return "date";
    case "timestamp":
      return "timestamp";
  }
}

const OPS = new Set(["=", "<>", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "||"]);

class Printer {
  readonly #n: PrintNames;
  readonly #table: string;
  constructor(n: PrintNames) {
    this.#n = n;
    this.#table = ident(n.table, (s) => TABLE_ID.test(s));
  }

  expr(e: Expr): string {
    const h = this.#n.hints;
    if (e.k === "cast" && h.transparent(e)) return this.expr(e.arg);
    const s = this.#expr(e);
    return h.widen(e) || (e.k === "int" && !h.bare(e)) ? `CAST(${s} AS bigint)` : s;
  }

  #expr(e: Expr): string {
    const p = (x: Expr) => this.expr(x);
    const list = (xs: readonly Expr[]) => xs.map(p).join(", ");
    switch (e.k) {
      case "col": {
        const c = this.#n.column(e);
        return `${this.#table}.${ident(c, (s) => FIELD_ID.test(s) || SYSTEM.has(s))}`;
      }
      case "int":
        if (!INT.test(e.text)) throw new Error("not an integer to print");
        return e.text;
      case "num":
        if (!NUM.test(e.text)) throw new Error("not a number to print");
        return e.text;
      case "str":
        return `'${e.value.replaceAll("'", "''")}'`;
      case "bool":
        return e.value ? "TRUE" : "FALSE";
      case "null":
        return "NULL";
      case "cast":
        return `CAST(${p(e.arg)} AS ${cast(e.to)})`;
      case "op": {
        if (!OPS.has(e.op)) throw new Error("not an operator to print");
        const [a, b] = e.args;
        // A space after a prefix operator: `- -x` must not become a comment.
        if (b === undefined) return `(${e.op} ${p(a as Expr)})`;
        if (this.#n.evaluate === true && e.op === "/")
          return `(CAST(${p(a as Expr)} AS ${GUARD}) / NULLIF(${p(b)}, 0))`;
        if (this.#n.evaluate === true && e.op === "%")
          return `(${p(a as Expr)} % NULLIF(${p(b)}, 0))`;
        return `(${p(a as Expr)} ${e.op} ${p(b)})`;
      }
      case "distinct":
        return `(${p(e.l)} IS DISTINCT FROM ${p(e.r)})`;
      case "not_distinct":
        return `(${p(e.l)} IS NOT DISTINCT FROM ${p(e.r)})`;
      case "nullif":
        return `NULLIF(${p(e.l)}, ${p(e.r)})`;
      case "in":
        return `(${p(e.arg)} ${e.not ? "NOT IN" : "IN"} (${list(e.list)}))`;
      case "like":
        return `(${p(e.arg)} ${e.not ? "NOT LIKE" : "LIKE"} ${p(e.pattern)}${e.escape !== undefined ? ` ESCAPE ${p(e.escape)}` : ""})`;
      case "between":
        return `(${p(e.arg)} ${e.not ? "NOT BETWEEN" : "BETWEEN"} ${p(e.lo)} AND ${p(e.hi)})`;
      case "and":
      case "or":
        return `(${e.args.map(p).join(e.k === "and" ? " AND " : " OR ")})`;
      case "not":
        return `(NOT ${p(e.arg)})`;
      case "isnull":
        return `(${p(e.arg)} ${e.not ? "IS NOT NULL" : "IS NULL"})`;
      case "booltest":
        return `(${p(e.arg)} IS ${e.test.slice(3).replace("_", " ").toUpperCase()})`;
      case "case":
        return `CASE${e.arg !== undefined ? ` ${p(e.arg)}` : ""}${e.whens.map((w) => ` WHEN ${p(w.when)} THEN ${p(w.result)}`).join("")}${e.else !== undefined ? ` ELSE ${p(e.else)}` : ""} END`;
      case "coalesce":
        return `COALESCE(${list(e.args)})`;
      case "greatest":
        return `GREATEST(${list(e.args)})`;
      case "least":
        return `LEAST(${list(e.args)})`;
      case "func":
        if (!/^[a-z_]+$/.test(e.name)) throw new Error("not a function name to print");
        if (this.#n.evaluate === true && e.name === "mod") {
          const [a, b] = e.args;
          if (a === undefined || b === undefined || e.args.length !== 2)
            throw new Error("mod takes two arguments");
          return `mod(${p(a)}, NULLIF(${p(b)}, 0))`;
        }
        return `${e.name}(${list(e.args)})`;
      case "extract":
        if (!WORD.test(e.field)) throw new Error("not an EXTRACT field to print");
        return `EXTRACT(${e.field} FROM ${p(e.arg)})`;
      case "agg": {
        if (!/^[a-z_]+$/.test(e.name)) throw new Error("not an aggregate name to print");
        const arg =
          e.star || this.#n.evaluate !== true || e.name !== "avg"
            ? () => p(e.arg as Expr)
            : () => `CAST(${p(e.arg as Expr)} AS ${GUARD})`;
        const body = e.star ? "*" : `${e.distinct ? "DISTINCT " : ""}${arg()}`;
        return `${e.name}(${body})${e.filter !== undefined ? ` FILTER (WHERE ${p(e.filter)})` : ""}`;
      }
      case "param":
      case "sublink":
      case "win":
        throw new Error("not in a derived rule");
    }
  }

  statement(s: RuleStatement): string {
    if (this.#n.members === true) return this.#members(s);
    const out = s.targets.map((t, i) => {
      const id = this.#n.outputs[i];
      if (id === undefined) throw new Error("an output column without a field ID");
      return `${this.expr(t.expr)} AS ${ident(id, (x) => FIELD_ID.test(x))}`;
    });
    if (this.#n.evaluate === true && this.#n.groupKey.length === 0)
      out.push(`count(*) AS "${INPUTS}"`);
    const parts = [`SELECT ${out.join(", ")}`, `FROM ${this.#table}`];
    if (s.where !== undefined) parts.push(`WHERE ${this.expr(s.where)}`);
    if (this.#n.groupKey.length > 0)
      parts.push(`GROUP BY ${this.#n.groupKey.map((i) => i + 1).join(", ")}`);
    if (s.having !== undefined) parts.push(`HAVING ${this.expr(s.having)}`);
    return parts.join(" ");
  }

  /**
   * The rows of the rule's partitions. Sound for this version's rules: one table, an aggregate at
   * the outermost level, no window function or subquery anywhere (the converter takes none), so a
   * group key expression is a function of one row and WHERE keeps the same rows either way.
   */
  #members(s: RuleStatement): string {
    const out = this.#n.groupKey.map((i) => {
      const t = s.targets[i];
      const id = this.#n.outputs[i];
      if (t === undefined || id === undefined) throw new Error("a group key without its output");
      return `${this.expr(t.expr)} AS ${ident(id, (x) => FIELD_ID.test(x))}`;
    });
    out.push(`${this.#table}."row_id" AS "row_id"`);
    const parts = [`SELECT ${out.join(", ")}`, `FROM ${this.#table}`];
    if (s.where !== undefined) parts.push(`WHERE ${this.expr(s.where)}`);
    return parts.join(" ");
  }
}

/** The ID-bound text of a checked rule. */
export function printRule(s: RuleStatement, names: PrintNames): string {
  return new Printer(names).statement(s);
}
