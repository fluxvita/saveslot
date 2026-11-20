// The structural fingerprint of a `sql` query for the read record (03-data-model/04-write-and-read.md
// «读取记录里记什么形状»): the bound tree (11-restricted-sql.md «处理步骤» 9) printed with IDs for
// names and placeholders for values, so that the text holds nothing the caller wrote.
//
// - a slot, table and field is its ID; a system column its fixed name; an output column of a
//   subquery or a CTE its position;
// - every constant, `$n`, number of an IN list's items, operand of a time clause and frame offset is
//   a placeholder `$1, $2 …` numbered in the order printed; an IN list is one placeholder. A
//   position in ORDER BY, GROUP BY or DISTINCT ON is no value and stays;
// - the callers' output column names and window names are not in it: an output column has no AS, a
//   window is `w1, w2 …` by first appearance. The aliases of FROM items and CTEs are the analysis's
//   own ordinals (`t1`, `c1`);
// - what the reading depends on and a caller can vary stays: which tables, the shape of the
//   conditions, the kind of a time clause (as of, or during).

import type { TimeClause, TimeOperand } from "./ir.ts";
import type { SqlAnalysis } from "./sql-analyze.ts";
import { type PrintHooks, printQuery, quoteIdent } from "./sql-print.ts";

export function fingerprintOf(analysis: SqlAnalysis): string {
  let k = 0;
  const holder = (): string => `$${++k}`;
  const windows = new Map<string, string>();
  const operands = (c: TimeClause): string => {
    const one = (_: TimeOperand): string => holder();
    return c.k === "as_of"
      ? ` FOR VALID_TIME AS OF ${one(c.at)}`
      : ` FOR VALID_TIME FROM ${one(c.from)} TO ${one(c.to)}`;
  };
  const hooks: PrintHooks = {
    table: (f) => {
      const alias = f.alias === undefined ? "" : ` AS ${quoteIdent(f.alias)}`;
      const rt = analysis.tables.get(f);
      if (rt === undefined) return `${quoteIdent(f.table)}${alias}`;
      return `${quoteIdent(rt.slot)}.${quoteIdent(rt.table)}${f.time !== undefined ? operands(f.time) : ""}${alias}`;
    },
    col: (e) => {
      const r = analysis.resolved.get(e);
      if (r === undefined) throw new Error("a column that binds to nothing has no fingerprint");
      switch (r.kind) {
        case "field":
          return `${quoteIdent(`t${r.source}`)}.${quoteIdent(r.field)}`;
        case "system":
          return `${quoteIdent(`t${r.source}`)}.${quoteIdent(r.name)}`;
        case "out":
          return `${quoteIdent(`t${r.source}`)}.${quoteIdent(`o${r.index + 1}`)}`;
        case "using":
          throw new Error("a merged column is printed as the column it is");
      }
    },
    konst: () => holder(),
    outName: () => undefined,
    windowName: (n) => {
      let w = windows.get(n);
      if (w === undefined) {
        w = `w${windows.size + 1}`;
        windows.set(n, w);
      }
      return quoteIdent(w);
    },
    frameOffset: () => holder(),
    foldIn: () => holder(),
  };
  return printQuery(analysis.query, hooks);
}
