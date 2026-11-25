# 04 · Architecture

> Translated from docs/zh-CN/guide/04-architecture.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

The first three chapters covered the data inside saveslot: the log, tables, provenance, items. This chapter covers what the program that holds this data looks like: how many layers it has, what each layer is responsible for, how a call travels from an agent to the log, what an event looks like in storage, and how the process runs.

The examples continue with the ledger from chapter 2.

## 1. Four parts

saveslot is made of four parts, from the inside out:

```
Surfaces       HTTP · MCP · command line (CLI)           Later: App, developer SDK
               ────────────── operation contract ──────────────
Service layer  identity · permissions · idempotent waiting · handles · rate limiting · control-plane storage
               ────────────── kernel operation layer ops ──────
Kernel         write · read · schema and migration · deletion · pending items         Later: jobs
               judgement judge · derivation derive · apply events apply
               rule engine · time
               log · read audit · data flags
               tenant storage · registry storage (two interfaces)
Backend        PGlite (local mode)        PostgreSQL (server mode)
```

The terms in the diagram (idempotent waiting, handles, control-plane storage, `ops`, data flags and so on) are explained one by one in sections 4, 5 and 8 of this chapter; for now just look at how the four parts stack. The two interfaces at the bottom are called "storage abstraction" and "anchor storage" in the specification's diagram; this guide calls them tenant storage and registry storage (section 8).

| Part | What it is | What it corresponds to in the example |
|---|---|---|
| **Kernel** | The code that holds the data rules. The log, `apply`, conflict judgement and the computation of deletion results are all here | Turns "lunch 45" into the four events #21–#24 and applies them to the tables |
| **Service layer** | Answers "who is calling, what can they do, which slots can they see", and handles matters of call experience | Recognizes that this call comes from connection A, that A has write permission and can see `ledger` |
| **Operation contract** | A definition independent of the transport: which operations exist, what parameters each takes, what result it returns, what errors it reports | The shape of the parameters and the receipt of the `write` operation |
| **Surface** | Carries the contract onto some concrete way of connecting | An agent calls `saveslot_write` through MCP; a person types `saveslot query` in a terminal |

**The core is the first three: kernel + service layer + operation contract.** Surfaces can be added or removed: HTTP, MCP and CLI are all generated from the same contract and have equal standing, and adding an App or a developer SDK later is just one more surface. The correctness of saveslot does not depend on any one surface existing; all checks are in the kernel and the service layer.

## 2. Where the line between the kernel and the service layer falls

Whether something belongs in the kernel or in the service layer is decided by a single criterion:

> **If you turned it off, would saveslot's data still be "traceable, explainable and recomputable"? Would the accountability guarantees saveslot states publicly (who did it, who read it, what was confirmed) stop holding?**

- What would stop holding goes into the kernel and cannot be turned off under any usage.
- What concerns only "who can do what, how to interact, call experience" is a **policy** of the service layer and can be replaced.

Two examples:

- If "every write leaves source data" is turned off, a value can no longer say what it rests on. It is in the kernel.
- If "how the caller's identity is verified" is done another way (a local token replaced by OAuth), the traceability of the data is not affected. It is in the service layer. The kernel only requires that "every event has a registered principal"; how that principal was authenticated is not the kernel's concern.

This line is drawn for the future developer SDK. When the SDK is embedded in someone else's agent, identity, permissions and the way confirmation is interacted with are all decided by the host application, and the whole service-layer set can be replaced; but not one rule of the kernel may be missing, or it is no longer saveslot.

The service layer's policies are: identity authentication, permissions (the first version goes by scope and slot range), the way confirmation is interacted with, the length of the idempotency window, handle signing, rate limiting and quotas, the numeric values of various thresholds, and how results are rendered as text. The full table is in [`../spec/02-architecture.md`](../spec/02-architecture.md) §3 "Service-layer policy".

## 3. Kernel invariants K1–K14

The rules the kernel holds are called **kernel invariants**. There are 14 of them, numbered K1–K14 in the specification. Here they are grouped by theme, each saying only what it guarantees; half of them were already covered in the first three chapters, and the concepts behind the other half are expanded in later chapters (the parentheses say which chapter), so on a first read it is enough to know that these 14 exist. Each one is an assertion that can be written as a test; the full table is in [`../spec/02-architecture.md`](../spec/02-architecture.md) §3.

**The log and replay**

| # | What it guarantees |
|---|---|
| K1 | The log is append-only. Each event has an event header and content; event headers are chained and are never deleted or modified, and hold no value computed from user content; content is stored in blocks, and only a deletion can clear a block, as a whole |
| K3 | Tables can be changed only by `apply`; every change corresponds to one log event and is committed in the same transaction. Writes within each tenant are serial |
| K12 | The log is the only source of truth. Everything in storage falls into one of three classes (fact, materialized state, local runtime state); replaying the log from an empty database yields tables that match the live ones row for row (chapter 3) |
| K13 | A write happens exactly once. When the same request is sent again (for example the network drops and the client retries), it is recorded only once, and the original result is returned on the resend (chapter 5) |

**Who did it, and on what basis**

