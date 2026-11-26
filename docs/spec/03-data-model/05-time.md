# saveslot · Data-layer mechanisms · 05 Time

English · [简体中文](../../zh-CN/spec/03-data-model/05-time.md)

> Part of the data-layer mechanisms; for the contents see [`README.md`](README.md). A section quoted in "…" in the text may be in another file in the same directory; look it up in the contents.

## Time: recorded time and valid time

**Two timelines**: recorded time (when saveslot wrote it down; maintained by the system, with no business meaning; reading as of a moment uses it) and valid time (when it happened or took effect in reality).
In most cases the two are the same moment; they diverge only when the user fills something in afterward.

Externally, recorded time is expressed as the **operation number** (see "Numbering"): a write, a resolution and a deletion confirmation each take one operation number, and all the events within one operation are, externally, the same recorded moment.

### Three kinds of table

The schema declares a time type for each table. Every base table is paired with a version table (`t__ver`: recorded per cell, where one cell is the value of one field over one stretch of valid time during one stretch of recorded time; it marks the valid interval in recorded time, `rec_from` / `rec_to`, whose values are operation numbers).

| Type | Examples | How valid time is stored |
|---|---|---|
| Timeless | Preferences, project metadata | None, only recorded time |
| Event | Runs, expenses, meetings | The moment of occurrence is an ordinary column (with a time zone, so that "which day" can be recomputed); a backdated change is an ordinary update |
| State | Budgets, goals, project status | One row = the value of one entity over one valid interval (`tstzrange` / `daterange`); `PRIMARY KEY (entity_id, valid WITHOUT OVERLAPS)` (PostgreSQL 18) |

