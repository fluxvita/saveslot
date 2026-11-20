// Printing a `sql` query's structured form (./ir.ts `Query`) as text (11-restricted-sql.md «处理步骤»
// 7–8: what is executed is printed from the tree, never copied from what the caller wrote).
//
// This is the one printer of the tree: by default names are the logical ones (slots, tables, fields,
// aliases as the analysis made them). The kernel prints the same tree with `PrintHooks` to get the
// text that is executed (./sql-rewrite.ts: tables as subqueries over the physical ones, parameters
// and times as the call's values) and the structural fingerprint of the read record
// (./sql-fingerprint.ts: IDs for names, placeholders for values). What is printed is only what the
// tree holds:
//
// - identifiers are always double-quoted, with a quote inside doubled, so that no identifier can
//   end its quotes or start something else;
// - string literals are in single quotes with quotes doubled (the session has
//   `standard_conforming_strings = on`, so a backslash is a backslash);
// - numbers are printed after their digits are checked; functions, operators and type names come
//   from fixed spellings checked against their shape;
// - every compound expression is parenthesized, so that parsing the text gives the same tree.
//
// Tests check that printing then parsing again gives an equal tree.

import type {
  CastTarget,
  Cte,
  Expr,
  Frame,
  FrameBound,
  FrameOffset,
  FromItem,
  GroupItem,
  OverClause,
  Query,
  SelectBody,
  SelectItem,
  SortItem,
  TimeClause,
  TimeOperand,
  WindowSpec,
} from "./ir.ts";

/**
 * What a caller of the printer decides in place of the default. Each hook returns the text of the
 * part it is asked about (undefined: the default); text a hook returns is the caller's own and is
 * not checked here.
 */
export interface PrintHooks {
  /** A table reference as a FROM item, its alias included (default: `slot.table` and its time clause). */
  readonly table?: (f: FromTable) => string;
  /** A column reference (default: its parts, quoted). */
  readonly col?: (e: Expr & { k: "col" }) => string | undefined;
  /** An integer, decimal, string or boolean constant, or a parameter. */
  readonly konst?: (e: Expr) => string | undefined;
  /** A function call by its name, for the ones the call itself fixes (`saveslot_now()`). */
  readonly func?: (e: Expr & { k: "func" }) => string | undefined;
  /** The AS of output column `index` (0-based) named `name`: undefined for none. */
  readonly outName?: (index: number, name: string) => string | undefined;
  /** A window's name where it is defined or used. */
  readonly windowName?: (name: string) => string;
  /** The operand of a time clause. */
  readonly operand?: (o: TimeOperand) => string;
  /** The offset of a window frame. */
  readonly frameOffset?: (o: FrameOffset) => string;
  /** An expression to print in place of this one (the call's own rewriting of it); undefined: as it is. */
  readonly rewrite?: (e: Expr) => Expr | undefined;
  /** Whether the items of an IN list are one placeholder (`IN ($1)`). */
  readonly foldIn?: (e: Expr & { k: "in" }) => string | undefined;
}

type FromTable = FromItem & { k: "table" };

const INT = /^-?(0|[1-9][0-9]*)$/;
const NUM = /^-?(?:[0-9]+\.[0-9]*|\.[0-9]+|[0-9]+)$/;
const NAME = /^[a-z_]+$/;
const OPS = new Set(["=", "<>", "<", "<=", ">", ">=", "+", "-", "*", "/", "%", "||"]);

/** A name as an identifier. */
export function quoteIdent(s: string): string {
  if (s === "" || s.includes("\0")) throw new Error("not an identifier to print");
  return `"${s.replaceAll('"', '""')}"`;
}

const quoteStr = (s: string): string => {
  if (s.includes("\0")) throw new Error("not a string to print");
  return `'${s.replaceAll("'", "''")}'`;
};