| # | What it guarantees |
|---|---|
| K2 | Every event has an actor: a principal registered in this tenant. Events the kernel produces itself are recorded under the reserved principal `system`, noting which background task triggered them |
| K4 | Every write to a base table has source data. Provenance is recorded down to the field, split into value source and operation source |
| K10 | Reads leave a trace. Every read operation in the contract records which versions were read, only the version numbers, not the values, and not hashes computed from values (chapter 6) |

**The shape and time of data**

| # | What it guarantees |
|---|---|
| K5 | Derived tables are generated only by rules and are refreshed in the same transaction as the write to the base tables; an agent cannot write into them. How much derived data a write touches, and whether it fits into one transaction, is also estimated by the kernel, which rejects the write when it does not fit (chapter 9) |
| K6 | A schema version, once in effect, is immutable, and fields have stable IDs. A table structure can be changed only through one fixed migration process; switching between the old and new versions is atomic, and reads are not interrupted during the switch (chapter 9) |
| K7 | Two timelines. Recorded time is given by the log sequence number; valid time is handled by the table's time type. The kernel itself does not read the clock: the "current instant" is taken once by the service layer at the entry point, handed to the kernel through the calling context (section 5) and recorded into the event, and replay uses only the instant recorded in the event (chapter 7) |
| K9 | An agent may query data with read-only SQL, but only allowlisted syntax is accepted (the statement is parsed into a syntax tree and checked node by node), and internal physical table names are not leaked (chapter 6) |

**Concurrency, deletion and confirmation**

