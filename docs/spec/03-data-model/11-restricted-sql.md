# saveslot · Data-layer mechanisms · 11 Restricted SQL

English · [简体中文](../../zh-CN/spec/03-data-model/11-restricted-sql.md)

> Part of the data-layer mechanisms; for the contents see [`README.md`](README.md). A section quoted in "…" may be in another file in the same directory; look it up by the contents.

## Restricted SQL

Restricted SQL is the only place in saveslot where a caller writes SQL. Three settings share one parser, one allowlist and one rewrite: the read-only query `sql`, derivation rules (L1), and the conversion expressions of a schema change (`migrate` and `backfill` in expression form).

**The allowlist is implemented as "reject everything not recognized".** Every node of the syntax tree, every operator, every function and every type conversion must be found in the tables of this document and be allowed in the current setting, otherwise the whole statement is rejected. There is no way of writing it as "list what to reject"; the "not accepted" entries in the tables of this document only explain the reasons and are not what the implementation relies on.

**Why the syntax tree alone**: safety and determinism are guaranteed in one place (kernel invariant K9). On PGlite a role can be escaped with `SET ROLE` and `statement_timeout` does not take effect, so the syntax-tree allowlist is the only line of defense there; on PostgreSQL a read-only role, a read-only transaction and `statement_timeout` act as a second line ("Findable"). Derivation rules and conversion expressions must produce the same result at replay and on both backends, and that too can only be controlled in the allowlist.

External baseline: PGlite currently bundles PostgreSQL 18; parsing uses the branch of libpg_query that corresponds to PostgreSQL 18, and the node names in this document follow its spelling.

### Three settings

| | `sql` | Derivation rule | Conversion expression |
|---|---|---|---|
| What is written | One `SELECT` | One `SELECT` whose outermost level is a grouped aggregate or an ungrouped whole-input aggregate ("Refresh scope and admission of writes") | One scalar expression, not a statement |
| When it is validated | At every call | At schema compile time; stored as text bound by ID (`rule.sql` in the event format) | At schema compile time; stored as text bound by ID (`migrate.sql`, `backfill.sql`) |
| When it is evaluated | At call time | Derived refresh (in the same transaction as the base write), computation at read time, replay, trial run at compile time | Trial run at compile time, schema switch, replay |
| What it can reference | Tables of any slot within the visible range | Base tables and derived tables of this slot | Only the name of this field in `base_version`, and constants |
| Whether the result enters replay | No | Yes: recomputed by the rule at replay | Yes: recomputed by the definition at replay |
| Parameters `$n` | Yes | No | No |
| `saveslot_now()`, `saveslot_today()` | Yes | Yes; the rule is therefore classed as depending on "today" and is computed at read time | No |
| What is reported on rejection | `sql_rejected` (subdivisions in "What is reported on rejection") | `validation_failed` (`schema`), detail codes `rule_sql_rejected` / `nondeterministic_function` / `unit_inference_failed` / `cross_slot_ref` | `validation_failed` (`schema`), detail codes `rule_sql_rejected` / `nondeterministic_function` / `migrate_failed` |

- **There is only one allowlist**, and every table below states in which settings each entry is allowed. The result of `sql` is not replayed, but it too accepts only entries whose result is deterministic: read records and impact queries are reconciled by "which versions were read", and the same query should read the same thing on both backends; the allowlist is also maintained in only one copy.
- **What is allowed only in `sql`** is the forms whose result depends on the order of rows (`LIMIT` / `OFFSET` after `ORDER BY`, `DISTINCT ON`, `row_number()`, `lag()`, `ROWS` frames, ...). On the same data they may give different results: that is acceptable as the answer to one call, but not for a derived cache.
- **Conversion expressions are the narrowest**: they are evaluated item by item, and the only input is the old value of that item ("Schema document format", "How deterministic conversions are replayed"). Tables, subqueries, aggregates, windows, parameters and instants are not accepted. What is unique to them is conversion from `text` to numbers and booleans, which can fail depending on the value: the trial run at compile time, the re-evaluation at confirmation of writes made after the trial run, and writes carrying an old `sv` during a migration can all report `migrate_failed` (see "What is reported on rejection").

### Processing steps

1. **Length check**: a text over the limit is rejected at once ("Cost").
2. **Lexical scan**: take the tokens out with the scanner of libpg_query; recognize saveslot's own time syntax `FOR VALID_TIME …`, cut it out of the text and note which table reference it follows; `FOR SYSTEM_TIME` is rejected at once. PostgreSQL's grammar has neither of these two forms, and if they were not cut out first the parser would report a syntax error. The scan runs outside comments and string literals. The JS binding used must provide three interfaces, scan, parse and deparse; this is checked at implementation time.
3. **Parse**: parse into a syntax tree. There must be exactly one statement, and it must be a `SelectStmt`. A conversion expression is wrapped as `SELECT <expression>` and parsed, and must have exactly one output item and no clause at all.
4. **Allowlist check**: walk the whole tree and check node kinds and forms, operator symbols, function names, target types of type conversions, and the limit of each item. Only the syntax tree is looked at, not the data, and no database is connected: for the same text, whether it is allowed is the same on any data, so fuzz testing can be done offline.
5. **Name resolution**: table names, field names and system columns are resolved to table IDs and field IDs ("Names"). Derivation rules and conversion expressions complete this step at compile time and store the bound text, so a later rename of a table or field does not affect them. After this step `sql` has a bound tree, in which every FROM item, every column reference and the name of every output column were generated by this step ("No name in the executed text is left for the database to resolve").
6. **Types and units**: infer the type and unit of every expression; check the signatures of functions and operators against the argument types (for the same function name some signatures are accepted and some are not, see "The allowlist"); infer the type and unit of the output columns (derived fields are back-filled from this).
7. **Rewrite**, done only inside the kernel, on the tree bound in step 5:
   - The aliases, column alias lists, `USING`, and `ORDER BY` / `GROUP BY` / `DISTINCT ON` written by output column name have already been replaced in this tree by generated aliases, explicit `AS`, equality `ON` and positional ordinals; the table aliases and CTE names written by the caller appear in no later text, and output column names and window names use the folded spelling, quoted by the printer;
   - Table IDs and field IDs are replaced by the physical table and physical columns that the current version pointer of that slot points to; every table reference is replaced by a subquery that contains only unrevoked rows and carries the time condition (logical table = the unrevoked rows in the current version);
   - Only tables within the visible range remain; when a derived table computed at read time is referenced, its rule is expanded as a subquery: the evaluation instant is the `at` of this call, `saveslot_today()` takes the time zone of the slot that owns this derived table, values are rounded to the field precision (the same as the derived rows stored in the table), and an ungrouped whole-input aggregate with no input yields no rows; the expansion counts toward the table reference limit. The read record records the base tables that the rule reads (table level), not this derived table; when the rule reads a state table, the point it reads is recorded;
   - `saveslot_now()` and `saveslot_today()` are replaced by parameters of this call, and `saveslot_date(f)` is replaced by an internal column ("Time"; **not done in this version**: using `saveslot_date(f)` reports `internal` (`not_implemented`));
   - The divisor of `/`, `%` and `mod()` is replaced by `NULLIF(divisor, 0)`; in derivation rules the dividend of `/` and the argument of `avg` are converted to `numeric(1000, 45)` ("The value of a derived field" in "Types"); `*` is expanded into the visible fields. The conversions added by this step come after the allowlist check, and the rewritten text does not go through the allowlist again.
