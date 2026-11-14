// The whitelist of restricted SQL, version `rsql@1` (docs/zh-CN/spec/03-data-model/11-restricted-sql.md
// «白名单»), as data: every node, function, aggregate, window function, operator and type cast, with
// the contexts it is allowed in (S = `sql`, D = derived rules, M = transformation expressions).
//
// The compiler reads this data: a node, function, aggregate, operator or cast is admitted in a
// context only when listed here for it (./convert.ts, ./analyze.ts); anything not listed is refused.
// Whitelisted forms this kernel does not compile yet stop as not implemented. Tests check these
// lists against the spec's tables item by item, and against the compiler entry by entry. Lookups go
// through Maps: names come from callers.

export type Context = "S" | "D" | "M";

export const RSQL_VERSION = "rsql@1";

interface Entry {
  readonly name: string;
  /** Other names of the same item (`ceiling` for `ceil`). */
  readonly aliases?: readonly string[];
  readonly contexts: readonly Context[];
}

const S = ["S"] as const;
const SD = ["S", "D"] as const;
const SM = ["S", "M"] as const;
const SDM = ["S", "D", "M"] as const;

/** «语法树节点»: 32 kinds. */
export const NODES: readonly Entry[] = [
  { name: "RawStmt", contexts: SDM },
  { name: "SelectStmt", contexts: SDM },
  { name: "ResTarget", contexts: SDM },
  { name: "ColumnRef", contexts: SDM },
  { name: "A_Star", contexts: S },
  { name: "A_Const", contexts: SDM },
  { name: "ParamRef", contexts: S },
  { name: "TypeCast", contexts: SDM },
  { name: "TypeName", contexts: SDM },
  { name: "A_Expr", contexts: SDM },
  { name: "BoolExpr", contexts: SDM },
  { name: "NullTest", contexts: SDM },
  { name: "BooleanTest", contexts: SDM },
  { name: "CaseExpr", contexts: SDM },
  { name: "CaseWhen", contexts: SDM },
  { name: "CoalesceExpr", contexts: SDM },
  { name: "MinMaxExpr", contexts: SDM },
  { name: "FuncCall", contexts: SDM },
  { name: "SubLink", contexts: SD },
  { name: "RangeVar", contexts: SD },
  { name: "Alias", contexts: SD },
  { name: "JoinExpr", contexts: SD },
  { name: "RangeSubselect", contexts: SD },
  { name: "WithClause", contexts: SD },
  { name: "CommonTableExpr", contexts: SD },
  // D only inside a window's ORDER BY.
  { name: "SortBy", contexts: SD },
  { name: "WindowDef", contexts: SD },
  { name: "String", contexts: SDM },
  { name: "Integer", contexts: SDM },
  { name: "Float", contexts: SDM },
  { name: "Boolean", contexts: SDM },
  { name: "List", contexts: SDM },
];

/** «函数»: 24 functions (synonyms and SQL-syntax spellings not counted). */
export const FUNCTIONS: readonly Entry[] = [
  { name: "abs", contexts: SDM },
  { name: "round", contexts: SDM },
  { name: "trunc", contexts: SDM },
  { name: "floor", contexts: SDM },
  { name: "ceil", aliases: ["ceiling"], contexts: SDM },
  { name: "sign", contexts: SDM },
  { name: "mod", contexts: SDM },
  { name: "date_trunc", contexts: SDM },
  { name: "extract", contexts: SDM },
  { name: "make_date", contexts: SM },
  { name: "length", aliases: ["char_length"], contexts: SDM },
  { name: "substr", aliases: ["substring"], contexts: SDM },
  { name: "left", contexts: SDM },
  { name: "right", contexts: SDM },
  { name: "strpos", aliases: ["position"], contexts: SDM },
  { name: "starts_with", contexts: SDM },
  { name: "btrim", contexts: SDM },
  { name: "ltrim", contexts: SDM },
  { name: "rtrim", contexts: SDM },
  { name: "replace", contexts: SDM },
  { name: "split_part", contexts: SDM },
  { name: "saveslot_now", contexts: SD },
  { name: "saveslot_today", contexts: SD },
  { name: "saveslot_date", contexts: SD },
];

