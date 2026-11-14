// Step 4 of 11-restricted-sql.md «处理步骤» for derived rules: walks libpg_query's parse tree and
// turns it into the rule's structured form (./ir.ts), refusing whatever is not in the whitelist.
//
// "Refuse what is not known" is this walker's own guarantee, not the parser's: every node is
// dispatched by its type name and every key of its body is checked against the keys this walker
// knows for it. An unknown node, an unknown key, or a known key with a value it does not handle is
// refused, so a wider grammar, or a parser version adding a field, cannot slip through.
//
// What is admitted is read from the whitelist's data (./whitelist.ts): a node, function, aggregate
// or operator missing there, or not marked for derived rules (D), is refused here whatever code
// below would make of it.
//
// Whitelisted forms this kernel does not compile yet stop as not implemented (subqueries, joins,
// WITH, set operations, window functions, DISTINCT, column alias lists).

import { notYet, refuseNode, refuseNondeterministic, reject } from "./errors.ts";
import type {
  BoolTest,
  CastTarget,
  Expr,
  FromTable,
  GroupItem,
  RuleStatement,
  Target,
} from "./ir.ts";
import {
  AGGREGATES,
  FUNCTIONS,
  index,
  NODES,
  NONDETERMINISTIC_FUNCTIONS,
  OPERATORS,
  ORDER_DEPENDENT_WINDOW,
  WINDOW_FUNCTIONS,
} from "./whitelist.ts";

type J = Record<string, unknown>;
const isObj = (v: unknown): v is J => v !== null && typeof v === "object" && !Array.isArray(v);

/** 11 «代价»: limits checked on the tree. */
export const LIMITS = {
  textBytes: 16 * 1024,
  nodes: 2000,
  depth: 32,
  inList: 1000,
  caseBranches: 256,
} as const;

const FUNCS = index(FUNCTIONS);
const AGGS = index(AGGREGATES);
const WINDOWS = index(WINDOW_FUNCTIONS);

/** Functions written in SQL syntax arrive qualified with pg_catalog (`EXTRACT`, `substring … FROM`). */
const SQL_SYNTAX = new Map([
  ["extract", "extract"],
  ["substring", "substr"],
  ["position", "strpos"],
  ["btrim", "btrim"],
  ["ltrim", "ltrim"],
  ["rtrim", "rtrim"],
]);

/** Nodes of derived rules; besides these, three are known only to be reported with a reason. */
const NODES_D: ReadonlySet<string> = new Set(
  NODES.filter((n) => n.contexts.includes("D")).map((n) => n.name),
);
const REPORTED: ReadonlySet<string> = new Set(["SQLValueFunction", "RangeFunction", "GroupingSet"]);
const gate = (t: string, loc: number | undefined): void => {
  if (!NODES_D.has(t)) refuseNode(loc, t);
};

/** Operators of derived rules; LIKE arrives as `~~` / `!~~` in its own form. */
const OPS_D: ReadonlySet<string> = new Set(
  OPERATORS.filter((o) => o.contexts.includes("D")).map((o) => o.name),
);
const LIKE_OPS = new Set(["~~", "!~~"]);
const PREFIX_OPS = new Set(["+", "-"]);

const BOOL_TESTS = new Map<string, BoolTest>([
  ["IS_TRUE", "is_true"],
  ["IS_NOT_TRUE", "is_not_true"],
  ["IS_FALSE", "is_false"],
  ["IS_NOT_FALSE", "is_not_false"],
  ["IS_UNKNOWN", "is_unknown"],
  ["IS_NOT_UNKNOWN", "is_not_unknown"],
]);

const INT64_MIN = -(2n ** 63n);
const INT64_MAX = 2n ** 63n - 1n;

class Walker {
  #nodes = 0;
  #depth = 0;

  /** A node `{Type: body}`: its type and body, counted against the node limit. */
  node(v: unknown, loc: number | undefined): [string, J] {
    if (!isObj(v)) return refuseNode(loc, "a malformed parse tree");
    const ks = Object.keys(v);
    const t = ks[0];
    if (ks.length !== 1 || t === undefined) return refuseNode(loc, "a malformed parse tree");
    const body = v[t];
    if (!isObj(body)) return refuseNode(loc, "a malformed parse tree");
    if (!REPORTED.has(t)) gate(t, loc);
    if (++this.#nodes > LIMITS.nodes) {
      reject("rule_sql_rejected", "limit", loc, `more than ${LIMITS.nodes} syntax tree nodes`);
    }
    return [t, body];
  }