8. **Execute**: print the tree of step 7 as text (print only what is in the tree, never copy the caller's original text) and execute it in a read-only transaction. Every identifier in the printed text is double-quoted, and every column reference is `"generated alias"."column name"`. The session fixes `standard_conforming_strings = on` (together with the other fixed session settings in §8 of the architecture document): backslashes in the printed string literals are not escaped, and their meaning depends on this setting; `search_path` is also fixed to contain only `pg_catalog` (functions are printed without schema, tables with their own schema). These are set in the read-only transaction with `SET LOCAL` and are restored when the transaction ends; on PostgreSQL where the timeout is enforced there is also `SET LOCAL statement_timeout`, and the whole call shares one deadline (see "Cost"). The read record reads the kernel's own tables in the same transaction, and those statements carry no schema, so after the caller's statement has run and before the statements of the read record, `search_path` is restored to its original value in the middle of the transaction (`set_config('search_path', original value, true)`).
9. **Read record**: the structural fingerprint of `sql` is derived from the syntax tree after step 5 ("What shape a read record keeps").

- Errors contain only logical names, node names and function names, never physical names; `line` is the line number in the caller's original text.
- If step 4 passes and a later step fails, the whole statement is likewise rejected; a rejection produces no event.

### Statement shape

| Form | `sql` | Derivation rule | Notes |
|---|---|---|---|
| A single `SELECT`, which may carry one trailing semicolon | Accepted | Accepted | |
| A `SELECT` without `FROM` (such as `SELECT saveslot_today()`) | Accepted | Not accepted | A derivation rule needs an input table |
| `WITH` (non-recursive) | Accepted | Accepted | `MATERIALIZED` / `NOT MATERIALIZED`, `SEARCH` and `CYCLE` are not accepted |
| `WITH RECURSIVE` | Not accepted | Not accepted | The number of rows has no upper bound |
| `UNION [ALL]`, `INTERSECT [ALL]`, `EXCEPT [ALL]` | Accepted | Accepted (inside the outermost aggregate) | |
| Subqueries: in `FROM`, scalar subqueries, `EXISTS`, `IN (SELECT …)` | Accepted | Accepted | May correlate with the outer query; `LATERAL` is not accepted |
| `JOIN`: `INNER`, `LEFT`, `RIGHT`, `FULL`, `CROSS`, with `ON` or `USING` | Accepted | Accepted | `NATURAL` is not accepted: the join condition would change when a field is renamed |
| `WHERE`, `HAVING`, `GROUP BY` (expressions or output column ordinals) | Accepted | Accepted | `GROUPING SETS`, `ROLLUP`, `CUBE` and `GROUP BY DISTINCT` are not accepted |
| `DISTINCT` | Accepted | Accepted | |
| `DISTINCT ON (…)` | Accepted | Not accepted | Which row is kept depends on the order |
| `ORDER BY` (`ASC` / `DESC`, `NULLS FIRST` / `LAST`) | Accepted | Not accepted (except inside windows) | `USING <operator>` is not accepted; a derived table has no row order |
| `LIMIT` / `OFFSET` (constants or `$n`) | Accepted | Not accepted | `FETCH … WITH TIES` is not accepted. Paging is handled by `max_rows` and `cursor` |
| `WINDOW` named windows | Accepted | Accepted | |
| `SELECT *`, `t.*` | Accepted, expanded into the visible fields | Not accepted | Every output column of a derivation rule must correspond to a declared derived field; `count(*)` is not affected. In `sql`, when the table that `*` or `t.*` expands (including the output of a subquery) has two columns of the same name, it is not accepted (after expansion they cannot be told apart) and reports `node`, with a hint to name them with `AS`; referencing a duplicate column directly by name, without going through `*`, is an ambiguous name and reports `unknown_name` ("Names") |

**What reports `not_select` as a whole**: everything that is not a single `SELECT`: `INSERT`, `UPDATE`, `DELETE`, `MERGE` (including those written inside `WITH`); any DDL; transaction control; `SET`, `RESET`, `SHOW`; `COPY`; `DO`, `CALL` and the definition of functions and procedures; `PREPARE`, `EXECUTE`, `DEALLOCATE`; `LISTEN`, `NOTIFY`; `LOCK`; `EXPLAIN`; `VACUUM`, `ANALYZE`; multiple statements; an empty statement.

**What reports `node` inside a `SELECT`**: `INTO`; locking clauses such as `FOR UPDATE` / `FOR SHARE`; `VALUES` lists; functions in `FROM` (`generate_series`, `unnest`, etc.); `TABLESAMPLE`; `XMLTABLE`, `JSON_TABLE`; `LATERAL`; `COLLATE`; arrays, subscripts, row constructors; special values such as `CURRENT_DATE`, `CURRENT_TIMESTAMP`, `CURRENT_USER`, `USER`; the `GROUPING SETS` family.

### Names

Names are resolved only against saveslot's logical names, never through the database's `search_path`.

**Tables**: write `table_name` or the qualified name `slot_name.table_name`, optionally with an alias.

- **`sql`**: resolved within the visible range. A table name without a slot is used directly when there is only one such table in the visible range; when there are several it reports `invalid_argument` (`ambiguous_table`), with the candidates attached (consistent with the contract, "References, sequence numbers and the encoding of values"). **One `sql` can reference tables of several slots within the visible range**: it is read-only and involves neither version ownership nor atomicity; the `sv` of the result is given per slot, as the version each one read. Every slot is read at its current version; an old name used within the last 10 schema versions is still resolved as usual, and `warnings` gives `renamed` ("Schema document format").
- **Derivation rule**: resolved only within the slot that holds the rule. A qualified name that points to another slot reports `cross_slot_ref`: neither derivation rules nor `ref` fields cross slots, a derived refresh is in the same transaction as the base write, and one write involves only one slot. Derived tables of this slot may be referenced (refreshed in topological order of the dependencies); a dependency cycle reports `rule_sql_rejected`.
- **Conversion expression**: references no table.

**Fields**: write `field_name`, `table_name.field_name`, `alias.field_name` or `slot_name.table_name.field_name`. A field without a table name that exists on several of the tables in `FROM` is handled as a name that does not resolve to a unique target (reports `unknown_name`, with a hint to add the table name). The only column name that can appear in a conversion expression is the name of this field in `base_version`; any other field reports `not_in_this_version` ("Schema document format").

**System columns**: every base table has the following extra columns in SQL, which need not be declared.

| Column | Which tables have it | SQL type | Notes |
|---|---|---|---|
| `row_id` | Event tables, timeless tables | `text` | The external row ID (`r_…`) |
| `entity_id` | State tables | `text` | The external entity ID (`e_…`) |
| `valid_from`, `valid_to` | State tables | By `granularity`: `date` or `timestamptz` | The valid interval of this segment, `[valid_from, valid_to)`; `valid_to` is empty when it continues indefinitely |

- `row_id`, `entity_id`, together with `valid`, `valid_from` and `valid_to`, are reserved field names and cannot be used as field names (the name rules in "Field types and value ranges").
- A derived table has no system columns: the group key is its field, and `partition_id` does not appear in SQL.
- Internal columns such as the revoked mark, version, provenance and physical segment do not appear. The result of `sql` does not automatically carry row IDs; select `row_id` / `entity_id` yourself if you want them.

**Case and quotes**: slot names, table names and field names are unique within their scope regardless of ASCII case ("Field types and value ranges"), so name resolution in SQL is also case-insensitive for ASCII, and double quotes make no difference: `avgHR`, `avghr` and `"AvgHR"` refer to the same field. Names that the caller chooses (CTE names, table aliases, output column names of subqueries and CTEs, window names) are likewise case-insensitive for ASCII, and the executed text always uses the form folded to lower case, the same at the definition and at every reference: the database compares quoted names literally, so different spellings on the two sides would point to different things. This way the PostgreSQL parser folding unquoted identifiers to lower case also causes no ambiguity. Quotes are needed only when the name happens to be an SQL keyword (`order`, `group`, `user`, ...); an unquoted `user` is parsed as PostgreSQL's `USER` (the current role) and is rejected as an `SQLValueFunction` node, and the error hints to add quotes.

**Output columns of subqueries and CTEs**: only an output column written with `AS`, or an output column that is a plain column as it is, has a name that the outer query can reference by name; the other output columns (functions, `CASE`, subqueries, operations, etc.) have no name the outer query can use, and referencing them by name reports `unknown_name`, whatever default name PostgreSQL would give them. `*` and `t.*` still expand them, and after expansion the kernel gives the names. Names given by the column alias list of a `FROM` subquery or CTE (`AS t (a, b)`) can likewise be referenced.

**Scope of output columns with or without names: a name that is not found is not looked up further outward**: when the `FROM` of a scope contains a subquery or CTE of this kind (with an output column that has no name), an unqualified name that is not found in this scope reports `unknown_name`, with a hint to give the inner output column an `AS` name, and the lookup does not continue to the outer query: PostgreSQL would bind it to that inner column, the analyzer does not have its name, and it must not quietly switch to a column of the same name in the outer query. A scope whose `FROM` items all have named output columns looks outward as usual (correlated subqueries).

**Bare names in `ORDER BY`, `DISTINCT ON` and `GROUP BY`**: an unqualified name in `ORDER BY` and `DISTINCT ON` is matched first against the output column names of this level (if two columns have the same name, it reports `unknown_name`), and only if it is not an output column is it treated as an expression over the input columns, so `SELECT DISTINCT ON (z) laps AS z FROM runs` is valid, and `SELECT DISTINCT ON (laps) feeling AS laps, laps AS feeling FROM runs` deduplicates by the output column `laps` (that is, `feeling`). A bare name in `GROUP BY` is matched first against the input columns of this level, then against the output column names of this level, and if neither has it, it reports `unknown_name` and does not look outward.

**The scope of `JOIN … ON`** contains only the two sides of this join, plus the outer query; comma items written before it in the same `FROM` cannot be seen (if its name exists in the outer query, it refers to the outer one).

**A three-part name `slot.table.column`** is recognized only when the slot was written in `FROM`: after `FROM health.runs` you can write `health.runs.laps`, but after `FROM runs` you cannot, and it reports `unknown_name`.

**A qualified name is looked up only in the innermost scope**: when `q.c` is written, only the innermost scope that has the qualifier `q` is looked at; if there is no column `c` there it reports `unknown_name` and does not look outward (once PostgreSQL has settled `q` at the innermost scope it does not look further out, and when that column is missing it treats `q.c` as a function call `c(q)` on the whole row; the two sides must be consistent). An unqualified column is looked up from the inside outward, at the nearest level, as usual.

**CTE names**: two CTEs in the same `WITH` whose names are the same after folding report `unknown_name` (names are unique regardless of ASCII case).

**Parameters**: `$1 … $n` are used only in `sql`, numbered consecutively from `$1`, and their number equals that of `params`, otherwise it reports `invalid_argument` (`malformed`, `param: "params"`). The type of a parameter is inferred from where it is used (which field it is compared with, whether it appears in `FOR VALID_TIME`, ...); if it cannot be inferred (such as a bare `SELECT $1`) it reports `sql_rejected` (`type`). Values are checked and converted by saveslot according to the inferred type, and are not handed to the database to be parsed under session settings: dates are written `YYYY-MM-DD`, instants are RFC 3339 with an offset, and quantities with a unit are written as a decimal string in the declared unit of that column (the contract, `SqlParams`).

**Names that do not resolve**: a table, field or slot that does not exist, is not visible, or is ambiguous is always reported as `sql_rejected` (`unknown_name`), with no distinction between not existing and not visible (so as not to reveal that "such a table exists"). Physical names (`t_…_v…`, `d_…`), the kernel's own tables, `pg_catalog` and every system object starting with `pg_`, and `information_schema` are not logical names; they are not found in step 5 and likewise report `unknown_name`. If a user happens to call a table `pg_class`, what it resolves to is the user's own logical table.

**Visible range**: step 7 references only visible tables. A derived table is visible if and only if all the tables and fields it depends on are visible ("Visible scope"). Derivation rules are also resolved at compile time against the visible range of the call (in the first version always everything).

### No name in the executed text is left for the database to resolve

The analysis first binds every name the caller wrote according to the rules of this document; if the executed text still carried the caller's names, the database would resolve them again by its own rules, and any difference between the two sets of rules is a hole: the database compares quoted names literally, when a column does not exist `q.f` turns into the function call `f(q)`, an output column without `AS` has a default name chosen by the database, and so on. So in the text executed after step 7, **all** names are generated and qualified by the analysis (output column names and window names are the caller's choice in folded form, quoted by the printer; table aliases and CTE names never enter the text), and the caller's spelling is used only for lookup during analysis:

