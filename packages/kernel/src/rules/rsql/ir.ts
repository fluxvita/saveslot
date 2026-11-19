// The structured form of a derived rule after the whitelist check (./convert.ts): only what the
// whitelist admits can be expressed here. Names are still as written; ./analyze.ts resolves them.
// Not persisted: the event keeps the ID-bound text (09-event-format §7 `rule.sql`), which is
// parsed again when the rule is evaluated.
//
// The same structure also holds a `sql` query (S): the forms only S admits are the `param`, `sublink`
// and `win` expressions and the `Query` tree below; a derived rule's `RuleStatement` keeps its
// one-table shape.
//
// `loc` is a byte offset into the text the rule was parsed from (for line numbers).

export type Loc = number;

/** A cast target (11 «类型转换»); `numeric` may carry precision and scale. */
export type CastTarget =
  | { readonly t: "numeric"; readonly precision?: number; readonly scale?: number }
  | { readonly t: "bigint" }
  | { readonly t: "date" }
  | { readonly t: "timestamp" };

export type BoolTest =
  | "is_true"
  | "is_not_true"
  | "is_false"
  | "is_not_false"
  | "is_unknown"
  | "is_not_unknown";

export type Expr =
  /** A column: 1–3 name parts as written. */
  | { readonly k: "col"; readonly parts: readonly string[]; readonly loc: Loc }
  /** An integer literal within 64 bits, as canonical text. */
  | { readonly k: "int"; readonly text: string; readonly loc: Loc }
  /** A decimal literal, as written (digits, optional sign and fraction; no exponent). */
  | { readonly k: "num"; readonly text: string; readonly loc: Loc }
  | { readonly k: "str"; readonly value: string; readonly loc: Loc }
  | { readonly k: "bool"; readonly value: boolean; readonly loc: Loc }
  | { readonly k: "null"; readonly loc: Loc }
  | { readonly k: "cast"; readonly arg: Expr; readonly to: CastTarget; readonly loc: Loc }
  /** Unary (`-x`, `+x`) or binary operator, by its symbol in the parse tree. */
  | { readonly k: "op"; readonly op: string; readonly args: readonly Expr[]; readonly loc: Loc }
  | {
      readonly k: "distinct" | "not_distinct" | "nullif";
      readonly l: Expr;
      readonly r: Expr;
      readonly loc: Loc;
    }
  | {
      readonly k: "in";
      readonly not: boolean;
      readonly arg: Expr;
      readonly list: readonly Expr[];
      readonly loc: Loc;
    }
  | {
      readonly k: "like";
      readonly not: boolean;
      readonly arg: Expr;
      readonly pattern: Expr;
      readonly escape?: Expr;
      readonly loc: Loc;
    }
  | {
      readonly k: "between";
      readonly not: boolean;
      readonly arg: Expr;
      readonly lo: Expr;
      readonly hi: Expr;
      readonly loc: Loc;
    }
  | { readonly k: "and" | "or"; readonly args: readonly Expr[]; readonly loc: Loc }
  | { readonly k: "not"; readonly arg: Expr; readonly loc: Loc }
  | { readonly k: "isnull"; readonly not: boolean; readonly arg: Expr; readonly loc: Loc }
  | { readonly k: "booltest"; readonly test: BoolTest; readonly arg: Expr; readonly loc: Loc }
  | {
      readonly k: "case";
      readonly arg?: Expr;
      readonly whens: readonly { readonly when: Expr; readonly result: Expr }[];
      readonly else?: Expr;
      readonly loc: Loc;
    }
  | {
      readonly k: "coalesce" | "greatest" | "least";
      readonly args: readonly Expr[];
      readonly loc: Loc;
    }
  /** A scalar function by its canonical name (`ceil`, not `ceiling`). */
  | { readonly k: "func"; readonly name: string; readonly args: readonly Expr[]; readonly loc: Loc }
  /** `EXTRACT(<field> FROM <date>)`. */
  | { readonly k: "extract"; readonly field: string; readonly arg: Expr; readonly loc: Loc }
  | {
      readonly k: "agg";
      readonly name: string;
      /** `count(*)`. */
      readonly star: boolean;
      readonly distinct: boolean;
      readonly arg?: Expr;
      readonly filter?: Expr;
      readonly loc: Loc;
    }
  /** `$n` (S only). */
  | { readonly k: "param"; readonly n: number; readonly loc: Loc }
  /**
   * A subquery in an expression (S, D): a scalar one, `EXISTS (…)`, or `arg IN (SELECT …)` (`NOT IN`
   * is a `not` around it).
   */
  | {
      readonly k: "sublink";
      readonly kind: "scalar" | "exists" | "in";
      readonly arg?: Expr;
      readonly query: Query;
      readonly loc: Loc;
    }
  /** A window function call: an aggregate or a window-only function with `OVER` (S only). */
  | {
      readonly k: "win";
      readonly name: string;
      readonly star: boolean;
      readonly distinct: boolean;
      readonly args: readonly Expr[];
      readonly filter?: Expr;
      readonly over: OverClause;
      readonly loc: Loc;
    };

