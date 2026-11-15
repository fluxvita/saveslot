// Business time conditions as SQL (docs/zh-CN/spec/02-architecture.md §4 `time`: rewriting
// `valid_at` / `valid_during` into predicates; 03-data-model/05-time.md «查询»). Intervals are
// left-closed and right-open; an interval's end column is NULL when it runs on. The arguments are
// SQL expressions the caller builds from its own column names and parameter placeholders.

/** The interval `[from, to)` contains the point `p`. */
export const containsPoint = (from: string, to: string, p: string): string =>
  `(${from} <= ${p} AND (${to} IS NULL OR ${p} < ${to}))`;

/** The point column `col` lies in `[a, b)`; `b` null: `[a, ∞)`. */
export const pointWithin = (col: string, a: string, b: string | null): string =>
  `(${col} >= ${a}${b === null ? "" : ` AND ${col} < ${b}`})`;
