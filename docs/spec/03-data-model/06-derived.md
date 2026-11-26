# saveslot · Data-layer mechanisms · 06 Derivation

> Translated from docs/zh-CN/spec/03-data-model/06-derived.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

> Part of the data-layer mechanisms; for the contents, see [`README.md`](README.md). A section quoted in "…" may be in another file of the same directory; look it up in the contents.

## Derivation rules and derived caches

**Base tables are written by the agent / caller; derived tables are generated entirely by rules, and the agent cannot write to them directly.** Derivation rules are part of the schema;
when a schema is defined, the agent drafts the base table schema together with the derivation rules.

**Rules come in three levels: a result that is deterministic may serve as a cache; a result that is not deterministic must be stored.**

| Level | What it is for | Example | Result |
|---|---|---|---|
| L1 restricted SQL (first version) | Most aggregations, joins and time windows | Distance run this week, 7-day average, budget left this month | Derived cache, can be recomputed |
| L2 sandboxed pure function | Deterministic algorithms that are too awkward in SQL | Exponential moving average of training load, complex billing rules | Derived cache, can be recomputed |
| L3 model derivation | Semantic judgement | "Training status this week: overloaded" | **Not a derivation rule**: a background executor that calls a model (a worker) makes one write to the base table; the provenance is the upstream versions it read plus the model output (stored as source data), and it is treated at the "agent inferred" level |

