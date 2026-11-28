// Steps 5 and 6 of 11-restricted-sql.md «处理步骤» for `sql` queries (S): names resolved against the
// slots and tables the caller can see («名字»), `*` expanded to the visible fields, and types and
// units inferred and checked («类型»), down to the type and unit of each output column.
//
// Names resolve only against what the caller is given: the visible slots with their visible tables.
// A name that is no table of those, for whatever reason (it does not exist, is not visible, is a
// physical name, a system object), is one error: `unknown_name`, the same words for all of them,
// so that the answer does not tell which. The typing of expressions is ./analyze.ts's (shared with
// derived rules); this file adds scopes: tables, joins, subqueries, CTEs, set operations, windows.
//
// Lookups by a name the caller wrote go through Maps.

import type {
  CompiledBaseTable,
  CompiledDerivedField,
  CompiledTable,
  CompiledUnit,
  FieldId,
  FieldType,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { type AnyColumn, children, ExprTyper, type ParamType, type Ty } from "./analyze.ts";
import { computedAtRead } from "./at-read.ts";
import { convertRule, LIMITS } from "./convert.ts";
import { reject } from "./errors.ts";
import type {
  Cte,
  Expr,
  Frame,
  FrameBound,
  FromItem,
  GroupItem,
  JoinRef,
  Query,
  SelectBody,
  SelectItem,
  SortItem,
  TableRef,
  Target,
  TimeClause,
  TimeOperand,
  WindowSpec,
} from "./ir.ts";
import { rsqlParser } from "./load.ts";
import { type Bindings, bind, type ResolvedColumn, type ResolvedTable } from "./sql-bind.ts";
import { walkExpr, walkQuery } from "./sql-walk.ts";

export type { ResolvedColumn, ResolvedTable };

import type { SqlType } from "./whitelist.ts";

/** ASCII case folding: names are unique without ASCII case (11 «名字 · 大小写与引号»). */
const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

// --- what the caller gives ----------------------------------------------------------------------

/** Names a slot's tables and fields had in the last 10 schema versions, by what they are now. */
export interface FormerNames {
  readonly tables?: readonly { readonly name: string; readonly table: TableId }[];
  readonly fields?: readonly {
    readonly table: TableId;
    readonly name: string;
    readonly field: FieldId;
  }[];
}

/**
 * A slot the caller can see, as `visibleSlots()` (../../read/slots.ts) gives it, with the tables it
 * can see in it: derived tables are in `tables`; whether one is visible follows from its
 * dependencies (11 «名字 · 可见范围»).
 */
export interface SqlSlot {
  readonly slot: string;
  readonly name: string;
  readonly timezone: string;
  readonly sv: number;
  readonly tables: readonly CompiledTable[];
  /** Old names that still resolve (11 «名字»: the last 10 schema versions). */
  readonly formerNames?: FormerNames;
}

/** A problem that is not a refusal of the text: the call itself is wrong. */
export class SqlInvalid extends Error {
  readonly reason: "ambiguous_table" | "granularity" | "malformed";
  readonly detail: {
    readonly loc?: number;
    readonly candidates?: readonly string[];
    readonly param?: string;
  };
  constructor(
    reason: "ambiguous_table" | "granularity" | "malformed",
    message: string,
    detail: SqlInvalid["detail"] = {},
  ) {
    super(message);
    this.name = "SqlInvalid";
    this.reason = reason;
    this.detail = detail;
  }
}

// --- what it gives back -------------------------------------------------------------------------

export type SqlWarning = {
  readonly code: "renamed";
  readonly table?: string;
  readonly from: string;
  readonly to: string;
};

/** A column of the result (04-contract-types `SqlResult.columns`). */
export interface OutputColumn {
  readonly name: string;
  readonly type: FieldType | "unknown";
  readonly unit?: string;
}

export interface SqlAnalysis {
  /** The query with each `*` replaced by the fields it stands for. */
  readonly query: Query;
  readonly columns: readonly OutputColumn[];
  /** Each table reference by what it names (CTE references are not in it). */
  readonly tables: ReadonlyMap<TableRef, ResolvedTable>;
  /** Each column reference, including those `*` stands for, by what it resolves to. */
  readonly resolved: ReadonlyMap<Expr, ResolvedColumn>;
  /** Each parameter by the type its use gave it. */
  readonly params: ReadonlyMap<number, ParamType>;
  readonly warnings: readonly SqlWarning[];
  /** The slots the query reads, with the schema version of each. */
  readonly slots: ReadonlyMap<string, { readonly name: string; readonly sv: number }>;
  /** `saveslot_now()` or `saveslot_today()` is used, or a state table is read without a time clause. */
  readonly usesNow: boolean;
  /** The integer sums of `query` that the executed text casts to bigint (an overflow is a runtime failure). */
  readonly widened: ReadonlySet<Expr>;
}

// --- scopes -------------------------------------------------------------------------------------

interface SrcCol {
  /** The name a query refers to it by (an alias list may have renamed it), and the result shows. */
  readonly name: string;
  readonly col: AnyColumn;
  readonly resolved: ResolvedColumn;
  /**
   * The name it has in the text that is executed: a slot table's field, a system column, or the
   * output name the analyser gave the column of a subquery or a CTE. Never a caller's spelling that
   * the database would have to resolve.
   */
  readonly phys: string;
  /** An output column with no name of its own (no AS, not a plain column): `*` takes it, a name does not. */
  readonly anon?: boolean;
  /** A column merged by JOIN … USING: the two it merges. */
  readonly using?: { readonly l: SrcCol; readonly r: SrcCol; readonly join: JoinRef["type"] };
}

interface Source {
  readonly id: number;
  /** How a column is qualified: the alias, or the table's name; folded. */
  readonly qualifier?: string;
  /** For `slot.table.column`: folded names, only when there is no alias. */
  readonly slotName?: string;
  readonly tableName?: string;
  readonly cols: readonly SrcCol[];
  readonly sys: ReadonlyMap<string, SrcCol>;
  /** Old names of fields, by what they now are (folded). */
  readonly former: ReadonlyMap<string, { readonly col: SrcCol; readonly to: string }>;
  readonly display?: string;
}

/** A column as a FROM clause offers it unqualified: after JOIN … USING merges the pairs. */
interface RelCol {
  readonly name: string;
  readonly col: SrcCol;
  readonly src?: Source;
}

interface Scope {
  readonly parent?: Scope;
  sources: Source[];
  rels: RelCol[];
  readonly windows: Map<string, WindowSpec>;
}

interface Found {
  readonly col: SrcCol;
  readonly depth: number;
  readonly renamed?: { readonly table?: string; readonly to: string };
}

interface OutCol {
  readonly name: string;
  readonly ty: Ty;
  /** No name of its own: see `SrcCol.anon`. */
  readonly anon?: boolean;
}

interface CteInfo {
  readonly id: number;
  readonly cols: readonly OutCol[];
  /** The output names the CTE's query is printed with. */
  readonly phys: readonly string[];
}

const INT64_MAX = 2n ** 63n - 1n;
const DATE_LIT = /^\d{4}-\d{2}-\d{2}$/;
const INSTANT_LIT = /^\d{4}-\d{2}-\d{2}[T ]\d{2}:\d{2}(:\d{2}(\.\d{1,6})?)?(Z|[+-]\d{2}:\d{2})$/;

function validDate(s: string): boolean {
  if (!DATE_LIT.test(s)) return false;
  const d = new Date(`${s}T00:00:00Z`);
  return !Number.isNaN(d.getTime()) && d.toISOString().slice(0, 10) === s;
}

const rank = (b: FrameBound): number =>
  b.k === "unbounded_preceding"
    ? 0
    : b.k === "preceding"
      ? 1
      : b.k === "current_row"
        ? 2
        : b.k === "following"
          ? 3
          : 4;

class SqlAnalyzer extends ExprTyper {
  readonly #slots: readonly SqlSlot[];
  /** Per slot: the tables the caller can see in it, with derived ones only if their dependencies are. */
  readonly #visible = new Map<string, readonly CompiledTable[]>();
  #scope: Scope = { sources: [], rels: [], windows: new Map() };
  #ctes: Map<string, CteInfo>[] = [];
  #nextId = 1;
  #winOk = false;
  /** How many aggregate calls enclose the expression being typed (a subquery starts again at 0). */
  #inAgg = 0;
  readonly tables = new Map<TableRef, ResolvedTable>();
  readonly resolved = new Map<Expr, ResolvedColumn>();
  readonly #depth = new Map<Expr, number>();
  readonly #ids = new Map<Expr, string>();
  readonly #warnings = new Map<string, SqlWarning>();
  readonly slotsRead = new Map<string, SqlSlot>();
  readonly #expansions = new Map<object, SelectItem[]>();
  // What the printed text is made from (./sql-bind.ts): the analysis's bindings, by object.
  /** Each column reference, by the column of a source it is. */
  readonly boundCol = new Map<Expr, SrcCol>();
  /** ORDER BY and GROUP BY items that name an output column, by its position. */
  readonly outRefs = new Map<Expr, number>();
  /** Each FROM item of a table, subquery or CTE reference, by its source. */
  readonly srcOf = new Map<FromItem, Source>();
  readonly cteOf = new Map<Cte, CteInfo>();
  /** The CTE a reference in FROM reads. */
  readonly cteRef = new Map<FromItem, CteInfo>();
  /** Each `JOIN … USING`, by the pairs of columns it equates. */
  readonly usingOf = new Map<FromItem, { l: SrcCol; r: SrcCol }[]>();
  /** The names a table reference was bound to: the slot's and the table's own. */
  readonly defNames = new Map<FromItem, { slot: string; table: string }>();
  /** Columns a `*` stands for, bound without looking a name up. */
  readonly #direct = new Map<Expr, SrcCol>();
  #usesNow = false;
  /** The table references so far: those written, and those of the rules expanded in their place. */
  #refs: number;
  readonly #expansion = new Map<string, number>();

  constructor(
    slots: readonly SqlSlot[],
    paramLocs: ReadonlyMap<number, number>,
    tableRefs: number,
  ) {
    super("names", "S");
    this.#slots = slots;
    this.#refs = tableRefs;
    for (const [n, loc] of paramLocs) this.paramLoc.set(n, loc);
    for (const s of slots) this.#visible.set(s.slot, visibleOf(s));
  }

  get warnings(): SqlWarning[] {
    return [...this.#warnings.values()];
  }

  get now(): boolean {
    return this.#usesNow || this.nowUsed;
  }

  get todayLocs(): readonly number[] {
    return this.todayAt;
  }

  get printHints() {
    return this.hints;
  }

  // --- names -------------------------------------------------------------------------------

  /** The table a reference names, or a thrown refusal: `unknown_name` or `ambiguous_table`. */
  #resolveTable(ref: TableRef): { slot: SqlSlot; table: CompiledTable } {
    const name = fold(ref.table);
    const unknown = (): never =>
      reject(
        "rule_sql_rejected",
        "unknown_name",
        ref.loc,
        `unknown table ${JSON.stringify(ref.slot !== undefined ? `${ref.slot}.${ref.table}` : ref.table)}`,
        undefined,
        ref.slot !== undefined ? `${ref.slot}.${ref.table}` : ref.table,
      );
    const inScope =
      ref.slot === undefined
        ? this.#slots
        : this.#slots.filter((s) => fold(s.name) === fold(ref.slot as string));
    const holders = inScope.flatMap((slot) => {
      const t = (this.#visible.get(slot.slot) ?? []).find((x) => fold(x.name) === name);
      return t === undefined ? [] : [{ slot, table: t }];
    });
    const [first, second] = holders;
    if (second !== undefined) {
      throw new SqlInvalid("ambiguous_table", `the table ${ref.table} is in more than one slot`, {
        loc: ref.loc,
        candidates: holders.map((h) => `${h.slot.name}.${h.table.name}`),
      });
    }
    if (first !== undefined) return first;
    // Old names: the last 10 schema versions; a current name wins, and none is current here.
    const old = inScope.flatMap((slot) => {
      const visible = this.#visible.get(slot.slot) ?? [];
      const hit = (slot.formerNames?.tables ?? []).find((f) => fold(f.name) === name);
      const table = hit === undefined ? undefined : visible.find((t) => t.id === hit.table);
      return table === undefined ? [] : [{ slot, table }];
    });
    const [o1, o2] = old;
    if (o2 !== undefined) {
      throw new SqlInvalid("ambiguous_table", `the table ${ref.table} is in more than one slot`, {
        loc: ref.loc,
        candidates: old.map((h) => `${h.slot.name}.${h.table.name}`),
      });
    }
    if (o1 === undefined) return unknown();
    this.#warn({ code: "renamed", from: ref.table, to: o1.table.name });
    return o1;
  }

  /**
   * A derived table that is computed when read has its rule put in its place as a subquery (11
   * «处理步骤» 7), and the references of that rule count too (11 «代价»): the limit is checked here,
   * before anything is expanded.
   */
  #expand(slot: SqlSlot, table: CompiledTable, loc: number): void {
    this.#refs += this.#expandedRefs(slot, table, 0);
    if (this.#refs > LIMITS.tableRefs) {
      reject(
        "rule_sql_rejected",
        "limit",
        loc,
        `more than ${LIMITS.tableRefs} table references (a derived table computed when read counts the tables its rule reads)`,
      );
    }
  }

  /** The references a read-time derived table adds: its rule's table, and what that one adds. */
  #expandedRefs(slot: SqlSlot, table: CompiledTable, depth: number): number {
    if (table.kind !== "derived" || !computedAtRead(table) || depth > 8) return 0;
    const key = `${slot.slot}/${table.id}`;
    const known = this.#expansion.get(key);
    if (known !== undefined) return known;
    // The rule's text is bound to table IDs; it is one table (the shape of a derived rule today: a
    // rule with a JOIN, a second table, a subquery or a WITH is not compiled yet). When that opens,
    // this counts every table the rule reads, recursively (there is a case in sql.test.ts that stops
    // holding when it does).
    const from = convertRule(rsqlParser().parse(table.rule.sql)).from;
    const source = slot.tables.find((t) => t.id === from.table);
    const n = 1 + (source === undefined ? 0 : this.#expandedRefs(slot, source, depth + 1));
    this.#expansion.set(key, n);
    return n;
  }

  #warn(w: SqlWarning): void {
    this.#warnings.set(`${w.table ?? ""}|${w.from}|${w.to}`, w);
  }

  #tableSource(
    ref: TableRef,
    slot: SqlSlot,
    table: CompiledTable,
    alias: string | undefined,
  ): Source {
    const id = this.#nextId++;
    const derived = table.kind === "derived";
    const qualified = `${slot.name}.${table.name}`;
    const cols: SrcCol[] = table.fields.map((f) => ({
      name: f.name,
      phys: f.name,
      col: derived
        ? { kind: "dfield", field: f as CompiledDerivedField }
        : { kind: "field", field: f as never },
      resolved: {
        kind: "field",
        source: id,
        slot: slot.slot,
        table: table.id,
        field: f.id,
        derived,
      },
    }));
    const renamed = ref.columns;
    if (renamed !== undefined && renamed.length > cols.length) {
      reject(
        "rule_sql_rejected",
        "node",
        ref.loc,
        "a column alias list longer than the columns",
        undefined,
        ref.table,
      );
    }
    const named = cols.map((c, i) => ({ ...c, name: renamed?.[i] ?? c.name }));
    const sys = new Map<string, SrcCol>();
    if (!derived) {
      const t = (table as CompiledBaseTable).time;
      const mk = (name: "row_id" | "entity_id" | "valid_from" | "valid_to", ty: SqlType): void => {
        sys.set(name, {
          name,
          phys: name,
          col: { kind: "system", name, t: ty },
          resolved: { kind: "system", source: id, slot: slot.slot, table: table.id, name },
        });
      };
      if (t.type === "state") {
        mk("entity_id", "text");
        mk("valid_from", t.granularity === "date" ? "date" : "timestamptz");
        mk("valid_to", t.granularity === "date" ? "date" : "timestamptz");
      } else mk("row_id", "text");
    }
    const former = new Map<string, { col: SrcCol; to: string }>();
    if (renamed === undefined) {
      for (const f of slot.formerNames?.fields ?? []) {
        if (f.table !== table.id) continue;
        const col = named.find((c) => c.resolved.kind === "field" && c.resolved.field === f.field);
        if (col !== undefined && !former.has(fold(f.name))) {
          former.set(fold(f.name), { col, to: col.name });
        }
      }
    }
    return {
      id,
      ...(alias !== undefined
        ? { qualifier: fold(alias), display: alias }
        : {
            qualifier: fold(table.name),
            // `slot.table.column` only where the FROM wrote the slot.
            ...(ref.slot !== undefined ? { slotName: fold(slot.name) } : {}),
            tableName: fold(table.name),
            display: qualified,
          }),
      cols: named,
      sys,
      former,
    };
  }

  /**
   * A FROM subquery or a CTE reference as a source. `phys` are the names the columns are printed
   * with when the source is a CTE's (its query is printed once, with them); a subquery's are made
   * here, and its query is printed with them.
   */
  #outSource(
    cols: readonly OutCol[],
    alias: string | undefined,
    renamed: readonly string[] | undefined,
    loc: number,
    phys?: readonly string[],
  ): Source {
    const id = this.#nextId++;
    if (renamed !== undefined && renamed.length > cols.length) {
      reject("rule_sql_rejected", "node", loc, "a column alias list longer than the columns");
    }
    const names = cols.map((c, i) => renamed?.[i] ?? c.name);
    const anon = cols.map((c, i) => c.anon === true && renamed?.[i] === undefined);
    const printed = phys ?? explicitNames(names, anon);
    return {
      id,
      ...(alias !== undefined ? { qualifier: fold(alias), display: alias } : {}),
      cols: cols.map((c, index) => ({
        name: names[index] as string,
        col: { kind: "out", ty: c.ty },
        resolved: { kind: "out", source: id, index },
        phys: printed[index] as string,
        ...(anon[index] ? { anon: true } : {}),
      })),
      sys: new Map(),
      former: new Map(),
    };
  }

  #addSource(scope: Scope, s: Source, loc: number): void {
    if (s.qualifier !== undefined && scope.sources.some((x) => x.qualifier === s.qualifier)) {
      reject(
        "rule_sql_rejected",
        "unknown_name",
        loc,
        `the table name ${s.display ?? s.qualifier} is used more than once (give each a different alias)`,
        undefined,
        s.display ?? s.qualifier,
      );
    }
    scope.sources.push(s);
  }

  /** A column by the name parts as written; the nearest scope that has it. */
  protected override lookup(e: Expr & { k: "col" }): AnyColumn | undefined {
    const direct = this.#direct.get(e);
    const found = direct !== undefined ? { col: direct, depth: 0 } : this.#find(e);
    if (found === undefined) return undefined;
    this.boundCol.set(e, found.col);
    this.resolved.set(e, found.col.resolved);
    this.#depth.set(e, found.depth);
    this.#ids.set(
      e,
      found.col.resolved.kind === "using"
        ? `using:${found.col.resolved.name}`
        : `${found.col.resolved.source}:${found.col.name}`,
    );
    if (found.renamed !== undefined) {
      const w: SqlWarning = {
        code: "renamed",
        ...(found.renamed.table !== undefined ? { table: found.renamed.table } : {}),
        from: e.parts[e.parts.length - 1] ?? "",
        to: found.renamed.to,
      };
      this.#warn(w);
    }
    return found.col.col;
  }

  #find(e: Expr & { k: "col" }): Found | undefined {
    const parts = e.parts.map(fold);
    const name = parts[parts.length - 1] ?? "";
    const written = e.parts.join(".");
    const ambiguous = (): never =>
      reject(
        "rule_sql_rejected",
        "unknown_name",
        e.loc,
        `the column ${written} is ambiguous: put the table name before it`,
        undefined,
        written,
      );
    // A qualified name is looked for in the innermost scope that has that qualifier, and only there:
    // PostgreSQL fixes the table by its name first, and without the column in it reads `q.f` as the
    // function `f(q)`; it does not go on outwards (11 «名字»).
    let only: Scope | undefined;
    if (parts.length > 1) {
      const qual = parts.length === 2 ? parts[0] : parts[1];
      for (let sc: Scope | undefined = this.#scope; sc !== undefined; sc = sc.parent) {
        const has = sc.sources.some((s) =>
          parts.length === 2
            ? s.qualifier === qual
            : s.slotName === parts[0] && s.tableName === qual,
        );
        if (has) {
          only = sc;
          break;
        }
      }
      if (only === undefined) return undefined;
    }
    for (const phase of ["current", "former"] as const) {
      let depth = 0;
      for (let sc: Scope | undefined = this.#scope; sc !== undefined; sc = sc.parent, depth++) {
        if (only !== undefined && sc !== only) continue;
        let hits: { col: SrcCol; renamed?: { table?: string; to: string } }[] = [];
        if (parts.length === 1) {
          if (phase === "current") {
            hits = [
              ...sc.rels
                .filter((r) => r.name === name && r.col.anon !== true)
                .map((r) => ({ col: r.col })),
              ...sc.sources.flatMap((s) => {
                const sys = s.sys.get(name);
                return sys === undefined ? [] : [{ col: sys }];
              }),
            ];
          } else {
            hits = sc.sources.flatMap((s) => {
              const f = s.former.get(name);
              return f === undefined ? [] : [{ col: f.col, renamed: { to: f.to } }];
            });
          }
        } else {
          const qual = parts.length === 2 ? parts[0] : parts[1];
          const sources = sc.sources.filter((s) =>
            parts.length === 2
              ? s.qualifier === qual
              : s.slotName === parts[0] && s.tableName === qual,
          );
          hits = sources.flatMap((s) => {
            if (phase === "current") {
              const c =
                s.cols.find((x) => fold(x.name) === name && x.anon !== true) ?? s.sys.get(name);
              return c === undefined ? [] : [{ col: c }];
            }
            const f = s.former.get(name);
            return f === undefined
              ? []
              : [{ col: f.col, renamed: { table: s.display ?? "", to: f.to } }];
          });
          // Two columns of one source with the same name (an alias list): ambiguous.
          if (sources.length === 1 && phase === "current") {
            const same = (sources[0] as Source).cols.filter(
              (x) => fold(x.name) === name && x.anon !== true,
            );
            if (same.length > 1) ambiguous();
          }
        }
        if (hits.length > 1) ambiguous();
        // A FROM item of this scope has an output column no name can reach (no AS): a name not found
        // here may have meant it, and PostgreSQL would bind it here, not outside. The two must not
        // differ, so the search stops (11 «名字»).
        if (
          hits.length === 0 &&
          parts.length === 1 &&
          phase === "current" &&
          sc.sources.some((src) => src.cols.some((c) => c.anon === true))
        ) {
          reject(
            "rule_sql_rejected",
            "unknown_name",
            e.loc,
            `the column ${written} is not found, and a subquery or CTE here has an output column without a name`,
            "give each output column of the subquery or CTE an AS name",
            written,
          );
        }
        const [hit] = hits;
        if (hit !== undefined) {
          return {
            col: hit.col,
            depth,
            ...(hit.renamed !== undefined ? { renamed: hit.renamed } : {}),
          };
        }
      }
    }
    return undefined;
  }

  protected override colKey(x: Expr & { k: "col" }): unknown {
    return this.#ids.get(x) ?? x.parts;
  }

  // --- the query ---------------------------------------------------------------------------

  /** The query's checks; `outer` is the scope its correlated references reach. */
  query(
    q: Query,
    outer: Scope | undefined,
  ): {
    query: Query;
    cols: { name: string; ty: Ty; loc: number; anon?: boolean }[];
    scope?: Scope;
  } {
    const saved = this.#scope;
    const frame = new Map<string, CteInfo>();
    this.#ctes.push(frame);
    try {
      for (const c of q.with) this.#cte(c, frame, outer);
      const body = q.body;
      if (body.k === "select") {
        const r = this.#select(body, outer, q);
        return { query: q, cols: r.cols, scope: r.scope };
      }
      const left = this.query(body.left, outer);
      const right = this.query(body.right, outer);
      if (left.cols.length !== right.cols.length) {
        reject(
          "rule_sql_rejected",
          "type",
          body.loc,
          `the sides of ${body.op.toUpperCase()} have ${left.cols.length} and ${right.cols.length} columns`,
        );
      }
      const cols = left.cols.map((l, i) => {
        const r = right.cols[i] as { ty: Ty };
        const u = this.unify([l.ty, r.ty], body.loc);
        return {
          name: l.name,
          ty: { ...u, konst: false, agg: false },
          loc: body.loc,
          ...(l.anon === true ? { anon: true } : {}),
        };
      });
      this.#sortLimit(q, undefined, cols, undefined);
      return { query: q, cols };
    } finally {
      this.#ctes.pop();
      this.#scope = saved;
    }
  }

  #cte(c: Cte, frame: Map<string, CteInfo>, outer: Scope | undefined): void {
    // Names are unique without ASCII case (11 «名字»): two CTEs of one WITH cannot share one.
    if (frame.has(fold(c.name))) {
      reject(
        "rule_sql_rejected",
        "unknown_name",
        c.loc,
        `the CTE name ${c.name} is used more than once in one WITH`,
        undefined,
        c.name,
      );
    }
    const r = this.query(c.query, outer);
    if (c.columns !== undefined && c.columns.length > r.cols.length) {
      reject("rule_sql_rejected", "node", c.loc, "a column alias list longer than the columns");
    }
    const id = this.#nextId++;
    const cols = r.cols.map((x, i) => ({
      name: c.columns?.[i] ?? x.name,
      ty: x.ty,
      ...(x.anon === true && c.columns?.[i] === undefined ? { anon: true } : {}),
    }));
    const info: CteInfo = {
      id,
      cols,
      phys: explicitNames(
        cols.map((x) => x.name),
        cols.map((x) => x.anon === true),
      ),
    };
    frame.set(fold(c.name), info);
    this.cteOf.set(c, info);
  }

  #findCte(name: string): CteInfo | undefined {
    for (let i = this.#ctes.length - 1; i >= 0; i--) {
      const c = this.#ctes[i]?.get(name);
      if (c !== undefined) return c;
    }
    return undefined;
  }

  // --- one SELECT --------------------------------------------------------------------------

  #select(
    b: SelectBody,
    outer: Scope | undefined,
    q: Query,
  ): { cols: { name: string; ty: Ty; loc: number; anon?: boolean }[]; scope: Scope } {
    const savedAgg = this.#inAgg;
    this.#inAgg = 0;
    const scope: Scope = {
      ...(outer !== undefined ? { parent: outer } : {}),
      sources: [],
      rels: [],
      windows: new Map(),
    };
    // FROM: each item reads only the outer scope (no LATERAL), a join's ON its own sides.
    for (const item of b.from) {
      this.#scope = scope;
      const rel = this.#from(item, scope, outer);
      scope.rels.push(...rel);
    }
    this.#scope = scope;
    for (const w of b.windows) {
      if (scope.windows.has(fold(w.name)))
        reject("rule_sql_rejected", "node", w.spec.loc, `the window ${w.name} is defined twice`);
      this.#spec(w.spec, scope, false);
      scope.windows.set(fold(w.name), w.spec);
    }
    if (b.where !== undefined) {
      this.#boolean(this.ty(b.where, false), b.where.loc, "WHERE");
    }
    // Output columns, `*` expanded; window functions are allowed here and in ORDER BY only.
    const items = b.targets.flatMap((t) => this.#expandStar(t, scope));
    const savedWin = this.#winOk;
    this.#winOk = true;
    const cols: { name: string; ty: Ty; loc: number; anon?: boolean }[] = [];
    const tys: Ty[] = [];
    for (const t of items) {
      const ty = this.ty(t.expr, true);
      tys.push(ty);
      cols.push({
        name: outputName(t),
        ty: outTy(ty),
        loc: t.loc,
        ...(this.#anon(t) ? { anon: true } : {}),
      });
    }
    this.#winOk = false;
    const exprs = items.map((t) => t.expr);
    // GROUP BY: expressions, or the number or name of an output column.
    const keys = new Set<string>();
    for (const g of b.groupBy) keys.add(this.key(this.#groupExpr(g, exprs, items, tys)));
    let havingTy: Ty | undefined;
    if (b.having !== undefined) {
      havingTy = this.ty(b.having, true);
      this.#boolean(havingTy, b.having.loc, "HAVING");
    }
    const aggregated =
      b.groupBy.length > 0 || b.having !== undefined || tys.some((t) => t.agg) || havingTy?.agg;
    if (aggregated) {
      for (const e of exprs) this.#grouped(e, keys, "the output");
      if (b.having !== undefined) this.#grouped(b.having, keys, "HAVING");
      const own = new Set(scope.sources.map((x) => x.id));
      for (const e of exprs) this.#groupedInSubqueries(e, keys, own, "the output");
      if (b.having !== undefined) this.#groupedInSubqueries(b.having, keys, own, "HAVING");
    }
    // DISTINCT [ON] and ORDER BY / LIMIT / OFFSET.
    const targetKeys = exprs.map((e) => this.key(e));
    const onKeys: string[] = [];
    if (typeof b.distinct === "object") {
      for (const e of b.distinct.on) {
        let at: number | undefined = e.k === "int" ? Number(e.text) - 1 : undefined;
        if (e.k === "col" && e.parts.length === 1) {
          // Like ORDER BY: a bare name is an output column's first.
          const hits = cols.flatMap((c, i) => (fold(c.name) === fold(e.parts[0] ?? "") ? [i] : []));
          if (hits.length > 1) {
            reject(
              "rule_sql_rejected",
              "unknown_name",
              e.loc,
              `DISTINCT ON ${e.parts[0]} is ambiguous`,
              undefined,
              e.parts[0],
            );
          }
          at = hits[0];
          if (at !== undefined) this.outRefs.set(e, at);
        }
        const target = at === undefined ? undefined : exprs[at];
        if (e.k === "int" && target === undefined)
          reject(
            "rule_sql_rejected",
            "node",
            e.loc,
            `DISTINCT ON ${e.text}: no such output column`,
          );
        const x = target ?? e;
        if (target === undefined) this.ty(x, false);
        onKeys.push(this.key(x));
      }
    }
    this.#winOk = true;
    const orderKeys = this.#sortLimit(q, scope, cols, { exprs, aggregated: !!aggregated, keys });
    this.#winOk = savedWin;
    if (b.distinct === true) {
      const missing = orderKeys.findIndex((k) => !targetKeys.includes(k));
      if (missing >= 0) {
        reject(
          "rule_sql_rejected",
          "node",
          q.orderBy[missing]?.expr.loc,
          "for SELECT DISTINCT, ORDER BY expressions must be output columns",
        );
      }
    } else if (typeof b.distinct === "object" && q.orderBy.length > 0) {
      const lead = new Set(orderKeys.slice(0, onKeys.length));
      if (
        orderKeys.length < onKeys.length ||
        lead.size !== new Set(onKeys).size ||
        onKeys.some((k) => !lead.has(k))
      ) {
        reject(
          "rule_sql_rejected",
          "node",
          q.orderBy[0]?.expr.loc,
          "SELECT DISTINCT ON expressions must match the initial ORDER BY expressions",
        );
      }
    }
    this.#inAgg = savedAgg;
    return { cols, scope };
  }

  /**
   * An output column is named for a query outside it only by AS or by being a plain column; every
   * other output (a function, a CASE, a subquery…) has no name another query can use, whatever the
   * database would call it: the two would have to agree on it (11 «名字»).
   */
  #anon(t: Target): boolean {
    if (t.name !== undefined) return false;
    if (t.expr.k !== "col") return true;
    return this.#direct.get(t.expr)?.anon === true;
  }

  #boolean(ty: Ty, loc: number, what: string): void {
    if (ty.param !== undefined) {
      this.bind(ty, "boolean");
      return;
    }
    if (ty.t !== "boolean" && ty.t !== "null")
      reject("rule_sql_rejected", "type", loc, `${what} needs a boolean`);
  }

  /**
   * `*` stands for columns by their names, so two columns of one table with the same name (a
   * subquery's `?column?` twice, or `a AS x, b AS x`) cannot be expanded: they would no longer be told apart.
   */
  #noRepeats(cols: readonly (readonly [string, string])[], loc: number): void {
    const seen = new Set<string>();
    for (const [q, n] of cols) {
      const key = `${q}\0${n}`;
      if (seen.has(key))
        reject(
          "rule_sql_rejected",
          "node",
          loc,
          `\`*\` over ${JSON.stringify(q === "" ? "a table" : q)} that has two columns named ${JSON.stringify(n)}: name them with AS`,
          undefined,
          "*",
        );
      seen.add(key);
    }
  }

  /** `*` and `t.*` as the output columns they stand for. */
  #expandStar(t: SelectItem, scope: Scope): Target[] {
    if (!("star" in t)) return [t];
    const out: Target[] = [];
    const mk = (parts: string[], col: SrcCol): Target => {
      const expr: Expr = { k: "col", parts, loc: t.loc };
      this.#direct.set(expr, col);
      return { expr, loc: t.loc };
    };
    if (t.qualifier === undefined) {
      if (scope.sources.length === 0)
        reject("rule_sql_rejected", "node", t.loc, "`*` in a SELECT without a FROM");
      this.#noRepeats(
        scope.rels.map((r) => [r.src?.qualifier ?? "", r.col.name] as const),
        t.loc,
      );
      for (const r of scope.rels) {
        const q = r.src?.display;
        out.push(
          mk(
            q !== undefined && r.src?.qualifier !== undefined
              ? [r.src.qualifier, r.col.name]
              : [r.col.name],
            r.col,
          ),
        );
      }
      this.#expansions.set(t, out);
      return out;
    }
    const parts = t.qualifier.map(fold);
    const src = scope.sources.find((s) =>
      parts.length === 1
        ? s.qualifier === parts[0]
        : s.slotName === parts[0] && s.tableName === parts[1],
    );
    if (src === undefined) {
      reject(
        "rule_sql_rejected",
        "unknown_name",
        t.loc,
        `unknown table ${JSON.stringify(t.qualifier.join("."))}`,
        undefined,
        t.qualifier.join("."),
      );
    }
    const s = src as Source;
    this.#noRepeats(
      s.cols.map((c) => [s.qualifier ?? "", c.name] as const),
      t.loc,
    );
    for (const c of s.cols) {
      out.push(mk(s.qualifier !== undefined ? [s.qualifier, c.name] : [c.name], c));
    }
    this.#expansions.set(t, out);
    return out;
  }

  /** The expression a GROUP BY item stands for. */
  #groupExpr(
    g: GroupItem,
    exprs: readonly Expr[],
    items: readonly Target[],
    tys: readonly Ty[],
  ): Expr {
    if (g.k === "ordinal") {
      const e = exprs[g.n - 1];
      if (e === undefined) {
        return reject(
          "rule_sql_rejected",
          "node",
          g.loc,
          `GROUP BY ${g.n}: there are ${exprs.length} output columns`,
        );
      }
      if (tys[g.n - 1]?.agg)
        reject("rule_sql_rejected", "node", g.loc, "an aggregate cannot be a group key");
      return e;
    }
    // A bare name is a column of this level's input, else an output column's name; it is not looked
    // for outside (11 «名字»).
    if (g.k === "col" && g.parts.length === 1) {
      const name = fold(g.parts[0] ?? "");
      const here = this.#scope;
      const input =
        here !== undefined &&
        (here.rels.some((r) => r.name === name && r.col.anon !== true) ||
          here.sources.some((src) => src.sys.has(name)));
      if (!input) {
        const i = items.findIndex((t) => fold(t.name ?? bareName(t.expr) ?? "") === name);
        if (i < 0) {
          reject(
            "rule_sql_rejected",
            "unknown_name",
            g.loc,
            `GROUP BY ${g.parts[0]}: no such column or output column`,
            undefined,
            g.parts[0],
          );
        }
        if (tys[i]?.agg)
          reject("rule_sql_rejected", "node", g.loc, "an aggregate cannot be a group key");
        this.outRefs.set(g, i);
        return exprs[i] as Expr;
      }
    }
    this.#winOk = false;
    this.ty(g, false);
    return g;
  }

  /**
   * A subquery of an aggregated SELECT that uses a column of that SELECT: the column must be a
   * group key (the database refuses the query otherwise, and its words are not passed on). An
   * aggregate in the subquery over the outer column alone is legal in PostgreSQL and refused
   * here too, the simpler rule.
   */
  #groupedInSubqueries(
    e: Expr,
    keys: ReadonlySet<string>,
    own: ReadonlySet<number>,
    what: string,
  ): void {
    walkExpr(e, {
      expr: (x) => {
        if (x.k !== "sublink") return;
        walkQuery(x.query, {
          expr: (c) => {
            if (c.k !== "col") return;
            const r = this.resolved.get(c);
            if (r === undefined || !("source" in r) || !own.has(r.source)) return;
            if (keys.has(this.key(c))) return;
            reject(
              "rule_sql_rejected",
              "node",
              c.loc,
              `${c.parts.join(".")} in a subquery of ${what} must be in GROUP BY`,
              undefined,
              c.parts.join("."),
            );
          },
        });
      },
    });
  }

  /** Every column of `e` of this SELECT, outside aggregates, is in a group key. */
  #grouped(e: Expr, keys: ReadonlySet<string>, what: string): void {
    if (keys.has(this.key(e)) || e.k === "agg") return;
    if (e.k === "col") {
      if ((this.#depth.get(e) ?? 0) > 0) return;
      reject(
        "rule_sql_rejected",
        "node",
        e.loc,
        `${e.parts.join(".")} in ${what} must be in GROUP BY or inside an aggregate`,
        undefined,
        e.parts.join("."),
      );
    }
    for (const c of children(e)) this.#grouped(c, keys, what);
  }

  // --- ORDER BY, LIMIT, OFFSET -------------------------------------------------------------

  /** Checks ORDER BY, LIMIT and OFFSET of a query; gives the keys ORDER BY sorts by. */
  #sortLimit(
    q: Query,
    scope: Scope | undefined,
    cols: readonly { name: string; ty: Ty; loc: number; anon?: boolean }[],
    select: { exprs: readonly Expr[]; aggregated: boolean; keys: ReadonlySet<string> } | undefined,
  ): string[] {
    const keys: string[] = [];
    for (const o of q.orderBy) {
      const e = o.expr;
      let target: number | undefined;
      if (e.k === "int") {
        target = Number(e.text) - 1;
        if (!(target >= 0 && target < cols.length)) {
          reject(
            "rule_sql_rejected",
            "node",
            e.loc,
            `ORDER BY ${e.text}: there are ${cols.length} output columns`,
          );
        }
      } else if (e.k === "col" && e.parts.length === 1) {
        const hits = cols.flatMap((c, i) => (fold(c.name) === fold(e.parts[0] ?? "") ? [i] : []));
        if (hits.length > 1) {
          reject(
            "rule_sql_rejected",
            "unknown_name",
            e.loc,
            `ORDER BY ${e.parts[0]} is ambiguous`,
            undefined,
            e.parts[0],
          );
        }
        target = hits[0];
        if (target !== undefined) this.outRefs.set(e, target);
      }
      if (target !== undefined) {
        keys.push(select !== undefined ? this.key(select.exprs[target] as Expr) : `out:${target}`);
        continue;
      }
      if (select === undefined || scope === undefined) {
        reject(
          "rule_sql_rejected",
          "node",
          e.loc,
          "ORDER BY of a set operation takes only output columns",
        );
      }
      this.ty(e, true);
      if (select?.aggregated) this.#grouped(e, select.keys, "ORDER BY");
      keys.push(this.key(e));
    }
    this.#limitValue(q.limit, "LIMIT");
    this.#limitValue(q.offset, "OFFSET");
    return keys;
  }

  #limitValue(e: Expr | undefined, what: string): void {
    if (e === undefined) return;
    if (e.k === "param") {
      this.bind({ t: "unknown", param: e.n, konst: true, agg: false }, "bigint");
      return;
    }
    if (e.k === "null") return;
    if (e.k === "int" && BigInt(e.text) >= 0n && BigInt(e.text) <= INT64_MAX) return;
    reject("rule_sql_rejected", "type", e.loc, `${what} takes a non-negative integer, NULL or $n`);
  }

  // --- FROM --------------------------------------------------------------------------------

  /** One FROM item: its sources are added to `scope`; gives its columns as a FROM clause offers them. */
  #from(item: FromItem, scope: Scope, outer: Scope | undefined): RelCol[] {
    switch (item.k) {
      case "table": {
        const cte = item.slot === undefined ? this.#findCte(fold(item.table)) : undefined;
        if (cte !== undefined) {
          if (item.time !== undefined) {
            reject(
              "rule_sql_rejected",
              "node",
              item.loc,
              "FOR VALID_TIME on a CTE",
              undefined,
              item.table,
            );
          }
          const src = this.#outSource(
            cte.cols,
            item.alias ?? item.table,
            item.columns,
            item.loc,
            cte.phys,
          );
          this.#addSource(scope, src, item.loc);
          this.srcOf.set(item, src);
          this.cteRef.set(item, cte);
          return relOf(src);
        }
        const { slot, table } = this.#resolveTable(item);
        this.slotsRead.set(slot.slot, slot);
        this.#expand(slot, table, item.loc);
        const src = this.#tableSource(item, slot, table, item.alias);
        this.#addSource(scope, src, item.loc);
        this.srcOf.set(item, src);
        this.defNames.set(item, { slot: slot.name, table: table.name });
        this.tables.set(item, {
          slot: slot.slot,
          slotName: slot.name,
          table: table.id,
          derived: table.kind === "derived",
          source: src.id,
        });
        if (item.time !== undefined) this.#timeClause(item.time, table, item);
        else if (table.kind === "base" && table.time.type === "state") this.#usesNow = true;
        return relOf(src);
      }
      case "sub": {
        const r = this.query(item.query, outer);
        const src = this.#outSource(
          r.cols.map((c) => ({
            name: c.name,
            ty: c.ty,
            ...(c.anon === true ? { anon: true } : {}),
          })),
          item.alias,
          item.columns,
          item.loc,
        );
        this.#addSource(scope, src, item.loc);
        this.srcOf.set(item, src);
        return relOf(src);
      }
      case "join": {
        const first = scope.sources.length;
        const left = this.#from(item.left, scope, outer);
        const right = this.#from(item.right, scope, outer);
        const sides = scope.sources.slice(first);
        let rel = [...left, ...right];
        if (item.using !== undefined) {
          const merged: RelCol[] = [];
          const drop = new Set<RelCol>();
          const pairs: { l: SrcCol; r: SrcCol }[] = [];
          for (const u of item.using) {
            const key = fold(u);
            const l = left.filter((c) => c.name === key);
            const r = right.filter((c) => c.name === key);
            if (l.length !== 1 || r.length !== 1) {
              reject(
                "rule_sql_rejected",
                "unknown_name",
                item.loc,
                `USING (${u}): the column must be in both sides, once`,
                undefined,
                u,
              );
            }
            const lc = (l[0] as RelCol).col;
            const rc = (r[0] as RelCol).col;
            this.comparable([this.tyOfColumn(lc.col), this.tyOfColumn(rc.col)], item.loc);
            drop.add(l[0] as RelCol);
            drop.add(r[0] as RelCol);
            pairs.push({ l: lc, r: rc });
            merged.push({
              name: key,
              col: {
                name: lc.name,
                col: lc.col,
                resolved: { kind: "using", name: key },
                phys: lc.phys,
                using: { l: lc, r: rc, join: item.type },
              },
            });
          }
          this.usingOf.set(item, pairs);
          rel = [...merged, ...rel.filter((c) => !drop.has(c))];
        }
        if (item.on !== undefined) {
          // The condition sees the two sides of its own join (and what is outside), not the comma items
          // before it in the same FROM.
          const saved = this.#scope;
          this.#scope = {
            ...(outer !== undefined ? { parent: outer } : {}),
            sources: sides,
            rels: [...left, ...right],
            windows: scope.windows,
          };
          try {
            this.#boolean(this.ty(item.on, false), item.on.loc, "ON");
          } finally {
            this.#scope = saved;
          }
        }
        return rel;
      }
    }
  }

  // --- FOR VALID_TIME ----------------------------------------------------------------------

  #timeClause(c: TimeClause, table: CompiledTable, ref: TableRef): void {
    if (table.kind !== "base" || table.time.type !== "state") {
      reject(
        "rule_sql_rejected",
        "node",
        ref.loc,
        "FOR VALID_TIME on a table that is not a state table",
        table.kind === "base" && table.time.type === "event"
          ? "select by the time field with WHERE"
          : undefined,
        "FOR VALID_TIME",
      );
    }
    const time = (table as CompiledBaseTable).time;
    const granularity = time.type === "state" ? time.granularity : "date";
    const ops = c.k === "as_of" ? [c.at] : [c.from, c.to];
    for (const o of ops) this.#timeOperand(o, granularity);
  }

  #timeOperand(o: TimeOperand, granularity: "date" | "instant"): void {
    const byDay = granularity === "date";
    const bad = (what: string): never =>
      reject(
        "rule_sql_rejected",
        "node",
        o.loc,
        `FOR VALID_TIME: ${what}`,
        undefined,
        "FOR VALID_TIME",
      );
    if (o.days !== undefined) {
      if (!byDay) bad("a number of days is added only on a table by day");
      if (o.base.k === "now") bad("days cannot be added to saveslot_now()");
    }
    switch (o.base.k) {
      case "param":
        // Text, read at the call exactly as a literal operand is (a day, or an instant with an offset,
        // by what the table takes): the same refusals, the same truncation to a day with a warning.
        this.bind({ t: "unknown", param: o.base.n, konst: true, agg: false }, "text");
        return;
      case "str": {
        const v = o.base.value;
        const date = validDate(v);
        const instant = INSTANT_LIT.test(v) && validDate(v.slice(0, 10));
        if (!date && !instant)
          reject(
            "rule_sql_rejected",
            "type",
            o.loc,
            "a date (YYYY-MM-DD) or an instant with an offset is expected",
          );
        if (date && !byDay)
          throw new SqlInvalid("granularity", "a table by instant takes an instant, not a date", {
            loc: o.loc,
            param: "sql",
          });
        if (instant && o.days !== undefined) bad("days cannot be added to an instant");
        return;
      }
      case "today":
        this.todayAt.push(o.loc);
        this.#usesNow = true;
        if (!byDay)
          throw new SqlInvalid("granularity", "a table by instant takes an instant, not a date", {
            loc: o.loc,
            param: "sql",
          });
        return;
      case "now":
        this.#usesNow = true;
        return;
    }
  }

  // --- subqueries and window functions in expressions ---------------------------------------

  protected override tySub(e: Expr & { k: "sublink" }, allowAgg: boolean): Ty {
    const saved = this.#scope;
    const r = this.query(e.query, saved);
    this.#scope = saved;
    if (e.kind === "exists") return { t: "boolean", konst: false, agg: false };
    if (r.cols.length !== 1) {
      reject(
        "rule_sql_rejected",
        "type",
        e.loc,
        `a subquery of this kind returns one column, not ${r.cols.length}`,
      );
    }
    const col = (r.cols[0] as { ty: Ty }).ty;
    const colTy: Ty = col.t === "unknown" && col.param === undefined ? { ...col, t: "text" } : col;
    if (e.kind === "scalar") return { ...colTy, konst: false, agg: false };
    const arg = this.ty(e.arg as Expr, allowAgg);
    this.comparable([arg, colTy], e.loc);
    return { t: "boolean", konst: false, agg: arg.agg };
  }

  /** A window's PARTITION BY, ORDER BY and frame. */
  #spec(w: WindowSpec, scope: Scope, allowAgg: boolean): void {
    let base: WindowSpec | undefined;
    if (w.base !== undefined) {
      base = scope.windows.get(fold(w.base));
      if (base === undefined) {
        reject(
          "rule_sql_rejected",
          "unknown_name",
          w.loc,
          `no window ${w.base}`,
          undefined,
          w.base,
        );
      }
      if (w.partitionBy.length > 0)
        reject(
          "rule_sql_rejected",
          "node",
          w.loc,
          `PARTITION BY on a window that extends ${w.base}`,
        );
      if (base?.frame !== undefined)
        reject(
          "rule_sql_rejected",
          "node",
          w.loc,
          `the window ${w.base} has a frame: it cannot be extended`,
        );
      if (base !== undefined && base.orderBy.length > 0 && w.orderBy.length > 0)
        reject(
          "rule_sql_rejected",
          "node",
          w.loc,
          `ORDER BY on a window that extends ${w.base}, which has one`,
        );
    }
    for (const p of w.partitionBy) this.ty(p, allowAgg);
    const order = w.orderBy.length > 0 ? w.orderBy : (base?.orderBy ?? []);
    const orderTys = order.map((o: SortItem) => this.ty(o.expr, allowAgg));
    if (w.frame === undefined) return;
    this.#frame(w.frame, orderTys, w.loc);
  }

  #frame(f: Frame, order: readonly Ty[], loc: number): void {
    const end = f.end ?? { k: "current_row" as const };
    if (rank(f.start) > rank(end)) {
      reject("rule_sql_rejected", "node", loc, "a window frame that starts after it ends");
    }
    if (f.mode === "groups" && order.length === 0) {
      reject("rule_sql_rejected", "node", loc, "GROUPS needs an ORDER BY in the window");
    }
    const bounds = [f.start, end].filter(
      (b): b is Extract<FrameBound, { offset: unknown }> => "offset" in b,
    );
    if (f.mode !== "range" || bounds.length === 0) return;
    const [key] = order;
    if (order.length !== 1 || key === undefined) {
      reject(
        "rule_sql_rejected",
        "node",
        loc,
        "RANGE with an offset needs exactly one ORDER BY key",
      );
    }
    const t = (key as Ty).t;
    for (const b of bounds) {
      const o = b.offset;
      const ok =
        t === "date"
          ? o.k === "interval"
          : (t === "bigint" || t === "numeric") && o.k !== "interval";
      if (!ok) {
        reject(
          "rule_sql_rejected",
          "type",
          loc,
          t === "date"
            ? "RANGE over a date takes an INTERVAL offset"
            : "RANGE over a number takes a number offset",
        );
      }
    }
    if (t !== "date" && t !== "bigint" && t !== "numeric") {
      reject("rule_sql_rejected", "type", loc, "RANGE with an offset orders by a date or a number");
    }
  }

  protected override aggTy(e: Expr & { k: "agg" }, allowed: boolean): Ty {
    this.#inAgg++;
    try {
      return super.aggTy(e, allowed);
    } finally {
      this.#inAgg--;
    }
  }

  protected override tyWin(e: Expr & { k: "win" }, allowAgg: boolean): Ty {
    if (this.#inAgg > 0) {
      reject(
        "rule_sql_rejected",
        "node",
        e.loc,
        "a window function inside an aggregate",
        undefined,
        e.name,
      );
    }
    if (!this.#winOk) {
      reject(
        "rule_sql_rejected",
        "node",
        e.loc,
        "a window function here (it is allowed in the output and ORDER BY)",
        undefined,
        e.name,
      );
    }
    const scope = this.#scope;
    if (e.over.k === "name") {
      if (!scope.windows.has(fold(e.over.name))) {
        reject(
          "rule_sql_rejected",
          "unknown_name",
          e.loc,
          `no window ${e.over.name}`,
          undefined,
          e.over.name,
        );
      }
    } else this.#spec(e.over.spec, scope, allowAgg);
    const n = e.args.length;
    const sig = (ok: boolean): void => {
      if (!ok)
        reject(
          "rule_sql_rejected",
          "function",
          e.loc,
          `${e.name}() with these arguments`,
          undefined,
          e.name,
        );
    };
    const plain = (t: Ty): Ty => ({ ...t, konst: false, agg: false });
    switch (e.name) {
      case "count":
      case "sum":
      case "avg":
      case "min":
      case "max": {
        sig(e.star ? e.name === "count" && n === 0 : n === 1);
        const synthetic: Expr & { k: "agg" } = {
          k: "agg",
          name: e.name,
          star: e.star,
          distinct: false,
          ...(e.args[0] !== undefined ? { arg: e.args[0] } : {}),
          ...(e.filter !== undefined ? { filter: e.filter } : {}),
          loc: e.loc,
        };
        const as = this.aggTy(synthetic, true);
        // The window sum of integers is numeric too: the call is the one cast back to bigint.
        if (this.widenSet.has(synthetic)) this.widenSet.add(e);
        return plain(as);
      }
      case "rank":
      case "dense_rank":
      case "row_number":
        sig(n === 0);
        return { t: "bigint", scale: 0, konst: false, agg: false };
      case "lag":
      case "lead": {
        sig(n >= 1 && n <= 3);
        const x = this.ty(e.args[0] as Expr, allowAgg);
        if (x.t === "null") sig(false);
        if (n >= 2) this.int4(e.args[1], e.loc, `${e.name}(x, n)`, (k) => k >= 0);
        if (n === 3) {
          const d = this.ty(e.args[2] as Expr, allowAgg);
          return plain(this.unify([x, d], e.loc));
        }
        return plain(x.t === "unknown" && x.param === undefined ? { ...x, t: "text" } : x);
      }
      case "first_value":
      case "last_value": {
        sig(n === 1);
        const x = this.ty(e.args[0] as Expr, allowAgg);
        if (x.t === "null") sig(false);
        return plain(x.t === "unknown" && x.param === undefined ? { ...x, t: "text" } : x);
      }
      default:
        return reject(
          "rule_sql_rejected",
          "function",
          e.loc,
          `the window function ${e.name}`,
          undefined,
          e.name,
        );
    }
  }

  // --- the whole statement -----------------------------------------------------------------

  /** What the printed tree is made from. */
  get bindings(): Bindings {
    return {
      boundCol: this.boundCol,
      outRefs: this.outRefs,
      srcOf: this.srcOf,
      cteOf: this.cteOf,
      cteRef: this.cteRef,
      usingOf: this.usingOf,
      defNames: this.defNames,
      expansions: this.#expansions,
      tables: this.tables,
      resolved: this.resolved,
      widen: (e) => this.widenSet.has(e),
    };
  }

  /** The scope an outer query's correlated references reach: none for the statement itself. */
  top(q: Query): { query: Query; cols: { name: string; ty: Ty; loc: number; anon?: boolean }[] } {
    return this.query(q, undefined);
  }
}