  expr(v: unknown, parentLoc: number | undefined): Expr {
    if (++this.#depth > LIMITS.depth) {
      reject(
        "rule_sql_rejected",
        "limit",
        parentLoc,
        `expressions nested deeper than ${LIMITS.depth}`,
      );
    }
    try {
      const [t, b] = this.node(v, parentLoc);
      return this.#expr(t, b, locOf(b) ?? parentLoc);
    } finally {
      this.#depth--;
    }
  }

  #list(v: unknown, loc: number | undefined): unknown[] {
    if (!Array.isArray(v)) return refuseNode(loc, "a malformed parse tree");
    return v;
  }

  #exprs(v: unknown, loc: number | undefined): Expr[] {
    return this.#list(v, loc).map((x) => this.expr(x, loc));
  }

  #expr(t: string, b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    switch (t) {
      case "ColumnRef": {
        only(b, ["fields", "location"], loc, t);
        const parts = this.#list(b["fields"], loc).map((f) => {
          const [ft, fb] = this.node(f, loc);
          if (ft === "A_Star") return refuseNode(loc, "`*`");
          if (ft !== "String") return refuseNode(loc, ft);
          return str(fb, "sval", loc);
        });
        if (parts.length < 1 || parts.length > 3)
          return refuseNode(loc, "a column name of more than three parts");
        return { k: "col", parts, loc: at };
      }
      case "A_Const":
        return this.#const(b, loc);
      case "TypeCast": {
        only(b, ["arg", "typeName", "location"], loc, t);
        return {
          k: "cast",
          arg: this.expr(b["arg"], loc),
          to: this.#type(b["typeName"], loc),
          loc: at,
        };
      }
      case "A_Expr":
        return this.#aexpr(b, loc);
      case "BoolExpr": {
        only(b, ["boolop", "args", "location"], loc, t);
        const args = this.#exprs(b["args"], loc);
        switch (b["boolop"]) {
          case "AND_EXPR":
            return { k: "and", args, loc: at };
          case "OR_EXPR":
            return { k: "or", args, loc: at };
          case "NOT_EXPR": {
            const [arg] = args;
            if (args.length !== 1 || arg === undefined) return refuseNode(loc, "NOT");
            return { k: "not", arg, loc: at };
          }
          default:
            return refuseNode(loc, "this boolean expression");
        }
      }
      case "NullTest": {
        only(b, ["arg", "nulltesttype", "location"], loc, t);
        const n = b["nulltesttype"];
        if (n !== "IS_NULL" && n !== "IS_NOT_NULL") return refuseNode(loc, "this null test");
        return { k: "isnull", not: n === "IS_NOT_NULL", arg: this.expr(b["arg"], loc), loc: at };
      }
      case "BooleanTest": {
        only(b, ["arg", "booltesttype", "location"], loc, t);
        const test = BOOL_TESTS.get(String(b["booltesttype"]));
        if (test === undefined) return refuseNode(loc, "this boolean test");
        return { k: "booltest", test, arg: this.expr(b["arg"], loc), loc: at };
      }
      case "CaseExpr": {
        only(b, ["arg", "args", "defresult", "location"], loc, t);
        const whens = this.#list(b["args"], loc);
        if (whens.length > LIMITS.caseBranches) {
          reject(
            "rule_sql_rejected",
            "limit",
            loc,
            `a CASE with more than ${LIMITS.caseBranches} branches`,
          );
        }
        return {
          k: "case",
          ...("arg" in b ? { arg: this.expr(b["arg"], loc) } : {}),
          whens: whens.map((w) => {
            const [wt, wb] = this.node(w, loc);
            if (wt !== "CaseWhen") return refuseNode(loc, wt);
            only(wb, ["expr", "result", "location"], loc, wt);
            return { when: this.expr(wb["expr"], loc), result: this.expr(wb["result"], loc) };
          }),
          ...("defresult" in b ? { else: this.expr(b["defresult"], loc) } : {}),
          loc: at,
        };
      }
      case "CoalesceExpr":
        only(b, ["args", "location"], loc, t);
        return { k: "coalesce", args: this.#exprs(b["args"], loc), loc: at };
      case "MinMaxExpr": {
        only(b, ["op", "args", "location"], loc, t);
        const op = b["op"];
        if (op !== "IS_GREATEST" && op !== "IS_LEAST")
          return refuseNode(loc, "this GREATEST / LEAST");
        return {
          k: op === "IS_GREATEST" ? "greatest" : "least",
          args: this.#exprs(b["args"], loc),
          loc: at,
        };
      }
      case "FuncCall":
        return this.#func(b, loc);
      case "SQLValueFunction":
        return refuseNondeterministic(
          loc,
          "node",
          "CURRENT_DATE, CURRENT_TIMESTAMP, USER and the like",
          'use saveslot_today() or saveslot_now(); quote a column named like a keyword ("user")',
        );
      case "SubLink":
        return notYet(loc, "a subquery");
      case "ParamRef":
        return refuseNode(loc, "a parameter ($n)");
      default:
        return refuseNode(loc, t);
    }
  }

  #const(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    const value = Object.keys(b).filter((k) => k !== "location");
    const [k] = value;
    if (value.length !== 1 || k === undefined) return refuseNode(loc, "a constant");
    const inner = b[k];
    switch (k) {
      case "isnull":
        if (inner !== true) return refuseNode(loc, "a constant");
        return { k: "null", loc: at };
      case "ival": {
        // Zero values are left out of the tree: `{"ival": {}}` is 0.
        gate("Integer", loc);
        if (!isObj(inner)) return refuseNode(loc, "a constant");
        only(inner, ["ival"], loc, "Integer");
        const n = inner["ival"] ?? 0;
        if (typeof n !== "number" || !Number.isSafeInteger(n)) return refuseNode(loc, "a constant");
        return { k: "int", text: String(n), loc: at };
      }
      case "fval": {
        gate("Float", loc);
        if (!isObj(inner)) return refuseNode(loc, "a constant");
        only(inner, ["fval"], loc, "Float");
        const text = str(inner, "fval", loc);
        if (/^-?[0-9]+$/.test(text)) {
          const n = BigInt(text);
          // An integer beyond 64 bits is a decimal in PostgreSQL.
          if (n >= INT64_MIN && n <= INT64_MAX) return { k: "int", text: n.toString(), loc: at };
          return { k: "num", text, loc: at };
        }
        if (/^-?(?:[0-9]+\.[0-9]*|\.[0-9]+)$/.test(text)) return { k: "num", text, loc: at };
        return refuseNode(loc, "a number with an exponent");
      }
      case "sval": {
        gate("String", loc);
        if (!isObj(inner)) return refuseNode(loc, "a constant");
        only(inner, ["sval"], loc, "String");
        const s = inner["sval"] ?? "";
        if (typeof s !== "string") return refuseNode(loc, "a constant");
        return { k: "str", value: s, loc: at };
      }
      case "boolval": {
        gate("Boolean", loc);
        if (!isObj(inner)) return refuseNode(loc, "a constant");
        only(inner, ["boolval"], loc, "Boolean");
        const v = inner["boolval"] ?? false;
        if (typeof v !== "boolean") return refuseNode(loc, "a constant");
        return { k: "bool", value: v, loc: at };
      }
      default:
        return refuseNode(loc, k === "bsval" ? "a bit string" : "a constant");
    }
  }

  #type(v: unknown, loc: number | undefined): CastTarget {
    // `typeName` is a TypeName body, not wrapped in a node.
    if (!isObj(v)) return refuseNode(loc, "a malformed parse tree");
    gate("TypeName", loc);
    const b = v;
    only(b, ["names", "typmods", "typemod", "location"], loc, "TypeName");
    if (b["typemod"] !== undefined && b["typemod"] !== -1)
      return refuseNode(loc, "a type modifier");
    const names = this.#list(b["names"], loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return refuseNode(loc, nt);
      return str(nb, "sval", loc);
    });
    const name =
      names.length === 2 && names[0] === "pg_catalog"
        ? names[1]
        : names.length === 1
          ? names[0]
          : undefined;
    if (name === undefined)
      return reject("rule_sql_rejected", "function", loc, "a schema-qualified type");
    const mods = "typmods" in b ? this.#list(b["typmods"], loc).map((m) => this.expr(m, loc)) : [];
    const ints = mods.map((m) => (m.k === "int" ? Number(m.text) : Number.NaN));
    switch (name) {
      case "numeric": {
        if (mods.length === 0) return { t: "numeric" };
        const [p, s] = ints;
        if (
          mods.length !== 2 ||
          p === undefined ||
          s === undefined ||
          !(p >= 1 && p <= 1000) ||
          !(s >= 0 && s <= p)
        ) {
          return refuseNode(
            loc,
            "numeric other than numeric or numeric(p, s) with 0 ≤ s ≤ p ≤ 1000",
          );
        }
        // Scales are 0–12 (10 «精度与舍入»).
        if (s > 12)
          return reject("rule_sql_rejected", "type", loc, `numeric(${p}, ${s}): a scale above 12`);
        return { t: "numeric", precision: p, scale: s };
      }
      case "int8":
      case "date":
      case "timestamp":
        if (mods.length !== 0) return refuseNode(loc, `a modifier on ${name}`);
        return { t: name === "int8" ? "bigint" : name };
      case "text":
      case "varchar":
      case "bpchar":
        return refuseNondeterministic(
          loc,
          "function",
          "a cast to text (its format follows session settings)",
        );
      case "timestamptz":
        return refuseNondeterministic(
          loc,
          "function",
          "a cast to timestamptz (it follows the session time zone)",
          "use saveslot_date(<field>) for the day of a zoned date-time",
        );
      default:
        return reject("rule_sql_rejected", "function", loc, `the type ${name} in a cast`);
    }
  }

  #aexpr(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    only(
      b,
      ["kind", "name", "lexpr", "rexpr", "location", "rexpr_list_start", "rexpr_list_end"],
      loc,
      "A_Expr",
    );
    const names = this.#list(b["name"], loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return refuseNode(loc, nt);
      return str(nb, "sval", loc);
    });
    const [op] = names;
    if (names.length !== 1 || op === undefined)
      return reject("rule_sql_rejected", "function", loc, "a schema-qualified operator");
    const l = () => this.expr(b["lexpr"], loc);
    const r = () => this.expr(b["rexpr"], loc);
    const pair = (): [Expr, Expr] => {
      gate("List", loc);
      const items = this.#list(
        isObj(b["rexpr"]) && isObj(b["rexpr"]["List"]) ? b["rexpr"]["List"]["items"] : undefined,
        loc,
      );
      only(b["rexpr"] as J, ["List"], loc, "A_Expr");
      only((b["rexpr"] as J)["List"] as J, ["items"], loc, "List");
      const [x, y] = items;
      if (items.length !== 2) return refuseNode(loc, "BETWEEN");
      return [this.expr(x, loc), this.expr(y, loc)];
    };
    switch (b["kind"]) {
      case "AEXPR_OP":
        if (!("lexpr" in b)) {
          if (!PREFIX_OPS.has(op) || !OPS_D.has(op))
            return reject("rule_sql_rejected", "function", loc, `the prefix operator ${op}`);
          return { k: "op", op, args: [r()], loc: at };
        }
        if (LIKE_OPS.has(op) || !OPS_D.has(op))
          return reject("rule_sql_rejected", "function", loc, `the operator ${op}`);
        return { k: "op", op, args: [l(), r()], loc: at };
      case "AEXPR_DISTINCT":
      case "AEXPR_NOT_DISTINCT":
      case "AEXPR_NULLIF":
        if (op !== "=") return refuseNode(loc, "this comparison");
        return {
          k:
            b["kind"] === "AEXPR_DISTINCT"
              ? "distinct"
              : b["kind"] === "AEXPR_NOT_DISTINCT"
                ? "not_distinct"
                : "nullif",
          l: l(),
          r: r(),
          loc: at,
        };
      case "AEXPR_IN": {
        if (op !== "=" && op !== "<>") return refuseNode(loc, "this IN");
        const rex = b["rexpr"];
        if (!isObj(rex) || !isObj(rex["List"])) return notYet(loc, "IN (SELECT …)");
        gate("List", loc);
        only(rex, ["List"], loc, "A_Expr");
        only(rex["List"], ["items"], loc, "List");
        const items = this.#list(rex["List"]["items"], loc);
        if (items.length > LIMITS.inList) {
          reject(
            "rule_sql_rejected",
            "limit",
            loc,
            `an IN list of more than ${LIMITS.inList} items`,
          );
        }
        return {
          k: "in",
          not: op === "<>",
          arg: l(),
          list: items.map((x) => this.expr(x, loc)),
          loc: at,
        };
      }
      case "AEXPR_LIKE": {
        if (!LIKE_OPS.has(op) || !OPS_D.has(op))
          return reject("rule_sql_rejected", "function", loc, `the operator ${op}`);
        const rex = b["rexpr"];
        // `LIKE p ESCAPE e` arrives as like_escape(p, e).
        if (isObj(rex) && isObj(rex["FuncCall"])) {
          const [, fb] = this.node(rex, loc);
          const fn = this.#list(fb["funcname"], loc).map((n) =>
            str(this.node(n, loc)[1], "sval", loc),
          );
          if (fn.length === 2 && fn[0] === "pg_catalog" && fn[1] === "like_escape") {
            only(fb, ["funcname", "args", "funcformat", "location"], loc, "FuncCall");
            const [p, e] = this.#list(fb["args"], loc);
            if ((fb["args"] as unknown[]).length !== 2) return refuseNode(loc, "ESCAPE");
            const esc = this.expr(e, loc);
            // PostgreSQL takes an escape string of at most one character.
            if (esc.k !== "str" || [...esc.value].length > 1) {
              return reject(
                "rule_sql_rejected",
                "function",
                loc,
                "ESCAPE takes a string constant of at most one character",
              );
            }
            return {
              k: "like",
              not: op === "!~~",
              arg: l(),
              pattern: this.expr(p, loc),
              escape: esc,
              loc: at,
            };
          }
        }
        return { k: "like", not: op === "!~~", arg: l(), pattern: r(), loc: at };
      }
      case "AEXPR_BETWEEN":
      case "AEXPR_NOT_BETWEEN": {
        const [lo, hi] = pair();
        return { k: "between", not: b["kind"] === "AEXPR_NOT_BETWEEN", arg: l(), lo, hi, loc: at };
      }
      case "AEXPR_ILIKE":
      case "AEXPR_SIMILAR":
        return reject(
          "rule_sql_rejected",
          "function",
          loc,
          "ILIKE, SIMILAR TO and regular expressions (use LIKE)",
        );
      default:
        return refuseNode(loc, `this operator form (${String(b["kind"])})`);
    }
  }

  #func(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    only(
      b,
      [
        "funcname",
        "args",
        "agg_order",
        "agg_filter",
        "over",
        "agg_within_group",
        "agg_star",
        "agg_distinct",
        "func_variadic",
        "funcformat",
        "location",
      ],
      loc,
      "FuncCall",
    );
    const names = this.#list(b["funcname"], loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return refuseNode(loc, nt);
      return str(nb, "sval", loc);
    });
    const format = b["funcformat"];
    let name: string | undefined;
    if (names.length === 1) name = names[0];
    else if (names.length === 2 && names[0] === "pg_catalog" && format === "COERCE_SQL_SYNTAX") {
      name = SQL_SYNTAX.get(names[1] ?? "");
      if (name === undefined)
        return reject("rule_sql_rejected", "function", loc, `the function ${names[1]}`);
    } else return reject("rule_sql_rejected", "function", loc, "a schema-qualified function");
    if (name === undefined) return refuseNode(loc, "a function");
    if (format !== "COERCE_EXPLICIT_CALL" && format !== "COERCE_SQL_SYNTAX")
      return refuseNode(loc, "this function call form");
    if (b["func_variadic"] === true) return refuseNode(loc, "VARIADIC");
    if (b["agg_within_group"] === true) return refuseNode(loc, "WITHIN GROUP");
    if ("agg_order" in b) return refuseNode(loc, "ORDER BY inside an aggregate");
    const args = "args" in b ? this.#exprs(b["args"], loc) : [];

    if ("over" in b) {
      if (ORDER_DEPENDENT_WINDOW.has(name)) {
        return refuseNondeterministic(
          loc,
          "function",
          `${name}() over a window (ties make the result depend on row order)`,
        );
      }
      if (AGGS.has(name) || WINDOWS.has(name)) return notYet(loc, "a window function");
      return reject("rule_sql_rejected", "function", loc, `the window function ${name}`);
    }

    const agg = AGGS.get(name);
    if (agg?.contexts.includes("D")) {
      const star = b["agg_star"] === true;
      const distinct = b["agg_distinct"] === true;
      if ((star || distinct) && name !== "count")
        return refuseNode(loc, `${star ? "*" : "DISTINCT"} in ${name}()`);
      if (star ? args.length !== 0 : args.length !== 1) {
        return reject(
          "rule_sql_rejected",
          "function",
          loc,
          `${name}() with ${args.length} arguments`,
        );
      }
      const [arg] = args;
      return {
        k: "agg",
        name: agg.name,
        star,
        distinct,
        ...(arg !== undefined ? { arg } : {}),
        ...("agg_filter" in b ? { filter: this.expr(b["agg_filter"], loc) } : {}),
        loc: at,
      };
    }
    if (b["agg_star"] === true || b["agg_distinct"] === true || "agg_filter" in b) {
      return refuseNode(loc, `*, DISTINCT or FILTER on ${name}()`);
    }
    if (name === "extract") {
      const [field, arg] = args;
      if (args.length !== 2 || field?.k !== "str" || arg === undefined)
        return refuseNode(loc, "EXTRACT");
      return { k: "extract", field: field.value, arg, loc: at };
    }
    const fn = FUNCS.get(name);
    if (fn?.contexts.includes("D")) return { k: "func", name: fn.name, args, loc: at };
    if (NONDETERMINISTIC_FUNCTIONS.has(name)) {
      return refuseNondeterministic(
        loc,
        "function",
        `${name}()`,
        "use saveslot_now() or saveslot_today()",
      );
    }
    return reject("rule_sql_rejected", "function", loc, `the function ${name}`);
  }

  /** The statement of a derived rule. */
  statement(tree: unknown): RuleStatement {
    if (!isObj(tree)) return refuseNode(undefined, "a malformed parse tree");
    only(tree, ["version", "stmts"], undefined, "the parse result");
    const stmts = this.#list(tree["stmts"] ?? [], undefined);
    const [raw] = stmts;
    if (stmts.length !== 1 || !isObj(raw)) {
      return reject(
        "rule_sql_rejected",
        "not_select",
        undefined,
        "a derived rule is exactly one SELECT statement",
      );
    }
    gate("RawStmt", undefined);
    only(raw, ["stmt", "stmt_location", "stmt_len"], undefined, "RawStmt");
    const stmt = raw["stmt"];
    const [t] = isObj(stmt) ? Object.keys(stmt) : [];
    if (t !== "SelectStmt")
      return reject("rule_sql_rejected", "not_select", undefined, `${t ?? "this"} is not a SELECT`);
    const [, s] = this.node(stmt, undefined);
    return this.#select(s);
  }

  #select(s: J): RuleStatement {
    const loc = undefined;
    for (const k of Object.keys(s)) {
      switch (k) {
        case "targetList":
        case "fromClause":
        case "whereClause":
        case "groupClause":
        case "havingClause":
          break;
        case "op":
          if (s["op"] !== "SETOP_NONE") return notYet(loc, "UNION, INTERSECT or EXCEPT");
          break;
        case "limitOption":
          if (s["limitOption"] === "LIMIT_OPTION_WITH_TIES")
            return refuseNode(loc, "FETCH … WITH TIES");
          if (
            s["limitOption"] !== "LIMIT_OPTION_DEFAULT" &&
            s["limitOption"] !== "LIMIT_OPTION_COUNT"
          ) {
            return refuseNode(loc, "this LIMIT");
          }
          break;
        case "sortClause":
          return refuseNondeterministic(loc, "node", "ORDER BY (a derived table has no row order)");
        case "limitCount":
        case "limitOffset":
          return refuseNondeterministic(loc, "node", "LIMIT / OFFSET");
        case "distinctClause": {
          const d = this.#list(s["distinctClause"], loc);
          if (d.length === 1 && isObj(d[0]) && Object.keys(d[0]).length === 0)
            return notYet(loc, "DISTINCT");
          return refuseNondeterministic(loc, "node", "DISTINCT ON");
        }
        case "withClause": {
          const w = s["withClause"];
          // `withClause` is a WithClause body, not wrapped in a node.
          if (isObj(w) && w["recursive"] === true) {
            return refuseNode(loc, "WITH RECURSIVE");
          }
          return notYet(loc, "WITH");
        }
        case "windowClause":
          return notYet(loc, "WINDOW");
        case "groupDistinct":
          return refuseNode(loc, "GROUP BY DISTINCT");
        case "intoClause":
          return refuseNode(loc, "SELECT INTO");
        case "lockingClause":
          return refuseNode(loc, "FOR UPDATE / FOR SHARE");
        case "valuesLists":
          return refuseNode(loc, "VALUES");
        default:
          return refuseNode(loc, `SELECT with ${k}`);
      }
    }
    const targets = this.#list(s["targetList"] ?? [], loc).map((x): Target => {
      const [t, b] = this.node(x, loc);
      if (t !== "ResTarget") return refuseNode(loc, t);
      only(b, ["name", "val", "location"], locOf(b), t);
      const l = locOf(b);
      return {
        ...("name" in b ? { name: str(b, "name", l) } : {}),
        expr: this.expr(b["val"], l),
        loc: l ?? 0,
      };
    });
    if (!("fromClause" in s))
      return refuseNode(loc, "a SELECT without FROM (a derived rule needs an input table)");
    const from = this.#list(s["fromClause"], loc);
    const [only1] = from;
    if (from.length !== 1) return notYet(loc, "more than one table in FROM");
    const fromTable = this.#from(only1);
    const groupBy = this.#list(s["groupClause"] ?? [], loc).map((g): GroupItem => {
      const [gt] = this.node(g, loc);
      if (gt === "GroupingSet") return refuseNode(loc, "GROUPING SETS, ROLLUP and CUBE");
      const e = this.expr(g, loc);
      if (e.k === "int" && isObj(g) && isObj(g["A_Const"]))
        return { k: "ordinal", n: Number(e.text), loc: e.loc };
      return e;
    });
    return {
      targets,
      from: fromTable,
      ...("whereClause" in s ? { where: this.expr(s["whereClause"], loc) } : {}),
      groupBy,
      ...("havingClause" in s ? { having: this.expr(s["havingClause"], loc) } : {}),
    };
  }

  #from(v: unknown): FromTable {
    const [t, b] = this.node(v, undefined);
    const loc = locOf(b);
    switch (t) {
      case "RangeVar": {
        only(
          b,
          ["catalogname", "schemaname", "relname", "inh", "relpersistence", "alias", "location"],
          loc,
          t,
        );
        if ("catalogname" in b) return refuseNode(loc, "a table name of three parts");
        if (b["inh"] !== true) return refuseNode(loc, "ONLY");
        if (b["relpersistence"] !== "p") return refuseNode(loc, "this table reference");
        let alias: string | undefined;
        if ("alias" in b) {
          const a = b["alias"];
          if (!isObj(a)) return refuseNode(loc, "an alias");
          gate("Alias", loc);
          only(a, ["aliasname", "colnames"], loc, "Alias");
          if ("colnames" in a) return notYet(loc, "a column alias list");
          alias = str(a, "aliasname", loc);
        }
        return {
          ...("schemaname" in b ? { slot: str(b, "schemaname", loc) } : {}),
          table: str(b, "relname", loc),
          ...(alias !== undefined ? { alias } : {}),
          loc: loc ?? 0,
        };
      }
      case "JoinExpr":
        return notYet(loc, "JOIN");
      case "RangeSubselect":
        if (b["lateral"] === true) return refuseNode(loc, "LATERAL");
        return notYet(loc, "a subquery in FROM");
      case "RangeFunction":
        return refuseNode(loc, "a function in FROM");
      default:
        return refuseNode(loc, t);
    }
  }
}

const locOf = (b: J): number | undefined =>
  typeof b["location"] === "number" && b["location"] >= 0 ? b["location"] : undefined;

function only(b: J, keys: readonly string[], loc: number | undefined, what: string): void {
  for (const k of Object.keys(b)) if (!keys.includes(k)) refuseNode(loc, `${what} with ${k}`);
}

function str(b: J, key: string, loc: number | undefined): string {
  const v = b[key];
  if (typeof v !== "string") return refuseNode(loc, "a malformed parse tree");
  return v;
}

/** The structured form of a derived rule's parse tree, or a thrown RsqlError. */
export function convertRule(tree: unknown): RuleStatement {
  return new Walker().statement(tree);
}
