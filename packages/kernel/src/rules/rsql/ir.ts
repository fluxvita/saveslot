// The structured form of a derived rule after the whitelist check (./convert.ts): only what the
// whitelist admits can be expressed here. Names are still as written; ./analyze.ts resolves them.
// Not persisted: the event keeps the ID-bound text (09-event-format §7 `rule.sql`), which is
// parsed again when the rule is evaluated.
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