- The alias of every FROM item is generated by the analysis and unique in the whole query (`t1`, `t2`, ...; for CTEs `c1`, ...);
- Every column reference is written `"generated alias"."column name"`, where the alias is that of the FROM item it is bound to and the column name is the name that column really has in the text; unqualified references and `ORDER BY` / `GROUP BY` / `DISTINCT ON` written by output column name are all replaced by the bound form or the positional ordinal;
- Every output column of every `SELECT` has an explicit `AS`: the caller's folded name if the caller gave one, otherwise one generated by the analysis; `*` is expanded into explicit columns; the column names of the top-level result are still the ones the caller sees, given by the column description of the result and independent of these internal names;
- `JOIN … USING` is written as the equality `ON` it stands for, and a merged column is written as the side it comes from (`COALESCE` for `FULL`);
- Tables are written by slot and the table's own name (the name in the schema, not the caller's spelling or an old name).

A column reference that binds to nothing is never printed: that is an error of the analysis, not of the caller.

### Time

**Valid time**: `FOR VALID_TIME AS OF <instant>` and `FOR VALID_TIME FROM <start> TO <end>`, immediately after the name of a state table and before the alias:

```sql
SELECT b.category, b.amount
FROM budgets FOR VALID_TIME AS OF saveslot_today() AS b
```

- **The operand** can only be: `$n`; a string literal (a date `YYYY-MM-DD`, or an instant with an offset); `saveslot_today()`; `saveslot_now()`. On a per-day table it can also be written as one of these plus or minus an integer constant (a number of days), such as `saveslot_today() - 30`. The operand must be a single fixed value within one call, so no other expressions are accepted.
- **The meaning** is the same as the time parameters of the contract: `AS OF t` is, for each entity, the segment that contains t (`valid_at`); `FROM a TO b` is every segment that intersects `[a, b)` (`valid_during`), and the endpoints are not clipped to the interval; clip them yourself with `GREATEST` / `LEAST` when needed.
- **Granularity**: a per-day table that receives an instant takes the day it falls on in the slot time zone, and `warnings` gives `time_truncated`; a per-instant table that receives a date reports `invalid_argument` (`granularity`). Consistent with the contract, "Time parameters".
- Using it on an event table, a timeless table or a derived table reports `sql_rejected` (`node`), with a hint that an event table should be filtered with `WHERE` on its occurrence time field instead.
- **Reading a state table without a time qualifier** = for each entity, the segment that contains the evaluation instant. The evaluation instant is `at`, or the entry instant, that is `saveslot_now()`, when there is none; "today" is also taken from it. Entities that currently have no value do not appear. A derivation rule that reads this way is classed as depending on "today" and in the first version is computed at read time ("Time dependence").
- **Segments as SQL sees them**: adjacent segments of the same entity whose fields all have the same value are first merged into one segment before they are given, and `valid_from` / `valid_to` are the endpoints after merging. How the data is physically segmented does not affect the result of any SQL; this is the same requirement as "all mechanical judgements ignore the boundaries of physical segments" ("State of a state table").

**Recorded time is not opened in SQL**: `FOR SYSTEM_TIME` reports `sql_rejected` (`system_time`), with `use: "history"` attached; in a derivation rule it reports `rule_sql_rejected`.

**saveslot's three functions**:

