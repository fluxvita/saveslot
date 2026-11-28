# 02 · One example from start to finish

English · [简体中文](../zh-CN/guide/02-walkthrough.md)

This chapter walks through saveslot's main mechanisms with one ledger: recording an expense, correcting it, two agents editing at the same time, and deleting a sentence.

Each step shows three things:

- **The call**: what the agent sent to saveslot.
- **The log**: which events saveslot appended.
- **The tables**: what the data looks like when queried.

Keep one thing in mind; every step that follows confirms it: **the log is the fact, and the tables are computed from the log.** For every event appended, a function inside saveslot called `apply` writes it into the tables, and the event and the table changes are committed in the same transaction.

> How to read this chapter
>
> - Operation names and parameter names in the calls follow the operation contract (the rules are in [`../spec/04-contract.md`](../spec/04-contract.md), the type definitions in [`../spec/04-contract-types.md`](../spec/04-contract-types.md)). Through MCP, the tool name is the operation name with a `saveslot_` prefix (`write` → `saveslot_write`).
> - Event numbers and structure follow the event format specification ([`../spec/09-event-format.md`](../spec/09-event-format.md)). To keep the main line clear, the tables list only "what each event records", not the field-level shape; chapter 4 expands one of these events in full.
> - **How numbers are written.** `#27` or "event #27" means the 27th event in the log. "Write #25" means the write whose write number is 25; in the log it is a run of consecutive events (#25–#28). Step 1 explains what a write number is. The whole guide uses this notation.
> - **How identifiers are written.** Identifiers for rows, items and the like are long strings that saveslot assigns; the examples show only the first few characters followed by an ellipsis (`r_01JC…`, `pi_7C…`). The two sources are abbreviated as `s_1` and `s_2` so they are easy to tell apart; real source identifiers are also long strings.
> - This chapter describes the complete design. Wherever the first version does not do something, it is marked on the spot; the full list is in [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md).

## Setup: a ledger

The user has a **slot** (a set of related tables) called `ledger`. Its schema has two tables:

| Table | Kind | Fields |
|---|---|---|
| `expenses` | base table, agents can write | `date` (the date, required), `category` (the category, required), `amount` (the amount, unit CNY, required), `note` (a note, optional) |
| `monthly_total` | derived table, read-only | Sums `expenses.amount` by month. The summing rule is written in the schema and executed by saveslot |

The user works with two agents on the same computer, each with a credential issued by saveslot, called a **connection** in saveslot:

- A: `MacBook · Claude Code`
- B: `MacBook · Codex`

The first time an agent touches this slot, it calls `catalog` to see which tables, fields and units exist. The result carries the slot's current schema version `sv: 1`, which the agent passes back on later writes.

The log of this ledger already has 20 events, so the numbers below start at #21. The first 20 were left over from October: #1 creates the data of this user (the "genesis" event); #2–#6 create the `ledger` slot (submit the schema, compile it, take effect, write the slot's default settings, switch to version 1); #7 and #8 are one event each, registered when the credentials for A and B were issued; #9–#20 are the three expenses A recorded in October, 4 events each. October's expenses count toward October's total and do not affect the November numbers below. What these events are is covered in chapters 3, 9 and 11; you do not need to know it here. A table of all the numbers is at the end of this chapter.

## Step 1: record an expense

The user says to A: "I spent 45 yuan on lunch today."

**The call.** A understands the sentence, fills in the values according to the schema, and calls `write`:

```json
{
  "sv": 1,
  "evidence": [
    { "kind": "user_message", "text": "I spent 45 yuan on lunch today" }
  ],
  "ops": [
    {
      "intent": "insert",
      "table": "expenses",
      "set": {
        "date": "2026-11-10",
        "category": "Dining",
        "amount": { "value": "45", "unit": "CNY" }
      }
    }
  ]
}
```

Besides the `sv` it passes back, A fills in only four things: the intent (`insert`, add), the table, the values and the evidence. The evidence is the user's original sentence, excerpted from the conversation. saveslot fills in the rest: who wrote it (derived from the credential), which slot it belongs to (derived from the table), the row ID and the recorded time.

**The log.** saveslot checks the types, units and ranges, finds no problem, and appends four events:

| Number | Event | What it records |
|---|---|---|
| #21 | logical write head | The request itself: the parameters exactly as A submitted them, the request key used to prevent duplicate submissions, the time used for judgement |
| #22 | source `s_1` | The original sentence "I spent 45 yuan on lunch today", of kind user message |
| #23 | base write | Adds one row to `expenses`: the value of each of the three fields this request involves, and **the provenance of each field**: `date`, `category` and `amount` all come from `s_1` |
| #24 | derived write | Recomputed the 2026-11 row of `monthly_total` by the rule |

Four points are worth noting:

- **A write has one "head", and the head's number stands for the write.** #21 is the first event of this write, called the **logical write head**, one per request. Its number, 21, is the write's **write number** (more generally, the **operation number**). Whenever saveslot refers to "which write" outside, it uses this number: the number in a receipt, the version mark and the number in history are all it. The numbers of #22–#24 are used only inside the log.
- **The original sentence is itself an event.** saveslot stores the evidence that comes with a write as **source data**. If the agent brought no evidence, saveslot stores the request itself as source data. So every write in the log can be traced to a source, without exception.
- **Provenance is recorded per field.** It is not "this row comes from this sentence" but "this row's date, category and amount each come from this sentence". Deletion later shows why it has to be this fine-grained.
- **The derived table is not written by the agent.** A wrote only `expenses`; the monthly total is computed by saveslot from the rule in the schema, in the same transaction as this write.

During the write, saveslot also records the result of one mechanical check, called the **literal match**: whether the written value appears literally in the original evidence text ("45 yuan" appears; "today" does not equal 11-10). In the first version it is only recorded, not used; chapter 5 covers it.

**The tables.**

`expenses`:

| Row | date | category | amount | Version |
|---|---|---|---|---|
| Lunch | 2026-11-10 | Dining | 45 CNY | `v21.0` |

`monthly_total`:

| Month | Total |
|---|---|
| 2026-11 | 45 CNY |

**The receipt.** `write` returns `status: "saved"`, the write number of this write `seq: 21`, the ID of this row and its version mark `ver: "v21.0"`, plus the affected derived values (the monthly total becomes 45).

A is connected through MCP (MCP is the general protocol for agents to call external tools, mentioned in chapter 1), so what it actually receives is a piece of text. In this version the agent receives English text (the Chinese edition writes it in Chinese). The untrusted-data lead line and the tags around strings are left out here (see chapter 6, section 7):

```
Saved · ledger schema v1 · #21
ledger.expenses r_01JC… insert: date 2026-11-10; category Dining; amount 45 CNY (ver=v21.0)
Derived: ledger.monthly_total (month 2026-11-01): total — → 45 CNY
```

The first line is the status, the slot and schema version, and the write number; then, for each operation, its target, intent, the result for each field and the new `ver`; last, the affected derived values: one line per derived row, first the derived table and its group key (here the field `month`, whose value is the first day of the month), then each field that changed with its values before and after, "—" where there was no value before. The `…` is only for layout: in the real text the ID and the version mark are complete, because the agent must pass them back unchanged later. The exact wording follows the samples in the implementation; these elements are fixed.

**What `ver` is, and why it exists.** It solves this problem: two agents both read the same row and each edits based on what it read; the later edit must not quietly overwrite the earlier one. It works in three steps:

1. **You get it when you read.** Every row has a `ver`, carried in read results and write receipts. In `v21.0`, 21 is the operation number of the operation that last changed this row; the number after the dot is normally always 0; chapter 3 says what it is and chapter 11 says why it is needed.
2. **You pass it back unchanged when you edit.** It means "I made this change looking at the state after write #21."
3. **saveslot compares.** If what you pass back is the current version, the write takes effect directly. If it is not the current version, someone changed the row in between. saveslot does not simply reject it; it looks field by field: if nobody touched the fields you want to change, the change is merged and takes effect; only if someone changed them is there a conflict. Step 3 demonstrates this.

This is the "optimistic concurrency control" common in databases: no locks, with the check made at write time. What is different in saveslot is that when the versions do not match, it judges field by field, and even on a real conflict it does not lose the later value.

When an agent forgets to pass `ver`, saveslot uses the version of this row that this connection read most recently, and says so in the receipt; if the connection has never read this row, it rejects the write and tells the agent to read first.

## Step 2: a correction

A little later, the user says to A: "No, lunch was 54 yuan."

**The call.** A first finds the row to change: it calls `query` for the expenses of 11-10 and gets the row ID and `ver: "v21.0"`. Then it calls `write`:

```json
{
  "sv": 1,
  "evidence": [
    { "kind": "user_message", "text": "No, lunch was 54 yuan" }
  ],
  "ops": [
    {
      "intent": "correct",
      "table": "expenses",
      "row": "r_01JC…",
      "ver": "v21.0",
      "set": { "amount": { "value": "54", "unit": "CNY" } }
    }
  ]
}
```

Compared with step 1 there are three differences:

- **The intent is `correct` (a correction).** It means "the original value was wrong to begin with", as opposed to `update` (the situation changed or was supplemented). For the table the two are the same: both change one value into another. The difference is **whether the old value was right at the time**, which decides whether tasks that read the old value earlier are affected:
  - A change: the user moves an expense from the category "Dining" to "Entertainment". Before the change, some agent made category statistics with it under "Dining"; that statistic was not wrong at the time.
  - A correction: lunch was actually 54, not 45. Before the correction, some agent read 45 and computed a reimbursement amount; that result is wrong, and someone needs to know.

  So a correction (and, as described later, a revoke) makes saveslot look up "who read that wrong value" and notify them (see the receipt below); a change does not. Without the distinction, either every value change would trigger a notice, so many that nobody reads them, or none would, and wrong results would leak out unnoticed. Only the agent can tell from the conversation whether "it was recorded wrongly" or "the situation changed"; saveslot cannot, so the agent must state it explicitly.
- **It carries a row ID and a `ver`.** The row ID says which row to change; `ver` says "I made this change based on this version".
- **It gives only `amount`.** This correction concerns only the amount; the date and category do not appear in the request.

**The log.**

| Number | Event | What it records |
|---|---|---|
| #25 | logical write head | This request: the intent is a correction, the target is the lunch row, the version passed back is `v21.0` |
| #26 | source `s_2` | The original sentence "No, lunch was 54 yuan" |
| #27 | base write | Field `amount`: value 54, in effect, provenance `s_2` |
| #28 | derived write | Recomputes the monthly total of 2026-11 |

#21–#24 are untouched. A correction does not change history; it appends new events.

Note that #27 records only the one field this request involves. It does not record "what it was before the change", nor the whole row after the change: the value before the change is already in earlier events, and every extra copy stored means one more place to clean when a deletion has to be complete. "What the row looks like after the change" follows from the earlier state plus the fields that take effect in this write.

Also, the `query` A made just now was recorded too: which connection, when, and which version of this row it read. This **read record** does not go into the log; it is stored separately and records only version numbers, not the values read.

**The tables.**

`expenses`:

| Row | date | category | amount | Version |
|---|---|---|---|---|
| Lunch | 2026-11-10 | Dining | 54 CNY | `v25.0` |

`monthly_total`: 2026-11 = 54 CNY.

The provenance of each field of this row now is:

| Field | Current value | Provenance |
|---|---|---|
| `date` | 2026-11-10 | `s_1` (write #21) |
| `category` | Dining | `s_1` (write #21) |
| `amount` | 54 CNY | `s_2` (write #25); the 45 before it came from `s_1` (write #21) |

**The receipt.** `status: "saved"`; write number 25; amount 45 → 54; monthly total 45 → 54; new `ver: "v25.0"`. Because the intent is a correction, saveslot also checks the read records: before the correction, did any other task read 45? If so, the receipt gives the number of affected reads, and those connections will also be notified the next time they read the related data. The read that A itself made in order to make the correction does not count.

**Three questions can now be answered** (call `history` to see them): it is 54 now; it was 45 originally and was corrected by A in write #25; the 45 comes from "I spent 45 yuan on lunch today" and the 54 from "No, lunch was 54 yuan".

## Step 3: two agents edit at the same time

To avoid complicating the history of the lunch row, this step uses a different row.

The user says to B: "The taxi cost 30 yuan." B writes it as in step 1:

| Number | Event |
|---|---|
| #29 | logical write head (write number 29) |
| #30 | source `s_3`: "The taxi cost 30 yuan" |
| #31 | base write: adds the taxi row, amount 30 |
| #32 | derived write: monthly total 84 |

After that, both A and B have read this row, and the `ver` each holds is `v29.0`.

**B edits first.** The user says to B: "The taxi was actually 35 yuan." B corrects it with `ver: "v29.0"`. The version matches, so it takes effect directly:

| Number | Event |
|---|---|
| #33 | logical write head (write number 33) |
| #34 | source `s_4`: "The taxi was actually 35 yuan" |
| #35 | base write: correction, amount 35, in effect |
| #36 | derived write: monthly total 89 |

The version of this row becomes `v33.0`.

**A edits later, still holding the old version.** In another window, the user says to A: "The taxi was 32 yuan." A has not read again; it sends a correction with `ver: "v29.0"`, changing the amount to 32.

**How saveslot judges.** The version A brought is not the current version, which means someone changed this row after A read it. saveslot neither rejects it outright nor overwrites. It understands A's write as "relative to the `v29.0` version, here is what I want to change", and then compares **field by field**: for the fields A wants to change this time, has anyone else changed them since `v29.0`?

- `amount` was changed by B in write #33. There is an overlap, so this is a conflict.
- Suppose A's request also changed `note` in passing, and nobody had touched `note`: that field would take effect directly. One write can have some fields take effect and others become conflicts.
- Suppose A's request passed `date` back unchanged (the same value as on the `v29.0` it read): that is not a change by A, and saveslot treats it as a no-op, so it does not create a conflict.

For the conflicting field, saveslot handles it as follows:

1. **A's value is recorded as a "candidate" and does not take effect.** The current value is still the 35 that B wrote. The rule is deterministic: keep the current value, that is, the one committed first.
2. **A pending item is created**, of type conflict, whose target is "the `amount` field of the taxi row", recording the current value, the candidate value and who wrote each. Conflict items are counted per conflict unit (a field, or a field group the schema declares): if A had conflicted on two fields not in one group, there would be two items, each handled separately.
3. **The row is marked "disputed"**, and the mark says which item and which field.

> In the complete design, if the candidate has a higher source level (for example, one side is something the user said in person and literally matches, and the other is only the agent's inference), saveslot lets the higher-level one take effect directly by rule. The first version does not do this; it always keeps the current value.

**The log.**

| Number | Event | What it records |
|---|---|---|
| #37 | logical write head | Write number 37; the version passed back is `v29.0` |
| #38 | source `s_5` | The original sentence "The taxi was 32 yuan" |
| #39 | base write | Field `amount`: value 32, state **candidate**, provenance `s_5` |
| #40 | pending item created | Conflict item `pi_…`: current value 35, candidate 32 |

There is no derived write, because the value in effect did not change. The `ver` of this row did not change either; it is still `v33.0`.

**The tables.** The taxi row's amount is still 35, with the "disputed" mark. The monthly total is still 89.

**The receipt.** What A receives is `status: "pending"`, not an error. The receipt says: `amount` became a candidate, the value in effect is 35, and gives the corresponding item ID and item version `item_ver`. The text A receives is:

```
Recorded, not in effect · ledger schema v1 · #37
ledger.expenses r_01JD… correct: amount not in effect (see below) (ver=v33.0)
  amount: at the version you gave (#29) it was 30 CNY; now it is 35 CNY, set by MacBook · Codex (#33), ver=v33.0. Your value 32 CNY did not take effect: it is a candidate in conflict item pi_7C… (version iv_2d…); the value in effect stays 35 CNY.
  Tell the user this was not done: MacBook · Codex changed the record (#33) after the version you gave; ask what they want before resolving.
  To resolve: saveslot_resolve pi_7C… (keep_effective / take_candidate / take_previous)
```

It states several things in full: what it was at the version A gave (as it stood after write #29), what it is now, who changed it in which write, that A's value did not take effect, and in which item it is recorded. ("The version A gave" is the version A read, provided A honestly passed back the ver it read.) The separate line is an instruction to A: tell the user this was not done and who changed it, and ask them before resolving. A is in the middle of a conversation with the user and can tell them the situation right away.

**Why it is designed this way.** saveslot cannot assume there is a way to notify the user proactively, nor that the user will respond promptly. So a conflict is made a **persistent state**, not a one-time error:

- It never blocks. While the conflict exists, reading this row returns a definite value (35) plus the "disputed" mark, and the reader decides for itself whether to go on.
- It is never lost. Any agent that reads this row later will see the mark and can remind the user.
- It does not expire. saveslot has no judgement and does not rule on behalf of people; the item stays until someone handles it. Even if an agent that has not seen this item changes this field again later, the item is only updated and is not quietly closed (chapter 5 covers this).

**Resolving.** A tells the user the situation, and the user says: "35 is right." A calls `resolve`:

```json
{
  "id": "pi_…",
  "decision": "keep_effective",
  "item_ver": "iv_…"
}
```

`item_ver` is the item version A got from the receipt; it means "what I confirm is the content I saw". If the item changed in the meantime (for example, another candidate was added), the version no longer matches, and saveslot rejects the call and returns the current content, asking for the confirmation to be redone.

| Number | Event | What it records |
|---|---|---|
| #41 | pending item resolved | The decision is to keep the current value; the confirmation record: who resolved it, through which credential |

The "disputed" mark is removed, and the amount stays 35. The other two decisions are:

- Take the candidate (`take_candidate`): 32 takes effect. When the item has several candidates, `candidate` says which one.
- Take the previous value (`take_previous`): go back to the value of the version before either side changed anything, which here is 30.

**Note: both the creation and the resolution of a conflict are log events.** If they were recorded only in some table, then dropping the table and rebuilding from the log would make the conflict disappear.

## Step 4: deleting a sentence

> The privacy deletion covered in this step (preview, confirm, a 24-hour grace period with the option to cancel, and physical erasure at expiry) is not provided yet in 0.2.0; a later version provides it (section 7 of [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md)). The first three steps can all be followed along in 0.2.0.

saveslot has three kinds of "deletion", with different meanings:

| Request | What the user wants | Effect |
|---|---|---|
| Revoke a row | This record should not exist ("that entry is a duplicate") | An ordinary write (intent `revoke`). The row is marked revoked; the history and the original sentences are kept |
| Evidence deletion | This original sentence should not be kept, but the data can stay | Deletes only the original text; the values stay |
| Privacy deletion | Forget it entirely | Both the original text and the values derived from it are dealt with |

> The first version does only revoke and privacy deletion (by source data), and does not do evidence deletion.

What follows is about privacy deletion. It has one definition, and every result follows from it:

> **The state after a privacy deletion = the state obtained by replaying the log from the beginning as if the deleted source had never existed.**

(The definition also has two deliberate deviations and one limit on its scope; chapter 8 covers them.)

Back to the lunch row. It has two sources: `s_1` (the original sentence; write #21 gave the date, category and amount 45) and `s_2` (the correcting sentence; write #25 changed the amount to 54). The three cases below are independent of each other, and all start from the state at the end of step 3.

Here we assume the user has given A the permission to delete. The permission to delete is not given by default; it must be ticked explicitly when the credential is issued (chapter 11).

### Case 1: delete the correcting sentence (`s_2`)

**The call has two steps: preview first, then execute.**

Why two steps: the consequences of a privacy deletion are often not intuitive (case 2 shows "delete one sentence and the whole row is gone"), and letting an agent or the user execute directly could easily delete something unexpected. So a **trial calculation** comes first: it tells you what would happen if you deleted, but deletes nothing.

**First step, preview.** A calls `deletion_preview` (through MCP, the `deletion_preview` mode of the `saveslot_sources` tool), with the parameters: kind privacy deletion, target `s_2`. saveslot computes the result as if `s_2` had never existed, and returns:

- The totals: 1 source deleted, 1 row affected, 1 derived value recomputed;
- The result for each row, with the reason: the lunch row's **amount goes back to 45**;
- Writes that were not in effect and would take effect because of this deletion (none here);
- What will not be deleted (for example, external files that saveslot does not hold, and metadata that remains after deletion);
- A confirmation handle `dc_…`.

**Second step, execute.** A tells the user the preview, and once the user agrees, A calls `delete` with only that handle as the parameter.

The handle's job is to tie what was seen to what is executed. It is bound to the content of that preview and to the log position at the time; if, after the preview, another write touches the scope of the deletion, the handle no longer matches, and saveslot refuses to execute and gives a new preview, asking for confirmation again. This way it cannot happen that the user agrees to one result and a different one is actually deleted. The handle is valid for 10 minutes; if it expires, preview again.

**Why it goes back to 45.** If "No, lunch was 54 yuan" had never been said, write #25 would have no amount to give, and on replay the last provenance of the amount is the 45 from write #21.

**The log.**

| Number | Event | What it records |
|---|---|---|
| #42 | deletion confirmed | The computed result: what the lunch row looks like after the deletion (amount 45, provenance `s_1`); the expiry time; the content at which locations is to be physically erased at expiry |
| #43 | derived write | Monthly total 89 → 80 |

Note that "what it looks like after the deletion" is computed at the moment of confirmation and written into the event. `apply` only changes the tables as the event says and makes no judgement of its own.

**The tables.** The lunch row's amount becomes 45, `ver` becomes `v42.0` (42 is the operation number of this deletion confirmation); the monthly total is 80. The original text of `s_2` can no longer be read from this moment on.

**The 24-hour grace period.** Within 24 hours after confirmation, this deletion can be cancelled: call `resolve` and choose `cancel` for the item that belongs to this deletion. The item does not record a separate event: the deletion confirmation (#42) itself opened it, and the item ID is the ID of this deletion, given in the receipt. After the cancellation, the amount goes back to 54. A deletion within the grace period only makes the content "unreadable"; the content is still there.

**Expiry.** After 24 hours (noon on November 11; nothing else happened in between, so it is #44), saveslot appends an "expired physical erasure" event (also called a **tombstone**) and really wipes the content:

- The original text of `s_2` (in #26);
- The amount value given by write #25 and its provenance (in #27), and the value A submitted unchanged (in #25);
- Everything else computed from this sentence, for example the request key in #25 (it is computed from the request content; why it also counts as content is in chapter 3, section 4), and the checksum of the monthly total in #28.

Each wiped location is left with a marker "removed by #n", which contains no content.

**What remains.** The **event headers** of events #25–#27 are still there: number, type, who did it, when, which operation they belong to. A few records that contain no content also remain: which row of which table this write targeted (both internal IDs), and that the intent was a correction. So it can be seen that "A made a correction to this row at some time, and it was later deleted", but not what the correction was. Storing the event header and the content separately is exactly for this: the log is append-only and the chain must not break, but the content must be truly deletable.

### Case 2: delete the original sentence (`s_1`)

The preview result may be unexpected: **the lunch row is deleted entirely.**

Looking step by step at "as if `s_1` had never existed":

- The date, category and amount 45 given by write #21 are all gone.
- Write #25 is still there, but it gave only one value: the amount 54.
- The row now has only an amount, with no date and no category. These two are required fields, and for a row to exist, every required field must have a source that is still there. So the row does not hold.

Why can it not keep a row with "only the amount", or keep the date and category?

- The date and category came from the deleted sentence. Keeping them would mean the deletion was not complete.
- A row with only an amount and an empty date and category violates the table's required constraints and is meaningless.

`s_2` ("No, lunch was 54 yuan") was not itself asked to be deleted, so its original text is still in the source data; but the correction it belongs to has no row to land on, so it produces no data. The monthly total goes from 89 to 35.

**The preview spells out the reason**: this row will be deleted entirely, because the date and category came only from `s_1`; the amount has another provenance from write #25. Seeing this, the user has two paths:

- **Really wants to forget this expense entirely**: delete `s_2` along with it; see case 3.
- **Only wants to delete this sentence but keep the record**: first give the date and category another source (called **corroboration**), then delete.

**What corroboration is.** It gives a value a second source. Write #25 gave only the amount, so the date and category have only one source, `s_1`. Suppose that when correcting, the user had said "That dining expense on November 10 was actually 54 yuan": that sentence by itself proves the date and the category; if A states at write time that "the date and category also come from this sentence", those two fields each gain one more source, `s_2`, and after `s_1` is deleted they still stand and the row is kept. If that sentence mentioned only the date and not the category, the category would still have only one source, `s_1`, and the row would be deleted entirely all the same; every required field needs a source of its own. How to state it, a complete example that works, and why "passing the value back unchanged" does not count and it must be stated explicitly, are in chapter 5, section 5.

### Case 3: forget the expense entirely

The user's intent is "this entry never existed". Then **all** the sources of this row must be removed, including `s_1`, which inserted it, and `s_2`, which changed it later.

In the complete design, `deletion_preview` can specify by row directly (the parameter `rows`), and saveslot itself finds all the sources of this row.

> The first version does not do deletion by row. In the first version, list both `s_1` and `s_2` as deletion targets; the effect is the same.

Result: the whole row is deleted, both original sentences are deleted, and the monthly total is 35.

One property in passing: deleting `s_1` and then `s_2`, deleting `s_2` and then `s_1`, and deleting both at once all give exactly the same result. Because the result is decided only by "which sources do not exist", and has nothing to do with the order of deletion.

**Be careful when one sentence serves several rows.** Suppose the user had originally said "Lunch was 45 yuan, the taxi was 30 yuan", and the agent wrote two rows using that one sentence as evidence. That sentence cannot be split, and deleting it affects both rows. The preview lists the affected rows one by one.

## Looking back

The mechanisms that appeared in this example are explained one by one in the next chapter:

| What the example showed | The corresponding concept |
|---|---|
| slot, base table, derived table | tenant, slot, table |
| The original sentence is stored as source data, and the values in the tables are derived from it | two layers of data |
| Every step appends events, and the tables are produced from them by `apply`; a write has one write number; read records do not go into the log and are stored separately | the log, `apply`, three kinds of state |
| After the content is deleted, the event header is still there | event header and content stored separately |
| Connections A and B; the provenance of fields `s_1`, `s_2` | actor and provenance |
| Field-by-field judgement when `ver` does not match | version mark and conflict |
| Conflict item, the grace period of a deletion, `resolve` | pending item |

Here is the list of all event numbers of this ledger. The whole guide has only this one log, and the later chapters cite the numbers from here:

| Event | Write number / operation number | What it is | When it was recorded |
|---|---|---|---|
| #1 | 1 | Genesis: creates the data of this user | October |
| #2–#6 | 2 | Creates the `ledger` slot, schema version 1 | October |
| #7 | 7 | Registers connection A | October |
| #8 | 8 | Registers connection B | October |
| #9–#20 | 9, 13, 17 | The three expenses A recorded in October, 4 events each | October |
| #21–#24 | 21 | A records lunch 45 | 11-10 |
| #25–#28 | 25 | A corrects lunch to 54 | 11-10 |
| #29–#32 | 29 | B records taxi 30 | 11-10 |
| #33–#36 | 33 | B corrects taxi to 35 | 11-10 |
| #37–#40 | 37 | A, with the old version, changes taxi to 32; it becomes a candidate | 11-10 |
| #41 | 41 | A resolves the conflict: keep 35 | 11-10 |
| #42–#43 | 42 | Case 1: confirm deleting `s_2` | 11-10 |
| #44 | 44 | Tombstone: that deletion expires and is physically erased (done by saveslot itself) | 11-11 noon |
| #45–#48 | 45 | Add a `budgets` table to the ledger (schema version 1 → version 2): submit the draft, compile, take effect automatically, switch | 11-11 evening |
| #49–#51 | 49 | A records the dining budget: 5000 from 10-01 | 11-11 evening |
| #52–#54 | 52 | A records the dining budget: 4000 from 11-10 | 11-11 evening |
| #55–#57 | 55 | A records the dining budget: 3000 from 11-02, without saying until when | 11-12 |

A few notes:

- The numbers follow the order in which things were recorded: a larger number was always recorded later. In business terms, the budget "from 10-01" was recorded only on November 11, which is exactly the two timelines chapter 7 covers.
- Each budget write has only 3 events (write head, source, base write): `budgets` has no derived table, so there is no derived write.
- Cases 2 and 3 are two other hypotheticals starting from the state after #41, and are not in this log. Examples in later chapters that say "change a premise" or "suppose" likewise do not take up numbers here.
- The budget table and these three writes are covered in chapter 7, and chapter 8 also uses them.

Specification counterparts: for writes, see [`../spec/03-data-model/04-write-and-read.md`](../spec/03-data-model/04-write-and-read.md); for conflicts, see [`../spec/03-data-model/09-references-conflict-sync.md`](../spec/03-data-model/09-references-conflict-sync.md), "Conflict handling"; for deletion, see [`../spec/03-data-model/03-deletion.md`](../spec/03-data-model/03-deletion.md), whose example in the "Corollaries" section has the same shape as cases 1 and 2 of this chapter; for which events one operation appends, see [`../spec/09-event-format.md`](../spec/09-event-format.md), section 4.
