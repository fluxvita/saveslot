// Steps 7 and 8 of 11-restricted-sql.md «处理步骤» for a `sql` query: the bound tree (./sql-bind.ts)
// rewritten to what is executed, and printed. Nothing of the caller's text is here: the tree is the
// analysis's, printed by ./sql-print.ts with the hooks below, so everything in the text is either
// what the tree holds or what this file puts there.
//
// What this file puts there:
//
// - A table reference becomes a subquery that exposes the table's logical columns under their
//   logical names, over the current version's physical table, with the revoked rows left out (an
//   event or timeless table), or over the segments of a state table as a reader sees them (adjacent
//   same-valued segments merged, ../../store/segments.ts) cut to the time condition. The printed
//   `"t<n>"."<name>"` is therefore a column of that subquery, never a function applied to a row; a
//   physical column the caller cannot see (the revoked flag, the version columns, a zoned
//   date-time's zone) is not in the subquery at all.
// - A parameter, `saveslot_now()`, `saveslot_today()` and each time operand become the call's
//   values, passed as parameters of the statement and cast to the type the analysis gave them: the
//   text holds no value of the caller's.
// - The divisor of `/`, `%` and `mod()` is `NULLIF(divisor, 0)`: a division by zero is NULL.
// - The output columns of the top-level query are `c1 … cN`: the names the caller sees are the
//   result's column descriptions, the text does not depend on them (and two columns may share one).
//
// Run in the session as it is fixed for a `sql` call: `search_path` is `pg_catalog`, so the physical
// tables are written with their schema, and functions are found where the whitelist has them.
//
// The read record is worked out from the same tree: for each base table the statement that gives the
// rows it reads, from the FROM and WHERE of its own level (a superset of the rows read: grouping,
// HAVING, ORDER BY, DISTINCT and LIMIT are left out), and whether that level can run alone.

