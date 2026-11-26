// Queries `sql` must accept: every legal query of the spec and the guide that is meant for `sql`
// (docs/zh-CN: 11-restricted-sql.md, 04-contract-types.md `sql`, guide 06 and 07, the rule
// examples of 06-cli.md, 07-schema-evolution.md and 09-schema.md, which a query may be too), and one
// for each form the whitelist lists for S. `columns` is the result as `name:type[:unit]`.

export interface Positive {
  readonly name: string;
  readonly sql: string;
  readonly params?: readonly unknown[];
  readonly columns?: string;
  /** The query needs the second slot, `ledger`, too. */
  readonly ledger?: true;
  /** Where the query comes from, when it is the documents'. */
  readonly source?: string;
}

const spec = (
  source: string,
  name: string,
  sql: string,
  columns?: string,
  params?: unknown[],
): Positive => ({
  name,
  sql,
  source,
  ...(columns !== undefined ? { columns } : {}),
  ...(params !== undefined ? { params } : {}),
});

/** The documents' queries. */
export const DOCUMENTED: readonly Positive[] = [
  spec(
    "11 «时间»",
    "state table as of today",
    "SELECT b.category, b.amount\nFROM budgets FOR VALID_TIME AS OF saveslot_today() AS b",
    "category:text,amount:quantity:CNY",
  ),
  spec(
    "11 «时间»",
    "as of a day, thirty days back",
    "SELECT b.category FROM budgets FOR VALID_TIME AS OF saveslot_today() - 30 AS b",
    "category:text",
  ),
  spec(
    "04-contract-types sql",
    "total by category since a date",
    "SELECT category, sum(amount) AS total FROM expenses WHERE date >= $1 GROUP BY 1 ORDER BY 2 DESC",
    "category:text,total:quantity:CNY",
    ["2026-11-01"],
  ),
  spec(
    "guide 06",
    "sum by name",
    "SELECT category, SUM(amount) FROM expenses GROUP BY category",
    "category:text,sum:quantity:CNY",
  ),
  spec("11 «语句形状»", "no FROM", "SELECT saveslot_today()", "saveslot_today:date"),
  spec("11 «时间»", "now", "SELECT saveslot_now()", "saveslot_now:unknown"),
  spec(
    "11 «类型»",
    "ref joined by row ID",
    "SELECT r.laps FROM runs r JOIN shoes s ON s.row_id = r.shoe",
    "laps:integer",
  ),
  spec(
    "09-bitemporal R5",
    "event joined to state table",
    "SELECT e.category, b.amount FROM expenses e JOIN budgets b ON b.category = e.category",
    "category:text,amount:quantity:CNY",
  ),
  spec(
    "guide 07 时间",
    "remaining budget this month",
    `SELECT b.category,
       b.amount - COALESCE(SUM(e.amount), 0) AS remaining
FROM budgets FOR VALID_TIME AS OF saveslot_today() AS b
LEFT JOIN expenses AS e
  ON e.category = b.category
 AND e.date >= date_trunc('month', saveslot_today()::timestamp)::date
 AND e.date <= saveslot_today()
GROUP BY b.category, b.amount`,
    "category:text,remaining:quantity:CNY",
  ),
  spec(
    "06-cli, 07-schema-evolution",
    "weekly totals",
    "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM runs GROUP BY 1",
    "week_start:date,total_distance:quantity:km,run_count:integer,days_recorded:integer,first_date:date,last_date:date",
  ),
  spec(
    "06-cli, 09-schema",
    "monthly totals",
    "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
    "month:date,total:quantity:CNY,days_recorded:integer,first_date:date,last_date:date",
  ),
  spec(
    "11 «类型»",
    "a sum that may be empty",
    "SELECT COALESCE(SUM(amount), 0) AS spent FROM expenses",
    "spent:quantity:CNY",
  ),
];