// --- helpers ------------------------------------------------------------------------------------

const relOf = (src: Source): RelCol[] =>
  src.cols.map((col) => ({ name: fold(col.name), col, src }));

/** The name of an output column the way PostgreSQL gives it: the AS name, the column's, the function's. */
function bareName(e: Expr): string | undefined {
  switch (e.k) {
    case "col":
      return e.parts[e.parts.length - 1];
    case "cast":
      return (
        bareName(e.arg) ??
        (e.to.t === "timestamp" ? "timestamp" : e.to.t === "bigint" ? "int8" : e.to.t)
      );
    case "func":
    case "agg":
    case "win":
      return e.name;
    case "extract":
      return "extract";
    case "case":
      return "case";
    case "coalesce":
    case "greatest":
    case "least":
      return e.k;
    case "nullif":
      return "nullif";
    case "sublink":
      return e.kind === "exists" ? "exists" : undefined;
    default:
      return undefined;
  }
}

/**
 * The names the output columns of a subquery or CTE are printed with: those with a name of their own
 * keep it; the others get one made here that no other column of the list has, so that nothing about
 * what a column is called is left to the database's defaults.
 */
function explicitNames(names: readonly string[], anon: readonly boolean[]): string[] {
  const taken = new Set(names.filter((_n, i) => !anon[i]));
  let k = 0;
  return names.map((n, i) => {
    if (!anon[i]) return n;
    let g: string;
    do g = `o${++k}`;
    while (taken.has(g));
    taken.add(g);
    return g;
  });
}

