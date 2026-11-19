// Random statements for the `sql` front end (./sql.prop.test.ts): a grammar over the slot `health`
// (./sql.fixture.ts) that draws the forms of S the whitelist lists, combined at random. A statement
// is built from typed pieces (number, quantity, text, boolean, date), so a clean one is accepted;
// `bad` puts one expression of the refused list (./sql-cases.fixture.ts) into a clean statement, and
// the statement then gets the outcome of that case. Parameters are written `@N@` / `@T@` and
// numbered here, with the values for `params`.

import fc from "fast-check";
import { type Case, FUNCTION_EXPR, NODE_EXPR, TYPE_EXPR } from "./sql-cases.fixture.ts";
import { EXPR_PLACES, GROUPING } from "./sql-mutate.fixture.ts";

/** What a FROM gives to write expressions over. */
interface Scope {
  readonly from: string;
  readonly num: readonly string[];
  readonly qty: readonly string[];
  readonly text: readonly string[];
  readonly bool: readonly string[];
  readonly date: readonly string[];
  /** A column that is a key to group by. */
  readonly keys: readonly string[];
}

const RUNS: Scope = {
  from: "runs r",
  num: ["r.laps", "r.pace"],
  qty: ["r.distance"],
  text: ["r.feeling"],
  bool: ["r.race"],
  date: ["r.date"],
  keys: ["r.route", "r.laps", "r.race", "r.date"],
};

const SCOPES: readonly Scope[] = [
  RUNS,
  { ...RUNS, from: "runs r JOIN shoes s ON s.row_id = r.shoe", text: ["r.feeling", "s.model"] },
  {
    ...RUNS,
    from: "runs r LEFT JOIN shoes s ON s.row_id = r.shoe",
    text: ["r.feeling", "s.model"],
  },
  { ...RUNS, from: "runs r, shoes s", text: ["r.feeling", "s.model"] },
  {
    from: "(SELECT r.laps AS x, r.pace AS y, r.feeling AS t, r.distance AS k, r.date AS d, r.race AS b FROM runs r WHERE r.laps > 0) AS q",
    num: ["q.x", "q.y"],
    qty: ["q.k"],
    text: ["q.t"],
    bool: ["q.b"],
    date: ["q.d"],
    keys: ["q.x", "q.b", "q.d"],
  },
  {
    from: "expenses e",
    num: [],
    qty: ["e.amount"],
    text: ["e.category", "e.note"],
    bool: [],
    date: ["e.date"],
    keys: ["e.category", "e.date"],
  },
];

const small = fc.integer({ min: 0, max: 50 });
const word = fc.constantFrom("a", "run", "x y", "it''s", "50%", "--", "/* c */", "é", "");
const pick = <T>(xs: readonly T[], otherwise: fc.Arbitrary<T>): fc.Arbitrary<T> =>
  xs.length === 0 ? otherwise : fc.constantFrom(...xs);

