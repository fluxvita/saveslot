# saveslot · Data-layer mechanisms · 09 References, conflicts and sync

> Translated from docs/zh-CN/spec/03-data-model/09-references-conflict-sync.md, updated in the same commit as this file.
> The Chinese edition is authoritative; where the two differ, the Chinese one holds.

> Part of the data-layer mechanisms; for the contents see [`README.md`](README.md). A section quoted with "…" in the text may be in another file in the same directory; look it up by the contents.

## References: strong and weak

**The criterion: if the thing referred to is gone, does the referrer still hold?** If it does not (it must be deleted or recomputed), the reference is strong;
if it still holds and only "once pointed to a thing that has since been deleted", the reference is weak.

| Reference | From → to | Strong / weak | Does it block deletion? | How it is handled on deletion |
|---|---|---|---|---|
| The value source of the current value of base data | a write of the current version of a base table → source data (the value source in change_sources) | Strong | Blocks on "evidence deletion" (only value sources whose original text is still present are looked at): rejected by default, and the referrers are listed; does not block privacy deletion; operation sources do not block | Privacy deletion follows "Definition of the result of a deletion": remove the contribution of the deleted source, then replay by the replay rules (see "Deletion") |
| The source of derived data | a derived write → upstream writes (the read set at partition level) | Strong | **Does not block**: derived data can be recomputed | The affected partitions are recomputed |
| The source of a historical version | an overwritten write → source data / upstream writes | Strong | Does not block (the current state does not depend on it) | On cascade, physically erase the content blocks derived from the deleted contribution (the values and sources of those fields in the events of each write, and the corresponding historical values in the version table) and their checksums; otherwise they could be used to infer the deleted content from the history. The result checksums and group key values of derived writes are cleared in the same way |
| A read | read_log → a version of a write | Weak | Does not block | Not changed, no notification; once the content is erased it naturally points to an "erased version" |
| The event header chain / a tombstone | a log event → the position of a deleted content block | Weak | Does not block | The event header is kept, so the chain can still be verified; a tombstone records only an opaque position (event `seq` + block path) and a reason code |