- PostgreSQL 18 has the `WITHOUT OVERLAPS` constraint, but the syntax for "rewriting one stretch of time" (`FOR PORTION OF`) was withdrawn in 19 Beta: **the row-splitting logic is implemented by saveslot**.
- The storage layer does not automatically merge adjacent segments with the same value (to keep each segment's provenance); the query layer merges them by default (see "Queries").
- **Intervals are always closed on the left and open on the right, `[start, end)`**: the end day (or end moment) is not included. A receipt writes the range in plain language with its endpoint included ("11-02 to 11-19 (inclusive)").
- The granularity `granularity` of a state table is `date` (a calendar day in the slot's time zone) or `instant` (a moment).

### State of a state table: per field, per instant

**The state of an entity is a function from "field × valid instant" to a value or no value**, with one timeline per field. A write assigns values to some fields over one interval; how the function is split into segments physically is an internal implementation matter.

**Every mechanical judgement (stop point, same value, high-impact, conflict) looks only at this function and at "which write took effect where", never at the boundaries of physical segments.** Split any segment into two segments with the same value and the same provenance, and the conclusion of every judgement stays the same.

**Stop point**: the stop points of a field f are the two kinds of valid instant below.

| Stop point | What it is |
|---|---|
| Where the value changes | The value of f differs before and after this instant, including the boundary between a value and no value (see "Intervals without a value") |
| Corroboration endpoint | Of the start and the **explicit** end of a same-value write that explicitly points to evidence (a corroboration), the ones that fall on the endpoints of a corroboration item's interval (see "Writing with the same value"). The start is the one given or "now"; the end counts only if given, and an end resolved from a default end does not count. When one write is split into several items, each item counts for itself, and the item in the middle, whose two ends were not stated by this write, has no corroboration endpoint. The endpoint stops counting once it is **covered** (a write or a revoke that took effect afterward covers it: an item that gives a value on that field; it covers the endpoint if it contains it, judged as closed on the left and open on the right, and one that starts at that moment counts too; whether the value it gives equals the corroborated value or not), once the source of this corroboration is deleted, or once this corroboration is reverted by a revert (`undo`, take the previous value). An item that covered it stops counting as covering once it is reverted at that place; the item written back by a revert is itself an item that takes effect later: when it writes back a value it covers just the same, and when it writes back no value or restores existence it does not cover |

A physical boundary between adjacent segments with the same value is not a stop point. Stop points are per field: `owner` changing hands on 11-10 is not a stop point of `amount`.

**Contributions that give a stop point**: the "contributions that give a stop point" of an instant = **all the contributions for which that instant is an endpoint of their interval, counting both sides and counting those already covered** (when judging a stop point of a field, or an endpoint of a backfill segment, count the contributions on that field and on "existence"; when the instant is a boundary between a value and no value, also count the contributions that have it as an endpoint on the fields that "have a value" (the required fields, excluding those that were given a constant `backfill`, see "Intervals without a value"), because this boundary is given by them. **Count only the contributions before the write being resolved**: those ranked ahead of it in the order of contributions, including the earlier ops in the same request; a backfill segment goes by that switch. **And only contributions that took effect**: covered ones and ones registered as reverted at that place both count; candidates and ones awaiting confirmation do not. The interval is taken from the current state's entry for this item: at write time, the latest one in the log that gave it; in a deletion replay, its interval in this replay, including one just re-resolved). These are the ones whose interval ends at that instant and the ones whose interval starts at that instant, including a revoke that leaves an adjacent hole and the corroboration item that a corroboration endpoint belongs to. Example: `[10-01, ∞) 4000`; explicit `[10-15, 11-10) 5000`; the stop point 11-10 is given by the explicit end of the 5000 item, and the 4000 item, which gives a value afterward, has no endpoint at 11-10 and does not count. Taking it this way does not miss the origin of an endpoint: an endpoint date is either stated by a write itself (an explicit start or end) or derived from other contributions; following the derivation back, there is always a write that stated this date in its own words, and the interval it recorded has this date as an endpoint, so it is always included, with no need to recurse along dependencies. The cost is that a contribution that merely happens to have an endpoint at the same moment, and is unrelated to this stop point, is counted too, and when it is deleted one extra piece is cleared; this errs on the side of clearing more. When the default end (`next_change`), the default interval of a correction (`corrected_span`), or the end of a revoke that carries only a start stops at a stop point, the dependencies recorded in the resolution result are exactly these contributions; the two ends of a backfill segment on a state table are taken by the same rule (see "Deletion · Provenance: value source and operation source").

### Writing state: parameters and defaults

| Parameter | Required | When not passed |
|---|---|---|
| Entity, new value | Yes | none |
| Valid start `valid_from` | No | From now |
| Valid end `valid_to` | No | **Up to the next stop point** (`next_change`): for each field in the op, take the first stop point strictly later than the start; if the field has no stop point after that, it continues indefinitely |

- `valid_to` can be a date or a moment, or can be written explicitly as `"open"` (continues indefinitely); not passing it is the same as `"next_change"`. An explicit end is the same for all fields in the op.
- **When the intent is a correction (`correct`) and neither start nor end is passed**: the interval of each field = **the interval bounded by stop points that contains "now"** of that field (from the nearest stop point not later than now to the first stop point strictly later than now). What is corrected is "that fact", and the extent of the fact is this stretch. A corroboration endpoint is also a bound: if someone explicitly restated this value on some day, the correction changes only up to that point, and the receipt states which stretch was changed.
  - When only one of the start and the end is passed, the ordinary rules of the table above apply.
  - If the field has no value at the point "now": reports `invalid_argument`, with a hint to give an interval.
- **Both the original arguments and the resolution result are recorded, separately**:
  - **The original arguments are recorded in the logical write header**, as the caller wrote them: the start is "the given value" or "now", and the end is "the given value", `open` or `next_change`; the default interval of a correction is recorded as `corrected_span` for both start and end.
  - **The resolution result is recorded in the base write**, per field and per item: `[start, end)`, all concrete values, with no "not passed". The interval is part of this contribution and is deleted together with this item's value. It is stored apart from the value, and records the other contributions that were used in resolving it: when those contributions are privacy-deleted or restated, the interval is cleared on its own and given again by the deletion event (see "Deletion · Content derived from other contributions").
  - Replay follows the resolution result and does not resolve again; in a deletion replay, `next_change` and `corrected_span` are always resolved again from the original arguments (saveslot's mechanical judgements are recomputed on the state after deletion, see "Deletion · Replay rules"). The interval re-resolved is recorded in that deletion event; **the interval of a contribution is the one in the latest event in the log that gave it**, and the later `undo` and the conflict criteria all go by it.
- **The logical write header also records the moments used for judgement**: `now` taken at the entry point, and `today` derived from it in the slot's time zone at that time. "Whether it is retroactive" (the start is earlier than now) is derived by comparing them with the resolution result. Replay and deletion replay both use the recorded values and read neither the clock nor the current time zone.

**Principle: by default, do not break any known fact; overwriting an existing fact requires explicit arguments; every write states its effect in the receipt.**

**Example (single field)**: "5000 from 10-01" and "4000 from 11-10" are already recorded.

| How it is written | Result | Receipt |
|---|---|---|
| Start 11-02, no end passed | 11-02 to 11-09 (inclusive) is 3000, and from 11-10 it is still 4000 | "Saved. Note: from 11-10 it is still 4000, unchanged." |
| Start 11-02, end "continues indefinitely" | From 11-02 on it is all 3000, covering the 11-10 segment and erasing the change point 11-10 | High-impact: goes to awaiting confirmation, listing the segments overwritten |
| Start 11-02, end 11-20 | Likewise erases the change point 11-10 | Same as above, high-impact |
| Start 11-02, end 11-05 | Changes only this stretch | Lists the segments that were split |
| Intent correction, no start and no end passed (today is 11-05, value 6000) | 10-01 to 11-09 (inclusive) is 6000, and the 4000 from 11-10 is untouched | States which stretch was corrected; reads that asked about these dates are affected |

By default "up to the next stop point": a wrong guess means "changed too little" (the receipt flags it, and the agent can follow up), whereas with a default of "continues indefinitely" a wrong guess means "changed too much" and silently overwrites existing facts.

**Example (multiple fields)**: "from 10-01 `amount 5000, owner Zhang Wei`", "from 11-10 `owner Li Na`" and "from 11-20 `amount 4000`" are already recorded. Write "from 11-02 `amount 3000, owner Wang Qiang`" with no end passed:

| Field | First stop point after the start | Resolved interval |
|---|---|---|
| `amount` | 11-20 | `[11-02, 11-20)` |
| `owner` | 11-10 | `[11-02, 11-10)` |

Each of the two fields is carried up to its own next stop point. If the whole op took the same end (11-10), `amount` would return to 5000 on 11-10, producing out of nowhere a change that no one stated.

#### Intervals without a value

On a state table, an entity may have no value during some stretch of valid time: before the entity's first segment, after an explicit end, and a hole left by a revoke with an interval are all **intervals without a value**, with the same rules.

- **Definition of "has a value" at a point**: all required fields have a value in effect at that point; when the table has no required field, having a write in effect on any field at that point counts as having a value. A write that clears a field (the value is empty) counts too: clearing is a contribution that took effect, and an empty value is not the same as no value; a stretch that has only been cleared is "has a value, with empty fields", not an interval without a value. This differs from event tables and timeless tables: on those two kinds of table, clearing cannot by itself keep a row alive (see "Existence of a row or entity" under "Deletion · Replay rules"). **A field that was given a constant `backfill` (a newly added required field, an optional field changed to required) is not counted as a required field only when judging has a value / an interval without a value** (and so not in the judgement of stop points and existence either), and at write time and in deletion replay (see "Existence of a row or entity" under "Deletion · Replay rules") the same rule is used. Write validation is not affected: see the item "falls in an interval without a value" below. The exception exists only so that deleting a backfill does not create an interval without a value out of nowhere. An optional field cleared over an interval is "the value is empty", not an interval without a value; its value ↔ empty is still a value change and counts as a stop point (see "Field types, same value and units · Clearing a field").
- **The boundary between a value and no value is a stop point of every field.** A write with a default end neither enters an interval without a value by itself nor crosses over it.
- **An explicit interval that crosses an interval without a value: fill it in.** The semantics of a write is "set the value for this stretch". It makes the change points at the two ends of the interval without a value disappear, which is high-impact ① (see "High-impact writes") and goes to awaiting confirmation; the receipt and the item's effect list the filled-in interval without a value on its own line (with the revoke that left it).
- **The part of a write that falls in an interval without a value must carry all the required fields declared by the schema**, including fields that were given a constant `backfill`; otherwise it reports `validation_failed` (naming which field is missing and which interval, with a hint to supply the field or shorten the interval). An optional field that is not carried is empty. This validation depends on the current state; it runs after the conflict judgement and only on the part that is about to take effect (see "The write request · The order of judgement").

**Example**: `[10-01, 10-10) 5000`, no value, `[10-20, ∞) 4000` (`amount` is required).

| How it is written | Result |
|---|---|
| "3000 from 10-05", no end passed | `[10-05, 10-10) 3000`, the rest untouched |
| Explicit `[10-05, 10-25) 3000` | Fills `[10-10, 10-20)` and erases the two change points at 10-10 and 10-20 → high-impact, goes to awaiting confirmation |
| Write only `owner`, interval `[10-12, 10-15)` | `validation_failed`: this stretch has no value, and the required field `amount` is missing |

#### Writing with the same value

For the general rule on corroboration with the same value, see "Deletion · Provenance"; what follows is the part specific to state tables.

- **The baseline for the same value is the version seen by the writer** (the version `ver` points to; if `ver` is the current one, it is the current state), taken as it is after the deletions that were confirmed and not cancelled at write time (a deleted value is not treated as the same value just because it is passed back unchanged). A field's value counts as the same value only if it equals the version seen over the **whole** resolved interval.
- Same value, and evidence was not explicitly pointed to with `evidence_by_field`: **no-op**. No version is produced, `ver` does not change, and no boundary is left.
- Same value, and evidence was explicitly pointed to: **corroboration**.
  - For the part where the current value is still equal to it: a source is appended to this stretch, with no new version produced and `ver` unchanged. The split by interval is done only in the source table and does not count as "splitting an existing segment" (segment `[10-01, 11-20) 5000`, corroboration `[11-05, 11-10) 5000`: only the piece `[11-05, 11-10)` gains one more source).
  - Of the start and the explicit end of this corroboration, the ones that fall on the endpoints of the corroboration item's interval become **corroboration endpoints** of the field and count as stop points (when split into several items, the item in the middle has none).
  - For the part where the current value has been changed by a write after the version seen: it takes part in the conflict judgement as an ordinary write (see "Conflict handling").
  - So within one write the same field can be split into several items, each with its own result: one item is a corroboration, another takes effect or becomes a candidate. Events and receipts are given per item.
- A write that covers a stretch of corroboration (whoever's it is, including one written by an earlier op in the same request) without changing the value change points: not high-impact; the receipt gives `warnings` with `overwrote_corroborated` (with the covered stretch and its sources).

**Example**: base `[10-01, ∞) 5000`. A says "from 11-20 it is 5000", B says "3000 from 11-02", no end passed, and both carry the same `ver`.

| A's way of writing | Result under the two arrival orders |
|---|---|
| No evidence pointed to (no-op) | Both are `[11-02, ∞) 3000` |
| Evidence pointed to (corroboration, 11-20 becomes a corroboration endpoint) | Both are `[11-02, 11-20) 3000`, `[11-20, ∞) 5000` |

When evidence was pointed to and B arrives first, A's stretch has already been changed by B, and takes part in the conflict judgement as A wrote it: no end passed, so it is a write from 11-20 with a default end, whose start differs from B's start, so no conflict; after merging, it resolves on the current state to `[11-20, ∞)`, where it changes the value, and so is a write that takes effect, not a corroboration. The final state is the same under both orders.

For a restated value to "count", the agent must use `evidence_by_field` to name the evidence; the tool description guides it that way. When two writes come one after the other and the later one has seen the earlier one, the result differing with the order is the semantics itself.

**Example (corroboration and another value, other ways of writing)**: base `[10-01, ∞) 5000`; A writes 5000 and points to evidence (corroboration), B writes 3000, and both carry the same `ver`. A corroboration does not change `ver`, so when A arrives first, the `ver` B carries is still the current one, and B counts as having seen A: B merges, and when it covers A's corroborated stretch the receipt gives `overwrote_corroborated`. When B arrives first, A has not seen B: the part of A that has already been changed takes part in the conflict judgement as A wrote it, what would become a candidate becomes a candidate, and the part still with the same value remains a corroboration as before. The conclusions under the two orders differ here, which does not violate symmetry (see the symmetry item under "Conflict handling · Conflict criteria").

| A's way of writing | B's way of writing | A arrives first | B arrives first |
|---|---|---|---|
| From 11-20, no end passed | From 11-20, no end passed | B takes effect `[11-20, ∞) 3000`, gives `overwrote_corroborated` | Default end against default end, same start and different values: A becomes a candidate |
| From 11-20, no end passed | `[11-02, 11-22)` | B takes effect, gives `overwrote_corroborated` | A becomes a candidate on `[11-20, 11-22)`, and `[11-22, ∞)` remains a corroboration |
| `[11-20, 11-25)` | From 11-02, no end passed | B stops at A's corroboration endpoint 11-20: takes effect `[11-02, 11-20)`, covering nothing | The whole of A becomes a candidate |
| `[11-20, 11-25)` | `[11-02, 11-22)` | B takes effect, gives `overwrote_corroborated` | A becomes a candidate on `[11-20, 11-22)`, and `[11-22, 11-25)` remains a corroboration |
| `[11-20, 11-25)` | `[11-20, 11-22)` | Same as the previous row | Same as the previous row |

**Example (two items for one field)**: base `[10-01, ∞) 5000`. B first writes explicit `[11-02, 11-10) 3000`; A, carrying the `ver` from before B, corroborates `[11-05, 11-20) 5000`. This write of A has two items on `amount`: `[11-10, 11-20)` is still 5000 → corroboration, a source is appended, and 11-20 becomes a corroboration endpoint; `[11-05, 11-10)` has already been changed by B to 3000 → judged as an ordinary write, it intersects B's and the values differ → candidate.

### High-impact writes

**The sole criterion for high-impact ①: after the write, a value change point that already existed, for some field at some valid instant, in the version seen by the writer is no longer a change point.** It is judged by the result and per field, independent of how the end was passed or what the intent was. The boundary between a value and no value is counted only on the fields that count as "has a value" (the required fields, excluding those given a constant `backfill`; every field when none is required; on the same basis as the definition of "has a value" in "Intervals without a value"), and as one change of those fields together; the other fields are compared only between the instants at which the entity has a value, and value ↔ empty is still a change point. Whether the entity has a value is defined only by these fields to begin with: as long as one such field still differs on the two sides of the boundary, the instant is still a change and no information is erased; if these fields have the same value on both sides, the boundary disappears, and it counts as ①. So creating a new entity by writing two segments at once (the second continues from the first one's explicit end, with a different value) is not high-impact, and this does not depend on whether the table has optional fields. Only the change points that exist in the version seen, are still there before the write and are not there after the write are counted; one erased by someone else after the version seen was not erased by this write and is governed by the conflict criteria.

- The **version seen** is the same one as the baseline for the same-value judgement: the version `ver` points to (if `ver` is the current one, it is the current state; one obtained by fallback is the version the fallback arrived at); later ops in the same request add on top of the results of the earlier ops in this request, so a change point just created by the previous op is within the protected range.
- **A change point newly created by someone else after the version seen is not within the protected range.** That belongs to concurrency and is governed by the conflict criteria: if it can be merged, the two sides have the same value at the intersection, and no information is covered. In this way the high-impact judgement does not change with the arrival order; for what range the conclusions of two writes are independent of the arrival order, see the symmetry item under "Conflict handling · Conflict criteria".

| Write | Counts as ① or not |
|---|---|
| An explicit end or `open` covers a change point | Yes |
| Changes the value of only one segment, and the new value is the same as that of an adjacent segment on one side (for example changing the 3000 from 11-02 back to 5000, so that there is no change at 11-02 any more); reverts are common | Yes |
| A write with a default end, where the new value is the same as the segment before the start | Yes (what is erased is the change point at the start) |
| An explicit interval that crosses an interval without a value, so that the change points at both ends disappear | Yes |
| An explicit interval that exactly fills an interval without a value, with a value different from both sides | No (the same reasoning as changing the value of only one segment) |
| Changes the value of only one segment, and the new value differs from both adjacent segments (for example changing the 4000 from 11-10 to 4500) | No |
| Only splits an existing segment | No |
| A same-value write (no-op or corroboration) | No |
| A write with a stale `ver` that makes a change point newly created by someone else after the version seen disappear (the two sides have the same value at the intersection, and it has been merged by the conflict criteria) | No |
| Revoke | No. A revoke is an explicit "no value in this stretch", keeps the history and can be `undo`ne; it is still subject to ② |
| `undo` of a revoke | No. What it restores is exactly the value that revoke removed, and the change points return to how they were before the revoke; the parts of that interval that others wrote after the revoke are skipped as usual |

Changing the value of a row on an event table is not high-impact.

**Example (independent of arrival order)**: base `[10-01, ∞) 5000`, with A and B carrying the same `ver`.

| The two writes | A arrives first | B arrives first |
|---|---|---|
| A "3000 from 11-10", B "3000 from 11-02", neither passes an end | B merges into `[11-02, 11-10) 3000`; it makes 11-10 no longer a change, but the change point 11-10 does not exist in the version B saw → takes effect | A merges, the value is unchanged |
| A `[11-01, 11-20) 3000`, B `[11-10, 12-01) 3000` | B makes 11-20 no longer a change, and that was created by A → takes effect | A makes 11-10 no longer a change, and that was created by B → takes effect |

The final state of each row is the same under both orders: the first row is 5000 / `[11-02, ∞) 3000`, the second row is `[11-01, 12-01) 3000`.

- A high-impact write goes to awaiting confirmation (`awaiting_confirmation`) by default, the value does not change, and the receipt lists the segments that would be overwritten (by field). **On confirmation, the proposed interval recorded in the item is executed** (in a deletion replay, take the interval most recently given by this item): if between the proposal and the confirmation a write changed the proposed field and interval, the item has already been superseded or refreshed and the version does not match; a stop point newly added by a write that does not intersect does not change the recorded interval. This applies only to write-type items awaiting confirmation; **for revert-type ones (the proposal is an `undo`) the scope follows the state**: on confirmation the revert record is listed again against the state at the moment of confirmation (see "The write request · Undoing a write"), so every time the item is refreshed it is judged again against the current state, and the interval and effect shown are what confirming would do right now.
- **`acknowledge` at the op level**: when the caller has already confirmed with the user, it can carry `acknowledge: ["overwrite"]` on **that op** to take effect directly, and this confirmation is recorded in the write event (who, and which overwritten segments were confirmed).
  **It is valid only when that op explicitly carries the current `ver` (not one obtained by fallback)**: then what the caller sees is the current state, and what is overwritten is the segments it saw;
  when `ver` is not carried, or `ver` was obtained by fallback or is stale, `acknowledge` does not take effect, and the write goes to awaiting confirmation as usual. No extra hash is added, and no preview round trip is needed.
  Which surfaces open it up is a matter for the surface: **MCP does not open it in the first version** (the model cannot see the segments that would be overwritten before writing, so everything goes through "awaiting confirmation → resolve", see 05-surfaces.md); HTTP opens it.
- **A write that is both a version mismatch and high-impact**: handled as a conflict first and becomes a candidate (see "Conflict handling").
- **The complete list of high-impact writes**:

  | # | High-impact write | First version |
  |---|---|---|
  | ① | A write on a state table that erases a recorded change point (above) | Yes; only it may take effect directly with `acknowledge: ["overwrite"]` |
  | ② | Revoking a row that is still referenced by `ref` from other rows. On a state table it is judged only for revoking a whole entity (without an interval); after a revoke with an interval the entity is still there, and it is not judged. How "still referenced" is counted and what happens to the referencing side after confirmation: see "The write request · Reference fields". Like ①, the judgement counts the results of the earlier ops in this request: a referencing row already revoked earlier in this request is treated as no longer referencing | Yes, always goes to awaiting confirmation |
  | ③ | A write on tables / fields additionally designated by the slot policy | Later |
  | ④ | An `undo` with `include_later: true` that reverts later writes: among the items marked `later` in the revert record, at least one has a non-empty scope in this revert (both event tables and state tables count, see "Reverting to a version" and steps 2 and 3 of "Deletion · The authoritative definition of reverting"). When an item marked `later` is wholly covered by a write that is not in the record, its scope is empty and it does not count; when a deletion makes the default end of some write outside the record extend and cover it, a revert awaiting confirmation is no longer high-impact and takes effect at its own write number, and the preview states the reason. **Another cause: the revoke written back would shadow a later write**: the revoke w that this `undo` (including undoing a revert) writes back on "existence" shadows a field item x: x takes effect (excluding corroboration, and excluding written-back items that only register and carry no content), (x's event, x's target) is not in the revert record, its operation number lies between the undone operation and this revert, and the interval(w) ∩ interval(x), after subtracting the part of x already registered by an earlier revert, is non-empty. The judgement is made in the state judged operation by operation in operation-number order, and this revert itself counts as taking effect; the item and the receipt list the writes that would be shadowed, and on confirmation they are listed again against the state at confirmation. A shadowed corroboration is not high-impact and gives an `overwrote_corroborated` warning. In a deletion replay it is judged again by the general rule of this clause: when the shadowed writes are all deleted or no longer give a value at that place, it is no longer high-impact and takes effect at its own write number. This cause applies only to `undo`: `take_previous` writes back no revoke, and the field writes within the same time-span unit are all in its revert record ([`../09-event-format.md`](../09-event-format.md) §5.7). **Third cause: the write-back leaves a stretch with no value**: a written-back item of this revert makes the entity go from having a value to having no value over some stretch (see "Intervals without a value"), and some field item x gives a value over that stretch (clearing counts; written-back items that only register or have no value do not count): the other conditions are as in the previous cause (excluding corroboration, not in the revert record, operation number between the undone operation and this revert, and after subtracting the registered part the stretch intersects interval(x)). The value of x is gone together with this stretch. On a table with no required field x itself keeps the value of this stretch alive, so this does not occur. `undo` goes to awaiting confirmation as above; `take_previous` also shadows writes outside the unit in this way, but it is a decision on a conflict item and does not go to awaiting confirmation; it is listed by `reverted_by_previous` in the item details | Yes, always goes to awaiting confirmation |

  High-impact is recomputed on the state after deletion (see "Deletion · Replay rules").

  **The state of reverts (`undo`, take the previous value) in replay is judged one by one in operation-number order**: when judging a revert, the reverts earlier than it count as in the state already judged, and it itself counts as taking effect; a judgement is final once made and is not judged again because of a later revert or a judgement result; the registration in the result counts all reverts judged to take effect (the event format §5.7 "The order in which the state of reverts is judged"). It counts itself as taking effect so that ④ is judged in the state in which it actually executes: an `undo` with `include_later`, if it would revert later writes when it takes effect, goes to awaiting confirmation, and does not take effect directly because, with it counted as not taking effect during judgement, the later items it would revert were not seen.

  ② counts the results of the earlier ops in this request, so "within one request, first revoke three detail rows, then revoke the meal they belong to" completes in one go and does not go to awaiting confirmation. Ordered the other way (first revoke the meal, then the details), when the op that revokes the meal is judged the details still reference it, and it goes to awaiting confirmation as usual; later the details are revoked, and the item's effect is refreshed accordingly (see "Pending items · Effect"). The order of the ops in one request therefore affects the result. This does not contradict "independent of arrival order": that item speaks of two requests each carrying its own `ver`, whereas the ops in one request are executed in order to begin with, and later ones see the results of earlier ones (see "The write request · Several ops in one request").

  ② is judged once, at the moment of writing: if afterward the referencing rows are re-pointed elsewhere or revoked, the item stays awaiting confirmation, its effect is refreshed accordingly (it may be refreshed to empty), and confirmation executes this revoke as usual. Only in a deletion replay does it, per [03-deletion](03-deletion.md) "High-impact (recomputed)", become no longer high-impact and take effect at its own write number.

### Revoking on state tables

- **A revoke is a write that says "no value in this stretch of time"**, and there is no separate "revoked" state. When `valid_from` / `valid_to` are carried, only that interval is revoked and an interval without a value is left; when no interval is carried, the whole entity is revoked, that is, no value for all time.
- **A revoke that carries only a start**: the end defaults to `next_change`, taking the first stop point of **any field** after the start (a revoke changes "existence", any field's change is a recorded fact, and by default it is not crossed); `open` can be written explicitly.
- **For a revoke with an interval, the interval is content** (the start and end points are what the user said), and its source is that sentence; a revoke without an interval contains no content and is a pure decision. For the difference between the two in privacy deletion, see "Deletion · Two principles".
- After revoking a whole entity, the entity and its key are still there. A later write by `entity` or `entity_key` is handled as an "interval without a value" (all required fields must be carried, with `ver` as usual), and **a second entity with the same key is not generated**.
- "Restore to what it was" uses a revert (see "Reverting to a version").
- For the conflict criteria between a revoke and a concurrent change, see "Conflict handling".

### Writing by `entity_key`

**Write if it exists, create if it does not**: when a state table declares `entity_key`, a write located by key records its intent as "change": if the entity exists it is an ordinary change (`ver` must be carried as usual, or fallback applies), and if it does not exist an entity is created (an `entity_id` is generated, the write event records a "create" mark, and `undo` uses it to recognize the first creation).

- The "add" intent is used only for tables with no `entity_key` (on a state table each add creates one entity); used on a table that declares `entity_key` it reports `invalid_argument`, with a hint to use the change intent and write by key. Writing by `entity_id` when the entity does not exist reports not found.
- **A key field cannot be changed**: the key does not change with valid time, and key uniqueness is uniqueness over all time. When a key field appears in a write with a value different from the entity's key, it reports `invalid_argument` (`key_field_changed`), regardless of intent and regardless of whether an interval is carried. When locating by key, key values are compared by the same-value criteria (see "Field types, same value and units").
- **Writing one character wrong creates a new entity** ("q4 promo" vs "Q4 promo budget"): in addition to "new entity", the receipt of a first creation gives two hints, so the caller can see at a glance whether the key was mistyped:
  - `similar_keys`: existing keys in this table whose spelling is close to the new key, at most 5, each with the reason for being close (`fold`: the same after folding; `affix`: one is the beginning or end of the other; `edit`: the edit distance is within the threshold). For the criteria, the comparison scope and the ordering, see "Similar keys". The comparison scope includes revoked entities (after a revoke the entity and its key are still there), and such a key is marked `revoked`: writing by that key fills its interval without a value (see "Revoking on state tables" above) and does not change an entity that is still in effect.
  - `existing_keys`: the entity keys that already exist in this table, at most 10; close keys come first, and the rest are ordered by most recent write.
  - Both are hints computed from the state at the moment of writing and do not go into events; the receipt of an idempotent replay does not give these two (`existing_keys` is marked in `omitted[]`) and does not recompute from the state at replay time, because otherwise the two receipts of the same request would differ.
  - The write takes effect as usual, generates no item and does not go to awaiting confirmation: close does not mean mistyped, and "promo" and "promo phase two" can be two budgets. Generating a `flagged` item by approximate matching on `entity_key` is not done in the first version.
- **How to correct a mistyped key**: revoke the mistyped entity (without an interval), then write by the right key. The mistyped entity and its key stay in the history, can be queried, and can be `undo`ne. Changing a key directly (replacing one entity's key with another value) is not done in the first version: after changing the key, if the evidence of that key change is then deleted, the key must fall back to the old value, and the old key may by then have been taken by another entity, which would need another set of rules.
- **Concurrent first creation**: when two callers both read "the entity does not exist" and then write by the same key one after the other, the one that arrives later, carrying no `ver` and having no per-row read to fall back on, reports `read_first`; it rereads, sees the value the other side just created, and decides again. The result is correct, at the cost of one more call.
  It does not treat "read as not existing" as a version and handle it as a conflict: that would require recording "read as not existing" by key in read_log, and the key value is user content, which K10 does not allow read_log to record, nor a hash computed from a value.
- When an entity is first created and a second segment is then written to it in the same request, the later op does not need `ver` (see "The write request · Several ops in one request").

### The effect of a change on earlier reads

On state tables, **any write that makes a value change** runs the impact query. The criterion is structural: the (field, valid-time interval) in which the value actually changed intersects a valid-time condition recorded in a read record, and the version that read saw is earlier than this write (for details see "Querying the reads a correction affects").

| Case | Who judges | Reason code | Wording for the reader |
|---|---|---|---|
| The intent is a correction | **The agent marks it explicitly** | `correct` | The value you read has been corrected |
| The part of the change interval earlier than "now" (changed long ago but known late, or decided today and taking effect backward) | saveslot, by the recorded `now` | `retroactive` | The value you read at that valid time was later changed retroactively |
| The part of the change interval not earlier than "now" | saveslot, by the recorded `now` | `plan_changed` | A future plan you read has changed |

- A read that passes no time is recorded as the entry instant (for `date` granularity, as that day), so "read today's value earlier today" naturally hits.
- Event tables have no valid interval: only a correction and a revoke trigger it.

### Queries

| What is being asked | Parameter |
|---|---|
| What is known now, what is in effect now (default) | Not passed |
| What it was at valid time T | `valid_at: T` (state: the interval contains T; for event tables use a time window instead) |
| History over a stretch of valid time | `valid_during: [a, b)` |
| What saveslot knew at that time | `as_of: operation number or moment` of `history` (reads the version table); only in `history`, the query interface does not provide it |
| Both axes given | `as_of` of `history` + `valid_at`: reproduces "the 11-05 budget that task saw at the time" |
| What changed between two recorded moments | `changes` of `history` (`since` excluded, `until` included) |

In restricted SQL, valid time can use `FOR VALID_TIME AS OF / FROM … TO …`, getting "today" uses `saveslot_today()` and getting the entry instant uses `saveslot_now()` (see L1 of "Derivation rules") (saveslot's own syntax, resembling the `FOR SYSTEM_TIME` of system-versioned tables in the SQL standard), and saveslot rewrites it into predicates without depending on native PostgreSQL support. Recorded time is not opened in SQL: a `FOR SYSTEM_TIME` that appears reports `sql_rejected`; use `history` instead (the contract, "Time parameters").

**The recorded-time side**

- **`as_of: S`** = the state when all operations with an operation number not greater than S have fully taken effect. The events of one write have the same operation number externally, so a half-written intermediate state is never read. Given a moment T, it is converted into an operation number by `recorded_at ≤ T`; a future moment equals the latest.
- `as_of` without `valid_at` reading a state-table entity: returns all the segments known at that time.

**The valid-time side**

- The default read of a state table (which returns only the current segment) also carries that segment's `valid_from` / `valid_to`, so the caller can see "until which day this value holds".
- **What `valid_during` returns**: the endpoints of a segment are not clipped to the query interval by default; adjacent segments with the same value are merged by default over the selected fields (computations by count or by duration would be wrong on segments left unmerged), looking only at values and not at flags; a merged row carries the flags of each segment, and flags of the item kind carry the segments (`spans`) of the item's interval that intersect this row, from which the reader knows which segment it is. The switches are `clip: true` and `coalesce: false`. An open end is written as `valid_to: null`; `valid_to_inclusive` is given only at `date` granularity.
- The `valid_from` / `valid_to` in query conditions can be used only together with `valid_during`; otherwise it reports `invalid_argument`.
- Restricted SQL reading a state table: no time qualifier = the current segment. A derivation rule that reads a state table without a valid-time qualifier is equivalent to depending on "now" and falls into the time-dependent rules: in the first version it is computed at read time and not cached (see "Derivation rules and derived caches · Time dependence").

**Mixing dates and moments**

| Case | Handling |
|---|---|
| Finer → coarser: a `date`-granularity table receives a moment | The day it falls on in the slot's time zone is taken, and `warnings` states it |
| Coarser → finer: an `instant`-granularity table receives a date | Reads and writes both report `invalid_argument`, and `example` gives the start and end moments of that day in the slot's time zone |
| An event table opens a window by date, and the occurrence-time field is `zoned_datetime` | By the calendar day in the **slot's time zone**; the time zone carried by the event is used only for display. This is the same rule as the bucketing in restricted SQL and in derivation rules (in SQL, take the day by writing `saveslot_date(f)`, see ["Restricted SQL"](11-restricted-sql.md) "Time"); the cost is that an event across time zones may be counted on another day; for a table that needs "which day locally", the schema defines a separate `date` field |

**The return contract**

- **A result read as of a moment always states the schema version it used**; fields are resolved by field ID, and units are labeled per the version at that time;
  when the moment falls before a switch, it is answered with the definitions and physical tables of the version at that time (retired tables, see ["Schema version evolution (continued)"](08-schema-migration.md) "The physical approach"), with values and units per the version at that time; for a moment across a re-extraction (irreversible) migration, it can only be returned in the old version's shape and is explicitly labeled.
- **Restoring a derived value as of a moment** = recomputing with the rule version at that time, on the base data of that time (what remains after deletion) (across a switch, the base tables of that version at that time; the retired derived physical tables are not consulted, and a derived table computed at read time is an empty table to begin with); **it is not guaranteed to equal the value read at that time**,
  and when the result checksum has been deleted along with the inputs or does not match, the check is skipped and "the inputs at that time have been partly deleted" (`partially_deleted`) is labeled. Rule versions are kept permanently (the rule text contains no user data).