/** «聚合函数»: `count` (with `*`, a value or DISTINCT), `sum`, `avg`, `min`, `max`, `bool_and`, `bool_or`. */
export const AGGREGATES: readonly Entry[] = [
  { name: "count", contexts: SD },
  { name: "sum", contexts: SD },
  { name: "avg", contexts: SD },
  { name: "min", contexts: SD },
  { name: "max", contexts: SD },
  { name: "bool_and", contexts: SD },
  { name: "bool_or", contexts: SD },
];

/** «窗口函数»: the five aggregates with OVER, and seven window functions. */
export const WINDOW_FUNCTIONS: readonly Entry[] = [
  { name: "rank", contexts: SD },
  { name: "dense_rank", contexts: SD },
  { name: "row_number", contexts: S },
  { name: "lag", contexts: S },
  { name: "lead", contexts: S },
  { name: "first_value", contexts: S },
  { name: "last_value", contexts: S },
];

/** «运算符», by the symbol in the parse tree (`!=` arrives as `<>`, LIKE as `~~`). */
export const OPERATORS: readonly Entry[] = [
  { name: "=", contexts: SDM },
  { name: "<>", contexts: SDM },
  { name: "<", contexts: SDM },
  { name: "<=", contexts: SDM },
  { name: ">", contexts: SDM },
  { name: ">=", contexts: SDM },
  { name: "+", contexts: SDM },
  { name: "-", contexts: SDM },
  { name: "*", contexts: SDM },
  { name: "/", contexts: SDM },
  { name: "%", contexts: SDM },
  { name: "||", contexts: SDM },
  { name: "~~", contexts: SDM },
  { name: "!~~", contexts: SDM },
];

/** Value types of restricted SQL («类型»); `timestamp` only from `date::timestamp`. */
export type SqlType =
  | "bigint"
  | "numeric"
  | "text"
  | "boolean"
  | "date"
  | "timestamptz"
  | "timestamp";

/** «类型转换»: source → target, per context. `unknown` is a string literal. */
export const CASTS: readonly {
  readonly from: SqlType | "unknown";
  readonly to: SqlType;
  readonly contexts: readonly Context[];
}[] = [
  { from: "bigint", to: "numeric", contexts: SDM },
  { from: "numeric", to: "bigint", contexts: SDM },
  { from: "numeric", to: "numeric", contexts: SDM },
  { from: "date", to: "timestamp", contexts: SDM },
  { from: "timestamp", to: "date", contexts: SDM },
  // `DATE '…'`: the only typed literal outside window frames.
  { from: "unknown", to: "date", contexts: SDM },
  { from: "text", to: "numeric", contexts: ["M"] },
  { from: "text", to: "bigint", contexts: ["M"] },
  { from: "text", to: "boolean", contexts: ["M"] },
];

/**
 * Names refused because their result is not determined by their input (11 «确定性» 1): reported as
 * `nondeterministic_function`, not as an unknown function.
 */
export const NONDETERMINISTIC_FUNCTIONS: ReadonlySet<string> = new Set([
  "now",
  "random",
  "clock_timestamp",
  "statement_timestamp",
  "transaction_timestamp",
  "timeofday",
  "current_setting",
  "set_config",
  "to_char",
  "concat",
  "concat_ws",
  "setseed",
  "gen_random_uuid",
]);

/** Window functions whose result depends on the order of tied rows (11 «窗口函数»). */
export const ORDER_DEPENDENT_WINDOW: ReadonlySet<string> = new Set([
  "row_number",
  "lag",
  "lead",
  "first_value",
  "last_value",
]);

/** Name → entry, over names and aliases, for one list. */
export function index(list: readonly Entry[]): ReadonlyMap<string, Entry> {
  const m = new Map<string, Entry>();
  for (const e of list) for (const n of [e.name, ...(e.aliases ?? [])]) m.set(n, e);
  return m;
}
