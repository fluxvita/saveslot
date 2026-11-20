// A walk over the tree of a `sql` query (./ir.ts `Query`): every select with the common table
// expressions it can see, every FROM item, every expression, subqueries in expressions included.
// For the passes that look at a bound tree as a whole (the read record: which tables are read where,
// and whether a level can run alone).

import { children } from "./analyze.ts";
import type { Cte, Expr, FromItem, Query, SelectBody, WindowSpec } from "./ir.ts";

export interface Walk {
  /** A select, with the CTEs visible to it, outermost first. */
  readonly select?: (s: SelectBody, chain: readonly Cte[]) => void;
  readonly from?: (f: FromItem) => void;
  readonly expr?: (e: Expr) => void;
}

export function walkQuery(q: Query, w: Walk, outer: readonly Cte[] = []): void {
  const chain = [...outer];
  for (const c of q.with) {
    // A CTE of a non-recursive WITH sees the ones before it.
    walkQuery(c.query, w, chain);
    chain.push(c);
  }
  const b = q.body;
  if (b.k === "select") walkSelect(b, w, chain);
  else {
    walkQuery(b.left, w, chain);
    walkQuery(b.right, w, chain);
  }
  for (const s of q.orderBy) walkExpr(s.expr, w, chain);
  if (q.limit !== undefined) walkExpr(q.limit, w, chain);
  if (q.offset !== undefined) walkExpr(q.offset, w, chain);
}

function walkSpec(s: WindowSpec, w: Walk, chain: readonly Cte[]): void {
  for (const e of s.partitionBy) walkExpr(e, w, chain);
  for (const o of s.orderBy) walkExpr(o.expr, w, chain);
}

function walkSelect(s: SelectBody, w: Walk, chain: readonly Cte[]): void {
  w.select?.(s, chain);
  for (const t of s.targets) if ("expr" in t) walkExpr(t.expr, w, chain);
  for (const f of s.from) walkFrom(f, w, chain);
  if (s.where !== undefined) walkExpr(s.where, w, chain);
  for (const g of s.groupBy) if (!("n" in g)) walkExpr(g, w, chain);
  if (s.having !== undefined) walkExpr(s.having, w, chain);
  for (const win of s.windows) walkSpec(win.spec, w, chain);
  if (typeof s.distinct === "object") for (const e of s.distinct.on) walkExpr(e, w, chain);
}

/** A FROM item and everything under it. */
export function walkFrom(f: FromItem, w: Walk, chain: readonly Cte[] = []): void {
  w.from?.(f);
  switch (f.k) {
    case "table":
      return;
    case "sub":
      walkQuery(f.query, w, chain);
      return;
    case "join":
      walkFrom(f.left, w, chain);
      walkFrom(f.right, w, chain);
      if (f.on !== undefined) walkExpr(f.on, w, chain);
  }
}

/** An expression and everything under it. */
export function walkExpr(e: Expr, w: Walk, chain: readonly Cte[] = []): void {
  w.expr?.(e);
  for (const c of children(e)) walkExpr(c, w, chain);
  if (e.k === "sublink") walkQuery(e.query, w, chain);
}