const outputName = (t: Target): string => t.name ?? bareName(t.expr) ?? "?column?";

/** A column's type as a subquery gives it on: a string literal is text. */
function outTy(t: Ty): Ty {
  return t.t === "unknown" && t.param === undefined ? { ...t, t: "text" } : t;
}

/**
 * The tables of a slot the caller can see: the tables it names, with a derived table only if
 * everything it depends on is visible too (11 «名字 · 可见范围»).
 */
function visibleOf(s: SqlSlot): readonly CompiledTable[] {
  const ids = new Set(s.tables.filter((t) => t.kind === "base").map((t) => t.id as string));
  let changed = true;
  const shown = new Set<string>();
  while (changed) {
    changed = false;
    for (const t of s.tables) {
      if (t.kind !== "derived" || shown.has(t.id)) continue;
      if (t.rule.depends_on.every((d) => ids.has(d.table) || shown.has(d.table))) {
        shown.add(t.id);
        ids.add(t.id);
        changed = true;
      }
    }
  }
  return s.tables.filter((t) => t.kind === "base" || shown.has(t.id));
}

// --- the entry ----------------------------------------------------------------------------------

/** Maps a type the analysis inferred to a result column (04-contract-types `SqlResult.columns`). */
export function columnOf(name: string, ty: Ty, loc: number): OutputColumn {
  const unit = (u: CompiledUnit | undefined): { unit?: string } =>
    u !== undefined ? { unit: u.code } : {};
  switch (ty.t) {
    case "text":
    case "unknown":
      if (ty.param !== undefined)
        reject(
          "rule_sql_rejected",
          "type",
          loc,
          `${name}: the type of a parameter cannot be inferred`,
        );
      return { name, type: ty.through ?? "text" };
    case "boolean":
      return { name, type: "boolean" };
    case "date":
      return { name, type: "date" };
    case "bigint":
      if (ty.unit === undefined || ty.unitless) return { name, type: "integer" };
      return { name, type: "quantity", ...unit(ty.unit) };
    case "numeric":
      if (ty.unit !== undefined && !ty.unitless)
        return { name, type: "quantity", ...unit(ty.unit) };
      return { name, type: "decimal" };
    case "timestamptz":
    case "null":
      return { name, type: "unknown" };
    case "timestamp":
      return reject(
        "rule_sql_rejected",
        "type",
        loc,
        `${name}: a timestamp cannot be a result column`,
        "<x>::date",
      );
  }
}

