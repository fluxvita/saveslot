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
// Whitelisted forms a derived rule has but this kernel does not compile yet stop as not implemented
// (subqueries, joins, WITH, set operations, window functions, DISTINCT, column alias lists); `sql`
// queries (S) take all of them (`convertQuery`).

import { notYet, refuseNode, refuseNondeterministic, reject } from "./errors.ts";
import type {
  BoolTest,
  CastTarget,
  Cte,
  Expr,
  Frame,
  FrameBound,
  FrameOffset,
  FromItem,
  FromTable,
  GroupItem,
  NamedWindow,
  OverClause,
  Query,
  RuleStatement,
  SelectBody,
  SelectItem,
  SortItem,
  Target,
  TimeClause,
  WindowSpec,
} from "./ir.ts";
import {
  AGGREGATES,
  type Context,
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
  /** Subqueries nested in each other: FROM, scalar, EXISTS, IN and CTE queries each count one. */
  subqueries: 4,
  tableRefs: 8,
  ctes: 8,
  setBranches: 8,
  params: 100,
  windows: 4,
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

/** Nodes of a context; besides these, three are known only to be reported with a reason. */
const nodesOf = (c: Context): ReadonlySet<string> =>
  new Set(NODES.filter((n) => n.contexts.includes(c)).map((n) => n.name));
const NODES_BY: Readonly<Record<"S" | "D", ReadonlySet<string>>> = {
  S: nodesOf("S"),
  D: nodesOf("D"),
};
const REPORTED: ReadonlySet<string> = new Set(["SQLValueFunction", "RangeFunction", "GroupingSet"]);

/** Operators of a context; LIKE arrives as `~~` / `!~~` in its own form. */
const opsOf = (c: Context): ReadonlySet<string> =>
  new Set(OPERATORS.filter((o) => o.contexts.includes(c)).map((o) => o.name));
const OPS_BY: Readonly<Record<"S" | "D", ReadonlySet<string>>> = { S: opsOf("S"), D: opsOf("D") };
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

/** What the caller's text had beside the parse tree: the time clauses taken out of it by name position. */
export interface ConvertOptions {
  /** `FOR VALID_TIME` clauses by the byte offset of the table name they follow (11 «处理步骤» 2). */
  readonly timeClauses?: ReadonlyMap<number, TimeClause>;
}

/** What a converted `sql` query was found to use, for the checks that need the whole text. */
export interface QueryFacts {
  /** The parameters `$n` that appear, with where the first of each is. */
  readonly params: ReadonlyMap<number, number>;
  /** Time clauses not attached to a table reference (by name offset). */
  readonly unattached: readonly number[];
  /** The table references written in the text (11 «代价»: the count is of references, not of tables). */
  readonly tableRefs: number;
}

class Walker {
  #nodes = 0;
  #depth = 0;
  readonly #c: "S" | "D";
  readonly #nodeSet: ReadonlySet<string>;
  readonly #ops: ReadonlySet<string>;
  readonly #opts: ConvertOptions;
  #subDepth = 0;
  #tableRefs = 0;
  #ctes = 0;
  #windows = 0;
  readonly #params = new Map<number, number>();
  readonly #attached = new Set<number>();

  constructor(c: "S" | "D" = "D", opts: ConvertOptions = {}) {
    this.#c = c;
    this.#nodeSet = NODES_BY[c];
    this.#ops = OPS_BY[c];
    this.#opts = opts;
  }

  /** The parameters seen and the time clauses not used. */
  get facts(): QueryFacts {
    return {
      params: this.#params,
      unattached: [...(this.#opts.timeClauses?.keys() ?? [])].filter((k) => !this.#attached.has(k)),
      tableRefs: this.#tableRefs,
    };
  }

  /** A node or form not in the whitelist. */
  no(loc: number | undefined, what: string): never {
    return refuseNode(loc, what, this.#c);
  }

  gate(t: string, loc: number | undefined): void {
    if (!this.#nodeSet.has(t)) this.no(loc, t);
  }

  /** Whether the whitelist admits a function, aggregate or window function here. */
  #admits(e: { readonly contexts: readonly Context[] } | undefined): boolean {
    return e?.contexts.includes(this.#c) === true;
  }

  only(b: J, keys: readonly string[], loc: number | undefined, what: string): void {
    for (const k of Object.keys(b)) if (!keys.includes(k)) this.no(loc, `${what} with ${k}`);
  }

  str(b: J, key: string, loc: number | undefined): string {
    // The body of a String node holds the string and nothing else.
    if (key === "sval") this.only(b, ["sval"], loc, "String");
    const v = b[key];
    if (typeof v !== "string") return this.no(loc, "a malformed parse tree");
    return v;
  }

  /**
   * A name the caller writes (a column, an alias, a CTE, a window, a table). In S it is folded to
   * lower case here, so the analyzer and the printed text agree: PostgreSQL compares quoted names
   * exactly, the analyzer by ASCII case-folding, and one spelling for both is what makes them the same
   * (11 «名字»: caller-chosen names are case-insensitive too).
   */
  id(b: J, key: string, loc: number | undefined): string {
    const v = this.str(b, key, loc);
    return this.#c === "S" ? v.replace(/[A-Z]/g, (c) => c.toLowerCase()) : v;
  }

  #limit(loc: number | undefined, what: string): never {
    return reject("rule_sql_rejected", "limit", loc, what);
  }

  /** A node `{Type: body}`: its type and body, counted against the node limit. */
  node(v: unknown, loc: number | undefined): [string, J] {
    if (!isObj(v)) return this.no(loc, "a malformed parse tree");
    const ks = Object.keys(v);
    const t = ks[0];
    if (ks.length !== 1 || t === undefined) return this.no(loc, "a malformed parse tree");
    const body = v[t];
    if (!isObj(body)) return this.no(loc, "a malformed parse tree");
    if (!REPORTED.has(t)) this.gate(t, loc);
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
    if (!Array.isArray(v)) return this.no(loc, "a malformed parse tree");
    return v;
  }

  #exprs(v: unknown, loc: number | undefined): Expr[] {
    return this.#list(v, loc).map((x) => this.expr(x, loc));
  }

  #expr(t: string, b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    switch (t) {
      case "ColumnRef": {
        this.only(b, ["fields", "location"], loc, t);
        const parts = this.#list(b["fields"], loc).map((f) => {
          const [ft, fb] = this.node(f, loc);
          if (ft === "A_Star") return this.no(loc, "`*`");
          if (ft !== "String") return this.no(loc, ft);
          return this.id(fb, "sval", loc);
        });
        if (parts.length < 1 || parts.length > 3)
          return this.no(loc, "a column name of more than three parts");
        return { k: "col", parts, loc: at };
      }
      case "A_Const":
        return this.#const(b, loc);
      case "TypeCast": {
        this.only(b, ["arg", "typeName", "location"], loc, t);
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
        this.only(b, ["boolop", "args", "location"], loc, t);
        const args = this.#exprs(b["args"], loc);
        switch (b["boolop"]) {
          case "AND_EXPR":
            return { k: "and", args, loc: at };
          case "OR_EXPR":
            return { k: "or", args, loc: at };
          case "NOT_EXPR": {
            const [arg] = args;
            if (args.length !== 1 || arg === undefined) return this.no(loc, "NOT");
            return { k: "not", arg, loc: at };
          }
          default:
            return this.no(loc, "this boolean expression");
        }
      }
      case "NullTest": {
        this.only(b, ["arg", "nulltesttype", "location"], loc, t);
        const n = b["nulltesttype"];
        if (n !== "IS_NULL" && n !== "IS_NOT_NULL") return this.no(loc, "this null test");
        return { k: "isnull", not: n === "IS_NOT_NULL", arg: this.expr(b["arg"], loc), loc: at };
      }
      case "BooleanTest": {
        this.only(b, ["arg", "booltesttype", "location"], loc, t);
        const test = BOOL_TESTS.get(String(b["booltesttype"]));
        if (test === undefined) return this.no(loc, "this boolean test");
        return { k: "booltest", test, arg: this.expr(b["arg"], loc), loc: at };
      }
      case "CaseExpr": {
        this.only(b, ["arg", "args", "defresult", "location"], loc, t);
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
            if (wt !== "CaseWhen") return this.no(loc, wt);
            this.only(wb, ["expr", "result", "location"], loc, wt);
            return { when: this.expr(wb["expr"], loc), result: this.expr(wb["result"], loc) };
          }),
          ...("defresult" in b ? { else: this.expr(b["defresult"], loc) } : {}),
          loc: at,
        };
      }
      case "CoalesceExpr":
        this.only(b, ["args", "location"], loc, t);
        return { k: "coalesce", args: this.#exprs(b["args"], loc), loc: at };
      case "MinMaxExpr": {
        this.only(b, ["op", "args", "location"], loc, t);
        const op = b["op"];
        if (op !== "IS_GREATEST" && op !== "IS_LEAST") return this.no(loc, "this GREATEST / LEAST");
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
          "SQLValueFunction",
        );
      case "SubLink":
        return this.#c === "S" ? this.#sublink(b, loc) : notYet(loc, "a subquery");
      case "ParamRef":
        return this.#c === "S" ? this.#param(b, loc) : this.no(loc, "a parameter ($n)");
      default:
        return this.no(loc, t);
    }
  }

  #const(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    const value = Object.keys(b).filter((k) => k !== "location");
    const [k] = value;
    if (value.length !== 1 || k === undefined) return this.no(loc, "a constant");
    const inner = b[k];
    switch (k) {
      case "isnull":
        if (inner !== true) return this.no(loc, "a constant");
        return { k: "null", loc: at };
      case "ival": {
        // Zero values are left out of the tree: `{"ival": {}}` is 0.
        this.gate("Integer", loc);
        if (!isObj(inner)) return this.no(loc, "a constant");
        this.only(inner, ["ival"], loc, "Integer");
        const n = inner["ival"] ?? 0;
        if (typeof n !== "number" || !Number.isSafeInteger(n)) return this.no(loc, "a constant");
        return { k: "int", text: String(n), loc: at };
      }
      case "fval": {
        this.gate("Float", loc);
        if (!isObj(inner)) return this.no(loc, "a constant");
        this.only(inner, ["fval"], loc, "Float");
        const text = this.str(inner, "fval", loc);
        if (/^-?[0-9]+$/.test(text)) {
          const n = BigInt(text);
          // An integer beyond 64 bits is a decimal in PostgreSQL.
          if (n >= INT64_MIN && n <= INT64_MAX) return { k: "int", text: n.toString(), loc: at };
          return { k: "num", text, loc: at };
        }
        if (/^-?(?:[0-9]+\.[0-9]*|\.[0-9]+)$/.test(text)) return { k: "num", text, loc: at };
        return this.no(loc, "a number with an exponent");
      }
      case "sval": {
        this.gate("String", loc);
        if (!isObj(inner)) return this.no(loc, "a constant");
        this.only(inner, ["sval"], loc, "String");
        const s = inner["sval"] ?? "";
        if (typeof s !== "string") return this.no(loc, "a constant");
        return { k: "str", value: s, loc: at };
      }
      case "boolval": {
        this.gate("Boolean", loc);
        if (!isObj(inner)) return this.no(loc, "a constant");
        this.only(inner, ["boolval"], loc, "Boolean");
        const v = inner["boolval"] ?? false;
        if (typeof v !== "boolean") return this.no(loc, "a constant");
        return { k: "bool", value: v, loc: at };
      }
      default:
        return this.no(loc, k === "bsval" ? "a bit string" : "a constant");
    }
  }

  #type(v: unknown, loc: number | undefined): CastTarget {
    // `typeName` is a TypeName body, not wrapped in a node.
    if (!isObj(v)) return this.no(loc, "a malformed parse tree");
    this.gate("TypeName", loc);
    const b = v;
    this.only(b, ["names", "typmods", "typemod", "location"], loc, "TypeName");
    if (b["typemod"] !== undefined && b["typemod"] !== -1) return this.no(loc, "a type modifier");
    const names = this.#list(b["names"], loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return this.no(loc, nt);
      return this.str(nb, "sval", loc);
    });
    const name =
      names.length === 2 && names[0] === "pg_catalog"
        ? names[1]
        : names.length === 1
          ? names[0]
          : undefined;
    if (name === undefined)
      return reject(
        "rule_sql_rejected",
        "function",
        loc,
        "a schema-qualified type",
        undefined,
        names.join("."),
      );
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
          return this.no(loc, "numeric other than numeric or numeric(p, s) with 0 ≤ s ≤ p ≤ 1000");
        }
        // Scales are 0–12 (10 «精度与舍入»).
        if (s > 12)
          return reject("rule_sql_rejected", "type", loc, `numeric(${p}, ${s}): a scale above 12`);
        return { t: "numeric", precision: p, scale: s };
      }
      case "int8":
      case "date":
      case "timestamp":
        if (mods.length !== 0) return this.no(loc, `a modifier on ${name}`);
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
        return reject(
          "rule_sql_rejected",
          "function",
          loc,
          `the type ${name} in a cast`,
          undefined,
          name,
        );
    }
  }

  #aexpr(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    this.only(
      b,
      ["kind", "name", "lexpr", "rexpr", "location", "rexpr_list_start", "rexpr_list_end"],
      loc,
      "A_Expr",
    );
    const names = this.#list(b["name"], loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return this.no(loc, nt);
      return this.str(nb, "sval", loc);
    });
    const [op] = names;
    if (names.length !== 1 || op === undefined)
      return reject(
        "rule_sql_rejected",
        "function",
        loc,
        "a schema-qualified operator",
        undefined,
        names.join("."),
      );
    const l = () => this.expr(b["lexpr"], loc);
    const r = () => this.expr(b["rexpr"], loc);
    const pair = (): [Expr, Expr] => {
      this.gate("List", loc);
      const items = this.#list(
        isObj(b["rexpr"]) && isObj(b["rexpr"]["List"]) ? b["rexpr"]["List"]["items"] : undefined,
        loc,
      );
      this.only(b["rexpr"] as J, ["List"], loc, "A_Expr");
      this.only((b["rexpr"] as J)["List"] as J, ["items"], loc, "List");
      const [x, y] = items;
      if (items.length !== 2) return this.no(loc, "BETWEEN");
      return [this.expr(x, loc), this.expr(y, loc)];
    };
    switch (b["kind"]) {
      case "AEXPR_OP":
        if (!("lexpr" in b)) {
          if (!PREFIX_OPS.has(op) || !this.#ops.has(op))
            return reject(
              "rule_sql_rejected",
              "function",
              loc,
              `the prefix operator ${op}`,
              undefined,
              op,
            );
          return { k: "op", op, args: [r()], loc: at };
        }
        if (LIKE_OPS.has(op) || !this.#ops.has(op))
          return reject("rule_sql_rejected", "function", loc, `the operator ${op}`, undefined, op);
        return { k: "op", op, args: [l(), r()], loc: at };
      case "AEXPR_DISTINCT":
      case "AEXPR_NOT_DISTINCT":
      case "AEXPR_NULLIF":
        if (op !== "=") return this.no(loc, "this comparison");
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
        if (op !== "=" && op !== "<>") return this.no(loc, "this IN");
        const rex = b["rexpr"];
        if (!isObj(rex) || !isObj(rex["List"])) return notYet(loc, "IN (SELECT …)");
        this.gate("List", loc);
        this.only(rex, ["List"], loc, "A_Expr");
        this.only(rex["List"], ["items"], loc, "List");
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
        if (!LIKE_OPS.has(op) || !this.#ops.has(op))
          return reject("rule_sql_rejected", "function", loc, `the operator ${op}`, undefined, op);
        const rex = b["rexpr"];
        // `LIKE p ESCAPE e` arrives as like_escape(p, e).
        if (isObj(rex) && isObj(rex["FuncCall"])) {
          const [, fb] = this.node(rex, loc);
          const fn = this.#list(fb["funcname"], loc).map((n) =>
            this.str(this.node(n, loc)[1], "sval", loc),
          );
          if (fn.length === 2 && fn[0] === "pg_catalog" && fn[1] === "like_escape") {
            this.only(fb, ["funcname", "args", "funcformat", "location"], loc, "FuncCall");
            const [p, e] = this.#list(fb["args"], loc);
            if ((fb["args"] as unknown[]).length !== 2) return this.no(loc, "ESCAPE");
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
          undefined,
          op,
        );
      default:
        return this.no(loc, `this operator form (${String(b["kind"])})`);
    }
  }

  #func(b: J, loc: number | undefined): Expr {
    const at = loc ?? 0;
    this.only(
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
      if (nt !== "String") return this.no(loc, nt);
      return this.str(nb, "sval", loc);
    });
    const format = b["funcformat"];
    let name: string | undefined;
    if (names.length === 1) name = names[0];
    else if (names.length === 2 && names[0] === "pg_catalog" && format === "COERCE_SQL_SYNTAX") {
      name = SQL_SYNTAX.get(names[1] ?? "");
      if (name === undefined)
        return reject(
          "rule_sql_rejected",
          "function",
          loc,
          `the function ${names[1]}`,
          undefined,
          names[1],
        );
    } else
      return reject(
        "rule_sql_rejected",
        "function",
        loc,
        "a schema-qualified function",
        undefined,
        names.join("."),
      );
    if (name === undefined) return this.no(loc, "a function");
    if (format !== "COERCE_EXPLICIT_CALL" && format !== "COERCE_SQL_SYNTAX")
      return this.no(loc, "this function call form");
    if (b["func_variadic"] === true) return this.no(loc, "VARIADIC");
    if (b["agg_within_group"] === true) return this.no(loc, "WITHIN GROUP");
    if ("agg_order" in b) return this.no(loc, "ORDER BY inside an aggregate");
    const args = "args" in b ? this.#exprs(b["args"], loc) : [];

    if ("over" in b) {
      if (this.#c === "S") return this.#window(name, b, args, at, loc);
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
    if (agg !== undefined && this.#admits(agg)) {
      const star = b["agg_star"] === true;
      const distinct = b["agg_distinct"] === true;
      if ((star || distinct) && name !== "count")
        return this.no(loc, `${star ? "*" : "DISTINCT"} in ${name}()`);
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
      return this.no(loc, `*, DISTINCT or FILTER on ${name}()`);
    }
    if (name === "extract") {
      const [field, arg] = args;
      if (args.length !== 2 || field?.k !== "str" || arg === undefined)
        return this.no(loc, "EXTRACT");
      return { k: "extract", field: field.value, arg, loc: at };
    }
    const fn = FUNCS.get(name);
    if (fn !== undefined && this.#admits(fn)) return { k: "func", name: fn.name, args, loc: at };
    if (NONDETERMINISTIC_FUNCTIONS.has(name)) {
      return refuseNondeterministic(
        loc,
        "function",
        `${name}()`,
        "use saveslot_now() or saveslot_today()",
        name,
      );
    }
    return reject("rule_sql_rejected", "function", loc, `the function ${name}`, undefined, name);
  }

  // --- `sql` queries (S) ---------------------------------------------------------------------

  #param(b: J, loc: number | undefined): Expr {
    this.only(b, ["number", "location"], loc, "ParamRef");
    const n = b["number"];
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1) return this.no(loc, "a parameter");
    if (n > LIMITS.params) this.#limit(loc, `a parameter above $${LIMITS.params}`);
    if (!this.#params.has(n)) this.#params.set(n, loc ?? 0);
    return { k: "param", n, loc: loc ?? 0 };
  }

  /** A subquery in an expression: scalar, EXISTS, or `x IN (SELECT …)`. */
  #sublink(b: J, loc: number | undefined): Expr {
    this.only(b, ["subLinkType", "testexpr", "operName", "subselect", "location"], loc, "SubLink");
    const at = loc ?? 0;
    const type = b["subLinkType"];
    if (type === "EXISTS_SUBLINK" || type === "EXPR_SUBLINK") {
      if ("testexpr" in b || "operName" in b) return this.no(loc, "this subquery");
      return {
        k: "sublink",
        kind: type === "EXISTS_SUBLINK" ? "exists" : "scalar",
        query: this.#nested(b["subselect"], loc),
        loc: at,
      };
    }
    if (type === "ANY_SUBLINK" && !("operName" in b) && "testexpr" in b) {
      const arg = this.expr(b["testexpr"], loc);
      return { k: "sublink", kind: "in", arg, query: this.#nested(b["subselect"], loc), loc: at };
    }
    return this.no(
      loc,
      type === "ANY_SUBLINK" ? "<op> ANY (SELECT …)" : `a subquery of kind ${String(type)}`,
    );
  }

  /** A query one level down: a FROM subquery, a subquery in an expression, a CTE's query. */
  #nested(v: unknown, loc: number | undefined): Query {
    // A statement that is not a SELECT (INSERT, UPDATE, DELETE in a WITH) is not one whatever the
    // whitelist says of its node.
    const kind = isObj(v) ? Object.keys(v)[0] : undefined;
    if (kind !== "SelectStmt") {
      return reject(
        "rule_sql_rejected",
        "not_select",
        loc,
        `${kind ?? "this"} is not a SELECT`,
        undefined,
        kind,
      );
    }
    const [, body] = this.node(v, loc);
    if (++this.#subDepth > LIMITS.subqueries) {
      this.#limit(loc, `subqueries nested deeper than ${LIMITS.subqueries}`);
    }
    try {
      return this.#query(body);
    } finally {
      this.#subDepth--;
    }
  }

  #sort(v: unknown, loc: number | undefined): SortItem[] {
    return this.#list(v, loc).map((x): SortItem => {
      const [t, b] = this.node(x, loc);
      if (t !== "SortBy") return this.no(loc, t);
      const l = locOf(b) ?? loc;
      this.only(b, ["node", "sortby_dir", "sortby_nulls", "useOp", "location"], l, t);
      const dir = b["sortby_dir"];
      const nulls = b["sortby_nulls"];
      if (dir === "SORTBY_USING" || "useOp" in b) return this.no(l, "ORDER BY … USING <operator>");
      return {
        expr: this.expr(b["node"], l),
        dir: dir === "SORTBY_ASC" ? "asc" : dir === "SORTBY_DESC" ? "desc" : "default",
        nulls:
          nulls === "SORTBY_NULLS_FIRST"
            ? "first"
            : nulls === "SORTBY_NULLS_LAST"
              ? "last"
              : "default",
      };
    });
  }

  /** LIMIT or OFFSET: a constant or `$n` (11 «语句形状»); the analysis checks its type. */
  #limitValue(v: unknown, loc: number | undefined): Expr {
    const e = this.expr(v, loc);
    if (
      e.k !== "int" &&
      e.k !== "num" &&
      e.k !== "str" &&
      e.k !== "bool" &&
      e.k !== "null" &&
      e.k !== "param"
    ) {
      return this.no(loc, "LIMIT or OFFSET other than a constant or $n");
    }
    return e;
  }

  #groupItems(v: unknown, loc: number | undefined): GroupItem[] {
    return this.#list(v ?? [], loc).map((g): GroupItem => {
      const [gt] = this.node(g, loc);
      if (gt === "GroupingSet") return this.no(loc, "GROUPING SETS, ROLLUP and CUBE");
      const e = this.expr(g, loc);
      if (e.k === "int" && isObj(g) && isObj(g["A_Const"]))
        return { k: "ordinal", n: Number(e.text), loc: e.loc };
      return e;
    });
  }

  /** A column-name list: `AS t (a, b)`, `USING (a)`, a CTE's column names. */
  #names(v: unknown, loc: number | undefined): string[] {
    return this.#list(v, loc).map((n) => {
      const [nt, nb] = this.node(n, loc);
      if (nt !== "String") return this.no(loc, nt);
      return this.id(nb, "sval", loc);
    });
  }

  /** The body of a SelectStmt (a query: WITH, set operations, ORDER BY, LIMIT around a SELECT). */
  #query(s: J): Query {
    const loc = undefined;
    let cte: Cte[] = [];
    let limitCount: Expr | undefined;
    let limitOffset: Expr | undefined;
    for (const k of Object.keys(s)) {
      switch (k) {
        case "targetList":
        case "fromClause":
        case "whereClause":
        case "groupClause":
        case "havingClause":
        case "windowClause":
        case "distinctClause":
        case "sortClause":
        case "limitCount":
        case "limitOffset":
        case "withClause":
        case "op":
        case "all":
        case "larg":
        case "rarg":
          break;
        case "limitOption":
          if (s["limitOption"] === "LIMIT_OPTION_WITH_TIES")
            return this.no(loc, "FETCH … WITH TIES");
          if (
            s["limitOption"] !== "LIMIT_OPTION_DEFAULT" &&
            s["limitOption"] !== "LIMIT_OPTION_COUNT"
          ) {
            return this.no(loc, "this LIMIT");
          }
          break;
        case "groupDistinct":
          return this.no(loc, "GROUP BY DISTINCT");
        case "intoClause":
          return this.no(loc, "SELECT INTO");
        case "lockingClause":
          return this.no(loc, "FOR UPDATE / FOR SHARE");
        case "valuesLists":
          return this.no(loc, "VALUES");
        default:
          return this.no(loc, `SELECT with ${k}`);
      }
    }
    if ("withClause" in s) cte = this.#with(s["withClause"], loc);
    const orderBy = "sortClause" in s ? this.#sort(s["sortClause"], loc) : [];
    if ("limitCount" in s) limitCount = this.#limitValue(s["limitCount"], loc);
    if ("limitOffset" in s) limitOffset = this.#limitValue(s["limitOffset"], loc);
    const around = {
      with: cte,
      orderBy,
      ...(limitCount !== undefined ? { limit: limitCount } : {}),
      ...(limitOffset !== undefined ? { offset: limitOffset } : {}),
      loc: 0,
    };
    const op = s["op"] ?? "SETOP_NONE";
    if (op !== "SETOP_NONE") {
      const kind =
        op === "SETOP_UNION" ? "union" : op === "SETOP_INTERSECT" ? "intersect" : "except";
      if (op !== "SETOP_UNION" && op !== "SETOP_INTERSECT" && op !== "SETOP_EXCEPT")
        return this.no(loc, "this set operation");
      for (const k of [
        "targetList",
        "fromClause",
        "whereClause",
        "groupClause",
        "havingClause",
        "windowClause",
        "distinctClause",
      ]) {
        if (k in s) return this.no(loc, `SELECT with ${k}`);
      }
      const l = s["larg"];
      const r = s["rarg"];
      if (!isObj(l) || !isObj(r)) return this.no(loc, "a malformed parse tree");
      const left = this.#queryBranch(l);
      const right = this.#queryBranch(r);
      const q: Query = {
        ...around,
        body: { k: "setop", op: kind, all: s["all"] === true, left, right, loc: 0 },
      };
      if (branches(q) > LIMITS.setBranches) {
        this.#limit(loc, `a set operation of more than ${LIMITS.setBranches} branches`);
      }
      return q;
    }
    return { ...around, body: this.#selectBody(s, loc) };
  }

  /** A branch of a set operation: a SelectStmt body, counted as a node. */
  #queryBranch(b: J): Query {
    if (++this.#nodes > LIMITS.nodes)
      this.#limit(undefined, `more than ${LIMITS.nodes} syntax tree nodes`);
    return this.#query(b);
  }

  #with(v: unknown, loc: number | undefined): Cte[] {
    // `withClause` is a WithClause body, not wrapped in a node.
    if (!isObj(v)) return this.no(loc, "a malformed parse tree");
    this.gate("WithClause", loc);
    this.only(v, ["ctes", "recursive", "location"], loc, "WithClause");
    if (v["recursive"] === true) return this.no(loc, "WITH RECURSIVE");
    return this.#list(v["ctes"], loc).map((x): Cte => {
      const [t, b] = this.node(x, loc);
      if (t !== "CommonTableExpr") return this.no(loc, t);
      const l = locOf(b) ?? loc;
      this.only(
        b,
        [
          "ctename",
          "aliascolnames",
          "ctematerialized",
          "ctequery",
          "search_clause",
          "cycle_clause",
          "location",
        ],
        l,
        t,
      );
      if (++this.#ctes > LIMITS.ctes) this.#limit(l, `more than ${LIMITS.ctes} CTEs`);
      if (b["ctematerialized"] !== "CTEMaterializeDefault")
        return this.no(l, "MATERIALIZED / NOT MATERIALIZED");
      if ("search_clause" in b) return this.no(l, "SEARCH");
      if ("cycle_clause" in b) return this.no(l, "CYCLE");
      return {
        name: this.id(b, "ctename", l),
        ...("aliascolnames" in b ? { columns: this.#names(b["aliascolnames"], l) } : {}),
        query: this.#nested(b["ctequery"], l),
        loc: l ?? 0,
      };
    });
  }

  /** One SELECT: output columns, FROM, WHERE, GROUP BY, HAVING, WINDOW, DISTINCT. */
  #selectBody(s: J, loc: number | undefined): SelectBody {
    let distinct: SelectBody["distinct"] = false;
    if ("distinctClause" in s) {
      const d = this.#list(s["distinctClause"], loc);
      const first = d[0];
      distinct =
        d.length === 1 && isObj(first) && Object.keys(first).length === 0
          ? true
          : { on: d.map((x) => this.expr(x, loc)) };
    }
    const targets = this.#list(s["targetList"] ?? [], loc).map((x): SelectItem => {
      const [t, b] = this.node(x, loc);
      if (t !== "ResTarget") return this.no(loc, t);
      this.only(b, ["name", "val", "location"], locOf(b), t);
      const l = locOf(b);
      const star = this.#star(b["val"], l);
      if (star !== undefined) {
        if ("name" in b) return this.no(l, "a name for `*`");
        return star;
      }
      return {
        ...("name" in b ? { name: this.id(b, "name", l) } : {}),
        expr: this.expr(b["val"], l),
        loc: l ?? 0,
      };
    });
    if (targets.length === 0) return this.no(loc, "a SELECT without output columns");
    const from = this.#list(s["fromClause"] ?? [], loc).map((f) => this.#fromItem(f));
    const windows = this.#list(s["windowClause"] ?? [], loc).map((w): NamedWindow => {
      const [t, b] = this.node(w, loc);
      if (t !== "WindowDef") return this.no(loc, t);
      if (typeof b["name"] !== "string") return this.no(loc, "a window without a name");
      this.#windows++;
      this.#windowLimit(loc);
      return { name: this.id(b, "name", loc), spec: this.#spec(b, locOf(b) ?? loc, true) };
    });
    return {
      k: "select",
      distinct,
      targets,
      from,
      ...("whereClause" in s ? { where: this.expr(s["whereClause"], loc) } : {}),
      groupBy: this.#groupItems(s["groupClause"], loc),
      ...("havingClause" in s ? { having: this.expr(s["havingClause"], loc) } : {}),
      windows,
      loc: 0,
    };
  }

  /** `*` or `t.*` / `slot.t.*` in an output position. */
  #star(val: unknown, loc: number | undefined): SelectItem | undefined {
    if (!isObj(val) || !isObj(val["ColumnRef"])) return undefined;
    const body = val["ColumnRef"];
    const fields = body["fields"];
    if (!Array.isArray(fields)) return undefined;
    const last = fields[fields.length - 1];
    if (!isObj(last) || !("A_Star" in last)) return undefined;
    this.node(val, loc);
    this.only(body, ["fields", "location"], loc, "ColumnRef");
    this.gate("A_Star", loc);
    const [, star] = this.node(last, loc);
    this.only(star, [], loc, "A_Star");
    const qualifier = fields.slice(0, -1).map((f) => {
      const [ft, fb] = this.node(f, loc);
      if (ft !== "String") return this.no(loc, ft);
      return this.id(fb, "sval", loc);
    });
    if (qualifier.length > 2) return this.no(loc, "a column name of more than three parts");
    return { star: true, ...(qualifier.length > 0 ? { qualifier } : {}), loc: locOf(body) ?? 0 };
  }

  #fromItem(v: unknown): FromItem {
    const [t, b] = this.node(v, undefined);
    const loc = locOf(b);
    switch (t) {
      case "RangeVar": {
        this.only(
          b,
          ["catalogname", "schemaname", "relname", "inh", "relpersistence", "alias", "location"],
          loc,
          t,
        );
        if ("catalogname" in b) return this.no(loc, "a table name of three parts");
        if (b["inh"] !== true) return this.no(loc, "ONLY");
        if (b["relpersistence"] !== "p") return this.no(loc, "this table reference");
        if (++this.#tableRefs > LIMITS.tableRefs)
          this.#limit(loc, `more than ${LIMITS.tableRefs} table references`);
        const alias = this.#alias(b["alias"], loc);
        const time = loc === undefined ? undefined : this.#opts.timeClauses?.get(loc);
        if (time !== undefined && loc !== undefined) this.#attached.add(loc);
        return {
          k: "table",
          ...("schemaname" in b ? { slot: this.id(b, "schemaname", loc) } : {}),
          table: this.id(b, "relname", loc),
          ...(alias?.name !== undefined ? { alias: alias.name } : {}),
          ...(alias?.columns !== undefined ? { columns: alias.columns } : {}),
          ...(time !== undefined ? { time } : {}),
          loc: loc ?? 0,
        };
      }
      case "JoinExpr": {
        this.only(
          b,
          [
            "jointype",
            "isNatural",
            "larg",
            "rarg",
            "usingClause",
            "join_using_alias",
            "quals",
            "alias",
            "location",
          ],
          loc,
          t,
        );
        if (b["isNatural"] === true) return this.no(loc, "NATURAL JOIN");
        if ("alias" in b || "join_using_alias" in b) return this.no(loc, "an alias on a join");
        const jt = b["jointype"];
        const type =
          jt === "JOIN_INNER"
            ? "inner"
            : jt === "JOIN_LEFT"
              ? "left"
              : jt === "JOIN_RIGHT"
                ? "right"
                : jt === "JOIN_FULL"
                  ? "full"
                  : undefined;
        if (type === undefined) return this.no(loc, "this join");
        const left = this.#fromItem(b["larg"]);
        const right = this.#fromItem(b["rarg"]);
        const using = "usingClause" in b ? this.#names(b["usingClause"], loc) : undefined;
        const on = "quals" in b ? this.expr(b["quals"], loc) : undefined;
        if (using !== undefined && on !== undefined)
          return this.no(loc, "a join with ON and USING");
        const cross = type === "inner" && using === undefined && on === undefined;
        return {
          k: "join",
          type: cross ? "cross" : type,
          left,
          right,
          ...(on !== undefined ? { on } : {}),
          ...(using !== undefined ? { using } : {}),
          loc: loc ?? 0,
        };
      }
      case "RangeSubselect": {
        this.only(b, ["lateral", "subquery", "alias", "location"], loc, t);
        if (b["lateral"] === true) return this.no(loc, "LATERAL");
        const alias = this.#alias(b["alias"], loc);
        return {
          k: "sub",
          query: this.#nested(b["subquery"], loc),
          ...(alias?.name !== undefined ? { alias: alias.name } : {}),
          ...(alias?.columns !== undefined ? { columns: alias.columns } : {}),
          loc: loc ?? 0,
        };
      }
      case "RangeFunction":
        return this.no(loc, "a function in FROM");
      default:
        return this.no(loc, t);
    }
  }

  #alias(a: unknown, loc: number | undefined): { name?: string; columns?: string[] } | undefined {
    if (a === undefined) return undefined;
    if (!isObj(a)) return this.no(loc, "an alias");
    this.gate("Alias", loc);
    this.only(a, ["aliasname", "colnames"], loc, "Alias");
    return {
      name: this.id(a, "aliasname", loc),
      ...("colnames" in a ? { columns: this.#names(a["colnames"], loc) } : {}),
    };
  }

  // --- window functions ---

  #windowLimit(loc: number | undefined): void {
    if (this.#windows > LIMITS.windows)
      this.#limit(loc, `more than ${LIMITS.windows} window definitions`);
  }

  #window(name: string, b: J, args: Expr[], at: number, loc: number | undefined): Expr {
    const agg = AGGS.get(name);
    const win = WINDOWS.get(name);
    const asAgg = agg !== undefined && WINDOW_AGGREGATES.has(agg.name);
    const asWin = win !== undefined && this.#admits(win);
    if (!asAgg && !asWin) {
      return reject(
        "rule_sql_rejected",
        "function",
        loc,
        `the window function ${name}`,
        undefined,
        name,
      );
    }
    const star = b["agg_star"] === true;
    if (b["agg_distinct"] === true) return this.no(loc, "DISTINCT in a window function");
    if (star && name !== "count") return this.no(loc, `* in ${name}()`);
    if ("agg_filter" in b && !asAgg) return this.no(loc, `FILTER on ${name}()`);
    const over = b["over"];
    if (!isObj(over)) return this.no(loc, "a malformed parse tree");
    return {
      k: "win",
      name: (asAgg ? agg : (win as { name: string })).name,
      star,
      distinct: false,
      args,
      ...("agg_filter" in b ? { filter: this.expr(b["agg_filter"], loc) } : {}),
      over: this.#over(over, loc),
      loc: at,
    };
  }

  /** `OVER w` or `OVER (…)`. */
  #over(w: J, loc: number | undefined): OverClause {
    this.gate("WindowDef", loc);
    const keys = Object.keys(w).filter((k) => k !== "location");
    // `OVER w`: the name alone (and the default frame the parser fills in).
    if ("name" in w && !("refname" in w)) {
      for (const k of keys) {
        if (k !== "name" && k !== "frameOptions") return this.no(loc, "this window");
      }
      if ((w["frameOptions"] ?? FRAME.default) !== FRAME.default)
        return this.no(loc, "this window");
      return { k: "name", name: this.id(w, "name", loc) };
    }
    this.#windows++;
    this.#windowLimit(loc);
    return { k: "spec", spec: this.#spec(w, locOf(w) ?? loc, false) };
  }

  /** The body of a window: base name, PARTITION BY, ORDER BY and frame. */
  #spec(w: J, loc: number | undefined, named: boolean): WindowSpec {
    this.gate("WindowDef", loc);
    this.only(
      w,
      [
        ...(named ? ["name"] : []),
        "refname",
        "partitionClause",
        "orderClause",
        "frameOptions",
        "startOffset",
        "endOffset",
        "location",
      ],
      loc,
      "WindowDef",
    );
    const frame = this.#frame(w, loc);
    return {
      ...("refname" in w ? { base: this.id(w, "refname", loc) } : {}),
      partitionBy: this.#list(w["partitionClause"] ?? [], loc).map((x) => this.expr(x, loc)),
      orderBy: "orderClause" in w ? this.#sort(w["orderClause"], loc) : [],
      ...(frame !== undefined ? { frame } : {}),
      loc: loc ?? 0,
    };
  }

  #frame(w: J, loc: number | undefined): Frame | undefined {
    const fo = w["frameOptions"];
    if (fo === undefined) return undefined;
    if (typeof fo !== "number" || !Number.isInteger(fo)) return this.no(loc, "this window frame");
    if ((fo & FRAME.nonDefault) === 0) {
      if (fo !== FRAME.default) return this.no(loc, "this window frame");
      return undefined;
    }
    if ((fo & FRAME.exclude) !== 0) return this.no(loc, "EXCLUDE in a window frame");
    if ((fo & ~FRAME.known) !== 0) return this.no(loc, "this window frame");
    const mode = (fo & FRAME.range) !== 0 ? "range" : (fo & FRAME.rows) !== 0 ? "rows" : "groups";
    const bound = (
      unbPre: number,
      unbFol: number,
      cur: number,
      offPre: number,
      offFol: number,
      offset: unknown,
    ): FrameBound => {
      if ((fo & unbPre) !== 0) return { k: "unbounded_preceding" };
      if ((fo & unbFol) !== 0) return { k: "unbounded_following" };
      if ((fo & cur) !== 0) return { k: "current_row" };
      if ((fo & offPre) !== 0) return { k: "preceding", offset: this.#offset(offset, mode, loc) };
      if ((fo & offFol) !== 0) return { k: "following", offset: this.#offset(offset, mode, loc) };
      return this.no(loc, "this window frame");
    };
    const start = bound(
      FRAME.startUnboundedPreceding,
      FRAME.startUnboundedFollowing,
      FRAME.startCurrentRow,
      FRAME.startOffsetPreceding,
      FRAME.startOffsetFollowing,
      w["startOffset"],
    );
    if ((fo & FRAME.between) === 0) return { mode, start };
    const end = bound(
      FRAME.endUnboundedPreceding,
      FRAME.endUnboundedFollowing,
      FRAME.endCurrentRow,
      FRAME.endOffsetPreceding,
      FRAME.endOffsetFollowing,
      w["endOffset"],
    );
    return { mode, start, end };
  }

  /** A frame offset: a non-negative constant, or `INTERVAL 'n days'` / `'n weeks'` (RANGE only). */
  #offset(v: unknown, mode: Frame["mode"], loc: number | undefined): FrameOffset {
    if (isObj(v) && "TypeCast" in v) {
      const [, c] = this.node(v, loc);
      this.only(c, ["arg", "typeName", "location"], loc, "TypeCast");
      const tn = c["typeName"];
      if (isObj(tn)) this.only(tn, ["names", "typmods", "typemod", "location"], loc, "TypeName");
      const names = isObj(tn) && Array.isArray(tn["names"]) ? tn["names"] : [];
      const last = names[names.length - 1];
      const argNode = c["arg"];
      // `'n days'`: a constant of one string, every node of it with the keys it is known to have.
      let text: unknown;
      if (isObj(argNode) && "A_Const" in argNode) {
        const [, k] = this.node(argNode, loc);
        this.only(k, ["sval", "isnull", "location"], loc, "A_Const");
        const sv = k["sval"];
        if (isObj(sv)) text = this.str(sv, "sval", loc);
      }
      for (const n of names) {
        const [nt, nb] = this.node(n, loc);
        if (nt === "String") this.only(nb, ["sval"], loc, "String");
      }
      const ok =
        isObj(tn) &&
        names.length === 2 &&
        isObj(last) &&
        isObj(last["String"]) &&
        last["String"]["sval"] === "interval" &&
        !("typmods" in tn) &&
        typeof text === "string";
      const m = ok ? /^([0-9]{1,6}) (days?|weeks?)$/i.exec(text as string) : null;
      if (mode !== "range" || m === null)
        return this.no(loc, "a frame offset interval other than 'n days' or 'n weeks' with RANGE");
      this.gate("TypeCast", loc);
      this.gate("TypeName", loc);
      const n = Number(m[1]);
      return { k: "interval", days: /^w/i.test(m[2] as string) ? n * 7 : n, loc: loc ?? 0 };
    }
    const e = this.expr(v, loc);
    if ((e.k !== "int" && e.k !== "num") || e.text.startsWith("-"))
      return this.no(loc, "a frame offset other than a non-negative constant");
    if (mode !== "range" && e.k !== "int")
      return this.no(loc, "a frame offset that is not an integer");
    return { k: e.k, text: e.text, loc: e.loc };
  }

  /**
   * One `sql` statement as a query. Throws RsqlError at the first refusal; the checks that need
   * the whole text (parameters, time clauses) are made on `facts`.
   */
  sqlStatement(tree: unknown): Query {
    if (!isObj(tree)) return this.no(undefined, "a malformed parse tree");
    this.only(tree, ["version", "stmts"], undefined, "the parse result");
    const stmts = this.#list(tree["stmts"] ?? [], undefined);
    const [raw] = stmts;
    if (stmts.length !== 1 || !isObj(raw)) {
      return reject(
        "rule_sql_rejected",
        "not_select",
        undefined,
        "a sql query is exactly one SELECT statement",
      );
    }
    this.gate("RawStmt", undefined);
    this.only(raw, ["stmt", "stmt_location", "stmt_len"], undefined, "RawStmt");
    const stmt = raw["stmt"];
    const [t] = isObj(stmt) ? Object.keys(stmt) : [];
    if (t !== "SelectStmt") {
      return reject(
        "rule_sql_rejected",
        "not_select",
        undefined,
        `${t ?? "this"} is not a SELECT`,
        undefined,
        t,
      );
    }
    const [, s] = this.node(stmt, undefined);
    return this.#query(s);
  }

  /** The statement of a derived rule. */
  statement(tree: unknown): RuleStatement {
    if (!isObj(tree)) return this.no(undefined, "a malformed parse tree");
    this.only(tree, ["version", "stmts"], undefined, "the parse result");
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
    this.gate("RawStmt", undefined);
    this.only(raw, ["stmt", "stmt_location", "stmt_len"], undefined, "RawStmt");
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
            return this.no(loc, "FETCH … WITH TIES");
          if (
            s["limitOption"] !== "LIMIT_OPTION_DEFAULT" &&
            s["limitOption"] !== "LIMIT_OPTION_COUNT"
          ) {
            return this.no(loc, "this LIMIT");
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
            return this.no(loc, "WITH RECURSIVE");
          }
          return notYet(loc, "WITH");
        }
        case "windowClause":
          return notYet(loc, "WINDOW");
        case "groupDistinct":
          return this.no(loc, "GROUP BY DISTINCT");
        case "intoClause":
          return this.no(loc, "SELECT INTO");
        case "lockingClause":
          return this.no(loc, "FOR UPDATE / FOR SHARE");
        case "valuesLists":
          return this.no(loc, "VALUES");
        default:
          return this.no(loc, `SELECT with ${k}`);
      }
    }
    const targets = this.#list(s["targetList"] ?? [], loc).map((x): Target => {
      const [t, b] = this.node(x, loc);
      if (t !== "ResTarget") return this.no(loc, t);
      this.only(b, ["name", "val", "location"], locOf(b), t);
      const l = locOf(b);
      return {
        ...("name" in b ? { name: this.str(b, "name", l) } : {}),
        expr: this.expr(b["val"], l),
        loc: l ?? 0,
      };
    });
    if (!("fromClause" in s))
      return this.no(loc, "a SELECT without FROM (a derived rule needs an input table)");
    const from = this.#list(s["fromClause"], loc);
    const [only1] = from;
    if (from.length !== 1) return notYet(loc, "more than one table in FROM");
    const fromTable = this.#from(only1);
    const groupBy = this.#list(s["groupClause"] ?? [], loc).map((g): GroupItem => {
      const [gt] = this.node(g, loc);
      if (gt === "GroupingSet") return this.no(loc, "GROUPING SETS, ROLLUP and CUBE");
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
        this.only(
          b,
          ["catalogname", "schemaname", "relname", "inh", "relpersistence", "alias", "location"],
          loc,
          t,
        );
        if ("catalogname" in b) return this.no(loc, "a table name of three parts");
        if (b["inh"] !== true) return this.no(loc, "ONLY");
        if (b["relpersistence"] !== "p") return this.no(loc, "this table reference");
        let alias: string | undefined;
        if ("alias" in b) {
          const a = b["alias"];
          if (!isObj(a)) return this.no(loc, "an alias");
          this.gate("Alias", loc);
          this.only(a, ["aliasname", "colnames"], loc, "Alias");
          if ("colnames" in a) return notYet(loc, "a column alias list");
          alias = this.str(a, "aliasname", loc);
        }
        return {
          ...("schemaname" in b ? { slot: this.str(b, "schemaname", loc) } : {}),
          table: this.str(b, "relname", loc),
          ...(alias !== undefined ? { alias } : {}),
          loc: loc ?? 0,
        };
      }
      case "JoinExpr":
        return notYet(loc, "JOIN");
      case "RangeSubselect":
        if (b["lateral"] === true) return this.no(loc, "LATERAL");
        return notYet(loc, "a subquery in FROM");
      case "RangeFunction":
        return this.no(loc, "a function in FROM");
      default:
        return this.no(loc, t);
    }
  }
}