function castName(t: CastTarget): string {
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

const names = (xs: readonly string[]): string => xs.map(quoteIdent).join(", ");

/** The default text of a frame offset. */
function defaultOffset(o: FrameOffset): string {
  switch (o.k) {
    case "int":
      if (!INT.test(o.text)) throw new Error("not an integer to print");
      return o.text;
    case "num":
      if (!NUM.test(o.text)) throw new Error("not a number to print");
      return o.text;
    case "interval":
      if (!Number.isInteger(o.days) || o.days < 0) throw new Error("not an interval to print");
      return `INTERVAL '${o.days} days'`;
  }
}

/** The default text of a time clause's operand. */
function defaultOperand(o: TimeOperand): string {
  const base =
    o.base.k === "param"
      ? `$${o.base.n}`
      : o.base.k === "str"
        ? quoteStr(o.base.value)
        : o.base.k === "today"
          ? "saveslot_today()"
          : "saveslot_now()";
  if (o.days === undefined) return base;
  if (!Number.isInteger(o.days)) throw new Error("not a number of days to print");
  return `${base} ${o.days < 0 ? "-" : "+"} ${Math.abs(o.days)}`;
}

/** The printer of a tree: the default text, with the parts `h` decides. */
function printer(h: PrintHooks) {
  const timeClause = (c: TimeClause): string => {
    const op = h.operand ?? defaultOperand;
    return c.k === "as_of"
      ? ` FOR VALID_TIME AS OF ${op(c.at)}`
      : ` FOR VALID_TIME FROM ${op(c.from)} TO ${op(c.to)}`;
  };
  const windowName = (n: string): string =>
    h.windowName !== undefined ? h.windowName(n) : quoteIdent(n);

  function expr(given: Expr): string {
    const e = h.rewrite?.(given) ?? given;
    const p = expr;
    const list = (xs: readonly Expr[]) => xs.map(p).join(", ");
    switch (e.k) {
      case "col":
        return h.col?.(e) ?? e.parts.map(quoteIdent).join(".");
      case "int":
        if (!INT.test(e.text)) throw new Error("not an integer to print");
        return h.konst?.(e) ?? e.text;
      case "num":
        if (!NUM.test(e.text)) throw new Error("not a number to print");
        return h.konst?.(e) ?? e.text;
      case "str":
        return h.konst?.(e) ?? quoteStr(e.value);
      case "bool":
        return h.konst?.(e) ?? (e.value ? "TRUE" : "FALSE");
      case "null":
        return "NULL";
      case "param":
        if (!Number.isInteger(e.n) || e.n < 1) throw new Error("not a parameter to print");
        return h.konst?.(e) ?? `$${e.n}`;
      case "cast":
        return `CAST(${p(e.arg)} AS ${castName(e.to)})`;
      case "op": {
        if (!OPS.has(e.op)) throw new Error("not an operator to print");
        const [a, b] = e.args;
        // A space after a prefix operator: `- -x` must not become a comment.
        if (b === undefined) return `(${e.op} ${p(a as Expr)})`;
        return `(${p(a as Expr)} ${e.op} ${p(b)})`;
      }
      case "distinct":
        return `(${p(e.l)} IS DISTINCT FROM ${p(e.r)})`;
      case "not_distinct":
        return `(${p(e.l)} IS NOT DISTINCT FROM ${p(e.r)})`;
      case "nullif":
        return `NULLIF(${p(e.l)}, ${p(e.r)})`;
      case "in":
        return `(${p(e.arg)} ${e.not ? "NOT IN" : "IN"} (${h.foldIn?.(e) ?? list(e.list)}))`;
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
        if (!NAME.test(e.name)) throw new Error("not a function name to print");
        return h.func?.(e) ?? `${e.name}(${list(e.args)})`;
      case "extract":
        if (!/^[a-z]+$/.test(e.field)) throw new Error("not an EXTRACT field to print");
        return `EXTRACT(${e.field} FROM ${p(e.arg)})`;
      case "agg": {
        if (!NAME.test(e.name)) throw new Error("not an aggregate name to print");
        const body = e.star ? "*" : `${e.distinct ? "DISTINCT " : ""}${p(e.arg as Expr)}`;
        return `${e.name}(${body})${e.filter !== undefined ? ` FILTER (WHERE ${p(e.filter)})` : ""}`;
      }
      case "sublink": {
        const q = `(${query(e.query)})`;
        if (e.kind === "exists") return `EXISTS ${q}`;
        if (e.kind === "in") return `(${p(e.arg as Expr)} IN ${q})`;
        return q;
      }
      case "win": {
        if (!NAME.test(e.name)) throw new Error("not a function name to print");
        const body = e.star ? "*" : list(e.args);
        return `${e.name}(${body})${e.filter !== undefined ? ` FILTER (WHERE ${p(e.filter)})` : ""} OVER ${over(e.over)}`;
      }
    }
  }

  function over(o: OverClause): string {
    return o.k === "name" ? windowName(o.name) : `(${spec(o.spec)})`;
  }

  /** `ordinal`: a bare integer is a position in the output, not a value (ORDER BY, DISTINCT ON). */
  const sortItem = (s: SortItem, ordinal: boolean): string =>
    `${ordinalOrExpr(s.expr, ordinal)}${s.dir === "asc" ? " ASC" : s.dir === "desc" ? " DESC" : ""}${s.nulls === "first" ? " NULLS FIRST" : s.nulls === "last" ? " NULLS LAST" : ""}`;

  function ordinalOrExpr(e: Expr, ordinal: boolean): string {
    if (ordinal && e.k === "int") {
      if (!INT.test(e.text)) throw new Error("not an integer to print");
      return e.text;
    }
    return expr(e);
  }

  function bound(b: FrameBound): string {
    const off = h.frameOffset ?? defaultOffset;
    switch (b.k) {
      case "unbounded_preceding":
        return "UNBOUNDED PRECEDING";
      case "unbounded_following":
        return "UNBOUNDED FOLLOWING";
      case "current_row":
        return "CURRENT ROW";
      case "preceding":
        return `${off(b.offset)} PRECEDING`;
      case "following":
        return `${off(b.offset)} FOLLOWING`;
    }
  }

  function frame(f: Frame): string {
    const mode = f.mode.toUpperCase();
    return f.end === undefined
      ? `${mode} ${bound(f.start)}`
      : `${mode} BETWEEN ${bound(f.start)} AND ${bound(f.end)}`;
  }

  function spec(w: WindowSpec): string {
    return [
      ...(w.base !== undefined ? [windowName(w.base)] : []),
      ...(w.partitionBy.length > 0 ? [`PARTITION BY ${w.partitionBy.map(expr).join(", ")}`] : []),
      ...(w.orderBy.length > 0
        ? [`ORDER BY ${w.orderBy.map((s) => sortItem(s, false)).join(", ")}`]
        : []),
      ...(w.frame !== undefined ? [frame(w.frame)] : []),
    ].join(" ");
  }

  function from(f: FromItem): string {
    switch (f.k) {
      case "table": {
        if (h.table !== undefined) return h.table(f);
        const alias =
          f.alias !== undefined
            ? ` AS ${quoteIdent(f.alias)}${f.columns !== undefined ? ` (${names(f.columns)})` : ""}`
            : "";
        const name = `${f.slot !== undefined ? `${quoteIdent(f.slot)}.` : ""}${quoteIdent(f.table)}`;
        return `${name}${f.time !== undefined ? timeClause(f.time) : ""}${alias}`;
      }
      case "sub": {
        const alias =
          f.alias !== undefined
            ? ` AS ${quoteIdent(f.alias)}${f.columns !== undefined ? ` (${names(f.columns)})` : ""}`
            : "";
        return `(${query(f.query)})${alias}`;
      }
      case "join": {
        const l = from(f.left);
        const r = from(f.right);
        if (f.type === "cross") return `(${l} CROSS JOIN ${r})`;
        const kind = f.type.toUpperCase();
        const cond =
          f.using !== undefined ? `USING (${names(f.using)})` : `ON ${expr(f.on as Expr)}`;
        return `(${l} ${kind} JOIN ${r} ${cond})`;
      }
    }
  }

  const group = (g: GroupItem): string => {
    if ("k" in g && g.k === "ordinal") return String(g.n);
    return expr(g as Expr);
  };

  function item(t: SelectItem, index: number): string {
    if ("star" in t) {
      return `${(t.qualifier ?? []).map((q) => `${quoteIdent(q)}.`).join("")}*`;
    }
    const as = h.outName !== undefined ? h.outName(index, t.name ?? "") : t.name;
    return `${expr(t.expr)}${as !== undefined ? ` AS ${quoteIdent(as)}` : ""}`;
  }

  function select(b: SelectBody): string {
    const parts = [
      `SELECT${b.distinct === true ? " DISTINCT" : typeof b.distinct === "object" ? ` DISTINCT ON (${b.distinct.on.map((e) => ordinalOrExpr(e, true)).join(", ")})` : ""} ${b.targets.map(item).join(", ")}`,
    ];
    if (b.from.length > 0) parts.push(`FROM ${b.from.map(from).join(", ")}`);
    if (b.where !== undefined) parts.push(`WHERE ${expr(b.where)}`);
    if (b.groupBy.length > 0) parts.push(`GROUP BY ${b.groupBy.map(group).join(", ")}`);
    if (b.having !== undefined) parts.push(`HAVING ${expr(b.having)}`);
    if (b.windows.length > 0)
      parts.push(
        `WINDOW ${b.windows.map((w) => `${windowName(w.name)} AS (${spec(w.spec)})`).join(", ")}`,
      );
    return parts.join(" ");
  }

  const cte = (c: Cte): string =>
    `${quoteIdent(c.name)}${c.columns !== undefined ? ` (${names(c.columns)})` : ""} AS (${query(c.query)})`;

  function query(q: Query): string {
    const parts: string[] = [];
    if (q.with.length > 0) parts.push(`WITH ${q.with.map(cte).join(", ")}`);
    const b = q.body;
    parts.push(
      b.k === "select"
        ? select(b)
        : `(${query(b.left)}) ${b.op.toUpperCase()}${b.all ? " ALL" : ""} (${query(b.right)})`,
    );
    if (q.orderBy.length > 0)
      parts.push(`ORDER BY ${q.orderBy.map((s) => sortItem(s, true)).join(", ")}`);
    if (q.limit !== undefined) parts.push(`LIMIT ${expr(q.limit)}`);
    if (q.offset !== undefined) parts.push(`OFFSET ${expr(q.offset)}`);
    return parts.join(" ");
  }

  return { expr, query, from, select };
}

/** The text of an expression. */
export const printExpr = (e: Expr, h: PrintHooks = {}): string => printer(h).expr(e);

/** The text of a query. */
export const printQuery = (q: Query, h: PrintHooks = {}): string => printer(h).query(q);

/** The text of a FROM item (a table, a subquery or a join of them). */
export const printFrom = (f: FromItem, h: PrintHooks = {}): string => printer(h).from(f);