import type {
  CompiledBaseTable,
  CompiledDerivedTable,
  CompiledTable,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import { column } from "../../store/layout.ts";
import type { SqlValue } from "../../store/ports.ts";
import { mergedSegments } from "../../store/segments.ts";
import type { Expr, FromItem, Query, SelectBody, TableRef, TimeClause, TimeOperand } from "./ir.ts";
import type { SqlAnalysis, SqlSlot } from "./sql-analyze.ts";
import { type PrintHooks, printQuery, quoteIdent } from "./sql-print.ts";
import { type Walk, walkExpr, walkFrom, walkQuery } from "./sql-walk.ts";

/** A feature this version of the kernel does not have: an internal error to the caller. */
export class SqlNotImplemented extends Error {
  override readonly name = "SqlNotImplemented";
}

/** A value the call gave makes the query unanswerable (an interval that does not run forward). */
export class SqlRuntime extends Error {
  override readonly name = "SqlRuntime";
}

/** The business time of one state table reference, as it is read. */
export type TimeRead =
  | { readonly at: string }
  | { readonly during: readonly [string, string | null] };

/** What the call decides: the values the text is given, and how time is read in the call's zone. */
export interface SqlCall {
  /** The value of `$n`, converted to the type the analysis inferred for it. */
  readonly param: (n: number) => SqlValue;
  /** The entry instant, or `at`: `saveslot_now()`. */
  readonly now: string;
  /** The day of the evaluation instant in a zone: `saveslot_today()`. */
  readonly today: (zone: string) => string;
  /**
   * The value of a clause's operand for a table by `granularity`, in the table's slot's zone: a
   * date, or an instant. Throws what the call refuses.
   */
  readonly operand: (o: TimeOperand, granularity: "date" | "instant", zone: string) => string;
  /** The point a state table is read at when it has no clause: the evaluation instant, or its day. */
  readonly current: (granularity: "date" | "instant", zone: string) => string;
}

export interface Statement {
  readonly text: string;
  readonly params: readonly SqlValue[];
}

/** What is read of one base table (or stored derived table) of one slot. */
export interface TableRead {
  readonly slot: SlotId;
  readonly slotName: string;
  readonly table: CompiledTable;
  /**
   * For each reference to it in the query: the statement that gives the identities of the rows it
   * reads (a row's or an entity's ID, a derived row's partition), or undefined where its level
   * cannot run alone (a subquery that reads the outer query's columns, a level that reads a
   * common table expression no statement can carry): then the whole table is recorded.
   */
  readonly refs: readonly (Statement | undefined)[];
}

export interface Rewritten {
  readonly main: Statement;
  readonly tables: readonly TableRead[];
  /** The time conditions of the state table references, in the order printed. */
  readonly times: readonly { readonly slot: SlotId; readonly read: TimeRead }[];
}

export interface RewriteInput {
  readonly analysis: SqlAnalysis;
  readonly slots: readonly SqlSlot[];
  readonly call: SqlCall;
}

/** Most identities the read record keeps of a table's rows: one more than the threshold says. */
export const IDENTITY_CAP = 1001;

const TABLE_ID = /^t[1-9][0-9]{0,8}$/;
const ALIAS = /^[tc][1-9][0-9]{0,8}$/;

const fold = (s: string) => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** A statement's parameters, numbered as they are first used. */
class Book {
  readonly list: SqlValue[] = [];
  /** `CAST($n AS type)`. */
  add(
    v: SqlValue,
    type: "bigint" | "numeric" | "text" | "boolean" | "date" | "timestamptz" | "timestamp",
  ): string {
    this.list.push(v);
    return `CAST($${this.list.length} AS ${type})`;
  }
}

/** The type a parameter is cast to. */
const castOf = (
  t: string,
): "bigint" | "numeric" | "text" | "boolean" | "date" | "timestamptz" | "timestamp" => {
  switch (t) {
    case "bigint":
    case "numeric":
    case "text":
    case "boolean":
    case "date":
    case "timestamptz":
    case "timestamp":
      return t;
    default:
      throw new Error(`not a parameter type: ${t}`);
  }
};

/** The divisor guarded: a division by zero is NULL, as the spec says (11 «处理步骤» 7). */
function guardDivisor(done: WeakSet<Expr>) {
  return (e: Expr): Expr | undefined => {
    if (done.has(e)) return undefined;
    const zero = (loc: number): Expr => ({ k: "int", text: "0", loc });
    let out: Expr | undefined;
    if (e.k === "op" && (e.op === "/" || e.op === "%") && e.args.length === 2) {
      const [a, b] = e.args as [Expr, Expr];
      out = { ...e, args: [a, { k: "nullif", l: b, r: zero(b.loc), loc: b.loc }] };
    } else if (e.k === "func" && e.name === "mod" && e.args.length === 2) {
      const [a, b] = e.args as [Expr, Expr];
      out = { ...e, args: [a, { k: "nullif", l: b, r: zero(b.loc), loc: b.loc }] };
    }
    if (out !== undefined) done.add(out);
    return out;
  };
}

/** The top-level query with its output columns named `c1 … cN` (the select's own objects are shared). */
function positional(q: Query): Query {
  const b = q.body;
  if (b.k === "select") {
    return {
      ...q,
      body: {
        ...b,
        targets: b.targets.map((t, i) => ("star" in t ? t : { ...t, name: `c${i + 1}` })),
      },
    };
  }
  return { ...q, body: { ...b, left: positional(b.left), right: positional(b.right) } };
}

/** The ID column a table's identity statement reads. */
function identityOf(t: CompiledTable): string {
  if (t.kind === "derived") {
    // A name no field has: the derived table's partition is not a column the caller can name.
    const taken = new Set(t.fields.map((f) => fold(f.name)));
    let n = "partition_id";
    while (taken.has(n)) n += "_";
    return n;
  }
  return t.time.type === "state" ? "entity_id" : "row_id";
}

export function rewriteSql(input: RewriteInput): Rewritten {
  const { analysis, call } = input;
  const slotOf = new Map(input.slots.map((s) => [s.slot as string, s]));
  const times = new Map<TableRef, { slot: SlotId; read: TimeRead }>();
  const tablesRead = new Map<string, { slot: SlotId; slotName: string; table: CompiledTable }>();

  const paramTypes = analysis.params;
  const typeOfParam = (n: number) => {
    const t = paramTypes.get(n);
    if (t === undefined) throw new Error(`no type for $${n}`);
    return castOf(t.t);
  };

  /** The subquery a table reference stands for. */
  function tableText(f: TableRef, book: Book, withIdentity: boolean): string {
    const rt = analysis.tables.get(f);
    if (rt === undefined) {
      // A reference to a common table expression of the tree.
      if (
        f.slot !== undefined ||
        f.time !== undefined ||
        !ALIAS.test(f.table) ||
        f.alias === undefined
      )
        throw new Error("a table reference that is neither a table nor a CTE");
      return `${quoteIdent(f.table)} AS ${quoteIdent(f.alias)}`;
    }
    if (f.alias === undefined || !ALIAS.test(f.alias)) throw new Error("a table without its alias");
    const slot = slotOf.get(rt.slot);
    const table = slot?.tables.find((t) => t.id === rt.table);
    if (slot === undefined || table === undefined) throw new Error("a table the call cannot see");
    tablesRead.set(`${slot.slot}/${table.id}`, {
      slot: slot.slot as SlotId,
      slotName: slot.name,
      table,
    });
    const inner =
      table.kind === "derived" ? derivedText(table, withIdentity) : baseText(table, f, slot, book);
    return `(${inner}) AS ${quoteIdent(f.alias)}`;
  }

  function derivedText(t: CompiledDerivedTable, withIdentity: boolean): string {
    if (t.rule.time_dependency === "now") {
      throw new SqlNotImplemented("a derived table computed when read is not read by sql yet");
    }
    const name = t.physical.table;
    if (!TABLE_ID.test(t.id) || !new RegExp(`^d_${t.id}_v[1-9][0-9]{0,8}$`).test(name))
      throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
    const cols = t.fields.map((f) => {
      if (!/^f[1-9][0-9]{0,8}$/.test(f.id))
        throw new Error(`not a field ID: ${JSON.stringify(f.id)}`);
      return `"f_${f.id}" AS ${quoteIdent(f.name)}`;
    });
    if (withIdentity) cols.unshift(`"partition_id" AS ${quoteIdent(identityOf(t))}`);
    return `SELECT ${cols.join(", ")} FROM "public"."${name}"`;
  }

  function baseText(t: CompiledBaseTable, f: TableRef, slot: SqlSlot, book: Book): string {
    const name = t.physical.table;
    if (!TABLE_ID.test(t.id) || !new RegExp(`^t_${t.id}_v[1-9][0-9]{0,8}$`).test(name))
      throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
    const fields = t.fields.map((x) => `${column(x)} AS ${quoteIdent(x.name)}`);
    const business = `"public"."${name}"`;
    if (t.time.type !== "state") {
      if (f.time !== undefined)
        throw new Error("a time clause on a table that is not a state table");
      return `SELECT ${['"row_id" AS "row_id"', ...fields].join(", ")} FROM ${business} WHERE NOT "revoked"`;
    }
    const g = t.time.granularity;
    const type = g === "date" ? "date" : "timestamptz";
    const point = (v: string) => book.add(v, type);
    const clause: TimeClause | undefined = f.time;
    let cond: string;
    let read: TimeRead;
    if (clause === undefined || clause.k === "as_of") {
      const p =
        clause === undefined
          ? call.current(g, slot.timezone)
          : call.operand(clause.at, g, slot.timezone);
      read = { at: p };
      cond = `"valid_from" <= ${point(p)} AND ("valid_to" IS NULL OR "valid_to" > ${point(p)})`;
    } else {
      const a = call.operand(clause.from, g, slot.timezone);
      const b = call.operand(clause.to, g, slot.timezone);
      if (!(a < b))
        throw new SqlRuntime("FOR VALID_TIME FROM … TO …: the interval does not run forward");
      read = { during: [a, b] };
      cond = `"valid_from" < ${point(b)} AND ("valid_to" IS NULL OR "valid_to" > ${point(a)})`;
    }
    times.set(f, { slot: slot.slot as SlotId, read });
    const cols = [
      `"entity_id" AS "entity_id"`,
      `"valid_from" AS "valid_from"`,
      `"valid_to" AS "valid_to"`,
      ...t.fields.map((x) => `${column(x)} AS ${quoteIdent(x.name)}`),
    ];
    return `SELECT ${cols.join(", ")} FROM (${mergedSegments(t, business)}) AS "m" WHERE ${cond}`;
  }

  const hooks = (book: Book, withIdentity: boolean): PrintHooks => {
    const guard = guardDivisor(new WeakSet());
    // An integer sum is numeric in PostgreSQL: cast back to bigint, so that a sum beyond 64 bits is
    // an overflow, a runtime failure of the query (11 «确定性» 6).
    const cast = new WeakSet<Expr>();
    return {
      table: (f) => tableText(f, book, withIdentity),
      konst: (e) => {
        if (e.k !== "param") return undefined;
        return book.add(call.param(e.n), typeOfParam(e.n));
      },
      func: (e) => {
        if (e.name === "saveslot_now") return book.add(call.now, "timestamptz");
        if (e.name === "saveslot_today") {
          const zones = new Set(
            [...analysis.slots.keys()].map((id) => slotOf.get(id)?.timezone ?? "UTC"),
          );
          const [zone = "UTC"] = zones;
          return book.add(call.today(zone), "date");
        }
        if (e.name === "saveslot_date") {
          throw new SqlNotImplemented(
            "saveslot_date needs the internal date column, not built yet",
          );
        }
        return undefined;
      },
      rewrite: (e) => {
        const g = guard(e);
        if (g !== undefined) return g;
        if (!analysis.widened.has(e) || cast.has(e)) return undefined;
        cast.add(e);
        return { k: "cast", arg: e, to: { t: "bigint" }, loc: e.loc };
      },
    };
  };

  const book = new Book();
  const main: Statement = (() => {
    const text = printQuery(positional(analysis.query), hooks(book, false));
    return { text, params: book.list };
  })();

  // --- the read record ------------------------------------------------------------------------

  /**
   * Whether a level reads a column of a FROM item it does not define: a level that reads the outer
   * query's columns cannot run alone.
   */
  const readsOuter = (s: SelectBody): boolean => {
    const refs = new Set<number>();
    const defs = new Set<number>();
    const w: Walk = {
      from: (f) => {
        if (f.k !== "join" && f.alias !== undefined) defs.add(Number(f.alias.slice(1)));
      },
      expr: (e) => {
        if (e.k !== "col") return;
        const r = analysis.resolved.get(e);
        if (r !== undefined && "source" in r) refs.add(r.source);
      },
    };
    for (const f of s.from) walkFrom(f, w);
    if (s.where !== undefined) walkExpr(s.where, w);
    return [...refs].some((x) => !defs.has(x));
  };

  const found: { f: TableRef; level: SelectBody }[] = [];
  walkQuery(analysis.query, {
    select: (s) => {
      const visit = (f: FromItem): void => {
        if (f.k === "table" && analysis.tables.get(f) !== undefined) found.push({ f, level: s });
        else if (f.k === "join") {
          visit(f.left);
          visit(f.right);
        }
      };
      for (const f of s.from) visit(f);
    },
  });

  /** The statement for a table reference at its level, or undefined when the level cannot run alone. */
  const identityStatement = (r: (typeof found)[number]): Statement | undefined => {
    const s = r.level;
    // A level of two or more references (a join, a comma) runs again at the cost of the product of its
    // tables, whatever the caller's LIMIT did to the statement itself: it is recorded for the whole
    // table, with no statement of its own. One reference is recorded by row, when its WHERE has no
    // subquery.
    if (s.from.reduce((n, f) => n + leavesOf(f), 0) >= 2) return undefined;
    // The same for a WHERE with a subquery in it: the statement carries the subquery along and runs
    // it for every row of the level's table, at whatever cost it has.
    if (s.where !== undefined && hasSubquery(s.where)) return undefined;
    if (readsOuter(s)) return undefined;
    const rt = analysis.tables.get(r.f);
    if (rt === undefined) return undefined;
    const slot = slotOf.get(rt.slot);
    const table = slot?.tables.find((t) => t.id === rt.table);
    if (table === undefined || r.f.alias === undefined) return undefined;
    const idBook = new Book();
    const loc = s.loc;
    const body: SelectBody = {
      k: "select",
      distinct: true,
      targets: [
        {
          expr: { k: "col", parts: [r.f.alias, identityOf(table)], loc },
          name: "id",
          loc,
        },
      ],
      from: s.from,
      ...(s.where !== undefined ? { where: s.where } : {}),
      groupBy: [],
      windows: [],
      loc,
    };
    const q: Query = {
      with: [],
      body,
      orderBy: [],
      limit: { k: "int", text: String(IDENTITY_CAP), loc },
      loc,
    };
    return { text: printQuery(q, hooks(idBook, true)), params: idBook.list };
  };

  const byTable = new Map<string, { head: TableRead; refs: (Statement | undefined)[] }>();
  for (const r of found) {
    const rt = analysis.tables.get(r.f);
    if (rt === undefined) continue;
    const key = `${rt.slot}/${rt.table}`;
    let e = byTable.get(key);
    if (e === undefined) {
      const slot = slotOf.get(rt.slot);
      const table = slot?.tables.find((t) => t.id === rt.table);
      if (slot === undefined || table === undefined) throw new Error("a table the call cannot see");
      e = {
        head: { slot: slot.slot as SlotId, slotName: slot.name, table, refs: [] },
        refs: [],
      };
      byTable.set(key, e);
    }
    e.refs.push(identityStatement(r));
  }
  // A table with one reference that cannot be read by row is recorded whole, whatever its other
  // references are: no statement is run for it at all.
  for (const e of byTable.values()) {
    if (e.refs.some((x) => x === undefined)) e.refs = [undefined];
  }

  return {
    main,
    tables: [...byTable.values()].map(({ head, refs }) => ({ ...head, refs })),
    times: [...times.values()],
  };
}

/** Whether an expression has a subquery in it, at any depth. */
function hasSubquery(e: Expr): boolean {
  let found = false;
  walkExpr(e, {
    expr: (x) => {
      if (x.k === "sublink") found = true;
    },
  });
  return found;
}

/** The references (tables, CTEs, subqueries) a FROM item joins. */
function leavesOf(f: FromItem): number {
  return f.k === "join" ? leavesOf(f.left) + leavesOf(f.right) : 1;
}