| Function | Result | Meaning | `sql` | Derivation rule | Conversion expression |
|---|---|---|---|---|---|
| `saveslot_now()` | `timestamptz` | The entry instant; the `at` when `sql` carries `at` | Accepted | Accepted; the rule is classed as depending on "today" | Not accepted |
| `saveslot_today()` | `date` | The date of `saveslot_now()` in the slot time zone | Accepted; not accepted when the slots referenced by the query do not all have the same time zone (it is not known which time zone to take the day in), and reports `function`, with a hint to pass a date with `$n` or split into two queries | Accepted; the rule is classed as depending on "today" | Not accepted |
| `saveslot_date(f)` | `date` | The date, in the time zone of the slot that owns the table, of the instant of the `zoned_datetime` field f on a base table | Accepted | Accepted; does not count as depending on "today" | Not accepted |

- None of the three functions reads the clock or does time zone conversion in the database. `saveslot_now()` and `saveslot_today()` are rewritten by saveslot into parameters of this call, and each has only one value within one call.
- The argument of `saveslot_date(f)` can only be a column reference to a `zoned_datetime` field, not an expression. This date is computed at the application layer, in the slot time zone, when `apply` applies the event, and is stored in an internal column of the business table; at rewrite it is replaced by this column. So, like "today", it depends only on saveslot's own time zone conversion, not on the database session time zone, and not on the version of the time zone library each of the two backends carries; the time zone library version that saveslot uses is pinned to the saveslot version. This column is materialized state computed from the log and the time zone library, and **the time zone library of the replaying side prevails**: `meta` records the time zone library version used to build the existing column, and when opening a tenant finds that it differs from the current version, it rebuilds this column and the affected derived partitions locally. This is a deterministic local rebuild and writes nothing to the log (§8 of the architecture document). In a cross-version replay comparison (replay after export or import, dual-backend replay comparison), where the time zone library versions on the two sides differ, this column and the derived values that depend on it are classed separately as "time zone library version differs" and do not count as a difference; when the versions are the same, zero difference is required as usual. An event that changes the slot time zone recomputes this column in the same transaction, and the derived tables that depend on it are rebuilt with it (the entry for changing the slot time zone in "Kinds of change and means of migration").
- `f AT TIME ZONE '<time zone>'` is not chosen: time zone conversion would land on the time zone data of each of the two backends, and with different versions it could be off by one day at a daylight saving boundary.

### Types

| Field type | Type in SQL | Notes |
|---|---|---|
| `text` | `text` | Compared and sorted with the `C` collation; already NFC-normalized |
| `enum` | `text` | |
| `integer` | `bigint` | |
| `decimal` | `numeric` | |
| `quantity` | `numeric` | A number in the declared unit of the field; the unit is tracked separately by the type check (see below) |
| `boolean` | `boolean` | |
| `date` | `date` | |
| `zoned_datetime` | `timestamptz` | The instant only; the time zone part does not appear. Use `saveslot_date(f)` to get the day |
| `ref` | `text` | The `r_…` / `e_…` of the target. To join the target table: `JOIN meals m ON m.row_id = d.meal` |

- Two further types can be used only as intermediate values: `timestamp` (coming only from `date::timestamp`, for `date_trunc`) and `interval` (only as the literal of a window frame offset).
- Types not accepted: floating-point types such as `real` and `double precision`, `integer` / `smallint` (only `bigint` is used), `money`, `json` / `jsonb`, arrays, range types, `uuid`, `bytea`, `xml`, and so on.
- **Literals**: strings, integers, decimals (`1.5` is `numeric`), `TRUE` / `FALSE`, `NULL`. Of those with a type prefix only `DATE '…'` and `INTERVAL '…'` are accepted (the latter only in window frames). A string literal compared with a `date` or `timestamptz` is checked by saveslot against the format of the contract (date `YYYY-MM-DD`, instant with a mandatory offset), and is not parsed by the database's date style.
- **Integers are always 64 bits**: values that the database would type as 32 bits (integer constants, `length`, `strpos`, `date - date`) and the `sum` of integers (the database gives `numeric`) are understood as `bigint`, and the executed text wraps them in `CAST(… AS bigint)`; going beyond 64 bits reports an overflow per item 6 of "Determinism". For the positions where the database accepts only 32-bit integers (the position and length of `substr`, the length of `left` / `right`, the ordinal of `split_part`, the number of digits of `round` / `trunc`, the number of days added to or subtracted from a `date`), the first version accepts only integer constants within 32 bits and executes them as they are.
- **An untyped `NULL`**: `NULL` can appear only where the other side or another branch can give it a type (`x + NULL`, `x = NULL`, `COALESCE(x, NULL)`, `CASE … ELSE NULL`, in an `IN` list); neither side having a type (`NULL + NULL`, `-NULL`, `NULL = NULL`), being the argument of a function or aggregate (`abs(NULL)`, `sum(NULL)`), and being the object of a type conversion (`NULL::numeric`) are not accepted and report `type`. In a boolean position (`WHERE NULL`, `NOT NULL`) and `NULL IS NULL` it is accepted. When both sides of `NULLIF` are string literals the result is `text`.
- **The type of a result column**: the column definition of `sql` gives a `FieldType` by the inferred type; a `timestamptz` column gives `"unknown"`, and its cells are RFC 3339 instants in UTC; what cannot be inferred gives `"unknown"`.

**Units**:

- Addition, subtraction, comparison, `sum` / `avg` / `min` / `max`, and the branches of `COALESCE` / `CASE` / `GREATEST` / `LEAST`: operands with a unit must have the same unit code. The same dimension with different units (`km` and `mi`) is also not accepted: the first version has no unit conversion function in SQL. `sql` reports `sql_rejected` (`type`), and a derivation rule reports `unit_inference_failed`.
- Comparison with, or addition to or subtraction of, a literal or parameter: the literal or parameter is understood in the unit of this side (the contract, `SqlParams`). Literals in the branches of `COALESCE` / `CASE` / `GREATEST` / `LEAST` are likewise understood in the unit of the branch that has a unit, so the `0` in `COALESCE(SUM(amount), 0)` is 0 in the unit of `amount`; when all branches are literals there is no unit. Addition, subtraction or comparison with a field that has no unit (`integer`, `decimal`) is not accepted.
- Multiplication and division: a quantity with a unit multiplied or divided by a number without a unit keeps its unit; dividing two quantities of the same unit gives the dimensionless `1`; for any other multiplication or division of two quantities with units, a derivation rule requires that the output field be declared `decimal` or have `unit` stated (otherwise `unit_inference_failed`), and the result column of `sql` is `decimal` without a unit ("Unit vocabulary").
- The result of `count` is `integer`. The precision inference of derived fields is in "Precision and rounding".
- **The value of a derived field**: the result of the rule in the database, rounded once by the precision of the field (`scale`, `rounding`, see "Precision and rounding"). Division and `avg` in a rule are evaluated to at least 45 decimal places (the database's rounding: exactly at a half, away from zero), and the other operations are exact. Where the 45 comes from: with a dividend of at most 12 decimal places and a divisor q of d decimal places, if the exact quotient is not exactly on a rounding boundary of at most 13 decimal places, it is at least 10^-13 / Q away from it (Q = |q|·10^d, an integer); the database's quotient differs from the exact value by at most 0.5·10^-45, so when Q < 2·10^32, evaluating this way and then rounding by the field precision equals rounding the exact quotient directly, and a value exactly at a half is also recognized. The values in a table are all within this (at most 18 integer digits and 12 decimal places), and so is the number of rows. When the dividend has more than 13 decimal places (such as two values multiplied first and then divided) or a division is nested in a division, the value is still defined as "each division at at least 45 decimal places, away from zero exactly at a half": it is deterministic, but is not guaranteed to equal the rounding of the exact value. The `round`, `trunc` and so on that the rule author writes follow the database's definition. The number 45 is part of the behavior of this version of the allowlist, and changing it is changing derived results, so a new version is issued per "changing the behavior of an existing entry" in "Allowlist versions and changes".
- **Decimal group keys**: a `decimal` / `quantity` group key is accepted only if the upper bound of the decimal places of its value does not exceed the inferred precision, otherwise creating the slot reports `not_in_this_version`. The reason is that the database groups by the raw computed value while derived rows are registered by the key rounded to the field precision, and the two would not match. The upper bound is computed level by level: a field takes its declared `scale`, `integer`, integer literals and `NULL` take 0, a decimal literal takes the number of decimal places it is written with (not clipped to 12); addition, subtraction and modulo take the larger of the two sides, multiplication takes the sum of the two sides (the database's multiplication is exact), and division and `avg` have no upper bound; `round(x, n)` / `trunc(x, n)` (`n` an integer constant) take `n` (0 if less than 0), and with only `x` take 0, `floor`, `ceil`, `sign` and `EXTRACT` take 0, a conversion to `numeric(p, s)` takes `s`, `abs` and unary minus follow the argument; `CASE` / `COALESCE` / `GREATEST` / `LEAST` / `NULLIF` take the largest of the result branches (the `WHEN` conditions do not count); the rest have no upper bound.

**Type conversions** (`x::t` and `CAST(x AS t)` are the same node):

| Conversion | `sql` | Derivation rule | Conversion expression | Notes |
|---|---|---|---|---|
| `bigint` → `numeric`, `numeric(p, s)` | Accepted | Accepted | Accepted | `s` at most 12 ("Precision and rounding") |
| `numeric` → `bigint` | Accepted | Accepted | Accepted | Rounded half away from zero |
| `numeric` → `numeric(p, s)` | Accepted | Accepted | Accepted | Rounded the same way as above; `s` at most 12 |
| `date` → `timestamp` | Accepted | Accepted | Accepted | For `date_trunc` |
| `timestamp` → `date` | Accepted | Accepted | Accepted | |
| `text` → `numeric`, `bigint`, `boolean` | Not accepted | Not accepted | Accepted | Can fail depending on the value and reports `migrate_failed` (for the three occasions see "What is reported on rejection") |
| `date` to `timestamptz` and back, `timestamptz` → `timestamp` | Not accepted | Not accepted | Not accepted | Varies with the session time zone; use `saveslot_date` to get the day |
| Conversion to `text` | Not accepted | Not accepted | Not accepted | The output format varies with session settings |
| Any other | Not accepted | Not accepted | Not accepted | |

Implicit conversions are bound by this table in the same way: for example comparing a `date` column with a `timestamptz` value implicitly converts the `date` to `timestamptz`, which is not accepted per the table above.

### The allowlist

The tables below are the allowlist. In the setting column: S = `sql`, D = derivation rule, M = conversion expression.

#### Syntax tree nodes

Node names follow the spelling of libpg_query (PostgreSQL 18 branch); the "Allowed form" column is the condition under which the node is allowed, and what does not satisfy it is handled as a node not accepted.

| Node | Allowed form | Setting |
|---|---|---|
| `RawStmt` | Exactly one | S D M |
| `SelectStmt` | `op` is `SETOP_NONE` / `SETOP_UNION` / `SETOP_INTERSECT` / `SETOP_EXCEPT`; `into_clause`, `locking_clause` and `values_lists` are empty; `group_distinct` is false; `limit_option` is not `LIMIT_OPTION_WITH_TIES`. D additionally requires `sort_clause`, `limit_count` and `limit_offset` to be empty and `distinct_clause` not to be `DISTINCT ON`; M has only one output item and no other clause | S D M |
| `ResTarget` | Output items and aliases | S D M |
| `ColumnRef` | A name of 1 to 3 parts; one whose last part is `A_Star` only in an output item of S | S D M |
| `A_Star` | See above | S |
| `A_Const` | Integer, decimal, string, boolean, `NULL`; bit strings are not accepted | S D M |
| `ParamRef` | `$1 … $n` | S |
| `TypeCast`, `TypeName` | Target and source types per "Type conversions"; without array dimensions | S D M |
| `A_Expr` | `kind` is `AEXPR_OP` (operators in the table below), `AEXPR_DISTINCT`, `AEXPR_NOT_DISTINCT`, `AEXPR_NULLIF`, `AEXPR_IN`, `AEXPR_LIKE`, `AEXPR_BETWEEN`, `AEXPR_NOT_BETWEEN`; operator names carry no schema qualification | S D M |
| `BoolExpr` | `AND_EXPR`, `OR_EXPR`, `NOT_EXPR` | S D M |
| `NullTest` | `IS_NULL`, `IS_NOT_NULL`, applied to a scalar | S D M |
| `BooleanTest` | `IS_TRUE`, `IS_NOT_TRUE`, `IS_FALSE`, `IS_NOT_FALSE`, `IS_UNKNOWN`, `IS_NOT_UNKNOWN` | S D M |
| `CaseExpr`, `CaseWhen` | Both the simple and the searched `CASE` | S D M |
| `CoalesceExpr` | | S D M |
| `MinMaxExpr` | `IS_GREATEST`, `IS_LEAST` | S D M |
| `FuncCall` | The function name is in the tables "Functions", "Aggregate functions" and "Window functions" and carries no schema qualification; `func_variadic` is false; `agg_within_group` is false; `agg_order` is empty; `agg_distinct` only for `count`; `agg_filter` (`FILTER (WHERE …)`) only for aggregates; `over` per "Window functions" | S D M (M accepts only those marked M in the "Functions" table) |
| `SubLink` | `EXISTS_SUBLINK`, `EXPR_SUBLINK` (scalar subquery), and the `IN (SELECT …)` form of `ANY_SUBLINK` | S D |
| `RangeVar` | A logical table name, optionally with a slot name (which lands in `schemaname`); `catalogname` is empty; without `ONLY` | S D |
| `Alias` | A table alias, optionally with a column name list | S D |
| `JoinExpr` | `JOIN_INNER`, `JOIN_LEFT`, `JOIN_RIGHT`, `JOIN_FULL`; `is_natural` is false; `ON` or `USING` | S D |
| `RangeSubselect` | `lateral` is false | S D |
| `WithClause` | `recursive` is false | S D |
| `CommonTableExpr` | `ctematerialized` is `CTEMaterializeDefault`; no `SEARCH` / `CYCLE` | S D |
| `SortBy` | `SORTBY_DEFAULT` / `SORTBY_ASC` / `SORTBY_DESC`, any `NULLS`; `SORTBY_USING` is not accepted | S; D only inside the `ORDER BY` of a window |
| `WindowDef` | Per "Window functions" | S D |
| `String`, `Integer`, `Float`, `Boolean`, `List` | As components of the nodes above | S D M |

There are 32 kinds of node in all. All others are not accepted; the common ones are: every `…Stmt` other than `SelectStmt`, `IntoClause`, `LockingClause`, `RangeFunction`, `RangeTableSample`, `RangeTableFunc`, `JsonTable`, `CollateClause`, `A_Indirection`, `A_ArrayExpr`, `RowExpr`, `GroupingSet`, `NamedArgExpr`, `SQLValueFunction`, `XmlExpr` and the various `Json…` nodes.

#### Operators

| Operator | Operands | Result | Setting | Notes |
|---|---|---|---|---|
| `=`, `<>` (`!=` is a synonym), `<`, `<=`, `>`, `>=` | Both sides of the same kind: integers and `numeric` compared with each other; `text`; `date`; `timestamptz`; `boolean` | `boolean` | S D M | `text` is compared byte by byte with the `C` collation; `date` and `timestamptz` cannot be compared with each other (see "Type conversions") |
| `IS [NOT] DISTINCT FROM` | Same as above | `boolean` | S D M | |
| `[NOT] BETWEEN … AND …` | Same as above | `boolean` | S D M | `SYMMETRIC` is not accepted |
| `[NOT] IN (list)`, `IN (SELECT …)` | Same as above | `boolean` | S D M (M only the list form) | |
| `+`, `-` (binary and unary) | Integers, `numeric` | Same kind | S D M | |
| `*` | Integers, `numeric` | Same kind | S D M | |
| `/` | At least one side is `numeric` | `numeric` | S D M | A divisor of 0 gives null; both sides integers is not accepted (it would silently truncate), with a hint to write `::numeric` |
| `%` | Integers, `numeric` | Same kind | S D M | A divisor of 0 gives null |
| `date + integer`, `integer + date`, `date - integer` | | `date` | S D M | Add or subtract days; in the first version the integer accepts only constants within 32 bits ("Types") |
| `date - date` | | Integer | S D M | The difference in days |
| `\|\|` | Both sides are `text` | `text` | S D M | Concatenation with other types is not accepted (that kind varies with session settings) |
| `LIKE`, `NOT LIKE`, optionally with `ESCAPE` | `text` | `boolean` | S D M | Case-sensitive, matches by bytes. In the first version the pattern accepts only a string constant (or `NULL`) and must not end with the escape character (the database would raise an error); when the escape character is not written it is `\`, and `ESCAPE` accepts only a string constant of length 0 or 1 |
| `AND`, `OR`, `NOT`; `IS [NOT] NULL`; `IS [NOT] TRUE / FALSE / UNKNOWN` | | `boolean` | S D M | |

There are 13 rows in all (synonymous spellings are not counted separately).

**`LIKE` is accepted, `ILIKE` and regular expressions are not**: under the `C` collation `LIKE` compares only bytes and its result is deterministic, and it is commonly used for prefix and substring matching; `ILIKE`, `~` and `SIMILAR TO` need case folding or character classification, their results depend on the locale and on the implementation of the backend, and the first version does not accept them.

#### Functions

| Function | Arguments | Result | Setting | Notes |
|---|---|---|---|---|
| `abs` | Integer, `numeric` | Same kind | S D M | |
| `round` | `numeric`; `numeric, integer constant` | `numeric` | S D M | Away from zero exactly at a half, the same as `half_up` ("Precision and rounding"). An integer argument is not accepted (the database takes the floating-point version), with a hint to write `::numeric`; likewise for `trunc`, `floor`, `ceil` and `sign` |
| `trunc` | `numeric`; `numeric, integer constant` | `numeric` | S D M | Truncates toward zero |
| `floor`, `ceil` (`ceiling` is a synonym) | `numeric` | `numeric` | S D M | |
| `sign` | `numeric` | `numeric` | S D M | |
| `mod` | Two integers; two `numeric` | Same kind | S D M | A divisor of 0 gives null |
| `date_trunc` | `text` constant, `timestamp` | `timestamp` | S D M | The first argument accepts only (lower-case) `'day'`, `'week'`, `'month'`, `'quarter'`, `'year'`; `week` starts on Monday. Written as `date_trunc('week', d::timestamp)::date`. An argument of `timestamptz` (including a `date` implicitly converted to it when `::timestamp` is not added) is not accepted, is rejected as "nondeterministic" and this rewrite is given |
| `EXTRACT(<field> FROM <date>)` | `date` | `numeric` | S D M | The field accepts only `year`, `quarter`, `month`, `day`, `dow`, `isodow`, `doy`, `week`, `isoyear`. The argument can only be a `date`; `date_part()` is not accepted (it returns floating point) |
| `make_date` | Three integers | `date` | S M | An invalid date raises an error, so derivation rules do not accept it |
| `length` (`char_length` is a synonym) | `text` | Integer | S D M | Counted in characters |
| `substr`, `substring(… FROM … FOR …)` | `text, integer constant[, integer constant]` | `text` | S D M | By character position; the length is not negative |
| `left`, `right` | `text, integer constant` | `text` | S D M | |
| `strpos`, `position(… IN …)` | `text, text` | Integer | S D M | |
| `starts_with` | `text, text` | `boolean` | S D M | |
| `btrim`, `ltrim`, `rtrim`, `trim(…)` | `text[, text]` | `text` | S D M | |
| `replace` | `text, text, text` | `text` | S D M | |
| `split_part` | `text, text, integer constant` | `text` | S D M | The ordinal is not 0 |
| `saveslot_now()`, `saveslot_today()`, `saveslot_date(f)` | See "Time" | | See "Time" | |

There are 24 functions in all (synonymous names and the special SQL-standard spellings are not counted separately): numeric 7, date 3, text 11, saveslot 3. The "integer constant" in the table marks the positions where the database accepts only 32-bit integers, and the first version accepts only constants within 32 bits ("Types"). `COALESCE`, `NULLIF`, `GREATEST`, `LEAST` and `CASE` are syntax nodes, see above.

#### Aggregate functions

| Aggregate | Arguments | Setting | Notes |
|---|---|---|---|
| `count(*)`, `count(x)`, `count(DISTINCT x)` | Any allowlisted type | S D | A distinct count over a `ref` field, such as `count(DISTINCT meal)`, is allowed |
| `sum`, `avg` | Integer, `numeric` | S D | The unit of a quantity with a unit is unchanged |
| `min`, `max` | Integer, `numeric`, `text`, `date`, `timestamptz` | S D | `text` uses the `C` collation |
| `bool_and`, `bool_or` | `boolean` | S D | |

- 9 entries in all. All can carry `FILTER (WHERE …)`. `DISTINCT` is used only for `count`, and `ORDER BY` inside an aggregate is not accepted.
- Not accepted: `string_agg`, `array_agg`, `json_agg` (the result depends on the order, and the types are not in the allowlist either); `percentile_cont`, `percentile_disc`, `mode` (`WITHIN GROUP`); the `stddev` and `variance` family and the `regr_…` family (not needed in the first version, and the precision rules would need to be settled separately).
- The numbers are all `numeric` or `bigint`, with no floating point, so sums and averages do not depend on the order of accumulation.

#### Window functions

| Function | `sql` | Derivation rule |
|---|---|---|
| `count`, `sum`, `avg`, `min`, `max` with `OVER (…)` | Accepted | Accepted; the frame can only be `RANGE` or `GROUPS` (including the default frame when no frame is written) |
| `rank()`, `dense_rank()` | Accepted | Accepted |
| `row_number()`, `lag(x[, n[, default]])`, `lead(x[, n[, default]])`, `first_value(x)`, `last_value(x)` | Accepted | Not accepted: when the sort key has tied values the result depends on the order of the tied rows |

- 12 entries in all (5 aggregates used as windows and 7 window-only functions).
- `OVER` can contain `PARTITION BY`, `ORDER BY`, a frame, or refer to a named window. Frame bounds accept only `UNBOUNDED PRECEDING`, `UNBOUNDED FOLLOWING`, `CURRENT ROW`, `n PRECEDING`, `n FOLLOWING`: for `ROWS` / `GROUPS` n is a non-negative integer constant; for `RANGE` ordered by `date` n is an `INTERVAL` literal in days or weeks (`INTERVAL '6 days'`), and ordered by a number n is a numeric constant. The `EXCLUDE` clause is not accepted.
- A `ROWS` frame is not accepted in a derivation rule, for the reason given above; `RANGE` and `GROUPS` cut the frame by value or by tie group and do not depend on the order of tied rows.
- In a derivation rule a window function can appear only inside the outermost grouped aggregate ("Refresh scope and admission of writes"); a rule with a window function recomputes all partitions every time in the first version.
- Not accepted: `ntile`, `percent_rank`, `cume_dist` (the latter two return floating point), `nth_value`.

### Determinism

The results of derivation rules and conversion expressions enter replay, and must produce the same values at replay and on both PGlite and PostgreSQL. The allowlist is chosen by the following items:

1. **The PostgreSQL function behind every entry is `IMMUTABLE`** (`pg_proc.provolatile = 'i'`), on both backends, and the tests assert this entry by entry ("How it is tested"). The `now()` family, `random()`, `clock_timestamp()`, `current_setting()`, `set_config()`, `to_char()`, `concat()`, `date_trunc` used on `timestamptz`, and conversion between `date` and `timestamptz` are not, and are not accepted. `CURRENT_DATE` and the like are `SQLValueFunction` nodes and are rejected as nodes. The `IMMUTABLE` property of each allowlist entry is checked entry by entry against the system catalog of PostgreSQL 18 at implementation time, and an entry found not to be is moved out of the allowlist.
2. **No dependence on session settings**. The fixed session settings are in §8 of the architecture document: time zone `UTC`, text with the `C` collation, decimal numbers as `numeric`, date output ISO. The allowlist avoids them beyond that: time zone conversion is never done in the database (`saveslot_today()` and `saveslot_date()` are computed at the application layer); literals and parameters of dates and instants are parsed by saveslot; no conversion to text is accepted.
3. **Text is compared only by bytes**. Text columns use the `C` collation and are NFC-normalized when written, so equal means identical code point by code point. What depends on character classification or case folding is not accepted: `lower`, `upper`, `initcap`, `ILIKE`, regular expressions, `SIMILAR TO`, `COLLATE`. Functions that count in characters, such as `length` and `substr`, depend on the database encoding, and the database encoding of both backends is fixed to UTF-8 (the default encoding of PGlite is checked at implementation time).
4. **No floating point**. Numbers are always `numeric` or `bigint`; floating-point types and functions that return floating point (`date_part`, `sqrt`, `power`, `exp`, `ln`, `random`, ...) are not accepted.
5. **The result does not depend on the order of rows**. Derivation rules do not accept `LIMIT` / `OFFSET` after `ORDER BY`, `DISTINCT ON`, window functions that depend on tie order, `ROWS` frames, or ordered aggregates (see the tables above).
6. **Evaluation does not fail because of data**. When the divisor of `/`, `%` and `mod()` is 0 the result is null (rewritten to `NULLIF(divisor, 0)`); integer divided by integer is not accepted; derivation rules do not accept conversions and functions that can fail depending on the value (`text` to number, `make_date`). What remains are only a few cases that arise from data: 64-bit integer overflow, exceeding the precision in a conversion to `numeric(p, s)`, a `date` going beyond the date range after adding or subtracting a constant number of days, and the result of a derived field going beyond the value range of the field type (a date not within 0001-01-01 to 9999-12-31, or a decimal whose integer part has more than 18 digits; the database computes it as usual, but saveslot's value representation cannot express it). The same holds for the result of `sql`: a `date` result not within 0001-01-01 to 9999-12-31 (the database would give `0044-03-15 BC` or a five-digit year, and the contract has no such form) reports `runtime`; the `sum` of integers (in both the aggregate and the window use) is `numeric` in PostgreSQL, and the executed text wraps it as `CAST(sum(…) AS bigint)`, and going beyond 64 bits reports `runtime` as an overflow, and the result is still `integer`, so an integer beyond 64 bits never appears. `sql` reports `sql_rejected` (`runtime`); a derivation rule reports `rule_sql_rejected` at the trial run at compile time, and when it happens afterwards in the refresh of a base write, the whole write is rejected and reports `validation_failed` (`write`), with detail code `rule_eval_failed`, and no event is produced.
   **The database's original text is not passed on**: any rejection by the database during execution of a statement that has passed the check (the data errors above, a scalar subquery returning more than one row `21000`, and any other situation the check did not foresee) is always reported by `sql` as `sql_rejected` (`runtime`), with text of the kernel's own; the database's original text (which would bring out generated aliases and internal names) goes only to the local log and into no field of the error; a timeout is reported separately as `sql_timeout`. What the check can determine is not left to the database: a window function nested inside an aggregate function, or a subquery in an aggregate query that uses a column of the outer query that is not grouped, is rejected as `node` at the analysis stage.
7. **Compared entry by entry on both backends**. Every entry has dual-backend test cases ("How it is tested"); an entry that shows a difference is either removed from the allowlist or has its behavior pinned by the kernel (explicit collation, explicit rounding, forced ordering), and then a new allowlist version is issued.

### Cost

**The main line of defense is before execution** (§7 of the architecture document: on PGlite a timeout can only terminate the whole DB Worker):

- The allowlist does not accept forms that would amplify the number of rows: functions that return multiple rows (`generate_series`, `unnest`, `regexp_split_to_table`, etc.; neither in `FROM` nor in output items), `WITH RECURSIVE`, `LATERAL`.
- The limits in the table below are checked in steps 1 and 4. The values are initial values, to be adjusted by experiment 2 and experiment 4:

| Item | Limit |
|---|---|
| SQL text | 16 KB (UTF-8 bytes) |
| Number of syntax tree nodes | 2,000 |
| Expression nesting depth | 32 |
| Subquery nesting levels (`FROM` subqueries, scalar subqueries, `EXISTS` / `IN` subqueries and CTEs each count as one level) | 4 |
| Number of table references (referencing the same table twice counts as two; references to CTEs and expanded derived tables computed at read time also count) | 8 |
| Number of CTEs | 8 |
| Number of branches of set operations | 8 |
| Number of items in an `IN` list | 1,000 |
| Number of branches of one `CASE` | 256 (enough to map 200 enum values one by one) |
| Number of parameters | 100 |
| Number of window definitions | 4 |

- Going beyond a limit: `sql` reports `sql_rejected` (`limit`), and derivation rules and conversion expressions report `rule_sql_rejected`.
- A derivation rule additionally goes through the write admission estimate: if any of the number of affected partitions, the estimated number of scanned rows, the dependency depth or the estimated time exceeds its limit, that write is rejected ("Refresh scope and admission of writes").

**During execution**:

- `sql` returns `max_rows` rows per page (default 100, upper limit 1,000), and `cursor` turns pages.
- **A read record does not amplify a query the caller has already limited**: the statements a read record runs row by row take the own FROM and WHERE of that query level (including the subqueries in the WHERE) and do not look at the caller's `LIMIT`. So **recording per row is done only when this level has exactly one table reference and the WHERE of this level contains no subquery**; if a level has two or more table references (a join, commas), or the WHERE contains a subquery, no statement is run for it and the tables of this level are recorded directly as table-level records. Once any one reference to a table cannot be recorded per row, none of that table's references runs a statement: the decision is made first and execution follows, so it never happens that several statements have run and it then turns out to be table level after all. The other half of the rule is in `04-write-and-read`, "How many are recorded".
- **A timeout reports `sql_timeout`**, with `elapsed_ms` attached. On PostgreSQL `statement_timeout` is used; **the whole call has one deadline**: executing the caller's statement and each statement of the read record each get the time that remains of the deadline, not a full allowance each; when less than 1 millisecond remains no further statement is sent and `sql_timeout` is reported directly. On PGlite `statement_timeout` does not take effect, and a timeout can only terminate the whole DB Worker, which equals one database crash; whether to enable it is decided by experiment 2, and when it is not enabled `sql_timeout` does not occur on PGlite, only the up-front limits above apply, and one slow query blocks the writes of that tenant until it ends. The timeout value is a temporary 10 seconds (a kernel constant, injectable by tests, not a key of `config.toml`; [`../08-open-questions.md`](../08-open-questions.md)), to be settled by experiments 2 and 4.

### What is reported on rejection

| Situation | `sql` | Derivation rule | Conversion expression |
|---|---|---|---|
| Syntax error; the text is not well-formed Unicode | `sql_rejected` (`syntax`) | `rule_sql_rejected` | `rule_sql_rejected` |
| Not a single `SELECT` | `sql_rejected` (`not_select`) | `rule_sql_rejected` | `rule_sql_rejected` |
| The node, or the form of the node, is not in the allowlist | `sql_rejected` (`node`) | `rule_sql_rejected` | `rule_sql_rejected` |
| The function, operator or type conversion is not in the allowlist (including a wrong signature) | `sql_rejected` (`function`) | `rule_sql_rejected` | `rule_sql_rejected` |
| Not accepted only because the result is nondeterministic (`now()`, `random()`, `date_trunc` on `timestamptz`, order-dependent forms in a derivation rule) | `sql_rejected` (`function` or `node`) | `nondeterministic_function` | `nondeterministic_function` |
| `FOR SYSTEM_TIME` | `sql_rejected` (`system_time`), `use: "history"` | `rule_sql_rejected` | `rule_sql_rejected` |
| The name does not exist, is not visible, or is ambiguous; physical names, system objects | `sql_rejected` (`unknown_name`); a table name without a slot that exists in several slots: `invalid_argument` (`ambiguous_table`) | `rule_sql_rejected`; a table of another slot: `cross_slot_ref` | A field other than this field: `not_in_this_version`; otherwise `rule_sql_rejected` |
| Type or unit mismatch | `sql_rejected` (`type`) | Unit: `unit_inference_failed`; type: `rule_sql_rejected` | `rule_sql_rejected` |
| Over a limit | `sql_rejected` (`limit`) | `rule_sql_rejected` | `rule_sql_rejected` |
| Evaluation error | `sql_rejected` (`runtime`) | At the trial run `rule_sql_rejected`; in a later write `validation_failed` (`write`), with detail code `rule_eval_failed` | At the trial run at compile time `validation_failed` (`schema`), with detail code `migrate_failed`; at confirmation (`resolve`) writes made after the trial run are evaluated again, and a failure reports `draft_outdated` (`migrate_failed`), and the item stays open; a write carrying an old `sv` during a migration is evaluated against the new version inside the transaction of the write, and a failure reports `validation_failed` (`migrate_failed`, with `path` pointing to the field), with a hint to reread by the new version and write again |
| The outermost level is not an aggregate | — | `not_in_this_version` | — |
| Wrong number of parameters | `invalid_argument` (`malformed`) | — | — |
| Time granularity mismatch | `invalid_argument` (`granularity`) | `rule_sql_rejected` | — |

- `sql_rejected` carries `line` (the line number in the original text) and `node` (the node name, function name or the logical name the caller wrote, never a physical name); a surface uses these to point out "which node / function on which line" (the surfaces document, "Rendering of text").
- The details of derivation rules and conversion expressions carry `path` (`tables/<i>/rule/sql`, `tables/<i>/fields/<j>/migrate`, ...) and `line`, and when a way to fix it can be given, `suggestion` (such as the SQL fragment after replacement); the subdivided reason is written in `sql_reason`, with values from the same set as the reason codes of `sql_rejected`.
- When the analysis result inside a derivation rule (whether `saveslot_now()` / `saveslot_today()` is used, whether a state table is read without a time qualifier, whether a group key is a `date` field, `saveslot_date(f)` or `date_trunc(unit, …)` applied on these two; a group key that merely reads a date field does not count as bucketing) is inconsistent with the `time_dependency` it declares, it reports `rule_sql_rejected`, and `suggestion` gives the value that should be declared.

### Allowlist versions and changes

The allowlist has a version number, written `rsql@1` (the same way as the unit vocabulary `units@1` and the checker `literal@1`). The version is recorded per rule: in the compiled result (`schema.compiled`) every derivation rule carries its own `rule.rsql`; the top-level `rsql` governs only the `migrate` and `backfill` expressions of this version. Derivation rules and conversion expressions are evaluated by the version each one recorded, and so is replay; `sql` always uses the current version. Rules in the same slot can therefore record different versions.

| Change | How it is done | Effect on existing data |
|---|---|---|
| Adding an entry (a new function, a new signature, a new form of a node, widening the settings of an entry) | Issue a new version; at the same time add the rejection and acceptance cases of experiment 2 and the dual-backend cases of experiment 5, and without passing the coverage check it cannot be merged | Existing rules do not use it, so results do not change |
| Tightening or removing an entry | Issue a new version; newly compiled rules no longer accept it | Rules already compiled are still evaluated by the version recorded |
| Changing the behavior of an existing entry (changing the rounding or the rewrite, or a function's result changing after a PostgreSQL upgrade) | It cannot be changed in place. The new behavior goes only into a new version; the implementation always keeps the behavior of the old version, which replay needs | Changing behavior equals changing derived results and conversion results, and so changing replay results, so it must carry a version |

- **Rules do not switch to a new version on their own**. A rule switches to the current allowlist version only when it is recompiled for another reason (it is changed itself, or a definition it depends on changed), and the switch is merged into that change, with no separately generated change and not entering awaiting confirmation; a rule that is not touched is always evaluated by the version recorded. So a kernel upgrade does not put unrelated drafts into awaiting confirmation, and there is no "switch the allowlist version" row in the table of kinds of change. When the behavior of a rule changes after the switch (it uses an entry whose behavior changed), the rule version is increased by 1 and the derived cache is rebuilt by the new rule.
- **The version of a conversion expression is valid permanently**: they must be evaluated as they are on every replay from the beginning, so for an entry in a released version, once its behavior is fixed it cannot be removed.
- A change in the result of an entry caused by a PostgreSQL upgrade is found by the cross-major-version replay comparison of experiment 5; the handling is for the kernel to pin the old behavior, or to move the entry out of the new version.

### How it is tested

In code the allowlist is one piece of data (for each entry: name, argument types, allowed settings, version it belongs to), and the tables of this document agree with it; the coverage check below reads this data and is judged mechanically by a script.

| Test | Corresponds to in this document | Pass criterion |
|---|---|---|
| Experiment 2 fuzz testing (the technical validation experiments of [`../07-scope-v1.md`](../07-scope-v1.md)) | A manual list covers every form rejected as a whole and every form rejected inside a `SELECT` in "Statement shape", the functions and forms named in items 1 to 4 of "Determinism", system objects and physical names, and `FOR SYSTEM_TIME`; each is varied (case, quotes, comments, put into a subquery, `CASE`, CTE); in addition a generator produces random statements following the PostgreSQL grammar. The positive cases are all the valid queries in the specification and the guide, and the derivation rules and conversion expressions | Among the allowed statements, the number that changed database state or session state or called a function outside the allowlist is 0; all positive cases are allowed; the implementation is "reject everything not recognized", confirmed by code review |
| Experiment 5 dual-backend consistency | For every node, operator, function, type conversion, aggregate and window function in the allowlist, at least one case in each setting where it is allowed; in addition it asserts that the function behind each entry is `IMMUTABLE` on both backends; adversarial cases cover division and rounding, truncation by week and by month, leap days, time zone boundaries, sorting and grouping with Chinese text and emoji, and nulls | Coverage 100%; the results of the two backends are byte for byte identical, with 0 differences; satisfied for every PostgreSQL major version intended to be supported |
| Rewrite and visible range | Steps 5 to 7 of "Processing steps": run queries with a visible range `scoped` down to the table level, where an unlisted table and a nonexistent table report the same error; a derived table is visible if and only if its dependencies are all visible; the SQL result of a state table is unchanged under any splitting into segments | All pass |

### Not accepted in the first version, may be added later

Added as needed, each addition going through "Allowlist versions and changes":

- Case folding and pattern matching: `lower` / `upper`, `ILIKE`, regular expressions. A folding rule independent of the locale must first be settled and compared on both backends.
- Unit conversion functions (converting `mi` to `km` in SQL), and the time zone part of `zoned_datetime`.
- Addition and subtraction on instants (`timestamptz ± interval`): the meaning of "add a day" at a daylight saving boundary must first be settled at the application layer.
- Ordered aggregates (`string_agg … ORDER BY`), quantiles, standard deviation.
- `LATERAL`, recursive CTEs, functions that return multiple rows: a way of estimating the cost in advance is needed.
- Order-dependent window functions in derivation rules: can be allowed once the sort key is required to be provably free of ties (such as ending with `row_id`).
- Non-constant integers in the positions that accept only 32-bit integers (`substr`, `left` / `right`, `split_part`, the number of digits of `round` / `trunc`, the number of days added to or subtracted from a `date`): the behavior when going beyond 32 bits must first be settled.
- `LIKE` patterns taken from data: the result when a pattern ends with the escape character must first be settled (the database would raise an error, and evaluation would then fail because of data).