- Example (a week of running records: R2 is the source "ran 7 km today", C3 is the write that adds runs#2 from it, and C4 is the derived write that refreshes the weekly distance W45 as a result): when R2 is under "evidence deletion": the current version C3 of runs#2 refers to R2 directly, so it blocks; W45 is derived data and can be recomputed, so it does not block;
  C4 has been overwritten and is a historical reference. With privacy deletion instead, nothing blocks: after the contribution of R2 is removed, the required fields of runs#2 have no contribution that is still present, so the whole row is deleted and W45 is recomputed.
- The reference relation is a directed acyclic graph (source data → table data → derived data), so reference counting is enough and no tracing GC is needed.
- **Unlike heap memory, a reference count of zero does not mean garbage.** Source data that is not referenced may still be extracted again under a new schema, so it is not reclaimed automatically;
  the reference count is only the threshold for deletion, not what triggers it.

## Where the model lives

**The core path of saveslot does not depend on a model; work that depends on a model is submitted, as an ordinary client, through the same interface.**

- **The deterministic kernel (no model)**: log, storage, schema validation, versions, conflict rules, permissions, audit.
  The trustworthiness that saveslot guarantees cannot be built on model output.
- **Extraction at write time, preferably done by the caller's agent**: the schema is maintained by saveslot, but the reasoning for the step of "turning a sentence into structured data according to the schema"
  is done with the model behind the caller's own agent (it is running a model anyway), so saveslot does not need to call one again;
  and the agent knows best what the user intends at this moment. It reads the schema through MCP, submits structured writes according to the schema with the source data attached, and saveslot only does deterministic validation.
- **A caller without an agent** (a script, a program) writes structured data directly through the API; when it can only supply raw data, the raw data is handed to a background executor that calls a model (a worker) for extraction (the worker is not in the first version, see "Later plans" in the positioning document).
- **The output of the model is recorded as log events**: the result of each extraction (with the source data it refers to and the schema version it used) is recorded in the log as an event.
  Replay uses the recorded result and does not call the model again, like the row-based binlog of MySQL, which records results,
  as opposed to a statement-based one, which re-executes statements containing non-deterministic functions. Only the affected parts need to be extracted again.
- **Work with no agent present is done by a background executor that calls a model (a worker)** (not in the first version): synchronization from external sources, scheduled tasks,
  bulk recomputation after a schema change, and drafting a new schema from accumulated source data.
- A worker is also a client with an identity; the source level of its writes is "agent inferred", and its writes go through the same permissions and conflict rules.
- Model access: **the user brings their own API key**. Without a key, saveslot still runs, only without background extraction and recomputation.

## Semantics: dynamic schema

- **saveslot provides dynamic semantics** (following the "draft → human confirmation → publish" of NVIDIA Auto Ontology),
  so that everyone can have their own shape of data.
- **A curated set of schemas is provided officially**: for example the Health Data Schema and the ledger schema. An official schema is also a public convention:
  a user schema can extend it, and capabilities written for the official schema can be reused.
- **Schema + SKILL published by the community**: the schema defines what the data looks like, and the SKILL tells the user's agent when to write, how to extract and how to use it.
  This corresponds exactly to "extraction at write time is done by the caller's agent".

## Conflict handling

**There is no assumption that a push channel exists, nor that the user will respond promptly.** A conflict is a persistent state, not a one-time notification.

1. **Detected at write time and returned to the writer.** A write carries an expected version; when it does not match and the write changes the same conflict unit, it is recorded as a candidate (not an error), and the receipt tells the writing agent
   (which is talking to the user right now, and is the most reliable "notification").
2. **Brought out on read.** Open conflicts and items awaiting confirmation are attached to the read result, marked "disputed". Any agent that reads next can tell the user;
   the read request itself is the notification channel.
3. **Never blocks.** During a conflict, a definite value in effect is given by the rule for the value in effect in the slot policy. **The rule of the first version is to keep the current value (the one committed first)**; automatic ruling by source level is in "System ruling", later.
   The reader gets "the value in effect + a dispute mark" and decides for itself whether the task goes on (for high impact it stops and asks, for low impact it goes on with the mark).
4. **Does not expire, but does not pile up.** saveslot has no judgement and does not decide for people; conflicts on the same target are merged into one item, and once a writer that has read it changes it, it is marked "superseded" (see "Pending items · No expiry"); when privacy deletion removes the cause of a conflict or all the value sources of the candidates, it is likewise superseded (see "Deletion · Replay rules"); if it stays unhandled for a long time, only the reminder escalates.
5. **Records reads.** It records which task used which version; once a conflict is ruled on afterwards, it can be found out which tasks used the overturned version.

(1 and 2 answer "cannot be notified"; 3 and 4 answer "nobody responds" by relying on a definite value in effect, not on expiry; 5 answers "responds too late".)

### Conflict criteria

**A write expresses "relative to the version I read, what I want to change".** The `ver` it passes back is the version it saw. When `ver` is the current version there is no conflict to speak of; when it is not, call this write W and the version it saw V, and judge by the following steps.

**Conflict unit**: a field, or a field group declared by the schema (`together`, see "Schema document format"). Fields of the same group are judged as a whole: changing any field of the group intersects with a write that changes any field of the group. Without a declaration each field is a unit of its own. A field group affects only the conflict judgement and the target of an item; it does not affect stop points, sources or the same-value judgement.

| Step | What is done |
|---|---|
| ① | Remove the **no-op fields** of W: a field whose value is the same as on V and that does not explicitly point to evidence is not a change of W (see "Deletion · Provenance"); V is taken as it looks after the deletions that were confirmed and not cancelled at the time of the write. A field that the agent passes back unchanged therefore cannot cause a false conflict |
| ② | For each conflict unit left in W, find the **operations L after V that changed its value in effect**: writes that took effect, writes triggered by resolving an item, deletion confirmations and cancellations of a deletion all count (a deletion returns the value to an earlier look, which the writer likewise did not see). A write that became a candidate or went into awaiting confirmation did not change the value in effect and does not count; the values filled by `backfill` at a schema switch do not count either (it does not change `ver`, so writing this row with the `ver` read before the switch does not conflict because of it; when the field itself has an incompatible change, the check on `sv` rejects the write) |
| ③ | Judge by the table below whether W conflicts with each L |
| ④ | No conflict with any L → **merge**: it takes effect directly, and the receipt states that it was merged automatically. On a state table, the interval of W is resolved against the **current** state and applied |
| ⑤ | Conflict with some L → the item of W that took part in the judgement on this conflict unit **becomes a candidate as a whole** and does not take effect; a conflict item is generated, or merged into an existing item on the same target (see "Pending items") |

| Table | W | L | A conflict if and only if |
|---|---|---|---|
| Event, timeless | — | — | this conflict unit was changed by L after V |
| State | default end point | default end point | the start is the same and the values differ |
| State | other combinations: at least one side is an explicit interval (the default interval of a correction counts as an explicit interval) | | the **interval seen** of W intersects the interval of L, and on the intersection the value of W differs from the current value |

- **Both sides being default end points** holds only when the original form of writing of both sides can be read: when the interval block of an item has been removed or is a placeholder from an import, its original form cannot be read, and it is judged as an explicit interval.

- **Group value**: when the conflict unit is a field group, "value" in the table above means the group value. The group value of W = for the fields of the group that W wrote and whose own seen interval holds the instant, the value of W, and for the other fields (those it did not write, and those it wrote whose seen interval does not hold the instant), the value on the version V seen (on a state table taken instant by instant: a field not written may be piecewise in V, and each field written has a seen interval of its own); where V has no value at an instant, the fields taken from V are empty there, since once W takes effect the entity exists at that instant and a field W did not write is empty. The current group value = the current values of the fields of the group; where the current state has no value at an instant, that stays "no value" (the entity does not exist at that instant, which is not an empty field). For default end point against default end point, what is compared is the group value of W with the group value of L at that start after L is applied. A group of a single field is the form in the table above. The group value is used only in this step: the no-op and corroboration of step ① are still judged field by field. Example: W writes a and L writes b (same group), and both orders of arrival conflict. If W and L both write only a, to the same value: on a state table the group values are the same and neither order conflicts; on event tables and timeless tables values are not compared (the first row of the table above), so it conflicts if this conflict unit was changed after V, and in both orders the side that arrives later becomes a candidate.
- **The interval seen** = the result of resolving the interval of W against the state of version V (an explicit interval is itself). On a state table the interval of a candidate is the interval seen, and the whole span becomes a candidate; it is not split into "the intersecting part is a candidate, the rest takes effect": an interval is one sentence, and having half of it take effect is harder to explain to the user. The only thing that splits one field into several items is corroboration: the part that still has the same value gets a source appended, and only the part that has been changed is judged by the table above and becomes a candidate, the whole span of the latter (see "Writing with the same value").
- **The interval of L** = the current resolved result of that item contributed by L: the interval it recorded when written, or the interval that the replay of a later privacy deletion re-resolved for it, whichever the log gave most recently. When L is a deletion confirmation or a deletion cancellation, it is the interval recorded by that event, in which it actually changed the value on this conflict unit, taken as recorded and not recomputed by later deletions (that the writer did not see that deletion is a fact in the log). These intervals are obtained from `results/<k>/fields/<field ID>/<j>` and `results/<k>/existence` of that event (the event format §5.9), compared with the state before it. When any of the blocks of that event for this conflict unit is listed in the position list of the deletion of any item in the set currently being deleted (the event format §3.5 rule 1: an item in `deps` is deleted, or is restated by that deletion; regardless of whether that deletion has expired and been executed), it is treated as having changed the value on the whole conflict unit: this judges more candidates, but never lets a write overwrite a change it has not seen. A deletion confirmation or a deletion cancellation as L is judged by the row of the table above "at least one side is an explicit interval" (what they record is the interval where the value actually changed, not a write with a default end point). When only `results/<k>/existence` is listed in the position list, it is counted as the "existence" unit having been changed as a whole (this deletion or cancellation gave the row or entity a new `ver`), and a field unit is not therefore counted as changed as a whole; whether a field unit was changed as a whole is decided by that unit's own `results/<k>/fields/…` blocks.
- **When L is a proposed write that took effect through confirmation** (the awaiting confirmation of a high-impact write was confirmed), whether it counts as a default end point or an explicit interval follows the original parameters of the proposed write: confirmation is "the proposed write takes effect" (see "Execution semantics of each decision"), and the form of the interval of L is the form of the proposed write.
- One op may have some conflict units take effect and others become candidates; the receipt states this field by field.
- **Symmetry** (with a scope): on a state table, when two writes carry the same `ver`, **neither passes an end, neither explicitly points to evidence, and neither makes a change point in the version seen disappear**, whichever arrives first gives the same conclusion: either both orders conflict, or both orders merge with **the same final value and no item raised**. The latter half relies on high impact ① protecting only the change points that already exist in the version the writer saw: when both orders merge, it is not high impact for the later one to make disappear a change point that the earlier one has just created (see "High-impact writes"). Corroboration does not change `ver`; a later write that carries this `ver` and for which this `ver` is still current at write time counts as having seen it, and falls outside this clause; for the consequence of its overwriting a corroboration segment see "Writing with the same value".
  No such promise is made outside this scope. Three cases are known where the results of the two orders differ (none of the three loses a write, and none lets a candidate quietly take effect):
  - (a) **One side gives an explicit interval, the other passes no end, with the same start and the same value**: no conflict, both orders merge and raise no item, but the final states differ. A default end point is resolved against the current state at merge time: if the explicit side arrives first, its end becomes a stop point, the later side stops there, and after the explicit end the original value is kept; if the side that passes no end arrives first, the new value continues indefinitely.
  - (b) **One side goes into awaiting confirmation because of high impact**: a write awaiting confirmation did not change the value in effect and does not count as an L of the other side (step ②). So for the same pair of writes, in one order the later one becomes a candidate, and in the other order one side is awaiting confirmation and the other takes effect directly. Both orders need a person to handle it, with different kinds of item.
  - (c) **The default end point of one side stops at a stop point in the version seen, and the other side carries `acknowledge` and erases that stop point**: both orders merge and raise no item, but the final states differ. If the side that erases the stop point arrives first, the default end point of the other is resolved against the current state, goes past the original stop point and continues, overwriting the value of that segment in the version it saw; conversely, it stops at the original stop point. It is the same when it is a corroboration.
  These three cases are results of the current rules, not defects of the implementation; whether the rules are to be changed so that they too are symmetric is in [`../08-open-questions.md`](../08-open-questions.md). Which test guards each case is in [`../11-claims.md`](../11-claims.md).
- Validation that depends on the current state (for example, an interval without a value must carry all the required fields) is done after the conflict judgement, and only for the part that is about to take effect; it is not done for a candidate. Otherwise the same pair of concurrent writes would report an error in one order and become a candidate in the other (for the order of judgement see "The write request · The order of judgement").

**The version seen for writes by external key** (see "Writing by external key"): the connector has not read this row and cannot pass back `ver`; all it knows is "what the source system now says this record is". So the judgement compares three things: the value delivered by external key last time, the current value in effect and the value delivered this time, and the version seen is given by the kernel **per field**. First, three terms are defined (all mechanical judgements; the key field of the external key is not among them, as it contributes only in the write that obtained the key):

- **Sync contribution**: a contribution that a write by external key makes to some field of this row, whether it was then in effect, corroborating, a candidate or awaiting confirmation; and the item carried over when such a candidate is adopted. **Not counted**: items written back by `take_previous` and `undo`: they are values brought out by a person's handling, not delivered by the source system.
- **Sync contribution in effect**: a sync contribution whose current state is `applied` / `corroborated` and which is **not registered as "already reverted"**. A sync contribution reverted by `undo` is still a sync contribution (it counts toward the baseline value) but is no longer in effect (it does not count toward the baseline position); whether a reverted item is in effect is decided by the revert record.
- **Sync baseline**, per field:
  - **Baseline value** = the value of the latest sync contribution on this field; with no sync contribution yet there is no baseline value.
  - **Baseline position** = the operation number of the latest sync contribution in effect on this field; with none, the operation in which this row obtained its external key (the operation that added it by external key, or the one that added the key).
  - When the key **is transferred** from a revoked row: for a field of this row that, after the key was added, has no sync contribution of its own yet, the baseline value continues the value of the latest sync contribution on this field of the original row (with no baseline value when the original row has none), and the baseline position is the operation that added the key. Once it has sync contributions of its own, only its own are looked at. After the key-field contribution of the write that added the key is removed by a deletion execution, the key goes back to the original row that gave it up (still revoked), and this row no longer counts as "the key was transferred in"; in a deletion replay, a later sync op by this key hits the revoked original row, and is handled by "Revoked rows do not come back" (restated as `dropped`).
  - Taken per field, not per conflict unit: the sync contribution of another field in the same conflict unit does not mean that the value delivered this time has seen the local changes on this field.

The criteria replace only two inputs and the rest is unchanged:

| Step | Ordinary write | Write by external key |
|---|---|---|
| ① Same value | compared with the value on the version seen | **compared with the baseline value**. The same as the baseline value → the source has not changed: whether or not evidence was pointed to, when the current value in effect differs from it it is always a no-op (not proposed again); when the current value in effect is also the same as it, it is a corroboration if evidence was pointed to and a no-op if not. A field with no baseline value is compared with the value at the baseline position, with the same rules as an ordinary write |
| ②–⑤ Conflict | V = the `ver` passed back or the fallback | **V = the baseline position of this field**. If the conflict unit of this field was changed by another operation after the baseline position → candidate, and a conflict item is generated or merged into; if not changed → takes effect |

- The conflict item is the same as for an ordinary write: the target is (row, conflict unit), and candidates are merged into it; the "`ver` it carries" of a candidate is the baseline position of this field, and the merge base is as usual the earliest of the versions carried by the candidates.
- The "symmetry" above is about two writes that carry the same `ver`; the version seen for a write by external key is taken by the kernel by log position, writes of the same tenant are serialized, and the result depends only on the log.
- Effect: a value that the user changed in saveslot is not overwritten by every sync (if the source has not changed it is a no-op); when the source changed and the value was also changed locally, it becomes a candidate and does not overwrite; a candidate is also a sync contribution, so the same candidate is not merged in again by every sync, and a source value that the user rejected by "keep the value in effect" or "go back to before the conflict" does not take effect directly in the next sync; when the source changes again, a person is asked again.

**Why two writes with default end points and different starts do not conflict**: each declares only "from some day on the value is v", and whichever arrives first the result is the same (except when one side erases the stop point the other stops at, see (c) of the symmetry clause above). Once one side gives an explicit interval, the range it covers no longer changes with the other side and must be judged by the interval seen, otherwise the merge result would depend on the order.

**Example (state table)**: `[10-01, ∞) 5000`, with A and B carrying the same `ver`.

| A | B | Both orders of arrival |
|---|---|---|
| "3000 from 11-10", no end passed | "4000 from 11-02", no end passed | both merge, and the result is in both cases 5000 · `[11-02, 11-10) 4000` · `[11-10, ∞) 3000` |
| "3000 from 11-10", no end passed | `[11-02, open) 4000` | both conflict: the later one becomes a candidate |
| changes December `[12-01, 2027-01-01)` | changes late November `[11-20, 12-01)` | the intervals do not intersect, both merge |

The third row is why the judgement is by interval: `ver` is given per entity, and if only the entity were looked at, any two concurrent writes on the same entity would be judged as a conflict, and unattended agents would keep producing false conflicts.

### Revoke and concurrent changes

A revoke carries no value, and by field it has "no intersection" with any change. So it is specified separately:

- **A revoke changes the "existence" of a row / entity, and intersects every conflict unit** (on a state table: within the revoked interval). A stale revoke that meets any change in effect in the meantime → candidate; a stale change that meets a revoke in the meantime → candidate. The target of such an item is (row / entity, existence); when it conflicts with both a revoke and a field change in the meantime, it also belongs to "existence" (a revoke changes whether the row or entity is there, which is more fundamental than a dispute on a field, and a candidate is in only one item), and for how it is handled see "Execution semantics of each decision".
- **Event tables and timeless tables**: a revoked row cannot be written. A change or a correction reports `revoked` (with the operation number of the write that revoked it, and a hint to restore with `revert: {undo}`); revoking again is a no-op.
- **State tables**: a revoke is "no value for this period", and later writes are handled as filling an interval without a value (see "Revoking on state tables").
- **Adopting a change candidate (the target is "existence")**: within the candidate interval the entity has a value again and this change is applied; for a required field the candidate did not give, the value of the merge base over that interval is taken, recorded as carried over (the value source is a reference to those contributions at the merge base); when it cannot be taken from the merge base either, `resolve` reports `validation_failed` (`required_in_gap`), with a hint to use `keep_effective` instead or to fill in the fields first. The part of the revoked interval outside the candidate interval stays without a value.

**Example**: A and B both read r7 (the same `ver`). B corrects `distance` from 10 to 5. A revokes r7 with the old `ver` ("this entry is a duplicate"). The revoke of A becomes a candidate; conversely, if A revokes first and B changes afterwards, the change of B becomes a candidate. Both orders are judged as a conflict.

### Both a version mismatch and high-impact

Conflict takes precedence: this write becomes a candidate and a conflict item is generated. If the candidate would be high-impact were it to take effect, the effect of the item also lists the segments that would be overwritten; adopting the candidate is the confirmation of that content, and no separate awaiting confirmation is generated. For what happens after the conflict disappears because of privacy deletion, see "Deletion · Replay rules".

### System ruling

> **Not in the first version.** In the first version a conflict always keeps the current value; the source level and the literal match are still recorded in events as usual (see "Source level") for future use.

- Rule: the authoritative source first; user stated > agent inferred, counting only the level that has a literal match. It is written as a **rank table** in the slot policy: rank = the declared level when matched, the lowest when not matched; the strictly higher rank wins, equal ranks keep the current value, and among several candidates of equal rank the one with the earliest write number is taken.
- When the value in effect ruled by the rule differs from the current value, it is materialized as a new version (intent "system ruling"; value source = the value source of the candidate write, and the item is only the operation source), and derived data is refreshed; the result of that field in the receipt is `applied_by_rule` (with `pi_…`), and it triggers the query for reads a correction affects just as a correction does (see "Querying the reads a correction affects"). After a candidate becomes the value in effect by system ruling, the item remains open.
- When system ruling is added back, old writes and old items are not re-judged automatically: every judgement records the rule version and the policy version at that time (see "The write request · Rule version and policy version").

## Sync protocol (one primary node per user)

> **Not in the first version** (the positioning document, "Later plans · Multi-node"). Both running modes of the first version are single node; this section is kept as a future design.
>
> **The structure the first version leaves for it**: the event header has no `event_id`; the genesis event and the restore event each carry a `node_id`, and the permanent identity of an event = (the `node_id` of the latest genesis or restore event, `seq`). When multiple nodes are added, old events need no change.
>
> **The external contract of the first version contains nothing about multiple nodes**: node credentials, the log synchronization endpoint, the `tentative` status and flag, and the `sync_rejected` item are not in the contract / surfaces; later they are added by a minor version of the contract, with the `tentative` write status and the `sync_rejected` item kind (the architecture document §6: adding an enum value raises the minor version, and callers must tolerate unknown values). What follows is the semantics at that time:
>
> - **Writes**: when the local node is online, the write is forwarded synchronously to the primary node and the receipt is the result of the primary node; when offline, the receipt is `tentative` (recorded on this machine, not yet accepted by the primary node).
> - **`sync_rejected` item**: generated when an offline write is demoted to a candidate by the primary node or rejected for violating the schema; decisions `rewrite` (returns the original write and the current schema, and the caller rewrites it by the current schema, with this item as a source) / `discard`.

A lightweight HTTP log synchronization protocol is written in-house, with a transport layer compatible with Durable Streams (MIT, draft), and without introducing a full sync engine
(Electric / PowerSync / Zero all take the server as authoritative by default, Turso quietly overwrites, and CRDTs pick a winner automatically; none of these fits the conflict rules of saveslot).

| Identifier | Meaning |
|---|---|
| `node_id` | generated by each node at installation |
| `event_id = (origin_node_id, origin_seq)` | the permanent identity of an event, generated at offline write time; **the chain hash is not used as identity** (after the primary node accepts an event it re-chains it by its own position) |
| `log_pos` | a position assigned only by the primary node (monotonic per user) |
| `primary_epoch` | increased by 1 at every switch of the primary node, which invalidates the old primary node |

- **Downstream** (primary node → replica): the replica pulls with `last_log_pos`, every batch ends with a checkpoint (position, rolling checksum, epoch), the whole batch is applied atomically, and a checksum mismatch causes a resync.
- **Upstream** (offline node → primary node): submitted in batches in `origin_seq` order; for each origin node the primary node persists `last_origin_seq` (in the same transaction as the log append),
  returns the original result for what has been processed (idempotent), asks for a resend from the expected position when there is a gap in the numbers, and tells a node with a stale epoch who the new primary node is.
- **The primary node handling offline events**: source data is always accepted and is rejected only when it hits a tombstone; writes to business tables have their expected versions checked again in `log_pos` order,
  and those that do not match are demoted to candidate versions or awaiting confirmation by the conflict rules, while those that violate the schema are rejected (the source data is kept and marked for re-extraction); the result of the handling is synchronized back to the origin node as events.
- **On the offline node locally**: split into a confirmed layer and a tentative layer, with the tentative state explicitly marked in read results (`tentative: true`); on reconnection **pull first (at least up to the latest tombstone), then push**;
  a local tentative event that hits a new tombstone is dropped locally.
- **Switching the primary node**: a signed control event in the log, with the epoch increased by 1; on an unplanned takeover, the writes made after the old primary node comes back are resubmitted by `event_id` as offline writes, and no data is lost.
- **Export = one complete downstream sync from position 0** (including tombstones), so "can leave" and "replicate" are the same code path.
- The first version replicates in full; partial replication is by slot, and tombstones and control events are always replicated in full. With partial replication in the future, event headers are still replicated in full, so **an event header contains only opaque IDs**
  (readable names of tables, rows and slots are in the content).
- **Read records are not replicated by sync in the first version**: the query for reads a correction affects covers only the reads on the primary node; if a tentative value read by an offline node is rejected by the primary node, it is only annotated locally on that node.
- Sync between nodes uses a node identity (a device credential issued by the user), which is a different level from the "connection identity" (agent to node).
