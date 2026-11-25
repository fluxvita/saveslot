# saveslot · Data-layer mechanisms · 01 Data layers and objects

> Translated from docs/zh-CN/spec/03-data-model/01-objects.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

> Part of the data-layer mechanisms; for the contents see [`README.md`](README.md). A section quoted in the text with "…" may be in another file of the same directory; look it up in the contents.

## Data layers

```
Upper layer  ── sees only modelled data
Modelled data   ← dynamic schema, can be recomputed from source data
Source data log ← append-only, organized by slot
```

- **The source data log**: conversation fragments, tool results, imports from external sources, user corrections and the like; append-only, never modified.
  Each source belongs to exactly one **slot** (see below).
- **Modelled data**: extracted and cleaned from source data according to the schema; it is the materialized result above the log.
- Key corollaries:
  - Modelled data must be **recomputable from source data**: when the schema changes, old data is migrated along with it.
  - Every piece of modelled data **can be traced to the source data it came from** (the authority of provenance lies here).
  - **A user correction is a new piece of source data**, not a direct change to the upper layer; otherwise a recomputation would overwrite the correction.
  - The upper layer sees only modelled data, but can trace to source data subject to permission (at least quote the original text).

| Reference | Counterpart in saveslot |
|---|---|
| MySQL redo log | The source data log: replaying it rebuilds the modelled data |
| undo log / multiple versions | Reads as of an instant ("which version did that task read at the time"), revert |
| Agent session log | A kind of source data: conversations and tool results, append-only per session |
| Super-agent thread | The timeline of a thing: any row can be traced to how it became what it is now |
| Chain recall | From the current state back along the timeline to the original evidence; it can be found again months later |
| git | Current state = the checkout; every step has an author and a provenance (like blame); history is evidence |

## The slot and the timeline of a thing

The slot and the timeline of a thing are two different levels:

| Concept | Granularity | Example | What it carries |
|---|---|---|---|
| **slot** | Coarse: a group of related tables + their source data | health, bookkeeping, the indie game Lumen | The unit of schema versions (one "current version pointer" per slot); the unit of time zone and slot policy; the scope of one privacy deletion; the smallest unit of a credential's authorization scope (a connection can be limited to some slots; data permissions at table and field level come later). Owning node, replication subscription (multiple nodes, later), export by slot and deletion of a whole slot are not done in the first version (see the positioning document, "Later plans"; what the first version exports is the whole tenant). It will also be the unit of keys when encryption is added in the future |
| **The timeline of a thing** | Fine: one concrete thing being tracked (granularity in the first version = one row or one entity; a thing that spans tables is pieced together by the agent through several queries) | this month's promotion budget, the run on 11-03 | Tracing how it became what it is now. In storage it is one row of a base table or one entity of a state table and is **not stored separately as an object**: it is found through the row ID, the log and the provenance tables |

- **Each source belongs to exactly one slot.** When one sentence touches two slots ("ran 5 km today, spent 600 on running shoes"), the agent splits it into two writes, each with its own evidence fragment.
- **The first version forbids derivation rules and `ref` across slots** (version ownership, migration impact and partial replication cannot be stated clearly); when needed, the agent queries the two slots separately and pieces the results together, or uses one read-only `sql` to join the tables of two slots within the visible range (see ["Restricted SQL"](11-restricted-sql.md)).

## Identifiers and objects

### Levels

- **Principals**: user (in the first version = tenant) → node (device credential, registered by the user) → connection (agent credential; the ID is globally unique; registration, renaming and revocation are all log events; the scope and the slot range are fixed at issuance and cannot be changed in the first version: to change them, revoke the connection and issue a new one). **The first version has a single node**: a connection is registered by a user session (architecture §5); with multiple nodes (later) it will instead be issued by a node, its ID will carry a node prefix, and it will propagate with sync.
- **The reserved principal `system`**: the events the kernel generates itself are recorded under it; it is registered together with the user principal by the genesis event (architecture K2).
- **Resources**: user → slot → table → field.
- **Each user has one log, one set of sequence numbers, one serial lock and one independent storage**: locally one PGlite data directory; hosted and multi-user self-hosted deployments use one database per user in the same cluster;
  the saveslot kernel depends only on "open the storage of a given user", and table names carry no user prefix (see the positioning document, "Technology choices");
  a slot is a partition label inside the log, not a separate log.
- **The first version does not support slots shared by several people** (household bookkeeping, team projects). The direction for later: a shared slot = one independent tenant + member authorization;
  therefore the interface does not hard-wire a slot under a user name; internal references always use `slot_id`, and the interface may use the slot name (unique within a user, not distinguishing ASCII case).
- **After an empty slot is removed** (contract `slots.remove`): the name can be reused, while `slot_id` and its table numbers are not used again. A slot created later with the same name is another slot (another `slot_id`), and the slot range of an old connection and the read records do not point to it; therefore removal goes only by `slot_id`, not by name.

### Numbering: one log, one set of sequence numbers

**One log per tenant** (in the first version tenant = user; a local single user is one tenant). Source data, every write, derived refreshes, every change of schema, every step of pending items and of deletion, slot policy changes and the registration of principals are all events in this log; which event types exist is as in the event table of [`../02-architecture.md`](../02-architecture.md) §3. Read records **are not in this log** (they have their own retention period and are cleaned on schedule without touching the chain).

**Tenant genesis**: the first event of the log, with `prev_hash` a fixed constant; its content is the tenant ID, the storage format version, the event format version, and the registration of the user principal and of the reserved principal `system`.
Later principals (connections) are registered by user sessions, so "every event's actor was registered in this tenant" (architecture K2) holds from the first event on.