| # | What it guarantees |
|---|---|
| K8 | A write with a mismatched version does not overwrite. Judgement is by **conflict unit** (one field, or a group of fields the schema declares must be judged together); on a state table it also looks at whether the valid-time intervals the two writes cover intersect (chapter 7, section 13): those with no intersection are merged, and those with an intersection are recorded as candidates and produce a conflict item. For two writes that both pass no end point, the judgement result does not depend on which arrived first (for the range see chapter 7, section 13); the value in effect during a conflict is given by a deterministic rule (chapter 5) |
| K11 | The result of a privacy deletion is computed by one definition: the state obtained by replaying the log as if the deleted source data had never existed; there are two deliberate deviations (a person's decision stays as recorded, and a write that has already taken effect stays in effect). Everything derived from the source data is within the scope of the deletion; a tombstone never expires (what has been deleted does not come back to life because time has passed); after any backup is restored, the deletions made after that backup are first done again, and only then does it serve externally (chapter 8) |
| K14 | A confirmation is bound to its content. An item that needs confirmation is executed only when it is explicitly resolved; resolving must pass back the version of the content being confirmed, and a mismatch is rejected; each resolution records who did it and through which credential (chapter 3) |

A few notes:

- **Judgement rules carry versions.** The kernel's mechanical judgements (is it a conflict, is it high-impact, does a row exist, and so on) have one **rule version** as a whole. Each slot's policy (chapter 3: a set of settings that says which schema changes take effect automatically and which value counts during a conflict; defaults are written when the slot is created, and the first version cannot change them) has a **policy version**. Both numbers are recorded in the head event of every operation. When a privacy deletion later has to recompute the judgement of an old write, it computes by the versions that write itself recorded. This way, after a kernel upgrade, an unrelated deletion does not change the result of an old judgement. The first version has only one rule version, but the number is recorded from the start, because it cannot be filled in afterwards.
- **The first version relaxes none of them.** A few have a narrower area of application because the feature is not turned on: K5 (the first version has no background jobs for large writes, so derived values are never behind, which is stricter than the full design), K8 (the first version does not do "a candidate with a higher source level takes effect automatically"; during a conflict it always keeps the current value), K10 (the correction-impact query in the first version does not cover reads of derived values), K11 (the first version has no "evidence deletion" and no deletion by row, so the rules that concern them are not triggered for now), K12 (the check of "replay the log from an empty database and compare row for row with the live tables" is called a **replay comparison**; the first version has no periodic background spot check, and the user has to run it manually).
- Every invariant has a corresponding test; see chapter 12.

## 4. The modules inside the kernel

The kernel is divided inside into modules, arranged in layers. The lower, the more basic.

| Layer | Module | What it does |
|---|---|---|
| L0 | `store` storage abstraction | Opens the storage of a tenant, opens transactions, guarantees that only one process writes at a time |
| L1 | `log` log | Appends events, assigns sequence numbers, chains event headers, stores content blocks and computes checksums, clears content blocks as a deletion requires, verifies the whole log |
| L1 | `audit` read audit | Buffering, flushing to disk and querying of read records; "the version each connection read most recently" (used as the fallback when `ver` is not passed) |
| L1 | `flags` data flags | Stores and retrieves the flags on data, such as "disputed", "has a change awaiting confirmation", "flagged" |
| L2 | `rules` rule engine | Parses read-only SQL and checks it against the allowlist, replaces table names and field names with internal physical names, computes how derived tables should be refreshed, estimates the cost of a write |
| L2 | `time` time | The time types of tables, basic interval operations, querying by valid time |
| L3 | `judge` judgement | **Computes only, stores nothing.** Given the state of a row (or an entity) and a write, it computes the judgement result: whether the value changed, whether there is a conflict, where the default end point falls, whether it is high-impact, whether the row exists. It does not read the database and does not produce events. For the two ways it is used, see "Why judgement is its own module" below |
| L3 | `derive` derivation generation | Given a batch of base data changes, computes which derived rows are affected and generates the derived write events |
| L3 | `apply` apply | The only implementation that applies events to tables. It does only what the result recorded in the event says and does not judge again |
| L4 | `schema` | Parsing and compiling of schema documents, change classification and impact preview, the migration process, the catalog |
| L4 | `pending` pending items | Generation, merging, refreshing and superseding of items; on resolve, checks the bound content |
| L5 | `write` write pipeline | Validation and unit conversion, storing evidence as source data, checking `ver` and `sv`, deduplication, locating the target row by external key (chapter 5, section 3), validating the premises the write declares, fetching the current state of the target row and handing it to `judge` together with this write, generating write events; when this write changes the premises of other rows, generating premise change events |
| L5 | `read` read | Simple queries, read-only SQL, history and reading at an instant, listing and searching source data, computing flags such as "premise changed" at read time, recording the read into `audit` |
| L5 | `delete` delete | Finds which rows a deletion affects, fetches all writes of those rows and hands them to `judge` for replay, generates deletion events (when a deletion changes premises, it also generates premise change events) |
| L6 | `maintenance` maintenance plan | **Computes only, does nothing.** Given "now", it answers which background tasks are due. It opens no transaction, reads no clock and executes nothing |
| L7 | `ops` kernel operation layer | The only entry point in the kernel for each operation in the contract, and the entry point for background tasks: opens the transaction, composes the modules above, assembles the receipt |

There are also two modules, `jobs` (background jobs) and `sync` (multi-node synchronization), for which only a place is reserved; the first version does not implement them.

### Why judgement is its own module

Judgements such as "does this write conflict" and "does this row exist" are needed in two places, used in different ways:

| Who calls | What is handed to `judge` | What `judge` computes | Example in this guide |
|---|---|---|---|
| At write time (`write`) | **The current state** of the target row, plus **the write that just arrived** | Judges only this one write: which fields did not change, which conflict, whether it is high-impact | Write #37: A changes the taxi amount carrying an old version, and the judgement is "`amount` conflicts and becomes a candidate" |
| At privacy deletion time (`delete`) | **All writes** of the affected row, with a mark of which contributions are no longer there | Judges these writes again in order from the start and obtains the state after the deletion | Chapter 8, section 5 (that section changes one premise: suppose nobody has handled the taxi conflict yet): after `s_4` is deleted, the taxi row is replayed and the judgement is "the conflict no longer exists, 32 is in effect". In the main line this conflict was already resolved by a person at #41, and a candidate does not take effect because of a deletion |

At write time history is not replayed: the state the row already has is the result of every earlier write's judgement, used as it is. Only at deletion time is a replay from the start needed, because the sentence that is deleted may have changed the judgement of every earlier step.

Behind the two uses there must be **the same set of rules**: the result of judging one write at a time must be exactly the same as the result of replaying all writes from the start. If writing and deleting each had their own copy, the rules would sooner or later drift apart, and the state after a deletion would no longer match "as if that sentence had never been said". So there is only one implementation of judgement, in `judge`, and writing, deleting and table-structure migration all call it. Making one piece of code support both "judge once" and "replay a whole row" is the point in the implementation that most needs to be verified first (the implementation steps in chapter 12 include a small prototype for exactly this).

Making it a pure computation that "computes only, stores nothing" has two more benefits: it does not touch the database, so it is the easiest to test with large numbers of random cases; and the rule version also gets a clear owner.

### Dependency rules

1. **A module may depend only on lower layers; modules in the same layer do not depend on each other.** This leaves the dependencies without cycles, so that when one module is changed it is clear who is affected.
2. **A module that generates events does not change tables directly; it only hands the events to `apply`.** `write`, `schema`, `pending`, `delete` and `derive` are responsible for "judge and write out the events", and `apply` is responsible for "change the tables according to the events". Chapter 3 explained why: the judgement is made only once and the result is recorded in the event, so that replay can obtain the same tables.
3. **There is only one implementation of judgement**: everyone calls `judge` and none implements its own.
4. **Transactions are opened by `ops`.** Lower-layer modules only receive a transaction that is already open and do not open one themselves.
5. **The service layer calls only `ops`, and surfaces call only the service layer.** Nobody can bypass `ops` to touch the modules below directly.

These rules are checked automatically by a tool on every code commit (CI); a violation cannot be merged.

### Why `ops` opens the transaction

One operation often spans several modules, and these changes must either all succeed or all fail.

Take A's write in step 3 of chapter 2, the one carrying an old `ver` (write number 37): `write` records the write head (#37), stores the evidence as source data (#38) and records the candidate write (#39); `pending` generates the conflict item (#40); `apply` applies them to the tables and puts the "disputed" flag on that row; and `audit` first has to flush the read records in the buffer to disk. If each module opened its own transaction, a crash midway could leave a half-finished state such as "has a candidate, no item". With one transaction opened by `ops` around all of it, this state cannot occur.

It also solves the "cycle" between modules. A write produces items, and resolving an item has to execute a write: `pending` and `write` need each other. Dependencies can point in only one direction: `write` is in the upper layer and may call `pending` (that is how the conflict item was generated in the write above); the reverse is not allowed. So when resolving an item has to execute a write, `ops` orchestrates it: first call `pending` to check the content and record the resolution, then call `write` to execute. `pending` does not know that `write` exists.

### How background tasks come in

Some things are not called by anyone but have to be done when their time comes: flushing read records to disk, physical erasure that has come due, the background build of a table-structure migration. They run into two rules: transactions can be opened only by `ops`; the kernel does not read the clock.

So a background task is split into three parts:

| Part | Where | What it does |
|---|---|---|
| Plan | `maintenance` in the kernel | Given "now", computes which tasks are due |
| Task body | An **internal operation** in `ops` | The same kind of entry point as an ordinary operation: receives the calling context, opens the transaction, composes the lower-layer modules. The only difference is that the actor is `system`, with a `trigger` saying which background task it is |
| Scheduler | **Outside the kernel** (in the saveslot service it is in the startup program) | Holds the timer and reads the clock, and calls the internal operation when the time comes |

The small piece of code that reads the clock is therefore outside the kernel, so that during replay and testing time can be fully controlled.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §4.

## 5. How a call travels

Take the correction in step 2 of chapter 2 as the example: A sends `saveslot_write` through MCP.

```
A (Claude Code)
  │  MCP tool call saveslot_write, carrying the connection token
  ▼
Surface · MCP adapter      turns the tool call into the contract's write operation
  ▼
Service layer
  ① Identity: token → looked up in the control plane (tenant, principal = connection A)
  ② Permission: does A's scope include write; which slots A's credential is limited to
  ③ Idempotency: compute the request key from "connection + task + request content"; if the same request is being processed, make the later one wait
  ④ Open this tenant's storage, build the calling context (visible range given by A's slot range)
  ▼
Kernel · ops.write
  open the transaction
  → audit: flush the read records in the buffer first (so that the fallback for ver is sure to see the read just made)
  → write: validate, deduplicate, store source data, fetch the current state of the lunch row
  → judge: compute the judgement result of this write (amount differs from the version read → it is a change; ver is the current one → no conflict; not high-impact)
  → write: generate the write head and base write events from the result
  → derive: work out that the monthly total is affected, generate the derived write events
  → apply: change the tables according to the events
  → read: find which reads this correction affected
  commit the transaction, assemble the receipt
  ▼
Service layer → MCP adapter      render the structured receipt as text (flags, units, versions, none missing)
  ▼
A receives the receipt
```

A read travels the same road; only what is done in the kernel differs. Take A calling `saveslot_query` to look up the expenses of 11-10, writing only the part inside the kernel:

```
Kernel · ops.query
  open a read-only transaction
  → rules: replace table name expenses and field name date with the physical table name and column name of the current version; the visible range also takes effect at this step
  → read: run the query, fetch the rows and their ver
  → flags: fetch the flags on these rows (disputed, has a change awaiting confirmation, flagged, ...)
  → audit: put "who, when, which version of which rows were read, the shape of the query condition" into the read record buffer
  assemble the result
  ▼
Service layer → MCP adapter      render as text: every value carries its unit, flags are written at the end of the row, text fields are wrapped in the untrusted boundary
```

A read produces no log event. Read records are first held in a memory buffer and flushed to disk a little later (section 7).

### The control plane

The "control plane" in step ① is a small store kept separate from tenant data. The credential must first tell which tenant it is before that tenant's storage can be opened, so this kind of "cross-tenant" information cannot be kept in the tenant's own database. The control plane holds:

- credentials (only the hash of the token is stored);
- the tenant directory: which user corresponds to which tenant;
- the contents of registry storage (see section 8): the deletion register, the highest sequence number, the restore count, and the markers "restore in progress" and "import in progress";
- the signing keys of handles.

In local mode it is a few files in saveslot's configuration directory; in server mode it is a separate PostgreSQL database. The control plane does not enter the tenant's log and is not exported with the tenant.

### The calling context: the real boundary between the kernel and the outside

When the service layer calls `ops`, besides the parameters of the operation itself it hands the kernel a **calling context**. Everything the kernel knows about "the outside world" is in it:

| Field | Meaning |
|---|---|
| `tenant` | Which tenant the operation is on |
| `actor` | The principal, already authenticated; for a background task it is `system` |
| `trigger` | Present only for a background task: which task it is |
| `task` | The task identifier the agent reports about itself; may be absent |
| `visibility` | Which data this call can see: "all", or a list of slots. The user themselves and a connection with no limited range get "all"; when the credential is limited to some slots, it is those slots, and slots outside the range are, to it, the same as nonexistent. The shape of the interface leaves room for tables and fields; the first version uses only the slot level |
| `request_key` | The request key of this operation, used for "exactly once" |
| `idempotency_window` | How long a repeated request still counts as the same one |
| `now` | The current instant. Taken once by the service layer at the entry point; the kernel itself does not read the clock |
| `confirmation` | The confirmation record when resolving an item |

This context is read-only and can be serialized as a whole into one piece of data. This design has two purposes: the kernel depends on no "environment", so the same events with the same context always give the same result; and when a host written in another language wants to use saveslot in the future, it can pass the context unchanged across the process boundary to the kernel.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §4 "The calling context of `ops`", §5.

## 6. What an event looks like

Chapter 2 described the log in one sentence. Here the events of **write #25 (the correction of lunch)** are laid out in their real shape. The full field-level definition is in the event format specification [`../spec/09-event-format.md`](../spec/09-event-format.md), which is frozen before the first public release and only grows after that; what follows is one instance of it.

> Skipping hint: the first half of this section (the event header, the basic shape of content blocks, where `apply` puts things) needs only the first three chapters. The `span` blocks on state tables, the block dependency index, and the last subsection, "After the content is deleted", use concepts that chapters 7 and 8 develop; on a first read you can skip those places, go straight to section 7, and come back after chapter 8.

To recall, this write appended four events:

| Seq | Type | What it is |
|---|---|---|
| #25 | `write.head` | The logical write head, the head event of this operation |
| #26 | `source.recorded` | Source data `s_2` |
| #27 | `write.base` | Base write: the amount of the lunch row |
| #28 | `write.derived` | Derived write: the monthly total |

Other operations have other event types, and their shapes are all in the event format specification. Two of them come up again later in this guide: when an operation changes the **premises** of some rows (chapter 5, section 6), the operation has one more event, the premise change event `premise.changed`, which records which declarations turn to "changed" and which turn back to "unchanged"; when an export is loaded into an empty tenant, the events of the export are appended unchanged, and then one import event, `tenant.imported`, is appended (section 8).

### The event header

The event header of each event has only a few common fields. The header of #27:

```json
{"actor":"ci_01A…","at":"2026-11-10T04:41:07.123Z","op":25,"prev_hash":"9f2c…e1","seq":27,"slot":"sl_4KTZ…","type":"write.base","v":1}
```

| Field | Meaning |
|---|---|
| `seq` | The position of this event in the log |
| `v` | The format version of this kind of event |
| `type` | The event type |
| `actor` | Who did it: the internal ID of connection A |
| `at` | The recorded time, always in UTC |
| `op` | Which operation it belongs to: 25. The head event #25 does not have this field itself; "no `op`" means it is a head event |
| `slot` | Which slot it belongs to (internal ID) |
| `prev_hash` | The hash of the event header of the previous event (#26) |

Note what is **not** in it: no amount, no word "lunch", no table or row, no intent, and no hash computed from any content. The event header only says "A appended a base write in this slot at this moment, belonging to operation 25".

The event header is encoded into bytes in a deterministic JSON form (RFC 8785, JCS for short): the same object always encodes to exactly the same bytes, so the hash is stable. The hash algorithm is SHA-256.

### Content blocks

The content is a set of blocks. Each block has an address: the sequence number of the event it is in, plus a **path**, such as "`fields/f3/0` of event #27". The path contains only fixed words, internal IDs and indexes, and no user content, so the address itself can safely be written into other events (a deletion event states which blocks to empty by listing these addresses).

Blocks are of two kinds, marked in the "Kind" column in the tables below:

| | What is in it | When deleted |
|---|---|---|
| **Data block** (data) | User content, or something computed from it: the original words, the value of a field, the provenance of a field, the request key | It remembers which source data it comes from; when that source data is privacy-deleted, the whole block is emptied |
| **Metadata block** (meta) | Only internal IDs, fixed enums, sequence numbers | Not deleted in the first version |

The smallest unit of deletion is one block; there is no "delete a part of a block". Content that needs to be deleted separately is cut into different blocks from the start.

Content blocks of **#25, the logical write head**:

| Path | Kind | Content |
|---|---|---|
| `ctx` | meta | The time and versions used for judgement: `{"now": "2026-11-10T04:41:07.123Z", "today": "2026-11-10", "ruleset_version": 1, "policy_version": 1, "literal_checker": "literal@1"}` |
| `request` | meta | `{"sv": 1, "sv_basis": "explicit", "op_count": 1}`: the schema version the request carried, whether it was brought by the agent or taken by the kernel as a fallback from the read record, and how many ops the request has in all. When syncing by external key, an op where nothing changed does not enter an event and leaves an empty number in `ops/<i>`, so the total is recorded separately |
| `ops/0/target` | meta | `{"table": "t1", "row": "r_01JC…", "intent": "correct", "ver": {"op": 21, "restore_count": 0, "basis": "explicit"}}` |
| `ops/0/set/f3` | data | The value as A passed it: `{"value": "54", "unit": "CNY"}` |
| `request_key` | data | The request key computed from "connection + task + request content" |

Content blocks of **#26, the source data**:

| Path | Kind | Content |
|---|---|---|
| `target` | meta | The internal ID of this source (written `s_2` externally), and its kind: the user's own words |
| `text` | data | The original text: "No, lunch was 54 yuan" |

Content blocks of **#27, the base write**:

| Path | Kind | Content |
|---|---|---|
| `target` | meta | `{"op_index": 0, "table": "t1", "row": "r_01JC…", "intent": "correct", "cause": "request", "sv": 1}` |
| `fields/f3/0` | data | The contribution of this write to the amount: `{"status": "applied", "value": {"value": "54", "unit": "CNY"}}` |
| `sources/f3/0` | data | The value source of the amount: `[{"kind": "value", "source": 26}]`, pointing to source #26 |
| `literal/f3/0` | data | The record of the literal match: `{"segments": [{"source": 26, "result": "hit"}]}` |

A few notes:

- **`t1` and `f3` are internal IDs.** `t1` is the `expenses` table and `f3` is the `amount` field. No names appear in events, so a rename does not affect old events, and after a deletion nobody can tell what the field was called.
- **The value as passed and the value as applied are each recorded once, in two different events.** The write head records what the agent said (the original number and unit); the base write records the value as applied after the kernel's conversion and rounding. In this example the two are the same; if the agent had passed another unit of the same kind, they would differ. The literal match compares the original value, because the evidence is written in the original form.
- **The contribution of a field is recorded by segment; the `0` at the end of the path is the segment index.** On a table like `expenses` a field has only one segment, and the index is always 0. On state tables (chapter 7), a field can get different results by time segment within one write: an earlier segment is only a corroboration and a later segment becomes a candidate; when a write is undone, a field may also have to be restored to several different old values. Each segment has its own status, value and valid interval, so they can be deleted separately. On state tables, the valid interval of a segment is kept in a separate block `span/<field>/<index>`: the endpoints of the interval are often not what this request said itself, but computed by the kernel from other writes (for example "until the next change" stopped at the start of another write). This block records which other writes it used; when those writes are privacy-deleted, this block is cleared with them, otherwise the deleted dates would remain in other people's events (chapter 8).
- **`status` is the status in effect of this segment.** There are four: `applied` (in effect), `candidate` (a conflict candidate), `awaiting` (high-impact, awaiting confirmation), `corroborated` (the value did not change, only a source was appended). The write in chapter 2 where A became a candidate has `"status": "candidate"` in #39.
- **A no-op field has no block in the base write.** A field whose value did not change and which points to no evidence does not count as a change of this write (chapter 5): it leaves only its field ID in `ops/0/noop` of the write head, and its value is left nowhere in the log. The reason is in chapter 8: this value was read back from saveslot by the agent and carried along unchanged, so keeping a copy would amount to leaving a copy of deleted content.
- **It does not record "what it was before the change", nor the whole row after the change.** Chapter 2 explained why.
- **The request key is a data block, not in the event header.** It is computed from the request content, so it counts as content (chapter 3, section 4).
- **Premises are also recorded in the write head.** This write declares no premises; if it did, each declaration would add a block `ops/<i>/premises/<j>` in the write head, holding only the internal ID of the target row, the field ID and the version seen; it is a metadata block and does not record the value of the premise.
- **The version numbers and times used for judgement are recorded.** `ruleset_version` and `policy_version` are the rule version and policy version from section 3; `now` and `today` are the time taken at the entry point and its date in the slot's time zone. Replay uses these recorded values and does not read the clock.

### Where `apply` puts it

`apply` takes #27, sees that the status of `fields/f3/0` is `applied`, and changes these internal tables accordingly (all are (b) materialized state from chapter 3, which can be rebuilt from the log if lost):

| What is changed | To what |
|---|---|
| The physical table of `expenses` | The amount of the lunch row is changed to 54 |
| The version table | The version table records by cell: a new version is added for the amount cell of this row, in effect from operation 25; the previous version of this cell is valid until operation 25. Fields that did not change are left alone. Reading by time depends on it |
| The provenance table | Records "segment 0 of the amount field of write #25, value source is #26, status is applied" |
| The block dependency index | Records which block was computed from which other writes. This write has no such block; the `span` blocks on state tables, the entries of items, and the results recorded by deletion events are registered here, and privacy deletion uses it to find the blocks to clear along with the rest |

When processing #25, `apply` writes the request key into the request key index (pointing to operation 25), and on a resend the original result is returned accordingly. The #28 that follows makes `apply` update the 2026-11 row in `monthly_total`. The four events and the changes to these tables are committed in the same transaction. The `ver` of this row becomes `v25.0`.

If the status of this segment were `candidate` or `awaiting`, `apply` would not change the business table or the version table; the event would stay only in the log, for looking up history, handling items and replaying deletions.

A correspondence between two names: the physical name of a business table carries the schema version number (of the form `t_<table ID>_v<version>`), so when a table's structure changes, a new version of the table can be built next to it and then switched atomically once it is built. These physical names appear only inside the kernel; agents and SQL always use names like `expenses`.

### After the content is deleted

Suppose `s_2` was later privacy-deleted and the deletion has come due (case one in chapter 2). The four events of this write become:

- **Event headers**: all four are still there unchanged, so the chain is not broken.
- **Data blocks that were emptied**: `text` of #26; `fields/f3/0`, `sources/f3/0` and `literal/f3/0` of #27; `ops/0/set/f3` and `request_key` of #25; `checksum` of #28. Each block leaves a mark "removed by #44" at its original place; #44 is the tombstone event.
- **Why #28 is included**: the derived write stores a check value, computed from the base data it read, which includes that 54. The value used to compute it was deleted, so this check value must also be cleared, otherwise a guessed amount could be compared against it. By the same reasoning, the check values of the two later derived writes (#32 and #36) that recomputed the November total and read the 54 are also cleared. The other block of #28, `key` (the group key "2026-11"), stays: the month comes from the date in `s_1`, and `s_1` was not deleted. This is what "the check information of derived data is removed along with its inputs" means.
- **Metadata blocks that remain**: `ctx`, `request` and `ops/0/target` of #25, `target` of #26, `target` of #27, `target` of #28.

When replay later reaches #27, `apply` sees that `fields/f3/0` has been removed and treats this block as nonexistent.

What this row should look like after the deletion is not computed during replay: the event that confirms the deletion (#42) already has the result written in (the amount goes back to 45, and the provenance points to the contribution of #23), and `apply` applies it as written. If other writes have a changed result because of this deletion (for example an earlier candidate now took effect, or the end point of a write's "until the next change" changed), #42 also writes down their new results item by item, and from then on the most recently written one holds (chapter 8). Which blocks the results recorded in events are, and what shape each has, is in [`../spec/09-event-format.md`](../spec/09-event-format.md) section 5.9.

Specification: [`../spec/09-event-format.md`](../spec/09-event-format.md) (section 2, the event header; section 3, content blocks; section 4, the events of one operation; section 5.7, write events); for which tables the tenant storage has, see [`../spec/02-architecture.md`](../spec/02-architecture.md) §8 "Storage format v1".

## 7. How the process runs

### One service process

The saveslot service is **one process**; HTTP, MCP and the scheduler of background tasks are all inside it.

The kernel is written in TypeScript. TypeScript is JavaScript with type checking; running it needs a JavaScript runtime, and saveslot uses Node (it could also be Bun; the two are the same kind of thing, like the JVM that a Java program needs).

Why this technology stack: PGlite, the database used in local mode, can run only inside a JavaScript runtime (see below). This is an implementation choice inside saveslot and has no effect on agents; an agent only connects to this process through MCP or HTTP.

### The single writer

**For the storage of one tenant, only one process may write at a time.** Two processes writing the same data at the same time would corrupt it. saveslot uses two safeguards:

- **A lock.** A lock is taken when the tenant's storage is opened; another process that cannot get it cannot open the storage.
- **An ownership number.** Each time the storage is opened, a number is incremented by 1 and recorded in the storage; after that every write transaction first checks this number. If it does not match, another process has taken over this tenant, and this process gives it up immediately. This guards against the case the lock does not, for example a process that was stuck for a long time and then recovers without knowing it has already been replaced.

This is also why, in local mode, all agents must access data through the same saveslot service process: the command line tool and the MCP forwarding program never open the data directory directly, and always connect to that process.

How exactly the lock is taken on the local machine has to be confirmed by an experiment (experiment 8 in chapter 12).

### Writes within each tenant are serial

The writes of one tenant are lined up in a queue, and one finishes before the next starts. The event sequence number `seq` is assigned inside the transaction, so the order of sequence numbers is the order of commits.

Serial execution sounds slow, but it suits saveslot: a tenant is one person's data, and the write rate is "the speed of a person talking"; and what serial execution buys is that conflict judgement, derived refresh and the `ver` check do not need to handle concurrency, so the rules are simple and the results are deterministic. Different tenants do not affect each other.

When a background task needs to write data, it goes through the same queue as foreground writes.

### The recorded time never goes backward

The event header of each event has a recorded time. It takes the later of "the current time the service layer took at the entry point" and "the recorded time of the previous event". So even if the computer's clock is set back, the time of a new event is never earlier than that of an old event; the order of events is always decided by the sequence number. When the clock is clearly earlier than the end of the log, saveslot gives a warning but does not refuse the write, because it has no way to know which clock is right.

### PGlite lives in a dedicated worker

**PGlite** is PostgreSQL compiled into a form that can be embedded in a JavaScript program: it is not a separate database service, but a library inside the saveslot process, with the data stored in a directory on the local machine. Local mode uses it, so users do not need to install a database themselves.

PGlite has one trait: there is only one connection at a time, and it can do only one thing at a time. So saveslot puts it entirely in a dedicated **worker** (a worker is an independent thread inside the process, with its own memory, communicating with the main thread by messages), and all reads and writes queue through it.

This brings a cost to be aware of: **one very slow query blocks the writes of this tenant**, for as long as the query timeout at most. And the timeout can be implemented only by terminating the whole worker, which amounts to crashing and restarting the database once. So saveslot's main line of defense is placed beforehand: the cost is estimated before a write and a write that is too large is rejected directly; derivation rules and read-only SQL reject costly forms at compile time. Termination on timeout is only the last resort, and whether to enable it depends on the experiment results.

Server mode uses native PostgreSQL and does not have this limit, but the first version likewise lets read-only SQL and writes share one connection and run serially.

### When read records are flushed to disk

Reads are frequent, and writing to disk on every read is too expensive. So read records are kept in memory first and flushed to disk at these moments:

- **When any write transaction starts**, in the same transaction as that write. This guarantees that the `ver` fallback always sees the reads just made.
- **Before the tenant is closed.**
- **Otherwise every few seconds** (initial value 5 seconds).

So they are lost only when the process really crashes, and only the read records of the last few seconds that no write followed.

### No dependence on the process staying up

Some things must be done when their time comes, the most typical being the physical erasure 24 hours after a deletion is confirmed. saveslot does not assume the process is always running: **each time storage is opened, the tasks that have already come due are done first**, and only then does it serve requests.

- Server mode: the scheduler actively opens the tenant at the due time in the deletion register and runs the task, without waiting for the user's next visit.
- Local mode: if the service is running, the task runs on time; if not, it runs first at the next start. The deletion receipt says this honestly.

If a due physical erasure fails (the disk is full, say), saveslot keeps serving as usual and keeps retrying: that content could no longer be read once the deletion was confirmed, and what is postponed is only the step of wiping it from the disk. There is only one case in which it refuses to serve: an old backup was restored and the deletions that must be re-applied are not yet finished. At that point the deleted content can be read.

### A confirmed write must not be lost

A write for which the receipt says "saved" must still be there after a process crash or a power failure. By default, for speed, PGlite does not force data to be flushed to disk; "just turn that switch on" is for now only an assumption, and whether it really meets the bar has to be confirmed by an experiment. This is the experiment placed first in development, and if it does not meet the bar, the backend of local mode will be replaced by native PostgreSQL packaged together with saveslot (see chapter 12).

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §7.

## 8. Two interfaces: tenant storage and registry storage

The kernel depends on only two interfaces for the storage outside it. All its guarantees (K1–K14) are built only on these two interfaces, and do not depend on anything in the service layer.

### Tenant storage

The first requirement is: **"open the storage of a given tenant for me."** The kernel does not care what database is underneath.

What you get after opening is only a few actions:

| Action | Meaning |
|---|---|
| Write transaction | Runs serially; first checks the ownership number at the start |
| Read transaction | Read-only |
| Clean up leftovers | After a physical erasure, clears the places inside the database that may still hold plaintext |
| Format version | The version number of saveslot's own internal tables |
| Close | Flushes the read records to disk first |

Two backends meet this requirement:

| Backend | Used where | One tenant corresponds to |
|---|---|---|
| PGlite | Local mode | One data directory |
| PostgreSQL | Server mode (our cloud service, user self-hosting) | One separate database |

Both backends are PostgreSQL, and this is deliberate: the SQL in the kernel is written only once. But "the same log replays into exactly the same tables on both backends" still does not come for free: it needs a fixed time zone and collation, an exact decimal type for numbers, only functions with deterministic results allowed in rules, and continuous checking by tests (the "replay comparison" in chapter 12).

Which tables the tenant storage has, which of (a), (b) and (c) each belongs to, and which kind of event maintains it: the specification has one single list (see [`../spec/02-architecture.md`](../spec/02-architecture.md) §8 "Storage format v1").

### Registry storage

The second interface holds **what must still be remembered after the tenant storage is replaced as a whole**. The specification calls it "anchor storage" (`AnchorStore`).

Why it is needed: suppose a user deleted a sentence, and later the database broke and was restored from an earlier backup. That backup contains the sentence, and has no record at all that it was ever deleted. If "what was deleted" were recorded only in the tenant storage, it would be turned back along with everything else. So this kind of information must be kept outside the tenant storage:

- **The deletion register**: which deletions are confirmed, when they come due, and the addresses of the deleted content. Only addresses are recorded, not content.
- **The highest sequence number**: up to which number the log of this tenant has been numbered.
- **The restore count**: how many times this tenant has been restored from a backup.
- **The "restore in progress" and "import in progress" marks.**

This interface is implemented from outside: the saveslot service implements it with the control plane (in local mode a file in the configuration directory, in server mode a table in the control database); the kernel's own tests implement it with a file. It must be stored separately from the tenant storage and backed up separately. If the two are restored together, the register also goes back to the past, and the kernel can neither make up for it nor detect it; this is a boundary that is stated explicitly.

How it is used to guarantee that "what was deleted does not come back" is in chapter 8.

### Export and format versions

**Export does not depend on the storage format.** What is exported is the log events themselves, not the database files. Given an export file, replaying it on any backend gives the same state. This is also the technical meaning of "data can be taken away".

**Import can only go into an empty tenant.** When loading an export back, the first version supports only loading it into a tenant that has no data yet, for example moving from local mode to server mode: first check the file with the same checks used to verify the log, then append the events of the export one by one unchanged and hand them to `apply`, and finally append one import event. The writes are not re-executed one by one: that would judge again and assign sequence numbers and IDs again, and the result would not be the same log. Connections that were registered before the import and are still valid are all deactivated (those already revoked stay revoked), and credentials must be issued again in the new place; things that were never in the export, such as read records and credentials, cannot be carried over. Import also increases the restore count by 1, so the item versions and deletion handles obtained before the import no longer match, and items must be viewed again and deletions previewed again. Merging into a tenant that already has data is for later. How to do it is in chapter 11.

**Format versions.** When storage is opened, if its format version is higher than what the current program knows (for example it was written by a newer version and then the older program is switched back in), opening is refused with a prompt to upgrade, instead of risking a write.

Specification: [`../spec/02-architecture.md`](../spec/02-architecture.md) §8.

## Summary

- The core of saveslot is the kernel, the service layer and the operation contract; the surfaces are generated from the contract and can be added or removed.
- Whether something goes into the kernel or the service layer depends on "if it is switched off, is the data still traceable, explainable and recomputable".
- The kernel invariants K1–K14 are rules that cannot be switched off under any usage; judgement rules carry a version, which is recorded in the events.
- The kernel modules are arranged in layers and depend only on lower layers; the module that generates events does not change tables; there is only one implementation of judgement; the transaction is opened by `ops`; the outside can come in only through `ops`, and background tasks are no exception.
- An event = an event header (a few common fields, in the chain, containing no user content) + content blocks (stored by address, where a data block can be emptied as a whole); `apply` changes the materialized state, such as the version table, the provenance table and the business tables, according to it.
- One service process; one writer per tenant at a time, with writes serial; due tasks are done when storage is opened.
- The kernel depends on only two interfaces: tenant storage (PGlite and PostgreSQL are its two implementations) and registry storage.

For how the code is divided into packages and how it is tested, see chapter 12.
