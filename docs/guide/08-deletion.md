# 08 · Deletion

> Translated from docs/zh-CN/guide/08-deletion.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

Chapter 2 used the lunch row to show three cases of privacy deletion. This chapter covers deletion in full: where its definition comes from, why it is defined this way, the whole process from preview to physical erasure, what remains after deletion, and how to make sure that deleted things do not come back when a backup is restored.

Write numbers follow chapter 2 (write #21 records the lunch, #25 corrects the lunch, #29 records the taxi ride, #33 is B's correction of the taxi ride, #37 is A's candidate) and the budget from chapter 7 (writes #49, #52, #55); the overview table is at the end of chapter 2.

> This chapter describes the complete design and marks on the spot what the first version does not do.
>
> **0.1.0 does not provide privacy deletion yet**: the preview, confirmation, grace period and cancellation, physical erasure at expiry, and re-applying deletions after a backup restore described in this chapter all come in later versions ([`../spec/07-scope-v1.md`](../spec/07-scope-v1.md) section 7). What 0.1.0 can do is revoke a row: the history is kept, and the revocation can be undone.

## 1. First, tell them apart: three kinds of "deletion", and deletion is not correction

When a user says "delete it", they may mean three different things:

| Request | What the user wants | What saveslot does | First version |
|---|---|---|---|
| Revoke a row | This record should not exist ("that entry is a duplicate") | An ordinary write with intent `revoke`. The row is marked as revoked; the history and the original words are both kept | Yes |
| Evidence deletion | The original words should not be kept, but the data derived from them may stay | Deletes only the original text; the values stay | No |
| Privacy deletion | Forget it completely | The original text and everything derived from it are dealt with | Yes (specified by source data) |

What tells them apart is the user's intent, which the agent has to judge:

- **The data is wrong**: use revoke or correction. The history is kept, and you can find out who read the wrong value.
- **It should not exist**: only then is it deletion. The content itself is wiped out.

Revoke was covered in chapter 5; it is just a write. The rest of this chapter covers privacy deletion, and the last section adds evidence deletion.

## 2. The definition of privacy deletion

> **The state after a privacy deletion = the state obtained by replaying the log in order as if the deleted source data had never existed. There are two deliberate deviations: decisions made by a person are carried out as recorded; writes that have already taken effect stay in effect.**

This is a definition, not a processing procedure. All the rules that follow are its corollaries; if a rule is inconsistent with it, change the rule.

### Why define it through replay

Intuitively, deletion is "find the values derived from this sentence and wipe them out". That does not work in saveslot, because values override one another in sequence:

- **Delete the later write, and the earlier value has to come back.** Delete "no, it was 54", and the amount should go back to 45, not become empty.
- **Delete the earlier write, and the later write may lose its footing.** Delete "lunch cost 45 today", and the remaining correction gives only the amount; this row has no date and no category, so it cannot stand.
- **Deleting one write can change the situation of other writes.** A write that used to conflict with it no longer conflicts.

Writing a separate rule for each case cannot be complete, and the rules would fight each other. With one definition, the answer in any case can be derived from "as if it had never existed", and it can be written as a program to check (section 10).

### Two deviations

**A person's decision is carried out as recorded.** There is no way to know "what the user would have decided if that sentence had never been said". A revoke, revert, confirmation, rejection, or choice made while resolving a conflict, made by the user on the basis of what they saw at the time, can only be carried out as recorded.

**A write that has already taken effect stays in effect.** After recomputing, a write that took effect long ago may "by the new state have become a conflict candidate". saveslot does not demote it. A write that has taken effect has been read by others and has been used as a basis by later writes; demoting it would let a deletion overturn an established fact unrelated to it, and would also create a pending item out of nothing. So recomputation changes the fate of a write in only one direction: a write that was not in effect may take effect, or turn into awaiting confirmation; one that is in effect is left alone.

### Another limit: only the current state

The definition says what things look like "now" after the deletion. Earlier historical versions are not recomputed by the definition; the deleted content is simply removed from them.

For example: after deleting `s_2` ("no, lunch was 54"), the current amount is 45. But if you look back at the historical version after write #25, the amount cell is **empty**, and the result carries a "part of the data at that time was deleted" flag; it does not show 45. 45 is the result of recomputing by the definition for "now", not a fact of that moment.

## 3. Two principles

During replay, what stays as it was and what is recomputed? Two principles.

### Principle one: follow only data dependencies, not control dependencies

Chapter 3 explained that there are two kinds of source. They are treated differently on deletion:

| | What it is | On deletion |
|---|---|---|
| Value source (data dependency) | The value came from it | Deletion propagates along it |
| Operation source (control dependency) | It triggered this write but did not supply a value | Deleting it does not affect the value and does not revoke the decision |

Example: the user says "revoke that lunch entry", and later asks to delete this sentence. The sentence is the operation source of that revoke, and no value comes from it. So after the deletion the row is still revoked; only the sentence itself is deleted.

One thing needs to be told apart on state tables. "The budget for October 10 to 20 does not count" is a revoke with an interval, and that interval is content stated in the user's sentence, so the sentence is a value source of the interval: when it is deleted, this revoke disappears with it, and that period goes back to the value before the revoke. A revoke without an interval ("drop this budget altogether") has no content that came from the sentence; it is a pure decision, and it remains valid when the evidence is deleted.

### Principle two: saveslot's own mechanical judgement is recomputed from the state after deletion

At write time saveslot made some judgements that involve no human judgement: whether this value is the same as the version that was read, whether this write conflicts with someone else's, whether it is high-impact, on which day "until the next change" actually falls, and whether this row exists.

When the inputs to these judgements change, the conclusions change with them. After a deletion they have to be recomputed on the new state. **Apart from the human decisions mentioned above, every judgement is recomputed, with only three exceptions**:

- **Suspected duplicate**: judged once at write time and kept as recorded, not recomputed.
- **Literal match**: likewise checked only once at write time and kept as recorded.
- **What left no value at write time stays unchanged**: a field that at write time had "an unchanged value and no evidence pointed at" (a no-op) still does not count as a change made by this write after the deletion (section 4 has an example). When a connector syncs by external key, records that were unchanged or skipped at the time never entered the log, so likewise they do not take effect after the fact because of a deletion.

Put together: **human decisions stay, saveslot's judgements are recomputed, and values follow data dependencies.**

There is one more kind of relationship that deletion does not follow: the **premise** (chapter 5, section 6). If a row declared "I wrote this after seeing the value of that row", and the value of that row is changed by a deletion, this row itself is left alone and only gets a "premise changed" flag, leaving it to a person to judge whether it still holds. Its value comes from its own evidence, not from its premise.

### Which version of the rules the recomputation uses

Chapter 5 explained that the head event of every write records the rule version and policy version used for its judgements. When a deletion replays an old write, it computes by the versions that write recorded for itself. This way, after a kernel upgrade or a change to the slot policy, an unrelated deletion does not change old judgement results.

## 4. Contributions: what replay actually computes

To turn the definition into a computation, one concept is needed: the **contribution**.

A write's contribution to a field = the value this write gave that field, together with its value source. The lunch row in chapter 2 has four contributions:

| Write | Field | Value | Value source |
|---|---|---|---|
| Write #21 | `date` | 2026-11-10 | `s_1` |
| Write #21 | `category` | Dining | `s_1` |
| Write #21 | `amount` | 45 | `s_1` |
| Write #25 | `amount` | 54 | `s_2` |

The deletion computation has three steps:

1. **Find the affected rows.** The deleted source data appears as a value source in which fields of which writes.
2. **Remove those contributions.**
3. **Replay all the writes of the affected rows in order**, including candidates and awaiting-confirmation writes that were not in effect. Derived tables are recomputed along with them.

A few basic rules for replay:

- **The value of a field** = the last contribution, in order, that is still there.
- **Between different writes the relation is "or".** If the same value was given by two writes separately, then deleting the source of one leaves the contribution of the other, and the value is kept. This is what corroboration is for.
- **Within one write, citing several pieces of evidence is "and".** If any one of them is deleted, this write's contribution to the field is removed (chapter 5 explained why).
- **Fields passed back unchanged and with no evidence pointed at still do not count as changes.** Such fields (the "no-op" of chapter 5) have no value recorded in the log. During replay, even if the value they read back then is no longer there, they do not become a change. Otherwise a value that should have been deleted would survive by way of "someone else passed it back unchanged".
- **A value carried over by taking a candidate** has its contribution recorded as "a reference to those original contributions". When none of the referenced contributions is there any more, the carried-over value is gone as well, and falls back to the value before it.
- **A revert** (undoing a write) has more rules, and they are set out in the subsection below.

### A revert meeting a deletion

The principle in one sentence: **"which changes to undo" is a human decision and is carried out as recorded; "which value to go back to" is not part of the decision and is recomputed after deletion; in no case does it fall back to the value of the undone write itself.**

A revert means "go back to the state before the undone operation". If some content in that "earlier state" has been deleted, the state changes, and the value it goes back to changes with it. Whether the undone change is in effect depends only on the record that "it was undone", not on what was written back at the time.

Take a budget example (a different set of data, not the main line):

| What happened, in order | State afterwards |
|---|---|
| ① Record "budget 5000", continuing from the start | 5000 throughout |
| ② Record "4000 from 11-10" | 5000 before 11-10, 4000 after |
| ③ Someone changes 11-02 to 11-19 to 3000 | That period is 3000 |
| ④ Undo ③ | 11-02 to 11-09 goes back to 5000, 11-10 to 11-19 goes back to 4000 |

Now a privacy deletion is made. Deleting different things gives different results:

| What is deleted | Result for the period 11-02 to 11-19 | Why |
|---|---|---|
| The sentence of ② ("4000 from 11-10") | 5000 for the whole period | The decision to undo is still there, and 3000 does not come back; the state before the undo no longer contains 4000 |
| The sentence of ① ("budget 5000") | No value for 11-02 to 11-09; 4000 for 11-10 to 11-19 | In the state before the undo, the first half already has no value; 3000 still does not come back |
| The sentence of ③ (the undone change itself) | Same as if ③ and ④ had never happened: 5000 in the first half, 4000 in the second half | The change to be undone no longer exists, so this undo no longer has any effect |

Two more points:

- **How far the undo reaches is also recomputed after deletion.** Suppose that when ④ undid ③, one part had already been covered by a later write by someone else and was therefore not undone; if that later write is then privacy-deleted, this part is undone too, so that 3000 does not pop up on this part.
- **On a table without time periods, one change is a whole.** On a table such as a ledger, if at undo time that change was entirely covered by a later write, it is not undone at all; once the write that covered it is deleted, it is undone as a whole.

#### Choosing "return to before the conflict" when resolving a conflict

`take_previous` and undo are the same kind of operation (chapter 5, section 4), and the rules are exactly the same:

| | How it is determined |
|---|---|
| Which changes were reverted | Listed when resolving, as recorded |
| Which version it goes back to | The version recorded when resolving (the merge base), as recorded, not chosen again |
| The value in that version | Recomputed after deletion |
| The range reverted | Recomputed after deletion, and only within the period the conflict involves |

The consequence of the last row: if all the candidates that brought up the conflict are deleted, "the period the conflict involves" does not exist, which amounts to the conflict never having happened, and the value submitted first takes effect as usual.

### The existence of a row

Event tables and timeless tables: **a row exists when every required field has at least one contribution still there**; otherwise the whole row is deleted.

There is a supplementary condition that applies to both kinds of table: at least one field must have content that really came from some sentence. A null value does not count, and neither does a constant filled in at a schema change (chapter 9). If a row is left with only the contribution of a write such as "clear the note", or its required fields are held up entirely by constants filled in by the schema, it does not count as existing; otherwise a record with no user content at all would be left behind.

The contributions to the individual required fields may come from different writes; it is not required that one write alone supplies them all.

For a field that received a constant fill at a schema change (a newly added required field, or a field changed from optional to required), this judgement does not treat it as required, and this is the same for both kinds of table. On a state table, when the write that a fill depended on for a period is deleted, the constant for that period disappears with it, and the field becomes empty during that time; the row or entity still exists, and the result is recorded as "kept, some fields emptied".

### Three outcomes for the lunch row

| What is deleted | Contributions still there | Result |
|---|---|---|
| `s_2` (the correcting words) | The three from write #21 | Kept; the amount goes back to 45 |
| `s_1` (the original words) | Only the amount from write #25 | The whole row is deleted: date and category have no contributions still there. `s_2` stays as source data but no longer supports any data, and the preview lists it separately (section 6) |
| `s_1`, but before the deletion A had explicitly corroborated the date and category with other evidence | The amount from write #25; one corroboration contribution each for date and category | Kept; amount 54 |

The third row is the "corroborate first, then delete" of chapter 2 (for how to write it, see chapter 5, section 5).

### An example on a state table

Use the budget from chapter 7. Three writes:

| Write | Content | Value source |
|---|---|---|
| Write #49 | 5000 from 10-01 | `s_a` |
| Write #52 | 4000 from 11-10 | `s_b` |
| Write #55 | 3000 from 11-02, no end point passed; resolved at write time as ending at 11-10 | `s_c` |

The current state: 10-01 to 11-01 is 5000, 11-02 to 11-09 is 3000, from 11-10 it is 4000.

| What is deleted | Replay | Result |
|---|---|---|
| `s_c` | Write #55 is removed | 10-01 to 11-09 is 5000, from 11-10 it is 4000. The period it had cut open goes back to its original value, leaving no gap |
| `s_b` | Write #52 is removed. The end point of write #55 was originally "until the next change"; now the next change does not exist, so it is resolved again as continuing indefinitely | 10-01 to 11-01 is 5000, from 11-02 it is 3000 |

The second row shows principle two: the day on which the end point of write #55 falls was saveslot's mechanical judgement at the time, not something the user said. After a deletion it has to be resolved again from its original wording. This is what chapter 7 meant when it said to "record the original wording and the resolved result separately".

The new interval resolved again (continuing indefinitely from 11-02) is recorded in the event of this deletion. From then on, what write #55 governs is this new interval: if someone later undoes write #55, what is reverted is the whole period from 11-02 on, not the 11-02 to 11-09 it had at first.

The event of write #55 originally recorded "until 11-10". The date 11-10 came from the deleted sentence, so the block that records it is also within the scope of what this deletion clears (section 7).

It is not only the interval. After replay, the result of an old write may change in several ways: a conflict candidate that was not in effect takes effect; what used to count as changing a value now equals the value before it and becomes a corroboration; the interval changes. **Whatever result has changed, the deletion event writes down its complete new result**, and `apply` follows the most recently written one. Values "carried over" by an undo or by taking a candidate are treated the same as ordinary writes and take part in this recomputation alike. This is what makes the live state agree with what the reference evaluator (section 10) computes, so that later writes get the same judgements on both sides.

Conversely, if the user had explicitly said "until November 10", that end point is content the user stated, has its own source, and is used as it is during replay.

The second row also shows the exact meaning of "no extra deletion": the contribution of 5000 from `s_a` was not removed, but after 11-10 it was originally not in effect (covered by 4000) and is still not in effect now (covered by the extended 3000). A contribution that was not deleted does not disappear, but the times at which it is in effect may change because other writes are resolved again. Such a change is listed in the preview as "re-segmented".

## 5. A consequence that must be visible: a write that was not in effect may take effect

The taxi row in chapter 2: B corrected the amount to 35 (`s_4`, write #33), and A, holding an old version, wanted to change it to 32 (`s_5`, write #37). 32 became a candidate, and a conflict item was generated.

In chapter 2 this conflict was then resolved by the user. Here we take a different premise: **suppose nobody has handled the conflict item yet**, and the user asks to delete `s_4`. Replay: write #33 is removed. What A's write passed back was `v29.0`, and since write #29 no other write has changed the amount. The conflict no longer exists, write #37 is an ordinary write, and **32 takes effect**.

This is a direct result of the definition: if B's sentence had never been said, A's write would have taken effect directly in the first place. But for the user it is a change they did not expect: they only wanted to delete one sentence, and as a result a value that was not in effect took effect.

So the specification requires that this case **must be visible**:

- The preview lists "the following writes that were not in effect will take effect" separately, not mixed with other results.
- It is stated in both the deletion receipt and the deletion event.
- The corresponding conflict item is marked "superseded".
- When a deletion is cancelled, these writes go back to their earlier not-in-effect state.

The same applies in another case: a high-impact write is waiting for confirmation, and the change point it would overwrite is deleted; it is no longer high-impact, so it takes effect.

### One way of not taking effect directly: turning into awaiting confirmation

There is another case that cannot take effect directly. Imagine that A's candidate write is not only in conflict with someone else's, but if it took effect it would also wipe out a change that had already been recorded (chapter 7, section 13, "both conflicting and high-impact"). Now the other side of the conflict is deleted, and the conflict no longer exists, but the write is still high-impact, and nobody has ever confirmed it.

The guarantee that "wiping out a recorded change must be confirmed by a person" should not be bypassed because of a deletion. So such a write **turns into an item awaiting confirmation** and does not take effect: the original conflict item is marked as superseded, and a new item awaiting confirmation is generated. The preview likewise lists "the following writes will turn into awaiting confirmation" separately.

### Three boundaries

- **What a person has already handled is kept as recorded.** If the conflict item has already been resolved by the user with `keep_effective`, that is a human decision: "these candidates do not take effect". The candidates do not take effect because of a deletion; if the value in effect loses its source, it falls back by the ordinary rules to the earlier value that is still there.
- **What has already taken effect is not demoted.** This is the second deviation in the definition.
- **Deletion does not increase the number of open items.** Writes already in effect are not demoted, so no new conflicts appear; every new item awaiting confirmation corresponds to a conflict item superseded by this deletion.

## 6. From preview to physical erasure

**A deletion targets only one slot.** Every source belongs to only one slot; when one sentence concerns two slots, it was already stored as two sources, and each slot deletes its own.

### Step 1: preview

The consequences of a privacy deletion are not obvious, so it may not be executed directly. First call `deletion_preview`, saying which sources are to be deleted.

**A preview is a trial computation and deletes nothing.** saveslot computes the result by the definition and returns:

| Content | Description |
|---|---|
| Totals | How many sources are deleted, how many rows are affected, how many derived values are recomputed |
| Result per row | The row is deleted entirely / the row stays but some fields become empty / some fields return to an earlier value / the row is re-segmented / the value is unchanged and only its provenance changes; plus the **reason for the judgement**: which writes still contribute to each required field. On a state table, intervals that go from having a value to having none are listed separately with the reason. One reason is that a required field has no surviving contribution in that stretch of time. The other is less obvious: for example, a revoke saying "does not count from 11-05 on" had its end point on 11-20, given by the deleted sentence; after the deletion it extends past that date, a value written after 11-20 with only an amount and no owner cannot support that stretch, and so that stretch has no value |
| Writes that will take effect | The ones described in the previous section, listed separately |
| Writes that will turn into awaiting confirmation | Same as above, listed separately |
| Items that will be superseded | |
| Rows that still point at a deleted row | Another row has a field that references a row that will be deleted entirely: those rows are not changed, and when read later that value is marked "target deleted" |
| Rows whose premise is a value that will change | Another row declared a premise on a value that this deletion will change: those rows are not changed, and after the deletion they carry "premise changed". saveslot does not know whether they restate the deleted content, so it lists them and leaves the decision to a person |
| Sources that no longer support any data after the deletion | Sources that remain after this deletion but go from "supporting some value" to "supporting nothing" (`orphaned_sources`); typically another piece of evidence in the same write, or a later correction of the same thing. saveslot does not delete them automatically; the caller decides whether to add them to the deletion |
| Rows from an external system | When an affected row carries an external key (synced in from another system by a connector), a reminder that after the deletion, if the connector syncs again, the same record will reappear (section 8) |
| Things that will not be deleted | See section 8 |
| Confirmation handle `dc_…` | Bound to this preview |

The preview for case 2 of chapter 2 (deleting `s_1`, starting from the state after #41) is, roughly, the following text as the agent receives it:

```
Deletion preview · ledger · will delete 1 source and 1 row, recompute 1 derived value
expenses r_01JC… row deleted entirely: date and category come only from s_1; amount also has a contribution from #25, but this row would lack required fields
  Evidence outside the same write: s_2 "No, lunch was 54 yuan" gave only amount. To keep this row, corroborate date and category by field first, then preview again
monthly_total 2026-11: 89 CNY → 35 CNY
The following sources stay after the deletion but no longer support any data; if their content should be forgotten too, add them to the deletion: s_2
Not deleted: retained records such as event headers and internal IDs (see the description of saveslot_sources)
Confirmation handle dc_8ZqK… (valid for 10 minutes). Execute: saveslot_delete; can be cancelled for 24 hours after confirmation
```

The first line is the totals; after it, each row's result and the reason for the judgement. When there are "writes that will take effect", "writes that will turn into awaiting confirmation", "rows whose premise is a value that will change" or "sources that no longer support any data", each gets its own paragraph, not mixed with the other results; when there are none, nothing is written. The agent works out the consequence from the single sentence "row deleted entirely: date and category come only from s_1" and relays it to the user. (The literal text is whatever the implementation's samples say; the elements are in section 6 of [`../spec/05-surfaces.md`](../spec/05-surfaces.md).)

The reason for the judgement exists so that the caller can do something about it. Seeing "this row will be deleted entirely because the date comes only from this sentence", the agent can first corroborate the date with other evidence and then preview again. The paragraph on "no longer support any data" works the same way: after this row is deleted, the sentence `s_2`, "No, lunch was 54 yuan", is still in the source data; if what the user wants is "forget everything about this lunch", add it to the deletion as well and preview again.

Through MCP, the preview is not a separate tool but the `deletion_preview` mode of the `saveslot_sources` tool.

### Step 2: confirm

The agent tells the user the preview. Once the user agrees, the agent calls `delete`, whose only parameter is that handle.

The handle ties "what was seen" to "what is executed". It binds the range of impact and the log position at the time of the preview, and is valid for 10 minutes. If new writes have landed in the range of impact since the preview, the handle no longer matches, and saveslot refuses and gives a new preview. It cannot happen that the user agrees to one result and a different one is deleted.

Whether the user really agreed is the caller agent's responsibility. What saveslot guarantees is that what was confirmed is what is executed, and it records who confirmed.

### What happens at the moment of confirmation

saveslot appends a "deletion confirmed" event, which is the head event of this operation. This event records **all the computed results**:

- what each affected row looks like after the deletion, with each field carrying its value source;
- the new `ver` of those rows (it encodes the operation number of this deletion confirmation);
- the writes that take effect because of the deletion, the writes that turn into awaiting confirmation, and the items that are superseded;
- the rule version used in the recomputation;
- the moment, 24 hours later, at which the grace period expires;
- which content blocks are to be emptied at expiry, with each address listed.

Changes to derived tables are recorded separately as derived-write events.

`apply` changes the tables as this event says and does no computation of its own. This is an instance of the property in chapter 3: judgement is finished at the time, and the result is written into the event. The benefit is that if the kernel is upgraded later and the details of the computation change, replaying the old log still gives no different result.

From this moment, the deleted content can no longer be read, and the current value and the derived values no longer contain it.

### The 24-hour grace period

For 24 hours after confirmation, the deletion can be cancelled. During the grace period the content is still in storage, only unreadable. This is the only path of regret for a deletion.

During this period:

- **There is a "deletion grace period" item**, whose ID is the ID of this deletion.
- **Writes continue as usual**, on top of the state after the deletion. When a write reaches an affected row, the receipt warns that "this row has a deletion that can be cancelled".
- **A source pending deletion can no longer be cited as evidence.**
- **Resending a write that was just deleted does not write it again.** The request key still takes part in duplicate checking until physical erasure, and the receipt says "the original write has been deleted".
- **On export, content pending deletion is replaced by a placeholder by default and is not exported.**

### Cancelling

Use `resolve` on that item with `cancel`. Cancelling does not need the item version: it is the path of regret, someone cancelling from a different session should not have to read first, and cancelling confirms no new content.

Cancelling is also computed by the definition: treat that deletion as if it had not happened, and replay together with the new writes made during the grace period. The result is written into the "cancel" event. The main points are:

- **Writes that took effect during the grace period stay in effect.** So after cancelling, the parts not covered by writes of the grace period are the same as if nothing had ever been deleted; the covered parts follow the writes of the grace period.
- Items that were superseded because of the deletion are restored, unless a write during the grace period has already changed the fields they involve.
- Writes that took effect because of the deletion go back to what they were. But if another write during the grace period has already used one as its base and changed it, it does not go back, and the receipt lists these "stay in effect" writes.
- For a conflict item that lost a candidate because of the deletion, the candidate is put back on cancelling; if that item has already been superseded during the grace period because of another write, it stays superseded and the candidate is not put back.

**During the grace period, no decision can be made on the rows affected by this deletion.** The conflicts and items awaiting confirmation on those rows cannot be handled for the time being, and a write on them cannot be undone (`undo`) either; ordinary writes go on as usual. The item's details say which deletion blocks it and when that deletion expires. To handle them, wait for the expiry, or cancel the deletion first. This is the rule because a decision is made by a person looking at the data of that moment, and during the grace period what they see is the state after the deletion, which would change back once the deletion is cancelled.

### At expiry: physical erasure

After 24 hours, saveslot appends an "expiry physical erasure" event, also called the **tombstone**, and empties, one by one, the content blocks listed in the deletion event. The emptied positions keep a mark "removed by #n"; the mark contains no content and no value computed from content.

The tombstone lists only the addresses of the deleted content blocks and the reason codes. It never expires: if the log is exported and replayed elsewhere later, this content does not come back either.

Physical erasure does not change the current state; the current state was already fixed at confirmation. What it does is clean the content out of storage, in two steps: first, in one transaction, append the tombstone and empty the content blocks and the matching content in each table; after the commit, have the database clear the internal places that may still hold plaintext. Both steps can be redone.

**Expiry must be executed on time.** In server mode, the scheduler executes it at the due time, without waiting for the user's next visit. In local mode, if saveslot is running it executes on time; if it is not running, it executes first at the next start, before serving. The deletion receipt says this plainly.

If the physical erasure at expiry fails (for example, the disk is full), saveslot keeps serving as usual and keeps retrying, and marks that deletion "overdue, not yet physically erased". This content has been unreadable since confirmation; what is delayed is only wiping it from the disk.

## 7. More than that one sentence has to be cleared

There is more "derived from source data" than one would think. The specification requires that everything derived from source data records its provenance and is within the range of deletion. Besides the values in tables and the historical versions, there are:

| Content | Why it counts |
|---|---|
| Request keys, explicit idempotency keys | Computed from the content of the request, or text written by the caller, so counted as content (chapter 3, section 4). It is deleted with the evidence of **this request** (with one boundary, see section 8) |
| The task identifier the agent reports for itself | Text written by the caller; it may contain user content |
| The values the agent handed over as they are in the write header | The same provenance as the recorded values |
| Records of literal matches | They state whether "this value is in the original words" |
| The intervals of the segments written back when a write is undone | They are copied from the write that was undone and the writes it covered. The record "which fields of which write were undone" holds only sequence numbers, no content, and stays |
| Intervals in other writes that were obtained from deleted content | A write's "until the next change" stopped at the start of a deleted write, so this end point is the deleted date; the same holds for the segments written back on an undo and the segments recorded in a deletion event |
| Current values, proposed values and reason text in pending items | They quote the content of rows |
| The evidence and notes attached when an item is resolved | They are themselves stored as source data, and can be named for deletion directly |
| The content hash in a confirmation record | Computed from the content that was confirmed |
| Group key values of derived rows | When summarizing by category, the category name is itself user content |
| The valid time in a premise declaration | The "November" in "premised on the November budget" was given by the caller or taken from the row's own date |
| The index of external keys | A key is an identifier in an external system, and some systems use email addresses or phone numbers as identifiers |
| The results a deletion event records about itself | The values in the results are content too; when their sources are deleted later they cascade in the same way |
| Tables of old versions | The old tables kept after a table structure change also hold these rows |
| Value examples in the catalog | Computed from the current data |

In the log these are each independent blocks of data, each recording which source data it comes from, so they can be emptied block by block.

One kind needs an extra word: **content that this request did not bring itself, but that was obtained or copied from other writes** (the parsed results, obtained intervals, values in items and results recorded by deletion events in the table above). The rule is that such content forms its own block, and the block records which writes it depends on; when a write it depends on is deleted, or its result is changed by this deletion, that block is cleared together. Results that are still needed after the clearing are written again by the event of this deletion.

There are also leftovers at the storage level: the database's write-ahead log and free pages, and the frequent values in statistics. The specification has a complete list, and every item must be handled. Both databases use the same approach: rewrite the affected tables, rewrite the statistics table again after the statistics are updated, switch, and stop reusing the old write-ahead log segments. When done, check again whether it is really clean, and if not, retry later. This approach was settled by an experiment (experiment 7 of chapter 12): with the main steps removed, the deleted original text can still be found by byte search in the data directory. With a managed database, where permission for these operations is not available, the log is instead replayed into a new database to clean it, and during that time this account cannot write.

The matching test is: after a privacy deletion expires, searching the whole storage for the deleted original text, or for values computed from it, finds nothing.

## 8. What remains after deletion, and what cannot be reached

The deletion receipt states these plainly and does not claim "everything has been completely deleted".

**Metadata that remains, in two layers.**

- **Event headers** (in the chain, can never be changed): they show that an event of some type existed at some moment, which principal did it, which slot it belongs to, and which events belong to the same operation.
- **Metadata blocks** (not in the chain, not deleted in the first version): they show which row of which table (the internal ID; the row ID itself carries its creation time), the intent of each write, and which events it references; a tombstone says which positions had content removed. A position carries the internal number of the field, so it shows that "field number so-and-so was changed".
- **Premise declarations** are metadata of the same kind: they show that some write declared a premise on which row of which table, which field number, and the value at which version, which later write cleared it, and in which operation its status changed.

What cannot be seen: any value, original words, time interval (including the valid time of a premise declaration), table name and field name.

**One known boundary: the request keys of other requests.** A request key is a hash computed over the whole request. If another request carried a deleted value back unchanged (that field being a no-op), the value, although it does not stay in the log, took part in computing the request key of that request. A request key is deleted only with that request's own evidence, not with the deleted sentence. It is a hash and the original value cannot be derived from it; but someone who already knows all the rest of that request's content can compute it with a guessed value and compare. It is left unchanged because the request key is used to recognize resends, and excluding the fields carried back unchanged would make two requests with different content look like the same request. This item is also written in the section for legal.

Event headers deliberately keep only a few general fields (chapter 3), precisely to leave room on this question: if a future requirement is that even "which row, what intent" may not remain, those metadata blocks can be cleared together when a row is deleted entirely, without changing the event header and without touching existing events. The itemized list and "what to do if retention is not allowed" are in section 9 of the event format specification. Whether this part is acceptable is pending confirmation by legal; it needs a conclusion before server mode goes live, and does not block local mode.

**What saveslot does not keep.** External files: saveslot stores only references, and the user must delete the files themselves.

**Records in external systems will sync in again.** Rows that a connector synced in from another system (a wristband, an expense app) carry an external key. After one is deleted, that record is still in the source system; the next time the connector syncs, it reappears as a new row. saveslot cannot stop this: after physical erasure it does not remember the deleted key, and does not even keep a hash of the key, which is the same cost as "no way to compare after deletion". So the preview, the receipt and the close of the grace period at expiry each remind once: to forget it completely, first delete it in the source system, or make the connector stop syncing it.

**Content outside the range of deletion.**

- The schema document itself, such as enum values, field descriptions and aliases, may contain text written by the user and is not cleared by a privacy deletion.
- The name of a connection. It was chosen by the user and is not derived from any source.
- On operations with no evidence at all, the task identifier the agent reports for itself and the explicit idempotency key. Submitting a schema draft, confirming a deletion, and resolving an item with neither evidence nor a note are operations without source data, and these identifiers have no source to follow for deletion. So a task identifier should not contain user content.

The preview explains these one by one.

**Backups.** saveslot does not encrypt content itself; deletion relies on physical erasure, not on destroying a key, and the disk encryption of the cloud service does not change this (chapter 10, section 5). Old data in backups can only disappear once the backup passes its retention period. The receipt gives the status and time of each: when the logical deletion happened, when the physical erasure happened, when the backup expires.

**System-level backups on the local machine.** Old copies in backups such as Time Machine are not saveslot's business. Restoring from there amounts to going back to the data of that time.

**Tasks that read deleted data.** Not traced back, not notified. Their output has long left saveslot and cannot be recalled; and a deletion done for privacy should not generate new records that describe the deleted content. The read record holds only version numbers anyway, so after the deletion it naturally shows "read a deleted version".

**Writing the same content again.** saveslot cannot recognize it. The tombstone stores no value computed from content, so there is no way to compare by content. This is the cost of "no way to compare after deletion".

**Deleting a whole account.** The first version has no such operation, and no deletion of a whole slot either. Per-source privacy deletion cannot do this: event headers and metadata blocks stay forever by design. In local mode, deleting the data directory and the configuration directory is all there is; before the cloud service goes live it must be defined clearly, and the questions to answer are listed under "Deleting a whole tenant" in [`../spec/08-open-questions.md`](../spec/08-open-questions.md).

## 9. When restoring a backup, deleted things must not come back

The tombstone in the log guarantees that "export, then replay" does not bring data back to life. But there is one case the tombstone cannot handle: restoring a backup from **before the deletion**. The log of that backup does not contain this deletion at all.

The solution is to keep, outside the log, a **deletion register**, placed in the registry storage described in chapter 4 (in server mode the control database; in local mode a file in the saveslot configuration directory). Each entry records only: which tenant, which deletion, the status, the expiry moment, and the addresses of the deleted content blocks. No content is stored. After restoring any backup, saveslot first re-applies deletions according to this register, and only then serves.

This section covers only how the register and the log stay consistent. How a restore is triggered, what to do if it crashes midway, and which cases cannot be handled belong to usage, in chapter 11, section 6.

### The register is never "less deleted" than the log

The register and the log are two places, and the process may crash after one has been written and before the other. The rule is one sentence:

> **The register is never "less deleted" than the log.**

Deleting too little is an invisible privacy incident; deleting too much is visible within 24 hours and can be cancelled. So every crash is made to land on the side of "the register deletes one step more", and reconciliation brings it back. This fixes which side each of the three actions writes first:

| Action | Written first | Written after | Crash in between |
|---|---|---|---|
| Confirm a deletion | The register, with status "intent" | The deletion transaction in the tenant; on success the register changes to "pending execution" | The register has it, the log does not |
| Cancel | The cancel transaction in the tenant | The register changes to "cancelled" | The log shows it cancelled, the register still says "pending execution" |
| Physical erasure at expiry | The tombstone in the tenant | The register changes to "executed" | Both sides say "to be deleted", no difference |

The status "intent" means: the register has been written, but it is not yet known whether the transaction in the tenant committed.

### Reconciliation in two directions

**In normal operation, the log decides, and the register is corrected.** Every time a tenant is opened, every time before the expiry tasks are scanned, and every time before a deletion-related operation, saveslot compares the two sides: if the register is behind, it catches up; if the register says "intent" and the log has no such deletion, the transaction did not commit at the time, and the entry is removed.

By the order above, the register can only be one step ahead of the log. If a combination that cannot occur in normal operation shows up (for example, the register says "pending execution" while the log has no such deletion at all), the tenant's data has been replaced with older data without going through the restore procedure. In that case local mode automatically enters the restore procedure, and server mode refuses to serve and tells operations to follow the restore procedure (chapter 11).

**After a restore, the register decides, and the log is made up.** If the register says executed while the content is still in the log, the tombstone is added and the content cleared, with no grace period; if the register says pending execution and the log has none, this deletion is generated again, keeping the original expiry moment; if the register says cancelled while the log still has the deletion waiting to be executed, a cancel is appended.

There is only one combination that saveslot cannot tell apart: the register says "intent" and the restored log has no such deletion. Either the transaction did not commit at the time, or it committed and was wiped out by the restore. saveslot treats it as the latter: it generates this deletion again and **gives a new 24-hour grace period**, stating the reason in a pending item. This may cause a deletion to appear for which the user got an error at the time, but it is visible and can be cancelled; handled the other way, a deletion for which the user already received a success receipt would quietly come back.

The two complete comparison tables (each status of the register meeting each status of the log) are in the specification.

### When importing an export

Loading an export into an empty tenant (chapter 11, section 6) is another route by which "the log comes from elsewhere", and the rule goes in the same direction:

- **The register is rebuilt from the imported log.** The source's register does not travel with the export; after the import, deletions still pending in the log are registered again.
- **Placeholders in the export get tombstones immediately.** By default an export replaces content pending deletion in the grace period with a placeholder, so the content never came along. On import, a tombstone is added at once for each such deletion, and these deletions cannot be cancelled at the target. This is the second way a tombstone is produced, besides physical erasure at expiry.
- **Deletions made at the source after the export cannot be brought over by the import.** An export file is by nature a copy that saveslot cannot delete from; importing it turns it into live data again, so before the import the moment of the export is shown, with the hint "deletions made at the source after this export are not in it".

## 10. How we know deletion was computed correctly

The computation of deletion is the most complex part of saveslot, and getting it wrong has serious consequences: a missed deletion is a privacy problem, and an excess deletion is data loss. So it has a dedicated method of verification.

### The reference evaluator

The definition is "replay the log as if the deleted source data had never existed" (plus two deviations). Write this sentence as the plainest possible program, ignoring performance, and that is the **reference evaluator**: its input is all the write events of a row and the set of deleted source data, and its output is what the row looks like after the deletion.

It shares no implementation with the code that actually executes deletions online, not even the judgement module described in chapter 4, and is used only in tests. Every result the online code computes should be the same as what the reference evaluator computes.

### Property tests

Besides comparing example by example, there is a set of properties that do not depend on particular examples. Write sequences and deletion sets are generated at random, and whether these properties hold is checked:

| Property | Meaning | What it catches |
|---|---|---|
| Agrees with the reference | The online deletion result = the reference evaluator's result | Any rule implemented wrongly |
| Write path agrees with the reference | The online state after a series of writes = the reference evaluator's result with "nothing deleted" | Judgement at write time disagreeing with the definition |
| Order independence | Delete A then B = delete B then A = delete both at once | A result that depends on the order of deletions |
| Cancel restores | After a deletion and a cancel, the parts not covered by writes of the grace period are the same as if nothing had ever been deleted | Something missed when putting back on a cancel |
| No missed deletion | Every value that remains and the end point of every time segment depend on no deleted source data; content obtained from it and left in other events is cleared too | Privacy leak |
| A no-op stays a no-op | A field that was a no-op at write time is still a no-op after any deletion | A field carried back unchanged being treated as a change after the value it read was deleted |
| Undoing a write leaves no trace | After a deletion extends the end point of a write, undoing it leaves it in effect at no time at all | An undo that used the old interval in the event and left a stretch that cannot be undone |
| A revert does not fall back to an undone value | After a revert, no deletion makes a reverted change take effect again | After a moved value is deleted, falling back to the value of the write that was undone |
| Online agrees with the reference after restating | After a deletion, for every old write the status, interval and whether it is a corroboration are the same online and in the reference evaluator | The deletion event not recording a status change, so that later writes are judged differently on the two sides |
| No excess deletion | A contribution whose provenance does not include the deleted source data is not removed | Deleting too much |
| No increase in open items | Every new item awaiting confirmation corresponds to a conflict item superseded by this deletion | A high-impact write whose conflict vanished taking effect directly, or items appearing from nowhere |
| What took effect stays in effect | Confirming a deletion never turns a write that took effect into a candidate or awaiting confirmation; cancelling a deletion reverts only the writes that took effect because of that deletion | The second deviation not implemented |
| What takes effect must be visible | Every write that takes effect or turns into awaiting confirmation because of a deletion appears in the preview, the receipt and the event | Quietly taking effect |
| Rule version isolation | Without an explicit re-judgement, the judgement result of an old write does not change because of a kernel upgrade or a policy change | Replay using the current rules |
| Record agrees with recomputation | The deletion result recorded in the log = the result the reference evaluator recomputes with the rule version of that time | See below |

The last one fills a blind spot. Chapter 3 said that "replay the log from an empty database and compare row by row with the live one" finds many problems. But it cannot find a deletion computed wrongly: replay uses the results recorded in the events, so if they were recorded wrongly, the replay comes out with the same error. Only recomputing with the reference evaluator and comparing catches it.

The property "write path agrees with the reference" shows that the reference evaluator does not cover only deletion: it is likewise the reference implementation for the time and conflict rules (chapter 12).

> The first version builds the reference evaluator and this set of property tests, covering the kinds of deletion the first version supports.

## 11. Addendum: evidence deletion and per-row deletion

Neither of these is in the first version; here we only say what they are.

**Evidence deletion.** It deletes only the original text and leaves the value. It has a threshold: if, after the deletion, some current field would have no source in which "the original text is still there", it is refused by default, and the fields concerned are listed. Because that would leave a value for which no original-text source can be found. (In the specification a source that can "block a deletion" is called a strong reference.) The caller can instead revoke, corroborate first and then delete, or use privacy deletion instead.

**Per-row privacy deletion.** The rows are named directly, and saveslot finds all the sources of those rows and deletes them together. When a sentence also served other rows and cannot be separated, the preview lists the rows drawn in separately.

> In the first version, to forget a row completely, list all the source data that the row involves as deletion targets. Deleting a whole slot is not in the first version either.

## Corresponding spec

| Content | Specification |
|---|---|
| The definition and the two deviations, the two principles, provenance and contributions, replay rules, corollaries and examples | [`../spec/03-data-model/03-deletion.md`](../spec/03-data-model/03-deletion.md) |
| What the preview and the receipt must state, cancelling and the grace period, content derived from source data, after deletion (including import), the deletion register | Same as above |
| Deletion and premises: when to attach them, when to remove "premise changed" | [`../spec/03-data-model/02-integrity-and-records.md`](../spec/03-data-model/02-integrity-and-records.md) "The premises of a write" |
| Rows with an external key: what happens to the key on deletion, why it syncs in again | [`../spec/03-data-model/04-write-and-read.md`](../spec/03-data-model/04-write-and-read.md) "Writing by external key" |
| Deleting a whole tenant (undecided) | [`../spec/08-open-questions.md`](../spec/08-open-questions.md) "Deleting a whole tenant" |
| References and "whether they block a deletion" | [`../spec/03-data-model/09-references-conflict-sync.md`](../spec/03-data-model/09-references-conflict-sync.md) "References: strong and weak" |
| Content blocks, keeping no values computed from content | [`../spec/03-data-model/02-integrity-and-records.md`](../spec/03-data-model/02-integrity-and-records.md) "Integrity and provenance" |
| The shape of deletion events, what remains after deletion | [`../spec/09-event-format.md`](../spec/09-event-format.md) sections 4.4, 5.9 and 9 |
| The interface of the registry storage, the restore procedure, on-time execution and the failure policy, property tests | [`../spec/02-architecture.md`](../spec/02-architecture.md) §7, §8, §11 |
| `deletion_preview`, `delete`, the handle | [`../spec/04-contract.md`](../spec/04-contract.md); for the types see [`../spec/04-contract-types.md`](../spec/04-contract-types.md) |
| Scope of the first version | [`../spec/07-scope-v1.md`](../spec/07-scope-v1.md) 3.4 |
