// The tree that is printed and executed for a `sql` query (11-restricted-sql.md «处理步骤» 7–8).
//
// The analysis (./sql-analyze.ts) binds every name the caller wrote by its own rules. Printing the
// caller's names back would leave the database to resolve them again, by PostgreSQL's rules, and any
// difference between the two is a hole (a quoted name is compared exactly, a column that is not
// there becomes a function call `f(q)`, a name has a default…). So the printed text has nothing for
// the database to resolve:
//
// - every FROM item gets an alias made here, unique in the whole query (`t<n>`; a CTE is `c<n>`),
//   and the caller's aliases are not in the text;
// - every column is written `"alias"."column"`, the alias of the FROM item the analysis bound it to
//   and the name that column has in the text (a slot table's field; an output column's AS name);
// - every output column of every SELECT has an AS with a name made here or the caller's folded one,
//   so no default name is in play; `*` is written out;
// - `JOIN … USING` is written as the equality it stands for, and a merged column as the column it
//   is, on the side it comes from;
// - ORDER BY, GROUP BY and DISTINCT ON that name an output column are written by position;
// - a table is written by the slot's and the table's own names, as the schema has them.
//
// A column reference with no binding is never printed: it is a fault of the analysis.

import type { FieldId, TableId } from "@fluxvita/saveslot-contract-core";
import type {
  Cte,
  Expr,
  FromItem,
  GroupItem,
  Query,
  SelectBody,
  SelectItem,
  SortItem,
} from "./ir.ts";

// --- what the analysis says a name is (re-exported by ./sql-analyze.ts) ---------------------------

export type ResolvedColumn =
  | {
      readonly kind: "field";
      readonly source: number;
      readonly slot: string;
      readonly table: TableId;
      readonly field: FieldId;
      readonly derived: boolean;
    }
  | {
      readonly kind: "system";
      readonly source: number;
      readonly slot: string;
      readonly table: TableId;
      readonly name: "row_id" | "entity_id" | "valid_from" | "valid_to";
    }
  /** An output column of a FROM subquery or a CTE. */
  | { readonly kind: "out"; readonly source: number; readonly index: number }
  /** A column merged by JOIN … USING. */
  | { readonly kind: "using"; readonly name: string };

export interface ResolvedTable {
  readonly slot: string;
  readonly slotName: string;
  readonly table: TableId;
  /** A derived table: its rule is expanded in its place (step 7). */
  readonly derived: boolean;
  readonly source: number;
}

/** A column of a source, as the analysis keeps it. */
export interface BoundCol {
  /** The name it has in the printed text. */
  readonly phys: string;
  readonly resolved: ResolvedColumn;
  readonly using?: { readonly l: BoundCol; readonly r: BoundCol; readonly join: string };
}

export interface BoundSource {
  readonly id: number;
  readonly cols: readonly { readonly phys: string }[];
}

export interface Bindings {
  readonly boundCol: ReadonlyMap<Expr, BoundCol>;
  readonly outRefs: ReadonlyMap<Expr, number>;
  readonly srcOf: ReadonlyMap<FromItem, BoundSource>;
  readonly cteOf: ReadonlyMap<Cte, { readonly id: number; readonly phys: readonly string[] }>;
  readonly cteRef: ReadonlyMap<FromItem, { readonly id: number }>;
  readonly usingOf: ReadonlyMap<FromItem, readonly { l: BoundCol; r: BoundCol }[]>;
  readonly defNames: ReadonlyMap<FromItem, { readonly slot: string; readonly table: string }>;
  readonly expansions: ReadonlyMap<object, SelectItem[]>;
  readonly tables: ReadonlyMap<object, ResolvedTable>;
  readonly resolved: ReadonlyMap<Expr, ResolvedColumn>;
  /**
   * An integer sum, which PostgreSQL gives as numeric: the executed text casts it back to bigint, so
   * that a sum beyond 64 bits is an overflow, a runtime failure of the query (11 «确定性» 6).
   */
  readonly widen: (e: Expr) => boolean;
}

export interface Bound {
  readonly query: Query;
  /** The integer sums of `query` (its own nodes) that the executed text casts to bigint. */
  readonly widened: ReadonlySet<Expr>;
  readonly tables: ReadonlyMap<object, ResolvedTable>;
  readonly resolved: ReadonlyMap<Expr, ResolvedColumn>;
}

const isObj = (v: unknown): v is Record<string, unknown> => v !== null && typeof v === "object";

