# saveslot · Event format v1

> Translated from docs/zh-CN/spec/09-event-format.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

> The field-level definition of every kind of event in the log. The implementation of `log` and `apply` follows this document; it is also the format description of an exported file: without any saveslot code, this document alone should be enough to read an exported log.
> The rules themselves (when each kind of event is produced, how judgement is done) are in [`03-data-model/`](03-data-model/README.md); the layering and the invariants are in [`02-architecture.md`](02-architecture.md). This document only defines "what an event writes, and how".
> **Freeze rule**: this document is frozen before the local mode is first released publicly, and after that it only grows, never changes (§1.6). Logs produced during development before the freeze are not promised to be compatible ([`07-scope-v1.md`](07-scope-v1.md), "The freeze point of the event format"). Undecided items that appear before the freeze are registered in [`08-open-questions.md`](08-open-questions.md).

## 1. Scope and conventions

### 1.1 What an event consists of

A tenant has one append-only log. Each entry in the log is an **event**, which consists of two parts:

| Part | What it is | Can it be deleted | Is it in the chain |
|---|---|---|---|
| **Event header** | A JSON object. It states which entry this is, what type, who did it, when, and which operation it belongs to | Never deleted or changed | Yes |
| **Content blocks** | Zero or more; each block is one JSON value, addressed by `(seq, path)`, each with a checksum | Can be emptied as a whole block only when a tombstone event is applied | No |

- **No user content appears in an event header, and no value computed from user content either** (the method of judging is in §2.3).
- Content blocks are of two kinds: **metadata blocks** (containing only opaque IDs, enums, sequence numbers and indexes, version numbers, booleans, the entry time and the dates and expiry times derived from it, the export time, and the identification of the client software; in the first version they are not deleted) and **data blocks** (containing user content or values computed from it, recording provenance, within the scope of the deletion cascade). The vocabulary of each event in §5 marks which kind each path is.

### 1.2 Encoding

| Item | Rule |
|---|---|
| Event header, content blocks | JSON, serialized to UTF-8 bytes per **RFC 8785 (JCS)**. The JCS bytes are the authoritative form; the index columns split out in storage are only indexes, and `verify` checks that they agree with the authoritative form |
| Omitted fields | Not encoded. An optional field that has no value does not appear in the object, and `null` is not written. Adding an optional field therefore does not change the bytes of old events |
| Integers | `seq`, indexes, version numbers and counts use JSON numbers, with values from 0 to 2^53 − 1 |
| Decimal numbers | **Always written as strings** (`"45"`, `"5.5"`), never as JSON numbers. Amounts, quantities, `decimal` fields, `min` / `max` are all so. A value that saveslot computes or converts uses the **canonical form** `-?(0\|[1-9][0-9]*)(\.[0-9]*[1-9])?`: no exponent and no plus sign, no leading zero in the integer part, no trailing zero in the fractional part, zero written as `"0"` (there is no `-0`), and written in this shape after rounding by `scale`. Two numbers with the same value therefore have only one byte form. Raw values handed in by the caller are not normalized (§1.3) |
| Times | String, UTC, fixed millisecond precision: `2026-11-10T04:41:07.123Z` |
| Dates | String `YYYY-MM-DD` |
| Valid intervals | Object `{"from": <point>, "to": <point>}`, closed on the left and open on the right; an omitted end is open: omitted `to` means it continues indefinitely, omitted `from` means the start is open, and `{}` with both ends omitted is the whole of time. An open start and the whole of time appear only on "existence" (the resolved interval of a contribution, §5.7 `span/existence/…`, and the entries of an item that concern "existence", §5.8 `current/<k>` and so on, such as the write-back entry that reverts a whole-entity revocation, or when a write-back over the whole of time is cut apart by other entries) and in the first segment of `scope_valid` (only the first segment may omit `from`; the whole of time is written as `[{}]`). Field intervals and intervals given by the caller always have `from`. The form of a point follows the granularity of the table: `date` granularity uses a date, `instant` granularity uses a time |
| Booleans, enums | JSON booleans; enums use lower-case snake_case strings |
| Field values | See §1.3 |
| Hashes, checksums | 64-character lower-case hexadecimal strings |

### 1.3 How field values are written

Wherever an event holds "the value of a field", it is written according to the field type:

| Field type | Form | Example |
|---|---|---|
| `text`, `enum` | String | `"餐饮"` |
| `integer` | Decimal string | `"3"` |
| `decimal` | Decimal string | `"5.5"` |
| `boolean` | Boolean | `true` |
| `date` | Date string | `"2026-11-10"` |
| `zoned_datetime` | `{"instant": <time>, "zone": <IANA time zone name>}` | `{"instant":"2026-11-10T04:31:00.000Z","zone":"Asia/Shanghai"}` |
| `quantity` | `{"value": <decimal string>, "unit": <unit code>}`, already converted to the unit the field declares, with precision and rounding per the compiled definition (§7) | `{"value":"54","unit":"CNY"}` |
| `ref` | The ID of the referenced row or entity | `"r_01JC8Z…"` |
| Null (an optional field explicitly set to empty) | `null` | `null` |

A "raw value" is a value handed in by the caller without conversion; it has the same shape, and its unit is the one the caller gave. A decimal is recorded as the caller wrote it (when the caller gave a JSON number, the number text as it appears in the request is recorded) and is not rewritten into the canonical form; a literal match compares exactly that. The syntax of decimal raw text (the value of `decimal` and `integer`, and the `value` of `quantity`) is in [`04-contract.md`](04-contract.md) section 1, "Encoding of values": a string and a JSON number use the same JSON number syntax, and one that does not fit the syntax is reported at write time as `validation_failed` (`malformed`) and does not get into an event. Apart from raw values, every decimal value in an event is in the canonical form of §1.2, and so is `integer` (it has no fractional part). Raw values appear in two places: the `ops/<i>/set/<field ID>` blocks of `write.head`; and the `request` block of the `api_call` source that a write without evidence stores for each op that got into an event (the request JSON of that one op, §5.6).

### 1.4 Identifiers

Every identifier in an event is an opaque string, allocated by saveslot, and contains no readable name.

| Identifier | Shape | Notes |
|---|---|---|
| `seq` | Integer | The position of the event in the log, starting from 1 |
| Operation number | Integer | The `seq` of the head event of an operation (§4.1) |
| `tn_…` | Tenant ID | Globally unique |
| `u_…`, `ci_…`; the fixed value `system` | Principal ID: a user, a connection, the kernel itself | Globally unique |
| `n_…` | Node ID (`node_id`) | Globally unique; see §2.2 |
| `sl_…` | slot ID | Unique within a tenant |
| `t1`, `f2`, `r1` | Table ID (unique within a tenant), field ID (unique within a table), rule ID (unique within a tenant) | Short IDs that increase; deleted ones are not reused; the numeric part starts from 1, has no leading zero, and has at most 9 digits |
| `r_…` | Row ID (UUIDv7) | Event tables, timeless tables |
| `e_…` | Entity ID (UUIDv7) | State tables |
| `p_…` | The `partition_id` of a derived row | |
| Source data | Referenced by the `seq` of the `source.recorded` event that produced it; the external `s_…` ID is recorded in that event | |
| `pi_…` | Pending item ID; the deletion ID is the same as it | |
| `d_…`, `m_…` | schema draft ID, migration ID | |
| `rs_…` | The ID of a restore (`restore_id`) | |

For the number of digits and the way each prefix is generated, see [`03-data-model/01-objects.md`](03-data-model/01-objects.md), "How identifiers are written"; IDs in examples are abbreviated with `…`.

### 1.5 The chain and the checksum

- **Event header hash** = SHA-256 (the JCS bytes of the event header).
- The `prev_hash` of an event header = the event header hash of the previous event. The `prev_hash` of the first event (tenant genesis) is 64 `0`s.
- **Content block checksum** = SHA-256 (the JCS bytes of the JSON value of that block). It is stored together with the content and is emptied together with it; **no checksum of any content block is put in an event header**.
- A checksum is used only to detect storage corruption. It is not a commitment to the content: after a block is deleted, no value computed from it is left, and afterwards there is no way to prove or compare "what was here before".
- Hashes and checksums are computed by the application layer and do not depend on database functions.

### 1.6 Versions and evolution

- Every event header carries `v`: **the format version of that event type**, starting from 1.
- **Only growth, never change**: the meaning and shape of existing fields and existing paths of an existing type do not change. Only five kinds of change are allowed: adding an event type; adding an optional event header field to an existing type; adding a path to an existing type; adding an optional key to an existing block; adding a value to an enum. **There is only one rule: any event that carries a shape the old kernel does not recognize must carry a higher `v`.** An event that uses a new event header field, a new path, a new key or a new enum value gets `v` of its event type increased by one; an event that uses none of these is still written with the original `v`, and the bytes of old events do not change. Events of old and new versions coexist in the same log. A new event type starts from `v` = 1.
- **A new kernel must be able to replay all events of old versions.**
- **When an old kernel meets an event type it does not recognize or a `v` it does not recognize, it stops `apply` and reports an error, and does not skip.** There is no "ignore unknown keys" path: under a `v` that is recognized, the event header fields, paths, keys in blocks and enum values are a known complete set, and anything outside the set means the event is invalid, and `apply` stops likewise (it may change the meaning of the event). `apply` parses in strict mode.
- **Version strings that are not recognized also stop it**: `compiled.compiler`, `compiled.rsql`, `rule.rsql`, `ctx.ruleset_version`, `ctx.literal_checker`, and later version strings of the same kind (the versions of rules, allow lists, checkers, compilers); when a value the kernel does not recognize is found, `apply` stops and reports an error. A case where the kernel cannot evaluate or recompute by that version is never downgraded to computing by another version: that the `v` of the event is recognized does not mean that the judgement version recorded inside it is recognized.

---

## 2. The common event header

### 2.1 Fields

| Field | Type | Appears in | Meaning |
|---|---|---|---|
| `seq` | Integer | All events | Log position |
| `v` | Integer | All events | The format version of that event type |
| `type` | String | All events | The event type (§6.1) |
| `actor` | String | All events | The ID of the principal that did this; it must already be registered in this tenant (the `actor` of `tenant.genesis` and `tenant.imported` is registered by that event itself). Events produced by the kernel itself have `system` |
| `at` | Time | All events | The recorded time. Take the max of (the `now` of the call context, the `at` of the previous event); all events of the same operation have the same `at`. Order is determined by `seq`; `at` only guarantees that it does not go backward |
| `prev_hash` | Hash | All events | The event header hash of the previous event |
| `op` | Integer | Events in an operation other than the head event | The operation number of the operation it belongs to (the `seq` of the head event). **An event without `op` is the head event of an operation** |
| `slot` | slot ID | Events that belong to a slot | Tenant-level events (genesis, restore, import, principals) do not have it |
| `trigger` | Enum (§6.9) | Head events whose `actor` is `system` | Which background task or process triggered it |
| `node_id` | String | Only `tenant.genesis`, `tenant.restored`, `tenant.imported` | See §2.2 |
| `restore_count` | Integer | Only `tenant.restored`, `tenant.imported` | See §5.2 |
| `restore_id`, `restored_to`, `high_water` | String, integer, integer | Only `tenant.restored` | See §5.2 |
| `imported_upto` | Integer | Only `tenant.imported` | See §5.2 |

Apart from these, the event header has no other fields. Tables, rows, intents, referenced events and the like are all in content blocks: the location and the intent are in the metadata block `target`, and the call context is in `ctx`; references to other events are spread over `target` (`origin_event`, `by_event`), `revert`, `take`, `valid_sources`, `op_sources`, `positions`, the `ops/<i>/baseline`, `ops/<i>/premises/<j>` and `ops/<i>/premise_covers` of the write head, the `targets/<k>` of `premise.changed`, and the `sources` and `deps` of the various blocks.

Example (the event header of a base write inside a correction write):

```json
{"actor":"ci_7HQ2…","at":"2026-11-10T04:41:07.123Z","op":25,"prev_hash":"9f2c…e1","seq":27,"slot":"sl_4KTZ…","type":"write.base","v":1}
```

### 2.2 The identity of an event

The event header of the first version **has no** `event_id`. The convention:

> The identity of an event = (the `node_id` of the nearest preceding `tenant.genesis`, `tenant.restored` or `tenant.imported` event, its own `seq`). The identity of `tenant.genesis`, `tenant.restored` and `tenant.imported` themselves uses their own `node_id`.

- The `node_id` of `tenant.genesis` is generated randomly when the tenant is created.
- Each restore changes to a new `node_id`. After a restore, `seq` continues from after the high-water mark, but a `seq` that was allocated between two advances of the high-water mark may be used again; changing `node_id` guarantees that events on the lost stretch of the timeline and new events after the restore do not share a name.
- Each import changes to a new `node_id`. Imported events keep the `seq` of the source unchanged; events produced at the target after the import, and events the source continues to produce after the export, will have the same `seq`; changing `node_id` guarantees that the two do not share a name.

### 2.3 How to judge that an event "contains no user content"

Whether a value can be put in an event header is decided in the following order, and if any one is not satisfied it can only go in a content block:

1. It is one of: an opaque identifier allocated by saveslot, a fixed enum, a sequence number, a version number, or a recorded time.
2. If all user input of this tenant (original words, field values, names, identifiers the caller reports about itself, times the caller gives) is replaced with something else, it does not change.
3. It is not the hash, checksum, length or count of any content.

By these three, the following **cannot** go in an event header: request keys, explicit idempotency keys and content fingerprints, group key values, values of external keys, hashes of any content, valid intervals (their start and end points are what the user said; the valid time in a premise declaration likewise), field values, table names and field names, names of connections, the task identifier `task`, and the `stated_at` the caller gives.

---

## 3. Content blocks

### 3.1 Addressing

The address of each content block is `(seq, path)`: the `seq` of the event it is in plus a `path`.

The syntax of `path`:

- One or more segments, joined with `/`, all ASCII.
- Each segment can only be one of three: **a fixed word of that event type** (lower-case letters and underscores, such as `fields`, `text`, `target`), **an opaque ID** (a field ID, a table ID), or **a decimal index** (starting from 0, no leading zero).
- No user content or value computed from it appears in a `path`. An address can therefore be written into a tombstone, into the position list of a deletion event, into the deletion register outside the log, and into export placeholders.

Which paths each event type has, and the JSON shape of each path, are listed one by one in §5. The vocabulary only grows with the event format version, and never changes.

### 3.2 Deleting a block

- **The block is the smallest unit of deletion; it is emptied as a whole, and there is no partial deletion inside a block.** Content that must be deleted per field or per entry is cut, in the vocabulary, into one block per field per item (value, provenance, literal match and interval each one block) and one block per entry.
- Only a `deletion.executed` (tombstone) event can empty a content block; when `apply` processes a tombstone, it empties the content and checksum of every block the tombstone lists, and records the `seq` of the tombstone.
- An emptied block still occupies its address, and its state is "removed by #n" (n is the `seq` of the tombstone). The mark holds no content, and no checksum or length of the original content.
- During replay, when `apply` meets a block "removed by #n", it treats the block as not existing. When replaying events earlier than the tombstone, it does not need to look ahead.

### 3.3 The three states of a block

| State | In storage | In the export file (§8) |
|---|---|---|
| Present | Content + checksum | `{"v": <content>, "sum": <checksum>}` |
| Removed | Content and checksum are empty, `removed_by` = the `seq` of the tombstone | `{"removed_by": <seq of the tombstone>}` |
| Pending deletion (within the grace period, not exported by default) | Content + checksum (still in storage, only unreadable) | `{"pending_deletion": <seq of the deletion confirmed event>}`. When the same block is listed by two pending deletions, the earliest one is written |

When there is no removal mark but the content cannot be found, or the content does not match the checksum, `verify` reports a "mismatch"; "removed" is reported separately and does not count as a mismatch.

### 3.4 Provenance and cascade

For every data block, the vocabulary in §5 states two things:

- **Provenance**: which source data it depends on. There are three ways to write it: depending directly on some `source.recorded` events; depending on "the contribution of a write to a field" (that is, the `fields/<field ID>/<k>` block of another event, and following it further); depending on another block in this event.
- **On deletion**: when a privacy deletion cascades to its provenance, it is listed in the position list of that deletion, and is emptied at expiry.

A metadata block has no provenance, and in the first version it is not listed in the position list of any deletion.

### 3.5 Computed content is its own block, with `deps`

**A data block holds only the content that this request itself brings** (the values the caller gave this time, the interval endpoints given this time). Content that is computed or copied from **other contributions** is placed in a separate data block, and the block carries `deps`, stating which contributions the content comes from:

```json
"deps": [{"event": 15, "field": "f2", "k": 0}, {"event": 22, "existence": 0}]
```

Each item of `deps` points to one contribution of a `write.base` event: the `k`-th item of some field, or its `k`-th contribution to "existence" (`"existence": <k>`). The values that `backfill` fills in at a schema switch (§5.5) are not contributions of `write.base`, and **the constant itself does not enter `deps`, nor is it referenced by `carried`**: its value comes from a constant written in the schema, is not cleared by deletion, and a copy produces no user content that cannot be deleted. When a value in a block comes from it, the provenance is written as a `schema_const` entry (§5.7). But **the intervals of a backfill segment of a state table come from other contributions**: when an interval endpoint or the extent of a segment in a block comes from a backfill segment (`backfill/<table ID>/<field ID>/<n>`), the `deps` of that block is copied into the `deps` of this block.

When an interval endpoint stops at a stop point, "the contributions that give the stop point" are taken as defined in [`03-data-model/05-time.md`](03-data-model/05-time.md), "State of a state table: per field, per instant": all contributions for which that instant is an endpoint of their interval (on this field and on "existence"; when that instant is the boundary between has-a-value and no-value, also those on the fields that compute "has a value"), counting both sides, and counting those that are already covered; only contributions that rank before the write being resolved and are in effect are counted (candidates and awaiting confirmation are not counted), with the interval taken from the current state (in a deletion replay, from this replay), including a revoke that leaves an adjacent gap and the corroboration items to which a corroboration endpoint belongs.

The blocks of this kind are:

| Block | What is computed or copied |
|---|---|
| `span/…` of `write.base` (§5.7) | The resolved interval of a contribution: a default end point, a `corrected_span` that stops at a stop point given by another contribution; for entries written back by a revert or by taking the previous value, the interval is copied from the write that is reverted and from the segments carried over; a write with an expired `ver` that is cut by writes in the meantime into several entries |
| `ack/<j>` and `duplicate` of `write.base` | The interval and value of the contributions that are overwritten or matched; when the overwritten segment originally had no value (`no_value` of `ack/<j>`), it is the contributions that give its two ends and the revoke it belongs to |
| `backfill/<table ID>/<field ID>/<n>` of `schema.switched` (§5.5; state tables; for event tables and timeless tables `backfill_rows/*` are metadata blocks and are not in this list) | The intervals of constant backfill on a state table: the segments, fixed by other contributions, where the entity exists but the field is empty, or has a value that violates the new constraint |
| `ops/<i>/premise_valid/<j>` of `write.head` (§5.7) | When the range of a premise declaration is taken from the valid time of the row it depends on, and that time value comes from another contribution, the resolved point or interval |
| The entry blocks and `scope_valid` of an item (§5.8) | The values and intervals of other writes |
| `results/…` and `restated/<k>` of a deletion event (§5.9) | The segments after deletion, and the contributions that are restated |

There are only two rules:

1. **When any item in `deps` is privacy-deleted, or is restated by some deletion (§5.9, whatever the result of the restatement), this block is listed in the position list of that deletion.** Which blocks one deletion lists is independent of other pending deletions: "restated by this deletion" is judged by a replay that has only this one deletion (plus the deletions already executed), and not by the basis of `restated/<k>` in the event. The `restated` of §5.9 is computed with the other pending deletions taken into account; when another pending deletion has already restated the same item, this deletion's event no longer restates it, yet its block must still be listed; "privacy-deleted" likewise looks only at the contributions this deletion itself removes. This way, when one of the deletions is cancelled, the position list of the other does not have to change. What is listed are the blocks given by events before that deletion: the blocks given by the deletion event itself (`restated/<k>`, `results/…`) are not listed in its own position list; they are the result after this deletion, and so is a `deps` that points to another restated item in the same event (a shadow restated as `dropped`, an entry written back by a revert, and so on); later deletions judge them by this rule. "Privacy-deleted" is judged by (event, field or "existence"), not by index: the items of the same event on the same target have the same provenance and are always deleted together, while indexes are renumbered as deletion proceeds (§5.7). The only exception is `backfill/<table ID>/<field ID>/<n>` of `schema.switched`: it is listed only when an item in its `deps` is **privacy-deleted**, and not when restated (the backfill position stays as recorded, and a deletion does not restate it); its `deps` takes the two ends by the basis of "the contributions that give the stop point" above (§5.5), and the write from which the endpoint date originally came is always among them, so nothing is missed because of this. In blocks that have an interval (`span/…`, `results/…/fields/…`, `restated/<k>` with a `value`), the item pointed to by the value-source carry reference `carried` (§5.7) is **always listed in `deps` as well**, so for such blocks only `deps` needs to be looked at. A `sources/<field ID>/<k>` without an interval has no `deps`: when the item its `carried` points to is deleted, or restated as `dropped`, it is listed in the position list together with the `fields` of the same item (a carried item has no `literal` block).
2. **A result that has been cleared and that `apply` still needs afterwards (an item that is no longer a contribution, `dropped`, included) is given again by that deletion event** (`restated/<k>`, `results/…`, and for the entries of an item the `item.refreshed` that follows). **The judgement result of a contribution is whatever the most recent event in the log that gives it says.**

This way, content in the log that is computed from some contribution can always be found and deleted when that contribution is deleted; the blocks of a deletion event itself also carry `deps`, and later deletions clear them the same way.

---

## 4. The events of one operation and their order

### 4.1 Operations and operation numbers

**One operation** = all the events that one request of a caller (or one background action of the kernel) appends in one transaction. Their `seq` are consecutive.

- The first is the **head event**: it has no `op` field. Its `seq` is the **operation number** of this operation.
- The other events carry `op` = the operation number.
- The `actor` and `at` of events of the same operation are the same.

**Every externally visible sequence number is an operation number**: the `seq` of a write receipt, the sequence number in `ver`, the #n of the `history` timeline, the n of `revert: {undo: n}`, `as_of`, the `since` / `until` of `changes`, the recorded time interval of the version table, the sequence number in an item version. The `seq` of each event inside an operation is used only to address content blocks and for references between events, and is not exposed.

When reading by recorded position (`as_of: S`), operations whose operation number is not greater than S are visible as a whole and the others are invisible as a whole; an S that falls in the middle of an operation is the same as falling on its operation number.

Which event types can be head events:

| Head event | Operation |
|---|---|
| `write.head` | One `write` request |
| `item.resolved` | One `resolve` (except cancelling a deletion) |
| `deletion.confirmed` | Confirming a deletion |
| `deletion.cancelled` | Cancelling a deletion |
| `deletion.executed` | Physical erasure at expiry; the tombstone added for a placeholder pending-deletion entry at import |
| `schema.draft_submitted` | Submitting a schema draft |
| `schema.switched`, `schema.migration_failed` | A background migration reaches the switch or fails |
| `slot.policy_set` | Changing the slot policy (the initial policy at slot creation belongs to the operation of `schema.draft_submitted`). **Acting as a head event is a reserved shape that the first version does not produce**: in the first version it appears only as a member of the operation that creates a slot |
| `principal.registered`, `principal.renamed`, `principal.revoked` | Principal management |
| `tenant.genesis`, `tenant.restored`, `tenant.imported` | Creating a tenant, restore, import into an empty tenant |

`premise.changed` (§5.10) is not a head event: it appears only as a member of these kinds of operation: a write, a resolve, a deletion confirmation, a deletion cancellation, and a schema switch (when the new version deletes a field that a premise declaration declares).

The head events that carry the metadata block `ctx` (§5.1): **all head events initiated by a caller** (`write.head`, `item.resolved`, `deletion.confirmed`, `deletion.cancelled`, `schema.draft_submitted`, the three `principal.*`; `slot.policy_set` too when it later acts as a head event), and the `deletion.confirmed`, `deletion.cancelled` and `principal.revoked` that `system` produces. The other system-generated head events (`tenant.genesis`, `tenant.restored`, `deletion.executed`, `schema.switched`, `schema.migration_failed`) do not carry it. Although `tenant.imported` is initiated by a user session, like the genesis event it is an event that establishes the state of a tenant, does no judgement, has no slot, and does not carry it either. Those that carry a request key additionally have a `request_key` block.

### 4.2 Writes