/** One query for each form of the whitelist for S that the documented ones do not use. */
export const FORMS: readonly Positive[] = [
  { name: "star", sql: "SELECT * FROM shoes", columns: "model:text" },
  { name: "qualified star", sql: "SELECT s.* FROM shoes AS s", columns: "model:text" },
  { name: "slot-qualified star", sql: "SELECT shoes.* FROM health.shoes", columns: "model:text" },
  { name: "star over a join", sql: "SELECT * FROM shoes a JOIN shoes b ON a.row_id = b.row_id" },
  { name: "a trailing semicolon", sql: "SELECT 1;", columns: "?column?:integer" },
  { name: "TABLE", sql: "TABLE shoes", columns: "model:text" },
  { name: "inner join", sql: "SELECT 1 FROM shoes a INNER JOIN shoes b ON a.model = b.model" },
  { name: "left join", sql: "SELECT 1 FROM shoes a LEFT JOIN shoes b ON a.model = b.model" },
  { name: "right join", sql: "SELECT 1 FROM shoes a RIGHT JOIN shoes b ON a.model = b.model" },
  { name: "full join", sql: "SELECT 1 FROM shoes a FULL JOIN shoes b ON a.model = b.model" },
  { name: "cross join", sql: "SELECT 1 FROM shoes a CROSS JOIN shoes b" },
  {
    name: "join using",
    sql: "SELECT model FROM shoes a JOIN shoes b USING (model)",
    columns: "model:text",
  },
  {
    name: "star after using",
    sql: "SELECT * FROM shoes a JOIN shoes b USING (model)",
    columns: "model:text",
  },
  { name: "comma join", sql: "SELECT a.model FROM shoes a, shoes b WHERE a.model = b.model" },
  {
    name: "three tables",
    sql: "SELECT 1 FROM runs r JOIN shoes s ON s.row_id = r.shoe JOIN expenses e ON e.date = r.date",
  },
  {
    name: "subquery in FROM",
    sql: "SELECT t.n FROM (SELECT count(*) AS n FROM runs) AS t",
    columns: "n:integer",
  },
  {
    name: "subquery in FROM without an alias",
    sql: "SELECT n FROM (SELECT count(*) AS n FROM runs)",
    columns: "n:integer",
  },
  {
    name: "column alias list",
    sql: "SELECT x, y FROM (SELECT 1, 'a') AS t (x, y)",
    columns: "x:integer,y:text",
  },
  { name: "column alias list on a table", sql: "SELECT a FROM shoes AS s (a)", columns: "a:text" },
  {
    name: "scalar subquery",
    sql: "SELECT (SELECT max(laps) FROM runs) AS m",
    columns: "m:integer",
  },
  {
    name: "correlated scalar subquery",
    sql: "SELECT r.date, (SELECT count(*) FROM expenses e WHERE e.date = r.date) AS n FROM runs r",
    columns: "date:date,n:integer",
  },
  {
    name: "EXISTS",
    sql: "SELECT 1 FROM runs r WHERE EXISTS (SELECT 1 FROM expenses e WHERE e.date = r.date)",
  },
  {
    name: "NOT EXISTS",
    sql: "SELECT 1 FROM runs r WHERE NOT EXISTS (SELECT 1 FROM expenses e WHERE e.date = r.date)",
  },
  { name: "IN subquery", sql: "SELECT 1 FROM runs WHERE date IN (SELECT date FROM expenses)" },
  {
    name: "NOT IN subquery",
    sql: "SELECT 1 FROM runs WHERE date NOT IN (SELECT date FROM expenses)",
  },
  { name: "subqueries four deep", sql: "SELECT (SELECT (SELECT (SELECT (SELECT 1))))" },
  {
    name: "WITH",
    sql: "WITH c AS (SELECT date, distance FROM runs) SELECT date FROM c",
    columns: "date:date",
  },
  {
    name: "WITH with column names",
    sql: "WITH c (d, k) AS (SELECT date, distance FROM runs) SELECT k FROM c",
    columns: "k:quantity:km",
  },
  {
    name: "WITH, two",
    sql: "WITH a AS (SELECT 1 AS x), b AS (SELECT x FROM a) SELECT x FROM b",
    columns: "x:integer",
  },
  {
    name: "a CTE hides a table",
    sql: "WITH runs AS (SELECT 1 AS x) SELECT x FROM runs",
    columns: "x:integer",
  },
  {
    name: "UNION",
    sql: "SELECT date FROM runs UNION SELECT date FROM expenses",
    columns: "date:date",
  },
  { name: "UNION ALL", sql: "SELECT date FROM runs UNION ALL SELECT date FROM expenses" },
  { name: "INTERSECT", sql: "SELECT date FROM runs INTERSECT SELECT date FROM expenses" },
  { name: "EXCEPT ALL", sql: "SELECT date FROM runs EXCEPT ALL SELECT date FROM expenses" },
  {
    name: "set operation with ORDER BY and LIMIT",
    sql: "SELECT date FROM runs UNION SELECT date FROM expenses ORDER BY 1 DESC LIMIT 3",
  },
  {
    name: "set operation, ordered by name",
    sql: "SELECT date AS d FROM runs UNION SELECT date FROM expenses ORDER BY d",
  },
  {
    name: "parenthesized set operation sides",
    sql: "(SELECT date FROM runs ORDER BY 1 LIMIT 1) UNION (SELECT date FROM expenses)",
  },
  {
    name: "set operation of numbers",
    sql: "SELECT 1 UNION SELECT 2.5",
    columns: "?column?:decimal",
  },
  { name: "DISTINCT", sql: "SELECT DISTINCT route FROM runs", columns: "route:enum" },
  {
    name: "DISTINCT ON",
    sql: "SELECT DISTINCT ON (route) route, date FROM runs ORDER BY route, date DESC",
  },
  { name: "DISTINCT ON by number", sql: "SELECT DISTINCT ON (1) route, date FROM runs ORDER BY 1" },
  {
    name: "ORDER BY directions",
    sql: "SELECT laps FROM runs ORDER BY laps ASC NULLS LAST, date DESC NULLS FIRST",
  },
  { name: "ORDER BY an output name", sql: "SELECT laps AS l FROM runs ORDER BY l" },
  { name: "ORDER BY an expression", sql: "SELECT laps FROM runs ORDER BY laps * 2" },
  { name: "LIMIT and OFFSET", sql: "SELECT laps FROM runs LIMIT 10 OFFSET 5" },
  {
    name: "LIMIT and OFFSET by parameter",
    sql: "SELECT laps FROM runs LIMIT $1 OFFSET $2",
    params: [10, 5],
  },
  { name: "LIMIT ALL", sql: "SELECT laps FROM runs LIMIT ALL" },
  { name: "FETCH FIRST", sql: "SELECT laps FROM runs ORDER BY laps FETCH FIRST 3 ROWS ONLY" },
  {
    name: "GROUP BY and HAVING",
    sql: "SELECT route, count(*) FROM runs GROUP BY route HAVING count(*) > 1",
  },
  { name: "GROUP BY an output name", sql: "SELECT route AS r, count(*) FROM runs GROUP BY r" },
  { name: "HAVING without GROUP BY", sql: "SELECT count(*) FROM runs HAVING count(*) > 1" },
  {
    name: "a whole aggregate",
    sql: "SELECT sum(distance), avg(pace), min(date), max(started), bool_and(race), bool_or(race) FROM runs",
    columns: "sum:quantity:km,avg:decimal,min:date,max:unknown,bool_and:boolean,bool_or:boolean",
  },
  {
    name: "FILTER",
    sql: "SELECT count(*) FILTER (WHERE race) AS races FROM runs",
    columns: "races:integer",
  },
  {
    name: "window function over a named window",
    sql: "SELECT sum(laps) OVER w FROM runs WINDOW w AS (ORDER BY date)",
    columns: "sum:integer",
  },
  {
    name: "window extending a window",
    sql: "SELECT rank() OVER (w ORDER BY date) FROM runs WINDOW w AS (PARTITION BY route)",
    columns: "rank:integer",
  },
  {
    name: "rank and dense_rank",
    sql: "SELECT rank() OVER (ORDER BY laps), dense_rank() OVER (ORDER BY laps) FROM runs",
  },
  {
    name: "row_number",
    sql: "SELECT row_number() OVER (PARTITION BY route ORDER BY date) FROM runs",
    columns: "row_number:integer",
  },
  {
    name: "lag and lead",
    sql: "SELECT lag(laps) OVER (ORDER BY date), lead(laps, 2, 0) OVER (ORDER BY date) FROM runs",
    columns: "lag:integer,lead:integer",
  },
  {
    name: "first_value and last_value",
    sql: "SELECT first_value(distance) OVER (ORDER BY date), last_value(distance) OVER (ORDER BY date) FROM runs",
    columns: "first_value:quantity:km,last_value:quantity:km",
  },
  { name: "count(*) over", sql: "SELECT count(*) OVER () FROM runs", columns: "count:integer" },
  {
    name: "window aggregates",
    sql: "SELECT avg(pace) OVER (), min(date) OVER (), max(laps) OVER () FROM runs",
  },
  {
    name: "ROWS frame",
    sql: "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN 2 PRECEDING AND CURRENT ROW) FROM runs",
  },
  {
    name: "ROWS frame without BETWEEN",
    sql: "SELECT sum(laps) OVER (ORDER BY date ROWS 2 PRECEDING) FROM runs",
  },
  {
    name: "ROWS unbounded",
    sql: "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN UNBOUNDED PRECEDING AND UNBOUNDED FOLLOWING) FROM runs",
  },
  {
    name: "ROWS following",
    sql: "SELECT sum(laps) OVER (ORDER BY date ROWS BETWEEN CURRENT ROW AND 3 FOLLOWING) FROM runs",
  },
  {
    name: "GROUPS frame",
    sql: "SELECT sum(laps) OVER (ORDER BY date GROUPS BETWEEN 1 PRECEDING AND 1 FOLLOWING) FROM runs",
  },
  {
    name: "RANGE frame over a date",
    sql: "SELECT sum(laps) OVER (ORDER BY date RANGE BETWEEN INTERVAL '6 days' PRECEDING AND CURRENT ROW) FROM runs",
  },
  {
    name: "RANGE frame over a date, in weeks",
    sql: "SELECT sum(laps) OVER (ORDER BY date RANGE BETWEEN INTERVAL '2 weeks' PRECEDING AND INTERVAL '1 day' FOLLOWING) FROM runs",
  },
  {
    name: "RANGE frame over a number",
    sql: "SELECT sum(laps) OVER (ORDER BY laps RANGE BETWEEN 2 PRECEDING AND 1.5 FOLLOWING) FROM runs",
  },
  {
    name: "RANGE frame without offsets",
    sql: "SELECT sum(laps) OVER (ORDER BY laps RANGE BETWEEN UNBOUNDED PRECEDING AND CURRENT ROW) FROM runs",
  },
  {
    name: "four windows",
    sql: "SELECT sum(laps) OVER (ORDER BY date), sum(laps) OVER (ORDER BY laps), sum(laps) OVER (PARTITION BY route), sum(laps) OVER w FROM runs WINDOW w AS (ORDER BY pace)",
  },
  {
    name: "a parameter as text",
    sql: "SELECT feeling FROM runs WHERE feeling = $1",
    params: ["x"],
  },
  {
    name: "a parameter beside a quantity",
    sql: "SELECT 1 FROM runs WHERE distance > $1",
    params: ["5.5"],
  },
  {
    name: "a parameter in arithmetic",
    sql: "SELECT distance * $1 AS d FROM runs",
    params: ["2"],
    columns: "d:quantity:km",
  },
  {
    name: "parameters in IN and BETWEEN",
    sql: "SELECT 1 FROM runs WHERE laps IN ($1, $2) AND date BETWEEN $3 AND $4",
    params: [1, 2, "2026-01-01", "2026-02-01"],
  },
  {
    name: "a parameter in COALESCE and CASE",
    sql: "SELECT COALESCE(laps, $1), CASE WHEN race THEN $2 ELSE 0 END FROM runs",
    params: [0, 1],
  },
  {
    name: "a parameter in LIKE and ||",
    sql: "SELECT 1 FROM runs WHERE feeling LIKE 'a%' AND feeling = 'x' || $1",
    params: ["y"],
  },
  { name: "a parameter as a boolean", sql: "SELECT 1 FROM runs WHERE race = $1", params: [true] },
  {
    name: "a parameter used twice",
    sql: "SELECT 1 FROM runs WHERE laps > $1 OR laps < $1",
    params: [3],
  },
  {
    name: "a parameter cast to a date",
    sql: "SELECT $1::date AS d",
    params: ["2026-01-01"],
    columns: "d:date",
  },
  {
    name: "a parameter in a time clause",
    sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF $1",
    params: ["2026-01-01"],
  },
  {
    name: "a parameter in a time clause, plus days",
    sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF $1 + 7",
    params: ["2026-01-01"],
  },
  {
    name: "a time range with parameters",
    sql: "SELECT amount FROM budgets FOR VALID_TIME FROM $1 TO $2",
    params: ["2026-01-01", "2026-02-01"],
  },
  {
    name: "a time range",
    sql: "SELECT amount FROM budgets FOR VALID_TIME FROM '2026-01-01' TO saveslot_today()",
  },
  {
    name: "a time instant on a table by day",
    sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF '2026-01-01T10:00:00+08:00'",
  },
  {
    name: "saveslot_now on a table by day",
    sql: "SELECT amount FROM budgets FOR VALID_TIME AS OF saveslot_now()",
  },
  {
    name: "a state table by instant",
    sql: "SELECT guest FROM rooms FOR VALID_TIME AS OF saveslot_now()",
  },
  {
    name: "a state table by instant, an instant",
    sql: "SELECT guest FROM rooms FOR VALID_TIME AS OF '2026-01-01T10:00:00Z'",
  },
  {
    name: "a state table by instant, parameters",
    sql: "SELECT guest FROM rooms FOR VALID_TIME FROM $1 TO $2",
    params: ["2026-01-01T00:00:00Z", "2026-01-02T00:00:00Z"],
  },
  {
    name: "time clause with a slot name and an alias",
    sql: "SELECT b.amount FROM health.budgets FOR VALID_TIME AS OF saveslot_today() AS b",
  },
  {
    name: "time clause across lines",
    sql: "SELECT amount FROM budgets\nFOR\nVALID_TIME\nAS OF saveslot_today()",
  },
  {
    name: "time clause in lower case",
    sql: "select amount from budgets for valid_time as of saveslot_today()",
  },
  { name: "a state table with no clause", sql: "SELECT amount FROM budgets" },
  {
    name: "state table system columns",
    sql: "SELECT entity_id, valid_from, valid_to FROM budgets",
    columns: "entity_id:text,valid_from:date,valid_to:date",
  },
  {
    name: "instant state table system columns",
    sql: "SELECT valid_from FROM rooms",
    columns: "valid_from:unknown",
  },
  { name: "row_id", sql: "SELECT row_id FROM runs", columns: "row_id:text" },
  { name: "row_id of a timeless table", sql: "SELECT row_id FROM shoes", columns: "row_id:text" },
  {
    name: "saveslot_date",
    sql: "SELECT saveslot_date(started) AS day FROM runs",
    columns: "day:date",
  },
  { name: "make_date", sql: "SELECT make_date(2026, 11, 1) AS d", columns: "d:date" },
  {
    name: "a derived table",
    sql: "SELECT week, km FROM weekly",
    columns: "week:date,km:quantity:km",
  },
  {
    name: "a derived table joined",
    sql: "SELECT w.km, r.laps FROM weekly w JOIN runs r ON w.week = r.date",
  },
  { name: "slot-qualified names", sql: "SELECT health.runs.laps FROM health.runs" },
  { name: "names in other case and quoted", sql: 'SELECT "LAPS", Runs.Laps FROM HEALTH."Runs"' },
  {
    name: "a keyword as a name",
    sql: 'SELECT "user" FROM (SELECT 1 AS "user") AS t',
    columns: "user:integer",
  },
  {
    name: "casts",
    sql: "SELECT laps::numeric, pace::bigint, pace::numeric(10, 2), date::timestamp::date, DATE '2026-01-01' FROM runs",
  },
  {
    name: "operators",
    sql: "SELECT laps + 1, laps - 1, laps * 2, laps % 3, -laps, +laps, pace / 2, laps::numeric / 3, feeling || 'x' FROM runs",
  },
  {
    name: "dates",
    sql: "SELECT date + 1, date - 1, 1 + date, date - date, EXTRACT(year FROM date), EXTRACT(isodow FROM date) FROM runs",
  },
  {
    name: "comparisons",
    sql: "SELECT 1 FROM runs WHERE laps = 1 OR laps <> 2 OR laps != 3 OR laps < 4 OR laps <= 5 OR laps > 6 OR laps >= 7 OR laps IS DISTINCT FROM 8 OR laps IS NOT DISTINCT FROM 9",
  },
  {
    name: "predicates",
    sql: "SELECT 1 FROM runs WHERE laps BETWEEN 1 AND 2 AND laps NOT BETWEEN 3 AND 4 AND laps IN (1, 2) AND laps NOT IN (3) AND feeling LIKE 'a%' AND feeling NOT LIKE 'b%' ESCAPE '!' AND feeling IS NOT NULL AND race IS TRUE AND race IS NOT FALSE AND race IS NOT UNKNOWN AND NOT race",
  },
  {
    name: "CASE, COALESCE, NULLIF, GREATEST, LEAST",
    sql: "SELECT CASE route WHEN 'park' THEN 1 ELSE 2 END, CASE WHEN race THEN 1 END, COALESCE(laps, 0), NULLIF(laps, 0), GREATEST(laps, 1), LEAST(laps, 9) FROM runs",
  },
  {
    name: "functions of numbers",
    sql: "SELECT abs(laps), round(pace), round(pace, 2), trunc(pace), trunc(pace, 1), floor(pace), ceil(pace), ceiling(pace), sign(pace), mod(laps, 3), mod(pace, 2) FROM runs",
  },
  {
    name: "functions of text",
    sql: "SELECT length(feeling), char_length(feeling), substr(feeling, 1), substr(feeling, 1, 2), substring(feeling FROM 2 FOR 3), left(feeling, 2), right(feeling, 2), strpos(feeling, 'a'), position('a' IN feeling), starts_with(feeling, 'a'), btrim(feeling), ltrim(feeling, 'x'), rtrim(feeling), trim(feeling), replace(feeling, 'a', 'b'), split_part(feeling, ',', 2) FROM runs",
  },
  {
    name: "date_trunc",
    sql: "SELECT date_trunc('day', date::timestamp)::date, date_trunc('week', date::timestamp)::date, date_trunc('month', date::timestamp)::date, date_trunc('quarter', date::timestamp)::date, date_trunc('year', date::timestamp)::date FROM runs",
  },
  {
    name: "count of everything",
    sql: "SELECT count(*), count(laps), count(DISTINCT shoe), count(feeling) FROM runs",
    columns: "count:integer,count:integer,count:integer,count:integer",
  },
  {
    name: "units kept",
    sql: "SELECT distance * 2 AS twice, distance / 2 AS half, distance + distance AS sum2, -distance AS neg, abs(distance) AS a, round(distance, 1) AS r, distance / distance AS ratio FROM runs",
    columns:
      "twice:quantity:km,half:quantity:km,sum2:quantity:km,neg:quantity:km,a:quantity:km,r:quantity:km,ratio:quantity:1",
  },
  {
    name: "a product of quantities",
    sql: "SELECT distance * duration AS x FROM runs",
    columns: "x:decimal",
  },
  {
    name: "text, enum, ref and boolean columns",
    sql: "SELECT feeling, route, shoe, race, min(route) AS m FROM runs GROUP BY feeling, route, shoe, race",
    columns: "feeling:text,route:enum,shoe:ref,race:boolean,m:enum",
  },
  {
    name: "NULL where another side types it",
    sql: "SELECT laps + NULL, COALESCE(NULL, laps), laps = NULL, CASE WHEN race THEN laps ELSE NULL END FROM runs WHERE NULL AND NOT NULL AND NULL IS NULL",
  },
  { name: "NULL as a column", sql: "SELECT NULL AS n", columns: "n:unknown" },
  {
    name: "a string literal as a column",
    sql: "SELECT 'a' AS s, 1.5 AS d, TRUE AS b, 3 AS i",
    columns: "s:text,d:decimal,b:boolean,i:integer",
  },
  { name: "comments and line breaks", sql: "SELECT /* c */ laps -- c\nFROM runs\n-- c" },
  {
    name: "two slots",
    sql: "SELECT r.laps, l.amount FROM health.runs r JOIN ledger.expenses l ON l.date = r.date",
    ledger: true,
  },
  {
    name: "slots by qualified name, ambiguous bare name avoided",
    sql: "SELECT h.amount, l.amount FROM health.expenses h, ledger.expenses l",
    ledger: true,
  },
  {
    name: "a table only one slot has",
    sql: "SELECT owner FROM accounts",
    columns: "owner:text",
    ledger: true,
  },
  {
    name: "a bare name in one slot only, the other slot's table of another name",
    sql: "SELECT laps FROM runs",
    ledger: true,
  },
];

export const POSITIVE: readonly Positive[] = [...DOCUMENTED, ...FORMS];