- **L1 restricted SQL**: only SELECT views over the modelled data inside saveslot are allowed; the functions are on a allowlist that admits only deterministic functions, and things like `NOW()` are forbidden;
  instead, the instant to compute "as of" is passed in explicitly. Which statements, functions, aggregates and operators are accepted is in ["Restricted SQL"](11-restricted-sql.md). **How SQL refers to this instant**: two functions without arguments, `saveslot_now()` (the instant taken at the entry point; when a `sql` operation carries `at`, it is `at`) and `saveslot_today()` (its date in the slot's time zone). They do not read the clock; saveslot rewrites them into explicit parameters of this call, and within one call there is only one value. A rule that contains either of them is classed as depending on "today" (table below). To read a state table at some instant, write `FROM <table> FOR VALID_TIME AS OF saveslot_today()`. Which tables and columns a rule depends on is obtained by parsing the SQL.
- **L2 sandboxed pure function**: for example compiled to WASM, with no network, no reading of time and no random numbers; the same input gives the same output; it is registered in the schema and called from SQL.
- A computation that needs external data (such as currency conversion) is not derivation: the external data first comes in as base data through a source connector, and is then used in a rule.
- **A rule reads logical tables, and a logical table contains only rows that are not revoked.** But when the referencing row is not revoked and the target its `ref` points to is revoked, the referencing row is still in the logical table, and the value of `ref` is still the original ID (references do not cascade, see "The write request · Reference fields"). So **counting or summing by a `ref` field** (such as counting how many meals were eaten in a day by the `meal` of the detail rows) **includes rows that point to a revoked target**. To exclude them, the rule must join the target table and take only the rows that can be joined: the logical table of the target table no longer has the revoked row. saveslot gives no separate warning about this.

**A derived cache is also an actually existing table, and it must be updated along with the base data:**

- A base write and the refresh of the derived caches it affects **complete synchronously in the same transaction**, so a derived value that is read never lags behind the base data.
- Refresh method: in the first version, **recompute the affected partitions or the whole view**: data is isolated per user and small, so a full recomputation is also fast;
  switch to incremental maintenance only when it actually becomes slow.
- After a refresh, **each derived row whose result changed** gets one derived write recorded in the log (rows whose result did not change are not recorded; **exception for deletion**: for the affected rows, a deletion confirmation and a cancellation of a deletion append one derived write for every partition the rows landed in before and after the deletion, even when the result did not change; when replaying from the start after a tombstone, the value of such a partition in an intermediate state may differ from the online one, and this entry is the only place that pulls it back): the rule version, `partition_id` and the log position that was read (containing no user content, not erased by deletion); the group key values and the result checksum (computed from user content, can be deleted). The provenance is recorded automatically by the rule engine. The field-level definition is in [`../09-event-format.md`](../09-event-format.md).
- The type, unit and precision of a derived field are inferred from the rule by the compiler and filled back in (see "Field types, same value and units").

**Fallback options** (none is used in the first version; evaluate them when the expressiveness or the performance of rules is not enough): incrementally maintained views pg_ivm, Materialize, RisingWave,
Feldera; dbt for SQL modelling with a dependency graph; the spreadsheet formula engine HyperFormula; the WASM sandbox for L2.

### Refresh scope and admission of writes

**The first version recomputes by the affected group and uses no IVM engine, pg_ivm included.** Measured on PGlite with 1 million rows: recomputing a whole user takes about 290 ms, and recomputing only the one affected week about 1.7 ms;
both fit into the same transaction; for figures at larger scales see the architecture document, "Capacity limits and measured values". pg_ivm is a fallback: if recomputation of a few hot rules later turns out too slow, it can serve as an accelerator for those rules (it does not support window functions and the like, and when it is used saveslot still has to record the derived writes itself).

**The first version requires a particular shape of rule: the outermost level must be a grouped aggregate, or an ungrouped overall aggregate (the result is a single row).** Then a partition is exactly one row: the identity of a derived row is its `partition_id`, and `ver` and the result checksum are both defined per "one derived row". A rule whose outermost level produces several rows without a group key (such as a bare window function, or a join without aggregation) reports `not_in_this_version` at compile time; window functions and joins can appear inside a grouped aggregate.

When a rule is compiled, the analyzer works out for each L1 rule its **recomputation scope** (which partitions one base change requires recomputing), and the primary key of the derived table = the group key:

| Rule form | Recomputation scope | How the affected keys are obtained | First version |
|---|---|---|---|
| Grouped aggregate (the group key is a deterministic function of base columns, including bucketing by valid time) | The group | Compute the group key from the before value and from the after value of the changed row | Yes |
| Ungrouped overall aggregate | The one and only partition; when there is no input row, there is no derived row (see "no derived row for a bucket without input" in "Time dependence") | — | Yes |
| Window function, bounded frame | The affected frames within the partition | Group key + frame offset | Not recognized: a window function can appear only inside a grouped aggregate, and such a rule is treated as "cannot be analyzed" |
| Window function, unbounded frame / running value | The whole partition (usually the whole user) | Partition key | Same as above |
| Joining a dimension table | The groups of the fact table, looked up in reverse by the join key | Affected dimension key → group keys that refer to it | Not recognized: treated as "cannot be analyzed" |
| Cannot be analyzed | All partitions of that rule | — | Yes |

Given the shape requirement above, "the outermost level must be a grouped aggregate or an overall aggregate", only three rows actually occur in the first version: "grouped aggregate", "overall aggregate" and "cannot be analyzed". A rule that has a window function inside or joins a dimension table recomputes all of its partitions on every base change. The two rows for window functions and for joining a dimension table are the recomputation scopes for when the shape of rules is opened up later, or the analysis is refined.

- Refresh = for each affected key: delete the derived row + reinsert it by the original rule with a key predicate added; if the result did not change, nothing is passed downstream; it runs level by level in the topological order of the derived dependencies. When the affected keys are more than a limit (a constant of the implementation), the rule recomputes all its partitions instead: recomputing each key on its own reads its input rows each time, and while a group's input rows cannot be found by key through an index, a few keys already cost more than one whole recomputation.
- **The identity of a derived row does not carry the group key values**: when a group first appears, an opaque `partition_id` is assigned, and the mapping "group key values → `partition_id`" is recorded in the content of that derived write (the group key values are ordered by the field IDs of the group key fields in the derived table, regardless of the order written in `GROUP BY`); the count table, `derived_reads` and read_log all record by `partition_id`.
  When the group key of a rule comes from a free-text field (`text`, excluding `enum`), the compile receipt (the `group_key_free_text` entry of `warnings`) and the deletion preview warn that "the group key is the user's original text and is erased together with the group on deletion".
  After a group becomes empty (all its rows were revoked, changed into another group, or deleted) and the same group key later gets rows again, **the original `partition_id` is reused**, so read records of reads that read this group still connect. When it became empty through revoking or rewriting, the mapping was not erased and does not need to be registered again; when it became empty through deletion, the mapping is erased with the deletion, and when rows appear again within the grace period it is registered again in a new derived write (see "Row identity" and "Deletion · Content derived from source data").
- **Admission threshold for writes**: before execution, the "sum of the row counts of the affected partitions" is estimated (partition row counts come from the count table maintained in the same transaction); if any of the number of affected partitions, the estimated number of rows scanned,
  the dependency depth or the **estimated time** exceeds its limit, the write is rejected, returning "affects about N rows, split into batches of at most K rows each"; during execution a timeout serves as the fallback.
  The timeout and retry semantics of the write interface will be decided after the results of the derived-refresh latency experiment (references-arch experiment 4).
  - **The premises of a write count toward the estimate**: the sum of the numbers of premise declarations in effect on the rows being written counts toward the estimated number of rows (`estimated_rows`), because the write has to update the state of every declaration that intersects (see "The premises of a write"). The number of declarations in effect per row has an upper limit at declaration time, so the contribution of a single op to this item is bounded; when the numeric admission thresholds are set, they are not lower than this limit, so a single op never exceeds the threshold only because of premises.
  - **Admission applies to writes triggered by `write` and `resolve`** (including the revert writes such as `undo` and taking the previous value), **and does not apply to deletion**: a deletion confirmation, a cancellation of a deletion and a physical erasure at expiry all do no admission estimate and do not report `too_large`. The scope of a deletion is determined by the source data being deleted and cannot be split into batches; rejecting it would amount to blocking the right to be forgotten. The derived recomputation and premise detection that a deletion causes are still done, and their cost is included in the deletion itself.
- **Large-write jobs** (**not in the first version**: anything above the admission threshold is rejected, and the caller splits it into batches): a large write that cannot be split (importing a year of data in bulk, changing one row of a dimension table; with several nodes (later), also an over-limit write synced up from offline) is turned into a job:
  accepted, a job handle is returned, processed in the background, and takes effect atomically on completion. In the meantime the affected derived values keep their old values and carry a `stale` (waiting to be refreshed) mark, which comes out with reads.
  **This is a limited relaxation of "a derived value never lags behind"**: only during the job, only for the affected derived values, and always marked.
  In a bulk import, one import file is one source, the writes of many rows share this source, and the derivations are refreshed together at the end of the job.
  **All the state of a job is in the log**: the "job accepted" event (containing the whole request, handled as content; `apply` uses it to set `stale` on the affected derived values), the base writes the job produces, and the "job completed" (clears `stale`) / "job failed" event;
  background progress is only a (c)-class cursor, and after a crash the to-do list is derived again from the jobs that are "accepted, not completed"; a job handle that was already returned remains valid.
- **Boundary of determinism**: the session time zone and the collation are fixed, the function allowlist admits only functions whose result is deterministic (IMMUTABLE) (see "Restricted SQL"), and numbers are uniformly `numeric`;
  reconciliation of "full recomputation vs cache" is folded into the log replay comparison (in the first version triggered manually from a user session; there is no periodic background sampling).

### Provenance tracking for derived data: three layers

| Layer | What it stores | When it is written | Use |
|---|---|---|---|
| Static column-level dependencies | Rule version → the (table, column) pairs referenced | When the rule is compiled | To decide whether a write triggers a rule, the schema-change impact preview, and later permission inheritance for derived tables |
| Partition-level read set | Derived write → (rule version, base table, `partition_id`, log position; group key values are not stored here) | At every derived refresh, one row per affected partition | The concrete form of the provenance "upstream write" (the `derived_reads` table) |
| Row-level provenance | Not stored in advance | Obtained when needed by rerunning the rule on the version table at a log position | Audit display "which runs make up the 22 of W45" |

- **In the first version the read set records only down to (base table, derived partition).** A rule with `WHERE` does not additionally record the shape of the predicate; for a rule whose recomputation scope cannot be analyzed, every base change recomputes all of its partitions, and the read set is still recorded per partition. An impact query therefore prefers to over-report. If "a predicate shape without user values" is to be recorded, it is added as a new optional item in the read set entry, and existing derived writes need no change.
- Storing row-level provenance in advance was measured to slow writes down 4–7 times; the partition level is already enough for deletion cascades (after the affected partitions are recomputed, "disappears if it came only from deleted data, no longer depends if it has other sources" holds naturally)
  and for correction impact queries (exact to the partition; for a rule with WHERE the old value can be substituted in for a further check).
- Dependencies are parsed with libpg_query, taking every referenced column (including columns in WHERE and JOIN); a form of writing it cannot understand is rejected outright.

### Time dependence

A rule declares its time dependence in the schema:

| Category | Example | Can it be cached | Refresh scope |
|---|---|---|---|
| Independent of time | Number of tasks in a project | Yes | As for ordinary dependencies |
| Bucketed by valid time | Distance per week, spending per month | Yes, the derived row carries the bucket key | Affected buckets = the union of the buckets that the valid times of the before row and the after row fall into |
| Depends on "today" | Budget left this month, 7-day average | It cannot be cached by "today" | Rewritten to an explicit instant parameter: computed at read time, or changed to a per-bucket cache with the current bucket selected at read time |
| Reads a state table without a valid-time qualification | "Sum of the current budgets of all categories" | No: the current segment changes as time passes, and no write triggers a refresh | Classed at compile time as depending on "today": computed at read time |

- **For a rule that depends on "today", the first version only does computation at read time and no caching.** Such derived rows have no derived-write event and no version: a read result carries no `ver`, and carries the annotation `computed_at_read` (computed at read time; the value depends on the instant of the read). It still has a derived physical table, which is always empty; all read entry points bypass it according to the time dependence of the rule (`time_dependency` is `now`) (see ["Schema version evolution (continued)"](08-schema-migration.md), "The physical approach").
- When a rule reads a state table and a cache is wanted, state a valid-time qualification (take the value at some instant, per bucket).
- **A bucket without input has no derived row**: a grouped aggregate produces no row for a group without input, and "no row for some week" means "not one record at all in that week". Whether the records in a bucket are complete or only partial, saveslot does not judge ("there should be a record every day" is domain knowledge); to let the caller tell the two apart, the rule includes coverage columns, such as the number of days with records `count(DISTINCT <date field>)` and the first and last dates `min` / `max`, and the reading side judges by the field descriptions. In the templates packaged with the CLI, the derived tables that bucket by time carry these columns ([`../06-cli.md`](../06-cli.md) 3.1).
- **The same holds for an ungrouped overall aggregate**: when after `WHERE` there is not a single input row (the table is empty, all rows are revoked, or all are filtered out), there is no derived row, and this one and only partition is treated as empty; when there is input there is exactly one row, even if the result of each aggregate is 0 or empty (for example no row matches `count(*) FILTER (…)`). A database returns one row for an overall aggregate over empty input all the same; this is deliberately different here: after the slot is created and before the first write there is no such row to begin with, and after everything is revoked it returns to the same state. When `HAVING` is false there is likewise no derived row. The `partition_id` of this partition is registered when there is input for the first time and reused afterwards.

### Catalog

**saveslot provides a queryable catalog (like `information_schema`), from which the agent learns which base tables and derived tables exist.**

- **Compiled at definition time**: the agent submits the base table schema + the derivation rules (SQL + one required description per derived field). saveslot parses the SQL,
  checks it against the allowlist, trial-runs it on the existing data, infers the columns and types of the derived table, works out the dependencies, and returns the complete definition of the derived table to the agent;
  errors are returned here too (such as "line 3 uses the disallowed function `NOW()`").
- **Layered discovery at use time**: MCP and the API provide three tiers: "list" (`list`: the list of slots and tables, table name + a one-sentence description + the table's aliases, with derived tables marked "derived · read-only"),
  "view one table" (`table`: columns, types, descriptions, aliases of the table and fields, the precision of `decimal` / `quantity` fields, the original text of the rule, dependencies, profile; the precision is given, because the agent should know before writing that values will be rounded), and "full schema" (`schema`: the complete schema document of a slot unchanged, with the slot policy; `base_version` is already filled in, and after editing it can be handed straight to `schema_draft`, see "Schema document format"). List first, then expand on demand, without stuffing the whole catalog into the context. Aliases, like descriptions, are untrusted text written by the schema author; they are used only to help the agent match the user's wording to names, and take no part in name resolution (see "Schema document format").
- **Scale hint**: in the profile of "view one table", when the row count of the table exceeds the comfortable line, it carries `profile.scale`: above the comfortable line and not above the tested line is `large`, above the tested line is `beyond_tested`, and the values of the two lines are given. The lines are computed per table, with one set per backend, and are released with the kernel version (see the architecture document, "Capacity limits and measured values"). It is computed at read time from the current row count, does not enter events, and is not a data flag; the "list" tier does not carry it. A derived table is judged by its own row count. It only states a fact and does not reject writes.
- **Reads and writes are consistent, and writes come with guidance**: base tables and derived tables are read with the same way of querying; writing to a derived table gets a clear error,
  such as "weekly_mileage is a derived table, read-only; write to the base table runs".
- A community SKILL can add notes on what a derived table is for; the authoritative information is the saveslot catalog.
- **How a party that read a derived value learns that it no longer holds**: in the first version, correction impact queries and premises do not cover derived rows, and the `changes` of `history` does not target derived tables either. The way to do it is to query `changes` on the base tables that this rule aggregates, with `since` set to the operation number in that read result (do not use `my_last_read`: a party that only read the derived value has no read record on the base table, and would get `read_first`); if there are changes, read the derived value again. Or simply read it again. Which base tables a rule depends on is given in the dependencies shown by "view one table".
- **Visible range**: the catalog lists only the tables visible to this call; a derived table is visible if and only if all the tables and fields it depends on are visible (see "Reads · Visible scope").