/** Typed expression arbitraries over one scope. */
function expressions(s: Scope) {
  return fc.letrec<{ num: string; qty: string; text: string; bool: string; date: string }>(
    (tie) => ({
      num: fc.oneof(
        { weight: 4, arbitrary: pick(s.num, small.map(String)) },
        { weight: 2, arbitrary: small.map(String) },
        fc
          .tuple(tie("num"), fc.constantFrom("+", "-", "*", "%"), tie("num"))
          .map(([a, o, b]) => `(${a} ${o} ${b})`),
        fc
          .tuple(tie("num"), fc.constantFrom("/"), tie("num"))
          .map(([a, o, b]) => `(CAST(${a} AS numeric(10, 2)) ${o} NULLIF(${b}, 0))`),
        tie("num").map((a) => `abs(${a})`),
        tie("num").map((a) => `COALESCE(${a}, 0)`),
        fc.tuple(tie("num"), tie("num")).map(([a, b]) => `GREATEST(${a}, ${b})`),
        fc.tuple(tie("num"), tie("num")).map(([a, b]) => `LEAST(${a}, ${b})`),
        tie("num").map((a) => `CAST(${a} AS numeric(10, 2))`),
        tie("num").map((a) => `(CAST(${a} AS numeric(10, 2)))::bigint`),
        fc
          .tuple(tie("num"), fc.constantFrom("floor", "ceil", "sign", "trunc"))
          .map(([a, f]) => `${f}(CAST(${a} AS numeric(10, 2)))`),
        tie("num").map((a) => `round(CAST(${a} AS numeric(10, 2)), 1)`),
        fc.tuple(tie("num"), small).map(([a, n]) => `mod(${a}, ${n + 1})`),
        tie("text").map((a) => `length(${a})`),
        tie("text").map((a) => `strpos(${a}, 'a')`),
        tie("date").map((a) => `EXTRACT(year FROM ${a})`),
        fc
          .tuple(tie("bool"), tie("num"), tie("num"))
          .map(([c, a, b]) => `CASE WHEN ${c} THEN ${a} ELSE ${b} END`),
        fc.tuple(tie("bool"), tie("num")).map(([c, a]) => `CASE WHEN ${c} THEN ${a} END`),
        fc.constant("(SELECT max(laps) FROM runs)"),
        fc.constant("(SELECT count(*) FROM shoes sh WHERE sh.model = 'a')"),
      ),
      qty: fc.oneof(
        pick(s.qty, small.map(String)),
        fc
          .tuple(tie("qty"), fc.constantFrom("+", "-"), tie("qty"))
          .map(([a, o, b]) => `(${a} ${o} ${b})`),
        fc.tuple(tie("qty"), tie("num")).map(([a, b]) => `(${a} * ${b})`),
        tie("qty").map((a) => `abs(${a})`),
        tie("qty").map((a) => `COALESCE(${a}, 0)`),
      ),
      text: fc.oneof(
        { weight: 3, arbitrary: pick(s.text, fc.constant("'a'")) },
        word.map((w) => `'${w}'`),
        fc.tuple(tie("text"), tie("text")).map(([a, b]) => `(${a} || ${b})`),
        tie("text").map((a) => `btrim(${a})`),
        tie("text").map((a) => `ltrim(${a})`),
        fc.tuple(tie("text"), small).map(([a, n]) => `left(${a}, ${n})`),
        fc.tuple(tie("text"), small).map(([a, n]) => `substr(${a}, 1, ${n})`),
        tie("text").map((a) => `replace(${a}, 'a', 'b')`),
        fc.tuple(tie("text"), small).map(([a, n]) => `split_part(${a}, ',', ${n + 1})`),
        fc
          .tuple(tie("bool"), tie("text"), tie("text"))
          .map(([c, a, b]) => `CASE WHEN ${c} THEN ${a} ELSE ${b} END`),
        tie("text").map((a) => `COALESCE(${a}, '')`),
      ),
      date: fc.oneof(
        pick(s.date, fc.constant("DATE '2026-01-01'")),
        fc.constant("DATE '2026-01-01'"),
        tie("date").map((a) => `date_trunc('month', (${a})::timestamp)::date`),
        fc.tuple(small).map(([n]) => `saveslot_today() - ${n}`),
        fc.tuple(tie("date"), small).map(([a, n]) => `(${a} + ${n})`),
      ),
      bool: fc.oneof(
        { weight: 3, arbitrary: pick(s.bool, fc.constant("true")) },
        fc
          .tuple(tie("num"), fc.constantFrom("=", "<>", "<", "<=", ">", ">="), tie("num"))
          .map(([a, o, b]) => `(${a} ${o} ${b})`),
        fc
          .tuple(tie("qty"), fc.constantFrom("=", "<", ">"), tie("qty"))
          .map(([a, o, b]) => `(${a} ${o} ${b})`),
        fc.tuple(tie("text"), fc.constantFrom("=", "<>")).map(([a, o]) => `(${a} ${o} @T@)`),
        fc.tuple(tie("num"), fc.constantFrom("=", "<", ">")).map(([a, o]) => `(${a} ${o} @N@)`),
        fc.tuple(tie("text"), word).map(([a, w]) => `(${a} LIKE '${w}%')`),
        fc.tuple(tie("text"), word).map(([a, w]) => `(${a} NOT LIKE '%${w}')`),
        fc.tuple(tie("date"), fc.constantFrom(">=", "<")).map(([a, o]) => `(${a} ${o} @D@)`),
        fc.tuple(tie("date"), tie("date")).map(([a, b]) => `(${a} <= ${b})`),
        fc
          .tuple(tie("bool"), fc.constantFrom("AND", "OR"), tie("bool"))
          .map(([a, o, b]) => `(${a} ${o} ${b})`),
        tie("bool").map((a) => `(NOT ${a})`),
        fc
          .tuple(tie("num"), fc.constantFrom("IS NULL", "IS NOT NULL"))
          .map(([a, t]) => `(${a} ${t})`),
        fc
          .tuple(tie("bool"), fc.constantFrom("IS TRUE", "IS NOT TRUE", "IS FALSE", "IS UNKNOWN"))
          .map(([a, t]) => `(${a} ${t})`),
        fc.tuple(tie("num"), small, small).map(([a, x, y]) => `(${a} BETWEEN ${x} AND ${x + y})`),
        fc
          .tuple(tie("num"), fc.array(small, { minLength: 1, maxLength: 5 }))
          .map(([a, xs]) => `(${a} IN (${xs.join(", ")}))`),
        tie("text").map((a) => `(${a} IN ('a', 'b', @T@))`),
        tie("num").map((a) => `(${a} IN (SELECT laps FROM runs WHERE race))`),
        fc
          .constantFrom("a", "b")
          .map((m) => `EXISTS (SELECT 1 FROM shoes sh WHERE sh.model = '${m}')`),
        fc.constant("EXISTS (SELECT 1 FROM runs rr WHERE rr.laps > 3)"),
      ),
    }),
  );
}