export interface Target {
  /** `AS` name as written, if any. */
  readonly name?: string;
  readonly expr: Expr;
  readonly loc: Loc;
}

export interface FromTable {
  /** Slot name when qualified (`slot.table`). */
  readonly slot?: string;
  readonly table: string;
  readonly alias?: string;
  readonly loc: Loc;
}

export type GroupItem = { readonly k: "ordinal"; readonly n: number; readonly loc: Loc } | Expr;

/** A derived rule of this version's shape: one table, an aggregate at the outermost level. */
export interface RuleStatement {
  readonly targets: readonly Target[];
  readonly from: FromTable;
  readonly where?: Expr;
  readonly groupBy: readonly GroupItem[];
  readonly having?: Expr;
}

// --- `sql` queries (S) --------------------------------------------------------------------------

export interface SortItem {
  readonly expr: Expr;
  readonly dir: "default" | "asc" | "desc";
  readonly nulls: "default" | "first" | "last";
}

/** A frame offset: a non-negative constant, or an interval of whole days (`INTERVAL '6 days'`). */
export type FrameOffset =
  | { readonly k: "int" | "num"; readonly text: string; readonly loc: Loc }
  | { readonly k: "interval"; readonly days: number; readonly loc: Loc };

export type FrameBound =
  | { readonly k: "unbounded_preceding" | "unbounded_following" | "current_row" }
  | { readonly k: "preceding" | "following"; readonly offset: FrameOffset };

export interface Frame {
  readonly mode: "rows" | "range" | "groups";
  readonly start: FrameBound;
  /** Absent: the frame is written without BETWEEN (it ends at the current row). */
  readonly end?: FrameBound;
}

/** `(base PARTITION BY … ORDER BY … frame)`: the body of an OVER clause or a named window. */
export interface WindowSpec {
  /** The named window this one extends. */
  readonly base?: string;
  readonly partitionBy: readonly Expr[];
  readonly orderBy: readonly SortItem[];
  readonly frame?: Frame;
  readonly loc: Loc;
}

export type OverClause =
  | { readonly k: "name"; readonly name: string }
  | { readonly k: "spec"; readonly spec: WindowSpec };

export interface NamedWindow {
  readonly name: string;
  readonly spec: WindowSpec;
}

/** `*` or `t.*` among the output columns. */
export interface StarTarget {
  readonly star: true;
  /** `t` or `slot.t`. */
  readonly qualifier?: readonly string[];
  readonly loc: Loc;
}

export type SelectItem = Target | StarTarget;

/** The operand of `FOR VALID_TIME`: a value fixed for the call (11 «时间»), plus whole days. */
export interface TimeOperand {
  readonly base:
    | { readonly k: "param"; readonly n: number }
    | { readonly k: "str"; readonly value: string }
    | { readonly k: "today" | "now" };
  readonly days?: number;
  readonly loc: Loc;
}

export type TimeClause =
  | { readonly k: "as_of"; readonly at: TimeOperand }
  | { readonly k: "during"; readonly from: TimeOperand; readonly to: TimeOperand };

export interface TableRef {
  readonly k: "table";
  readonly slot?: string;
  readonly table: string;
  readonly alias?: string;
  readonly columns?: readonly string[];
  readonly time?: TimeClause;
  readonly loc: Loc;
}

export interface SubRef {
  readonly k: "sub";
  readonly query: Query;
  readonly alias?: string;
  readonly columns?: readonly string[];
  readonly loc: Loc;
}

export interface JoinRef {
  readonly k: "join";
  readonly type: "inner" | "left" | "right" | "full" | "cross";
  readonly left: FromItem;
  readonly right: FromItem;
  readonly on?: Expr;
  readonly using?: readonly string[];
  readonly loc: Loc;
}

export type FromItem = TableRef | SubRef | JoinRef;

export interface SelectBody {
  readonly k: "select";
  /** `true`: DISTINCT; `{on}`: DISTINCT ON. */
  readonly distinct: boolean | { readonly on: readonly Expr[] };
  readonly targets: readonly SelectItem[];
  readonly from: readonly FromItem[];
  readonly where?: Expr;
  readonly groupBy: readonly GroupItem[];
  readonly having?: Expr;
  readonly windows: readonly NamedWindow[];
  readonly loc: Loc;
}

export interface SetOp {
  readonly k: "setop";
  readonly op: "union" | "intersect" | "except";
  readonly all: boolean;
  readonly left: Query;
  readonly right: Query;
  readonly loc: Loc;
}

export interface Cte {
  readonly name: string;
  readonly columns?: readonly string[];
  readonly query: Query;
  readonly loc: Loc;
}

/** A query: its WITH list, its body, and the ORDER BY, LIMIT and OFFSET that apply to the body. */
export interface Query {
  readonly with: readonly Cte[];
  readonly body: SelectBody | SetOp;
  readonly orderBy: readonly SortItem[];
  readonly limit?: Expr;
  readonly offset?: Expr;
  readonly loc: Loc;
}
