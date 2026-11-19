// Printing a `sql` query's structured form (./ir.ts `Query`) as text (11-restricted-sql.md «处理步骤»
// 7–8: what is executed is printed from the tree, never copied from what the caller wrote).
//
// This is the logical printer: names are the logical ones (slots, tables, fields, aliases as
// written). Rewriting them to physical tables and columns is the kernel's next step and works on
// the same tree. What is printed is only what the tree holds:
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

export function printExpr(e: Expr): string {
  const p = printExpr;
  const list = (xs: readonly Expr[]) => xs.map(p).join(", ");
  switch (e.k) {
    case "col":
      return e.parts.map(quoteIdent).join(".");
    case "int":
      if (!INT.test(e.text)) throw new Error("not an integer to print");
      return e.text;
    case "num":
      if (!NUM.test(e.text)) throw new Error("not a number to print");
      return e.text;
    case "str":
      return quoteStr(e.value);
    case "bool":
      return e.value ? "TRUE" : "FALSE";
    case "null":
      return "NULL";
    case "param":
      if (!Number.isInteger(e.n) || e.n < 1) throw new Error("not a parameter to print");
      return `$${e.n}`;
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
      if (!NAME.test(e.name)) throw new Error("not a function name to print");
      return `${e.name}(${list(e.args)})`;
    case "extract":
      if (!/^[a-z]+$/.test(e.field)) throw new Error("not an EXTRACT field to print");
      return `EXTRACT(${e.field} FROM ${p(e.arg)})`;
    case "agg": {
      if (!NAME.test(e.name)) throw new Error("not an aggregate name to print");
      const body = e.star ? "*" : `${e.distinct ? "DISTINCT " : ""}${p(e.arg as Expr)}`;
      return `${e.name}(${body})${e.filter !== undefined ? ` FILTER (WHERE ${p(e.filter)})` : ""}`;
    }
    case "sublink": {
      const q = `(${printQuery(e.query)})`;
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
  return o.k === "name" ? quoteIdent(o.name) : `(${spec(o.spec)})`;
}

const sortItem = (s: SortItem): string =>
  `${printExpr(s.expr)}${s.dir === "asc" ? " ASC" : s.dir === "desc" ? " DESC" : ""}${s.nulls === "first" ? " NULLS FIRST" : s.nulls === "last" ? " NULLS LAST" : ""}`;

function offset(o: FrameOffset): string {
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

function bound(b: FrameBound): string {
  switch (b.k) {
    case "unbounded_preceding":
      return "UNBOUNDED PRECEDING";
    case "unbounded_following":
      return "UNBOUNDED FOLLOWING";
    case "current_row":
      return "CURRENT ROW";
    case "preceding":
      return `${offset(b.offset)} PRECEDING`;
    case "following":
      return `${offset(b.offset)} FOLLOWING`;
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
    ...(w.base !== undefined ? [quoteIdent(w.base)] : []),
    ...(w.partitionBy.length > 0
      ? [`PARTITION BY ${w.partitionBy.map(printExpr).join(", ")}`]
      : []),
    ...(w.orderBy.length > 0 ? [`ORDER BY ${w.orderBy.map(sortItem).join(", ")}`] : []),
    ...(w.frame !== undefined ? [frame(w.frame)] : []),
  ].join(" ");
}

function operand(o: TimeOperand): string {
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

const timeClause = (c: TimeClause): string =>
  c.k === "as_of"
    ? ` FOR VALID_TIME AS OF ${operand(c.at)}`
    : ` FOR VALID_TIME FROM ${operand(c.from)} TO ${operand(c.to)}`;

function from(f: FromItem): string {
  switch (f.k) {
    case "table": {
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
      return `(${printQuery(f.query)})${alias}`;
    }
    case "join": {
      const l = from(f.left);
      const r = from(f.right);
      if (f.type === "cross") return `(${l} CROSS JOIN ${r})`;
      const kind = f.type.toUpperCase();
      const cond =
        f.using !== undefined ? `USING (${names(f.using)})` : `ON ${printExpr(f.on as Expr)}`;
      return `(${l} ${kind} JOIN ${r} ${cond})`;
    }
  }
}

const group = (g: GroupItem): string => {
  if ("k" in g && g.k === "ordinal") return String(g.n);
  return printExpr(g as Expr);
};

function item(t: SelectItem): string {
  if ("star" in t) {
    return `${(t.qualifier ?? []).map((q) => `${quoteIdent(q)}.`).join("")}*`;
  }
  return `${printExpr(t.expr)}${t.name !== undefined ? ` AS ${quoteIdent(t.name)}` : ""}`;
}

function select(b: SelectBody): string {
  const parts = [
    `SELECT${b.distinct === true ? " DISTINCT" : typeof b.distinct === "object" ? ` DISTINCT ON (${b.distinct.on.map(printExpr).join(", ")})` : ""} ${b.targets.map(item).join(", ")}`,
  ];
  if (b.from.length > 0) parts.push(`FROM ${b.from.map(from).join(", ")}`);
  if (b.where !== undefined) parts.push(`WHERE ${printExpr(b.where)}`);
  if (b.groupBy.length > 0) parts.push(`GROUP BY ${b.groupBy.map(group).join(", ")}`);
  if (b.having !== undefined) parts.push(`HAVING ${printExpr(b.having)}`);
  if (b.windows.length > 0)
    parts.push(
      `WINDOW ${b.windows.map((w) => `${quoteIdent(w.name)} AS (${spec(w.spec)})`).join(", ")}`,
    );
  return parts.join(" ");
}

const cte = (c: Cte): string =>
  `${quoteIdent(c.name)}${c.columns !== undefined ? ` (${names(c.columns)})` : ""} AS (${printQuery(c.query)})`;

/** The text of a query. */
export function printQuery(q: Query): string {
  const parts: string[] = [];
  if (q.with.length > 0) parts.push(`WITH ${q.with.map(cte).join(", ")}`);
  const b = q.body;
  parts.push(
    b.k === "select"
      ? select(b)
      : `(${printQuery(b.left)}) ${b.op.toUpperCase()}${b.all ? " ALL" : ""} (${printQuery(b.right)})`,
  );
  if (q.orderBy.length > 0) parts.push(`ORDER BY ${q.orderBy.map(sortItem).join(", ")}`);
  if (q.limit !== undefined) parts.push(`LIMIT ${printExpr(q.limit)}`);
  if (q.offset !== undefined) parts.push(`OFFSET ${printExpr(q.offset)}`);
  return parts.join(" ");
}
