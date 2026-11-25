# 09 · Schema evolution

> Translated from docs/zh-CN/guide/09-schema.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

In the earlier chapters, which fields `expenses` has and how `monthly_total` is computed were simply given. This chapter explains where they come from: what a schema is, who writes it, how the data follows when a schema changes, and how the rules of derived tables are executed.

> This chapter covers the complete design and marks on the spot what the first version does not do. In the first version, schema changes cover only the kinds that need no model.

## 1. What a schema is, and who writes it

**A schema is the data definition of a slot: which tables there are, the type and unit of each field, which fields are required, and by what rule each derived table is computed.** It is a JSON document.

saveslot has no built-in domain. What bookkeeping, health or project tracking looks like is described by the schema. A schema has three sources:

- **The user's own**: drafted by the user's agent. Each person can have their own data shapes.
- **Official**: curated schemas published by saveslot, which are also a public convention: a dashboard that reads budgets or a tool that computes nutrition intake can recognize that "this slot conforms to it" and read the data by its definition (section 8).
- **Community**: published together with usage instructions for agents (in the agent ecosystem such instructions are called a SKILL: a piece of text plus optional scripts, loaded by the agent's host). The schema defines what the data looks like; the usage instructions tell the agent when to write and how to use it.

> The few templates bundled with the command-line tool (running, budget, daily spending) are **not official schemas**. They are ordinary user schemas: when a slot is created, one is copied over, and once the slot exists it has no relation to the template; upgrading the command-line tool and changing its templates does not affect slots already created. The first version only reserves a place for official schemas and does not implement them (section 8).

That ledger's schema looks like this (it is the content of the daily spending template):

```json
{
  "slot": "ledger", "base_version": null, "timezone": "Asia/Shanghai",
  "tables": [
    {
      "name": "expenses", "kind": "base", "description": "One row per expense",
      "time": { "type": "event", "field": "date" },
      "fields": [
        { "name": "date", "type": "date", "required": true, "description": "The day of the expense (a calendar day in the slot's time zone)" },
        { "name": "category", "type": "text", "required": true, "description": "Category, such as dining or transport" },
        { "name": "amount", "type": "quantity", "unit": "CNY", "required": true, "min": 0, "description": "Amount" },
        { "name": "note", "type": "text", "description": "Note" }
      ],
      "duplicate_keys": [["date", "category", "amount"]]
    },
    {
      "name": "monthly_total", "kind": "derived", "description": "Monthly spending total and record coverage. A month with no row means no spending was recorded in that month",
      "rule": {
        "sql": "SELECT date_trunc('month', date::timestamp)::date AS month, sum(amount) AS total, count(DISTINCT date) AS days_recorded, min(date) AS first_date, max(date) AS last_date FROM expenses GROUP BY 1",
        "time_dependency": "bucketed"
      },
      "fields": [
        { "name": "month", "description": "First day of the month" },
        { "name": "total", "description": "Total spending of the month (CNY); includes only recorded spending" },
        { "name": "days_recorded", "description": "Number of days in the month with spending records (not every day has spending, so fewer than the days in the month does not mean something was missed)" },
        { "name": "first_date", "description": "Date of the first record of the month" },
        { "name": "last_date", "description": "Date of the last record of the month" }
      ]
    }
  ]
}
```

A few points to notice when reading this document:

- **`timezone`** decides how "which day" is computed. `date` is a calendar day in this time zone.
- **`time`** declares the table's time type (chapter 7).
- **Every table and every field has a required description.** It is written for the agent: the agent relies on these descriptions to understand the data.
- **`duplicate_keys`** is the criterion for a suspected duplicate: same day, same category, same amount. A hit only flags the row; it does not reject the write.
- **A derived table has only a rule and a description for each field.** The type and unit of each field are inferred by saveslot from the rule.
- **`time_dependency`** states how the rule relates to time, which decides whether the result can be computed in advance and stored. It has three values: `none`, the result does not depend on time; `bucketed`, the result is bucketed by valid time (here by month), each bucket is computed and stored, and recomputed only when the base data changes; `now`, the result depends on "today" (for example "budget left this month") and changes as the day passes, so it is computed on every read (chapter 7, section 14).
- **`days_recorded`, `first_date` and `last_date` are coverage columns.** Does "89 yuan spent in November" mean the whole month was recorded, or only three days? saveslot does not judge: which days "should" have records is domain knowledge. The coverage columns lay the facts out and let the reading side judge (section 7).

Tables and fields can also carry two things not used in this document:

- **`aliases`**: other names the user has for this table or field; see the "Aliases" subsection below.
- **`external_key`**: used only on event tables and timeless tables. It declares which fields are the record's identifier in the source system (for example `["origin", "external_id"]`). A program that syncs data on a schedule from a wristband or a bookkeeping app (a connector) writes by it: if the record already exists, saveslot decides from the value handed over last time whether to update it; if not, it adds it, and repeated syncs create no duplicates (chapter 5, section 3, "Syncing by external key: writing without having read").

### Field types, units and precision

The field types are: text, integer, decimal, boolean, enum, date, timestamp with time zone, quantity with a unit (`quantity`), and a reference to a table of the same slot (which may be the table the field is in).

**`quantity` is a number with a unit.** The written value carries its own unit, and units of the same kind are converted automatically to the unit the field declares. Units come from a **fixed vocabulary**: length, mass, duration, volume, energy and so on, each unit having a code (`km`, `kg`, `min`) and a conversion factor. `ug` (microgram) and `floz` (US fluid ounce), which records such as nutrition and medication need, are also in it.

- **Units outside the vocabulary are not accepted.** If a draft uses one, compilation rejects it and offers candidates of the same kind. For a quantity that truly has no suitable unit, use a plain decimal field and state the unit in the description.
- **Only units whose meaning is the same everywhere are accepted.** Every row of the vocabulary is a promise that "saveslot guarantees the conversion is correct". So cups and tablespoons are not accepted (a cup is anywhere from 200 to 250 milliliters depending on the place), imperial fluid ounces are not accepted (they differ from US ones by 4%), and the international unit IU is not accepted (the conversion differs for each substance). Such quantities are written as `mL` or as a plain decimal, and the user's own words ("two cups") stay in the evidence.
- **Currency is a special case**: each currency is a kind of its own, and they are not converted into each other, because an exchange rate is not a fixed factor. Writing US dollars to a CNY field is rejected. To convert, write the exchange rate in as base data and compute with it in a derivation rule.
- **Months and years are not units**: they are not of fixed length.

**Precision and rounding.** Each field with a fractional part has a precision: how many digits to keep after the decimal point (`scale`) and how to round (`rounding`). It can be declared on the field; when it is not, currency uses the smallest unit in common use (2 places for yuan, 0 for yen), everything else defaults to 6 places, and rounding defaults to round-half-up. A written value is first converted to the field's unit, then rounded to the precision, and then recorded; when digits beyond the precision are rounded away, the receipt says so. "Whether two values are the same" is also compared after rounding.

### Naming rules

Slot names, table names and field names use only letters, digits and underscores, start with a letter, and are at most 63 characters long. This way they can be written directly as identifiers in read-only SQL. Names are case-insensitive: a slot cannot have both `Runs` and `runs`, and SQL accepts either spelling. A few names are reserved by saveslot itself: they cannot start with an underscore; a field cannot be named `valid`, `valid_from` or `valid_to` (the parameter names that denote the valid interval in writes and queries), nor `row_id` or `entity_id` (the ID columns of rows and entities in SQL). Descriptions and aliases are not subject to this restriction and may be written in Chinese.

### Aliases

The user says "food money" while the table is called `expenses`; the user says "time taken" while the field is called `duration`. A name is an identifier for programs, and users do not speak in it. Tables and fields can carry a set of aliases that record how the user puts it:

```text
{ "name": "expenses", "aliases": ["spending", "outlays", "food money"], … }
```

Aliases appear in the catalog, and an agent reading the catalog uses them to match the user's wording to a table. There are three rules:

- **An alias is not a name.** Requests and SQL recognize only names; writing an alias reports "no such table", and the error puts the name that the alias matches first among the candidates, so the agent can correct itself in one step. Aliases do not take part in resolution for these reasons: aliases can repeat (what users say is ambiguous to begin with) while names must be unique; and if changing an alias could make the same request land on a different table, "changing only a description" would no longer be a safe change.
- **It must not collide with a name that is still recognized.** A table's alias cannot equal the current name, or a former name still recognized, of any table in this slot; otherwise an agent writing by the alias would have its request land on another table.
- **It is untrusted text**, like a description: when read out it is wrapped in the untrusted boundary, it does not go into tool descriptions, and it is not removed by privacy deletion. So do not write a user's private words as an alias.

Each object can have at most 8 aliases. Changing an alias takes effect automatically, like changing a description (section 2).

### Which fields are judged for conflict together

Chapter 5 explained that concurrent writes are merged by field. When fields are related, this can produce a combination nobody wrote (a start date later than the end date). A table can declare `together` to put related fields into one group:

```json
"together": [["start", "end"]]
```

Fields in the same group are treated as one whole in conflict judgement. When it is not declared, each field is a group of its own.

Specification: the value ranges of the types, the unit vocabulary and the default precision are in [`../spec/03-data-model/10-types-and-units.md`](../spec/03-data-model/10-types-and-units.md).

## 2. Submitting a schema

The agent calls `schema_draft` to submit the document. saveslot **compiles** it:

- parses the document and checks the types and constraints;
- parses the SQL of the derivation rules and checks it against the allowlist (the specification, "Restricted SQL": which statements, functions and operators are accepted is listed in tables, and anything not in the tables is rejected), trial-runs it on the existing data, infers the columns and types of the derived table, and works out which tables and fields it depends on;
- assigns IDs to tables, fields and rules and fills them back into the document;
- compares with the current version, decides which kind each change belongs to, and gives an impact preview.

If compilation fails it reports an error, points to the location, and produces no event. For example, a rule uses `NOW()`, or the rule above omits `::timestamp`: without it PostgreSQL picks the function that takes a time zone, and the result varies with the session time zone, so saveslot rejects it as a "function with an uncertain result" and gives the fix.

When compilation passes there are two outcomes:

| Outcome | When |
|---|---|
| Takes effect directly | A new slot (it has no data yet, so there is nothing to break); or every change in the draft belongs to the kinds that "can take effect automatically" |
| Awaiting confirmation | A "schema change" item is generated, waiting for a person or an agent to confirm |

### Which changes take effect automatically

This is decided by the slot's policy. When a slot is created, saveslot writes a default policy, in which eight kinds of change take effect without confirmation:

| Change that takes effect automatically | Why it is safe |
|---|---|
| Adding a base table | Does not touch existing data |
| Adding a derived table | Only one more thing is computed |
| Adding an optional field | In old rows this field is empty |
| Changing only descriptions and aliases | Does not touch the data |
| Renaming a name nobody else is using | "Nobody is using it" means that in the last 30 days no connection other than the submitter has read or written it |
| Relaxing a constraint (required to optional, a wider range, a value added to an enum) | The old data all satisfies it |
| Changing the criterion for suspected duplicates | Affects only rows added afterwards |
| Changing the structure of a table that has never been written and that nobody else is using | There is no value to lose and no value to convert (section 4, "When the table has never been written") |

What they have in common: they do not change existing values, do not make writes that carry an old version fail, and do not make existing reads see something different. **If even one item in a draft is not in this list, the whole draft goes to awaiting confirmation.**

> The first version has no operation for changing the slot policy; every slot uses the policy written when it was created. The policy is written in the log and does not change with the kernel: if a later default policy adds kinds, it applies only to slots created afterwards.

### How to submit a change

**Within a table, hand in the whole table; within a slot, hand in only the changes.** The draft lists only the tables to create or change, and gives the complete definition of each listed table; tables not listed stay as they are. What the agent reads is the whole definition, so handing it back after the edit is the most natural thing, and there is no incremental-operation syntax to learn.

The draft carries `base_version`: the version it was drafted from. If it does not match the current version it is rejected, and a new draft based on the new version is required. A slot can have only one change in progress at a time.

### Names and IDs

The agent writes with names; saveslot assigns IDs. **Fields are identified by ID, and the name is only a label.** An ID that has been deleted is not reused.

This raises a question: when a field is missing from the submitted document, was it renamed or deleted? saveslot does not guess; the rules are deterministic:

| Field in the submission | How saveslot handles it |
|---|---|
| Carries an ID | Matched by ID. If the name differs, it is a rename |
| No ID, and the name equals an existing field | The same field |
| No ID, and the name is new | An addition |
| An existing field is not matched and is not listed in `drop_fields` | Error: "This field did not appear; to rename it, pass back the ID; to delete it, list it in `drop_fields`" |

So an agent that does not rename never has to deal with IDs, and leaving out a field is not taken as a deletion. **A deletion must be explicit.**

## 3. Versions are immutable

Every schema change produces a new version. The version number is an integer that increases within the slot; it is the `sv` that has appeared all along.

**An old version is never modified.** This guarantees that data is not quietly reinterpreted:

- The event of each write records the schema version it used.
- A read at a point in time interprets the data with the version in force at that time.
- A read record also records the schema version.

**Only the latest version is visible outside.** Each time an agent reads, it gets the current schema and so follows along naturally. Old versions are kept internally, for reads at a point in time.

Two accompanying rules follow:

**A read result explains itself.** Every value carries its unit, and the result carries the schema version. If an agent's memory still holds an old impression such as "the amount field is called `amount` and the note is free text", it can see from the result that this has changed.

**A write with an old version number is rejected only when it writes to an incompatible field.** A write carries `sv`. If the fields it wants to write have changed incompatibly since that version (the type was changed, another kind of unit was substituted, or the field was deleted), it is rejected with a hint to read again. If the fields it wants to write have not changed, or have only been renamed, or other optional fields were added to the table, it is accepted as usual. Changing the unit within the same kind (kilometers to miles) is also not incompatible: the written value carries its own unit and saveslot converts it. Tightening a constraint does not count either: a write is always validated against the current definition, and a value that does not satisfy it gets a validation error. One exception is stricter: if a table that has never been written had its structure changed as a whole (section 4), any later request that writes this table with an old version number is rejected, with a hint to read again.

The reason for the second rule: versions are managed per slot. If versions were cut off by version number alone, changing any one table in the slot would make every agent's writes be rejected for a round. Judging by field affects only the writes that are really affected.

After a rename, the old name still works for a while: a write resolves names by the `sv` it carries and accepts the names of any version; a read that carries no version accepts old names used in the most recent 10 versions, and the receipt points to the new name. When a name is changed, the old name does not automatically become an alias; if you want people and agents to still recognize the old wording long afterwards, write it into `aliases`, which only helps match the wording and does not restore resolution.

## 4. Three kinds of change

When a schema changes, the existing data has to follow. The cost has three tiers:

| Kind | How the data changes | Needs a model | First version |
|---|---|---|---|
| Metadata only | Existing values do not change | No | Yes |
| Deterministic conversion | A deterministic function computes the new value from the old one | No | Yes |
| Re-extraction | Go back to the original text of the source data and derive the new value again | Yes | No |

Which kind applies is decided by saveslot and listed item by item in the compilation receipt. (Creating a new slot or adding a table has no "existing data", so it belongs to none of the three kinds and is listed separately in the receipt as "new".) When designing a schema, try to keep changes within the first two kinds. The specification has a complete table that lists, for every key of the schema document and every kind of change to it, which kind it belongs to, whether it takes effect automatically, whether a write with an old version is still accepted, and whether the first version supports it ([`../spec/03-data-model/07-schema-evolution.md`](../spec/03-data-model/07-schema-evolution.md), "Kinds of change and means of migration"). A few examples of each follow.

### Metadata-only changes

**Example 1: add an optional field.** Add `payee` to `expenses`. In old rows this field is empty.

**Example 2: rename.** `note` becomes `memo`. The field ID does not change, and the column name in storage uses the ID, so not a byte of data moves; only the name in the catalog changes. If another connection has recently read or written it by the old name, it is listed in the preview and needs confirmation.

**Example 3: delete a field.** List the field in `drop_fields`. The field and its data in the table are deleted; the source data is untouched. Deleting a field needs confirmation (except when the table has never been written; see the end of this section). A field that is used elsewhere (a derivation rule, `entity_key`, `duplicate_keys`) cannot be deleted directly; the places that depend on it must be changed in the same draft.

**Example 4: delete a whole table.** List the table name in the slot-level `drop_tables`, which also needs confirmation. After that the table disappears from the catalog of the current version and can no longer be read or written, and a request that writes it with an old version number is rejected. Its source data is untouched (those words are still there and can be viewed and privacy-deleted as usual), and the events about it are all still in the log; a read at a past recorded time can still show how it looked then. A table that a reference field of another table points to cannot be deleted directly; the fields that reference it must be changed in the same draft.

### Deterministic conversions

> The first version does not yet support migration expressions: a field that carries `migrate`, or a `backfill` written as an expression, makes the whole draft report `not_in_this_version` (see [Scope of the first version](../spec/07-scope-v1.md)). Conversion between units of the same kind, changing precision and filling with a constant work as usual. The example below describes the complete design.

**Example: text becomes an enum.** `category` used to be free text, and now we want to normalize it to a few fixed values. The agent writes a migration expression on the field:

```json
{ "id": "f2", "name": "category", "type": "enum",
  "values": ["food", "transport", "other"], "required": true, "description": "Category",
  "migrate": { "sql": "CASE category WHEN '餐饮' THEN 'food' WHEN '交通' THEN 'transport' ELSE 'other' END" } }
```

The expression is restricted SQL with a deterministic result. saveslot compiles it, trial-runs it on the existing data, and puts the results and the failing samples into the preview.

> A migration expression can use only this field's own old value and constants; it cannot refer to other fields (the example above uses only `category`). It is evaluated only where there is a value: an optional field that was cleared, or never filled in, is still empty after the conversion and does not fall into the `ELSE` branch. The reason is in the next paragraph: a migration converts the old writes one by one, and a write remembers only the fields it changed. When the expression depends only on this field, each change an old write made to this field turns into exactly one change in the new version, and who wrote it, which sentence it came from and which period it covers are all carried over unchanged; depending on other fields cannot do this. To merge several fields into one new field, the first version uses a derived table, or has the agent read the values out and write them again.

**The result of a conversion is not written into the log.** What the log records is the conversion rule itself (it is part of the compiled schema definition). When the log is replayed later, saveslot converts the old writes again by this rule. Because the rule is deterministic, the recomputed result is the same as before; to be able to notice "in case it is not", the event that switches to the new version records the row count and a checksum of each new table, and replay checks them. This is the same approach as for derived tables: what can be computed is not stored in the log, only a checksum for checking.

A change between units of the same kind (for example kilometers to miles) needs no expression; saveslot converts automatically. Changing the slot's time zone also belongs here: the dates themselves do not change, and what must be rebuilt are the derived tables that assign a timestamp to a day by time zone; it needs confirmation because the meaning of "today" and "which day" changes afterwards.

**Tightening a constraint** is also handled here: when an optional field becomes required, or a range is narrowed, some existing rows may not satisfy it. A field can be given a `backfill` stating how to fill those rows; if none is given and some rows do not satisfy the constraint, compilation fails and reports how many rows and what they look like. `backfill` can be an expression or a constant (the first version accepts only constants). An expression is computed only where a value already exists; places that had no value to begin with (when a required field is added, all old rows are like this; when an optional field becomes required, the rows never filled in are too) can only be filled with a constant, so both of these changes must always give a constant, even if the table has no row at all right now; a constant and an expression cannot both be given. A value filled in this way has its provenance recorded as "the backfill of schema version N": it is not anything anybody said, so it does not disappear when some sentence is deleted. And because it is not the user's content, privacy deletion does not count it when it judges "whether this row still exists": a row of which only the backfilled constant is left is still deleted as a whole row (chapter 8, section 4). Two more points: a backfill fills only rows that exist, and does not fill revoked rows or the blank left by a revocation (the "required" constraint governs rows that exist); the version produced by a backfill cannot be undone, and to change it you submit a new schema draft.

### Re-extraction

**Example: split a field.** In `note` the user wrote "at the noodle place downstairs with Lao Wang", and now we want to split it into `payee` and `companions` (the people along). There is no deterministic function for this; the only way is to go back to the original words and understand them again. This is the only truly new migration method in saveslot, and also the most expensive one. Section 6 covers it separately.

> Re-extraction is not in the first version; it is the first increment after the first version, and the event format has left a place for it.
>
> If a draft in the first version contains the key that denotes re-extraction (or another change the first version does not support, such as changing the time type of a table that has been written), **the whole draft is rejected with an error** that names the key. It is not quietly treated as "just add an optional field": the agent would then think the old rows will be filled in later.

### When the table has never been written

Some changes are not supported on a table that has been written, because there is no general way to convert the existing values: changing the table's time type (event to state), changing `entity_key`, changing `granularity`, changing a base table into a derived table, changing the target of a reference field, and replacing the set of external keys. But a table drafted by an agent often turns out to have the wrong time type only after it is built, and at that moment there is not a single row of data yet.

So these changes can be made on a table that has **never been written**, in place, without deleting and rebuilding it. On the same table, the changes that normally need confirmation (deleting a field, changing a type, changing a unit, adding a required field) are handled in the same way. "Never been written" looks only at the log: the table has never had a single write event. After one write it no longer counts, even if all rows have been revoked and all content has been privacy-deleted: the history and the events are still there, and if the structure changed they would have nowhere to go. Only having been read (a read that returned an empty result) still counts as never written.

Such a change needs confirmation when someone else is using the table; when nobody else is (in the last 30 days only the submitter has read or written it), it takes effect automatically, which is the eighth kind in the table of section 2. After the change:

- The table ID, field IDs, descriptions and aliases are all kept, and derivation rules that depend on it are recompiled against the new definition.
- The receipt always records the kind of such a change as "metadata only": the table has no values and there is no conversion.
- Adding a required field, or changing optional to required, still needs a backfill in the form of a constant: this rule does not look at whether the table has rows (the "Deterministic conversions" subsection above).
- A request that writes this table with an old version number is always rejected (section 3).
- If the table is written after the draft is submitted and before it is confirmed, the confirmation is rejected, and the only way out is to submit a new draft to replace it. Once "never been written" no longer holds, it never holds again.

The cost is that a table that has had a single piece of test data written can only be deleted and rebuilt. In the specification's table of change kinds, these rows say "Yes when the table has never been written" in the "first version" column.

## 5. The migration process: reads never stop

> **0.1.0 does not yet provide migrations that need a physical table rebuilt**: drafts that add a field, delete a field, tighten a constraint, change precision or change a unit on a table that has been written can be submitted and previewed, but cannot yet take effect, and confirmation reports `not_in_this_version`. Changes that touch only the catalog, and changes to a table that has never been written, take effect as usual in 0.1.0 ([`../spec/07-scope-v1.md`](../spec/07-scope-v1.md), section 7). The background build and switch described in this section are the design of such migrations.

After a change is confirmed, how does the data go from the old structure to the new? saveslot's way is: **build the new version in the background, catch up, then switch once.** Throughout the process reads do not stop, and writes pause only for the instant of the switch.

### The state machine

```
draft → awaiting confirmation → migrating → switch → current → retired
```

| Stage | Reads | Writes | What is going on |
|---|---|---|---|
| Draft to awaiting confirmation | Old version | Old version | The new version is only a proposal. It does not expire; a newly submitted draft supersedes an older draft that has not been confirmed |
| Migrating | Old version | Old version | In the background the tables of the new version are built from the log, and the new writes made in the meantime are continuously caught up |
| Switch | Not interrupted | Paused for a very short time | In one transaction the last stretch is caught up and the "current version" is pointed at the new version |
| Current | New version | New version | |
| Retired | Not visible outside | Not writable | Kept internally, for reads at a point in time |

The compilation described in section 2 happens at the "draft" step, and compilation and the impact preview are one step. A draft that can take effect automatically skips "awaiting confirmation"; a change that only renames or changes descriptions and needs no new table skips "migrating" and switches directly.

Every state change is a log event. The compiled definition is also recorded in the event and is not recompiled on replay.

### How it is done physically

- **Every slot has a "current version pointer".** All reads and writes go through saveslot, which resolves the logical table name to the physical table the pointer points at.
- **Whether a new table is needed depends on whether the physical shape changed.** A change that only renames or only changes descriptions leaves the table on disk looking the same, so no new table is built; only the catalog and the pointer change. Adding a field, deleting a field, or changing a type or unit changes the physical shape, so a new physical table carrying the new version number is built for that table. A table that has been built is never renamed; tables that did not change are reused across versions. Physical table names and column names are all IDs and are never exposed.
- **The new version's tables are built by replaying the log into the new structure.** Each old write carries over only the fields it changed, and through the deterministic conversion becomes a new value. This incidentally verifies that "the log can rebuild the state". An individual's data volume is small, and taking this one path throughout is steadier than handling cases separately.
- **The switch is one transaction**: lock the pointer, catch up the last stretch of the log, verify, change the pointer, and record a switch event. Reads do not take this lock and are not affected at all.

What is used here is saveslot's own log, not a database's online schema-change tool. Those tools solve "both the old and the new version are writable at the same time" and "catching up with the database's log", and saveslot needs neither.

### Failure is safe

Before the switch, the new version exists only in the background. If it fails, the whole thing is thrown away and the old version is not affected at all. After the switch, only forward migration is done, and there is no switching back.

While waiting for confirmation and while migrating, the old version stays writable as usual, and a newly written value may make the conversion expression impossible to compute (for example, when converting text to a number, a "fifteen" written in words arrives). There is a handling for each of the two points: at confirmation, saveslot in the same transaction computes again over the new writes made since the trial run, and if any cannot be computed it rejects this confirmation, the item stays open, and you fix the expression and submit the draft again; while migrating, a write that carries an old version number is computed by the new version in its own transaction, and if it cannot be computed the write is rejected with a hint to read again by the new version and write again. A migration that has been confirmed should not be held up by a later write; a value that cannot fit in the new version anyway is better rejected on the spot than quietly dropped at the switch.

The new-version tables under construction are state of kind (c) described in chapter 3: they can be thrown away and rebuilt from the log. This is the one exception to "a table can be changed only by `apply`"; it formally becomes state computed from the log only at the switch event.

### A privacy deletion confirmed halfway through a migration

A deletion event counts only for the result in the current version. In the new-version tables being built in the background, the affected rows are dropped whole and rebuilt from the log. By then the deleted content can no longer be read in the log, so what is rebuilt naturally does not contain it.

> The retired old-version tables are kept throughout the first version, and cleanup is left for later. The cleanup itself will also be a log event, so that "replaying from an empty database equals the online state" also holds for the old tables. Privacy deletion takes effect on old-version tables as well.

## 6. Extraction jobs: migrations that need a model

> This whole section is not in the first version. Only the main points are given here; for details see the specification.

**Why the caller's agent does it.** Re-extraction needs an understanding of language and so needs a model. saveslot's core path does not call a model; this is the principle of chapter 1. So saveslot makes this work a **job** and hands it to the caller to execute: the user's agent is already running a model and also has permission to read the data. saveslot sets the questions, checks the answers and records the results. The interface does not distinguish who executes; once the user authorizes calling a model in the future, a background executor that calls a model can plug into the same interface; like the user's agent it writes through the contract and is not inside the kernel.

**How it works.** The agent claims a batch of **work items**, gives a result for each and submits it; it is fine not to finish, because the old version stays readable and writable as usual, and any caller with permission can pick up afterwards. A work item is not "extract the source data again from the beginning" but **translating, one by one, the writes that touched the fields to be re-extracted into the shape of the new version**, after which saveslot replays them in the original order. This keeps the history as it was: a write that was a correction is still a correction after translation; row IDs do not change; the valid intervals of state tables do not change.

**The translation results are recorded in the log.** This is the difference from a deterministic conversion: the output of a model is not deterministic, and replay cannot call the model again, so the result is recorded as a fact.

**The result is a proposal, not a verdict.** When a new field is extracted from an old field, the "old value → new value" of every row goes into a difference list; when the same field is re-extracted, those that differ from the confirmed value go into the list. The list is handled by a person or an agent (accept all, accept or reject row by row, or give the value directly), so that an inferred value does not silently take the place of a value the user confirmed. If the new field was empty to begin with (a pure fill-in extraction), it does not go into the list and takes effect directly. If during the migration a write touches a field that is being re-extracted, saveslot appends work items automatically, and the difference already listed for that row is voided and listed again after the re-extraction.

**Not letting a migration stop halfway.** When there are many differences and the person handling them does not come for a long time, there are two exits: treat all unhandled differences as rejected and then switch; or abandon this migration and leave the old version as it is. A migration with no difference list (only deterministic conversions, or those plus pure fill-in extraction) does not wait for anyone: once the deterministic part is done it switches, and any fill-in extraction not yet complete continues after the switch.

## 7. Derivation rules

### Derived tables are generated only by rules

`monthly_total` is not written by an agent; saveslot computes it by the rule in the schema. An agent that writes to a derived table gets a clear error and is told which base table to write to.

What this constraint buys: derived data can always be recomputed from the base data. So derived data never gets in the way of deletion, needs no history of its own, and has complete provenance, because the inputs are decided by saveslot itself.

Rules come in three levels:

| Level | What it is for | First version |
|---|---|---|
| Restricted SQL | The vast majority of aggregations, joins and time windows | Yes |
| Pure functions in a sandbox | Deterministic algorithms that are too convoluted to write in SQL | No |
| Model judgement (things like "too much training this week") | This is not a derivation rule: it is an ordinary write made by a saveslot background process, and is treated as "agent inference" | No |

The criterion for the levels is whether the result is deterministic: only a deterministic result can serve as a cache and be recomputed at any time; a non-deterministic one must be recorded as a write.

### Rules must be deterministic

When the same log is replayed on the local embedded database and on PostgreSQL on a server, the derived results must be identical row by row. For this:

- only functions with deterministic results on the allowlist are permitted;
- the session time zone and the collation are fixed;
- numbers use the exact decimal type throughout, not floating point;
- functions such as `NOW()` are disabled; "today" is taken once by saveslot at the call entry (a read can also specify it with a parameter) and passed to the rule as an explicit parameter (chapter 7);
- only the tables of this slot are read. (A read-only query can join tables of several slots; a derivation rule and a reference field cannot.)

Which statements, functions, operators and type conversions the allowlist accepts is listed item by item in the specification, "Restricted SQL". It is written as "anything not in the table is rejected", not as "a list of what is rejected". The allowlist has versions: each rule records the version it was compiled with, and replay computes by the recorded version; a kernel upgrade does not make a rule that was not changed use a different algorithm.

A computation that needs external data, such as currency conversion, is not derivation. First write the exchange rate in as base data, then use it in the rule.

**Counting by a reference field counts rows that point to a revoked record.** The tables a rule reads contain only rows that are not revoked, but if a row is not revoked while the row it references is revoked, it is still in the table, and the referenced value is still the original ID. For example, if you count "how many meals in a day" by the `meal` field of the detail rows, and a meal is revoked but its detail rows are not, that meal is still counted. To exclude it, the rule joins the target table and takes only rows that find a match: the revoked row is no longer in the target table. saveslot gives no separate warning for this.

The unit and precision of a derived field are inferred by saveslot from the rule: sum, maximum and minimum follow the input field's; when two fields with units are multiplied or divided and no unit in the vocabulary results, it reports an error and requires the result to be declared as a plain decimal with a description.

### Refreshed in the same transaction

**The base write and the affected derived values are updated in the same transaction.** So a derived value that is read never lags behind the base data. The "derived write" event that follows every write in chapter 2 is exactly this.

The refresh is straightforward: **recompute the affected group.** When a rule is compiled, saveslot analyzes what it groups by. If the amount of one expense changes, only the month it is in is recomputed. If what changes is the date, moved from November to October, both months are recomputed.

No dedicated incremental-computation engine is used. Data is isolated per user and small. In early measurements, a whole-user recomputation of 1 million rows on the embedded database took about 290 milliseconds, and recomputing only the affected week took about 1.7 milliseconds, both small enough to fit in the same transaction. The threshold for write admission is set by an experiment (experiment 4 in chapter 12); how large a table can get while still being comfortable is measured by the capacity experiment (experiment 9).

> The first version requires the outermost level of a derivation rule to be a grouped aggregation (each group corresponds to exactly one row in the derived table), or an ungrouped overall aggregation (the whole derived table has only one row), so that every derived row has a definite identity. The analysis of the recomputation scope recognizes only grouping by field and bucketing by valid time; when the inner level of a rule has a window function or joins other tables, every base change recomputes all groups of that rule.
>
> For a rule that reads the "current value" of a state table, or a rule that depends on "today", the result changes as time passes, so the first version always computes it at read time and does not cache it (chapter 7). Such a derived value has no stored version, so the read result does not carry `ver` and carries a "computed at read time" mark instead.

**The identity of a derived row is opaque.** The group key "2026-11" is computed from the user's data, and when grouping by category the category name is text the user wrote. So saveslot assigns each group an opaque ID, and only that is used in event headers and read records; the group key value itself is a content block, and it is cleared together when the group becomes empty through deletion. After a group becomes empty (all its rows revoked, moved to another group, or deleted), if the same group key gets rows again it reuses the original ID, so the read records of those who read this group still connect.

### Periods with no record, and periods only partly recorded

A grouped aggregation produces no row for a group that has no input. So there is no October row in `monthly_total`, which means that not a single spending record exists for October, not that October's total is 0.

Harder to tell is the partly recorded case: "89 yuan spent in November" might mean the whole month was recorded, or only three days. saveslot does not judge this for you; "which days should have records" is domain knowledge. The way is to include **coverage columns** in the rule and lay the facts out: the number of days with records (`count(DISTINCT date)`), and the dates of the earliest and the latest record (`min`, `max`). The reading side judges by the field descriptions: if the number of days equals the days the month should have, it is complete; if fewer, the first and last dates show whether the gap is at the start, at the end or in the middle; while the current month is not over yet, how far `last_date` is from today shows whether it is "not yet" or "not recorded". The rule for the coverage columns does not refer to "today"; otherwise this table would become computed at read time and could not be cached.

In the templates bundled with the command-line tool, every derived table bucketed by time carries these three columns (the example in section 1 does).

### Admission of writes and large-write jobs

Refreshing in the same transaction has a cost: when one write affects too wide a range, the refresh takes a long time and blocks the other writes of this tenant.

So before a write is executed, saveslot first estimates how many rows it would affect. If it exceeds the threshold, the write is rejected, and the caller is told "about this many rows affected; split into batches of no more than this many rows".

Some writes cannot be split, such as importing a year of data at once. In the complete design this becomes a **large-write job**: the request is accepted, a job ID is returned, it is processed in the background, and it takes effect at once on completion. During the job, the affected derived values keep their old values and carry a "pending refresh" mark, which comes out with the read.

This is a relaxation of "derived values never lag", with a very narrow scope: only during the job, only for the affected derived values, and always marked. The acceptance, completion and failure of a job are log events.

> The first version has no large-write jobs. A write over the threshold is always rejected, and the caller splits it into batches. That is, in the first version derived values are not allowed to lag, which is stricter than the complete design.

### How a derived value comes about

saveslot records which base tables each derived refresh read and which group was refreshed. That is enough to support two things:

- **Deletion cascade.** When base data is deleted, the affected groups are recomputed. A derived value that came only from the deleted data disappears naturally, and one that has other sources naturally no longer depends on it.
- **Impact of a correction.** From a corrected base version, find the derived values that used it.

The finer "which expenses make up this month's total" is not stored in advance; when needed it is obtained by rerunning the rule at the log position of the time. Storing it in advance down to the row level would make writes several times slower.

## 8. The official schema and your own schema

A user who wants to use the official bookkeeping schema and also add fields of their own has two ways:

- **Extension.** Add fields on top of the official schema, placed in a namespace of their own.
- **Mapping.** Build tables entirely in your own structure, then write a derivation rule that projects your data into the shape of the official schema. A tool written for the official schema just reads this derived table.

The second introduces no new mechanism at all: "compatible with the official schema" is simply a derived table, read-only, recomputable, with complete provenance.

Both ways first require an identifiable official definition, and also a way to declare that "this slot conforms to it". A template cannot do this: it is only a one-time copy and has no connection once the slot is built.

> In the first version the official schema is **only reserved, not implemented**: the compiled definition leaves an optional `extends` (which official definition it claims to conform to: identifier, version, content hash) and, on tables and fields, an `official` (a stable handle given by the official schema, by which upper-layer tools find a field), and no key is left for `compatibility`. If `extends` or `compatibility` appears in a draft, the whole draft reports `not_in_this_version`; templates remain ordinary schemas, and new templates such as health and nutrition will be written after the implementation exists. Adding the implementation later will only add optional keys to the compiled definition and will not change existing events. The details not yet answered are listed in the specification, [`../spec/08-open-questions.md`](../spec/08-open-questions.md), "Details of the official schema".

## Corresponding spec

| Content | Specification |
|---|---|
| The complete table of change kinds (including changes to a table that has never been written), principles, the format and examples of the schema document, aliases, external keys, field groups, naming rules | [`../spec/03-data-model/07-schema-evolution.md`](../spec/03-data-model/07-schema-evolution.md) |
| State machine, physical method, extraction jobs, official schema | [`../spec/03-data-model/08-schema-migration.md`](../spec/03-data-model/08-schema-migration.md) |
| Details of the official schema (undecided) | [`../spec/08-open-questions.md`](../spec/08-open-questions.md), "Details of the official schema" |
| Field types, unit vocabulary, precision and rounding | [`../spec/03-data-model/10-types-and-units.md`](../spec/03-data-model/10-types-and-units.md) |
| Default slot policy | [`../spec/03-data-model/01-objects.md`](../spec/03-data-model/01-objects.md), "What a slot contains" |
| Derivation rules, refresh scope, write admission, time dependency and coverage columns, catalog | [`../spec/03-data-model/06-derived.md`](../spec/03-data-model/06-derived.md) |
| Restricted SQL: statement shapes, names, time notation, allowlist, determinism and cost | [`../spec/03-data-model/11-restricted-sql.md`](../spec/03-data-model/11-restricted-sql.md) |
| Templates bundled with the command-line tool | [`../spec/06-cli.md`](../spec/06-cli.md) 3.1 |
| Schema events, the structure of the compiled definition | [`../spec/09-event-format.md`](../spec/09-event-format.md), sections 4.5, 5.5, 7 |
| Parameters and receipt of `schema_draft` | [`../spec/04-contract.md`](../spec/04-contract.md); for the types see [`../spec/04-contract-types.md`](../spec/04-contract-types.md) |
| Scope of the first version | [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md) 3.5, 3.6 |