**The log is the only source of truth**: all other state in storage is either computed deterministically from the log through `apply` (business tables, version tables, derived tables, the current state of items, ...),
or is local runtime state that is listed explicitly, with what is lost if it is lost. The classified list (including the complete list of local runtime state) is as in [`../02-architecture.md`](../02-architecture.md) §3, "The log is the only source of truth".

| Number | What it is | Assigned by | Notes |
|---|---|---|---|
| `seq` | The position of an event in the log | primary node | Monotonic per tenant, **not reused where possible** (after a backup is restored, numbering continues after the high-water mark, and the gap is explained by a "restore" event; the cases in which a number can still be used again, and the restore count, are under "The deletion register"); **it is at the same time** the change_id, the log_pos and the position on the event-header chain, not a separate set; the externally visible recorded time uses the operation number (see below) |
| Write number / operation number | The externally visible unique sequence number of an operation | saveslot | See "Write number and operation number" below |
| Event identity | The permanent identity of an event across nodes | — | In the first version the event header has no `event_id`: the genesis event and the restore event each carry a `node_id`, and the event identity = (the `node_id` of the latest genesis or restore event, `seq`). With multiple nodes (later), events written offline additionally have an `event_id`, see "Sync protocol" |
| `slot_id` / `table_id` / `field_id` | slot, table, field | saveslot | Stable, does not change on rename |
| `schema_version` | The schema version of a slot | saveslot | One increasing integer per slot; the version number in the physical table name is this one |
| `row_id` | The identity of a business row | saveslot (generated at insert, UUIDv7) | Returned to the writer after a successful insert; unchanged by migration |
| `entity_id` | The tracked entity in a state table | saveslot (generated on first write) | The agent reads and writes state tables by entity; interval segments are an internal implementation |
| The version mark `ver` | The token of the current version of a row / entity | saveslot | Returned on read, passed back unchanged on write. See "The version mark" below |
| Connection ID | Which agent on which device | saveslot (issued when the connection is made) | See "Connection identity" |
| `node_id`, `primary_epoch` | Node, term of the primary node | node / primary node | See "Sync protocol" |

#### Write number and operation number

One write request, one write triggered by `resolve`, one deletion confirmation and one deletion cancellation each occupy several consecutive `seq` values in the log. **Each operation has one head event, and its `seq` is the operation number of that operation**; the head event of a write is the logical write head, and its operation number is also called the **write number** (see "The write request · The events that make up one write").

- **Externally only the operation number is used**: the `seq` of a receipt, the sequence number inside `ver`, the #n of `timeline`, the n of `undo`, `revert.to`, `since` / `until` of `changes`, `as_of`, the recorded-time intervals of the version table.
- The `seq` of the other events inside an operation (source data, the base writes of each row, items, derived writes) is not exposed.
- This way an operation is a single instant in recorded time: a read by `as_of` never sees a half-written state (see "Time · Queries").

#### The version mark `ver`

