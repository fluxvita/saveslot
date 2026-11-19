// Steps 5 and 6 of 11-restricted-sql.md «处理步骤» for derived rules, and the analysis of
// 06-derived.md: names resolved against the slot's tables (by name, or by ID for the bound text),
// types and units inferred and checked, the grouping checked, and from that the rule's
// dependencies, recompute scope, time dependency and the types, units and precision of its output.
//
// Rules of this version read one base table (./convert.ts stops on the rest). Lookups by a name
// a caller wrote go through Maps.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledDerivedField,
  CompiledUnit,
  FieldId,
  Rounding,
  TableId,
  TimeDependency,
} from "@fluxvita/saveslot-contract-core";
import {
  notYet,
  type Place,
  RsqlError,
  refuseNode,
  refuseNondeterministic,
  reject,
} from "./errors.ts";
import type { Expr, RuleStatement } from "./ir.ts";
import { CASTS, type SqlType } from "./whitelist.ts";

/** ASCII case folding: names are unique without ASCII case (11 «名字» 大小写与引号). */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Scales are 0–12 (10 «精度与舍入»); inferred scales are capped there. */
const MAX_SCALE = 12;

/** The type of an expression, with what inference needs beyond the SQL type. */
export interface Ty {
  /** `unknown`: a string literal not yet given a type; `null`: the NULL literal. */
  readonly t: SqlType | "unknown" | "null";
  /** Unit code of a numeric value from a `quantity` field. */
  readonly unit?: CompiledUnit;
  /** Two quantities multiplied or divided: no unit can be inferred. */
  readonly unitless?: true;
  /** Scale of a numeric value when known (bigint: 0). */
  readonly scale?: number;
  /** Rounding inherited from the fields the value comes from, when they agree. */
  readonly rounding?: Rounding;
  /** No column reference inside: a literal or an expression of literals. */
  readonly konst: boolean;
  /** Contains an aggregate. */
  readonly agg: boolean;
  /** The field type passed through unchanged (an `enum` or `ref` column, or min / max of one). */
  readonly through?: "enum" | "ref";
  /** The text of a string literal (for date and instant literals). */
  readonly lit?: string;
  /** `unknown` with this set: the parameter `$n`, whose type the place it is used gives (S). */
  readonly param?: number;
}

/** A resolved column. */
export type Column =
  | { readonly kind: "field"; readonly field: CompiledBaseField }
  | { readonly kind: "system"; readonly name: string; readonly t: SqlType };

/** A field of a derived table: its type, unit and precision are inferred, not declared. */
type AnyField = CompiledBaseField | CompiledDerivedField;

/** `sql` queries (S) also read derived tables' fields and the output columns of subqueries. */
export type AnyColumn =
  | Column
  | { readonly kind: "dfield"; readonly field: CompiledDerivedField }
  /** An output column of a subquery or CTE, with the type its query gave it. */
  | { readonly kind: "out"; readonly ty: Ty };

/** What a parameter `$n` was found to be, from the places it is used (S). */
export interface ParamType {
  readonly t: SqlType;
  readonly unit?: CompiledUnit;
  /** Where the type was decided. */
  readonly loc: number;
}

export interface DeclaredField {
  readonly name: string;
  /** Only `decimal` may be declared (a product or quotient of two quantities). */
  readonly type?: "decimal";
  /** Resolved by the caller from `units@1`. */
  readonly unit?: CompiledUnit;
  readonly scale?: number;
  readonly rounding?: Rounding;
}

export type DerivedFieldResult =
  | {
      readonly name: string;
      readonly type: "text" | "boolean" | "date" | "integer" | "enum" | "ref";
    }
  | {
      readonly name: string;
      readonly type: "decimal";
      readonly precision: { readonly scale: number; readonly rounding: Rounding };
    }
  | {
      readonly name: string;
      readonly type: "quantity";
      readonly unit: CompiledUnit;
      readonly precision: { readonly scale: number; readonly rounding: Rounding };
    };

export interface Analysis {
  readonly table: CompiledBaseTable;
  readonly timeDependency: TimeDependency;
  readonly dependsOn: readonly { readonly table: TableId; readonly field: FieldId }[];
  /** Output column positions of the group key; empty for a whole aggregate. */
  readonly groupKey: readonly number[];
  readonly keyFromFreeText: boolean;
  /** The declared field (by position in the declared list) of each output column. */
  readonly outputs: readonly number[];
  /** By declared field position. */
  readonly fields: readonly DerivedFieldResult[];
  /** The column of each column reference, for printing. */
  readonly columnOf: (e: Expr & { k: "col" }) => Column;
  /** For printing; see PrintHints in ./print.ts. */
  readonly hints: PrintHints;
  /** A structural key of an expression: columns resolved, places left out. */
  readonly key: (e: Expr) => string;
}

/**
 * Where the printed text must differ from the tree so that PostgreSQL gives each value the type
 * the analysis gave it (64-bit integers; 11 «类型»).
 */
export interface PrintHints {
  /** Printed inside `CAST(… AS bigint)`: PostgreSQL types it int4, or numeric for sum(bigint). */
  readonly widen: (e: Expr) => boolean;
  /** Integer constants printed bare: the position takes only a 32-bit integer. */
  readonly bare: (e: Expr) => boolean;
  /** `CAST(… AS bigint)` of a bigint in the bound text: the printer's own, printed as its argument. */
  readonly transparent: (e: Expr) => boolean;
}

/** 32-bit bounds: positions where PostgreSQL takes only an int4. */
const INT4_MIN = -(2 ** 31);
const INT4_MAX = 2 ** 31 - 1;

export interface AnalyzeInput {
  readonly slot: string;
  readonly tables: readonly CompiledBaseTable[];
  /** Names of the slot's derived tables: reading one is not compiled yet. */
  readonly derivedTables: readonly string[];
  readonly fields: readonly DeclaredField[];
  readonly declaredTimeDependency: TimeDependency;
  /** `names`: the rule as written; `ids`: its ID-bound text (tables `t<n>`, fields `f<n>`). */
  readonly naming: "names" | "ids";
}

const numeric = (t: Ty["t"]) => t === "bigint" || t === "numeric";
const maxOf = (xs: readonly (number | undefined)[]) =>
  xs.some((x) => x === undefined)
    ? undefined
    : Math.min(MAX_SCALE, Math.max(0, ...(xs as number[])));

/** The rounding shared by all inputs that carry one; undefined when none or when they differ. */
function sharedRounding(tys: readonly Ty[]): Rounding | undefined {
  const rs = new Set(tys.map((t) => t.rounding).filter((r) => r !== undefined));
  return rs.size === 1 ? [...rs][0] : undefined;
}