const locOf = (b: J): number | undefined =>
  typeof b["location"] === "number" && b["location"] >= 0 ? b["location"] : undefined;

/** The aggregates that can be used as window functions (11 «窗口函数»). */
const WINDOW_AGGREGATES: ReadonlySet<string> = new Set(["count", "sum", "avg", "min", "max"]);

/** PostgreSQL's `frameOptions` bits (nodes/parsenodes.h FRAMEOPTION_*). */
const FRAME = {
  nonDefault: 0x00001,
  range: 0x00002,
  rows: 0x00004,
  groups: 0x00008,
  between: 0x00010,
  startUnboundedPreceding: 0x00020,
  endUnboundedPreceding: 0x00040,
  startUnboundedFollowing: 0x00080,
  endUnboundedFollowing: 0x00100,
  startCurrentRow: 0x00200,
  endCurrentRow: 0x00400,
  startOffsetPreceding: 0x00800,
  startOffsetFollowing: 0x01000,
  endOffsetPreceding: 0x02000,
  endOffsetFollowing: 0x04000,
  exclude: 0x38000,
  known: 0x3ffff,
  /** RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW: the frame of a window without one. */
  default: 0x00002 | 0x00020 | 0x00400,
} as const;

/** The SELECTs of a set operation, counted through nested set operations. */
function branches(q: Query): number {
  return q.body.k === "setop" ? branches(q.body.left) + branches(q.body.right) : 1;
}

/** The structured form of a derived rule's parse tree, or a thrown RsqlError. */
export function convertRule(tree: unknown): RuleStatement {
  return new Walker("D").statement(tree);
}

/** A `sql` query's parse tree as a query (S), with what the checks on the whole text need. */
export function convertQuery(
  tree: unknown,
  opts: ConvertOptions = {},
): { readonly query: Query; readonly facts: QueryFacts } {
  const w = new Walker("S", opts);
  const query = w.sqlStatement(tree);
  return { query, facts: w.facts };
}