/** A SELECT that gives one number column, to put in a set operation. */
const numberQuery = fc.constantFrom(
  "SELECT laps FROM runs",
  "SELECT pace FROM runs WHERE race",
  "SELECT 1",
  "SELECT count(*) FROM shoes",
  "SELECT length(model) FROM shoes",
);

/** A statement of S over some scope, accepted. */
const clean: fc.Arbitrary<string> = fc.constantFrom(...SCOPES).chain((s) => {
  const e = expressions(s);
  const where = fc
    .option(e.bool, { nil: undefined, freq: 2 })
    .map((c) => (c === undefined ? "" : ` WHERE ${c}`));
  const targets = fc.array(fc.tuple(fc.oneof(e.num, e.text, e.bool, e.date, e.qty), fc.boolean()), {
    minLength: 1,
    maxLength: 4,
  });
  const order = fc.constantFrom("", " ORDER BY 1", " ORDER BY 1 DESC", " ORDER BY 1 NULLS FIRST");
  const limit = fc.constantFrom("", " LIMIT 5", " LIMIT 5 OFFSET 2", " LIMIT @N@");
  const from = s.from;
  const select = (allNamed: boolean) =>
    fc
      .tuple(fc.boolean(), targets, where, order, limit)
      .map(
        ([distinct, ts, w, o, l]) =>
          `SELECT ${distinct ? "DISTINCT " : ""}${ts.map(([t, named], i) => (named || allNamed ? `${t} AS c${i}` : t)).join(", ")} FROM ${from}${w}${o}${l}`,
      );
  const plain = select(false);
  const grouped = fc
    .tuple(
      pick(s.keys, fc.constant("r.route")),
      fc.constantFrom("count(*)", "count(DISTINCT 1)", "min(1)"),
      fc.boolean(),
      fc.constantFrom(...(s.num.length > 0 ? s.num : ["1"])),
      where,
    )
    .map(
      ([k, a, having, n, w]) =>
        `SELECT ${k}, ${a}, sum(${n}) AS total, max(${n}) FROM ${from}${w} GROUP BY ${k}${having ? ` HAVING count(*) > 1` : ""} ORDER BY ${k}`,
    );
  const windowed = fc
    .tuple(
      fc.constantFrom(...(s.num.length > 0 ? s.num : ["1"])),
      pick(s.keys, fc.constant("r.route")),
      where,
    )
    .chain(([n, k, w]) =>
      fc
        .constantFrom(
          `rank() OVER (PARTITION BY ${k} ORDER BY ${n})`,
          `dense_rank() OVER (ORDER BY ${n} DESC)`,
          `row_number() OVER (ORDER BY ${n}, ${k})`,
          `lag(${n}) OVER (ORDER BY ${n})`,
          `lead(${n}, 1, 0) OVER (PARTITION BY ${k} ORDER BY ${n})`,
          `first_value(${n}) OVER (ORDER BY ${n})`,
          `sum(${n}) OVER (ORDER BY ${n} ROWS BETWEEN 2 PRECEDING AND CURRENT ROW)`,
          `avg(${n}) OVER (PARTITION BY ${k})`,
          `count(*) OVER ()`,
          `max(${n}) OVER w`,
        )
        .map(
          (f) =>
            `SELECT ${n}, ${f} FROM ${from}${w}${f.endsWith("OVER w") ? ` WINDOW w AS (ORDER BY ${n})` : ""}`,
        ),
    );
  const scalar = small.map((n) => `SELECT (SELECT max(laps) FROM runs) + ${n}`);
  const sub = fc
    .tuple(select(true), fc.boolean())
    .map(([q, cte]) =>
      cte
        ? `WITH c AS (${q.replace(/ ORDER BY .*$/, "")}) SELECT * FROM c`
        : `SELECT * FROM (${q.replace(/ ORDER BY .*$/, "")}) AS z`,
    );
  const setop = fc
    .tuple(numberQuery, fc.constantFrom("UNION", "UNION ALL", "INTERSECT", "EXCEPT"), numberQuery)
    .map(([a, o, b]) => `${a} ${o} ${b}`);
  return fc.oneof(
    { weight: 5, arbitrary: plain },
    { weight: 2, arbitrary: grouped },
    { weight: 2, arbitrary: windowed },
    scalar,
    sub,
    setop,
  );
});