const DATE_LIT = /^\d{4}-\d{2}-\d{2}$/;
/** Instant literal: must carry an offset (11 «类型» 字面量). */
const INSTANT_LIT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(s: string): boolean {
  if (!DATE_LIT.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

/**
 * A LIKE pattern is a string constant (or NULL) in this version, checked here: PostgreSQL fails on
 * a pattern ending in its escape character, so a pattern read from data could fail on the data
 * (11 «确定性» 6). The escape is `\` unless ESCAPE says otherwise; ESCAPE '' has none.
 */
function likePattern(e: Expr & { k: "like" }): void {
  const p = e.pattern;
  if (p.k === "null") return;
  if (p.k !== "str") {
    reject(
      "rule_sql_rejected",
      "function",
      e.loc,
      "a LIKE pattern other than a string constant (it could fail on the data)",
    );
    return;
  }
  const esc = e.escape === undefined ? "\\" : e.escape.k === "str" ? e.escape.value : "";
  if (esc === "") return;
  const cs = [...p.value];
  for (let i = 0; i < cs.length; i++) {
    if (cs[i] !== esc) continue;
    if (i === cs.length - 1)
      reject(
        "rule_sql_rejected",
        "function",
        e.loc,
        "a LIKE pattern ending in its escape character",
      );
    i++;
  }
}

/** A NULL that nothing gives a type: PostgreSQL cannot resolve the operator or function. */
const untypedNull = (loc: number): never =>
  reject(
    "rule_sql_rejected",
    "type",
    loc,
    "an untyped NULL (it needs a typed operand or branch beside it)",
  );

const DATE_TRUNC_FIELDS = new Set(["day", "week", "month", "quarter", "year"]);
const EXTRACT_FIELDS = new Set([
  "year",
  "quarter",
  "month",
  "day",
  "dow",
  "isodow",
  "doy",
  "week",
  "isoyear",
]);

const FIELD_SQL: Readonly<Record<CompiledBaseField["type"], SqlType>> = {
  text: "text",
  enum: "text",
  ref: "text",
  integer: "bigint",
  decimal: "numeric",
  quantity: "numeric",
  boolean: "boolean",
  date: "date",
  zoned_datetime: "timestamptz",
};

/**
 * The typing of expressions (11 «处理步骤» 6): shared by derived rules (`Analyzer`, one table) and
 * `sql` queries (./sql-analyze.ts, scopes of tables and subqueries). A subclass says which column
 * a reference names; this class infers and checks types and units.
 */
export abstract class ExprTyper {
  protected readonly naming: "names" | "ids";
  /** Where the problems are reported: the wording follows. */
  protected readonly place: Place;
  readonly #columns = new Map<Expr, AnyColumn>();
  protected readonly widenSet = new Set<Expr>();
  protected readonly bareSet = new Set<Expr>();
  protected readonly transparentSet = new Set<Expr>();
  protected nowUsed = false;
  /** What each parameter was found to be (S). */
  readonly paramTypes = new Map<number, ParamType>();

  constructor(naming: "names" | "ids", place: Place) {
    this.naming = naming;
    this.place = place;
  }

  /** The column a reference names, or undefined when it names none (no side effects). */
  protected abstract lookup(e: Expr & { k: "col" }): AnyColumn | undefined;

  /** Called for each column reference as it is typed. */
  protected onColumn(_c: AnyColumn): void {}

  /** The column a reference names, or undefined when it names no column. */
  column(e: Expr & { k: "col" }): AnyColumn | undefined {
    const known = this.#columns.get(e);
    if (known !== undefined) return known;
    const c = this.lookup(e);
    if (c !== undefined) this.#columns.set(e, c);
    return c;
  }

  protected col(e: Expr & { k: "col" }): AnyColumn {
    const c = this.column(e);
    if (c === undefined) {
      return reject(
        "rule_sql_rejected",
        "unknown_name",
        e.loc,
        `no column ${e.parts.join(".")}`,
        undefined,
        e.parts.join("."),
      );
    }
    this.onColumn(c);
    return c;
  }

  /** A subquery in an expression: typed by the subclass that has scopes. */
  protected tySub(e: Expr & { k: "sublink" }, _allowAgg: boolean): Ty {
    return refuseNode(e.loc, "a subquery", this.place);
  }

  /** A window function call: typed by the subclass that has windows. */
  protected tyWin(e: Expr & { k: "win" }, _allowAgg: boolean): Ty {
    return refuseNode(e.loc, "a window function", this.place);
  }

  /** The type a parameter `$n` is given by where it is used. */
  protected bind(x: Ty, t: SqlType, unit?: CompiledUnit): void {
    if (x.param === undefined) return;
    const known = this.paramTypes.get(x.param);
    if (known === undefined) {
      this.paramTypes.set(x.param, {
        t,
        ...(unit !== undefined ? { unit } : {}),
        loc: this.paramLoc.get(x.param) ?? 0,
      });
      return;
    }
    const numbers = (a: SqlType, b: SqlType) => numeric(a) && numeric(b);
    if (known.t !== t && !numbers(known.t, t)) {
      reject(
        "rule_sql_rejected",
        "type",
        this.paramLoc.get(x.param),
        `$${x.param} is used as ${known.t} and as ${t}`,
      );
    }
    if (known.unit !== undefined && unit !== undefined && known.unit.code !== unit.code) {
      reject(
        "unit_inference_failed",
        "type",
        this.paramLoc.get(x.param),
        `$${x.param} is used in ${known.unit.code} and in ${unit.code}`,
      );
    }
    if (known.t !== t || (known.unit === undefined && unit !== undefined)) {
      this.paramTypes.set(x.param, {
        t:
          known.t === "bigint" && t === "numeric"
            ? "numeric"
            : known.t === "numeric"
              ? "numeric"
              : t,
        ...((known.unit ?? unit) !== undefined
          ? { unit: (known.unit ?? unit) as CompiledUnit }
          : {}),
        loc: known.loc,
      });
    }
  }

  /** Where `saveslot_today()` is used. */
  protected readonly todayAt: number[] = [];

  /** Where each parameter first appears (set by the subclass that has them). */
  protected readonly paramLoc = new Map<number, number>();

  /** The column's type, as an expression of it. */
  protected tyOfColumn(c: AnyColumn): Ty {
    if (c.kind === "system") return { t: c.t, konst: false, agg: false };
    if (c.kind === "out") return { ...c.ty, konst: false, agg: false };
    const f: AnyField = c.field;
    const base: Ty = { t: FIELD_SQL[f.type], konst: false, agg: false };
    if (f.type === "integer") return { ...base, scale: 0 };
    if (f.type === "decimal")
      return { ...base, scale: f.precision.scale, rounding: f.precision.rounding };
    if (f.type === "quantity") {
      return {
        ...base,
        unit: f.unit,
        scale: f.precision.scale,
        rounding: f.precision.rounding,
      };
    }
    if (f.type === "enum" || f.type === "ref") return { ...base, through: f.type };
    return base;
  }

  // --- types ---------------------------------------------------------------------------------

  ty(e: Expr, allowAgg: boolean): Ty {
    const ty = (x: Expr, a = allowAgg) => this.ty(x, a);
    switch (e.k) {
      case "col":
        return this.tyOfColumn(this.col(e));
      case "int":
        return { t: "bigint", scale: 0, konst: true, agg: false };
      case "num": {
        const frac = e.text.split(".")[1] ?? "";
        return { t: "numeric", scale: Math.min(MAX_SCALE, frac.length), konst: true, agg: false };
      }
      case "str":
        return { t: "unknown", lit: e.value, konst: true, agg: false };
      case "bool":
        return { t: "boolean", konst: true, agg: false };
      case "null":
        return { t: "null", konst: true, agg: false };
      case "cast":
        return this.castTy(e, ty(e.arg));
      case "op":
        return this.op(
          e,
          e.args.map((a) => ty(a)),
        );
      case "distinct":
      case "not_distinct": {
        // Each side is typed once: typing it again for the result makes nested tests double at every level.
        const sides = [ty(e.l), ty(e.r)];
        this.comparable(sides, e.loc);
        return this.boolOf(sides);
      }
      case "nullif": {
        // The type both sides resolve to: NULLIF of two string literals is text, not a literal.
        const u = this.unify([ty(e.l), ty(e.r)], e.loc, true);
        return u.t === "unknown" ? { ...u, t: "text" } : u;
      }
      case "in": {
        const all = [ty(e.arg), ...e.list.map((x) => ty(x))];
        this.comparable(all, e.loc);
        return this.boolOf(all);
      }
      case "like": {
        const all = [ty(e.arg), ty(e.pattern), ...(e.escape !== undefined ? [ty(e.escape)] : [])];
        for (const x of all) this.needText(x, e.loc, "LIKE");
        const [arg, pattern] = all as [Ty, Ty];
        if (
          (arg.t === "null" && pattern.t !== "text") ||
          (pattern.t === "null" && arg.t !== "text")
        )
          untypedNull(e.loc);
        likePattern(e);
        return this.boolOf(all);
      }
      case "between": {
        const all = [ty(e.arg), ty(e.lo), ty(e.hi)];
        this.comparable(all, e.loc);
        return this.boolOf(all);
      }
      case "and":
      case "or": {
        const all = e.args.map((x) => ty(x));
        for (const x of all) this.needBoolean(x, e.loc);
        return this.boolOf(all);
      }
      case "not": {
        const x = ty(e.arg);
        this.needBoolean(x, e.loc);
        return this.boolOf([x]);
      }
      case "isnull":
        return this.boolOf([ty(e.arg)]);
      case "booltest": {
        const x = ty(e.arg);
        this.needBoolean(x, e.loc);
        return this.boolOf([x]);
      }
      case "case": {
        const whens = e.whens.map((w) => ty(w.when));
        const arg = e.arg !== undefined ? ty(e.arg) : undefined;
        if (arg !== undefined) {
          for (const w of whens) this.comparable([arg, w], e.loc);
        } else for (const w of whens) this.needBoolean(w, e.loc);
        const results = [
          ...e.whens.map((w) => ty(w.result)),
          ...(e.else !== undefined ? [ty(e.else)] : []),
        ];
        const u = this.unify(results, e.loc);
        const conds = arg !== undefined ? [arg, ...whens] : whens;
        return {
          ...u,
          konst: u.konst && conds.every((c) => c.konst),
          agg: u.agg || conds.some((c) => c.agg),
        };
      }
      case "coalesce":
      case "greatest":
      case "least": {
        const u = this.unify(
          e.args.map((x) => ty(x)),
          e.loc,
        );
        if (e.k !== "coalesce" && u.t === "boolean") {
          reject("rule_sql_rejected", "type", e.loc, "GREATEST / LEAST of booleans");
        }
        return u;
      }
      case "extract": {
        const a = ty(e.arg);
        if (!EXTRACT_FIELDS.has(e.field)) {
          reject("rule_sql_rejected", "function", e.loc, `EXTRACT(${e.field} …)`);
        }
        if (a.t === "timestamptz") {
          refuseNondeterministic(
            e.loc,
            "function",
            "EXTRACT from a zoned date-time",
            "EXTRACT(… FROM saveslot_date(<field>))",
          );
        }
        if (a.t !== "date")
          reject("rule_sql_rejected", "function", e.loc, "EXTRACT from anything but a date");
        return { t: "numeric", scale: 0, konst: a.konst, agg: a.agg };
      }
      case "func":
        return this.funcTy(
          e,
          e.args.map((x) => ty(x)),
        );
      case "agg":
        return this.aggTy(e, allowAgg);
      case "param":
        return { t: "unknown", param: e.n, konst: true, agg: false };
      case "sublink":
        return this.tySub(e, allowAgg);
      case "win":
        return this.tyWin(e, allowAgg);
    }
  }

  protected boolOf(parts: readonly Ty[]): Ty {
    return { t: "boolean", konst: parts.every((p) => p.konst), agg: parts.some((p) => p.agg) };
  }

  protected needBoolean(x: Ty, loc: number): void {
    if (x.param !== undefined) {
      this.bind(x, "boolean");
      return;
    }
    if (x.t !== "boolean" && x.t !== "null")
      reject("rule_sql_rejected", "type", loc, "a boolean is expected");
  }

  protected needText(x: Ty, loc: number, what: string): void {
    if (x.t !== "text" && x.t !== "unknown" && x.t !== "null") {
      reject("rule_sql_rejected", "function", loc, `${what} on a value that is not text`);
    }
    this.bind(x, "text");
  }

  /**
   * Units of operands that must agree (11 «单位»): one code, literals taking the other side's; or
   * none inferable (a product or quotient of quantities), which carries on upward.
   */
  protected units(xs: readonly Ty[], loc: number): Pick<Ty, "unit" | "unitless"> {
    let unit: CompiledUnit | undefined;
    for (const x of xs) {
      if (x.unit === undefined) continue;
      if (unit !== undefined && unit.code !== x.unit.code) {
        reject(
          "unit_inference_failed",
          "type",
          loc,
          `${unit.code} and ${x.unit.code} together (no unit conversion in SQL)`,
        );
      }
      unit = x.unit;
    }
    const unitless = xs.some((x) => x.unitless);
    if (unit !== undefined) {
      for (const x of xs) {
        if (x.unit === undefined && numeric(x.t) && !x.konst) {
          reject(
            "unit_inference_failed",
            "type",
            loc,
            x.unitless
              ? `a value in ${unit.code} with a product of quantities`
              : `a value in ${unit.code} with a number without a unit`,
          );
        }
      }
      return { unit };
    }
    return unitless ? { unitless: true } : {};
  }

  /** Operands that are compared with each other (11 «运算符» 比较). */
  protected comparable(xs: readonly Ty[], loc: number): void {
    this.unify(xs, loc, true);
  }

  /** One type for values that meet (comparison operands, CASE results, COALESCE …). */
  protected unify(xs: readonly Ty[], loc: number, comparing = false): Ty {
    const typed = xs.filter((x) => x.t !== "null" && x.t !== "unknown");
    const classes = new Set(typed.map((x) => (numeric(x.t) ? "number" : x.t)));
    if (classes.has("date") && classes.has("timestamptz")) {
      refuseNondeterministic(
        loc,
        "function",
        "a date with a zoned date-time (it follows the session time zone)",
        "compare saveslot_date(<field>) with the date",
      );
    }
    if (classes.size > 1)
      reject(
        "rule_sql_rejected",
        "type",
        loc,
        `values of different types (${[...classes].join(", ")})`,
      );
    const [cls] = [...classes];
    if (comparing && cls === "timestamp")
      reject("rule_sql_rejected", "type", loc, "a comparison of timestamps (cast back to date)");
    // String literals take the other side's type, checked as that type (11 «类型» 字面量).
    for (const x of xs) {
      if (x.t !== "unknown" || x.param !== undefined) continue;
      const lit = x.lit ?? "";
      if (cls === undefined || cls === "text") continue;
      if (cls === "date" && validDate(lit)) continue;
      if (cls === "timestamptz" && INSTANT_LIT.test(lit) && validDate(lit.slice(0, 10))) continue;
      reject(
        "rule_sql_rejected",
        "type",
        loc,
        cls === "date" || cls === "timestamptz"
          ? `a ${cls === "date" ? "date (YYYY-MM-DD)" : "instant with an offset"} literal is expected`
          : `a string where a ${cls} is expected`,
      );
    }
    const units = cls === "number" ? this.units(xs, loc) : {};
    const konst = xs.every((x) => x.konst);
    const agg = xs.some((x) => x.agg);
    if (cls === undefined) {
      // Only NULLs and string literals: text (PostgreSQL resolves string literals so); only NULLs
      // have no type at all. Parameters beside only these have nothing to be inferred from.
      const literal = xs.some((x) => x.t === "unknown" && x.param === undefined);
      if (!literal) {
        if (xs.some((x) => x.param !== undefined))
          reject(
            "rule_sql_rejected",
            "type",
            loc,
            "the type of a parameter cannot be inferred here",
          );
        return untypedNull(loc);
      }
      for (const x of xs) this.bind(x, "text");
      return { t: "text", konst, agg };
    }
    if (cls !== "number") {
      for (const x of xs) this.bind(x, cls as SqlType);
      const through = new Set(typed.map((x) => x.through));
      const [only] = [...through];
      return {
        t: cls as SqlType,
        konst,
        agg,
        ...(through.size === 1 && only !== undefined && typed.length === xs.length
          ? { through: only }
          : {}),
      };
    }
    const t: SqlType = typed.every((x) => x.t === "bigint") ? "bigint" : "numeric";
    for (const x of xs) this.bind(x, t, (units as Pick<Ty, "unit">).unit);
    const scale = maxOf(typed.map((x) => x.scale));
    const rounding = sharedRounding(typed);
    return {
      t,
      konst,
      agg,
      ...units,
      ...(scale !== undefined ? { scale } : {}),
      ...(rounding !== undefined ? { rounding } : {}),
    };
  }

  /**
   * An integer constant in a position where PostgreSQL takes only a 32-bit integer (the length of
   * `substr`, the digits of `round`, the days added to a date): printed bare. This version takes a
   * constant only there (11 «函数», «运算符»).
   */
  protected int4(
    x: Expr | undefined,
    loc: number,
    what: string,
    ok?: (n: number) => boolean,
  ): number {
    const n = x?.k === "int" ? Number(x.text) : Number.NaN;
    if (x === undefined || !Number.isInteger(n) || n < INT4_MIN || n > INT4_MAX) {
      return reject(
        "rule_sql_rejected",
        "function",
        loc,
        `${what}: the integer must be a constant within 32 bits here`,
      );
    }
    if (ok !== undefined && !ok(n))
      reject("rule_sql_rejected", "function", loc, `${what}: ${n} is out of range`);
    this.bareSet.add(x);
    return n;
  }

  /**
   * A parameter beside a number in arithmetic takes the number's type (S); in addition and the
   * like also its unit, as a literal does (11 «单位»); a factor or divisor has none.
   */
  protected adopt(xs: readonly Ty[], withUnit: boolean): readonly Ty[] {
    const [a, b] = xs;
    if (xs.length !== 2 || a === undefined || b === undefined) return xs;
    const one = (p: Ty, q: Ty): Ty => {
      if (p.param === undefined || !numeric(q.t)) return p;
      this.bind(p, q.t, withUnit ? q.unit : undefined);
      const { unit, unitless, ...plain } = q;
      return {
        ...(withUnit
          ? { ...plain, ...(unit !== undefined ? { unit } : {}), ...(unitless ? { unitless } : {}) }
          : plain),
        konst: true,
        agg: false,
      };
    };
    return [one(a, b), one(b, a)];
  }

  protected op(e: Expr & { k: "op" }, given: readonly Ty[]): Ty {
    const { op, loc } = e;
    const xs = "+-*/%".includes(op) ? this.adopt(given, op !== "*" && op !== "/") : given;
    const konst = xs.every((x) => x.konst);
    const agg = xs.some((x) => x.agg);
    const [a, b] = xs;
    if (a === undefined) return refuseNode(loc, "an operator without operands");
    if (b === undefined) {
      if (a.t === "null") return untypedNull(loc);
      if (!numeric(a.t))
        reject(
          "rule_sql_rejected",
          "function",
          loc,
          `prefix ${op} on a value that is not a number`,
        );
      return { ...a, konst, agg };
    }
    switch (op) {
      case "=":
      case "<>":
      case "<":
      case "<=":
      case ">":
      case ">=":
        this.comparable([a, b], loc);
        return { t: "boolean", konst, agg };
      case "||":
        this.needText(a, loc, "||");
        this.needText(b, loc, "||");
        if ((a.t === "null" && b.t !== "text") || (b.t === "null" && a.t !== "text"))
          untypedNull(loc);
        return { t: "text", konst, agg };
    }
    // Dates: date ± integer, date − date (11 «运算符»). PostgreSQL adds only a 32-bit integer to a
    // date: this version takes an integer constant there.
    if (a.t === "date" || b.t === "date") {
      const [x, y] = e.args as [Expr, Expr];
      if (op === "+" && a.t === "date" && b.t !== "date") {
        this.int4(y, loc, "date + <integer>");
        return { t: "date", konst, agg };
      }
      if (op === "+" && b.t === "date" && a.t !== "date") {
        this.int4(x, loc, "<integer> + date");
        return { t: "date", konst, agg };
      }
      if (op === "-" && a.t === "date" && b.t === "date") {
        // int4 in PostgreSQL.
        this.widenSet.add(e);
        return { t: "bigint", scale: 0, konst, agg };
      }
      if (op === "-" && a.t === "date") {
        this.int4(y, loc, "date - <integer>");
        return { t: "date", konst, agg };
      }
      return reject("rule_sql_rejected", "function", loc, `${op} on a date`);
    }
    for (const x of xs) {
      if (!numeric(x.t) && x.t !== "null")
        reject("rule_sql_rejected", "function", loc, `${op} on a value that is not a number`);
    }
    if (a.t === "null" && b.t === "null") untypedNull(loc);
    const bothInt = a.t !== "numeric" && b.t !== "numeric";
    const t: SqlType = bothInt ? "bigint" : "numeric";
    const rounding = sharedRounding(xs);
    const r = rounding !== undefined ? { rounding } : {};
    switch (op) {
      case "+":
      case "-":
      case "%": {
        const units = this.units(xs, loc);
        const scale = maxOf(xs.map((x) => x.scale));
        return {
          t,
          konst,
          agg,
          ...units,
          ...(scale !== undefined ? { scale } : {}),
          ...r,
        };
      }
      case "*": {
        const sum =
          a.scale !== undefined && b.scale !== undefined
            ? Math.min(MAX_SCALE, a.scale + b.scale)
            : undefined;
        return {
          t,
          konst,
          agg,
          ...this.product(a, b, false),
          ...(sum !== undefined ? { scale: sum } : {}),
          ...r,
        };
      }
      case "/": {
        if (bothInt) {
          reject(
            "rule_sql_rejected",
            "function",
            loc,
            "integer / integer (it truncates)",
            "cast one side: <x>::numeric",
          );
        }
        const s = maxOf([a.scale, b.scale, 6]);
        return {
          t: "numeric",
          konst,
          agg,
          ...this.product(a, b, true),
          ...(s !== undefined ? { scale: s } : {}),
          ...r,
        };
      }
      default:
        return reject("rule_sql_rejected", "function", loc, `the operator ${op}`);
    }
  }

  /** Units of a product or quotient (11 «单位» 乘除). */
  protected product(a: Ty, b: Ty, divide: boolean): Pick<Ty, "unit" | "unitless"> {
    if (a.unitless || b.unitless) return { unitless: true };
    if (a.unit !== undefined && b.unit === undefined) return { unit: a.unit };
    if (a.unit === undefined && b.unit !== undefined)
      return divide ? { unitless: true } : { unit: b.unit };
    if (a.unit !== undefined && b.unit !== undefined) {
      if (divide && a.unit.code === b.unit.code)
        return { unit: { code: "1", dimension: "dimensionless", to_base: "1" } };
      return { unitless: true };
    }
    return {};
  }

  protected castTy(e: Expr & { k: "cast" }, x: Ty): Ty {
    const { to, loc } = e;
    const keep = { konst: x.konst, agg: x.agg };
    if (x.t === "timestamptz" && to.t === "date") {
      return refuseNondeterministic(
        loc,
        "function",
        "a cast from a zoned date-time to date (it follows the session time zone)",
        "saveslot_date(<field>)",
      );
    }
    // The bound text widens int4 values with CAST(… AS bigint) (PrintHints): there a bigint to
    // bigint cast is the printer's own and stands for its argument.
    if (this.naming === "ids" && to.t === "bigint" && x.t === "bigint") {
      this.transparentSet.add(e);
      return x;
    }
    // The cast table is the whitelist's data (11 «类型转换»).
    const from = x.t === "null" ? undefined : x.t;
    if (!CASTS.some((c) => c.from === from && c.to === to.t && c.contexts.includes(this.place))) {
      return x.t === "null"
        ? untypedNull(loc)
        : reject("rule_sql_rejected", "function", loc, `a cast from ${x.t} to ${to.t}`);
    }
    if (to.t === "numeric") {
      if (x.t === "numeric" && to.scale === undefined)
        return reject("rule_sql_rejected", "function", loc, "a cast from numeric to numeric");
      const scale = to.scale ?? x.scale;
      return {
        t: "numeric",
        ...keep,
        ...(x.unit !== undefined ? { unit: x.unit } : {}),
        ...(x.unitless ? { unitless: true as const } : {}),
        ...(scale !== undefined ? { scale } : {}),
        ...(x.rounding !== undefined ? { rounding: x.rounding } : {}),
      };
    }
    if (to.t === "bigint") {
      return {
        t: "bigint",
        scale: 0,
        ...keep,
        ...(x.unit !== undefined ? { unit: x.unit } : {}),
        ...(x.unitless ? { unitless: true as const } : {}),
      };
    }
    if (to.t === "timestamp") return { t: "timestamp", ...keep };
    // to date: from a timestamp, or a DATE '…' literal.
    if (x.param !== undefined) {
      this.bind(x, "date");
      return { t: "date", ...keep };
    }
    if (x.t === "unknown" && !validDate(x.lit ?? ""))
      return reject("rule_sql_rejected", "type", loc, "a date literal is written YYYY-MM-DD");
    return { t: "date", ...keep };
  }

  protected funcTy(e: Expr & { k: "func" }, xs: readonly Ty[]): Ty {
    const { name, loc } = e;
    const konst = xs.every((x) => x.konst);
    const agg = xs.some((x) => x.agg);
    const sig = (ok: boolean) => {
      if (!ok) reject("rule_sql_rejected", "function", loc, `${name}() with these arguments`);
    };
    // No function here takes an untyped NULL: PostgreSQL cannot pick among its forms.
    if (xs.some((x) => x.t === "null")) untypedNull(loc);
    const isNum = (x: Ty | undefined) => x !== undefined && numeric(x.t);
    const isText = (x: Ty | undefined) => {
      const ok = x !== undefined && (x.t === "text" || x.t === "unknown");
      if (ok) this.bind(x, "text");
      return ok;
    };
    /** round, trunc, floor, ceil, sign take numeric only: on an integer PostgreSQL goes to floating point. */
    const numericOnly = (x: Ty | undefined) => {
      sig(n >= 1 && isNum(x));
      if (x?.t !== "numeric") {
        reject(
          "rule_sql_rejected",
          "function",
          loc,
          `${name}() of an integer (PostgreSQL computes it in floating point)`,
          "<integer>::numeric",
        );
      }
    };
    const [a, b, c] = xs;
    const [, eb, ec] = e.args;
    const n = xs.length;
    const unitOf = (x: Ty) => ({
      ...(x.unit !== undefined ? { unit: x.unit } : {}),
      ...(x.unitless ? { unitless: true as const } : {}),
    });
    const round = (x: Ty) => (x.rounding !== undefined ? { rounding: x.rounding } : {});
    switch (name) {
      case "abs":
        sig(n === 1 && a !== undefined && isNum(a));
        return { ...(a as Ty), konst, agg };
      case "round":
      case "trunc": {
        sig(n === 1 || n === 2);
        numericOnly(a);
        // The number of digits is a constant; it gives the scale (10 «精度与舍入»).
        const scale =
          n === 1 ? 0 : Math.max(0, Math.min(MAX_SCALE, this.int4(eb, loc, `${name}(x, n)`)));
        return {
          t: "numeric",
          konst,
          agg,
          ...unitOf(a as Ty),
          ...(scale !== undefined ? { scale } : {}),
          ...round(a as Ty),
        };
      }
      case "floor":
      case "ceil":
        sig(n === 1);
        numericOnly(a);
        return { t: "numeric", scale: 0, konst, agg, ...unitOf(a as Ty), ...round(a as Ty) };
      case "sign":
        sig(n === 1);
        numericOnly(a);
        return { t: "numeric", scale: 0, konst, agg };
      case "mod": {
        sig(n === 2 && isNum(a) && isNum(b));
        const units = this.units(xs, loc);
        const scale = maxOf(xs.map((x) => x.scale));
        const rounding = sharedRounding(xs);
        return {
          t: (a as Ty).t !== "numeric" && (b as Ty).t !== "numeric" ? "bigint" : "numeric",
          konst,
          agg,
          ...units,
          ...(scale !== undefined ? { scale } : {}),
          ...(rounding !== undefined ? { rounding } : {}),
        };
      }
      case "date_trunc": {
        const field = e.args[0];
        sig(n === 2 && field?.k === "str");
        if (field?.k !== "str" || !DATE_TRUNC_FIELDS.has(field.value)) {
          return reject(
            "rule_sql_rejected",
            "function",
            loc,
            "date_trunc takes 'day', 'week', 'month', 'quarter' or 'year' (in lower case)",
          );
        }
        const x = b as Ty;
        if (x.t === "date" || x.t === "timestamptz") {
          return refuseNondeterministic(
            loc,
            "function",
            `date_trunc on a ${x.t === "date" ? "date without ::timestamp (it becomes a zoned value)" : "zoned date-time"}`,
            x.t === "date"
              ? `date_trunc('${field.value}', <date>::timestamp)::date`
              : `date_trunc('${field.value}', saveslot_date(<field>)::timestamp)::date`,
          );
        }
        sig(x.t === "timestamp");
        return { t: "timestamp", konst, agg };
      }
      case "length":
        sig(n === 1 && isText(a));
        // int4 in PostgreSQL.
        this.widenSet.add(e);
        return { t: "bigint", scale: 0, konst, agg };
      case "substr":
        sig((n === 2 || n === 3) && isText(a));
        this.int4(eb, loc, "substr(t, from)");
        if (n === 3) this.int4(ec, loc, "substr(t, from, count)", (k) => k >= 0);
        return { t: "text", konst, agg };
      case "left":
      case "right":
        sig(n === 2 && isText(a));
        this.int4(eb, loc, `${name}(t, n)`);
        return { t: "text", konst, agg };
      case "strpos":
        sig(n === 2 && isText(a) && isText(b));
        // int4 in PostgreSQL.
        this.widenSet.add(e);
        return { t: "bigint", scale: 0, konst, agg };
      case "starts_with":
        sig(n === 2 && isText(a) && isText(b));
        return { t: "boolean", konst, agg };
      case "btrim":
      case "ltrim":
      case "rtrim":
        sig((n === 1 || n === 2) && isText(a) && (n === 1 || isText(b)));
        return { t: "text", konst, agg };
      case "replace":
        sig(n === 3 && isText(a) && isText(b) && isText(c));
        return { t: "text", konst, agg };
      case "split_part":
        sig(n === 3 && isText(a) && isText(b));
        this.int4(ec, loc, "split_part(t, delimiter, n)", (k) => k !== 0);
        return { t: "text", konst, agg };
      case "make_date": {
        // Three integers: constants within 32 bits, or other integer values; an impossible date
        // fails when the query runs (11 «函数»).
        sig(n === 3 && xs.every((x) => x.t === "bigint"));
        e.args.forEach((x, i) => {
          if (x.k === "int")
            this.int4(x, loc, "make_date", (k) => k >= Number.MIN_SAFE_INTEGER && i >= 0);
        });
        return { t: "date", konst, agg };
      }
      case "saveslot_now":
        sig(n === 0);
        this.nowUsed = true;
        return { t: "timestamptz", konst: true, agg: false };
      case "saveslot_today":
        sig(n === 0);
        this.nowUsed = true;
        this.todayAt.push(loc);
        return { t: "date", konst: true, agg: false };
      case "saveslot_date": {
        const arg = e.args[0];
        const col = n === 1 && arg?.k === "col" ? this.column(arg) : undefined;
        if (col?.kind !== "field" || col.field.type !== "zoned_datetime") {
          return reject(
            "rule_sql_rejected",
            "function",
            loc,
            "saveslot_date takes one zoned_datetime column",
          );
        }
        return { t: "date", konst: false, agg };
      }
      default:
        return reject("rule_sql_rejected", "function", loc, `the function ${name}`);
    }
  }

  protected aggTy(e: Expr & { k: "agg" }, allowed: boolean): Ty {
    const { loc } = e;
    if (!allowed)
      reject(
        "rule_sql_rejected",
        "node",
        loc,
        `${e.name}() here (aggregates are allowed in the output and HAVING, not nested)`,
      );
    if (e.filter !== undefined) {
      const f = this.ty(e.filter, false);
      this.needBoolean(f, loc);
    }
    if (e.star) return { t: "bigint", scale: 0, konst: false, agg: true };
    const raw = this.ty(e.arg as Expr, false);
    if (raw.t === "null") untypedNull(loc);
    if (raw.param !== undefined)
      reject(
        "rule_sql_rejected",
        "type",
        loc,
        `${e.name}() of a parameter: its type cannot be inferred`,
      );
    // A string literal is text here, as in PostgreSQL.
    const x: Ty = raw.t === "unknown" ? { ...raw, t: "text" } : raw;
    const sig = (ok: boolean) => {
      if (!ok) reject("rule_sql_rejected", "function", loc, `${e.name}() of this type`);
    };
    const unit = {
      ...(x.unit !== undefined ? { unit: x.unit } : {}),
      ...(x.unitless ? { unitless: true as const } : {}),
    };
    const r = x.rounding !== undefined ? { rounding: x.rounding } : {};
    switch (e.name) {
      case "count":
        sig(x.t !== "timestamp");
        return { t: "bigint", scale: 0, konst: false, agg: true };
      case "sum":
        sig(numeric(x.t));
        // sum(bigint) is numeric in PostgreSQL: printed as CAST(sum(…) AS bigint), so that a sum
        // beyond 64 bits is an overflow (11 «确定性» 6).
        if (x.t === "bigint") this.widenSet.add(e);
        return {
          t: x.t as SqlType,
          konst: false,
          agg: true,
          ...unit,
          ...(x.scale !== undefined ? { scale: x.scale } : {}),
          ...r,
        };
      case "avg": {
        sig(numeric(x.t));
        const s = maxOf([x.scale, 6]);
        return {
          t: "numeric",
          konst: false,
          agg: true,
          ...unit,
          ...(s !== undefined ? { scale: s } : {}),
          ...r,
        };
      }
      case "min":
      case "max":
        sig(numeric(x.t) || x.t === "text" || x.t === "date" || x.t === "timestamptz");
        return { ...x, konst: false, agg: true };
      case "bool_and":
      case "bool_or":
        sig(x.t === "boolean");
        return { t: "boolean", konst: false, agg: true };
      default:
        return reject("rule_sql_rejected", "function", loc, `the aggregate ${e.name}`);
    }
  }

  /**
   * A key for structural equality: columns by what they resolve to, places left out, the bound
   * text's own widening casts left out.
   */
  key(e: unknown): string {
    return JSON.stringify(e, (k, v: unknown) => {
      if (k === "loc") return undefined;
      let x = v;
      while (x !== null && typeof x === "object" && this.transparentSet.has(x as Expr)) {
        x = (x as Expr & { k: "cast" }).arg;
      }
      if (x !== null && typeof x === "object" && (x as { k?: unknown }).k === "col") {
        return { col: this.colKey(x as Expr & { k: "col" }) };
      }
      // A replaced value is not passed through the replacer again: its places go here.
      return x === v ? v : JSON.parse(this.key(x));
    });
  }

  /** What a column reference stands for in a structural key. */
  protected colKey(x: Expr & { k: "col" }): unknown {
    const c = this.column(x);
    if (c === undefined) return x.parts;
    if (c.kind === "field" || c.kind === "dfield") return c.field.id;
    return c.kind === "system" ? c.name : x.parts;
  }

  get hints(): PrintHints {
    return {
      widen: (e) => this.widenSet.has(e),
      bare: (e) => this.bareSet.has(e),
      transparent: (e) => this.transparentSet.has(e),
    };
  }
}

/** A derived rule's analysis: names resolved against one base table of the slot. */
export class Analyzer extends ExprTyper {
  readonly #in: AnalyzeInput;
  readonly #table: CompiledBaseTable;
  readonly #qualifier: string;
  readonly #fields: ReadonlyMap<string, CompiledBaseField>;
  readonly #system: ReadonlyMap<string, SqlType>;
  readonly #outputNames: ReadonlyMap<string, number>;
  readonly #deps = new Map<FieldId, true>();
  readonly #aliased: boolean;

  constructor(input: AnalyzeInput, stmt: RuleStatement) {
    super(input.naming, "D");
    this.#in = input;
    this.#table = this.#resolveTable(stmt);
    const ids = input.naming === "ids";
    this.#qualifier = fold(stmt.from.alias ?? (ids ? this.#table.id : this.#table.name));
    this.#aliased = stmt.from.alias !== undefined;
    this.#fields = new Map(this.#table.fields.map((f) => [ids ? f.id : fold(f.name), f]));
    const t = this.#table.time;
    this.#system = new Map<string, SqlType>(
      t.type === "state"
        ? [
            ["entity_id", "text"],
            ["valid_from", t.granularity === "date" ? "date" : "timestamptz"],
            ["valid_to", t.granularity === "date" ? "date" : "timestamptz"],
          ]
        : [["row_id", "text"]],
    );
    const names = new Map<string, number>();
    stmt.targets.forEach((x, i) => {
      if (x.name !== undefined && !names.has(fold(x.name))) names.set(fold(x.name), i);
    });
    this.#outputNames = names;
  }

  get table(): CompiledBaseTable {
    return this.#table;
  }

  #resolveTable(stmt: RuleStatement): CompiledBaseTable {
    const { from } = stmt;
    if (from.slot !== undefined && fold(from.slot) !== fold(this.#in.slot)) {
      reject(
        "cross_slot_ref",
        "unknown_name",
        from.loc,
        "a derived rule reads only tables of its own slot",
      );
    }
    const ids = this.#in.naming === "ids";
    const key = ids ? from.table : fold(from.table);
    const tables = new Map(this.#in.tables.map((t) => [ids ? t.id : fold(t.name), t]));
    const t = tables.get(key);
    if (t !== undefined) return t;
    if (!ids && this.#in.derivedTables.some((d) => fold(d) === key)) {
      return notYet(from.loc, "reading a derived table");
    }
    return reject("rule_sql_rejected", "unknown_name", from.loc, `no table ${from.table}`);
  }

  protected override lookup(e: Expr & { k: "col" }): Column | undefined {
    const parts = e.parts.map((p) => (this.naming === "ids" ? p : fold(p)));
    let name: string | undefined;
    if (parts.length === 1) name = parts[0];
    else if (parts.length === 2 && fold(parts[0] ?? "") === this.#qualifier) name = parts[1];
    else if (
      parts.length === 3 &&
      fold(parts[0] ?? "") === fold(this.#in.slot) &&
      fold(parts[1] ?? "") === this.#qualifier &&
      !this.#aliased &&
      this.naming === "names"
    ) {
      name = parts[2];
    }
    if (name === undefined) return undefined;
    const f = this.#fields.get(name);
    if (f !== undefined) return { kind: "field", field: f };
    const sys = this.#system.get(fold(name));
    if (sys !== undefined) return { kind: "system", name: fold(name), t: sys };
    return undefined;
  }

  protected override onColumn(c: AnyColumn): void {
    if (c.kind === "field") this.#deps.set(c.field.id, true);
  }

  /** The output column a GROUP BY item names (11 «语句形状»: every key is an output column). */
  groupTarget(stmt: RuleStatement, g: RuleStatement["groupBy"][number]): number {
    if (g.k === "ordinal") {
      if (g.n < 1 || g.n > stmt.targets.length) {
        return reject(
          "rule_sql_rejected",
          "node",
          g.loc,
          `GROUP BY ${g.n}: there are ${stmt.targets.length} output columns`,
        );
      }
      return g.n - 1;
    }
    // A bare name that is no column of the table is an output column's name.
    if (g.k === "col" && g.parts.length === 1 && this.column(g) === undefined) {
      const i = this.#outputNames.get(fold(g.parts[0] ?? ""));
      if (i !== undefined) return i;
    }
    const ty = this.ty(g, false);
    if (ty.konst) return reject("rule_sql_rejected", "node", g.loc, "GROUP BY a constant");
    const k = this.key(g);
    const i = stmt.targets.findIndex((t) => this.key(t.expr) === k);
    if (i < 0) {
      return reject(
        "rule_sql_rejected",
        "node",
        g.loc,
        "every GROUP BY key must be an output column (it is the derived table's key)",
      );
    }
    return i;
  }

  /** Every column of `e` outside aggregates is part of a group key expression. */
  grouped(e: Expr, keys: ReadonlySet<string>, what: string): void {
    if (keys.has(this.key(e)) || e.k === "agg") return;
    if (e.k === "col") {
      reject(
        "rule_sql_rejected",
        "node",
        e.loc,
        `${e.parts.join(".")} in ${what} must be in GROUP BY or inside an aggregate`,
      );
    }
    for (const c of children(e)) this.grouped(c, keys, what);
  }

  get usesNow(): boolean {
    return this.nowUsed;
  }

  dependsOn(): { table: TableId; field: FieldId }[] {
    return [...this.#deps.keys()]
      .sort((x, y) => Number(x.slice(1)) - Number(y.slice(1)))
      .map((field) => ({ table: this.#table.id, field }));
  }

  /** A business-time bucket: a date field, saveslot_date(f), or date_trunc of one, casts aside. */
  isBucket(e: Expr): boolean {
    const bare = (x: Expr): Expr => (x.k === "cast" ? bare(x.arg) : x);
    const x = bare(e);
    if (x.k === "col") {
      const c = this.column(x);
      return c?.kind === "field" && c.field.type === "date";
    }
    if (x.k === "func" && x.name === "saveslot_date") return true;
    if (x.k === "func" && x.name === "date_trunc") {
      const arg = x.args[1];
      return arg !== undefined && this.isBucket(arg);
    }
    return false;
  }

  /** Whether `e` reads a column of one of `types`. */
  reads(e: Expr, pred: (c: Column) => boolean): boolean {
    if (e.k === "col") {
      const c = this.column(e);
      return c !== undefined && (c.kind === "field" || c.kind === "system") && pred(c);
    }
    return children(e).some((c) => this.reads(c, pred));
  }
}

export function children(e: Expr): readonly Expr[] {
  switch (e.k) {
    case "col":
    case "int":
    case "num":
    case "str":
    case "bool":
    case "null":
      return [];
    case "cast":
    case "not":
    case "isnull":
    case "booltest":
    case "extract":
      return [e.arg];
    case "op":
    case "and":
    case "or":
    case "coalesce":
    case "greatest":
    case "least":
    case "func":
      return e.args;
    case "distinct":
    case "not_distinct":
    case "nullif":
      return [e.l, e.r];
    case "in":
      return [e.arg, ...e.list];
    case "like":
      return [e.arg, e.pattern, ...(e.escape !== undefined ? [e.escape] : [])];
    case "between":
      return [e.arg, e.lo, e.hi];
    case "case":
      return [
        ...(e.arg !== undefined ? [e.arg] : []),
        ...e.whens.flatMap((w) => [w.when, w.result]),
        ...(e.else !== undefined ? [e.else] : []),
      ];
    case "agg":
      return [
        ...(e.arg !== undefined ? [e.arg] : []),
        ...(e.filter !== undefined ? [e.filter] : []),
      ];
    case "param":
      return [];
    case "sublink":
      return e.arg !== undefined ? [e.arg] : [];
    case "win":
      return [
        ...e.args,
        ...(e.filter !== undefined ? [e.filter] : []),
        ...(e.over.k === "spec"
          ? [...e.over.spec.partitionBy, ...e.over.spec.orderBy.map((o) => o.expr)]
          : []),
      ];
  }
}

/** The output column's name: its AS name, or the name of a bare column (07 «文档结构», 派生表). */
function outputName(t: RuleStatement["targets"][number]): string | undefined {
  if (t.name !== undefined) return t.name;
  if (t.expr.k === "col") return t.expr.parts[t.expr.parts.length - 1];
  return undefined;
}

/** The derived field an output column becomes, with declarations applied (10 «精度与舍入»). */
function fieldOf(name: string, ty: Ty, decl: DeclaredField, loc: number): DerivedFieldResult {
  const bad = (what: string, suggestion?: string): never =>
    reject("rule_sql_rejected", "type", loc, `${name}: ${what}`, suggestion);
  const simple = (
    type: "text" | "boolean" | "date" | "integer" | "enum" | "ref",
  ): DerivedFieldResult => {
    const an = /^[aeiou]/.test(type) ? "an" : "a";
    // A declared unit that contradicts the inferred one is a unit error (11 «拒绝时报什么»).
    if (decl.unit !== undefined)
      reject("unit_inference_failed", "type", loc, `${name}: ${an} ${type} column has no unit`);
    if (decl.type !== undefined || decl.scale !== undefined || decl.rounding !== undefined) {
      bad(`${an} ${type} column takes no type, scale or rounding`);
    }
    return { name: decl.name, type };
  };
  switch (ty.t) {
    case "text":
    case "unknown":
      return simple(ty.through ?? "text");
    case "boolean":
      return simple("boolean");
    case "date":
      return simple("date");
    case "bigint":
      if (ty.unit === undefined && !ty.unitless) return simple("integer");
      break;
    case "numeric":
      break;
    case "timestamptz":
      return bad(
        "a zoned date-time cannot be a derived column",
        "saveslot_date(<field>) gives its day",
      );
    case "timestamp":
      return bad("a timestamp cannot be a derived column", "<x>::date");
    case "null":
      return bad("NULL has no type");
  }
  // Numbers: decimal or quantity.
  let unit: CompiledUnit | undefined;
  if (ty.unitless) {
    if (decl.type === "decimal") unit = undefined;
    else if (decl.unit !== undefined) unit = decl.unit;
    else {
      return reject(
        "unit_inference_failed",
        "type",
        loc,
        `${name}: the unit of a product or quotient of quantities is not inferred`,
        `declare the field with "type": "decimal"`,
      );
    }
  } else {
    unit = ty.unit;
    // A declared unit that contradicts the inferred one is a unit error (11 «拒绝时报什么»).
    const badUnit = (what: string): never =>
      reject("unit_inference_failed", "type", loc, `${name}: ${what}`);
    if (decl.type === "decimal" && unit !== undefined)
      badUnit(`declared decimal, but it is a quantity in ${unit.code}`);
    if (decl.unit !== undefined && decl.unit.code !== unit?.code) {
      badUnit(
        unit === undefined
          ? `declared in ${decl.unit.code}, but it has no unit`
          : `declared in ${decl.unit.code}, but it is in ${unit.code}`,
      );
    }
  }
  if (ty.scale !== undefined && decl.scale !== undefined && decl.scale !== ty.scale) {
    bad(`declared scale ${decl.scale}, but it has scale ${ty.scale}`);
  }
  const scale = ty.scale ?? decl.scale;
  if (scale === undefined) return bad("its scale is not inferred", `declare "scale" on the field`);
  if (ty.rounding !== undefined && decl.rounding !== undefined && decl.rounding !== ty.rounding) {
    bad(`declared rounding ${decl.rounding}, but it rounds ${ty.rounding}`);
  }
  const precision = { scale, rounding: ty.rounding ?? decl.rounding ?? "half_up" };
  if (unit !== undefined) return { name: decl.name, type: "quantity", unit, precision };
  return { name: decl.name, type: "decimal", precision };
}

/** Analyses a converted rule; throws RsqlError at the first problem. */
export function analyze(stmt: RuleStatement, input: AnalyzeInput): Analysis {
  const a = new Analyzer(input, stmt);
  if (stmt.targets.length === 0) refuseNode(undefined, "a SELECT without output columns");

  // Output columns ↔ declared fields, by name without ASCII case.
  const declared = new Map(
    input.fields.map((f, i) => [input.naming === "ids" ? `f${i + 1}` : fold(f.name), i]),
  );
  const used = new Set<number>();
  const outputs = stmt.targets.map((t) => {
    const name = outputName(t);
    if (name === undefined) {
      return reject(
        "rule_sql_rejected",
        "node",
        t.loc,
        "an output column needs a name",
        "<expression> AS <field name>",
      );
    }
    const i = declared.get(input.naming === "ids" ? name : fold(name));
    if (i === undefined)
      return reject(
        "rule_sql_rejected",
        "unknown_name",
        t.loc,
        `the output column ${name} is not a declared field`,
      );
    if (used.has(i))
      return reject("rule_sql_rejected", "node", t.loc, `two output columns named ${name}`);
    used.add(i);
    return i;
  });
  const missing = input.fields.findIndex((_, i) => !used.has(i));
  if (missing >= 0) {
    reject(
      "rule_sql_rejected",
      "node",
      undefined,
      `the declared field ${input.fields[missing]?.name} is not an output column`,
    );
  }

  if (stmt.where !== undefined) {
    const w = a.ty(stmt.where, false);
    if (w.t !== "boolean" && w.t !== "null")
      reject("rule_sql_rejected", "type", stmt.where.loc, "WHERE needs a boolean");
  }
  const tys = stmt.targets.map((t) => a.ty(t.expr, true));
  const groupKey = [...new Set(stmt.groupBy.map((g) => a.groupTarget(stmt, g)))].sort(
    (x, y) => x - y,
  );
  for (const i of groupKey) {
    if (tys[i]?.agg)
      reject(
        "rule_sql_rejected",
        "node",
        stmt.targets[i]?.loc,
        "an aggregate cannot be a group key",
      );
  }
  let havingTy: ReturnType<typeof a.ty> | undefined;
  if (stmt.having !== undefined) {
    havingTy = a.ty(stmt.having, true);
    if (havingTy.t !== "boolean" && havingTy.t !== "null")
      reject("rule_sql_rejected", "type", stmt.having.loc, "HAVING needs a boolean");
  }

  // The outermost level is an aggregate: grouped, or a whole aggregate (06 «刷新范围与写入准入»).
  if (groupKey.length === 0 && !tys.some((t) => t.agg) && !havingTy?.agg) {
    throw new RsqlError({
      kind: "not_in_this_version",
      message:
        "the outermost level of a derived rule must be a grouped aggregate or an aggregate over the whole table",
    });
  }
  const keys = new Set(groupKey.map((i) => a.key((stmt.targets[i] as { expr: Expr }).expr)));
  stmt.targets.forEach((t, i) => {
    if (!groupKey.includes(i)) a.grouped(t.expr, keys, "the output");
  });
  if (stmt.having !== undefined) a.grouped(stmt.having, keys, "HAVING");

  const dependsOn = a.dependsOn();
  if (dependsOn.length === 0) notYet(stmt.from.loc, "a rule that reads no field of its table");

  // Time dependency (06 «时间依赖», 11 «时间»): now > bucketed > none. Bucketed: a group key is a
  // date field, saveslot_date(<field>), or date_trunc(<unit>, …) of one of these.
  const table = a.table;
  const keyExprs = groupKey.map((i) => (stmt.targets[i] as { expr: Expr }).expr);
  const timeDependency: TimeDependency =
    a.usesNow || table.time.type === "state"
      ? "now"
      : keyExprs.some((e) => a.isBucket(e))
        ? "bucketed"
        : "none";
  if (timeDependency !== input.declaredTimeDependency) {
    reject(
      "rule_sql_rejected",
      undefined,
      undefined,
      `the rule is ${timeDependency === "now" ? "computed at read time (it uses saveslot_now() / saveslot_today() or reads a state table)" : timeDependency === "bucketed" ? "bucketed by a date" : "independent of time"}, declared ${input.declaredTimeDependency}`,
      `"time_dependency": "${timeDependency}"`,
    );
  }
  const keyFromFreeText = keyExprs.some((e) =>
    a.reads(e, (c) => c.kind === "field" && c.field.type === "text"),
  );

  const fields: DerivedFieldResult[] = new Array(input.fields.length);
  stmt.targets.forEach((t, i) => {
    const d = outputs[i] as number;
    const decl = input.fields[d] as DeclaredField;
    fields[d] = fieldOf(decl.name, tys[i] as Ty, decl, t.loc);
  });

  return {
    table,
    timeDependency,
    dependsOn,
    groupKey,
    keyFromFreeText,
    outputs,
    fields,
    columnOf: (e) => {
      const c = a.column(e);
      if (c === undefined || c.kind === "dfield" || c.kind === "out")
        throw new Error("unresolved column");
      return c;
    },
    hints: a.hints,
    key: (e) => a.key(e),
  };
}