/** The query as it is printed; `names` are the names of the result's columns. */
export function bind(q: Query, names: readonly string[], b: Bindings): Bound {
  const tables = new Map<object, ResolvedTable>();
  const resolved = new Map<Expr, ResolvedColumn>();
  const widened = new Set<Expr>();

  const sourceOf = (c: BoundCol): number => {
    const r = c.resolved;
    if (r.kind === "using") throw new Error("a merged column has no source of its own");
    return r.source;
  };

  /** A column of a source, as the text writes it. */
  const colRef = (c: BoundCol, loc: number): Expr => {
    if (c.using !== undefined) {
      const { l, r, join } = c.using;
      if (join === "right") return colRef(r, loc);
      if (join === "full") return { k: "coalesce", args: [colRef(l, loc), colRef(r, loc)], loc };
      return colRef(l, loc);
    }
    const e: Expr = { k: "col", parts: [`t${sourceOf(c)}`, c.phys], loc };
    resolved.set(e, c.resolved);
    return e;
  };

  /** An expression with every column written as above, and its subqueries bound. */
  const expr = (e: Expr): Expr => {
    if (e.k === "col") {
      const c = b.boundCol.get(e);
      if (c === undefined)
        throw new Error("a column reference that binds to nothing is not printed");
      return colRef(c, e.loc);
    }
    if (e.k === "sublink") {
      return {
        ...e,
        ...(e.arg !== undefined ? { arg: expr(e.arg) } : {}),
        query: query(e.query, undefined),
      };
    }
    return deep(e) as Expr;
  };

  /** The same tree with each expression in it bound: every object is rebuilt, nothing is shared. */
  const deep = (v: unknown): unknown => {
    if (Array.isArray(v)) return v.map(deep);
    if (!isObj(v)) return v;
    if (v["k"] === "col" || v["k"] === "sublink") return expr(v as unknown as Expr);
    const out = Object.fromEntries(Object.entries(v).map(([k, x]) => [k, deep(x)]));
    if ((v["k"] === "agg" || v["k"] === "win") && b.widen(v as unknown as Expr))
      widened.add(out as unknown as Expr);
    return out;
  };

  const sort = (s: SortItem): SortItem => {
    const target = b.outRefs.get(s.expr);
    return {
      ...s,
      expr:
        target !== undefined
          ? { k: "int", text: String(target + 1), loc: s.expr.loc }
          : expr(s.expr),
    };
  };

  const group = (g: GroupItem): GroupItem => {
    if ("k" in g && g.k === "ordinal") return g;
    const target = b.outRefs.get(g as Expr);
    return target !== undefined
      ? { k: "ordinal", n: target + 1, loc: (g as Expr).loc }
      : expr(g as Expr);
  };

  const from = (f: FromItem): FromItem => {
    switch (f.k) {
      case "table": {
        const src = b.srcOf.get(f);
        if (src === undefined)
          throw new Error("a table reference that binds to nothing is not printed");
        const alias = `t${src.id}`;
        const def = b.defNames.get(f);
        if (def !== undefined) {
          const out: FromItem = {
            k: "table",
            slot: def.slot,
            table: def.table,
            alias,
            ...(f.time !== undefined ? { time: f.time } : {}),
            loc: f.loc,
          };
          const t = b.tables.get(f);
          if (t !== undefined) tables.set(out, t);
          return out;
        }
        const cte = b.cteRef.get(f);
        if (cte === undefined)
          throw new Error("a table reference that binds to nothing is not printed");
        return { k: "table", table: `c${cte.id}`, alias, loc: f.loc };
      }
      case "sub": {
        const src = b.srcOf.get(f);
        if (src === undefined) throw new Error("a subquery that binds to nothing is not printed");
        return {
          k: "sub",
          query: query(
            f.query,
            src.cols.map((c) => c.phys),
          ),
          alias: `t${src.id}`,
          loc: f.loc,
        };
      }
      case "join": {
        const left = from(f.left);
        const right = from(f.right);
        if (f.type === "cross") return { ...f, left, right };
        const pairs = b.usingOf.get(f);
        let on: Expr;
        if (pairs !== undefined) {
          const eqs = pairs.map(
            (p): Expr => ({
              k: "op",
              op: "=",
              args: [colRef(p.l, f.loc), colRef(p.r, f.loc)],
              loc: f.loc,
            }),
          );
          on = eqs.length === 1 ? (eqs[0] as Expr) : { k: "and", args: eqs, loc: f.loc };
        } else on = expr(f.on as Expr);
        return { k: "join", type: f.type, left, right, on, loc: f.loc };
      }
    }
  };

  const select = (s: SelectBody, outNames: readonly string[] | undefined): SelectBody => {
    const items = s.targets.flatMap((t) => ("star" in t ? (b.expansions.get(t) ?? []) : [t]));
    const targets = items.map((t, i) => {
      if ("star" in t) throw new Error("a `*` that was not expanded is not printed");
      return {
        expr: expr(t.expr),
        name: outNames?.[i] ?? t.name ?? `o${i + 1}`,
        loc: t.loc,
      };
    });
    return {
      k: "select",
      distinct:
        typeof s.distinct === "object"
          ? {
              on: s.distinct.on.map((e) => {
                const target = b.outRefs.get(e);
                return target !== undefined
                  ? ({ k: "int", text: String(target + 1), loc: e.loc } as Expr)
                  : expr(e);
              }),
            }
          : s.distinct,
      targets,
      from: s.from.map(from),
      ...(s.where !== undefined ? { where: expr(s.where) } : {}),
      groupBy: s.groupBy.map(group),
      ...(s.having !== undefined ? { having: expr(s.having) } : {}),
      windows: s.windows.map((w) => ({ name: w.name, spec: deep(w.spec) as typeof w.spec })),
      loc: s.loc,
    };
  };

  const cte = (c: Cte): Cte => {
    const info = b.cteOf.get(c);
    if (info === undefined) throw new Error("a CTE that binds to nothing is not printed");
    return { name: `c${info.id}`, query: query(c.query, info.phys), loc: c.loc };
  };

  function query(qq: Query, outNames: readonly string[] | undefined): Query {
    const body = qq.body;
    return {
      with: qq.with.map(cte),
      body:
        body.k === "select"
          ? select(body, outNames)
          : { ...body, left: query(body.left, outNames), right: query(body.right, outNames) },
      orderBy: qq.orderBy.map(sort),
      ...(qq.limit !== undefined ? { limit: expr(qq.limit) } : {}),
      ...(qq.offset !== undefined ? { offset: expr(qq.offset) } : {}),
      loc: qq.loc,
    };
  }

  return { query: query(q, names), tables, resolved, widened };
}