**An op that got into an event**: an op that has its `ops/<i>/target` in `write.head`. An ordinary op always gets into an event, including one whose fields are all no-ops and one that only changes premises (restate, clear). An op located by external key gets into an event only when it leaves something behind: it added a row, or it hit an existing row with at least one field that is not a no-op; an op by external key whose result is `unchanged` (all fields are no-ops) or `skipped` (skipped) gets into no event and appears only in the receipt ([`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md), "Writing by external key").

The events that one `write` request appends, in this order:

1. `write.head`: one.
2. `source.recorded`: one per piece of new evidence, in the order of the evidence in the request (request-level first, then the inline pieces of each op). When no evidence is given, **one `api_call` per op that got into an event**: it is produced only for an op that has neither request-level evidence nor inline evidence; an op that did not get into an event is not stored. When in one request some ops carry evidence and some do not, the `api_call` entries come after all evidence pieces, in the order of the ops in the request. `source_ref` produces no event.
3. For each op that got into an event, in the order in the request:
   - `write.base`: one for the row or entity this op acts on (an op acts on only one row or one entity; when a revert changes several rows as a consequence, one per row). A field that is a no-op does not enter `write.base`; when all fields of this op are no-ops it is not produced, and an op that only changes premises (restate, clear) does not produce it either.
   - The item that this op opens or merges into: `item.created`, `item.merged` (the entries are as at the end of the whole request, see step 4).
4. Refresh and supersession of existing items: after the events of all ops, `item.refreshed` and `item.superseded`, at most one per item (§5.8, "Item content within one request").
5. `premise.changed`: after the events of all ops and items, at most one, present only when this operation changes the state of some premise declarations (§5.10).
6. `write.derived`: in the topological order of the derivation dependencies, and within the same rule in the lexicographic order of `partition_id`, one for each derived row whose result changed.

When **no op in a request gets into an event** (all are `unchanged` / `skipped` by external key), this request **appends no event**: no `write.head`, no source data, no request key, and no operation number; the receipt is still given.

Example: step one, "lunch cost 45 yuan today" (the same ledger and the same sequence numbers as [`../guide/02-walkthrough.md`](../guide/02-walkthrough.md)).

| `seq` | `type` | `op` | Description |
|---|---|---|---|
| 21 | `write.head` | — | Head event, operation number 21 |
| 22 | `source.recorded` | 21 | The original words, external ID `s_1` |
| 23 | `write.base` | 21 | Adds the lunch row |
| 24 | `write.derived` | 21 | The monthly total for 2026-11 |

In the receipt `seq: 21`, and this row has `ver: "v21.0"`.

Example: a write with an expired `ver` becomes a conflict candidate.

| `seq` | `type` | `op` | Description |
|---|---|---|---|
| 37 | `write.head` | — | Operation number 37 |
| 38 | `source.recorded` | 37 | "The taxi was 32 yuan" |
| 39 | `write.base` | 37 | The `status` of `fields/f3/0` is `candidate` |
| 40 | `item.created` | 37 | A conflict item |

The value in effect did not change, so there is no `write.derived`; the `ver` of this row does not change.

### 4.3 Resolving an item

The events that `resolve` appends:

1. `item.resolved`: the head event.
2. `source.recorded`: one per piece of evidence the resolve request carries; when a `note` is carried, or when the handling triggers a write and no evidence is carried, there is one more `api_call` (the request itself, including the `note`). It is not produced when no evidence is carried, no `note` is carried, and no write is triggered. `item.resolved` references them as operation sources (`op_sources`).
3. The `write.base` that the handling triggers (taking a candidate, confirming a proposal, taking the previous value, revoking the flagged row), and the item events that it leads to.
4. `premise.changed`: at most one, with the same rule as for writes (§5.10).
5. `write.derived`.

When handling a `schema_change` item, `item.resolved` is followed by `schema.confirmed` or `schema.rejected`, see §4.5.

Example: `take_candidate`, taking the 32 of the example above.

| `seq` | `type` | `op` | Description |
|---|---|---|---|
| 41 | `item.resolved` | — | Operation number 41 |
| 42 | `source.recorded` | 41 | `api_call`: the resolve request itself |
| 43 | `write.base` | 41 | Amount 32, the value source is a reference to that contribution of #39, and #42 is the operation source |
| 44 | `write.derived` | 41 | The monthly total |

### 4.4 Deletion

**Confirmation**:

1. `deletion.confirmed`: the head event, with the fully computed result written in.
2. For each write that turns awaiting confirmation because of the deletion, one `item.created`; for each item superseded because of the deletion, one `item.superseded`; for each item whose content entries are cleared and which is still open, one `item.refreshed`.
3. `premise.changed`: at most one (§5.10).
4. `write.derived`: one for **each** derived partition that the affected rows fell in before the deletion and after the deletion, **appended even when the result did not change** ("results that did not change are not recorded" for writes does not hold for deletion confirmation). When replaying from the start after the tombstone is applied, the deleted content is no longer present at the events in between, and the derived partitions compute a different set of intermediate values all the way; these derived writes are the only place that pulls them back to the live result.

**Cancellation**: `deletion.cancelled` (head) → item events → `premise.changed` (at most one) → `write.derived`, with a shape symmetric to confirmation: cancellation likewise appends one `write.derived` for each derived partition that the affected rows fall in, even when the result did not change.

**Expiry**: `deletion.executed` (head, the tombstone), this one only. It does not change the current business state. The tombstone added for a placeholder pending-deletion entry at import (§5.2 `tenant.imported`) is such an event too.

Example: deleting the sentence of the correction (the lunch amount returns to 45).

| `seq` | `type` | `op` | `actor` | Description |
|---|---|---|---|---|
| 42 | `deletion.confirmed` | — | Connection A | Operation number 42 (it continues the resolve #41 of "keep 35" in the guide; the example of §4.3 is another branch, taking the candidate, which occupies #41–#44, and the two examples do not hold at the same time); the new `ver` of the lunch row is `v42.0` |
| 43 | `write.derived` | 42 | Connection A | The monthly total |
| 44 | `deletion.executed` | — | `system` | 24 hours later (the grace period expires at 2026-11-11T05:02:11Z, and this tenant has no other operation in between, so it follows immediately); `trigger: "deletion_expiry"` |

### 4.5 Schema

**Submitting a draft** (creating a slot or changing a structure): if it does not compile, that is an error and no event is produced. After it compiles:

1. `schema.draft_submitted`: the head event.
2. `schema.superseded`: one, when the slot has an earlier draft that is not yet confirmed (together with the `item.superseded` for that draft's `schema_change` item).
3. `schema.compiled`.
4. After that, two cases:
   - Takes effect automatically (a new slot, or a change that may take effect automatically under the slot policy): `schema.confirmed` → when creating a slot, one `slot.policy_set` (the initial policy) → **no physical table needs rebuilding** (`rebuilt_tables` is empty: a change to the catalog only) or, when creating a slot, directly `schema.switched` (followed by at most one `premise.changed`, see the end of this section), otherwise `schema.migration_started`. The criterion is whether the physical shape changed, regardless of the category of the change: adding an optional field belongs to the "metadata only" category, but it rebuilds the physical table, so it goes through `schema.migration_started`. **Adding a table does not count as a rebuild**: the new table is empty, there are no earlier writes to convert, and the table is created inside the switch's transaction, so it goes directly to `schema.switched` (`rebuilt_tables` is empty). **The same holds for changing the structure of a table that was never written**: the table is replaced by a new physical table (`physical.since` in the compiled definition is this version), but the log has no `write.base` targeting it and so no earlier writes to convert; the table is likewise created inside the switch's transaction, goes directly to `schema.switched`, and is not listed in `rebuilt_tables`.
   - Awaiting confirmation: `item.created` (a `schema_change` item).

**Confirming or rejecting** (`resolve`): `item.resolved` (head) → `schema.confirmed` or `schema.rejected` → on confirmation, followed by `schema.switched` (no physical table needs rebuilding; followed by at most one `premise.changed`, see the end of this section) or `schema.migration_started`. For any change in the draft that was compiled as "never written" (those whose `class` is therefore recorded as `metadata` and for which `migrate` may be omitted), if the table it belongs to has been written by the time of confirmation, `resolve` is always rejected (`draft_outdated`, `table_written`), no event is produced, and the item stays open. Confirmation does not recompile according to which tables have been written: the judgement recorded in `schema.compiled`, the one the confirming party saw, is the judgement that is executed.

**A background migration ends**: `schema.switched` (head, `actor: "system"`, `trigger: "migration"`) → one `item.superseded` for each item superseded by the switch → `premise.changed` (see below). On failure it is `schema.migration_failed` (head).

**Premises at a switch**: after any switch (one that needs no physical table rebuild, and one that ends a background migration), when the new version removes a field declared by some premise declaration (including a field removed together with its table), there is at most one `premise.changed` after `schema.switched` and its `item.superseded` events (§5.10); when there is no such declaration, none is produced.

The process of building the new version's tables in the background produces no events.

Example: creating the `ledger` slot.

| `seq` | `type` | `op` |
|---|---|---|
| 2 | `schema.draft_submitted` | — |
| 3 | `schema.compiled` | 2 |
| 4 | `schema.confirmed` | 2 |
| 5 | `slot.policy_set` | 2 |
| 6 | `schema.switched` | 2 |

Example: adding a `budgets` table to `ledger` (version 1 → version 2; `add_table` takes effect automatically under the default policy and does not rebuild the existing tables).

| `seq` | `type` | `op` |
|---|---|---|
| 45 | `schema.draft_submitted` | — |
| 46 | `schema.compiled` | 45 |
| 47 | `schema.confirmed` | 45 |
| 48 | `schema.switched` | 45 |

### 4.6 Background tasks and restore

For an operation the kernel starts itself, the head event's `actor` is `system` and it carries a `trigger`. The first version has six kinds: physical erasure at expiry (`deletion.executed`); a migration switch or failure; the `tenant.restored` appended by the restore procedure; the deletion events the restore procedure adds from the deletion register (`deletion.confirmed`, `deletion.cancelled`, `deletion.executed`); the tombstone added at import for a placeholder pending deletion (`deletion.executed`, `trigger: "import"`); and the revocation of a connection when a refresh token is replayed (`principal.revoked`, `trigger: "oauth_refresh_replay"`). The `tenant.imported` of the import itself is made by the user principal that started the import, not by `system`.

Persisting and cleaning up the read record, residue cleanup, advancing the high-water mark, replay comparison, log verification and export produce no events.

---

## 5. Event types

Each type gives: who produces it, the fields specific to its event header, the vocabulary of its content blocks, and what `apply` does with it. In the "kind" column of the vocabulary: **meta** is a metadata block and **data** is a data block.

### 5.1 Blocks common to head events

| path | kind | content | notes |
|---|---|---|---|
| `ctx` | meta | see below | The call context and the judgement versions of this operation. All head events started by a caller have it; so do the deletion confirmations, deletion cancellations and revocations produced by `system`; the other system-generated head events do not (list in §4.1) |
| `task` | data | string | The task identifier the caller reports about itself. Its provenance is the same as that of `request_key` |
| `request_key` | data | `{"key": <string>}` | The request key the server computes from "connection + task + normalized request". The normalized request includes the version seen resolved for each premise (including those obtained by fallback); the `ver` filled in by fallback for a write target is not included |
| `idempotency` | data | `{"key": <string>, "fingerprint": <hash>}` | The idempotency key the caller gave explicitly, and the fingerprint of the request content (computed over the whole request body) |

`task`, `request_key` and `idempotency` appear only in head events started by a caller. Their provenance: all `source.recorded` events of this operation, and the source data that is referenced by a `source_ref` and appears in this operation's events (listed in `sources/<field ID>/<k>`, `valid_sources` or `op_sources` of some op that made it into the events). If any one of these is privately deleted, these three blocks are deleted with it. A `source_ref` segment that no op that made it into the events used is not included: this operation records no reference to it, the request holds only that source data's ID, and after it is deleted nothing of it remains in this operation. During the grace period, `request_key` and `idempotency` still take part in duplicate detection. A head event has at most one of `request_key` and `idempotency`: when the caller gave an explicit idempotency key, only `idempotency` is recorded.

**A `write` containing only external-key ops does not record `request_key`**: the external key itself makes a resend idempotent (submitting the same content again gives `unchanged`), and the server does not compute a request key for such a request. When the caller gave an explicit idempotency key and the request produced events, `idempotency` is recorded as usual; when the request produced no events, nothing is recorded. A request containing ordinary ops records `request_key` as usual.

**An operation with no source data at all** (`delete`; cancelling a deletion (`deletion.cancelled`: the request itself carries no evidence or content); `schema_draft`; a `resolve` that has neither evidence nor `note` and does not trigger a write; **a `write` that produces events always has source data**: at least its evidence, or the `api_call` of each op that made it into the events): these three blocks have no provenance and are outside the cascade of any privacy deletion. The "will not be deleted" list of the deletion preview lists them truthfully (`operation_labels` in the contract); so a task identifier should not contain user content. A `write` in which no op made it into the events produces no event, and so has none of these three blocks.

The shape of `ctx`:

```json
{
  "now": "2026-11-10T04:41:07.123Z",
  "today": "2026-11-10",
  "ruleset_version": 1,
  "policy_version": 1,
  "literal_checker": "literal@1"
}
```

| key | meaning |
|---|---|
| `now` | The current moment in the call context (taken at the entry point, possibly earlier than the event header's `at`) |
| `today` | The date of `now` in the slot's time zone. Omitted for operations that have no slot (`principal.*`) and for a `slot.removed` that makes no judgement |
| `ruleset_version` | The rule version used when this operation made its mechanical judgement (the kernel's integer version number). An operation that makes no judgement still records the kernel's version at that time. A version the kernel does not recognize: `apply` stops (§1.6) |
| `policy_version` | The slot's policy version when this operation made its judgement. Omitted for operations that have no slot (`principal.*`) and for `slot.removed`; the `schema.draft_submitted` that creates a slot records the version of the initial policy in the same operation |
| `literal_checker` | The version of the literal match checker (including the synonym table version). Only `write.head` has it. A version the kernel does not recognize: `apply` stops (§1.6) |

When a deletion is replayed, each earlier write is recomputed with the `ruleset_version` and `policy_version` recorded in its own head event.

### 5.2 Tenants

#### `tenant.genesis`

The first event of the log (`seq` = 1, `prev_hash` is 64 `0` characters). Produced by `saveslot init` or when server mode creates a tenant. `actor` is the user principal being registered.

Specific to the event header: `node_id`.

It is generated by the system when the tenant is created and is not an operation by a caller: **it has no `ctx`**, and no `task` or `request_key` either.

| path | kind | content |
|---|---|---|
| `tenant` | meta | `{"tenant_id": <string>, "storage_format": <integer>, "event_format": 1}` |
| `user` | meta | `{"principal": <principal ID>, "kind": "user"}` |
| `system` | meta | `{"principal": "system", "kind": "system"}` |

`apply`: creates the two rows of `principals`.

#### `tenant.restored`

The first event appended after a backup or snapshot is restored. `actor: "system"`, `trigger: "restore"`.

Specific to the event header:

| field | meaning |
|---|---|
| `node_id` | Newly generated; event identities use it from then on |
| `restore_id` | The ID of this restore; the restore procedure uses it to tell whether this event has already been appended |
| `restore_count` | The tenant's restore count after the restore (the value before the restore plus 1). It is the second number in the external `ver`, in the item version and in the handle |
| `restored_to` | The `seq` of the last event in the restored log |
| `high_water` | The high-water mark of `seq` that the anchor storage recorded at the time of the restore. This event's `seq` = max(`restored_to`, `high_water`) + 1 |

It has no content blocks. `verify` accepts the gap in `seq` between `restored_to` and this event on this basis. `restored_to` is also the restore point used when judging a `ver` issued before the restore ([`04-contract.md`](04-contract.md) section 15).

`apply`: no materialization action. The current restore count is not stored separately; it is taken from the `restore_count` of the most recent `tenant.restored` or `tenant.imported` in the log (`ver`, item versions and handles all read it); the restore count in the anchor storage has the same value: the restore procedure first adds 1 in the anchor, then writes the incremented value into this event.

#### `tenant.imported`

The event appended after an export has been loaded into an empty tenant (import is available only to user sessions, see [`04-contract.md`](04-contract.md) section 17). A head event; `actor` is the user principal that started the import, registered by this event, in the same way as the genesis event registers the user principal.

How import works: the events in the export file are appended one by one as they are and handed to `apply` (the bytes of the event header are the same as in the export, and content blocks are applied according to the three states in the export, §3.3); then this event is appended; then, for each placeholder pending deletion in the export, one tombstone is added (`deletion.executed`, `trigger: "import"`, `reason: "import_placeholder"`, §5.9). Which deletions count as placeholders is judged per block: in the concatenated file, if any block in a deletion's position list is a placeholder (`pending_deletion`), a tombstone is added for that deletion; the manifest's `pending_deletions` is not consulted. Tombstones are added in ascending order of the `seq` of the corresponding deletion confirmation event. For deletions whose pending content was explicitly included in the export, the deletions are still pending at the target and continue to the expiry time recorded in the events. Contract operations are not re-executed one by one: that would re-judge them and reassign `seq` and IDs, and the result would not be the same log.

Specific to the event header:

| field | meaning |
|---|---|
| `node_id` | Newly generated; event identities use it from then on (§2.2) |
| `restore_count` | The restore count in the export manifest plus 1 (when there are several segments, the last segment's manifest is used, §8). Item versions issued before the import therefore never match, and a `ver` from before the import is still recognized. The number in the manifest is checked first: it must be a non-negative integer not exceeding 2^31 − 2 and equal to the imported log's own current restore count (that of the most recent restore or import event, or 0 if there is none); otherwise the manifest does not match the content, and the import is rejected and not applied |
| `imported_upto` | The `seq` of the last imported event. This event's `seq` = `imported_upto` + 1. It is also the import point used when judging a `ver` issued before the import ([`04-contract.md`](04-contract.md) section 15) |

It is not a judgement and **has no `ctx`**, and no `task` or `request_key` either. The ID used by the import only names the staging storage and pairs with the "import in progress" mark in the anchor; it does not go into the events.

| path | kind | content |
|---|---|---|
| `tenant` | meta | `{"tenant_id": <ID of the target tenant>, "previous_tenant_id": <tenant ID in the export>, "storage_format": <integer>, "event_format": <integer>}` |
| `user` | meta | `{"principal": <ID of the user principal that started the import>, "kind": "user"}` |
| `export` | meta | `{"exported_at": <export time in the manifest>, "pending_deletions": "placeholder" \| "included"}`. When files from several segments are concatenated for import, the first segment's manifest is used |

- It is a separate event from `tenant.restored`: a restore does not change the tenant, does not change the user and does not disable principals, and it explains a gap in `seq`; an import has no gap, and what `verify` checks is that `prev_hash` follows the last imported event and that `seq` is exactly `imported_upto` + 1.
- The bytes of imported events do not change: the genesis event still holds the original tenant ID. **The current tenant ID is that of the most recent `tenant.genesis` or `tenant.imported`**; the manifest's `tenant_id` at export time takes it.
- An import can be done only once, into an empty tenant: after the import the tenant is no longer empty.

`apply`: registers the new user principal; **sets the user principals and connections that were registered before it and are still valid to disabled** (`disabled`; except `system`); those already revoked stay revoked (`revoked`). The principal in this event's `user` is not disabled and its status is valid: this also holds when it was registered in the imported log (the same user loads their own export back into an empty tenant); it records the current restore count and the current tenant ID. A disabled principal cannot authenticate and cannot be restored in the first version; the `actor` of the events it wrote does not change.

### 5.3 Principals

All three are head events and carry the `ctx` of §5.1 (there is no slot, so it has only `now` and `ruleset_version`). The `actor` of `principal.registered` and `principal.renamed` is the user principal that started them; for the `actor` of `principal.revoked`, see the note under that type; the `ctx` has the same shape for all three kinds of initiator. **In the first version they carry no `task`, `request_key` or `idempotency`**: the contract's `connections.*` has no task identifier or idempotency key parameter, and principal management does no idempotent de-duplication.

#### `principal.registered`

| path | kind | content |
|---|---|---|
| `principal` | meta | `{"principal": <principal ID>, "kind": "connection", "scopes": ["saveslot.read","saveslot.write"], "slots": ["sl_4KTZ…"], "via": "token" \| "oauth", "client": <OAuth client identifier>}`. `client` is required when `via` is `oauth` and absent otherwise; it identifies the client software and is not user content. For `slots` see below |
| `name` | data | `{"name": "MacBook · Claude Code"}`. The name the user chose. Provenance: none, outside the cascade of any privacy deletion; the `not_deleted` of the deletion preview lists it truthfully as `connection_names` |

`scopes` has no duplicates, must contain `saveslot.read`, and is arranged in the order in which the `Scope` enumeration lists them (`saveslot.read`, `saveslot.write`, `saveslot.schema`, `saveslot.delete`): the same set of permissions has only one way of being written.

`slots` is this connection's **slot range**: an array of slot IDs, in ascending ID order, without duplicates, not empty. **Omitted = all**, including slots created later (an omitted field is not encoded; a registration event with no range limit has no such key). The same `scopes` apply to every slot in the range. It holds only opaque IDs allocated by saveslot and is placed in the metadata block together with `scopes`; principal events are tenant-level events, the event header has no `slot`, and the range does not go into the event header either. A range cannot be changed after issuance; to change it, revoke and issue again. The service layer builds the visible range of the call context from the range recorded in `principals`; the control database does not keep a separate copy.

#### `principal.renamed`

| path | kind | content |
|---|---|---|
| `principal` | meta | `{"principal": <principal ID>}` |
| `name` | data | `{"name": <new name>}` |

#### `principal.revoked`

| path | kind | content |
|---|---|---|
| `principal` | meta | `{"principal": <principal ID>}` |

`actor` has three cases: the user principal that started the revocation (`connections.revoke`); the revoked connection itself (revoking its own authorization through the OAuth revocation endpoint, [`05-surfaces.md`](05-surfaces.md) section 15), in which case `actor` must equal the principal in the `principal` block, a connection cannot revoke another principal, and `apply` stops when the log contains such an event; and `system`, with `trigger: "oauth_refresh_replay"` (the same refresh token is used a second time and is treated as a token leak). Those started by a user principal or by a connection carry no `trigger`. The `apply` of the three is the same. Revoking a principal that is already revoked or disabled produces no event, whoever starts it: a connection that is already revoked or disabled cannot write a revocation of itself either.

`apply`: maintains `principals` (kind, name, scopes, slot range, status). The status is derived from events: after `principal.revoked` it is revoked (`revoked`); `tenant.imported` sets the principals registered before it that are still valid to disabled (`disabled`, §5.2), and those already revoked stay revoked; one with neither is valid. The token itself is not in the log; it is in the control database.

### 5.4 Slot policy and removal

#### `slot.policy_set`

Produced as a member of the `schema.draft_submitted` operation when a slot is created (the initial policy); afterwards, when the policy is changed, it is a head event (the first version has no operation that changes the policy and produces only the initial one).

| path | kind | content |
|---|---|---|
| `policy` | meta | see below |

```json
{
  "policy_version": 1,
  "effective_value_rule": "keep_current",
  "rank": {"user_stated": 2, "agent_inferred": 1, "miss": 0},
  "auto_apply": ["add_table", "add_derived_table", "add_optional_field", "description",
                 "rename_unused", "loosen_constraint", "duplicate_keys", "restructure_unused"],
  "high_impact": [],
  "user_session_only": []
}
```

| key | meaning |
|---|---|
| `policy_version` | The policy version of this slot, increased by 1 with each `slot.policy_set` |
| `effective_value_rule` | The rule for the value in effect during a conflict. The first version has only `keep_current` |
| `rank` | The rank table of source levels: on a literal match the rank of the declared level is taken, on a miss `miss` is taken. In the first version it is recorded but not used |
| `auto_apply` | Which categories of schema change may take effect automatically without confirmation. Values: `add_table`, `add_derived_table`, `add_optional_field`, `description`, `rename_unused`, `loosen_constraint`, `duplicate_keys`, `restructure_unused` (what each means is in the table in [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md) "Kinds of change and means of migration"; changing aliases, `change_aliases`, falls under `description`; structure changes on a table that was never written and is not in use, and field changes on such a table that would otherwise need confirmation (including adding a required field and changing the time field), fall under `restructure_unused`). The default policy when a slot is created has all eight on, as in the example above. The values are written in this event at slot creation: a slot whose `auto_apply` in the log does not contain `restructure_unused` does not enjoy this category, and the first version has no operation that changes the policy |
| `high_impact` | Tables or fields the policy additionally designates as high-impact: `[{"table": <table ID>, "fields": [<field ID>]}]`. Always empty in the first version; **non-empty is a reserved shape and does not belong to `v` = 1**, and when it is enabled the `v` of `slot.policy_set` is increased by one |
| `user_session_only` | Decisions accepted only when confirmed by a user session: `[{"type": <item kind>, "decision": <decision>}]`. Always empty in the first version; non-empty is a reserved shape, as above |

`apply`: updates the current policy pointer of `slots`.

#### `slot.removed`

Removes an empty slot (the contract's `slots.remove`). A head event; `actor` is the user principal that started the removal; the event header's `slot` is the slot being removed. It carries the `ctx` of §5.1 with only `now` and `ruleset_version` (no judgement is made); **it carries no `task`, `request_key` or `idempotency`**: `slots.remove` has no such parameters, and removing again by `slot_id` returns the result of the first removal and records no event.

| path | kind | content |
|---|---|---|
| `target` | meta | `{"slot_id": <slot ID>, "sv": <the current version at removal>}`. `slot_id` is the same as the event header's `slot` |
| `name` | data | `{"name": <the slot's name at removal>}`. The name the user chose. Provenance: none, outside the cascade of any privacy deletion (same as the `name` of `principal.registered`) |

Only an empty slot can be removed. Whether it is empty is judged from the log at write time (contract §17), and `apply` does not judge it again. `apply`: deletes the `slots` row, this slot's catalog (`catalog`) and row counts (`counts`), and DROPs the physical tables of its current version (the base tables with their version tables, and the derived tables). It **keeps** the slot's versions in the schema version table: the table numbers and the `slot_id` are not used again (the table numbers of a new slot are assigned after the largest number already in the schema version table, and a new `slot_id` is checked for duplicates against those that appear there); it keeps the request key of the operation that created it (a resend of that `schema_draft` within the window returns the original receipt and does not create another); `principals` does not change (the connection's slot range still holds this ID, and it is filtered out on reads and authorization); the read record does not change. When `target.slot_id` differs from the event header, when the slot does not exist, or when its current version is not `target.sv`, `apply` stops.

### 5.5 The schema lifecycle

#### `schema.draft_submitted`

A head event. `actor` is the submitter. It carries the blocks of §5.1.

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…", "base_version": <integer>, "creates_slot": <boolean>}`. There is no `base_version` when a slot is created |
| `draft` | data | The full text of the submitted schema document (JSON). Provenance: none. The names, descriptions and enumeration values in the schema document are outside the cascade of any privacy deletion |

#### `schema.compiled`

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…", "target_version": <integer>, "outcome": "applied" \| "pending"}`. `target_version` is the version number this draft was assigned at compile time: the next after the numbers this slot has already used; a number held by a rejected or superseded draft also counts as used and, once assigned, is not used for another draft; so a version number corresponds to only one compiled definition, and `sv` need not be contiguous |
| `compiled` | data | The compiled definition (§7). Provenance: none, for the same reason as above. Replay uses it and does not recompile |
| `changes` | meta | The changes, item by item, see below |

`changes` is an array. The keys of each item are the same, one by one, as those of the contract's `SchemaChange` ([`04-contract-types.md`](04-contract-types.md) 5.3), with one difference: tables and fields in `target` are written by ID, not by name (a name is text written by the user and does not go into a metadata block).

```json
[
  {"target": {"slot": true}, "change": "create_slot", "class": "create",
   "compatible_with_old_writes": true, "destructive": false, "auto": true},
  {"target": {"table": "t1"}, "change": "add_table", "class": "create",
   "compatible_with_old_writes": true, "destructive": false, "auto": true},
  {"target": {"table": "t2", "rule": true}, "change": "change_rule", "class": "deterministic",
   "compatible_with_old_writes": true, "destructive": false, "auto": false},
  {"target": {"table": "t1", "field": "f4"}, "change": "change_type", "class": "deterministic",
   "compatible_with_old_writes": false, "destructive": false, "auto": false}
]
```

| key | meaning |
|---|---|
| `target` | What is changed, written in four ways: slot level `{"slot": true}` (`create_slot`, `rename_slot`, `change_timezone`); table level `{"table": <table ID>}`; field level `{"table": <table ID>, "field": <field ID>}`; derivation rule `{"table": <table ID>, "rule": true}` |
| `change` | The change code. For the values, see the table in [`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md) "Kinds of change and means of migration" (including changing aliases `change_aliases`, the external key's `add_external_key` / `drop_external_key` / `change_external_key`, and `change_time_type`, `change_entity_key`, `change_granularity`, `change_table_kind` and `change_ref`, which are allowed only on a table that was never written) |
| `class` | The category: `create` (creating a slot, adding a table) / `metadata` / `deterministic`. Reserved value: `reextract`. Any change that takes effect through `restructure_unused` (a change on a table that was never written and is not in use, including table-level structure changes and field-level `drop_field`, `change_type`, `add_required_field`, `change_time_field` and so on) is always recorded as `metadata`: the table has no existing values and no conversion, and `migrate` need not be given. `class` records what this switch actually does, not an intrinsic property of the change code. If the table has been written by the time of confirmation, the whole draft cannot be confirmed (§4.5) |
| `compatible_with_old_writes`, `destructive`, `auto` | The results of the judgement at compile time, recorded as they are. `target.outcome` is derived from the `auto` of the items (`applied` only when all are true); replay reads the recorded values and does not recompute them under the policy of the time |
| `as_never_written` | Optional; can only be `true`, only goes with `class: metadata`, and the target can only be a table or a field: this item was compiled as "never written" ([`03-data-model/07`](03-data-model/07-schema-evolution.md) "Restructuring a table that was never written"), and it holds only while the table has never been written. The re-judgement at confirmation (§4.5: if the table has been written, the whole draft cannot be confirmed, `table_written`) and the whole-table rejection of writes that carry the old `sv` after the switch look only at this key and do not infer from `class` and the change code (a change to the catalog only is likewise recorded as `metadata`). A newly added optional key, compatible with older events |

The order of `changes` does not depend on how the draft is written; the same set of changes always has the same order: slot-level changes first; then the existing tables by table ID, each table with its table-level changes first and then its field changes by field ID; then the deleted tables by table ID; and last the added tables by the IDs they were assigned. Several items on the same target follow the order in which the change codes are listed in `SchemaChangeCode` in [`04-contract-types.md`](04-contract-types.md) 5.3. (Table IDs and field IDs are compared by their numeric part.)

The first `schema.compiled` of each slot always contains a `create_slot` item (the first two items of the example above are the case of creating a slot and the last two are the case of a later modification; they are put together only to list all the forms of writing).

The row counts and trial-run samples in the impact preview are estimates made at submission and do not go into events.

#### `schema.confirmed`

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…", "target_version": <integer>, "by": "auto" \| "resolve"}` |

#### `schema.rejected`

The confirming party rejected the draft.

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…"}` |

#### `schema.superseded`

A draft that was not yet confirmed is superseded by a new draft of the same slot.

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…", "by_draft": "d_…"}` |

#### `schema.migration_started`

| path | kind | content |
|---|---|---|
| `target` | meta | `{"migration_id": "m_…", "draft_id": "d_…", "from_version": <integer>, "to_version": <integer>}` |

`apply`: records only the migration state. The new-version tables under construction are local runtime state and are not created by this event.

#### `schema.switched`

The current version pointer points to the new version. For a change that needs no physical table rebuild (`rebuilt_tables` is empty) and when a slot is created, it is a member of the operation that submitted or confirmed; one that went through a background migration is a head event (`actor: "system"`, `trigger: "migration"`).

| path | kind | content |
|---|---|---|
| `target` | meta | `{"draft_id": "d_…", "from_version": <integer>, "to_version": <integer>, "migration_id": "m_…", "rebuilt_tables": ["t1","t2"]}`. There is no `from_version` when a slot is created; there is no `migration_id` when no migration was involved. `rebuilt_tables` lists only the **base tables** whose physical tables were rebuilt from the log and must be checked; added tables and tables whose structure changed without ever having been written do get new physical tables, but have no earlier writes to convert and are not listed. Derived tables are rebuilt from the new definition at every switch, are not listed here and have no `tables/<table ID>` block (they are checked through the checksum of their own derived writes) |
| `tables/<table ID>` | data | `{"rows": <integer>, "checksum": <hash>}`: the number of logical rows and the result checksum (algorithm in §5.13) of that new-version table once built. One block for each rebuilt table. Provenance: all contributions of all rows of that table |
| `backfill_rows/<table ID>/<field ID>/<n>` | meta | Event table, timeless table: the IDs of the rows to which this switch's constant `backfill` gave a value for this field, as a list of row IDs. All the row IDs are split into consecutive chunks in ascending order, at most 10,000 per block, with `n` starting from 0. It does not appear when nothing was backfilled |
| `backfill/<table ID>/<field ID>/<n>` | data | State table: a stretch that was given a backfilled value, `{"entity": <entity ID>, "valid": {…}, "deps": […]}`, one block per stretch, with `n` starting from 0. The interval is determined by other contributions (what is backfilled is those stretches where the entity exists and the field is empty or has a value that violates the new constraint; the intervals where an entity exists are determined by writes and revocations, and the switch does not recompute them). `deps` are the contributions that give the two ends of this interval: following the definition of "the contributions that give the stop point" in §3.5, all contributions for which that instant is an endpoint of their interval, counting both sides and including those already covered (the contributions on this field and on "existence"; when that instant is the boundary between has-a-value and no-value, also those on the fields that compute "has a value"), without recursing into their own `deps` | `deps` (§3.5; cleared only when one of them is deleted, not when restated) |

- `tables/<table ID>` is used for checking, not for generating: when replay reaches this event, `apply` converts each write of the old version into the new version's shape according to the definition in `compiled`, builds the tables in `rebuilt_tables`, and then compares them with this block; when the block has been deleted, the check is skipped. The conversion of each write is item by item: each item of an old write on a field becomes one item on the same field of the new version; an item with a value is evaluated according to `migrate` (contributions produced by an earlier switch's backfill are converted likewise and are still recorded under that switch), and an item whose value is empty (`"value": null`), `no_value` or `uncovered` is not evaluated and is passed over unchanged; the state, the interval, the provenance and whether it has been reverted do not change ([`03-data-model/07-schema-evolution.md`](03-data-model/07-schema-evolution.md) "How deterministic conversions are replayed").
- When any contribution of any row of that table is privately deleted, this block is put in the position list of that deletion.
- **Backfill positions follow the record, and deletion does not change them**: a later deletion does not restate the switch's backfilled values and does not backfill the constant again. When a deletion makes a field somewhere empty, it is empty (`kept_fields_cleared`), even if that field is required. For a backfilled stretch of a state table, when a contribution in `deps` is deleted, this block is put in that deletion's position list (§3.5) and that backfilled stretch no longer exists with it; when a contribution in `deps` is only restated, it is not put in the list and that backfilled stretch stays as it was.
- `apply`: builds the new-version physical tables (at replay; every table whose `physical.since` in `compiled` equals this version is built); changes the current version of `slots`; marks the old version as retired; rebuilds the derived tables from the new definition; rebuilds `counts` from the new-version tables; rebuilds the key index `external_keys` from the new-version tables (for a table from which the external key was removed, the entries are cleared). The rebuild keeps "yielded" and "frozen" (together with the frozen set): a revoked row that yielded its key still holds the key field's value, and rebuilding by value would give it the same key as the holder. The declaration and state of premises do not change with the switch: the origin items' (event, field ID, index) are the same before and after conversion, and `premise_edges` is not converted; when no field is removed, the switch produces no `premise.changed`, and when one is, see §5.10. The values produced by a constant `backfill` are registered as this event's contributions **according to the records of `backfill_rows/*` and `backfill/*`** (in `base_sources` the event `seq` is this event, a row or entity ID is attached, and the kind is schema constant; in the version table the origin is this event and the intent is `schema_switch`), and where they are backfilled is not recomputed from the state reached by replay at this point. A stretch whose `backfill/<table ID>/<field ID>/<n>` has been removed is not registered: that backfilled stretch no longer exists. **When the entity or row does not exist at the point replay reaches here, the two kinds of table are handled differently**:
  - Event table, timeless table: a row listed in `backfill_rows/<table ID>/<field ID>/<n>` that does not exist when replay reaches here is registered into the provenance table as recorded (this contribution exists all the same), and nothing is written if the business table has no such row; this row is afterwards given whole by the result of a deletion (a row whose giver of "existence" changed, in "Which to list" in §5.9).
  - State table: `backfill/<table ID>/<field ID>/<n>` is registered as recorded and applied as recorded, regardless of whether the entity exists when replay reaches here. When the entity does not exist at that time (the interval block of the contribution that created it has been cleared and was not applied at the original event), this stretch is created on the business table with only this field (the same as "only the fields given by this write" when a §5.7 `write.base` writes to a row or entity that does not exist); the other fields are given by the result of a later deletion (the stretches given by restated items are listed as in "Which to list", and every listed entity carries `results/<k>/existence`). The backfill does not change the `ver` of the row or entity. Later events do not reference this contribution: when a value falls back to it, the provenance writes a `schema_const` entry (§5.7).

#### `schema.migration_failed`

A head event, `actor: "system"`, `trigger: "migration"`.

| path | kind | content |
|---|---|---|
| `target` | meta | `{"migration_id": "m_…", "reason": "build_failed" \| "verify_failed"}` |

`apply`: sets the migration state to failed; the old version remains current.

### 5.6 Source data

#### `source.recorded`

A piece of evidence is stored as one source data record. Other events refer to it by the `seq` of this event.

| path | Kind | Content |
|---|---|---|
| `target` | metadata | `{"source_id": "s_…", "kind": <evidence kind>, "level": "user_stated" \| "agent_inferred", "op_index": <integer>}`. `op_index` is present only for the `api_call` of a `write`: which op of the request this source data is the request of (the same as the `i` of `ops/<i>` in `write.head`). The `api_call` of a `resolve` has none |
| `text` | data | `{"text": <original text>}`. For `user_message`, `agent_note`, `tool_result` |
| `file` | data | `{"name": …, "mime": …, "size": <integer>, "sha256": <hash>, "origin": …, "excerpt": …}`. For `file_ref`; the last three keys may be absent |
| `request` | data | The JSON of the request itself. `api_call`: for `write` it is that one op (the values of no-op fields are not recorded, only the field names are kept; an op by external key includes the value of `external_key`; a restate and a clear include their `premises`); `resolve` records only `id`, `decision`, `candidate`, `note` and the references to the evidence it carries (`evidence`: the source data IDs of the segments, in the order the evidence appears in the request; this key is absent when no evidence was carried), and **does not include the content of the evidence segments**: each piece of evidence has its own source data, and recording a second copy here would be a copy that cannot be reached for deletion |
| `stated_at` | data | `{"at": <instant>}`. The caller's statement of "when this sentence was said"; may be absent |

- Values of `kind`: `user_message`, `agent_note`, `tool_result`, `file_ref`, `api_call`. `source_ref` produces no event.
- **The granularity of `api_call`**: when a `write` carries no evidence, there is one for each op that entered the events (§4.2), containing only that op; an op by external key that did not enter the events is not stored. A record that arrives by sync corresponds to one op, and deleting its source data removes only the contribution of this record, without affecting the other records of the same batch. The `api_call` of a `resolve` is at most one per request (§4.3). When the request produced events, the evidence that the caller carried explicitly is stored as it is, whether or not an op that entered the events refers to it; when the request produced no events (the last paragraph of §4.2), nothing needs source data and the evidence is not stored either; the receipt states truthfully that the evidence was not stored.
- Each source data record has exactly one of `text`, `file`, `request`.
- All four data blocks have this event itself as their provenance: when this source data is privacy-deleted, all four blocks are deleted and `target` stays.
- `apply`: registers the source data (for the provenance tables to refer to, and for `sources` to list and search).

### 5.7 Writes

#### `write.head` (the logical write head)

One for each `write` request that produced events, as the head event (a request in which no op entered the events does not produce it, §4.2). It carries the blocks of §5.1, plus:

| path | Kind | Content | Provenance |
|---|---|---|---|
| `request` | metadata | `{"sv": <integer>, "sv_basis": "explicit" \| "fallback", "op_count": <integer>}`: the schema version the request carried, whether the caller carried it or it was obtained by falling back on the read record, and the total number of ops in the request (including those that did not enter the events) | — |
| `ops/<i>/target` | metadata | See below | — |
| `ops/<i>/set/<field ID>` | data | The **original value** of this field (§1.3). Recorded only for a field that is not a no-op. The key field of an external key is recorded only in the write that obtained the key (adding by external key, or supplying the key) | All the evidence this field refers to in this op (all of it is needed at the same time); for a key field: all the evidence of this op |
| `ops/<i>/noop` | metadata | The list of IDs of the fields that are no-ops in this op: `["f4"]`. When an external key hits an existing row, the key field is also listed here. Absent when there is no no-op field | — |
| `ops/<i>/explicit` | metadata | The list of IDs of the fields in this op that explicitly point to evidence by field (the keys of `evidence_by_field`, excluding `valid`; in the field order of the table): `["f2"]`. Used only for the same-value judgement: a field in it that has the same value as the version seen is a corroboration, not a no-op; replay and deletion replay use it to restore the input of the judgement. Absent when there is no explicit field | — |
| `ops/<i>/valid` | data | The original form of the interval parameter, see below | The evidence that the `valid` of `evidence_by_field` maps to; when nothing is mapped, all the evidence of this op |
| `ops/<i>/revert` | metadata | `{"undo_op": <operation number>, "include_later": <boolean>}` | — |
| `ops/<i>/acknowledge` | metadata | `["overwrite"]` | — |
| `ops/<i>/named_fields` | metadata | The list of IDs of the fields that this op refers to by name, for the statistics of the rename preview | — |
| `ops/<i>/refs` | data | When the request refers to a row of this same request by a temporary name: `{"as": "<temporary name>"}` (the temporary name registered by this op: a newly created row, or a row hit by external key). The temporary name is text chosen by the caller and has meaning only within this request; the resolved row ID is recorded in the field value that refers to it | All the evidence of this op |
| `ops/<i>/baseline` | metadata | When an external key hits an existing row, the sync baseline position of each field: `{"f2": 30, "f3": 50}` (field ID → operation number). Absent when adding | — |
| `ops/<i>/premises/<j>` | metadata | The `j`-th premise declared by this op, see below | — |
| `ops/<i>/premise_valid/<j>` | data | The valid time of the `j`-th premise, see below. Present when the range is `row_time` or `given` | See below |
| `ops/<i>/premise_covers` | metadata | The origin items that the declarations of this op additionally cover: `[{"event": 52, "field": "f1", "k": 0}]` (for an item of "existence", written as `{"event": …, "existence": <k>}`). Absent when empty | — |
| `ops/<i>/premises_cleared` | metadata | `true`: this op carries `premises: []` (a clear). The items it covers are likewise listed in `ops/<i>/premise_covers` | — |

**No `ops/<i>/explicit` means no explicit field.**

**A no-op field leaves no value**: for a field that has the same value as the version seen and does not explicitly point to evidence, the event lists only the field ID in `ops/<i>/noop`, and no block holds its value. A same-value field that explicitly points to evidence is a corroboration (`ops/<i>/explicit`) and has items and provenance as usual.

**The number of ops is given by `request.op_count`**. The `i` of `ops/<i>` is the index of the op in the request; an op that did not enter the events (`unchanged` or `skipped` by external key) leaves its number empty, and no block exists under its index. The `target.op_index` of `write.base`, the `target.op_index` of `api_call` and the identity of a premise declaration all use this index.

`ops/<i>/target`:

```json
{
  "table": "t1",
  "row": "r_01JC8Z…",
  "intent": "correct",
  "ver": {"op": 21, "restore_count": 0, "basis": "explicit"}
}
```

| Key | Meaning |
|---|---|
| `table` | Table ID |
| `row` / `entity` | The target row or entity. When adding, the ID that saveslot has just allocated; when located by external key, the row ID that was located or newly allocated |
| `by_entity_key` | `true` means the caller located it by `entity_key` |
| `by_external_key` | `true` means the caller located it by external key (`external_key`). The result of locating is `row`; `apply` applies it as it is, and deletion replay does not locate again |
| `key_from` | When a key is supplied to a row that has no external key and this key is transferred from a row that has been revoked: the row ID of that row. That row no longer holds this key from then on |
| `created` | `true` means this op newly created this row or this entity (`undo` uses it to recognize the first creation). It is a mechanical judgement: when a privacy deletion changes it, the `recreated/<k>` of the deletion event gives the new value, and the one given most recently prevails (§5.9) |
| `intent` | Intent (§6.2) |
| `ver` | The version this op saw. `basis`: `explicit` (carried by the caller) / `fallback` (obtained from the read record as a fallback) / `same_request` (created by an earlier op of this request, so no `ver` is needed; `op` is filled with this operation number) / `external_key` (an external key hit an existing row: the version seen is taken by the kernel from the sync baseline position, `op` is the earliest baseline position among the fields this op involves, the position of each field is in `ops/<i>/baseline`; `restore_count` is the current restore count at the moment of the write. It is a position that the kernel took in this log, not a token: decoding and replay both use the recorded `op` and do not convert by the restore point below). `current`: `true` means that at the time of the write this version was the current version of this row (`op` and `restore_count` are both the same as the current version); it may be carried only when `basis` is `explicit` or `fallback` (a version obtained by `fallback` is carried only if it has been compared in the same way), and `same_request` and `external_key` do not carry it. For an op that carries it, the state seen is the state at the moment before it (in the order of the ops in the request, so earlier ops of the same request are included), including the records after `op` that did not change the version (corroborations, restatements of a deletion, items that took effect without changing any value); the lower bound of "after V" in the conflict criterion is likewise taken at this moment. It is judged once at write time, and replay follows the record and does not compare version numbers again. When this key is absent, the state seen is the state up to the operation `op` (the position seen). A token issued before a restore or an import (`basis` is `explicit` or `fallback`) is recorded as it is (`op` and `restore_count` are both given by the caller); its position seen is converted according to section 15 of [`04-contract.md`](04-contract.md): when the restore count is exactly 1 less than the current value at the moment of this event and `op` does not exceed the restore point at that moment, it takes its own `op`; otherwise it takes the restore point at that moment. The restore count and the restore point are both those of the most recent restore or import event before this event, so if there is a later restore or import, the position seen obtained by replay does not change either. When adding there is no `ver` |

`ops/<i>/valid` (only on state tables). A write to a state table by a caller always has this block; when neither start nor end was given, write `{"from": {"mode": "now"}, "to": {"mode": "next_change"}}`; a revoke without an interval has none. The write pipeline checks this when encoding, and its absence makes the event invalid:

```json
{"from": {"mode": "given", "value": "2026-11-02"}, "to": {"mode": "next_change"}}
```

| Key | Values of `mode` |
|---|---|
| `from` | `given` (with `value`) / `now` / `corrected_span` |
| `to` | `given` (with `value`) / `open` / `next_change` / `corrected_span` |

`corrected_span` is the form used when the intent is `correct` and neither start nor end was passed: the interval is the stretch of that field that contains "now" and is bounded by stop points. The end points resolved from `next_change` and `corrected_span` are the result of a mechanical judgement, and in a deletion replay they are resolved again against the state after the deletion. But the end point itself is a value computed from another contribution (which stop point it stops on, given by whom), so the resolved result is recorded in the `span/<field ID>/<k>` block of `write.base` with `deps` (§3.5; the contribution that gives the stop point counts on both sides); when the contribution that gives the stop point is deleted, or the resolved result is changed by a deletion replay, the old block is cleared and the `restated/<k>` of the deletion event gives the new value (§5.9).

`ops/<i>/baseline`: when writing by external key, the version seen that is used for judgement is taken per field, and each field takes its own sync baseline position ([`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md), "Writing by external key"). This block contains only field IDs and operation numbers; it is a log position at write time, and deletion replay uses it as recorded, handled in the same way as a `ver` obtained by fallback.

**Premises** ([`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md), "The premises of a write"): the caller declares in an op which values it has read that this write rests on. The declaration is an original argument and is recorded in the write head: a restate and a clear have no base write, and a write that becomes a candidate or awaits confirmation also needs its declaration recorded. An op by external key, an op that carries `revert`, and a revoke cannot carry premises, so `ops/<i>/baseline` and the premise blocks never appear on the same op. The identity of a declaration = (the operation number the declaration is in, the op index `i`, the declaration index `j`).

`ops/<i>/premises/<j>`:

```json
{"table": "t1", "row": "r_01JF…", "fields": ["f2"],
 "ver": {"op": 40, "restore_count": 0, "basis": "explicit"},
 "range": "whole", "state": "current"}
```

| Key | Meaning |
|---|---|
| `table`, `row` / `entity` | The premise target. When given by `entity_key` or by temporary name, the resolved ID is recorded here (the key value and the temporary name are content and are not recorded here) |
| `fields` | The list of declared field IDs. Default = the whole row |
| `ver` | The version seen. The same as the `ver` of `ops/<i>/target` (a token issued before a restore is recorded as it is, and its position seen is likewise converted by the restore point according to section 15 of 04-contract; the position seen is earlier than this operation, and for `same_request` it is this operation. Because the position seen has to be converted by the restore point, the `op` of a token may be no earlier than this operation (after an import, a token issued by the exporter after the export), so this is checked by `apply`, and the shape check only checks that `op` is a positive integer), but there is no `current` (a premise only compares values and does not take part in the judgement of the value), and `basis` is `explicit` / `fallback` / `same_request` (a premise has no form by external key) |
| `range` | The kind of valid time range declared: `whole` (the premise target is on an event table or a timeless table: no valid time) / `from_now` (the premise target is on a state table and continues from `ctx.now` onward; for `date` granularity, from `ctx.today`) / `row_time` (the premise target is on a state table and takes the valid time of the dependent row itself, see `ops/<i>/premise_valid/<j>`) / `given` (the premise target is on a state table and the caller gave a time, see the same block) |
| `state` | The result of the judgement when applied: `current` (the value seen is the current value) / `changed` (it had already changed when declared: it carries a flag as soon as it is written) |
| `reason`, `since` | Present only when `state` is `changed`: `since` is the first operation number in the stretch of versions that, after the position seen and from it on up to the time of the declaration, differ from the version seen over the declared range (`since` is greater than the position seen; because the position seen has to be converted by the restore point, it is not necessarily greater than `ver.op`; this is checked by `apply` and not by the shape check) (declaring at the moment seen and then detecting step by step yields exactly this); `reason` is the reason code of that operation (§6.8) |

This block is metadata: it holds only opaque IDs, field IDs, operation numbers, restore counts and enumerations. The key is named `range` and not `scope`: the `existence/<k>` of `write.base` already has `scope`.

The declarations of one op have pairwise different premise targets (`table` and `row` / `entity`): an origin item has only one effective declaration for one premise target (see "Cover" below), and a second one in the same op would push the first out. A `write.head` in which two declarations point to the same target is not a legal event.

`ops/<i>/premise_valid/<j>`: `{"at": <point>}` or `{"during": {"from": <point>, "to": <point>}}`, the valid time after resolution and already aligned to the granularity of the table the premise target is on. The start and end points of a valid time are what the user said, so it is a data block:

| `range` | Content | Provenance |
|---|---|---|
| `given` | The `valid_at` / `valid_during` given by the caller | All the evidence of this op (the same as `ops/<i>/valid` when nothing is mapped) |
| `row_time`, from a time field or interval that this op itself writes | The time value that this write gives the dependent row (whether this part took effect, became a candidate or entered awaiting confirmation) | The same as that block (`ops/<i>/set/<field ID>` or `ops/<i>/valid`) |
| `row_time`, from another contribution (this op writes no time field, or an interval end point was resolved from `next_change` / `corrected_span`) | The time value of the dependent row after the op | The block carries `deps`, pointing to the contribution that gives it (§3.5) |

A range taken from the dependent row is fixed at declaration time, and if the time of the dependent row is changed afterwards, the range of this declaration does not follow. From the moment this block is listed in the position list by a deletion confirmation (without waiting for the tombstone), the range of this declaration is handled as the whole timeline (preferring to report too much), and it is judged once more as the whole timeline in the detection of that deletion, with the change written into the `premise.changed` of the same operation; when that deletion is cancelled the range is restored (except where it is still listed by another pending deletion) and is likewise judged once more ([`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md), "The premises of a write", "Detection"). The tombstone clears only the copy of the valid time in `premise_decls`.

**Cover**: a declaration covers all the items of the `write.base` of this op on the target row, plus the items listed in `ops/<i>/premise_covers`: the other items of this row that were already in effect on the version seen by the op and are still in effect after the op. `premise_covers` is present only when all the fields of this op are already in effect (`applied`, `corroborated`, no-op); it is not recorded when some field became a candidate or entered awaiting confirmation, and it is not added later when that field takes effect through adoption or because of a deletion. **A clear is not subject to this limit**: an op that carries `premises: []` still records these items in `premise_covers`, and what it clears is the declarations of the whole row. A restate (an `update` without `set`) has no items of its own and only `premise_covers`. For the same origin item and the same premise target, the declaration that covers it latest prevails; on an item covered by a clear, all the declarations before it are invalidated together.

A premise takes part in no judgement of the value: the same-value, conflict, high-impact, existence, revert and deletion-replay judgements do not read it, and it does not enter the `deps` of any block.

`apply`: writes `request_key` / `idempotency` into the request key index (pointing to this operation number); registers the declarations in `premise_decls` according to `ops/<i>/premises/<j>` and `ops/<i>/premise_valid/<j>`; rewrites `premise_edges` according to `ops/<i>/premise_covers` and `ops/<i>/premises_cleared` (a clear registers one entry whose premise target is "all"); when supplying a key carries `key_from`, and the key field item `fields/<key field ID>/0` on the `write.base` of this op in the same operation is present (not removed), the entry of the key index `external_keys` is changed to point to the row of this op and the `key_from` row is marked "yielded"; when that item has been removed (replay from the start after a tombstone), it does not transfer, and the holder is still decided by [`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md), "How the holder is decided". The other blocks serve only `timeline`, the receipt of an idempotent replay, deletion replay and audit.

#### `write.base` (the base write)

The write of one op to one row or one entity. A state table records one per entity, not per physical segment.

**The contributions of a field are several items arranged by interval, one block per item.** On event tables and timeless tables every field always has exactly one item (`k = 0`). On state tables there is usually one item too; when a field has different values or different states over different intervals there are several items: `undo` and taking the previous value must write back several stretches of different old values; within the interval of a corroboration, part still has the same value (`corroborated`) and part has been changed by someone else (it takes part in the judgement as an ordinary write); `undo` reverts only the part still in effect. The intervals of the items are pairwise disjoint, and `k` rises with the start of the interval, starting from 0.

| path | Kind | Content | Provenance |
|---|---|---|---|
| `target` | metadata | See below | — |
| `fields/<field ID>/<k>` | data | One item of contribution that this write makes to this field: the status in effect and the value, see below | The value sources listed in `sources/<field ID>/<k>`; state tables add `valid_sources` |
| `sources/<field ID>/<k>` | data | The list of value sources of this item, see below | The same as `fields/<field ID>/<k>`; the two blocks are created and removed together |
| `literal/<field ID>/<k>` | data | The literal match record of this item, see below | The same as `fields/<field ID>/<k>` |
| `span/<field ID>/<k>` | data | State tables: the interval of this item after resolution, see below | The same as `fields/<field ID>/<k>`, plus the `deps` of this block (§3.5) |
| `existence/<k>` | metadata | One item of contribution to "existence", recorded by item just as a field is (always `k = 0` on event tables and timeless tables). Revoke: `{"status": …, "scope": "whole" \| "interval"}`; restoring existence (the write-back item when a revoke is reverted): additionally carries `"restored": true`. See below | — |
| `span/existence/<k>` | data | The interval of the item whose `scope` is `interval`: the interval of a revoke, or the interval of a restored existence. An item written back by a revert records its origin through the `deps` of this block, so when the write-back falls on the whole of time it is also `interval`, and the interval is written `{}`; when it is cut by other items the start may be open, written `{"to": …}` (§1.2). Only a whole revoke given by the caller is `whole` and has no such block. See below | A revoke given by the caller: `valid_sources` (a revoke with an interval given by the caller always has this block), plus the `deps` of this block; an item written back by a revert: the `deps` of this block |
| `valid_sources` | metadata | The source of the interval parameter: `[<seq of a source data event>]`. A base write with an interval parameter on a state table (a write and a revoke) always has this block: the segment that the `valid` of `evidence_by_field` maps to, or, when nothing is mapped, all the evidence of this op (when no evidence was carried, its `api_call`). One without an interval parameter (a write on a state table that gives no start or end, the default interval `corrected_span` of a correction, a whole revoke) has no such block | — |
| `op_sources` | metadata | The operation source: `[<seq of a source data event>]`. The base write of `undo`: the evidence of this request (its `api_call` when none was carried). A revoke given by the caller: the segments of its evidence that do not serve as the interval source; for a whole revoke, all the evidence (its `api_call` when none was carried). Absent when there is none; earlier events may not have this block | — |
| `duplicate` | data | The judgement of a suspected duplicate: `{"matched": [<row ID>], "keys": [<field ID>], "deps": […]}`. `matched` is the rows that were hit: 1 to 10, each appearing once, not including this row itself, ordered by most recent write (descending by the operation number of the last write in effect on the matched row); `keys` is the group of `duplicate_keys` that was hit, non-empty, each field once. Present only on a newly added row that has taken effect (the target is a row, not an entity). Judged once at write time and not recomputed afterwards | `deps`: the contributions in effect at that time on these fields of the matched rows |
| `ack/<j>` | data | A stretch that `acknowledge` confirms as overwritten: when there was a value, `{"field": "f2", "valid": {…}, "value": …, "op": <operation number that wrote this stretch>, "deps": […]}`; when there was no value, `{"field": "f2", "valid": {…}, "no_value": true, "deps": […]}`, without `value` and `op`. `no_value` has the same meaning as the key of the same name in `fields/<f>/<k>`: this stretch had no value, without distinguishing whether the entity had no value or the field had no contribution. Exactly one of `value` and `no_value` is present | `deps`: the contribution that wrote this stretch (when there was a value), the contributions that give the two ends of this stretch, and, when this stretch is inside a revoke, that revoke as well |
| `revert` | metadata | **The revert record**: which operations' changes on which targets this write reverted, see below. The base writes of `revert: {undo}` and of `take_previous` both carry it, in the same shape. It holds only event `seq`, operation numbers and targets (a field ID or "existence"), not indexes and intervals | — |
| `take` | metadata | **The adoption record**: the base write triggered by `take_candidate` carries it, leaving the record that deletion replay needs, see "`item.resolved`" in §5.8. It holds only the item, the candidate number, the operation number and (event, target), not indexes and intervals, and it is not cleared by deletion | — |

`target`:

```json
{"op_index": 0, "table": "t1", "row": "r_01JC8Z…", "intent": "correct", "cause": "request", "sv": 1}
```

| Key | Meaning |
|---|---|
| `op_index` | Which op of `write.head` this corresponds to (the index in the request, i.e. the `i` of `ops/<i>`). Absent when triggered by `resolve` |
| `table`, `row` / `entity` | The target |
| `intent` | Intent (§6.2) |
| `cause` | `request` (a write by the caller) / `resolve` (triggered by resolving an item). Reserved values are in §10 |
| `item` | When `cause` is `resolve`, the ID of the item that was resolved |
| `sv` | The schema version by which this write interprets the fields |
| `created` | The same as in the head event |

`fields/<field ID>/<k>`:

```json
{"status": "applied", "value": {"value": "54", "unit": "CNY"}}
```

| Key | Meaning |
|---|---|
| `status` | The status in effect of this item: `applied`, `candidate`, `awaiting`, `corroborated` (§6.3). A no-op field has no item |
| `value` | The value written, in canonical form (§1.3) |
| `no_value` | `true`: this item puts the field back into the state of **no contribution at all** (on state tables: over its interval). It applies to all three kinds of table and appears only in a revert and in taking the previous value: the place written back has **no contribution at all** at the value position. It **masks** the value underneath. It is not used when, at the value position, that place is inside a revoke; `uncovered` is used then. In this case there is no `value`, and this item has no `sources/<field ID>/<k>` or `literal/<field ID>/<k>`. It differs from `"value": null`: the latter explicitly sets an optional field to empty and is a value with provenance. When a required field is put back to having no value, whether the row or that valid instant still exists is judged by the ordinary rules of existence |
| `uncovered` | `true`: this item **only registers, gives no value, and does not mask what is underneath**: the item that was reverted no longer takes effect in this stretch, and whatever lies under it shows through. It appears only in a revert and in taking the previous value: at the value position this stretch is inside a revoke (what was reverted is a write that filled a value in a hole). In this case there is no `value`, `sources` or `literal`, and there are `span/<field ID>/<k>` and `deps`. The difference from `no_value`: `no_value` sets this place to no contribution at all, so when the revoke is reverted later there is still no value here; `uncovered` does not mask, so after the revoke is reverted or deleted, the value that was originally under the revoke appears as usual. Nor does it mask other writes: when that place has another filling write that is not in the revert record and took effect only later because of a deletion, what shows through is that filling write |

On state tables, each item additionally has a `span/<field ID>/<k>` block that records the interval of this item after resolution:

```json
{"valid": {"from": "2026-11-02", "to": "2026-11-10"},
 "deps": [{"event": 15, "field": "f2", "k": 0}]}
```

```json
{"seen_valid": {"from": "2026-11-02"}}
```

| Key | Meaning |
|---|---|
| `valid` | The valid interval of this item after resolution (per field, per item). When `status` is `applied`, `awaiting` or `corroborated`, it is resolved against the state at write time |
| `seen_valid` | `candidate` only: the interval resolved against the version seen by the writer. The interval of a candidate is this, and there is no `valid` then |
| `deps` | The other contributions used in resolving this interval (§3.5): who gave the default end point and the stop point that `corrected_span` stops on (both sides count); the contributions that cut this write into several items (writes that changed the value after the version seen); when this item was carried over, the item that `carried` in `sources/<field ID>/<k>` points to. **An item written back by a revert** (an undo, taking the previous value) additionally includes: the items covered by the entries of the revert record, the contributions of the writes that mask the skipped parts, and the givers of the two adjacent stretches of state at the value position at each interval end point of this item; taking the previous value additionally includes the candidates of the item. Among them, those that come from a backfill segment of a state table copy the `deps` of that `backfill/…` block (§3.5). An ordinary write whose two ends are both given explicitly by this request and which has only one item has no `deps` |

- A field that appears in the request and is not a no-op has at least one item. A field that does not appear in the request, and a no-op field, have no block.
- **The key field of an external key** has one item only in the write that obtained the key (`fields/<key field ID>/0`, `applied`, with the evidence of this write as its provenance): adding by external key, or supplying a key to a row that has no external key. When an external key hits an existing row the key field is a no-op, and no corroboration is recorded.
- **The event records neither the value before the write nor the whole row after the write.** The state after the write is obtained from "the state before + the items of this event whose `status` is `applied`"; for a state table, the `value` of each item is assigned to every valid instant within its `valid` interval, and the segmentation is then normalized by "adjacent points whose field values are all the same form one segment". Both steps are deterministic and contain no judgement.
- `status` is `corroborated`: the value is the same as the version seen and points explicitly to evidence. It produces no new version and only appends provenance to this field over the `valid` interval of this item. **Corroboration endpoints** = those of the start and the **explicit** end of this corroboration that fall on the end points of the corroborated item's interval (end points resolved from a default end do not count); they are derived from the current `status` and `valid` of this item and the original form in `ops/<i>/valid` of `write.head`, and are not recorded separately. An item without `ops/<i>/valid` (a write triggered by `resolve`, an item written back by a revert that was later restated as `corroborated` through a deletion) has no explicit end points; nor does it when this block was removed by a deletion, and "now" is not used to fill it in.
- **The judgement result of an item of contribution (status in effect, interval, `deps`) is the one given by the most recent event in the log**: this event, or the `restated/<k>` of a later `deletion.confirmed` / `deletion.cancelled` (§5.9). Later `undo`, conflict criteria and references to it all read the latest one.
- **An item whose `span` block has been removed, met during replay**: this item is not applied at this event; it is applied by the later deletion event that restates it (if it was not restated, it is no longer a contribution).

`sources/<field ID>/<k>`:

```json
[{"kind": "value", "source": 26}]
```

```json
[{"kind": "value", "carried": {"event": 39, "field": "f3", "k": 0}}]
```

| Entry | Meaning |
|---|---|
| `{"kind":"value","source":<seq>}` | The value source is a source data record (the `seq` of `source.recorded`) |
| `{"kind":"value","carried":{"event":<seq>,"field":<field ID>,"k":<integer>}}` | The value was carried over (undo, adopting a candidate, taking the previous value): it refers to the `k`-th item of contribution to this field made by another `write.base` event. On state tables the interval carried over is the interval of that item itself (`span/<field ID>/<k>`), and it is not recorded again here. In a deletion replay, an adoption item may refer to an item of the adopted write that in the replay has the same value as the version seen and no longer counts as a contribution (the index is the one the log gave most recently, and this or an earlier deletion restated it as `dropped`): the value source is still the source of the block it had when written; it does not count as a contribution again because of this |
| `{"kind":"schema_const","sv":<integer>,"field":<field ID>}` | The value comes from a schema constant: the value that the constant `backfill` of this field filled in at the switch to version `sv` (`field` is the field ID in that version; the table is the target table of this event). The value is written in the item as usual. It points to no event, and the constant itself produces no `deps` (when the interval of this item on a state table comes from a backfill segment, `span` copies the `deps` of that `backfill/…` block, §3.5). This item has no `literal` block |

Several `source` entries in one block mean "all needed at the same time"; several `carried` entries mean "any one still present is enough" (the same-value candidates merged when a candidate is adopted).

`existence/<k>` and `span/existence/<k>`:

```json
{"status": "applied", "scope": "interval"}
```

```json
{"valid": {"from": "2026-11-10", "to": "2026-11-20"}}
```

"Existence" is recorded by item just as a field is: the contribution of one write to "existence" is several items arranged by interval, the intervals of the items are pairwise disjoint, and `k` starts from 0. One revoke by the caller is always one item; a write-back by a revert may be several items (when the range of restored existence is split into non-adjacent stretches by other writes).

- `scope` is `whole`: revoke the whole row or the whole entity. It contains no content and is a pure decision with no value source; the evidence of the revoke request is recorded as the operation source (`op_sources`), and if the evidence is deleted the record still stands and the row does not come back; there is then no `span/existence/<k>`.
- `scope` is `interval` (state tables only): equivalent to "no value in this stretch". The interval is recorded in `span/existence/<k>`, which is content. For a revoke given by the caller, the source is `valid_sources`, and after that source is privacy-deleted this revoke as a whole makes no contribution; the segments of the evidence that do not serve as the interval source (the remaining segments when the `valid` of `evidence_by_field` maps to only some of the segments) are recorded as the operation source (`op_sources`); a revoke that carries only a start has its end resolved by `next_change` (the first stop point of any field after the start), and the resolved result is likewise recorded here with `deps` (the contribution that gives that stop point, both sides count, §3.5).
- When, in replay, `scope` is `interval` and `span/existence/<k>` has been removed: this item is not applied at this event, by the same rule as a field item.
- **"Existence" items written back by a revert** (writes that carry a revert record `revert`) are of two kinds, both obtained by the unified definition of revert (see below):
  - `restored: true`: what was reverted is a revoke, and this stretch exists at the value position → the row or entity exists again in this stretch. The value that the revoke masked is still there, and no field item needs to be written back; where a field has another change to revert, the field item is written back as usual.
  - Without `restored`: what was reverted is a "restored existence", and this stretch does not exist at the value position → one revoke item is written back, in the same shape as the item of an ordinary revoke. It has no `valid_sources`, and the source of the interval is the `deps` of `span/existence/<k>`.
  - The `scope` of both is the same as that of the item that was reverted; when it is `interval`, `deps` includes the corresponding items covered by the entries of the revert record, the item that gives the state at the value position, the writes that mask the skipped parts, and the givers of the two adjacent stretches of state at the value position at each interval end point of this item.
- **An "existence" item written by adopting a modification candidate on "existence"** (event tables and timeless tables, a write that carries the adoption record `take`): `restored: true`, `scope` is `whole`, and the row exists again; there is no `revert` block, and that revoke is not registered: when another restored existence takes effect after the revoke, that revoke no longer counts (03-deletion, "Replay rules", the row "the value of a field"). On state tables, adopting this kind of candidate writes no "existence" item and is recorded as a field item that fills an interval without a value (a required field is carried over from the merge base).

`literal/<field ID>/<k>`:

```json
{"segments": [{"source": 22, "result": "hit"}, {"source": 26, "result": "miss"}]}
```

One entry for each piece of evidence that this item refers to, with `result` being `hit` / `miss` / `na`; the order of `segments` is the same as that of `sources/<field ID>/<k>` of this item. The cases where `result` is `na`: the field type does not apply, the value is empty, or this piece of evidence has no comparable original text: an `api_call` (it is the request itself), or a `file_ref` without `excerpt`; a `file_ref` with `excerpt` is checked against `excerpt`. The version of the checker is in the `ctx` of the head event. Only an item whose value source is source data (a `source` entry) has this block: an item that was carried over (`carried`) is not literal-checked again and has no `literal` block, and its check result is that of the item it was carried from; an item whose source is `schema_const`, and items of `no_value` and `uncovered`, likewise have none.

`revert` (the revert record) and the unified definition of "revert":

`undo` and `take_previous` are two ways of taking the same kind of operation, **revert**. A revert consists of three things:

| | What it is | How it is obtained |
|---|---|---|
| ① The revert record | Which operations' changes on which targets are reverted, listed one by one (event, target) | **As recorded**. Fixed at write time and recorded in this block; deletion replay does not change it |
| ② The range | Over which valid times it reverts (state tables) | **Recomputed in the replay** |
| ③ The value position and the value | The state at which position it returns to; what the value there is | The position **as recorded**, the value **recomputed in the replay** |

```json
{"before_op": 25,
 "items": [{"event": 27, "field": "f3"}, {"event": 27, "field": "f1"}],
 "skipped": [{"event": 27, "field": "f1", "by_op": 33}]}
```

```json
{"as_of_op": 29, "item": "pi_3KD…",
 "items": [{"event": 35, "field": "f3"}]}
```

| Key | Meaning |
|---|---|
| `before_op` | `undo`: the value position is the state **before** this operation. It is the operation number of the write that is undone |
| `as_of_op` | `take_previous`: the value position is the state **up to** this operation number. It is the merge base (`merge_base_op`) that the item recorded when it was resolved, and it is not recomputed afterwards. Exactly one of this and `before_op` is present |
| `item` | `take_previous`: the item that is resolved |
| `items` | The entries of the revert record: `{"event", "field"}`, or, for "existence", `{"event", "existence": true}`, **without an index**. One entry covers all the items of that event on that target in the replay: whether the index existed at write time or was assigned by a deletion, and whatever the state at write time. Entries of later writes that `include_later` reverts along carry `"later": true` in addition |
| `skipped` | `undo` only: the entries that were already masked by later writes and skipped **at the time this `undo` was written**, in the same shape as the entries of `items` with `by_op` added (the write that masks it); when the same entry is masked by several writes, one is recorded for each. **These entries are also listed in `items`**; here they are only marked additionally to show the situation at that time, for history and receipts; the skipped intervals are not recorded, and deletion replay does not read it |

**① What entries the revert record lists** (fixed at write time):

- `undo`, where the operation m that is undone is an ordinary write: every base write e of m on this row or this entity, and **every target t that e had when written** (a field or "existence", according to the blocks of e when written), **whether the item of e on t was in effect, corroboration, candidate or awaiting confirmation at that time**, and regardless of which items it has left now (except the key field of an external key; a no-op field does not enter the base write and is not a target). So the parts of the undone operation that were candidates or awaiting confirmation when written and took effect later because of a deletion are reverted as well: what the person undid is that operation, not just the items that could be listed at that time. When all of them are skipped, this base write is recorded as usual: it has no write-back item, only `target`, `op_sources` and this block.
- `undo`, where m is itself a revert: the base write of m, and **every target that appears in the revert record of m** (including "existence"), whether or not m had a write-back item on that target when written. When m had no write-back item at that time, it cannot be undone by `undo` (`invalid_argument`), where "at that time" is judged by the state at the time this `undo` is written, including pending deletions: when a pending deletion restates all the write-back items of m as `dropped`, it is rejected; when a pending deletion gives m write-back items, it is accepted, and if that deletion is later cancelled, this `undo` covers no item and its end state is the same as if it had never been accepted. When m has no item in effect on this row and exactly one awaiting-confirmation revert on this row has taken effect through confirmation, the base write triggered by the confirmation and its revert record are taken (§5.8), not the one of the proposal; when m also has items in effect on this row, what is undone is the changes of m itself, and that revert is undone by the operation number of the confirmation; when m has no item in effect but has two or more confirmed proposals, it is rejected as "nothing to undo", and each is undone by the operation number of its confirmation.
- `undo`, where m is a confirmation (a `confirm` by `resolve` of an awaiting-confirmation item of the write kind): (the base write of m, **every target that the confirmed write had when it was written**), listed according to the blocks of the confirmed write at that time, without regard to which targets actually took effect at the moment this `undo` is written, and not only those that were awaiting confirmation at the time of the confirmation. When a later deletion makes other targets of the confirmed write take effect through this confirmation, they are reverted by this record in the same way: what the person undid is that confirmation.
- Later writes reverted along by `include_later`: at write time (or confirmation), when some later item is in effect (`applied`, not including corroboration), supersedes some item in effect of the undone operation according to step 3 of the revert, and the intervals intersect, list (the base write of that item, the target of that item) and mark it `later`. That target need not be a target of the undone operation: a later revoke supersedes the field item of the undone operation (list "existence"), and a later filling or restored existence supersedes the revoke of the undone operation (list the field or "existence"). When the later write is itself a revert, it is likewise picked by its items.
- `take_previous`: within the conflict unit and interval of the item, **the (event, target) that has an item that was in effect after the merge base and before this resolution**. "Was in effect" = was applied as `applied` or `corroborated` in this stretch of recorded time (at write time, or restated through a deletion), whether or not it has since been masked by a later write at the moment of the resolution, and whether or not it has been registered as reverted by another revert; including items written back by an undo or by taking the previous value. For an item whose target is "existence", the conflict unit is the whole row or the whole entity: anything that had an item in effect on any field, or on "existence", in this stretch of time is listed. **The candidates of the item do not enter the revert record**; they are closed by the resolution of the item.
- The record does not change with deletion replay. Operations outside the record are not added: a write that had not yet taken effect at the time of the resolution and took effect only later because of a deletion is not in the record; its effect on the result is decided entirely by the range rules below (when it ranks after some item covered by an entry of the revert record, it counts as masking that item, the same on all three kinds of table).

**② The range**:

- **The range of an item = its interval, minus the parts still masked; `take_previous` further intersects it with the interval of the item; for an item x under an entry marked `later` in `undo`, it further intersects with D(x).** D(x) = the union of the intervals of the items that the undone operation has in effect (or corroborating) in the replay, are not marked `later`, and that x supersedes according to step 3 (on event tables it is ⊤ or ∅): a later write reverted along is reverted only over the intervals that intersect the undone operation, and the parts beyond stay in effect as before. "Mask": after this item and before this revert, an item in effect that is not in the revert record supersedes it at that place (a later value on the same field; a later restored existence or filling above a revoke; a later revoke above a field value or restored existence). The interval of the item = the union of the intervals of the candidates that still exist.
- **The three kinds of table follow the same rule.** On event tables and timeless tables an item has no interval and is treated as an indivisible whole: when it is still masked, the range is empty and this item is **not reverted at all**; otherwise the whole item is reverted. The interval of the item on these two kinds of table is the whole conflict unit, and it is empty when all the candidates are gone.
- At write time it is computed against the state at that time, and the result is the sum of the intervals of the items this event writes back (`span/…`); an item whose range is empty has no write-back item.
- **Recomputed in a deletion replay**: each item takes its interval in the replay (the restated one if it was restated), a deleted operation does not count as masking, and a deleted candidate does not count in the interval of the item. So after the write that masked it is deleted, the part (or the whole item) that was skipped is reverted too; after the interval of a reverted item is resolved again, what is reverted is the new whole stretch; after a candidate is deleted, the interval of the item shrinks accordingly. For a case that had no write-back item at write time and whose range is no longer empty after the replay, the write-back item is given for the first time by the `restated/<k>` of the deletion event (the index continues after the largest index already used for this field or "existence" in this event).
- **A registration takes effect only within the range**: the items covered by the entries of the revert record no longer take effect within the range, and take effect as usual outside the range.

**③ The value**: at every place in the range, take the state at the "value position" in the replay. On the field side: when the place has a value, the write-back item gives the contribution that gives it with `carried` (when what gives it is the backfill of a schema switch, `carried` is not written, the source is written as a `schema_const` entry, and the `deps` of `span` do not list the constant itself; on state tables, when this place comes from a backfill segment, copy the `deps` of that `backfill/…` block); when there is no contribution at all, write back `no_value`; **when the place is inside a revoke, write back an item with `uncovered`**: after the item that was reverted (the one that filled a value in the hole) is registered it no longer counts as a filling, the revoke shows through again, this place returns to the hole, and the value under the revoke is untouched, and appears as usual after the revoke is reverted or deleted. On the "existence" side: when the place exists, write back "restored existence"; when it does not exist, write back one revoke item. In no case does it fall back to the value of the reverted item itself.

**Invariant: the sum of the intervals of the items that this event writes back on a field (or "existence") is the range of this revert on that field (or "existence").** Every place in the range has a write-back item (one of: a value, `no_value`, `uncovered`, restored existence, revoke); `apply` registers "has been reverted" by reading only the intervals of these items and does not compute the range itself. An item covered by an entry of the revert record is registered over "its interval ∩ this range"; an item x under an entry marked `later` is further intersected with D(x). There is no write-back item only when the range is empty (an `undo` in which everything is skipped).

**The authoritative definition is the pseudocode of the reference evaluator**, in [`03-data-model/03-deletion.md`](03-data-model/03-deletion.md), "Replay rules · The authoritative definition of reverting"; where the textual descriptions in this section and in other documents disagree with it, the pseudocode holds.

**Whether a reverted item is in effect is decided by the revert record, not by what was written back.** From this operation number on, the items in the replay of each (event, target) listed in `items` provide nothing within the range: they give no value, append no provenance, and their corroboration endpoints no longer count as stop points. The provenance table registers it this way, and later `undo`, conflict criteria and the reference evaluator all follow it.

**Write-back items** (the same rules for both ways of taking a revert):

- The `deps` of `span/…` (and of a restatement) include: the items covered by the entries of the revert record, the contribution that gives the state at the value position, and the writes that mask the skipped parts; `take_previous` additionally includes the candidates. They further include: **at each interval end point of a write-back item, the givers of the two adjacent stretches of state at the value position**, listing both sides (when one side has no contribution at all, only the other is listed; when one side is inside a revoke, that revoke is listed). When any of the above is a constant backfill segment of a state table, the constant itself is not listed, and the `deps` of that `backfill/…` block are copied. Example: #12 explicit `[10-01, 11-20) 5000`; #42 explicit `[11-10, 11-25) 4800`; `undo` #42 writes back `f2/0` 5000 `[11-10, 11-20)` and `f2/1` `no_value` `[11-20, 11-25)`. The end point 11-20 of `f2/1` is the end of that stretch of #12 at the value position, and the `deps` of `f2/1` are `[#42/f2/0, #12/f2/0]`; when the source of #12 is deleted, this block is cleared along with it.
- Like ordinary contributions, they take part in the same-value recomputation of the deletion replay (§5.9), with two qualifications:
  - When, among the items covered by the entries of the revert record, some are still contributions in the replay (including corroboration) and the range is non-empty, the written-back item is **not dropped for having the same value as before** (its function is to make those items not take effect).
  - When the items covered by the entries of the revert record are all not contributions in the replay, or the range is empty, the written-back item becomes `dropped`. Example: after `take_previous`, all the candidates are deleted and the interval of the item is empty, and the side in effect stays in effect as usual; all the side in effect is deleted while the candidates remain, and the written-back item becomes `dropped`, and the candidates stay closed.
- When only part of the items covered by a write-back item's entries of the revert record is no longer a contribution, it is enough to restate its interval narrower.

**When the target of a revert is itself a revert** (undoing an undo; undoing the resolution of a `take_previous`): it is handled as an ordinary write, what is reverted is the items written back by that revert, and the value position is before that operation. The revert record lists every target that appears in the revert record of the base write of that revert (see the way of listing above), so write-back items that grow out of it later through a deletion are covered as well. The items that that operation registered as "has been reverted" **stay registered unchanged**, and their values reappear through the write-back items of this revert (which carry them over). When what is undone is the resolution of a `take_previous`, the item stays resolved.

**What the entries of the revert record cover in a deletion replay**: one (event, target) covers **all the items** of that event on that target in the replay, whether the index existed at write time or was assigned by a deletion, and whatever the state at write time. So the items of the same (event, target) are always covered by the same group of reverts, and **there is no longer a case of being split by different coverage**. The items of any write follow the splitting and numbering rules below, not only the write-back items of a revert:

- **The interval of an item in the replay is the maximal contiguous stretch with the same state and content.** The "content" of a write-back item includes its giver: adjacent stretches with different givers are not merged, otherwise only one `carried` is left, and the cascade goes wrong when the other giver is deleted.
- **An original item** keeps its index and stays on the first stretch that intersects the interval block it had when written; when several original items fall in the same stretch they are **always merged into one**, keeping the smallest index, and the others are restated as `dropped`. An original item whose interval block at write time was cleared, before this confirmation or cancellation, by some deletion that was executed when due is handled in the same way as "an index assigned earlier by a deletion" in the next point, using its original interval: the deletion that cleared that block must have restated it (§5.9, item 2 of "Which items are restated"), so the original interval can always be read. An original index with no readable interval block (one that was restated as `dropped` and later became a contribution again) is reused in order of start from small to large, and no new number is assigned: `carried` and `premise_covers` may still point to it.
- **A newly split item** is numbered continuing after the largest index already used for that target. An index assigned earlier by a deletion stays on the first stretch that intersects its original interval (original interval = the interval most recently given for this item in the log before this replay: look backward in log order, skip the blocks given by the confirmation event of a cancelled deletion, also skip those restated as `dropped`, and take the first block that gave an interval; the block given by a cancelled deletion is never used as an original interval in any replay, but the restatement of the cancellation event itself counts). The block most recently given is used only to preserve the numbering of this kind of index.
- **Which original item a newly assigned index is split from** is decided by the interval block that the base write event gave when written (it is fixed in the log and does not change with the order of deletions or with cancelled deletions): look at where the start of the new index's interval in this replay falls among the intervals that the original items had when written; if it falls outside all intervals or in a gap, it belongs to the left neighbor (sorted by the start of the interval at write time; at the very front, it belongs to the first item). For an original item whose interval block at write time has been cleared by a deletion executed when due, its original interval is used here. It is used only for numbering and for part 2 of the premise declaration (`premise_covers`, see [`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md), "The premises of a write"), and does not affect the coverage of a revert.
- **Deviation 2 is judged by the state of the items of each (event, target) at write time, not by interval and not by surviving index**: when all the items of an ordinary write or a revoke on a target were `applied` or `corroborated` at write time, all the items on this target in the replay are protected; if any one is not, all the items are judged by the replay ([`03-data-model/03-deletion.md`](03-data-model/03-deletion.md), "Definition of the result of a deletion", deviation 2). What is read is the `status` of `fields/<field ID>/<k>` and `existence/<k>` of this event, not `span`: `span` carries `deps` and will be cleared by other deletions, while the status block is cleared only together with the source of this item of contribution. A base write that carries `revert` or `take`, and a base write whose `cause` is `resolve`, do not go through this criterion; whether a revert was awaiting confirmation or in effect when written is seen from whether the same operation has an `awaiting_confirmation` item whose `origin_event` points to it, and the status blocks of the write-back items are not read.
- Indexes remain addressing: restatements, `carried`, `deps`, `candidates/<k>.items`, `kept_effective/<k>.items`, and the `premise_covers` of part 2 of the premise declaration all refer by index.

**The order in which the state of reverts is judged**: of the reverts in the result of one replay, which take effect (take effect at write time, take effect through confirmation, or take effect because of a deletion, in which case its record is the one listed at proposal time) is judged one by one in operation number order: when judging a revert, the reverts earlier than it count by their already judged state, and it counts itself as in effect; a judgement is final once made and is not rejudged because of a later revert or the result of a judgement; the registration in the result counts all the reverts that were judged in effect. It counts itself as in effect, so high-impact ④ is judged in the state when it takes effect (see [`03-data-model/05-time.md`](03-data-model/05-time.md), "High-impact writes").

Example (reverting a "restored existence"): operation 20 (#22) revokes `[11-05, 11-15)`; operation 30 (#32) `undo: 20` writes back `existence/0 {applied, interval, restored}`; operation 40 `undo: 30`, base write #42. The value position is before operation 30, when this stretch did not exist, so one revoke item is written back:

```
existence/0        {"status":"applied","scope":"interval"}
span/existence/0   {"valid":{"from":"2026-11-05","to":"2026-11-15"},"deps":[{"event":32,"existence":0},{"event":22,"existence":0}]}
revert             {"before_op":30,"items":[{"event":32,"existence":true}]}
```

Example (the range of restored existence is two stretches): the entity has a value throughout; operation 20 (#22) revokes `[11-05, 11-15)`; operation 25 fills `[11-08, 11-10)` in the hole (with all the required fields); operation 40 `undo: 20`, base write #42:

```
existence/0        {"status":"applied","scope":"interval","restored":true}
span/existence/0   {"valid":{"from":"2026-11-05","to":"2026-11-08"},"deps":[{"event":22,"existence":0},{"event":27,"field":"f2","k":0}]}
existence/1        {"status":"applied","scope":"interval","restored":true}
span/existence/1   {"valid":{"from":"2026-11-10","to":"2026-11-15"},"deps":[{"event":22,"existence":0},{"event":27,"field":"f2","k":0}]}
revert             {"before_op":20,"items":[{"event":22,"existence":true}]}
```

Example (undoing a write that filled a value in a hole): the entity is 5000 throughout (#12); operation 20 (#22) revokes `[11-05, 11-15)`; operation 25 (#27) fills `[11-08, 11-10) 3000` in the hole; operation 40 `undo: 25`, base write #42. At the value position (before operation 25) this stretch is inside the revoke, so an item without content is written back:

```
fields/f2/0   {"status":"applied","uncovered":true}
span/f2/0     {"valid":{"from":"2026-11-08","to":"2026-11-10"},"deps":[{"event":27,"field":"f2","k":0},{"event":22,"existence":0}]}
revert        {"before_op":25,"items":[{"event":27,"field":"f2"}]}
```

According to `span/f2/0`, `apply` registers the item of #27 as "has been reverted by operation 40"; it no longer counts as a filling, and `[11-08, 11-10)` returns to the hole of #22; the `ver` of the entity becomes `v40.0`. Then operation 50 `undo: 20`: the revoke is reverted and "restored existence" `[11-05, 11-15)` is written back; on `[11-08, 11-10)` both #27 and #22 have been reverted, so the 5000 of #12 shows through, and the whole span is 5000.

Example (no value): the entity already has #12 `[10-01, 11-01) 5000` and has no value after 11-01; #22 (operation 20) filled `[11-02, 11-20) 3000` in the empty time; operation 40 `undo: 20`, base write #42:

```
fields/f2/0   {"status":"applied","no_value":true}
span/f2/0     {"valid":{"from":"2026-11-02","to":"2026-11-20"},"deps":[{"event":22,"field":"f2","k":0}]}
revert        {"before_op":20,"items":[{"event":22,"field":"f2"}]}
```

`apply` sets this field to no value over `[11-02, 11-20)`; a valid instant at which a required field has no value becomes an interval without a value. In the provenance table, item 0 of #22 is registered as "has been reverted by operation 40". An example on an event table: undoing the write that "filled in the note for the first time" writes back `fields/f4/0 {"status":"applied","no_value":true}`, and the note returns to the state of no contribution at all.

Example (`take_previous`, the interval of the side in effect is larger than the interval of the item): #12 `[10-01, ∞) 5000`; L (operation 20, base #22) explicit `[11-02, 12-01) 3000`, already in effect; A (base #27) writes explicit `[11-10, 11-15) 4000` with an old `ver` and becomes a candidate, the interval of the item is `[11-10, 11-15)`, and the merge base is operation 10. Operation 40 resolves with `take_previous`, base write #41:

```
fields/f2/0   {"status":"applied","value":{"value":"5000","unit":"CNY"}}
sources/f2/0  [{"kind":"value","carried":{"event":12,"field":"f2","k":0}}]
span/f2/0     {"valid":{"from":"2026-11-10","to":"2026-11-15"},"deps":[{"event":12,"field":"f2","k":0},{"event":22,"field":"f2","k":0},{"event":27,"field":"f2","k":0}]}
revert        {"as_of_op":10,"item":"pi_…","items":[{"event":22,"field":"f2"}]}
```

L is reverted only over `[11-10, 11-15)`, and the 3000 on both sides stays as before.

`apply`:

| What it looks at | What it changes |
|---|---|
| `status: applied` in `fields/*/*` | The corresponding field of the current version of the business table (state tables: assign item by item by the interval of `span/*/*`, then normalize the segmentation). When the target row or entity does not exist when the replay reaches here (all the blocks of the write that created it have been removed), create a row containing only the fields given by this write; it need not be the same as the intermediate state online, and the end state is given by the whole row of the deletion result (§5.9); the version table adds one version on each affected cell, with the recorded-time interval starting from this operation number (the version table is placed in cells by the state at the end of an operation: when several `write.base` in the same operation change the same cell, the later op overwrites the value of the earlier op, and the cell records the item of contribution that gave the value last, see [`02-architecture.md`](02-architecture.md) §8); `counts` |
| `applied`, `corroborated` in `fields/*/*`; `applied` in `existence/*` | `base_sources` (field × item × source; state tables carry the interval). For "existence" items the field ID column uses the fixed value `existence` (field IDs are all `f<n>`, so they cannot collide) |
| The `deps` and `carried` of each block | `block_deps` (block → the contributions it depends on), for deletion to find the blocks to cascade to |
| `applied` in `existence/*`, without `restored` | The revoked mark or interval without a value of the business table (the interval is taken from `span/existence/<k>`); the version table |
| `no_value` in `fields/*/*` | Set this field to no value over the interval of this item; the version table |
| `uncovered` in `fields/*/*` | No assignment. Over the interval of this item the field takes the item that shows through after registration (the last item in effect that is not registered as reverted, a field item or a revoke); the version table |
| `revert` | **Registered only when this base write takes effect**: in `base_sources`, the current item of each (event, target) listed in `items` is registered as "has been reverted by this operation" (the range of registration is read only from the blocks: an item under an entry not marked `later` (in `undo` it is the item of the undone operation itself; no entry of `take_previous` is marked) is registered over "its interval ∩ the sum of the intervals of the items this event writes back on the same field or 'existence'"; an item x under an entry marked `later` is further intersected with D(x), which `apply` computes itself: among the items of the undone operation, the union of the intervals of those whose state is `applied` or `corroborated` (the current interval in the provenance table, the restated one if restated by a deletion) and that x can supersede according to step 3 of the revert, the supersession relation looking only at the kind of the content, all in the blocks; if restated by a deletion event later, by the restated interval). When this write enters awaiting confirmation it is not registered, and it is registered when it takes effect through confirmation (applied by the write triggered by that resolution); an awaiting-confirmation revert that is no longer high-impact because of a deletion and takes effect at its own write number is registered by the application of that deletion event (using the revert record listed at proposal time); one that is rejected or superseded is not registered. An `undo` in which everything is skipped counts as in effect and has no write-back item, and the range it registers is empty. This is the only path by which "has been reverted" is registered |
| `take` | None. `take` registers no revert: the writes in the coverage set are overridden by the items that the adoption wrote, by the ordinary supersession relation |
| `applied` in `existence/*`, with `restored` | In the business table, remove the revoked mark or interval without a value within that range; the version table |
| `candidate`, `awaiting` | No change to the business table or the version table |
| `duplicate` | None (the flag is derived from `item.created`) |
| `fields/<key field ID>/0` of a key field (`applied`) | The key index `external_keys`: register the entry of this row by the new value. A revoke does not touch the entry |
| The premise declarations of this op found through `target.op_index` | `premise_edges`: all the items of this event (whether in effect, candidate or awaiting confirmation) are registered as covered by these declarations. This part covers by (event, target): indexes newly assigned on this event by a later deletion restatement are covered as well |

The `ver` of this row or entity becomes this operation number when this operation changes its version table (opens or closes a cell, with intent other than `schema_switch`), consistent with the definition of `ver` in the contract (the operation number of the most recent operation that changed its current state). When a write-back item takes effect but what shows through is still the item that was in effect before, the version table does not change and neither does `ver`: for example, operation 30 writes `[11-05, 11-07)`, operation 43 reverts it (writing back `uncovered`, which shows an earlier revoke through), and operation 80 reverts operation 30 again: its write-back item takes effect as usual and is registered as usual, and what shows through is still that revoke; a write-back item masked by a later item that is not reverted is the same.

Example (a state table, an `undo` that covers a write over two stretches): base #12 `[10-01, ∞) 5000`; #15 `[11-10, ∞) 4000`; #22 `[11-02, 11-20) 3000`; operation 30 `undo: 20`, base write #32:

```
fields/f2/0   {"status":"applied","value":{"value":"5000","unit":"CNY"}}
sources/f2/0  [{"kind":"value","carried":{"event":12,"field":"f2","k":0}}]
span/f2/0     {"valid":{"from":"2026-11-02","to":"2026-11-10"},"deps":[{"event":12,"field":"f2","k":0},{"event":15,"field":"f2","k":0},{"event":22,"field":"f2","k":0}]}
fields/f2/1   {"status":"applied","value":{"value":"4000","unit":"CNY"}}
sources/f2/1  [{"kind":"value","carried":{"event":15,"field":"f2","k":0}}]
span/f2/1     {"valid":{"from":"2026-11-10","to":"2026-11-20"},"deps":[{"event":12,"field":"f2","k":0},{"event":15,"field":"f2","k":0},{"event":22,"field":"f2","k":0}]}
revert        {"before_op":20,"items":[{"event":22,"field":"f2"}]}
```

#### `write.derived` (the derived write)

The rule engine refreshes one derived row.

| path | Kind | Content | Provenance |
|---|---|---|---|
| `target` | metadata | `{"table": "t2", "rule": "r1", "rule_version": 1, "partition": "p_8WM…", "read_pos": <seq>, "reads": [{"table": "t1"}], "emptied": <boolean>}` | — |
| `key` | data | The group key value: `{"values": ["2026-11-01"]}`, in the order of the field IDs of the group key fields in the derived table, regardless of the order written in `GROUP BY`; for a whole aggregation without grouping: `{"values": []}` | The contributions, on the fields that the group key depends on, of the base rows that fall into this group |
| `checksum` | data | `{"checksum": <hash>}`: the checksum of the result of this refresh (§5.13) | The base contributions in the read set |

- `read_pos`: the log position read at refresh time: the `seq` of the last event in this operation before the derived refresh began. All the `write.derived` events of the same operation are the same (the whole batch is refreshed and computed at the same position).
- `reads`: which base tables were read, without repetition, in the string order of the table IDs (`t10` comes before `t2`). The first version records only down to the table level; a finer read set will later be added as a new optional key and will not change existing events.
- `emptied`: `true` means this group has no rows after the refresh and the derived row is deleted. There is then no result, so there is no `checksum` and no `key` either; when `emptied` is `false` there is always a `checksum` (it still counts as present when listed in the position list, per §1.1).
- `key` is present in only two cases: this `partition_id` appears for the first time (registering the mapping "group key value → `partition_id`"); the `key` block that registered the mapping last time has been listed in the position list of some deletion, and this group has rows again (registering again).
- When a group becomes empty because of a deletion, the `key` block that registered the mapping is listed in the position list.
- After a group becomes empty (`emptied`), if the same group key has rows again, it reuses the original `partition_id`, whether it became empty because of a revoke or a deletion; while the `key` block of the mapping is still there, this derived write no longer carries `key`.
- `checksum` is used for checking, not for generating; when a contribution in the read set is deleted it is listed in the position list, and afterwards the check is skipped when that derived value is restored as of a given time.
- A deletion confirmation and a cancelled deletion each have one for every partition that the affected rows fall into, even if the result did not change (§4.4).
- `apply`: recompute this partition on the current base data by the rule of `rule_version` and write it into the derived table; check `checksum` if there is one; maintain `partitions` and `derived_reads`. The version of the derived row is this operation number.

### 5.8 Pending items

The current state of an item is computed entirely from these five event types (and the deletion lifecycle events). The item version is encoded externally as (item ID, the operation number of the item's most recent content change, restore count).

The content of an item is cut into blocks by entry. The values and intervals in an entry block come from other writes, so every entry block carries `deps` (§3.5):

```json
"deps": [{"event": 39, "field": "f3", "k": 0}]
```

`deps` lists all the contributions that the **values and interval endpoints** of the entry come from: the one that wrote the value, and the contributions that cut this segment to its present shape. When a contribution listed in `deps` is deleted by a privacy deletion or restated, the entry block is put on the position list; if the item is still open, a following `item.refreshed` (`entries_deleted`) gives the entries again, including candidates and `matched` entries.

**Naming of references** (the same throughout the document):

| What the value is | Key name |
|---|---|
| An operation number | `op`, or ending in `_op` |
| An event `seq` (`write.base`, a head event, etc.) | `event`, or ending in `_event`; when it points to a content block, it also carries `field` and `k` (or `"existence": <k>`), or carries `path` |
| Source data (the `seq` of a `source.recorded` event) | `source`, or `sources`, or ending in `_sources` (`valid_sources`, `op_sources`) |
| A log position | `read_pos` (`write.derived`): the `seq` of the last event read |

The `seq` in the block address in a position list is part of the address.

#### `item.created`

| path | Kind | Content | Provenance |
|---|---|---|---|
| `target` | meta | see below | — |
| `scope_valid` | data | State table: the valid-time interval the item covers, given segment by segment as `{"spans": [{"from": …, "to": …}, …], "deps": […]}`. There is only this one shape; a single segment is also a `spans` of length 1. The segments are in ascending order of start, do not overlap or touch (touching ones are combined into one), and have the same granularity (all by day or all by instant). Only the first segment may lack `from` (open start, for example the segment covered by an item that undoes a write-back over the whole time span after that write-back was cut apart by other writes), and only the last segment may lack `to` (open end). When both are given, `from` is earlier than `to`. The whole time span is written as `[{}]` (for example when revoking a whole entity becomes a candidate); it is both the first and the last segment and is not listed alongside other segments. In judging merging and intersection, an open start is treated as negative infinity and an open end as positive infinity. The whole time span is also written out explicitly, and "no `scope_valid` given" is not used to express it: in `item.merged` and `item.refreshed`, not giving it has another reading (zero blocks mean an empty group). When it is applied into a flag, the whole time span stores no interval. The bounding span of the segments is not taken: the flags, the "changed to" judgement and the execution all go segment by segment along `spans`. **Pending items awaiting confirmation that revert (the proposal is an `undo`)**: `spans` is the union of the intervals of the items that this confirmation would write back, judged against the current state, that is, the intervals actually written at confirmation time; it is recomputed on refresh | `deps`: the contributions of the candidates or of the proposal; a pending item awaiting confirmation that reverts adds the contributions that correspond to the revert entries listed by this judgement (the range depends on how they look now) |
| `current/<k>` | data | One segment of the value currently in effect: `{"field": "f3", "value": …, "valid": {…}, "op": <the operation number that wrote it>, "deps": […]}`. `valid` exists only on state tables, and likewise for `proposed`, `previous` and the `overwritten_segment` of `impact` in this table; an entry for "existence" writes `{}` for the whole time span and `{"to": …}` for an open start (§1.2, for example the segment left by revoking a whole entity in an "existence" item); an entry for a field always has `from` | `deps` |
| `candidates/<k>` | data | One candidate (all candidate items of one write on this conflict unit), see below | `deps` |
| `proposed/<k>` | data | The value of a proposal awaiting confirmation on one field: `{"field": …, "value": …, "valid": {…}, "deps": […]}` | `deps` |
| `previous/<k>` | data | One segment of the value on the merge base: `{"field": …, "value": …, "valid": {…}, "deps": […]}`. `take_previous` returns to it | `deps` |
| `impact/<k>` | data | One entry for what will be changed after execution, see below | `deps` |
| `matched/<k>` | data | `flagged`: another row suspected to be a duplicate, `{"row": …, "deps": […]}`. A `flagged` item must have it, numbered from 0 without gaps, at most 10 entries, each row once, not including the flagged row, in the same order as `duplicate.matched` in `write.base`; a `flagged` item has only `target` and this group, and other kinds do not have this group | `deps` |

`target`:

```json
{
  "item": "pi_3KD…",
  "type": "conflict",
  "reason": "stale_write",
  "table": "t1",
  "row": "r_01JC9A…",
  "unit": ["f3"],
  "merge_base_op": 29,
  "origin_event": 39,
  "ruleset_version": 1,
  "policy_version": 1
}
```

| Key | Meaning |
|---|---|
| `item` | Item ID |
| `type` | Item kind (§6.4) |
| `reason` | Cause code (§6.6) |
| `table`, `row` / `entity` | Where the target is. A `schema_change` item does not have them and has `draft` instead |
| `unit` | The conflict unit, always an array: one field (`["f3"]`), or all the fields (the field IDs) in a field group declared by the schema. When the target is "existence" (a conflict in which a revoke takes part), write `["existence"]`. For an `awaiting_confirmation` item: when the proposal involves "existence", write `["existence"]` (the whole row or the whole segment, with fields not listed separately); otherwise it is all the fields the proposal involves, sorted by field ID. A `flagged` item may lack it (what is flagged is the whole row); `schema_change` does not have it |
| `merge_base_op` | A `conflict` must have it and the other kinds do not: the operation number of the merge base (the earliest of the versions in the `ver` that the candidates carry) |
| `origin_event` | An item caused by a write (`conflict`, `awaiting_confirmation`, `flagged`) must have it: the `seq` of the `write.base` event that gave rise to this item. `schema_change` does not have it |
| `draft` | A `schema_change` must have it and the other kinds do not: the draft ID |
| `related_item` | If and only if the cause is `restored_candidate`: the item the candidate was originally in (does not appear in the first version) |
| `ruleset_version`, `policy_version` | The two versions used when this item was judged |

For an item whose conflict unit is "existence" (a stale write ran into a revoke, or a revoke became a candidate), `current/<k>` and `previous/<k>` record only what is on this unit, and both kinds of entry are listed:
- A revoked segment: `{"field": "existence", "revoked": true, "valid": {…}, "op": <the operation number of that revoke>, "deps": […]}`;
- A segment with a value: `{"field": "existence", "valid": {…}, "deps": […]}`, without `revoked`, `op` or `value`; `deps` are the contributions that give this segment a value.

`valid` exists only on state tables (on event tables and timeless tables it is one entry for the whole row), and likewise in `previous`. A segment of the item's interval that neither kind of entry covers has no value and was not caused by a revoke (for example the segment after a value filled in a segment that was never written, where this fill was then undone). After a fill in a gap is undone, that segment goes back to the gap that the revoke left, and the entry is a revoke entry. Entries do not list the values of fields. In the contract, the `effective` and `previous` of a conflict item (`{seq, exists, values?, spans?}`) and the `current` of an item awaiting confirmation are assembled at read time: the state of this row at that time is read at the operation number of the item version (`previous` at the operation number of the merge base), restricted to the segments of the item and the fields of the conflict unit (when the unit is "existence", the values of the whole row are given); they are not inferred from these entries and do not enter the item content either ([`04-contract-types.md`](04-contract-types.md) 4.8).

**Item content within one request**: the operation number of the item version is that of the request, and which op in the request cannot be told apart; a receipt that gives the whole content of an item counts as having been read. So the content of an item is computed from the state at the end of the whole request:
- Within one request, each item produces at most one group of content. For an item newly opened by this request, the entries of `item.created` (and of the `item.merged` by which later ops in the request merge into it) are taken from the state at the end of the request; for an existing item that any op in this request changes, a refresh or a supersession is computed once, after the events of all the ops, with the entries likewise taken from the state at the end of the request, and `by_event` is the last `write.base` that changed it.
- Whether it was "read" is judged by the item version at the start of the request. An item that this request merged into is always treated as not read, regardless of the order of merging and changing: it is not superseded (superseding would discard the candidates this request has just merged into it), and when it is changed it is refreshed, and the event records `writer_had_read: false`.
- For an item that is changed, `by_event` is judged op by op: compare the value in effect on the item's unit before and after each op, and take the `write.base` of the last op that really changed it; if it was changed and changed back, the last time counts.
- A `flagged` item newly opened by this request that, at the end of the request, no longer has any listed row matching (or the flagged row has been revoked) is not opened: `matched` has at least one row, and by the state at the end it has no entries. The `duplicate` block in the write is still written; it is the judgement at the time of the write.
- An item that this request merged into and that no op changed has its content change from the merge given by the `item.merged` itself (it carries `current`); no separate `item.refreshed` is issued, and the receipt marks only `merged`.
- Content must not go stale silently: at the end of a request, the content of every open item on a row that it wrote and that was not changed is recomputed (the entries together with `op` and `deps`, and the impact), and if it differs from the existing content it is refreshed (`cause` is `entries_changed`), only refreshed and not superseded, whether read or not. For example, when the same segment is revoked a second time, the entries of an "existence" item are redirected to the later revoke; for corroboration with the same value on a field unit, the value has not changed and it does not count as changed, but the impact gains one more write.
- In the `pending[]` of the receipt, each item appears only once, with the applicable marks (`merged`, `refreshed`; for an item newly opened by this request, give `item_ver` and do not mark `merged`); a superseded one appears only in `superseded[]`.

"Changed" also goes by conflict unit: when the conflict unit of the item is fields, look at whether the state of these fields within the item's interval has changed; when it is "existence", look only at the change between having a value and having none (on a state table, segment by segment whether the segment has a value; on an event table and a timeless table, whether the whole row has been revoked), and a change to a field value does not count as changing it: the item content has no field values, so when a field value changes the item content does not, and there should be no refresh.

`candidates/<k>`:

```json
{"event": 39, "intent": "correct",
 "seen": {"op": 29, "restore_count": 0},
 "cause": "stale_write",
 "items": [{"field": "f3", "k": 0, "value": {"value": "32", "unit": "CNY"}}],
 "deps": [{"event": 39, "field": "f3", "k": 0}]}
```

**One candidate = all the items of one write that became candidates on this conflict unit**, one entry per candidate. When the conflict unit is a field group, if the same write changes two fields in the group, that is one candidate with two entries in `items`; on a state table, when one write is cut into several segments on this unit and some of the segments become candidates, that is also one candidate with several entries in `items`. One `write.base` is at most one candidate in the same item.

- `event` is the `seq` of the `write.base` event the candidate is in (the writer is the `actor` of that event); `seen` is the `ver` the candidate carries (for a write by external key, it is the earliest of the synchronization baseline positions of the fields of this conflict unit, taken from `ops/<i>/baseline`); for `cause` see §6.7.
- `items` lists the items one by one: `field` and `k` indicate which item of that event it is, and `value` is its value; on a state table each item also has `valid` (the interval seen by this item). When the candidate is a revoke, `intent` is `revoke` and `items` holds `{"existence": <k>}` (a revoke with an interval also has `valid`), without `field` and `value`.
- `deps` includes every item in `items`, and the contributions that cut out these intervals.
- The candidate items of an item (the K that adopting and returning to the merge base refer to) are identified by (`event`, the item's `target.unit`), not by the index in `items`: when a deletion merges several items of the same candidate write and keeps the smallest index, identifying by index would lose them.
- **The index `k` is the candidate number**, the only such scheme in the whole document: the `Candidate.index` of the contract, the `candidate` of `resolve`, the `candidate` of `item.resolved`, the `dropped_candidates` / `restored_candidates` of `item.refreshed` and the `candidates/<k>` it gives again all refer to it. `take_candidate` adopts **all the items** of that candidate.
- When some items of a candidate are no longer contributions because of a privacy deletion and the rest are still there, the candidate is still the same candidate (the index does not change): the original entry block is cleared according to `deps`, and the following `item.refreshed` gives again, with the same index, an entry that contains only the remaining items. Only a candidate that is no longer a candidate in this item because of this deletion is listed in `dropped_candidates`: its cause was deleted and it takes effect, it turns into awaiting confirmation (taken over by the succeeding item), it is covered by a revert record, or all its items are deleted; when other candidates in the same item are still open, the item is refreshed and not superseded.

The shape of `impact/<k>` depends on the cause:

| Cause | Shape |
|---|---|
| Erasing a change point (high-impact ①), filling across a gap | `{"kind": "overwritten_segment", "field": …, "valid": {…}, "value": …, "op": <the operation number that wrote this segment>, "deps": […]}` |
| Revoking a row that is still referenced (high-impact ②) | `{"kind": "referencing_row", "table": …, "row": …, "field": …}`; when the referencing side is on a state table, write `entity` instead of `row` |
| `undo` with `include_later` (high-impact ④) | `{"kind": "reverted_write", "op": <operation number>, "deps": […]}` |
| `conflict`: a write that `take_previous` would revert | `{"kind": "reverted_write", "op": <operation number>, "deps": […]}` |
| `conflict`: when the candidate, if it took effect, would be high-impact, the segment it would overwrite | `{"kind": "overwritten_segment", …}`. Listed only when putting the items of this candidate into effect on top of the current state would erase a current change point (the same way of judging as high-impact ① for a write, judged candidate by candidate; only state tables have change points); `deps` also contains the items of that candidate, from which the reading side tells which candidate it belongs to |

When an `overwritten_segment` covers a segment without a value (an interval without a value that would be filled), it carries `"gap": true`, `value` is `null`, and `op` is the revoke that left it; when no revoke left it, `op` is not given; in the contract it goes into `filled_gaps`. A field value explicitly cleared to `null` is a value, not a segment without a value: it does not carry `gap`, `op` is the write that cleared it, and in the contract it goes into `overwritten`. A block without `gap` must have `op`.

`apply`: add a row to `pending_items` (status open, item version = this operation number); `pending_entries` registers the positions of the entry blocks; set flags by item kind: `conflict` → `disputed` (with the item, the fields in `unit`, the interval), `awaiting_confirmation` → `awaiting` (same as above), `flagged` → `flagged`.

#### `item.merged`

A new candidate merges into an existing conflict item.

| path | Kind | Content |
|---|---|---|
| `target` | meta | `{"item": "pi_…", "merge_base_op": <operation number>, "origin_event": <seq>, "ruleset_version": …, "policy_version": …}` |
| `candidates/<k>` | data | The newly merged candidate. `k` continues from the indexes of the candidates the item already has and is not reused within the whole lifecycle of the item |
| `scope_valid`, `previous/<k>`, `impact/<k>` | data | The results recomputed after the merge, which **replace the whole group** of the same name that the item had before. These groups are given as a whole group every time, and zero blocks mean an empty group |
| `current/<k>` | data | The current value in effect after the merge (by the state at the end of the whole request), which replaces the whole group of the previous `current`; an `item.merged` that does not give `current` keeps the previous one |

`apply`: the item version is replaced with this operation number; the earlier `previous/*`, `impact/*` and `scope_valid` entries become void (the blocks themselves remain in their own events).

#### `item.refreshed`

The target of the item was changed by a write that had not read it, or the referencing side of a high-impact ② changed, or the content recomputed at the end of a request changed: the item stays open and its content is updated.

| path | Kind | Content |
|---|---|---|
| `target` | meta | `{"item": "pi_…", "by_event": <seq>, "writer_had_read": <boolean>, "cause": "target_overwritten" \| "references_changed" \| "entries_deleted" \| "entries_restored" \| "matched_changed" \| "entries_changed", "dropped_candidates": [<index>], "restored_candidates": [<index>], "merge_base_op": <operation number>}` |
| `current/<k>`, `previous/<k>`, `impact/<k>`, `proposed/<k>`, `scope_valid` | data | The results after the refresh, which replace the whole group of the same name. **These groups are given as a whole group every time, and zero blocks mean an empty group**; there is no reading in which "not given means unchanged" |
| `matched/<k>` | data | The rows that a `flagged` item still matches, with the same shape as in `item.created` (with `deps`). **When given, it replaces the whole previous `matched` group** and is renumbered from 0; when not given, it is unchanged. It appears only with four causes: `matched_changed` (always present, and this is the only group: when some rows no longer match, the others are given, keeping their original order; when none match any more, the item is superseded, not refreshed), `entries_changed` (the rows all still match, but for some rows the matching value is now given by other contributions: the whole group is given again, `deps` point to the contributions that now give it, and the order is unchanged), `entries_deleted` (when the entry block was cleared by a deletion while the rows still match, the whole group is given again), `entries_restored` |
| `candidates/<k>` | data | The candidate entries given again, with the same shape as in `item.created` (with `deps`). **They keep the original index `k` and replace only the entry of the same index**; those not given stay unchanged. Used in two places: the entry block was cleared by a deletion while the entry is still there (for example the interval seen by the candidate is resolved again, or the candidate lost one item while the rest are still there and the candidate is still a candidate); putting back the candidate that was removed when a deletion is cancelled |

- `cause` is `entries_changed`: at the end of a request, the item was not changed, but the recomputed content differs from the existing one ("Item content within one request"); `by_event` is the last `write.base` of this request on this row; there is no `writer_had_read`.
- `writer_had_read`: whether the writer had read the current version of this item at the time. The read audit is consulted once at the time of the write and the result is recorded here, and replay does not recompute it. When `cause` is `target_overwritten` it is always `false` (if it had been read, it would be a supersession, not a refresh).
- `cause` is `entries_deleted`: a privacy deletion cleared some of the entries of the item while the item is still open (for example one candidate was removed), and `dropped_candidates` lists the indexes of the candidates removed; when, in the same deletion, other candidates return to this item, `restored_candidates` is listed in this same event (each item has at most one `item.refreshed` in one operation, §4.2); in this case there is no `by_event`. `by_event` is the `write.base` event that changed the target of the item (when `references_changed`, it is the one of the referencing side).
- `cause` is `matched_changed`: either of the two rows that a `flagged` item matched (the flagged row, or the other row that was matched) was revoked or changed, some rows no longer match, and the item is still open; for `by_event` see the same reason in `item.superseded`. When `cause` is `entries_changed` and the item is `flagged`: the listed rows all still match, only the contributions that give the matching value changed (for example the two rows were both changed to the same new value in the same request); if it is not given again, the entry block would not be in the position list when the source of the new contribution is later deleted (§3.5). A `flagged` item does not look at whether it was read, and has no `writer_had_read`.
- A `flagged` item "matches" under the same definition as at write time: matching on any one of the several groups of `duplicate_keys` is a match. The flagged row and a listed row count as no longer matching only when they no longer match on **any group**; the `deps` of `matched/<k>` take the first group that it matches now (the group matched at flagging time comes first). The `duplicate.keys` of the write is still the group matched at flagging time and does not change with later writes.
- `cause` is `entries_restored`: after a deletion is cancelled, or when a later deletion makes a candidate that had been removed go back to the original item that is still open (it took effect only because of the earlier deletion, and this time it returns to its original kind), the candidates the item had lost are put back. `restored_candidates` lists only the indexes of the candidates that were **removed as a whole** (symmetric with `dropped_candidates`); when a candidate had lost only some of its items and those items come back after the cancel, its index does not enter `restored_candidates`, and this event gives again, with the same index, the `candidates/<k>` that contains all items. The `candidates/<k>` of this event give them again according to the state after the cancel or deletion (this event prevails, and the original blocks are not read back); in this case there is no `by_event`.
- **This kind does not appear in the first version**: in the grace period, an item cannot be resolved on the rows affected by this deletion (data model, "Deletion · Cancelling a deletion and the grace period"), so when a deletion is cancelled, an item that lost candidates is either still open (follow the previous point) or has already been superseded within the grace period (the candidates are not put back). The format is kept for when that restriction is lifted: when a deletion is cancelled and the item was **already resolved**, no `item.refreshed` is produced, and the resolution of the original item is untouched. The candidates put back are judged again by the current state at the time of the cancel, restated item by item by the cancel event: an item with the same value as the value in effect becomes `dropped` by the ordinary rules (no evidence referred to) or `corroborated` (evidence referred to); otherwise it is still a `candidate`. As long as one item is still a `candidate`, a following `item.created` (cause `restored_candidate`) opens another item for this candidate, and in the new item its `items` contain only the items that are still candidates. The `rejudged` of the receipt gives one entry per candidate: if some item is still a candidate, record `reopened`; otherwise if some item became corroboration, record `corroborated`; if all became `dropped`, record `dropped`.
- When the keys of `target` appear: `dropped_candidates` comes only with `entries_deleted`; `restored_candidates` comes with `entries_restored`, or with `entries_deleted` (when in the same deletion some candidates leave and others come back: if any candidate leaves, take `entries_deleted`; only when candidates come back and none leave, take `entries_restored`), and is non-empty when it appears; `by_event` is absent for `entries_deleted` and `entries_restored` and is required for the other causes; `writer_had_read` is required for `target_overwritten` (always `false`) and `references_changed` and absent for the other causes; `merge_base_op` may be absent for every cause, and when given it is the merge base after the refresh.
- **A pending item awaiting confirmation that reverts** (the proposal is an `undo`): on refresh it is judged again against the current state; `scope_valid` takes the interval this confirmation would write back (the same as the judgement at confirmation time), and `impact/*` takes the result of judging the same `undo` again against the current state (the judgement at confirmation does not count as high-impact ①, and cannot list a segment that would be overwritten); the two judgements list the same revert entries. The two groups of blocks each list their own `deps`: those of `scope_valid` come from the judgement at confirmation, and those of `impact/*` from the re-judgement of the `undo`. If only `deps` changed, the content counts as changed too: the item is refreshed and its version is replaced (consistent with the confirmation hash counting `deps` in). After the re-judgement, when there is neither an item to write back nor a write to cover or revert, no refresh is made and an `item.superseded` (`nothing_to_revert`) is issued instead. When the writer had read the item it is `overwritten` as before: that case is not a refresh anyway, so there is no refresh to replace.
- `apply`: the item version is replaced with this operation number.

#### `item.superseded`

The item no longer needs handling.

| path | Kind | Content |
|---|---|---|
| `target` | meta | `{"item": "pi_…", "reason": <supersession reason, §6.6>, "by_event": <seq>, "writer_had_read": <boolean>}` |

`by_event` is the `seq` of the event that superseded it: for `overwritten` it is that `write.base`, for `schema_switched` it is `schema.switched`, for `deleted` / `deletion_cancelled` it is the head event of the deletion confirmation or cancel, and for `draft_replaced` it is `schema.superseded`. For `matched_changed` it is the `write.base` that changed one of the two matched rows: judged op by op, take the `write.base` on these rows of the last op in this operation that really changed what the item has to say (which rows still match, which contributions give each of them, whether the flagged row is still there); an op that changed only other fields does not count. The `matched_changed` and `entries_changed` (of a `flagged` item) of `item.refreshed` are taken the same way. For `nothing_to_revert` it is the `write.base` that left it with nothing to do (the one that changed it, or the last one of this request on this row). `writer_had_read` exists only when `reason` is `overwritten`; a `flagged` item does not carry it.

`apply`: set the item state to superseded; remove the corresponding flag; replace the item version with this operation number.

#### `item.resolved`

A head event. A person or an agent handled an item. It carries the blocks of §5.1.

| path | Kind | Content | Provenance |
|---|---|---|---|
| `target` | meta | see below | — |
| `op_sources` | meta | The operation sources of this resolution: `[<seq of a source data event>]` (the evidence that the resolve request carried, and the `api_call` of this resolution: present when a `note` was carried, or when a write-triggering action was handled without evidence, §4.3). It does not appear when there is none | — |
| `confirmation` | data | `{"hash": <hash>}`: the hash of the content confirmed | The entry blocks that were confirmed; if any one of those blocks is deleted, this block is deleted with it |

```json
{"item": "pi_3KD…", "decision": "take_candidate", "candidate": 0,
 "item_op": 37, "restore_count": 0, "via": "call"}
```

| Key | Meaning |
|---|---|
| `decision` | The decision (§6.5) |
| `candidate` | `take_candidate`: the index of the candidate adopted (the `k` of `candidates/<k>`). All the items of that candidate are adopted |
| `item_op`, `restore_count` | The item version confirmed |
| `via` | `call`. Reserved value: `elicitation` |

- Who resolved it is the `actor` of the event header; through which credential follows from `actor`.
- The hash of `confirmation` is **computed at append time and checked at apply time**: before the kernel appends this event, it computes the hash from the entry blocks currently in effect for the item and writes it into this block; at apply time it computes it again from the state as applied up to here, and a mismatch with this block means the log and the state disagree (`inconsistent`) and apply stops. Both places use the same algorithm: SHA-256 (over the checksums of the confirmed entry blocks, sorted by `(seq, path)` and joined with newlines).
  - The confirmed entry blocks = all the entry blocks currently in effect for the item, that is, the "item content": the `current`, `candidates`, `proposed`, `previous`, `impact`, `matched` and `scope_valid` blocks given by the `item.created`, `item.merged` and `item.refreshed` of the item, minus those later replaced as a whole group by events of the same item (the rules are the same as for `item.merged` and `item.refreshed` above). Candidates and proposals enter the hash as their entry blocks, and the contributions referenced in a block (`deps`, the `event` of a candidate) are counted along with the block. A refresh and `confirmation_mismatch` use the same "item content": when the content changes, the item version is replaced with it, and the hash of the old version no longer matches.
  - For a `schema_change` item it is the `compiled` block of the `schema.compiled` of the corresponding draft.
  - An item without any entry block does not produce this block. When one of the confirmed entry blocks is deleted, this block is deleted with it, and apply no longer checks it.
- The `note` is not in this event: it is stored as source data with the resolve request (§4.3) and referenced by `op_sources`; the `note` echoed in the item details is taken from there and is cleared along with the privacy deletion of that source data.
- The base write triggered by **`take_candidate`** carries the adoption record `take`:

  ```json
  {"item": "pi_3KD…", "candidate": 0, "merge_base_op": 29,
   "items": [{"event": 35, "field": "f3"}]}
  ```

  | Key | Meaning |
  |---|---|
  | `item`, `candidate` | The item resolved and the candidate number adopted |
  | `merge_base_op` | The merge base the item recorded at resolution time, not recomputed afterwards |
  | `items` | The coverage set: the (event, target) pairs that took effect after the merge base and before this resolution within the item's conflict unit and interval, listed in the same way as the revert record of `take_previous` (§5.7), with entries shaped like `revert.items` (without `later`) |
  | `filled` | State table: the revokes that the adoption fills in, `[{"event": <seq>, "existence": true}, …]` (entries written like `items`): the revokes in effect at resolution time that intersect the range adopted (data model, "Deletion · Carried values"). It does not appear when there is none |

  This block is meta information, has only sequence numbers and targets, and is not cleared by deletion. The writes in the coverage set are not registered as reverted: the items written by the adoption cover them by the ordinary supersession relation.

  **For the revokes filled in, only which ones they are is recorded, not their intervals at the time**: the interval is copied from the content of that revoke, and its endpoints may come only from content deleted later. Replay judges the relation between a revoke and the adopted items as a whole revoke (data model, "Deletion · Carried values"): a revoke listed in `filled` as a whole does not cover the adopted items, and one not listed covers them over its whole segment.
- The base write triggered by **`take_previous`** carries the revert record `revert` (§5.7): the operation number of the merge base is recorded in its `as_of_op`, and the (event, target) pairs reverted are listed in `items`. It is the same kind of operation as `undo`, and the replay rules are only those of §5.7. The candidates are not in the revert record and are closed by this event.
- **Confirming a revert awaiting confirmation** (`awaiting_confirmation` · `confirm`, the proposal is an `undo`): the base write triggered by the confirmation carries **its own** `revert`, determined by the state at confirmation time (consistent with the impact after the item refresh); both registration and write-back follow it, with the operation number of this resolution as the reference. The `revert` in the base write of the proposal is only the content of the proposal, used for the item and the preview, and not used for registration.
- Handling a `deletion` item (cancel) does not produce this event; see `deletion.cancelled`.
- `apply`: set the item state to resolved and record the decision; remove the corresponding flag; `request_key` enters the request key index. The write triggered by the handling is applied by the `write.base` that follows.

### 5.9 Deletion

#### `deletion.confirmed`

A head event. A privacy deletion is confirmed and enters the grace period. It carries `ctx` (also when produced by `system`); one confirmed by a caller also carries the other blocks of §5.1. **A deletion concerns only one slot**: the `sources` all belong to the slot that the `slot` of the event header names, and a caller splits a deletion across slots into several deletions. When a caller confirmed it, `actor` is the confirmer; when the restore procedure regenerated it from the deletion register, `actor` is `system` and `trigger` is `restore`.

| path | kind | content | source |
|---|---|---|---|
| `target` | metadata | see below | — |
| `positions` | metadata | the content blocks to be emptied at expiry: `[{"seq": 26, "path": "text"}, {"seq": 27, "path": "fields/f3/0"}, {"seq": 42, "path": "summary"}]` (42 is this event itself: `summary` is listed in its own position list) | — |
| `summary` | data | `{"hash": <hash>}`: the hash of the impact summary (the one the confirmation handle is bound to) | the content being deleted; it lists itself in `positions` |
| `results/<k>/target` | metadata | one affected row or entity: `{"table": …, "row": …, "outcome": <enum>}` (a state table writes `entity`) | — |
| `results/<k>/fields/<field ID>/<j>` | data | one segment of that field after the deletion, see below | the contribution that `carried` in the block refers to, plus the `deps` of the block |
| `results/<k>/existence` | data | state table: all intervals without a value after the deletion, `{"gaps": [{"from": …, "to": …}], "deps": […]}`; `gaps` is an empty array when there is no interval without a value. When it must be given, see "Which to list" below | `deps`: the revokes that left these gaps, and the contributions that cut them short |
| `restated/<k>` | data | a contribution that this deletion **restates**: its judgement result after the replay, see below | the contribution it points to, plus the `deps` and `carried` of the block |
| `recreated/<k>` | metadata | a change of the first-creation mark: `{"event": <seq of the write.base>, "created": <boolean>}` | — |
| `superseded_items` | metadata | the list of IDs of the items superseded by the deletion | — |

`target`:

```json
{"deletion": "pi_9QX…", "kind": "privacy", "due_at": "2026-11-11T05:02:11.000Z",
 "sources": [26], "origin": "request"}
```

| key | meaning |
|---|---|
| `deletion` | the deletion ID, which is also the ID of the `deletion` item during the grace period |
| `kind` | `privacy`. For the reserved values see §10 |
| `due_at` | the time at which the grace period expires |
| `sources` | the sources being deleted (the `seq` of `source.recorded`) |
| `origin` | `request` / `restored_unconfirmed` (in the register but not in the restored log: regenerated with a new grace period) / `restored_pending` (the register says pending: keeps the original expiry time) / `restored_executed` (the register says executed: `due_at` is the `at` of this event, and the tombstone follows immediately) |

The `outcome` of `results/<k>/target`: `deleted` (the whole row is deleted) / `kept_fields_cleared` (kept, some fields become empty) / `fields_reverted` (some fields go back to an earlier value) / `resegmented` (a state table is segmented again) / `sources_changed` (the values did not change; the row is listed because its giver, its judgement result, or the block that gives them is given again: for example only the contribution that gives it was replaced; the revoke that gives a gap was resolved again and the gap is still in the same place; or an item was merely restated unchanged).

When a row fits several of these, the first that fits in the order above is taken: `deleted` (it existed before the deletion and does not exist after) → `kept_fields_cleared` (among the fields that had a value before the deletion, one has no value anywhere after) → `fields_reverted` (the value changed on an event table or a timeless table) → `resegmented` (the value or its segmentation changed on a state table; an interval without a value counts too) → `sources_changed`. A row that did not exist before the deletion and exists after it (for example the revoke that made it not exist was deleted) is recorded as `fields_reverted`: the row goes back to its earlier shape.

`results/<k>/fields/<field ID>/<j>`: one segment of this field after the deletion (always `j = 0` on an event table):

```json
{"value": {"value": "45", "unit": "CNY"},
 "sources": [{"kind": "value", "carried": {"event": 23, "field": "f3", "k": 0}}]}
```

A state table also carries `valid` and `deps`:

```json
{"valid": {"from": "2026-11-20"}, "value": {"value": "5000", "unit": "CNY"},
 "sources": [{"kind": "value", "carried": {"event": 12, "field": "f2", "k": 0}}],
 "deps": [{"event": 12, "field": "f2", "k": 0}, {"event": 32, "field": "f2", "k": 0}]}
```

- **Definition of a segment**: on a state table, the state of the field after the deletion is cut into segments by "which contribution gives it": the longest interval over which the same contribution gives the value continuously is one segment. `carried` points to the contribution that gives this segment. `deps` **always contains the contribution that `carried` points to** (the interval of this segment comes from it, and when it is restated this block must be cleared), plus the other contributions that cut this segment to its present shape (the writes that cover it on both sides, the revokes that leave an adjacent gap).
- **Which to list**: the same rule for all three kinds of table: **list every field whose value, or whose giving contribution item, differs from before the deletion; also list those given by an item restated in this deletion**. A field whose giver changed while its value did not must be listed as well: once the tombstone is applied and the log is replayed from the start, the deleted contribution is no longer there, and a business table can get these fields only from here. A state table lists by segment, and the two kinds of segment are special cases of this rule; **a segment is listed whole, not trimmed to the part that changed**:
  1. at some valid time within the segment, the value or the contribution item that gives it differs from before the deletion;
  2. the segment is given by an item restated in this deletion (`restated`).

  A state table also has changes that fall where there is no value: when the cells `apply` keeps there (those a no_value write-back gives on the fields that decide "has a value", and the cells of "existence" in the version table marked revoked) differ from before the deletion, the entity must be listed as well. The latter are kept only where a field item is in effect, so they grow or shrink when the deletion changes where a field item under the revoke is in effect, even though every field is still given by that revoke. These places all lie in the gaps of `results/<k>/existence`, which gives them; no segment of a field is listed for them.

  In addition, **a row whose giver of "existence" changed is listed in full** (the same for all three kinds of table): when the contribution that created this row or entity was deleted and the row stays because of other contributions, the value and the giver of every field are listed, including those that come from a schema constant (the source is written as `schema_const`). In a replay from the start, this row is newly created by this result, with all its fields; the "create the row when it does not exist in the replay" of `apply` below depends on this rule.

  In addition, **when an "existence" item is deleted or restated (including a restatement unchanged), or an `uncovered` write-back item is restated, the row or entity must be listed**, the same for all three kinds of table. An event table or a timeless table has no `existence` block, and whether the row is there is expressed by `outcome`, whose result takes the existing value in the shape after the deletion (the whole row deleted: `deleted`; a field becomes empty: `kept_fields_cleared`; a field goes back to an earlier value: `fields_reverted`; no value changed: `sources_changed`). On a state table, the segments of all fields that intersect the intervals of these items are listed whole, where "the intervals of these items" is the union of the interval last given before the restatement and the interval after the restatement. In a replay from the start, the `span` blocks of these items have been removed and they are not applied at the original event (§5.7), so the gaps and the "already reverted" register can be obtained only from here and from `restated/<k>`.

  On an event table or a timeless table, a row that was revoked both before and after the deletion is not listed because of its fields: after the revoke, the values of the fields remain on the row, and the deletion may change their givers, but they cannot be read, so the result does not mention them; `apply` applies them as the provenance table says (see the first item of `apply` below).

  **On a state table, every entity that is listed (whichever of the rules above caused it) gets `results/<k>/existence`** (all gaps after the deletion; `gaps` is an empty array when there is none).

  A segment that is not listed stays as it is. When this segment has no contribution at all, `value` is `null` and `sources` is an empty array; when the value of this segment is an explicit clearing (the `"value": null` of §5.7), `value` is `null` and `sources` writes `carried` as usual. The part of a write-back item restated as `no_value` that is still exposed is listed under rule 2 (a segment given by an item restated in this deletion), also written as `value: null`, `sources: []`, and `deps` contains that write-back item. When a revoke with an interval is deleted, the value that becomes visible again is listed as the whole segment it lies in (the interval of that segment is that of the contribution that gives it, not including the interval of the deleted revoke), and `results/<k>/existence` gives the gaps that remain after the deletion. The interval of a gap may have no `from` (from the earliest); having neither `from` nor `to` means the whole entity has no value at any valid time.
- A value carried over from an earlier contribution always has its source written as `carried`. When the sources of these contributions are deleted later, this block is likewise in the scope of the cascade. When a value falls back to the backfill of a schema switch, the source is written as a `schema_const` entry (§5.7), not `carried`, and the constant itself does not enter `deps`; on a state table the interval of this segment comes from the backfill segment, and the `deps` of that `backfill/…` block is copied in (§3.5). A `restated/<k>` with a value follows the same rule.

`restated/<k>`: the judgement result of one contribution after the replay. Its shape is the same as the judgement result of one item in `write.base` (the `status` of `fields` plus the content of `span`):

```json
{"event": 18, "field": "f2", "k": 0, "status": "applied", "valid": {"from": "2026-11-02"}}
```

```json
{"event": 26, "field": "f2", "k": 0, "status": "corroborated",
 "valid": {"from": "2026-11-05", "to": "2026-11-20"}}
```

| key | meaning |
|---|---|
| `event`, `field`, `k` | which item (the k-th) of which field of which `write.base` it points to. When the restated item is a contribution to "existence", there is no `field` or `k`, and `"existence": <k>` is used instead; when it is an item that restores existence, it also carries `"restored": true` |
| `status` | the status in effect after the replay: `applied`, `corroborated`, `candidate`, `awaiting`, or `dropped` (this item is no longer a contribution: it became the same value and no evidence was pointed to at the time; every item covered by the entry of the revert record is not a contribution or the range is empty (the item written back by the revert); or its interval was merged into another item of the same field). A carried item (written back by a revert, by adopting a candidate, or by returning to the merge base) is treated like an ordinary contribution |
| `valid` / `seen_valid` | state table: the interval after the replay. `candidate` uses `seen_valid`; `dropped` has neither |
| `deps` | the other contributions used when resolving this interval after the replay, with the same meaning as the `deps` of `span` |
| `value`, `sources` | present only when a carried item (written back by a revert, or by returning to the merge base) had its value or carried source changed by the replay: the new value and the new `carried` references (the items that `carried` points to are also listed in `deps`) |
| `no_value` | `true`: after the replay, this item writes back "no value" (the same meaning as `no_value` of `write.base`). There is then no `value` or `sources` |
| `uncovered` | `true`: after the replay, this item only registers and gives no value (the same meaning as `uncovered` of `write.base`). There is then no `value` or `sources` |

- **Which items are restated**:
  1. Every item whose judgement result after the replay (the status in effect, the interval, `deps`, the value and source of a carried item, whether it is `no_value` or `uncovered`) differs from the one last given in the log. When `deps` are compared, an item of an event or timeless table has no `deps` of its own: the carried items that a valued `restated/<k>` block also lists in its `deps` (§3.5) do not count as a difference.
  2. **Every item that is still a contribution after the replay and whose current judgement result was given by a block that this deletion clears**. That block is its original `span`, or the `restated/<k>` of an earlier deletion. Even when the result did not change it is given again, because the original block can no longer be read; if it were not given again, in a replay from an empty store this item would be treated as "no longer a contribution". "Cleared by this deletion" goes by this deletion's own list of positions ([`03-data-model/03-deletion.md`](03-data-model/03-deletion.md), "Each deletion lists all its positions on its own"); what the other pending deletions do in the replay does not change it. An item whose block last given is an earlier deletion's `restated/<k>` saying `dropped` is restated as `dropped` again when this deletion clears that block: it is no contribution, but if it were not given again, in a replay from an empty store it would fall back to the block it was written with and be a contribution again.

  3. **The cancellation event additionally restates every item whose most recently given interval block comes from the deletion being cancelled**, and restates it unchanged even when the result did not change (the same kind as the unchanged restatement of an "existence" item). The blocks given by the cancelled deletion no longer count afterwards (§5.7, "Blocks given by a cancelled deletion do not count"); if it were not restated, looking back for the most recently given interval would pass over the current interval of this item and reach an outdated block.

  A carried item whose original field block was cleared by this deletion and that has a new result after the replay is restated with its original `k`. The cancellation event follows rules 1 and 2 in the same way, plus rule 3. When an "existence" item or an `uncovered` write-back item is restated (including a restatement unchanged), `results` lists this row or entity at the same time, and a state table also gives `results/<k>/existence` ("Which to list" above).
- **The cases that a restatement covers**: a candidate or awaiting item takes effect because of the deletion (the `status` and `valid` after taking effect are given, which may be `applied` or `corroborated`); it becomes awaiting confirmation because of the deletion (`awaiting`, the new item is given by the `item.created` that follows, and its `origin_event` points to this `write.base`); a value change becomes a corroboration, a corroboration becomes a value change; the default end point, the `corrected_span`, and the end point of a revoke that carries only a start point are resolved again; an item written back by a revert changes because "the previous state" changed.
- **The latest one holds**: the judgement result of a contribution is the one in the event that gave it most recently in the log. A later `undo`, "the interval recorded by that write" in the conflict criterion, and references to it all follow it; the corroboration end point is derived from the `status` and `valid` after the restatement.
- It is a data block: when the item it points to is deleted or restated again, or any item in its `deps` is deleted or restated, it is listed in the position list of that deletion (§3.5).

**`recreated/<k>`**: recorded when the deletion replay changes "which write was the first creation". `created` likewise follows the one given most recently.

**`positions` are all the content blocks that this deletion empties**, each deletion listing them in full (blocks that overlap with other pending deletions are listed anyway). They include:

| category | blocks |
|---|---|
| the source data being deleted | `text` / `file` / `request` / `stated_at` |
| the contributions of these sources | `fields/*/*`, `sources/*/*`, `literal/*/*`, `span/*/*` of `write.base`, and `span/existence/*` of a revoke with an interval |
| the raw parameters and operation identifiers | `ops/<i>/set/*`, `ops/<i>/valid`, `ops/<i>/refs` of `write.head`, and the `ops/<i>/premise_valid/*` whose source is the same as theirs; `task`, `request_key`, `idempotency` of the operations concerned |
| blocks whose `deps` contain a deleted or restated contribution (§3.5) | `span/*/*`, `span/existence/*`, `ack/*`, `duplicate` of other writes; `ops/<i>/premise_valid/*` with `deps`; the entry blocks and `scope_valid` of items; `results/*/fields/*/*`, `results/*/existence`, `restated/*` of earlier deletion events |
| backfill segments whose `deps` contain a deleted contribution (a restatement does not count, the exception to rule 1 of §3.5) | `backfill/*/*/*` of `schema.switched` |
| items whose `carried` points to a contribution that is deleted or restated as `dropped` | `fields/*/*`, `sources/*/*` of a carried item (a carried item has no `literal` block; its `span` is in the row above) |
| those that become invalid as a consequence | `confirmation` of `item.resolved`; `key`, `checksum` of a derived write; `tables/*` of `schema.switched` |
| this event's own | `summary` |

The `ver` of an affected row or entity is replaced with this operation number.

`apply`:

  - **Business tables are applied from the provenance table and checked against `results/*`**: first change the provenance table as the `base_sources` item below says, then apply every row or entity that this deletion touched (one whose field block or interval block of an item is listed in `positions`, one with an item restated by `restated`, or one listed in `results`) from all of its items in effect in the provenance table; this is the same deterministic computation as the application of `write.base` (assign the values of the items in effect to their intervals and normalize the segmentation, with no judgement and no replay); the version table adds a version on a changed cell (the intent is recorded as `deletion`), and the cells given by an item whose content was changed by the restatement (the new value of a carried item, a write-back item changed to `no_value`) are replaced with new ones as well. The result of the application must be exactly what `results` says, checked item by item: for every segment of every field listed in `results`, the value and the giver (the item that `carried` points to) on the same interval (a segment whose value is empty and that has no source is checked only for being empty); for the entity of a state table, all intervals without a value equal `results/<k>/existence`; a row or entity whose outcome is `deleted` does not exist after the application (for other outcomes whether it exists is not checked: a row that does not exist before or after the deletion may also be listed because its giver changed). Of a listed row or entity, the fields and segments that are not listed stay as they are: outside the listed segments and intervals without a value, which item gives each segment (or that no item gives it, and whether it is recorded as no value) is the same before and after the application. A row or entity that was touched but is not listed in `results` must have cells after the application identical to the original; the only exception is a row of an event table or a timeless table that does not exist (does not exist or is revoked) both before and after the deletion, which is applied as the provenance table says and is not checked. If anything does not match, `apply` stops with an inconsistency and does not compute another shape of its own. A row or entity in `results` that does not exist when the replay reaches this point (all blocks of the writes that created it have been removed, and `apply` created no row at that time) is newly created with its items in effect when it is applied.
  - `base_sources`: remove the items whose field blocks are listed in `positions`; the schema constant contributions that correspond to the state-table backfill segments listed in `positions` (`backfill/*/*/*` of `schema.switched`) are removed as well; write the status in effect, the interval and the carried references of every restated item according to `restated/*`, including write-back items with `no_value` and `uncovered` (`dropped` ones are removed; `candidate` and `awaiting` ones do not count as in effect; when an item has both, `restated` holds). An item that takes effect because of the deletion keeps its original place in the order of contributions. `block_deps` is updated accordingly.
  - Which items were reverted (the revert record `revert`) does not change because of a restatement; the range of the register is recomputed from the intervals of the restated write-back items (the same as the `apply` of `revert` in §5.7).
  - `premise_decls`: when `ops/<i>/premise_valid/<j>` of a declaration is listed in `positions`, the range of this declaration is handled as the whole timeline from this event on (the copy of the valid time stays until the tombstone clears it); the change of state is applied by the `premise.changed` in the same operation.
  - `counts`: updated when a whole row is deleted, or when a row appears or disappears because of the deletion.
  - `recreated`: update the register of the first creation.
  - `premise_edges`: the indexes newly assigned by `restated/*` on the same (event, field or "existence") are covered by the declarations that cover that (event, target) (the part the op itself wrote); the indexes newly assigned on the items listed by `premise_covers` are covered together with the item they were split from, where "which item it was split from" is judged by the interval block at the time of the write, and by the original interval when that block has been cleared by a deletion executed at expiry (§5.7). The change of premise state is applied by the `premise.changed` in the same operation (§5.10).
  - Key index `external_keys`: when the key field item of a `write.base` (`fields/<key field ID>/0`) appears in `positions`, the entry for the key held by that row, or for the key it yielded (when it is the `key_from` row), becomes "frozen", and the holder does not change. Freezing is inferred from `positions`, not from the difference before and after of the key field value in `results`: in a replay from the start the deleted block is no longer there, and the difference may be "empty → empty". What freezing records is a **set of deletion IDs**: when several pending deletions freeze the same key, one is recorded for each. No block is added.
  - `superseded_items`: the state of the items is applied by the `item.superseded` events that follow.
  - The blocks listed in `positions` cannot be read from now on (logical deletion), and stay in storage until expiry.
  - Add a row to `deletions` (pending); the `deletion` item during the grace period is derived from this row.
  - The source data being deleted (`target.sources`) is recorded as pending deletion in the source data register: later writes can no longer use it as evidence (`pending_deletion_source`). It is set back when the deletion is cancelled.

#### `deletion.cancelled`

A head event. A deletion is cancelled within the grace period. `actor` is the canceller; when the restore procedure supplied it from the register, `actor` is `system` and `trigger` is `restore`. It carries `ctx`; one cancelled by a caller also carries the other blocks of §5.1.

| path | kind | content |
|---|---|---|
| `target` | metadata | `{"deletion": "pi_…", "origin": "request" \| "restore_cancel"}` |
| `results/<k>/target`, `results/<k>/fields/<field ID>/<j>`, `results/<k>/existence` | metadata / data | the same shape as in `deletion.confirmed`: the shape of the affected rows or entities after the cancellation (computed again by definition, together with the writes made during the grace period) |
| `restated/<k>`, `recreated/<k>` | data / metadata | the same shape as in `deletion.confirmed`: the judgement results of the contributions and the first-creation marks after the cancellation. A write that took effect because of that deletion and goes back to the not-in-effect state after the cancellation is restated here as `candidate` or `awaiting`; an item that was restated by that deletion is restated here once more according to the state after the cancellation |
| `restored_items` | metadata | the list of IDs of the items restored as open |
| `kept_superseded/<k>` | metadata | an item that stays "superseded": `{"item": "pi_…", "by_event": <seq>}` |
| `kept_effective/<k>` | metadata | a write that took effect because of the deletion, was used as the baseline by another write during the grace period, and so is not reverted (recorded only when all its items on this target were in effect before the cancellation; the judgement goes by (event, target), `items` is only for the receipt, and the indexes do not take part in the judgement): `{"event": <seq>, "items": [{"field": …, "k": …}], "by_event": <seq of the write.base that used it as baseline>}` (written as `{"existence": <k>}` for an "existence" item). When several writes during the grace period used it as baseline, `by_event` takes the first |

- The blocks that that deletion listed in `positions` become readable again (except those still listed by another pending deletion). Of these, a block with `deps` has content computed before the deletion; whether it still holds after the cancellation is decided by the replay, and what changed is given again by the `restated` and `results` of this event, which hold.
- The `results/*` and `restated/*` blocks of the confirmation event of that deletion are no longer "the one given most recently" from now on; they stay in the log and are cleared with their `deps` according to §3.5.

`apply`: the same as for the confirmation, applied from the provenance table and checked against `results/*` (the intent of a version is recorded as `deletion_cancelled`; a row that does not exist in the replay is newly created, the same as for the confirmation; `restated/*` changes only the provenance table, not the business tables). The rows touched are those touched by the deletion being cancelled and those touched by this event; when applying, the judgement of each item is the one given most recently in the log, blocks given by the cancelled deletion do not count, and blocks given by other cancelled deletions do not count either; the blocks that cannot be read are those listed by other deletions that are still pending; `counts` is updated when a row comes back or disappears; the provenance table and the register of the first creation are updated according to `restated/*` and `recreated/*`; the state-table backfill segments that that deletion removed are put back into `base_sources` (except those still listed by another pending deletion); a premise declaration that that deletion changed to be handled as the whole timeline gets its range restored to the valid time recorded in `premise_valid` (the same exception as above); the external key entries frozen by this deletion have the ID of this deletion removed from the frozen set, and turn back to "present" only when the set is empty; `deletions` is set to cancelled; the items restored are set back to open from `restored_items`. The change of premise state is applied by the `premise.changed` in the same operation.

#### `deletion.executed` (tombstone)

A head event, `actor: "system"`. `trigger`: for expiry it is `deletion_expiry`, for what the restore procedure supplies it is `restore_backfill`, and for what is supplied for a placeholder pending deletion at import it is `import`.

| path | kind | content |
|---|---|---|
| `target` | metadata | `{"deletion": "pi_…", "reason": "expiry" \| "restore_backfill" \| "import_placeholder"}` |
| `positions` | metadata | the content blocks emptied this time: `[{"seq": …, "path": …}]` |

- The tombstone contains no text that describes the deleted content and no value computed from it.
- `positions` is in general equal to the `positions` of the corresponding `deletion.confirmed`; blocks already emptied by an earlier tombstone are skipped and not listed again.
- **The tombstone supplied at import** (`reason: "import_placeholder"`): by default the export replaces the blocks pending deletion within the grace period with placeholders (§8), and this content is not in the file. Right after `tenant.imported`, the import supplies one tombstone for each such deletion, placed after it; these deletions cannot be cancelled at the target, and the corresponding `deletion` items close as expired. In this way the store holds only two real states, "present" and "removed", and leaves no placeholder that appears cancellable but cannot be cancelled.
- A tombstone never expires.
- `apply`: empty every block listed in `positions` and record `removed_by` = the `seq` of this event; clear, from the physical tables of each version (including retired tables), the version table, `pending_entries`, `partitions`, the request key index, the full-text index, and the valid time in `premise_decls`, the content derived from these blocks; for every key that `positions` involves, remove the ID of this deletion from the frozen set, then recompute the holder according to [`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md) "How the holder is decided" (when what was removed is the key contribution of the write that backfilled the key, the entry points back to the `key_from` row, provided its key contribution is still there; otherwise the entry is removed); while the set still holds IDs of other deletions, it stays frozen; `deletions` is set to executed. The current business state does not change.

### 5.10 Premises

#### `premise.changed`

When an operation changes the state of some premise declarations, record these changes: from "unchanged" to "changed" (set the mark), from "changed" back to "unchanged" (clear the mark), and the repointing at deletion. It is **not a head event** and carries `op`; the `slot`, `actor` and `at` of the event header are the same as those of the operation it belongs to. There is at most one per operation, produced only when there is a change; within an operation it comes after all `write.base` and item events and before `write.derived` (§4.2–§4.4). Only five kinds of operation produce it: a write, a write triggered by `resolve`, a deletion confirmation, a cancelled deletion, and a schema switch (only when the new version deletes a field that some declaration declared; see the end of this section).

The judgement is made online, once, at the time: comparing "the value now" with "the value on the version seen" requires reading historical versions, and after the content has been physically deleted a replay cannot read the value of that time. So the change is written into the event, and `apply` does as it says without comparing by itself (for the criterion and the detection steps see [`03-data-model/02-integrity-and-records.md`](03-data-model/02-integrity-and-records.md) "The premises of a write").

| path | kind | content |
|---|---|---|
| `targets/<k>` | metadata | a premise target whose value changed, and the declarations whose state changed because of it, see below |

```json
{"table": "t1", "row": "r_01JF…", "by_event": 62,
 "changed":   [{"op": 50, "i": 0, "j": 0, "reason": "update"}],
 "matched":   [{"op": 73, "i": 0, "j": 0}],
 "repointed": [{"op": 45, "i": 1, "j": 0}]}
```

| key | meaning |
|---|---|
| `table`, `row` / `entity` | the premise target |
| `by_event` | the event that made it change: the `seq` of the `write.base` in this operation (when several change this target, the earliest; it does not take part in `apply` and is only for display); when caused by a deletion, the `seq` of `deletion.confirmed` / `deletion.cancelled`; when caused by a schema switch, the `seq` of `schema.switched` |
| `changed` | the declarations that go from "unchanged" to "changed". A declaration is identified by (operation number `op`, op index `i`, declaration index `j`) (§5.7). `reason` is given for each one (on a state table the same write may have different reasons for different declarations), with the values in §6.8; `since` is this operation number and is not recorded separately |
| `matched` | the declarations that go from "changed" back to "unchanged" (the value now is again the same as the value seen, and the value on the version seen can be read) |
| `repointed` | appears only in a deletion confirmation and a cancelled deletion: the declarations that stay "changed" with `since` set to this operation number and `reason` set to `deleted` |

- **`premise.changed` in a schema switch**: when the new version deletes a field that some declaration declared (including a field deleted with its table), an "unchanged" declaration becomes "changed", with `reason` `schema_switched` and `since` this operation number; `by_event` is the `seq` of `schema.switched`; there is one block for each affected premise target, with only `changed`. A declaration that is already "changed" is left alone (`since` and `reason` stay); when a declaration declared several fields and only one of them is deleted, the declaration likewise becomes "changed"; a declaration is not widened to the whole row. The switch itself does not judge any other declaration again (it neither clears marks nor repoints): when `migrate` makes the values equal again in the new version, the mark is cleared in the next operation that touches this premise target, by the usual detection comparison. The fields listed in a mark are only those still present in the current version.
- Each of `changed`, `matched` and `repointed` is omitted when empty, and a premise target where all three are empty has no block (every block has at least one of the three). There is one block for each premise target that changed, with `k` starting from 0.
- **All of it is metadata**, and in the first version it is not cleared by any deletion; the information it leaves is in §9.2.
- `apply`: change the state, reason and `since` of the corresponding declarations in `premise_decls` according to `changed` / `matched` / `repointed`. Nothing else.

### 5.11 The operations that produce events in the first version

| operation | produces events? |
|---|---|
| `write`, `resolve`, `schema_draft`, `delete`, cancelling a deletion | Yes (above) |
| issuing, renaming, revoking a connection | Yes (`principal.*`) |
| removing an empty slot | Yes (`slot.removed`); removing an already removed slot again: No |
| import into an empty tenant | Yes: the imported events are appended unchanged, followed by one `tenant.imported`, then one tombstone for each placeholder pending deletion (§5.2) |
| a rejected request (validation failure, `read_first`, `insufficient_scope`, compile failure, a `resolve` whose table has been written to by the time of confirmation, …) | No. A rejected write produces no event and no deduplication is done |
| a write whose fields are all no-ops | `write.head` and `source.recorded`; no `write.base` |
| restating and clearing premises (an `update` without `set` that carries only `premises`, or carries `premises: []`) | `write.head` (with the premise blocks) and `source.recorded` (the evidence, or the `api_call` of this op); no `write.base`, and the `ver` of the row does not change |
| a write whose ops are all `unchanged` / `skipped` by external key | No (§4.2). The receipt is still given, with no operation number |
| all read operations (including the deletion preview) | No. Reads are recorded in the read record, not in the log |
| log verification, replay comparison, export, read audit queries | No |
| persisting and cleaning up the read record, residue cleanup, advancing the high-water mark, the ownership epoch | No |

### 5.12 What the materialized state maintained by `apply` is rebuilt from

| materialized state | rebuilt from which parts of which events |
|---|---|
| the principal register (including scope, slot range, state) | `user`, `system` of `tenant.genesis`; `principal.*`; `user` and deactivation of `tenant.imported` |
| the current restore count | `restore_count` of the latest `tenant.restored` or `tenant.imported` (0 if there is neither) |
| the current tenant ID | `tenant` of the latest `tenant.genesis` or `tenant.imported` |
| slots, the current version pointer, the current policy | `compiled` of `schema.compiled`; `target` of `schema.switched`; `slot.policy_set`; `slot.removed` (removes) |
| the schema version table, the migration state, the structural part of the catalog | `schema.*`; `slot.removed` (removes its catalog, and the schema version table stays) |
| the current version of business tables, the version table, the row count counters | `target`, `fields/*/*` (`applied`), `existence/*` of `write.base`; `span/*/*`, `span/existence/*` of `write.base`; `results/*`, `restated/*` of `deletion.confirmed` / `deletion.cancelled`; `schema.switched` (converts the writes of the old version according to `compiled`); `deletion.executed` (empties); `slot.removed` (removes the physical tables and the counters) |
| the provenance table (including the current interval of each contribution, the register of the first creation, the corroboration end points) | `status` of `fields/*/*` and `existence/*`, `span/*/*`, `span/existence/*`, `sources/*/*`, `valid_sources`, `op_sources`, `target.created`, `revert` (the register of "already reverted") of `write.base`; `ops/<i>/valid` of `write.head` (to tell an explicit end point), `ops/<i>/target.by_external_key` (which contributions are sync contributions, for the sync baseline); `restated/*`, `recreated/*` of `deletion.*`; `schema.switched` (converts the items of the old version according to `compiled`, and registers the contributions that a constant `backfill` supplies) |
| the block dependency index | the `deps` of each data block, and the `carried` in `sources/*/*`, `results/*`, `restated/*` |
| derived tables, the group mapping, the derived read set | `write.derived`; `schema.switched` (rebuilt according to the new rule) |
| pending items and their entries | `item.*`; `deletion.confirmed` / `deletion.cancelled` (the `deletion` item itself, `superseded_items`, `restored_items`) |
| the data flags `disputed`, `awaiting`, `flagged` | the `target` and `scope_valid` of open items |
| the key index `external_keys` (external key → row, with state "present", "frozen" and the set of deletion IDs that froze it, and the "yielded" rows) | `compiled` of `schema.compiled` (the `external_key` of the table); the key field items of `write.base`; `ops/<i>/target.key_from` of `write.head` (when the key field item is present in the same operation); `positions` (freezing) and `results/*` of `deletion.confirmed`; `deletion.cancelled` (unfreezing); `deletion.executed` (recomputes the holder); `schema.switched` (rebuilt according to the table of the new version) |
| the premise declarations `premise_decls` | `ops/<i>/premises/<j>`, `ops/<i>/premise_valid/<j>` of `write.head`; `premise.changed`; `positions` of `deletion.confirmed` (a declaration whose `premise_valid` is listed gets its range changed to the whole timeline); `deletion.cancelled` (the range is restored); `deletion.executed` (empties the valid time) |
| the premise coverage `premise_edges` | `write.base` (finds the declarations of this op by `target.op_index` and registers the items of this event); `ops/<i>/premise_covers`, `ops/<i>/premises_cleared` of `write.head`; `restated/*` of deletion events (the newly assigned indexes). Only grows and is rewritten, never deleted from |
| the request key index | `request_key`, `idempotency` of each head event |
| the deletions table | `target` of `deletion.*` |
| the source data register, the full-text index | `source.recorded` |
| the profile and value examples of the catalog | computed from the current business tables, not given directly by events |

### 5.13 The algorithm of the result checksum

Used for the `checksum` of `write.derived` and the `tables/<table ID>` of `schema.switched`.

- **One derived row**: arrange the result columns, ordered by the lexicographic order of the field IDs, into the object `{<field ID>: <value>}` (the values follow §1.3), and take the SHA-256 of the JCS bytes.
- **One table**: computed over the final logical rows of the table of the new version, taking the value after the backfill when there is a constant backfill. Write each logical row as `{"id": <row or entity ID>, "valid": <interval, only for a state table>, "fields": {<field ID>: <value>}}`, and sort by `id`, then by `valid.from`; take the JCS bytes of each row and join them with a newline (`0x0A`); take the SHA-256 of the whole. Revoked rows are not counted.

---

## 6. Enumerations

**"Reserved value" refers only to the kind that the first version does not produce and that stops the node when encountered; the dedicated values the first version is already using (the principal `system`, the `existence` of "existence") are called "fixed values" and are legitimate content of `v` = 1. A reserved value does not belong to the set of values of `v` = 1.** The tables in this section list the values that the first version of the kernel produces; those marked "reserved" only hold the name: the first version of the kernel neither produces nor accepts them, and meeting one in an event of `v` = 1 stops the node as an unknown shape (§1.6). When a reserved value is enabled in the future, the `v` of the event type that uses it is incremented by one. The same holds for keys that are "always empty in the first version": a non-empty shape does not belong to `v` = 1.

### 6.1 Event types

Produced by the first version:

| `type` | description |
|---|---|
| `tenant.genesis` | tenant genesis |
| `tenant.restored` | restore |
| `tenant.imported` | import into an empty tenant |
| `principal.registered`, `principal.renamed`, `principal.revoked` | principals |
| `slot.policy_set` | slot policy |
| `slot.removed` | removing an empty slot |
| `schema.draft_submitted`, `schema.compiled`, `schema.confirmed`, `schema.rejected`, `schema.superseded`, `schema.migration_started`, `schema.switched`, `schema.migration_failed` | the schema lifecycle |
| `source.recorded` | source data |
| `write.head`, `write.base`, `write.derived` | writes |
| `item.created`, `item.merged`, `item.refreshed`, `item.superseded`, `item.resolved` | pending items |
| `deletion.confirmed`, `deletion.cancelled`, `deletion.executed` | deletion |
| `premise.changed` | the change of premise state |

Reserved (not produced by the first version): see §10.

### 6.2 Intent: `intent`

| value | meaning |
|---|---|
| `insert` | add |
| `update` | change |
| `correct` | correction |
| `revoke` | revoke |

A revert (`revert`) is not an intent; `write.base` carries a separate revert record `revert`, and it is the same kind of operation as the base write triggered by `take_previous` (the only difference is whether the `revert` block holds `before_op` or `as_of_op`). The intent of a write that reverts: for `undo`, the caller's intent if the caller gave one, otherwise **the intent of the `write.base` with the largest `seq` on this row (or entity) among those of the undone operation**, not counting the writes reverted along with it by `include_later`; for `take_previous`, **the intent of the `write.base` that holds the item with the largest event `seq` in the revert record**, and `update` when the revert record is empty. The other two kinds of write triggered by handling an item follow the same practice: `take_candidate` takes **the intent of the `write.base` that holds the item with the largest event `seq` among the items of the adopted candidate**, and confirming an awaiting-confirmation item (`confirm`) takes **the intent of the `write.base` that holds the item with the largest event `seq` among the items of the proposal**. These intents only mean "which origin it follows"; the actual effect is determined by the written-back items: for example, when the side in effect in a conflict whose target is "existence" is a revoke, the write of `take_previous` that restores existence follows the intent `revoke`, while what it writes back is the `restored` item of `existence`; when `timeline` shows such a write, it explains what was done by the revert record and the written-back items, and does not rely on the intent alone. Reserved value: `applied_by_rule` (system ruling, §10).

Each version in the version table also records an intent, for `timeline` and `changes` to give. Besides the four above there are three more values, used only for versions produced by a deletion or a schema switch and never appearing in `write.base`:

| value | meaning |
|---|---|
| `deletion` | this version was produced by a deletion confirmation |
| `deletion_cancelled` | this version was produced by a cancelled deletion |
| `schema_switch` | this version was supplied by the `backfill` of a schema switch at a position that originally had no value (its origin is that `schema.switched`) |

### 6.3 Field status in effect: `status`

| value | meaning | changes the business table? | records a source? |
|---|---|---|---|
| `applied` | in effect | Yes | Yes |
| `candidate` | a conflict candidate, not in effect | No | recorded in the event, not entering the provenance table |
| `awaiting` | high-impact, awaiting confirmation, not in effect | No | same as above |
| `corroborated` | the same value with evidence explicitly pointed to: a source is appended | No | Yes |
| `dropped` | appears only in `restated/<k>` of a deletion event: this item is no longer a contribution after the deletion replay (it became the same value and no evidence was pointed to at the time); for an item written back by a revert, every item covered by the entries of its revert record is not a contribution or the range is empty; or its interval was merged into another item of the same field | No | No |
| `noop` | the same value as the version seen and no evidence pointed to: a no-op. **It does not appear in `write.base`** (a field that is a no-op has no item, and only the field ID is listed in `ops/<i>/noop` of `write.head`); this value is used only in the receipt of the contract | No | No |

Reserved value: `applied_by_rule` (later: a system ruling makes a candidate take effect by rule).

### 6.4 Item kind: `type`

`conflict`, `awaiting_confirmation`, `flagged`, `schema_change`. A `deletion` item is not expressed by `item.*` events (§5.9). Reserved values: `migration_diff`, `sync_rejected`.

### 6.5 Decision: `decision`

| item kind | values |
|---|---|
| `conflict` | `keep_effective`, `take_candidate`, `take_previous` |
| `awaiting_confirmation` | `confirm`, `reject` |
| `flagged` | `keep`, `revoke` |
| `schema_change` | `confirm`, `reject` |

Cancelling a `deletion` item (the decision `cancel` on the surface) does not go through `item.resolved` and is expressed by `deletion.cancelled` (§5.9).

Reserved values: `accept_all`, `rows` (accept, reject, or give a value row by row), `keep_rest_and_switch`, `abandon` of `migration_diff`.

### 6.6 Cause codes and supersession reasons

The `reason` of `item.created`:

| value | item kind | meaning |
|---|---|---|
| `stale_write` | `conflict` | a write that carries a stale `ver` intersects a write made in the meantime |
| `overwrites_change_point` | `awaiting_confirmation` | wipes out a recorded change point (including filling a value across a gap) |
| `referenced_row` | `awaiting_confirmation` | revokes a row that is still referenced |
| `undo_includes_later` | `awaiting_confirmation` | `undo` reverts later writes along with it |
| `undo_hides_later` | `awaiting_confirmation` | the revoke that `undo` writes back would hide a later write (when both causes hold, `undo_includes_later` is recorded) |
| `conflict_cleared_by_deletion` | `awaiting_confirmation` | a deletion makes a conflict disappear, while that write is still high-impact |
| `restored_candidate` | `conflict` | a cancelled deletion put a candidate back, and the item it was originally in was resolved during the grace period: a separate item is opened for it, and `related_item` points to the original item. It does not occur in the first version (an item cannot be resolved on an affected row during the grace period) |
| `duplicate_keys` | `flagged` | meets the criterion of a suspected duplicate |
| `schema_change` | `schema_change` | the draft needs confirmation |

Reserved value: `policy_high_impact`.

A `deletion` item has no `item.created`; the cause code given on the surface is the `origin` of `deletion.confirmed` (§6.8).

The `reason` of `item.superseded`:

| value | meaning |
|---|---|
| `overwritten` | the target was changed by a write that had read the item |
| `schema_switched` | the schema has switched and the item involves a changed field |
| `deleted` | a privacy deletion leaves the item without a target, the candidate or the proposal without any value source, or deletes its cause |
| `draft_replaced` | the draft that the `schema_change` item corresponds to was superseded by a new draft |
| `deletion_cancelled` | an awaiting-confirmation item generated because of a deletion no longer holds after the deletion is cancelled |
| `matched_changed` | one of the two rows that a `flagged` item matched was revoked or changed, and the suspected duplicate no longer holds |
| `nothing_to_revert` | after an awaiting-confirmation item of the revert kind is judged again against the current state, there is no segment left to write back and no write to hide or revert |

Reserved values: `evidence_deleted`, `migration_failed`.

### 6.7 Why a candidate arose: `cause`

`stale_write`. Reserved value: `displaced_by_rule`.

### 6.8 Other values

| Field | Values |
|---|---|
| `kind` of `source.recorded` | `user_message`, `agent_note`, `tool_result`, `file_ref`, `api_call` |
| Source level `level` | `user_stated`, `agent_inferred`. Reserved: `external_authority` |
| Literal match `result` | `hit`, `miss`, `na` |
| `ver.basis` | `explicit`, `fallback`, `same_request`, `external_key` (the last appears only in `ops/<i>/target`, not in premise declarations) |
| `range` of a premise declaration | `whole`, `from_now`, `row_time`, `given` |
| `state` of a premise declaration | `current`, `changed` |
| Reason of a premise `reason` (the declaration block, and `changed` of `premise.changed`) | `correct`, `update`, `revoke`, `retroactive`, `plan_changed`, `deleted`, `schema_switched` |
| `mode` of `valid` | `given`, `now`, `open`, `next_change`, `corrected_span` |
| `cause` of `write.base` | `request`, `resolve` |
| `scope` of `existence` | `whole`, `interval` |
| `kind` of `deletion.confirmed` | `privacy` |
| `origin` of `deletion.confirmed` | `request`, `restored_unconfirmed`, `restored_pending`, `restored_executed` |
| `origin` of `deletion.cancelled` | `request`, `restore_cancel` |
| `reason` of `deletion.executed` | `expiry`, `restore_backfill`, `import_placeholder` |
| `export.pending_deletions` of `tenant.imported` | `placeholder`, `included` |
| Deletion result `outcome` | `deleted`, `kept_fields_cleared`, `fields_reverted`, `resegmented`, `sources_changed` (the value did not change; the row is listed because the giver, the judgement result or the block that gave them was given again, §5.9) |
| `outcome` of `schema.compiled` | `applied`, `pending` |
| Change class `class` | `create`, `metadata`, `deterministic`. Reserved: `reextract` |
| `reason` of `schema.migration_failed` | `build_failed`, `verify_failed` |
| `cause` of `item.refreshed` | `target_overwritten`, `references_changed`, `entries_deleted`, `entries_restored`, `matched_changed`, `entries_changed` |
| `via` of `item.resolved` | `call`. Reserved: `elicitation` |
| Principal `kind` | `user`, `connection`, `system` |
| State of a principal (in `principals`, derived from events, not written in a block) | `revoked` (from `principal.revoked`), `disabled` (from `tenant.imported`); a principal that is neither is valid |
| `write.head` `request.sv_basis` | `explicit`, `fallback` |
| `by` of `schema.confirmed` | `auto`, `resolve` |
| `via` of `principal.registered` | `token`, `oauth` |
| `kind` of `impact/<k>` | `overwritten_segment`, `referencing_row`, `reverted_write` |
| `kind` of an entry under `sources/…` | `value` (from source data, or carried with `carried`), `schema_const` (from a schema constant) |
| `effective_value_rule` of `slot.policy_set` | `keep_current` |
| `auto_apply` of `slot.policy_set` | The eight change-class values, see §5.4 |
| The fixed value of an item's `target.unit` | `"existence"` (when the target is "existence", `unit` is written `["existence"]`; in use in the first version, not a reserved value) |
| Enumerations in the compiled definition (§7) | The table `kind`, `time.type`, `granularity`, `rule.time_dependency`, `rule.scope.kind`, `rounding`, `ref.target`: the values are listed in the tables of §7 |
| `pending_deletions` of the export manifest (§8) | The values are listed in §8 |

**Which keys count as enumerations**: every key written as `a | b` or as "values: …" in the tables and shape descriptions of §5, §7 and §8 is an enumeration and is subject to the rule in §1.6, "stop on a value that is not recognized". This section is their index; the definition in each section prevails.

### 6.9 `trigger`

| Value | Used in |
|---|---|
| `deletion_expiry` | Physical erasure at expiry |
| `migration` | The switch and the failure of a background migration |
| `restore` | `tenant.restored`; the deletion confirmations and cancellations that the restore process regenerates from the register |
| `restore_backfill` | Tombstones added by the restore process |
| `import` | Tombstones added on import for placeholder items awaiting deletion |
| `oauth_refresh_replay` | Revoking the connection of this authorization when a refresh token is replayed (`principal.revoked`) |

Reserved values: `job`, `retired_purge`, `rejudge`, `ruling`.

---

## 7. The compiled schema definition

The `compiled` block of `schema.compiled`. It is produced when the first slot is created; afterwards replay, reads at a point in time, deletion replay and migration builds read only it and do not recompile the draft.

```json
{
  "compiler": 1,
  "rsql": "rsql@1",
  "slot": "sl_4KTZ…",
  "name": "ledger",
  "sv": 1,
  "timezone": "Asia/Shanghai",
  "tables": [
    {
      "id": "t1", "name": "expenses", "kind": "base", "description": "One row per expense",
      "aliases": ["spendings", "outlays"],
      "time": {"type": "event", "field": "f1"},
      "physical": {"table": "t_t1_v1"},
      "fields": [
        {"id": "f1", "name": "date", "type": "date", "required": true, "description": "Day of the expense"},
        {"id": "f2", "name": "category", "type": "text", "required": true, "description": "Category"},
        {"id": "f3", "name": "amount", "type": "quantity", "required": true, "min": "0", "description": "Amount",
         "unit": {"code": "CNY", "dimension": "currency:CNY"},
         "precision": {"scale": 2, "rounding": "half_up"}},
        {"id": "f4", "name": "note", "type": "text", "description": "Note"}
      ],
      "duplicate_keys": [["f1", "f2", "f3"]],
      "together": []
    },
    {
      "id": "t2", "name": "monthly_total", "kind": "derived", "description": "Expense total per month",
      "physical": {"table": "d_t2_v1"},
      "rule": {
        "id": "r1", "version": 1, "rsql": "rsql@1",
        "sql": "SELECT date_trunc('month', \"t1\".\"f1\"::timestamp)::date AS \"f1\", sum(\"t1\".\"f3\") AS \"f2\" FROM \"t1\" GROUP BY 1",
        "time_dependency": "bucketed",
        "depends_on": [{"table": "t1", "field": "f1"}, {"table": "t1", "field": "f3"}],
        "scope": {"kind": "group", "key": ["f1"], "key_from_free_text": false}
      },
      "fields": [
        {"id": "f1", "name": "month", "type": "date", "description": "First day of the month"},
        {"id": "f2", "name": "total", "type": "quantity", "description": "Expense total for the month",
         "unit": {"code": "CNY", "dimension": "currency:CNY"},
         "precision": {"scale": 2, "rounding": "half_up"}}
      ]
    }
  ]
}
```

| Where | Key | Meaning |
|---|---|---|
| Top level | `compiler` | The version of the compiler's output format. Add 1 when the structure of the definition changes incompatibly; `apply` stops on a value it does not recognize. Division of work: the event's `v` governs which blocks the `schema.compiled` event has and which keys the blocks have; `compiler` governs the structure of the definition inside the `compiled` block and the compilation rules (what the same draft compiles to). When a key is added to the definition (such as a field's `offset` or a multi-field `migrate`), both are increased by one |
| | `rsql` | The version of the restricted SQL allowlist used to compile this version (such as `rsql@1`, [`03-data-model/11-restricted-sql.md`](03-data-model/11-restricted-sql.md), "Allowlist versions and changes"). The `migrate` / `backfill` expressions of this version are evaluated under it, and replay uses it too. Derivation rules record their own (`rule.rsql`). The kernel keeps the behavior of old versions; when the allowlist changes the behavior of an existing item, a new version is issued. A version the kernel does not recognize: `apply` stops (§1.6) |
| | `slot`, `name`, `sv`, `timezone` | The slot ID, the name, the version number of this version, the time zone |
| | `tables` | **All the tables in this version** (not only the changed ones), each with its complete definition. In replay, this block alone is enough to interpret every write of this version |
| Table | `id`, `name`, `kind`, `description` | All required. `kind`: `base` / `derived`. `description` is required on tables, on fields of base tables and on derived fields (the schema document states it is mandatory, and compilation fails when it is missing) |
| | `aliases` | Aliases: an array of strings, may be absent. Wording for the Agent to see; it takes no part in name resolution. Both base tables and derived tables may have it |
| | `time` | `{"type": "none"}` / `{"type": "event", "field": <field ID>}` / `{"type": "state", "granularity": "date" \| "instant"}`. For an event table, `field` is a required `date` or `zoned_datetime` field of this table |
| | `entity_key` | The natural key of a state table: an array of field IDs, may be absent; when given it is non-empty and every key field is required |
| | `together` | Field groups: an array of arrays of field IDs. Fields of one group are one conflict unit, so a field is in at most one group and each group has at least two fields |
| | `duplicate_keys` | The criteria for suspected duplicates: an array of arrays of field IDs. Appears only on event tables and timeless tables (a state table does not declare it, see [`03-data-model/04-write-and-read.md`](03-data-model/04-write-and-read.md), "Suspected duplicates") |
| | `external_key` | The external key: an array of field IDs (1 to 4), may be absent. Appears only on event tables and timeless tables; key fields do not appear in `together` |
| | `physical` | `{"table": <physical table name>, "since": <integer>}`. `since` is the version in which this physical table was first built; it may be omitted when it equals this version's `sv`, meaning the table is new in this version (an added table, a rebuilt table, a table whose structure changed while it was never written) |
| Fields of a base table | `id`, `name`, `type`, `description`, `required` | The first four are required; `required` appears only when `true`, and its absence means optional |
| | `aliases` | Aliases, same as `aliases` of the table |
| | `min`, `max` | Decimal strings |
| | `values` | The values of an `enum` |
| | `unit` | `quantity`: `{"code": <unit code>, "dimension": <dimension identifier>, "to_base": <decimal string>}`. `to_base` is the factor converting to the base unit of that dimension; currencies and temperatures have none (each currency and each temperature unit is its own dimension and is not converted). Code, dimension and factor are taken from the unit vocabulary `units@1` ([`03-data-model/10-types-and-units.md`](03-data-model/10-types-and-units.md)) |
| | `precision` | `quantity`, `decimal`: `{"scale": <number of decimal places 0–12>, "rounding": "half_up" \| "half_even"}`. When the field does not declare it, the compiler fills in the default (for currencies the number of digits of the ISO 4217 minor unit, otherwise 6; rounding `half_up`). Rounding after conversion on write, the same-value judgement and the `min` / `max` check all follow it; a literal match compares the original value |
| | `ref` | `{"table": <table ID>, "target": "row" \| "entity"}` |
| | `migrate` | The deterministic conversion this version applies to the field: `{"sql": <expression bound to the table IDs and field IDs of the previous version>}`. In the first version the expression may contain only this field's ID in the previous version and constants; it is evaluated only for items that have a value. Changing the unit within the same dimension does not write `migrate`; it converts from the old unit to the new one ([`03-data-model/07`](03-data-model/07-schema-evolution.md), "How deterministic conversions are replayed") |
| | `backfill` | The value filled in for violating rows when a constraint is tightened: `{"sql": …}` (likewise referencing only this field; evaluated only at positions that have an old value) or `{"const": <value>}` (at positions without an old value only it gives a value; adding a required field and changing optional to required must use this form, whether or not the table has rows). The two forms do not appear together |
| | `from` | The ID of the field in the previous version that this version's field corresponds to (on a rename or a type change). A new field has none |
| Derived table | `rule.id`, `rule.version` | The rule ID and version. The version is increased by 1 when the rule text or the field definitions it depends on change |
| | `rule.rsql` | The allowlist version used when this rule was compiled. The rule is evaluated under it, and replay uses it too. A rule switches to the current allowlist version only when it is recompiled for another reason; a rule that is not touched is always evaluated under its recorded version and is copied unchanged into the `compiled` of later versions. So rules in one `compiled` may stay at different versions, and may differ from the top-level `rsql`. On a switch, the rule version of the affected items is increased by 1. A version the kernel does not recognize: `apply` stops (§1.6) |
| | `rule.sql` | The restricted SQL bound to table IDs and field IDs; the output column names are derived field IDs |
| | `rule.time_dependency` | `none` / `bucketed` / `now` |
| | `rule.depends_on` | Static column-level dependencies |
| | `rule.scope` | The scope of recomputation: `{"kind": "group", "key": [<derived field ID>], "key_from_free_text": <boolean>}` or `{"kind": "tenant"}`. For `group`, `key_from_free_text` is required and means the group key comes from a free-text field |
| Fields of a derived table | `type`, `unit`, `precision` | Inferred and filled in by the compiler |
| | `aliases` | Aliases, same as `aliases` of the table |

- Names, descriptions, aliases and enum values are text written by the schema author and may contain the user's own words; they are not within the cascade of privacy deletion.
- The declaration of re-extraction (`reextract`) is not part of the first version's compilation result; the reserved space is in §10.

---

## 8. The export file

An export is all the events of this tenant, from `seq` 1 (when resuming, from after `after`), in ascending `seq` order. The read record, the control plane and the materialized state are not in it.

- The file is **NDJSON**: one JSON object per line, UTF-8, line terminator `0x0A`. Each line is itself serialized with JCS: a line that is not equal to its own JCS serialization (other whitespace, line terminator, key order, the same key twice) is rejected on import as an unrecognized format. A line is at most 16 MiB (in bytes; far above any single event); an import reports `too_large` (`import_line`) for a longer one.
- **The first line is the manifest**, and each line after it is one event.
- An export file may be wrapped as a whole in an age file (the CLI's optional encryption); the wrapping is not part of the export format, and once unwrapped it is the NDJSON defined in this section.
- An export can be loaded into an empty tenant (import, see §5.2 `tenant.imported`): several resumed files are joined in order and replayed event by event, unchanged.

The manifest:

```json
{"event_format": 1, "events": 43, "exported_at": "2026-11-10T08:00:00.000Z",
 "pending_deletions": "placeholder", "restore_count": 0, "saveslot_export": 1,
 "tenant_id": "tn_…", "upto": 43, "upto_hash": "5b1e…a7"}
```

| Key | Meaning |
|---|---|
| `saveslot_export` | The version of the export file format |
| `tenant_id`, `event_format` | The current tenant ID (the one in the latest `tenant.genesis` or `tenant.imported`); the version of the event format |
| `restore_count` | The tenant's restore count at export time. On import, `restore_count` of `tenant.imported` is this plus 1; when several resumed files are concatenated and imported, it is that of the last segment (the resumed segment is newer) |
| `after` | Present only when resuming: this file contains only events whose `seq` is greater than it. A file with `after` cannot be replayed on its own and must follow the previous segment. For a segment that follows the previous one: if `saveslot_export` or `event_format` is a version the import does not recognize, `unsupported_format` is reported (as for the first segment); for recognized versions, `tenant_id` must equal the first segment's and `restore_count` must not be smaller than the previous one's, otherwise `segment_order` is reported; `pending_deletions` may differ between segments (each block carries its own state). The first segment has at least the genesis event; importing a first segment whose `events` is 0 reports `incomplete` |
| `upto`, `events` | The `seq` of the last event in this file; the number of events in this file (when there is a restore gap, less than the difference between `upto` and the starting point) |
| `upto_hash` | The hash of the event header of event number `upto`, written like `prev_hash` (§2.1). No next event's `prev_hash` vouches for the last event header, so this vouches for it and is checked against it: on import, at the end of each segment, the hash of the segment's last event header is compared (for a segment without events, that of the previous segment's last one); if they differ, `chain_broken` is reported, at position `upto` |
| `exported_at` | The time of the export |
| `pending_deletions` | `placeholder` (default: blocks awaiting deletion within the grace period are replaced by a placeholder) / `included` (explicitly requested by the user session to be included) |

An event line (each line serialized with JCS, keys in lexicographic order: `c` before `h`; the example below is split across lines for readability):

```json
{"c": {"fields/f3/0": {"pending_deletion": 42},
       "literal/f3/0": {"pending_deletion": 42},
       "sources/f3/0": {"pending_deletion": 42},
       "target": {"sum": "c20a…5d",
                  "v": {"cause": "request", "intent": "correct", "op_index": 0, "row": "r_01JC8Z…", "sv": 1, "table": "t1"}}},
 "h": {"actor": "ci_7HQ2…", "at": "2026-11-10T04:41:07.123Z", "op": 25, "prev_hash": "9f2c…e1",
       "seq": 27, "slot": "sl_4KTZ…", "type": "write.base", "v": 1}}
```

| Key | Meaning |
|---|---|
| `h` | The event header object. The reader serializes it again with JCS, and the resulting bytes are the bytes that entered the chain |
| `c` | The content blocks: `path` → the state of the block (one of the three shapes of §3.3). An event without content blocks has no `c` |

The example was exported within the grace period (the deletion was confirmed at 2026-11-10T05:02Z and the export was made three hours later; `upto` of the manifest is 43, and tombstone #44 has not been appended yet): the three blocks of this correction live and die together, and all are placeholders awaiting deletion. After the tombstone is applied, an export shows them as `{"removed_by": 44}`.

Reader verification: for each line, compute the event header hash of `h` and check it against the `prev_hash` of the next line; for each `{"v", "sum"}`, check the checksum. A gap in `seq` must be explained by a `tenant.restored` that follows.

After replaying an export with placeholders, the business state at the end of the log matches the live one (what it looks like after the deletion is written in `deletion.confirmed`); the historical content at the placeholders is not available, and that deletion can no longer be cancelled. On import, tombstones are therefore added immediately for these deletions (§5.9).

---

## 9. What the event header leaves behind

Privacy deletion empties only the content blocks. The event header stays on the chain for good, and in the first version metadata blocks are not deleted either; in addition, several kinds of data blocks have no provenance, or a provenance that is not the sentence being deleted, and are not erased by this deletion either. This section lists what remains after a deletion, why each item remains, and whether it could be made not to remain.

### 9.1 The event header (in the chain, cannot be deleted or changed)

| Field | What can be seen | Why it must be in the event header | If retention is not allowed |
|---|---|---|---|
| `seq`, `prev_hash` | That this event was in the log, and where | Components of the chain | Cannot be moved out: without them there is no chain |
| `v`, `type` | The nature of the operation (a write, a piece of evidence, a confirmation, …). No intent, no table | In replay, the kernel must know how to handle the event without reading its content; an old kernel uses them to decide whether it can continue | Types can be merged more coarsely (for example `write.base` and `source.recorded` into one), at the cost of a new event format version; old events do not change |
| `actor` | Which principal did it | Every event having a person who handled it is a kernel invariant; principal revocation and audit both go by it | Can be moved into a metadata block. Cost: `verify` cannot check "actor is registered" without reading content |
| `at` | When it was recorded | The idempotency window, grace period expiry and recorded time monotonicity all depend on it | Precision can be lowered (to seconds or minutes), a change of notation in a new version |
| `op` | Which events belong to the same operation | When reading by recorded position, an operation must be visible as a whole or invisible as a whole | Can be moved into a metadata block, at the same cost as `actor` |
| `slot` | Which slot it belongs to (an opaque ID, not the name) | When partial replication by slot is done in the future, event headers are replicated in full and need it for filtering | Can be moved into a metadata block; partial replication would then read the metadata block |
| `trigger` | Which kind of background task of the kernel | Involves no user | n/a |
| `node_id`, `restore_*`, `high_water`, `imported_upto` | On which node the tenant was created, how many times it was restored, how far the imported log goes | The identity of events and the explanation of gaps in `seq` | Involves no user content |

### 9.2 Metadata blocks (not in the chain, not deleted in the first version)

| Content | What can be seen | If retention is not allowed |
|---|---|---|
| Table IDs, row or entity IDs (including the row ID list `backfill_rows/<table ID>/<field ID>/<n>` of `schema.switched`) | That a row existed in a table; a row ID is a UUIDv7 and carries a millisecond-level creation time | When a whole row is privacy-deleted, also list all `target` blocks of that row in the position list. **No change to the event header, no change to existing events**; cost: after a whole-row deletion the version table no longer keeps a record of "deleted here", and a read at a point in time within that span cannot see that the row ever existed |
| Intent | Whether this write was an addition, a change, a correction or a revocation | Same as above, deleted together with `target` |
| Referenced source data and the `seq` of writes | Which write referenced which piece of evidence (both only sequence numbers) | Same as above |
| Item kind, cause code, decision | That there was a conflict or a confirmation, and how it was handled afterwards | When the whole row an item targets is deleted, the `target` block is deleted with it |
| Deletion ID, expiry time, position list | That a deletion happened, and which positions it cleared | Cannot be deleted: "a deletion does not come back" is guaranteed by tombstones and position lists |
| Rule version, policy version, `now`, `today` | The versions and the entry time used in the judgement. `today` is the date of the entry time in the slot's time zone; it shows which day the time zone the user set for the slot falls on, and nothing else | Involves no user content |
| The slot scope of a connection (`slots` of `principal.registered`) | Which slots a connection is authorized to access (only opaque IDs) | Involves no user content; the slot name is not here |
| The location and baseline of an external key (`by_external_key` and `key_from` of `ops/<i>/target`, `ops/<i>/baseline`, `request.op_count`) | That a write was located by external key and which row it landed on; from which row a row's external key was transferred; in which operation each field's sync baseline is; how many ops a sync request contained in total (including unchanged, skipped and those that did not enter an event). **The value of the external key is not here**: it is an ordinary data block of the key field and is deleted with the evidence | Handled as with the table ID and row ID entry: when a whole row is privacy-deleted, also list the `ops/<i>/target` and `ops/<i>/baseline` that involve that row in the position list. `op_count` is only a request-level count and is not deleted with any one row |
| Premise declarations and state changes (`ops/<i>/premises/<j>`, `ops/<i>/premise_covers`, `ops/<i>/premises_cleared`, `premise.changed`) | That a write declared as its premise the value of a given row of a given table, a given field number, at a given version; that a write cleared premises; in which operation a declaration changed state. The premise's value, the value of the depended-on row and the valid time of the declaration cannot be seen (`premise_valid` is a data block) | Same as above: when a depended-on row is privacy-deleted as a whole row, also list its declaration blocks in the position list; no change to the event header |
| Import records (`tenant` and `export` of `tenant.imported`) | From which tenant ID this log was imported, when it was exported, whether it contained content awaiting deletion | Involves no user content |

### 9.3 What cannot be inferred

After a deletion expires, the following cannot be inferred from what remains: any value the deleted content gave, the original text of evidence, the valid time interval that came from the deleted content (including endpoints derived from it: the default end point at which another write stopped on it, and the intervals copied into reverts and deletion results, see §3.5), the name and value of the field that was changed (**field IDs are retained**: they appear in the path of data blocks, and paths remain in the position list; they also appear in several metadata blocks: the list of no-op fields `ops/<i>/noop`, the list of fields that explicitly point to evidence `ops/<i>/explicit`, `named_fields`, the keys of `ops/<i>/baseline`, the `fields` of premise declarations and the entries of `premise_covers`, the entries of the revert record `revert`, the `unit` of an item's `target`, the `items` of `kept_effective`. So it can be seen "which write, which item, which premise involves which field number", but not the field name and value), table names and field names, group key values, the value of an external key, the hash or length of the deleted content. **There is one exception: the request keys and explicit idempotency key fingerprints of other requests, see §9.5.**

In addition, the number of events of each kind within one operation itself shows a few things: how many pieces of evidence this write carried, how many ops there were, how many items it led to, how many derived rows changed, whether any premise changed state. The number of events is determined by user content but does not contain the content itself. An op that did not enter an event when writing by external key leaves no block and is only counted in `op_count`; a request in which all ops did not enter events leaves nothing in the log.

Removing the field IDs as well would mean replacing the field IDs in the path and in these metadata blocks with meaningless sequence numbers; that is a new event format version, and the first version does not do it.

### 9.4 Blocks not erased by this deletion

The following are data blocks (containing text written by the user, or values computed from user content), but they have no provenance, or their provenance is not the deleted sentence, so one privacy deletion cannot reach them. The `not_deleted` of the deletion preview lists truthfully those among them that relate to this deletion.

| Content | Where | Why it is not erased | How to remove it |
|---|---|---|---|
| The name of a connection | `name` of `principal.registered` / `principal.renamed` | A name the user chose, not derived from source data | Renaming a connection only appends a new name; erasing the old name requires a new kind of deletion, which the first version does not have |
| Text in schema drafts and compilation results (table names, field names, descriptions, aliases, enum values, constants in `migrate` and `backfill`) | The blocks of `schema.draft_submitted` and `schema.compiled` (§5.5, §7) | Text written by the schema author, with no provenance recorded. The constants of `backfill`, once filled into business tables and version tables by a switch, are likewise not erased, and the write-back items and deletion results that reference them later also copy this value | Same as above; in the first version the only way is not to write the user's own words in a schema |
| The task identifier, request key, explicit idempotency key and fingerprint self-reported by operations that have no source data | `task`, `request_key`, `idempotency` of `deletion.confirmed`, `deletion.cancelled`, `schema.draft_submitted`, and of an `item.resolved` that carries neither evidence nor a `note` and triggers no write (§5.1) | These operations have no evidence, so the three blocks have no provenance along which to delete | A task identifier must not contain user content (stated in the tool description); request keys can be cleared by a newly added cleanup action once the idempotency window has passed, which the first version does not do |
| Request keys and idempotency key fingerprints of other requests | See §9.5 | They are deleted only with the evidence of their own request | See §9.5 |
| Content repeated in another sentence | `text` etc. of another `source.recorded` | The user said the same content in another sentence; that is another piece of source data and is not within the scope of this deletion | List that source data as a deletion target as well |

The "existence" item `existence/<k>` is a metadata block (only a state and a range, no content) and remains as in §9.2: it can be seen that a row was revoked.

### 9.5 Known limit: the request key is a hash that includes content

- The **request key** (`request_key`) is computed from "connection + task + normalized request"; the **fingerprint of an explicit idempotency key** (`idempotency.fingerprint`) is a hash of the request content. Both are computed over the **original request body**, and the values of no-op fields passed back unchanged in the request also take part in the computation.
- Their provenance is **this request's evidence**: if any piece of this request's evidence is privacy-deleted, they are erased with it. They are **not** erased with "the old source whose value the no-op field has the same value as".
- So there is this situation: the user said a sentence A (recording the value X); later another request passed X back unchanged and carried the evidence of another sentence B. After A is privacy-deleted, X cannot be found in any value, original text or interval in the whole store; but the request key of that request is still there, and it is a hash containing X.
- **Requests that write by external key are also within this limit**, in two cases:
  - **A request that contains ordinary ops** records a request key as usual, computed over the original request body, and the content of the external-key ops in it (including the records handed in by ops that are `unchanged`, `skipped` or did not enter events) goes into this hash as well. They are deleted only with this request's own evidence: after a record that came in by sync is privacy-deleted, if the next sync within the grace period still hands it in, and in one request together with ordinary ops, its content goes into a new request key. A connector avoids this by sending external-key ops and ordinary ops in separate requests.
  - **A connector's explicit idempotency key**: when the caller gave `idempotency_key` and the request produced events, the fingerprint is computed over the whole request body, including the content of ops that did not enter events, with the same rule as above. A connector is already idempotent through external keys, and generally need not give an explicit idempotency key as well.
  - A request that contains only external-key ops records no request key (§5.1) and has no such problem; a request in which all ops did not enter events leaves nothing.
- **What can be seen**: someone who obtains the storage of this tenant and already knows all the rest of the content of that request can recompute the hash with a guessed X and compare. The hash itself does not yield X.
- **Why it remains**: idempotency judgement relies on the request key (resending a write that was just deleted within the grace period must not write it again); excluding no-op fields from the request key would make two requests whose passed-back values differ be judged to be the same request. Apart from this, the log keeps no value of any no-op field (§5.7).
- **If retention is not allowed**: once the idempotency window has passed (10 minutes computed by the server, 24 hours for an explicit idempotency key), the request key is no longer useful, and a new cleanup action could be added to clear the expired `request_key` and `idempotency` blocks; this is a new event type and does not change existing events. The first version does not do it: they are deleted only with the evidence.

### 9.6 To do: legal confirmation

> **To do (before server mode goes live; does not block local mode and development)**: send this section to legal, and state in which regions server mode is planned to be offered. Ask legal to answer item by item, "may be retained / may not be retained":
>
> 1. The event header of §9.1: after deletion, it can still be seen that an operation of some nature took place at some time, by which connection, and belonging to which slot.
> 2. The metadata blocks of §9.2: that a row existed in some table (the row ID carries a millisecond-level creation time), the intent of a write, which field number it involved, that there was a conflict and how it was handled.
> 3. The premise declarations of §9.2: that a write declared as its premise the value of a given row of a given table, a given field number, at a given version, and in which operation this declaration changed state; they remain after the depended-on row or the premise target is privacy-deleted.
> 4. The request keys and explicit idempotency key fingerprints of §9.5: hashes computed from the request content, deleted only with this request's evidence; in a connector's mixed requests, the content of records that did not enter events is in them too.
> 5. `request.op_count` of §9.2: after deletion, it can still be seen how many records a sync request handed in (including unchanged and skipped ones).
> 6. The kinds of text in §9.4: the name of a connection, text in schemas, content repeated in another sentence.
> 7. How deletion is carried out: the relation between the 24-hour grace period and the statutory deletion deadline; how the time of physical erasure and the backup retention period are communicated to users.
>
> For each item answered "may not be retained", the corresponding change and its cost are in the "If retention is not allowed" column of each subsection. Only "this event was in the log" (`seq`, `prev_hash`) cannot be removed.

---

## 10. Reserved space and evolution

The first version produces none of the following. For each item, what is added when it comes in later is stated; **none of them requires rewriting existing events**. Under the rule in §1.6, for any event that uses a path, key or enumeration value newly added in the table below, the `v` of that event type is increased by one; events that do not use them stay as they are.

| Capability | What is added later |
|---|---|
| System ruling (a candidate of higher level takes effect automatically) | `ruling` is added to `cause` of `write.base`, `applied_by_rule` to `intent`, `applied_by_rule` to `status` of field items (takes effect by rule); `displaced_by_rule` is added to `cause` of candidates; `ruling` to `trigger`; `by_rank` to `effective_value_rule` of `slot.policy_set` (rulings by the rank of the source level). The inputs it needs are already recorded in the first version: `literal/*`, `stated_at`, the two version numbers of `ctx`, `merge_base_op`, `ver.basis`, `writer_had_read`, `seen_valid` |
| Rejudgement (making old items use a new rule or a new policy) | A new event type `judge.rejudged` (a head event, `trigger: "rejudge"`): lists the rejudged writes and items, the new state in effect, the new two version numbers. Before the kernel retires an old rule version, it must first rejudge the writes that still use it |
| Evidence deletion (delete only the original text, the value stays) | `evidence` is added to `kind` of `deletion.confirmed`; `item.superseded` starts using `evidence_deleted` in `reason`. The position list contains only the original-text blocks of source data |
| Row-level privacy deletion | An optional `rows` is added to `target` of `deletion.confirmed`; the computation and event shapes do not change |
| Extraction jobs (re-extraction migrations, extraction of new fields) | New event types `schema.migration_result` (the translated result is cut into blocks by `items/<work item>/<field ID>`, with all the original text attached to the work item as provenance) and `schema.migration_abandoned` (not produced in the first version: a deterministic migration has no way out by manual abandonment); an optional block `pending_extraction` is added to `schema.switched`; the item kind `migration_diff` and its decisions; `reextract` is added to fields of `compiled`; an optional block `reextract/<k>` is added to `deletion.confirmed`; the data flag `pending_extraction` |
| Large write jobs | New event types `job.accepted` (the request content cut into blocks by op), `job.completed`, `job.failed`; `job` is added to `trigger`; the data flag `stale` |
| Cleanup of retired tables | A new event type `schema.retired_purged` (`actor: "system"`, `trigger: "retired_purge"`) that lists the physical tables cleaned up |
| Slot policy changes, high impact specified by policy | `slot.policy_set` is produced by a user session as a head event (it has no `op` field and carries `ctx`, a new shape, `v` increased by one); `high_impact` and `user_session_only` start to have content; the cause code `policy_high_impact` |
| Scope changes | A new event type `principal.scope_changed`; the slot scope changes together with it and no separate event is added |
| The external authority level (`external_authority`) | An optional key is added to the `principal` block of `principal.registered`, recording whether this connection has been granted the right to declare this level (granting can only be done by a user session at issuance); the reserved value `external_authority` of `target.level` of source data is enabled |
| Premises on derived rows | An optional key `partition` is added to the target of `ops/<i>/premises/<j>`; `premise.changed` is triggered by derived writes |
| The official schema (`extends` / `compatibility`) | An optional top-level key `extends` is added to `compiled`: `{"id", "version", "hash"}` (records only the identifier, the version and the content hash of the official definition; the full text of the definition is already in `tables`); an optional key `official` is added to tables and fields: `{"id"}` (a stable handle given by the official schema; field IDs are still assigned by saveslot); no key is reserved for `compatibility` for now, and it is added together with the upgrade process; the change code `declare_extends` is added (class `metadata`). `v` and `compiler` of a `schema.compiled` that uses these keys are increased by one. A draft that contains `extends` / `compatibility` is rejected as a whole with `not_in_this_version` until they are implemented |
| `elicitation` confirmation | The reserved value `elicitation` of `via` of `item.resolved` is enabled; `v` of an `item.resolved` that uses it is increased by one |
| Encryption | Each content block in storage has a nullable key identifier; changing the checksum to be computed over the ciphertext is a change of the storage format, not a change of the event format |
| Signed checkpoints, hash trees | New event types that periodically commit to a range of event headers; old events are not appended to |
| Revert to a given version (`revert: {to, fields}`) | Optional keys `to_op` and `fields` are added to `ops/<i>/revert` of `write.head`; the shape of `write.base` does not change (the value source is still `carried`) |
| Correcting an entity's key (`rekey`) | A new write intent or an optional key of `ops/<i>/target`, together with its own `write.base` shape; in the first version keys cannot be changed, and a wrong key is fixed by revoking and rewriting |
| `migrate` / `backfill` that reference several fields | `migrate` / `backfill` of fields in `compiled` are allowed to contain the IDs of other fields, and a new notation for "contributions produced by a conversion" is added (the item that an old write that wrote only the input field produces on the new field); this is a replay rule under a new version: a `schema.compiled` with such a definition (`v` and `compiler` both increased by one) and the `schema.switched` that follows (`v` increased by one); old compile and switch events replay under the old rule |
| Conversion between temperature units | An optional key `offset` (a decimal string) is added to `unit` in `compiled`; existing definitions do not have it, and their meaning does not change |
| Custom units outside the vocabulary | When the `code` of `unit` in `compiled` takes a value outside the vocabulary, a complete definition comes with it; this belongs to a new unit vocabulary version |

**Multiple nodes** (local + cloud, multiple devices, offline writes):

- For events produced by other nodes and accepted by the primary node, the event header gains an optional field `origin`: `{"node": <node_id>, "seq": <the sequence number on that node>}`. For an event without `origin`, the identity is derived by the convention in §2.2, so existing events need no change.
- A new event type `sync.primary_changed` (primary node switch) and other sync control events; the item kind `sync_rejected`.
- Event headers contain only opaque IDs and carry `slot`; in partial replication by slot, event headers and tombstones are replicated in full, and content blocks are filtered by slot.

---

## 11. Undecided items in this document

None. The several items left over when the format was written have all been settled: the unit vocabulary, precision and rounding are in [`03-data-model/10-types-and-units.md`](03-data-model/10-types-and-units.md); the default policy and the values of `auto_apply` are in §5.4; the prefixes of identifiers are in §1.4. Undecided items that appear later are registered in [`08-open-questions.md`](08-open-questions.md).