export interface Generated {
  readonly sql: string;
  readonly params: readonly unknown[];
  /** The outcome it must get, or `ok`. */
  readonly want: string;
  /** The case put in, when one was. */
  readonly bad?: string;
}

/** Numbers the `@N@`, `@T@` and `@D@` marks as `$1…` and gives the values. */
export function bind(sql: string): { sql: string; params: unknown[] } {
  const params: unknown[] = [];
  const out = sql.replace(/@([NTD])@/g, (_m, k: string) => {
    params.push(k === "N" ? 3 : k === "T" ? "a" : "2026-01-01");
    return `$${params.length}`;
  });
  return { sql: out, params };
}

const BAD: readonly Case[] = [...NODE_EXPR, ...FUNCTION_EXPR, ...TYPE_EXPR].filter(
  (c) =>
    c.where === "expr" && c.params === undefined && !c.sql.includes("$") && !GROUPING.test(c.sql),
);

/** A clean statement. */
export const cleanStatement: fc.Arbitrary<Generated> = clean.map((q) => {
  const b = bind(q);
  return { sql: b.sql, params: b.params, want: "ok" };
});

/**
 * A clean statement with one refused expression put in: into one of the places of
 * ./sql-mutate.fixture.ts (a statement of its own), or as a CTE ahead of a random clean statement.
 */
export const refusedStatement: fc.Arbitrary<Generated> = fc
  .tuple(fc.constantFrom(...BAD), fc.nat(), clean, fc.boolean())
  .map(([c, n, q, wrap]) => {
    const e = wrap ? `(${c.sql})` : c.sql;
    if (n % 3 === 0) {
      const p = EXPR_PLACES[Math.floor(n / 3) % EXPR_PLACES.length] as (typeof EXPR_PLACES)[number];
      return { sql: p.put(e), params: [], want: c.want, bad: c.sql };
    }
    const prefix = `bad AS (SELECT ${e} FROM runs)`;
    const b = bind(q);
    const sql = b.sql.startsWith("WITH ")
      ? `WITH ${prefix}, ${b.sql.slice(5)}`
      : `WITH ${prefix} ${b.sql}`;
    return { sql, params: b.params, want: c.want, bad: c.sql };
  });

/** Bits to build text out of, for statements that are mostly not statements. */
export const TOKENS: readonly string[] = [
  "SELECT",
  "FROM",
  "WHERE",
  "GROUP",
  "BY",
  "HAVING",
  "ORDER",
  "LIMIT",
  "OFFSET",
  "UNION",
  "ALL",
  "DISTINCT",
  "ON",
  "JOIN",
  "LEFT",
  "AS",
  "WITH",
  "OVER",
  "PARTITION",
  "WINDOW",
  "CASE",
  "WHEN",
  "THEN",
  "ELSE",
  "END",
  "AND",
  "OR",
  "NOT",
  "IN",
  "IS",
  "NULL",
  "EXISTS",
  "BETWEEN",
  "LIKE",
  "FOR",
  "VALID_TIME",
  "SYSTEM_TIME",
  "runs",
  "shoes",
  "laps",
  "pace",
  "feeling",
  "date",
  "r",
  "s",
  "x",
  "pg_class",
  "*",
  ",",
  "(",
  ")",
  ";",
  "--",
  "/*",
  "*/",
  "'",
  '"',
  "$1",
  "$0",
  "1",
  "1.5",
  "'a'",
  "=",
  "<",
  ">",
  "+",
  "-",
  "||",
  "::",
  "numeric",
  "now()",
  "count(*)",
  "lower(",
  "\n",
  "\t",
  "\\",
  "é",
  "\u{1F600}",
  "INSERT",
  "DELETE",
  "COPY",
  "SET",
  "RECURSIVE",
];