export interface AnalyzeQueryInput {
  readonly query: Query;
  readonly slots: readonly SqlSlot[];
  /** Where each parameter first appears, by number. */
  readonly paramLocs: ReadonlyMap<number, number>;
  /** The table references written in the text. */
  readonly tableRefs: number;
}

/** Names resolved, types and units checked; throws RsqlError or SqlInvalid at the first problem. */
export function analyzeQuery(input: AnalyzeQueryInput): SqlAnalysis {
  const a = new SqlAnalyzer(input.slots, input.paramLocs, input.tableRefs);
  const { cols } = a.top(input.query);
  // Every parameter has a type its use gave it.
  for (const [n, loc] of input.paramLocs) {
    if (!a.paramTypes.has(n)) {
      reject(
        "rule_sql_rejected",
        "type",
        loc,
        `the type of $${n} cannot be inferred from where it is used`,
      );
    }
  }
  // saveslot_today() needs one time zone to take the day in (11 «时间»).
  const [firstToday] = a.todayLocs;
  if (firstToday !== undefined) {
    const zones = new Set([...a.slotsRead.values()].map((s) => s.timezone));
    if (zones.size > 1) {
      reject(
        "rule_sql_rejected",
        "function",
        firstToday,
        "saveslot_today(): the slots the query reads have different time zones",
        "pass the date as $n, or split the query",
        "saveslot_today",
      );
    }
  }
  const columns = cols.map((c) => columnOf(c.name, c.ty, c.loc));
  // What is executed is a tree of its own: no name in it is left for the database to resolve.
  const bound = bind(
    input.query,
    cols.map((c) => c.name),
    a.bindings,
  );
  return {
    query: bound.query,
    columns,
    tables: bound.tables as ReadonlyMap<TableRef, ResolvedTable>,
    resolved: bound.resolved,
    widened: bound.widened,
    params: a.paramTypes,
    warnings: a.warnings,
    slots: new Map([...a.slotsRead].map(([k, s]) => [k, { name: s.name, sv: s.sv }])),
    usesNow: a.now,
  };
}
