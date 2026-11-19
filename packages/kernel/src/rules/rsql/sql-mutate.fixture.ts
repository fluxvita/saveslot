// Variations of a query that must not change what is said of it (11 «怎么测», experiment 2: "对每条做
// 变形（大小写、引号、注释、放进子查询、`CASE`、CTE）"). Spelling variations rewrite the tokens the
// scanner finds, so strings and comments are left as they are; placements put an expression or a
// SELECT inside another construct.

import { rsqlParser } from "./load.ts";
import type { Case } from "./sql-cases.fixture.ts";
import { inRuns } from "./sql-cases.fixture.ts";

type Token = ReturnType<ReturnType<typeof rsqlParser>["scan"]>["tokens"][number];

const bytes = (s: string) => new TextEncoder().encode(s);
const slice = (src: Uint8Array, a: number, b: number) =>
  new TextDecoder().decode(src.subarray(a, b));

/** The tokens of a text, or none when the scanner refuses it (the text is then left as it is). */
function tokens(sql: string): Token[] | undefined {
  try {
    return rsqlParser().scan(sql).tokens;
  } catch {
    return undefined;
  }
}

/** The text with each token (comments dropped) passed through `f`, and `sep` between them. */
function rewrite(
  sql: string,
  f: (t: Token, text: string, i: number) => string,
  sep: (i: number) => string,
): string {
  const src = bytes(sql);
  const all = tokens(sql);
  if (all === undefined) return sql;
  const ts = all.filter((t) => t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT");
  // No comment after NOT or NULLS: libpg_query reads `NOT /* c */ LIKE` and `NULLS /* c */ LAST` as
  // syntax errors (the grammar's one-token lookahead, which does not skip comments).
  return ts
    .map((t, i) => {
      const gap = i === 0 ? "" : LOOKAHEAD.has(ts[i - 1]?.text.toUpperCase() ?? "") ? " " : sep(i);
      return `${gap}${f(t, slice(src, t.start, t.end), i)}`;
    })
    .join("");
}

const LOOKAHEAD = new Set(["NOT", "NULLS"]);
const IDENT = /^[a-z_][a-z0-9_$]*$/;
const isWord = (t: Token): boolean =>
  t.tokenName === "IDENT" ||
  (t.keywordKind !== undefined && t.keywordKind > 0) ||
  /^[A-Za-z_]+$/.test(t.text);

export interface Mutation {
  readonly name: string;
  readonly apply: (sql: string) => string;
}

/** Spelling variations. They keep every token and its order. */
export const SPELLINGS: readonly Mutation[] = [
  {
    name: "upper case",
    apply: (s) =>
      rewrite(
        s,
        (t, x) =>
          isWord(t) && t.tokenName !== "SCONST" && !x.startsWith('"') ? x.toUpperCase() : x,
        () => " ",
      ),
  },
  {
    name: "lower case",
    apply: (s) =>
      rewrite(
        s,
        (t, x) =>
          isWord(t) && t.tokenName !== "SCONST" && !x.startsWith('"') ? x.toLowerCase() : x,
        () => " ",
      ),
  },
  {
    name: "alternating case",
    apply: (s) =>
      rewrite(
        s,
        (t, x, i) =>
          isWord(t) && t.tokenName !== "SCONST" && !x.startsWith('"') && !x.startsWith("$")
            ? [...x]
                .map((ch, j) => ((i + j) % 2 === 0 ? ch.toUpperCase() : ch.toLowerCase()))
                .join("")
            : x,
        () => " ",
      ),
  },
  {
    name: "quoted names",
    apply: (s) =>
      rewrite(
        s,
        (t, x) => (t.tokenName === "IDENT" && IDENT.test(x) ? `"${x}"` : x),
        () => " ",
      ),
  },
  {
    name: "block comments",
    apply: (s) =>
      rewrite(
        s,
        (_t, x) => x,
        () => " /* c ; */ ",
      ),
  },
  {
    name: "line comments",
    apply: (s) =>
      rewrite(
        s,
        (_t, x) => x,
        () => " -- c ;\n",
      ),
  },
  {
    name: "line breaks",
    apply: (s) =>
      rewrite(
        s,
        (_t, x) => x,
        () => "\n",
      ),
  },
  {
    name: "tabs and spaces",
    apply: (s) =>
      rewrite(
        s,
        (_t, x) => x,
        (i) => (i % 2 === 0 ? "\t" : "   "),
      ),
  },
  { name: "comments around", apply: (s) => `/* a */ ${s}\n-- b` },
];

export interface Placement {
  readonly name: string;
  /** The query that holds `sql` (an expression or a SELECT, by `where`). */
  readonly put: (sql: string) => string;
}

/** Places for an expression. */
export const EXPR_PLACES: readonly Placement[] = [
  { name: "in a subquery", put: (e) => `SELECT * FROM (SELECT ${e} AS v FROM runs) AS q` },
  { name: "in a CASE", put: (e) => `SELECT CASE WHEN true THEN ${e} END FROM runs` },
  {
    name: "in a CASE condition",
    put: (e) => `SELECT 1 FROM runs WHERE CASE WHEN ${e} THEN true ELSE false END`,
  },
  { name: "in a CTE", put: (e) => `WITH c AS (SELECT ${e} AS v FROM runs) SELECT v FROM c` },
  { name: "in a scalar subquery", put: (e) => `SELECT (SELECT ${e} FROM runs) FROM shoes` },
  { name: "in a WHERE", put: (e) => `SELECT 1 FROM runs WHERE (${e}) IS NULL` },
  {
    name: "in a join condition",
    put: (e) => `SELECT 1 FROM runs a JOIN shoes b ON (${e}) IS NULL`,
  },
  { name: "in a set operation", put: (e) => `SELECT 1 UNION SELECT ${e} FROM runs` },
];

/** Places for a whole SELECT. */
export const SELECT_PLACES: readonly Placement[] = [
  { name: "in a subquery", put: (q) => `SELECT * FROM (${q}) AS q` },
  { name: "in a CTE", put: (q) => `WITH c AS (${q}) SELECT 1` },
  { name: "in EXISTS", put: (q) => `SELECT 1 WHERE EXISTS (${q})` },
  { name: "in a set operation", put: (q) => `(${q}) UNION ALL (${q})` },
];

/** An aggregate or a window function: not allowed where a condition is. */
export const GROUPING =
  /\b(sum|count|min|max|avg|bool_and|bool_or|string_agg|array_agg|json_agg|stddev|variance|regr_slope|mode|percentile_cont|ntile|percent_rank|cume_dist|nth_value)\s*\(|\bOVER\b|GROUPING\(/i;
export const CONDITION_PLACES = new Set([
  "in a WHERE",
  "in a join condition",
  "in a CASE condition",
]);

/** Every variation of a case with the outcome it must still get: the text and a name for failures. */
export function variations(c: Case): { name: string; sql: string }[] {
  const base = c.where === "expr" ? inRuns(c.sql) : c.sql;
  const out: { name: string; sql: string }[] = [];
  for (const m of SPELLINGS) out.push({ name: m.name, sql: m.apply(base) });
  if (c.where === "expr") {
    for (const p of EXPR_PLACES) {
      // An aggregate in a condition is refused as such, whatever else is wrong with it.
      if (CONDITION_PLACES.has(p.name) && GROUPING.test(c.sql)) continue;
      out.push({ name: p.name, sql: p.put(c.sql) });
      // And spelled differently inside.
      out.push({
        name: `${p.name}, in upper case`,
        sql: SPELLINGS[0]?.apply(p.put(c.sql)) as string,
      });
    }
  } else if (c.where === "select") {
    for (const p of SELECT_PLACES) out.push({ name: p.name, sql: p.put(c.sql) });
  }
  return out;
}