- **Encoding**: (the operation number of the latest change to the current state of this row / entity, the tenant's restore count), written `v57.0`. More precisely, this operation number is that of **the latest version in the version table whose intent is not `schema_switch`**: the value filled in by the constant `backfill` at a schema switch is one version in the version table but does not change `ver`. The row / entity is given separately by the caller and is not repeated inside the token. The restore count has the initial value 0 and increases by 1 each time a backup is restored (see "The deletion register").
- A token whose operation number is not an operation on this row / entity reports `invalid_argument`.
- The historical version that `history` returns with `as_of` is written `h41.0` and cannot be used for writes. It takes the same number (the latest version in the version table at that instant whose intent is not `schema_switch`), so the values read at two instants before and after a switch may differ while the `h…` is the same.
- With multiple nodes (later) the encoding is the event identity.

| What changes `ver` | What does not |
|---|---|
| The part that **has taken effect** within an addition, change, correction, revoke or revert | A write that became a candidate or went to awaiting confirmation (the value in effect was not changed) |
| A write triggered by `resolve` (confirm, take a candidate, take the previous value (`take_previous`)) | Corroboration with the same value (only adds a source), a no-op |
| System ruling (later) | A derived refresh, a schema migration (including values filled in by the constant `backfill` at a switch: the version table gets one more version with the intent `schema_switch`, and the `ver` of the row does not change) |
| A deletion confirmation or a cancellation of a deletion that changed this row / entity: it encodes the operation number of this deletion confirmation or cancellation | Renumbering after an offline event is accepted by the primary node (multiple nodes, later) |

#### How identifiers are written

Identifiers are all opaque strings assigned by saveslot; they contain no readable name, and a deleted one is not reused. The random part is written in Crockford Base32.

**How identifiers are written in examples in the documents**: written as "prefix + the first few characters + `…`" (`r_01JC8Z…`, `pi_7C2E…`, `sl_4KTZ…`), with characters taken from Crockford Base32 (digits and uppercase letters, without I, L, O, U); real identifiers have the full length given in the table below. Only to tell apart several sources or items within one passage of explanation, short labels are used (`s_1`, `s_R1`, `s_lunch_1`, `pi_2`); they are not how real identifiers are written. Item versions, deletion confirmation handles and paging cursors are opaque tokens (see the second table below); in examples they likewise end with `…` and are not limited by the character set.

| Identifier | Prefix | Unique within | How it is generated |
|---|---|---|---|
| Tenant | `tn_` | Global | 128-bit random number, 26 characters |
| User principal | `u_` | Global | Same as above |
| Connection | `ci_` | Global | Same as above |
| Node | `n_` | Global | Same as above |
| Reserved principal | `system` | — | Fixed value |
| slot | `sl_` | Within the tenant | 80-bit random number, 16 characters |
| Source | `s_` | Within the tenant | Same as above |
| Pending item (the deletion ID is the same one) | `pi_` | Within the tenant | Same as above |
| Schema draft, migration | `d_`, `m_` | Within the tenant | Same as above |
| `partition_id` of a derived row | `p_` | Within the tenant | Same as above |
| A restore, a read | `rs_`, `rd_` | Within the tenant | Same as above |
| Row, entity | `r_`, `e_` | Within the tenant | The 128 bits of a UUIDv7 written as 26 characters; ordered by time, carrying the creation time to the millisecond |
| Table, rule | `t<n>`, `r<n>` | Within the tenant | An increasing short ID: `n` is a decimal integer counting from 1, without leading zeros, at most 9 digits (the physical table name is built from it and must stay within the length of a database identifier) |
| Field | `f<n>` | Within the table | An increasing short ID, `n` written as above |

Tokens that are not identifiers but also have a fixed form:

| Token | Form | Notes |
|---|---|---|
| Version mark | `v<operation number>.<restore count>`; historical version `h…` | See above |
| Item version | `iv_…` | Opaque, see "Item ID and item version" |
| Deletion confirmation handle, paging cursor | `dc_…`; opaque | Signed by the service layer, see architecture §5 |
| Connection token | `slt_…` | A secret, not an identifier; only its hash is stored in the control plane, and it does not enter the log |

#### Terms

A few words used repeatedly in the rules, each defined in one place:

| Term | In one sentence | Defined in |
|---|---|---|
| Write number / operation number | The externally visible unique sequence number of an operation | This section |
| The version seen, the interval seen | The version that the `ver` passed back by a write points to; the interval of the write as resolved against that version | "Conflict handling · Conflict criteria" |
| Conflict unit | The smallest unit of conflict judgement and of items: one field or one field group | "Conflict handling · Conflict criteria" |
| Merge base | The earliest of the versions seen by the candidates of a conflict item | "Pending items · Contents of a conflict item" |
| Stop point | The valid-time instant at which a write with a default end point stops | "Time · State of a state table" |
| Corroboration endpoint | The stop point left by a same-value write that points explicitly to evidence | "Time · Writing with the same value" |
| Interval without a value | A stretch of valid time during which an entity of a state table has no value | "Time · Intervals without a value" |
| Contribution, corroboration, no-op | The value that a write gives to a field together with its value source; the two cases in which the write has the same value as the version seen | "Deletion · Provenance" |
| Literal match | The value written appears literally in the original text of the evidence | "Source level" |
| Rule version, policy version | The semantic version of mechanical judgement; the version of the slot policy | "The write request · Rule version and policy version" |
| Premise | The values already read, on which a write declares that it depends (op parameter `premises`). When a premise changes, saveslot puts a `premise_changed` flag on the rows that depend on it | "The premises of a write" |
| Declaration | One premise: the target row or entity, optionally fields, the version at the time it was read, and for state tables the range of valid time | "The premises of a write" |
| Restate, clear | An `update` without `set` and with a non-empty `premises`: the value is unchanged and only the premises are updated; an `update` with `premises: []`: removes the premise declarations of this row | "The premises of a write" |
| Origin item | The contribution that gives the current value of a field (a carried one is followed along the carried references to its end), plus the corroboration items that still count (corroboration with the same value as the current value, not reverted, and, on state tables, whose interval intersects this cell; if the value goes elsewhere and comes back, earlier corroboration still counts: corroboration proves this value, not that it did not change during that time); the premise declarations hang on it | "The premises of a write" |
| External key | The `external_key` declared on event tables and timeless tables: the identifier of a record in the source system; a write by it updates if the record exists and adds if it does not | "Writing by external key" |
| Sync contribution, sync baseline | The contribution that a write by external key gives to a field; the value handed over last time, taken per field (the baseline value), and the version seen (the baseline position) | "Conflict handling · Conflict criteria" |
| Never written | No `write.base` in the log has this table as its target; the structure of such a table can be changed | "Schema version evolution · Kinds of change" |

### Row identity

- **Base tables**: `row_id` is generated and returned by saveslot at insert; the agent later changes this row by `row_id`.
- **State tables**: the identity exposed is `entity_id`; a write is expressed as "entity + valid interval", and the interval segments cut out are managed by saveslot and not exposed; the version mark is given per entity.
  The schema may declare an optional natural key `entity_key` for a table (such as the category of a budget); when the agent does not know `entity_id`, it can locate the entity by natural key (see "Schema document format").
- **External key**: event tables and timeless tables may declare `external_key` (the identifier of the record in the source system, such as `["origin", "external_id"]`), unique within the table. In a write by external key saveslot does the locating: it updates if the row exists and adds if it does not; the located or newly assigned `row_id` is recorded in the event, and replay does not locate again. The identity of a row is still `row_id`; the external key is only another way of finding it; the key fields can be given only through `external_key` and cannot be changed afterwards. A row without an external key can have one added once (see "Writing by external key"). State tables do not offer external keys; writes by natural key use `entity_key`.
- **Derived tables**: row identity = an opaque `partition_id` (unique within a rule), read-only; one partition is exactly one row (the first version requires the outermost layer of a rule to be a grouped aggregate or an overall aggregate, see "Derivation rules and derived caches"). Version = the operation number of the operation that most recently refreshed it; a derived row computed at read time (a rule that depends on "now") has no version, and the read result carries no `ver` but the annotation `computed_at_read`. Such derived tables also have a physical table that is always empty, and reads bypass it according to the time dependence of the rule (`time_dependency` is `now`) (see "The physical approach" in "Schema version evolution (continued)").
  **Grouping key values (such as the `week_start` of W45, or the category name of `GROUP BY category`) are computed from user content and are themselves content**: the mapping "grouping key value → `partition_id`" is recorded in the content of the derived write, and the event header, `derived_reads`, the count tables and read_log use only `partition_id`;
  the interface can still locate a derived row by grouping key, and saveslot turns it into `partition_id` through the mapping. When a group becomes empty because of deletion, the mapping is cleared with it; if the same grouping key gets rows again within the grace period, the original `partition_id` is reused and the mapping is registered again in the new derived write (see "Deletion · Content derived from source data"). When a group becomes empty because of a revoke (or because a row is changed into another group) and the same grouping key later gets rows again, the original `partition_id` is likewise reused; the mapping was not cleared and need not be registered again. This way the read records that read this group still connect.
- **Migration**: `row_id` and `entity_id` stay unchanged; a migration changes the table structure and the values, not the identity.

### What a slot contains

- A group of tables (base tables + derived tables), the source data of those tables, the schema versions of the slot and the current version pointer, the pending items inside the slot, and the slot-level policy.
- The contents of the **slot policy**:

  | Item | What it is | Default policy (written when the slot is created) |
  |---|---|---|
  | Schema changes that take effect automatically (`auto_apply`) | Which kinds of change take effect without confirmation | All eight kinds on: adding a base table (`add_table`), adding a derived table (`add_derived_table`), adding an optional field (`add_optional_field`), changing only descriptions and aliases (`description`), renaming something nobody uses (`rename_unused`), loosening a constraint (`loosen_constraint`), changing the criteria for suspected duplicates (`duplicate_keys`), changing the structure of a table that nobody uses and that was never written (`restructure_unused`) (the definition of each kind is in "Schema version evolution · Kinds of change") |
  | The rule for the value in effect during a conflict | In the first version only "keep the current value" | Keep the current value |
  | Rank table | The order of source levels, used by system ruling (later) | User stated > agent inferred > no match; recorded only, not used |
  | Extra high-impact list | Writes on tables / fields that the policy names count as high-impact (later) | Empty |
  | Handling that accepts only confirmation from a user session | A reserved place: which handling of which kind of item cannot be confirmed by an agent (later) | Empty |

  Each policy change is one "slot policy change" event and adds 1 to the policy version (see "The write request · Rule version and policy version"). The first version has no operation that changes the policy, so each slot has only the one written when the slot was created.
  **The policy of a slot is the full text written in that event** and does not follow the default policy in the kernel: kinds added to the default policy later take effect only for slots created afterwards; a kind missing from the policy of an existing slot (for example no `restructure_unused`) means "needs confirmation" for that slot. Adding, removing or replacing external keys has no kind of its own: on a table that has been written it needs confirmation, and on a table that was never written it falls under `restructure_unused`.
- **Creating a slot**: the v1 draft takes effect automatically once it compiles (the slot has no data yet, so there is nothing to break); at the same time the full text of the default policy is written as one "slot policy change" event; the policy is not a constant in code.
- **Each table belongs to exactly one slot**; table names are unique within a slot (not distinguishing ASCII case), and the interface accepts the qualified name `health.runs`; when the table name is not duplicated within the visible range of this call, the table name alone can be written and the slot is inferred from the table (tables outside the range do not take part, so that a request writing only `runs` does not report ambiguity because another `runs` exists outside the range; see "Reads · Visible scope"). **One write involves only one slot** (atomicity relies on one pointer lock); things that span slots are split into several writes.

### What a source is

- **A source = a fragment of evidence attached to one write**, belonging to one slot; a write may carry several fragments (within the same slot), and a single fragment has a size limit (initial values below).
- The whole conversation is not collected, only the fragments relevant to this write (consistent with "the conversation is not saved in full").
- **Each fragment of evidence has a kind**: the user's own words / the agent's paraphrase or inference / a tool result / an external file reference; when no evidence is given, saveslot stores an "API call". **"Correction" is not a kind of evidence**: it is an annotation brought out when the source is read, derived from the intent of the write that references this evidence, and is not stored separately. A write can say which fragments of evidence each op and each field references, and the field-level provenance of a base write is derived from that (see "Deletion · Provenance"). A fragment of evidence may carry an optional statement time (see "Source level").
- **Evidence can reference an existing source** (same slot, evidence kind `source_ref`, see the contract, "Evidence"): when corroborating, the original is attached directly and not copied, otherwise the copy would remain when the user deletes the original words.
- **The first version stores no files**: when the origin is a file (text, media), the source is an **external file reference**: file name, type, size, content hash, and an optional origin location and text excerpt; saveslot does not keep the file itself; on deletion it states honestly that "the external file is not kept by saveslot". When file storage (content blobs) is added later, the files are uploaded afterwards by content hash and the structure is unchanged (the positioning document, "Later plans").
- Size limits (initial values): a single fragment of evidence 32 KB, a single request 256 KB.
- When no evidence is given, the request itself is stored as source data (type "API call", one for each op that left something in an event and containing only that op; an op that did not enter the events is not stored, see "Invariant: every write has source data").
- When one sentence involves two slots it is split into two sources; when the user wants to "delete this sentence", each of the two slots deletes its own.

### Pending items: one unified object

Awaiting confirmation, conflicts, check mismatches and the like are unified as **one object**, kept persistently in saveslot and belonging to a slot, and handled by a person (in the first version through the CLI, in the app later) or by an agent (MCP); "tentative" and "disputed" are flags on data, not items.
**This section is the authoritative definition of the item mechanism and of the execution semantics of each decision**; the contract ([`../04-contract.md`](../04-contract.md), "Pending items") gives only the kind × decision × whether it takes effect × required scope on the interface, and refers to this section.

| Kind | Interface kind | Arises from | How it is resolved |
|---|---|---|---|
| Awaiting confirmation (proposal not in effect) | `awaiting_confirmation`, `schema_change`, `migration_diff` | A high-impact write (the list is in "Time · High-impact writes"), a schema change, a migration that needs re-extraction from old fields (generated as soon as the migration starts) | Confirm / reject; a migration additionally has "treat the unhandled differences as rejected and switch" and "abandon the migration" |
| Flagged (in effect) | `flagged` | A suspected duplicate (`duplicate_keys`). Statistical anomalies produce no item in the first version (definition undecided, see architecture §14) | Keep / revoke |
| Conflict | `conflict` | On write, the version seen does not match, and the write is recorded as a candidate | Keep the value in effect / take a candidate / take the previous value |
| Deletion grace period | `deletion` | Derived from the deletion lifecycle (deletion confirmed → cancelled or expired) | Cancel |
| Check mismatch | (none on the interface yet) | Background evidence checking: the value does not match the evidence | Accept / correct / ignore (**not produced in the first version**: there is no model-based checking; the result of literal match for each fragment is only hit, miss or not applicable, with no "mismatch") |

With multiple nodes, "sync rejected" is covered in "Sync protocol": the first version does not produce it, and it is not in the contract.

**The fields of an item**: item ID, item version, kind, slot, target, current value and proposed value, effect, reason, initiator, state (pending / resolved / superseded), result of the resolution; conflict and awaiting-confirmation items also record the rule version and the policy version at the time they arose.

- **The arising, merging, refreshing, superseding and resolving of an item are all log events**; the resolution event carries a confirmation record (the resolver, who is the user, through which credential, the operation number; **the hash of the confirmed content is computed from the content and placed in the content area**, and is deleted together with the confirmed content). The current state of an item is computed from the log and is not lost on export or restore.
- **The content of an item records provenance**: the reason text, the effect, the current and proposed values and the list of differences are all content (individually deletable per entry), and they record which row versions and sources they reference;
  when privacy deletion cascades to these provenances, the corresponding entries are cleared; if the item thereby loses its target (the target row is deleted), the candidates / proposed values lose all their value sources, or the cause of the conflict / high-impact is deleted, the item is marked "superseded" (reason code `deleted`, containing no content), and it is restored when the deletion is cancelled (see "Deletion · Replay rules" and "Cancelling a deletion and the grace period").
  When the only value source whose original text still exists of a candidate / proposed value is removed by "evidence deletion", the item is likewise marked "superseded" (reason code `evidence_deleted`) and can no longer be taken or confirmed (see "Kinds of deletion").
- **Data flags**: carried with read results; the full list is as in architecture §4 `flags` (`disputed`, `awaiting`, `flagged`, `stale`, `pending_extraction`; `tentative` is used only with multiple nodes and does not appear in the first version); `disputed` and `awaiting` carry the item, the field and the interval (see "Reads · Fast"). The contract has further flags derived at read time: `corrected`, `possibly_affected`, `partially_deleted`, `revoked`, `pending_deletion`, `dangling_ref`, `computed_at_read` (their home is the same place; the complete list is as in [`../04-contract-types.md`](../04-contract-types.md) section 3); the summary flags of derived rows are computed at read time.

#### Targets and merging

| Item | Target | When another comes on the same target |
|---|---|---|
| `conflict` | (row / entity, conflict unit); a state table additionally carries intervals of valid time (which may be several disjoint intervals) | **Merge into**: on the same conflict unit, a candidate whose interval intersects (in any one segment) the interval of an existing item merges into it, and the interval of the item becomes the union, then normalized (adjacent and intersecting segments combine into one, not taking the enclosing span); a candidate that does not intersect becomes a separate item. When one candidate intersects several existing items at once, it merges into the earliest created, and the others are left alone. For a revoke taking part in a conflict, the target is (row / entity, **existence**) |
| `awaiting_confirmation` | The row / entity, the fields and the intervals that this write is to change | **No merging**: each high-impact write becomes its own item. After one of them is confirmed, the others are superseded or refreshed according to the rules of "No expiry" |
| `flagged` | The flagged row (the newly added row); the content lists the rows it matches and the key groups matched (see "The write request · Suspected duplicates") | One item per newly added row |
| `schema_change` | The draft (a slot has only one at a time) | A new draft supersedes the old one |

- A conflict unit is a field or a field group declared by the schema (see "Conflict handling · Conflict criteria"). **A write that becomes a candidate on two conflict units makes two items, each resolved on its own.** This way merging, superseding and the scope of handling need no notion of "partial"; where fields are truly related, a field group joins them into one unit.
- Example: B changes the `amount` and `note` of a row. A, with a stale `ver`, changes `amount` and `note`, and C, with a stale `ver`, changes only `note`. The result is two items: one for `amount` (candidate A) and one for `note` (candidates A and C).

#### Contents of a conflict item

- **The candidates are listed one by one**, and each candidate is "all the parts of one write on this conflict unit" (the several fields it changes in a field group, and the several segments on which it became a candidate on a state table, all count as the same candidate and are taken as a whole when taken; the index of a candidate is the same in the item, in the contract and in the log): write number, writer, intent, value (or revoke), candidate interval (state tables), the `ver` it carried, and cause (in the first version only `stale_write`). A write that became a candidate did not change the value in effect; it does not supersede existing items but merges into them.
- **Merge base**: the earliest version among the `ver` carried by the candidates currently in the item. The history of saveslot is linear, so it is unique. The item content records the operation number of the merge base, and the value at the merge base of this item's conflict unit (and interval): this is the value that `take_previous` goes back to; on a state table it can be several segments.
- When a candidate merges in, or a candidate is removed by privacy deletion, the merge base is recomputed by mechanical judgement and the item version is renewed. The recomputation is done by the judgement module, and the result is handed to the item module to be recorded as an event (architecture §4).
- **Several candidates and deletion**: when a candidate loses all its value sources, it is only removed from the item (the item version is renewed); only when all candidates are removed is the item marked "superseded".
- With system ruling (later), when the ranks of several candidates are all higher than the current value, the one with the highest rank is taken, and among equal ranks the one with the earliest write number; after a candidate becomes the value in effect through system ruling, the item remains open.

Example: #40 `distance 15`; #57 corrects it to 5 (with `v40.0`); A writes 6 with `v40.0` (candidate); C writes 5.5 with `v33.0` (candidate; at `v33.0` the value was 12). The merge base is `v33.0`, and `take_previous` goes back to 12; when A is the only candidate the merge base is `v40.0`, and it goes back to 15.

#### Effect: what changes once executed

The kernel computes it when the item arises and stores it as item content entry by entry, in the same shape as what the `awaiting` / `candidate` attached to a write receipt carries:

| Item | What the effect contains |
|---|---|
| `awaiting_confirmation` · high-impact ① | The segments that will be overwritten (per field): interval, old value, and the write number and writer of the write that wrote it; the intervals without a value that will be filled (with the revoke that left them) |
| `awaiting_confirmation` · high-impact ② | The rows that still reference this row |
| `awaiting_confirmation` · high-impact ④ | The later writes that will be reverted |
| `conflict` | The value that `take_previous` goes back to, and the writes it will revert (all the writes that took effect on this conflict unit after the merge base); if a candidate would be high-impact when it takes effect, the segments that taking it would overwrite (what is overwritten is the writes in the overwrite set: all the writes that took effect after the merge base on this conflict unit and the interval of the item) |
| `schema_change` | The draft ID and the changes one by one; the row counts and trial-run results in the impact preview are estimates made when the draft is submitted and are outside the bound scope |

- **The effect is within the coverage of the item version and of the content hash of the confirmation record, and the item detail must give it**: a caller that confirms from the detail alone sees as much as one that holds the write receipt. Therefore a write triggered by `resolve` does not go through high-impact judgement again: taking a candidate or taking the previous value is the confirmation of what the effect lists.
- **The effect does not quietly expire**:
  - a write that changes these segments or these writes supersedes or refreshes the item according to the rules of "No expiry";
  - when privacy deletion clears one of them, the item version is renewed, and when all its causes are deleted the item is superseded;
  - for high-impact ②, the referrers will change while the target row itself is not changed: when another row adds or removes a `ref` to this row (a referrer being revoked, or a revoke being restored through `undo`, likewise counts as removing / adding), the kernel refreshes the corresponding entries of the effect and renews the item version (the write pipeline already has to validate the target of `ref`), and a confirmation with the old version receives `confirmation_mismatch` and the new list of referrers. After all referrers are removed the item is still kept, with an empty effect, and waits for a person to confirm as usual: saveslot does not execute on someone's behalf just because the cause has gone.

#### Item ID and item version

- The **item ID** (`pi_…`) is a short stable ID, assigned randomly by saveslot and never reused within a tenant, **neither signed nor bound to content**; the ID stays unchanged after the item merges in a new candidate or after entries are cleared by deletion.
- **Content binding is by item version**: an opaque token that encodes (the item ID, the operation number of the latest change to the item content, the tenant restore count). It is renewed when the item arises, merges, is refreshed, has an entry cleared, is superseded, is restored on cancellation of a deletion, and is resolved.
- **A resolve request passes back the item version it read**; when the version does not match, it is rejected with the current content: this is how K14 "a confirmation is bound to its content" holds. The hash of the confirmed content is still computed from the content and recorded in the confirmation record of the resolution event (content area); who confirmed is seen in the `actor` of the resolution event, and through which credential is derived from `actor`; the confirmation record holds only the hash.
- **The fallback when none is passed**: the item version of that item which this connection read most recently is used, with the same rule as the `ver` fallback (when a task identifier is passed, only the same task counts); if it has never read it, the request is rejected, with a prompt to view the item first.
- **An item version is "read" in only two ways**:
  - ① viewing the detail of the item;
  - ② this write / deletion / draft submission **newly generated** the item and the receipt gives its full content (the `awaiting` / `candidate` in the per-field results of a write receipt, the `deletion` of a deletion receipt, the `schema_change` in a `schema_draft` receipt).

  Places that list only the item ID (`pending[]`, `superseded[]`, `warnings` of a receipt, the flags of a read result) do not count; a write that **merged into an existing item** does not count either: the receipt states only the part from this write, the merged content has never been seen by the caller, and the receipt prompts to view the item first.
- What records "was read" is `audit`: the `pending` detail is handed to it by `read`, and the version of an item newly generated in a receipt is handed to it by `write` / `delete` (that of `schema_draft` through `ops`) (architecture §4).

**What is bound depends on the kind of item and the decision**: "reject when the version does not match" above is the default; the following are the exceptions:

| Item · decision | What is bound |
|---|---|
| `migration_diff` · `abandon` / `keep_rest_and_switch` | Only "which migration": the item ID (one-to-one with the migration) + the tenant restore count; the content is not checked, and the difference list growing with extraction does no harm |
| `migration_diff` · `accept_all` | "Up to the k-th difference": difference entries are numbered in the order they are listed, the detail returns `diff_upto` = the number of the current last entry, which is passed back on handling; only entries with a number ≤ k are accepted, and those listed later stay in the list. When an entry is refreshed it takes a new number (see "No expiry"), so the entries with a number ≤ k are as the caller saw them when reading |
| `migration_diff` · per row | Only the listed rows are checked: the difference entries of those rows have not changed since the item version the caller read; changes to other rows do not matter |
| `deletion` · `cancel` | The item version is not checked: it is executed as long as the item is still within the grace period. Cancelling is the only path of regret for a deletion, and one who cancels from another session or task should not first be required to read; cancelling confirms no new content |

**The order of judgement**: the item does not exist → `not_found`; the item is closed (resolved or superseded) → if resolved with the same decision, the original result is returned (a replay, not executed again), otherwise rejected (`item_closed`, with the existing result or the superseder / the reason for superseding); when the target of the item is affected by a deletion still to be executed and the item is neither `deletion` nor `schema_change`, rejected (`invalid_argument`, `pending_deletion_target`, see "Deletion · Cancelling a deletion and the grace period"); only last is the item version validated (`confirmation_mismatch`).

- So resending the same decision with an old item version after 24 hours is returned as a replay and does not report a version mismatch.
- After a backup is restored, an item version obtained before the restore has a restore count that does not match, and `confirmation_mismatch` is reported (with the current version and content).
- After a `deletion` item is physically erased on expiry it is resolved (the result is "executed": not a decision, but applied as a tombstone of `system`), and after that `cancel` reports `item_closed`. When the grace period has passed but the tombstone has not yet been applied, the item is still pending, but no decision can be used any more, and `cancel` likewise reports `item_closed`.

#### No expiry: merging into, superseding and refreshing

**Only a person or an agent has judgement, saveslot does not, and any expiry duration is a guess.** Items do not expire; they do not pile up thanks to three things: conflicts on the same target merge into one item (see "Targets and merging"); an item is superseded when a writer who has seen it changes the data; an item that no longer applies after a schema switch is superseded. While unhandled, a definite value in effect is given by the conflict rules (never blocking); items left unhandled for a long time are only escalated in the prompts of read and write results, and saveslot does not dispose of them itself.

When a write that has taken effect **changes** the target of an open item:

| Writer | Item | Notes |
|---|---|---|
| Has read the current version of the item (for the definition of "read" see above) | **Superseded** | The writer saw the candidates / proposals and then made a new write, so the old dispute has no meaning any more |
| Has not read it (including one merged into by this request) | **Refreshed**, remains open | For a conflict item the current value in effect is replaced by the new value and the effect is recomputed; for an awaiting-confirmation item the effect is recomputed. The item version is renewed, and `refreshed: true` is marked in `pending[]` of the receipt |

- **"Changes" is judged by the conflict criteria**: a write counts only if it changes the conflict unit of the item (on a state table the interval of valid time must also intersect the interval of the item, looked at segment by segment); an item with no intersection is unaffected, and on execution the recorded interval is used. A write that became a candidate or went to awaiting confirmation did not change the value in effect and does not count as a change.
- **A request counts as a whole**: the content of an item is computed from the state at the end of the whole request, with at most one set of content per item in a request; an existing item changed by any op in the request is superseded or refreshed only once, at the end; "has read" is judged by the item version at the start of the request; an item merged into by this request counts as not read, regardless of order, and is not superseded (event format §5.8, "Item content within one request").
- **Content does not quietly expire**: an open item that the request did not change, but whose recomputed content (entries and effect) changed, is refreshed at the end of the request; it is only refreshed and not superseded, whether or not it was read. Superseding follows only the conflict criteria above.
- **Why an item not read is not superseded**: what the writer read is only the value in effect and the flags, and it never saw the candidates. Letting it close the conflict for a person would make the candidate vanish silently, for example: value in effect 9.5 (agent inferred), candidate 10 (the user's own words), and an unattended agent writes 9.6 by a tool sync, after which the 10 the user said would appear in no pending item any more. A candidate can be closed only by a party that has seen it.
- **After a refresh**, a `resolve` holding the old item version receives `confirmation_mismatch` and the new content and must confirm again. Taking a candidate or confirming a proposal therefore does not quietly overwrite a new write.
- Whether the writer "has read" is derived at write time from the read audit, and the result is written into the supersede / refresh event; on replay the recorded result is used and not recomputed (handled the same as suspected duplicates and literal match).
- **`flagged` is an exception**: it has no unapplied candidate or proposal to lose, so it does not look at whether the writer read (the event does not record whether the writer read). When the flagged row is revoked, or neither it nor the listed rows match any more (either side changed or revoked), the item is marked "superseded"; when only some of the rows no longer match, the entries are refreshed (the other rows keep their original order). The reason for both is recorded as `matched_changed` (a matched row was revoked or changed). When the rows all still match and only the matched value is now given by another contribution, the entries are given again (`entries_changed`), so that later, when the source of the new contribution is deleted, the entries can be deleted as well.
- **Schema switch**: when a field the item involves undergoes an incompatible change in the switch (the same criteria as for writes with an old `sv`, see "Schema version evolution · Principles"), the item is marked "superseded". A mere rename or a unit change within the same dimension does not count.
- **`migration_diff` is an exception**: it is not superseded by ordinary writes during the migration: writes that change a `from` field during a migration are expected (work items are appended automatically, see "Extraction jobs"). For a row changed by a write, **the corresponding entry in the difference list is refreshed**: the old entry is voided, and after the row is extracted again it is listed again with the new result, taking a new number at the end.
  It is closed only when the migration ends: switch (resolved), abandon the migration (resolved), migration failure (superseded, reason code `migration_failed`).

#### Execution semantics of each decision

A decision is "the decision of the person, executed as recorded" (see "Definition of the result of a deletion"). A write triggered by a decision must have source data (see "Invariant: every write has source data"); the resolve request is only the operation source, unless the table below says otherwise. A write triggered by a decision belongs to this resolve operation: the head event is the resolution event, the operation number is its `seq`, and there is no separate logical write head. **The note (`note`) and the evidence carried by a resolve request are stored as source data**, and the resolution event references them as the operation source; the same holds for decisions that trigger no write (keep the value in effect, reject, keep).

| Interface kind | Decision | Execution |
|---|---|---|
| `awaiting_confirmation` | `confirm` | The proposed write takes effect; value source = references to the contributions of the proposed write |
| | `reject` | The proposal does not take effect and stays in the history |
| `flagged` | `keep` | The data is unchanged, the flag is removed |
| | `revoke` | Revoke the flagged row (one revoke write, which triggers the query of the reads a correction affects, as an ordinary revoke does) |
| `conflict` | `keep_effective` | Keep the current value in effect; no candidate takes effect |
| | `take_candidate` | Take the one candidate named by `candidate` (the index of the candidate in the item, counting from 0; it may be omitted when the item has only one candidate, and when there are several, not giving it reports `invalid_argument` with the list of candidates attached). **It lands only on the conflict unit of this item**: on a state table, on the intervals of the parts of the taken candidate in this item. When what is taken is a revoke, the revoke item lands even if there is no value there at resolution time (the row has already been revoked). At resolution it follows the recorded merge base, the overwrite set (the (event, target) pairs that took effect within the conflict unit and interval of the item after the merge base, listed in the same way as the revert record of `take_previous`) and the revokes it fills in (on a state table, the revokes that are in effect at resolution and intersect the scope taken, with their intervals); after privacy deletion, the intervals the take lands on are recomputed in replay, and writes outside the overwrite set take effect as usual (see "Deletion · Carried values"). Value source = references to the contributions of that candidate; the contributions of the other candidates in the item with the same value are also value sources. The other candidates do not take effect and stay in the history |
| | `take_previous` | **Go back to the merge base**: the same kind of operation as `undo` (revert). It reverts the (event, target) pairs that took effect within the conflict unit and interval of the item after the merge base (listed one by one into the revert record at write time; candidates are not among them, they are closed by the resolution); the scope is the intersection of the intervals of these items and the interval of the item, and within the scope it goes back to the state at the operation number of the merge base; where the merge base has no contribution it writes back "no value". Writes outside the interval and on other conflict units are not touched. Value source = references to the contributions in effect at the merge base. The intent of the reverting write: for `undo`, the intent the caller gave is used, and when none was given, the intent of **the `write.base` with the largest `seq` on this row (or entity) among the operations undone**, not looking at writes reverted along with it by `include_later`; `take_previous` takes **the intent of the `write.base` that holds the item with the largest event `seq` in the revert record**, and `update` when the revert record is empty. The operation number of the merge base is as recorded at resolution, and a later privacy deletion does not change it; the scope and the values are recomputed in deletion replay (the authoritative definition is in "Deletion · Replay rules · The authoritative definition of reverting") |
| `schema_change` | `confirm` | The draft takes effect. One that needs no new physical table (catalog changes only) switches on the spot; one whose physical shape changes enters migrating, where saveslot builds the new table, replays the log and then switches, without waiting for a person any more (see "The physical approach"). One that needs re-extraction (later) additionally generates an extraction job and a `migration_diff` item, see "Extraction jobs" |
| | `reject` | The draft is abandoned |
| `migration_diff` (later) | `accept_all` | Accept all differences with a number ≤ `diff_upto` (the new values go into the new version table); entries with no proposed value (those skipped with `ambiguous`) are not included and stay in the list. It can also be used before extraction has finished; after extraction has finished and all differences are handled, it switches |
| | Per row (`accept` / `reject` / `set`) | Accept or reject row by row (the new field stays empty, and the old value can still be found in the old version and in the source data), or give a value; the value source of `set` = the evidence of this resolution (if none is carried, the resolve request itself) |
| | `keep_rest_and_switch` | **= treat all unhandled differences as a per-row `reject`** (the new field stays empty, and the old value can still be found in the old version and in the source data), then switch to the new version. The actual consequence for splitting fields: the new field is empty on these rows; if the old field is in `drop_fields`, after the switch it cannot be seen in the current version and can only be found by reading as of an instant or in the source data: the item detail and the prompt must say so. Entries not yet extracted are still handled by the difference rules of the original migration and do not take effect directly as a pure supplementary extraction (see "Extraction jobs · During migration and at the switch") |
| | `abandon` | Abandon the migration: the new version tables under construction are discarded, the old version remains current, and nothing has changed; the extraction jobs end and the leases not handed in are voided (a later submission reports `lease_expired`, reason `migration_abandoned`); translations already handed in stay in the log and do not take effect |
| `deletion` | `cancel` | Cancel this deletion (see "Deletion · Cancelling a deletion and the grace period") |

**An item is not reopened after handling**: the first version has no way to bring a resolved item back to open. Decisions that trigger no write (`keep_effective`, `reject`, `keep`) have nothing to `undo`; for those that triggered a write (`confirm`, `take_candidate`, `take_previous`, `revoke`), that write can be undone with `undo` and the value goes back to what it was before the handling, but the item stays resolved, and a candidate that was not taken appears in no open item any more. If the user changes their mind and wants the value of some candidate, that value is written directly. On tables synced by external key, the effect of this is: a source value that the user rejected with "keep the value in effect" or "take the previous value" is not proposed again by later syncs, and does not take effect directly either (see "Writing by external key" and the sync baseline in "Conflict handling · Conflict criteria").

**Conflict items whose target is "existence"** (revoke and concurrent changes, see "Conflict handling · Revoke and concurrent changes"):

| Decision | Effect |
|---|---|
| `keep_effective` | Keep the status quo; the candidates do not take effect |
| `take_candidate` | If the candidate is a revoke: the revoke takes effect. If the candidate is a change: the row exists again, and this change is applied |
| `take_previous` | Go back to the merge base: the row exists, and the value is the value at the merge base. The revert record lists the (event, target) pairs that took effect after the merge base on any field or on "existence": when what is reverted is a revoke, the row exists again; when it is a change, the field goes back to the value at the merge base |

- On a state table, taking a candidate or taking the previous value touches only the intervals the item recorded. When writes that intersect those intervals came in during the pending period, the item has already been superseded or refreshed (the item version is renewed, and it must be confirmed again), so nothing is quietly overwritten.
- An extraction job has only two skip reason codes: `no_content` (the original text has nothing to extract, and the new field stays empty) and `ambiguous` (it cannot be judged, and goes into the difference list for a person to handle).
