// What a privacy deletion would do, worked out on the state now (docs/zh-CN/spec/03-data-model/
// 03-deletion.md «预览与回执要写明的内容», «删除结果的定义»; 09-event-format §5.9): the (event, target)
// contributions its sources take away, each affected row's or entity's replay, the positions it
// lists, and the impact summary its confirmation handle binds. Read only, in one read transaction;
// the preview and the confirmation both start here, so what is confirmed is what was previewed
// unless the impact summary changed (`preview_outdated`).
//
// Earlier deletions on an affected row are read from the log (./deletion-row.ts): the event is
// worked out with the other pending deletions, the list of positions with this one alone. The
// pending items it changes are changed by item events after its own (./deletion-items.ts).
// Every other shape, and each shape the later parts of the deletion do not apply yet, is
// refused before anything is appended, as `not_implemented` with a kind of its own:
//
// - `ops_after_deletion`: an operation on an affected row after its earliest deletion or
//   cancellation (it meets that event as L of the conflict criterion, not read yet);
// - `executed_deletion_on_row`: a deletion carried out touched an affected row (not applied yet);
// - `pending_items_touched`: an open item of a type other than a conflict or an awaiting
//   confirmation (a `flagged` item) has an entry block on the list of positions (its supersession or
//   refresh, 03-deletion «删除结果的定义», is not made yet);
// - `awaiting_not_a_write`: an awaiting item the deletion would open is a revert's or a revoke's
//   proposal (its `impact.reverted` / `referrers` are not worked out) (./deletion-items.ts);
// - `items_restored`, `succeeded_as_conflict`: members or candidates go back to their original
//   item, one an earlier deletion superseded or one still open whose candidates an earlier
//   deletion dropped (not reached with no earlier deletion), or a write awaiting is a conflict
//   candidate after (its new conflict item's candidate entry is not made yet)
//   (./deletion-items.ts);
// - `external_key`: the table has an external key (keys with deletion);
// - `premise`: a premise declaration names an affected row, as its target or its dependent row
//   (premises with deletion: the forecast and `premise.changed`);
// - `schema_const`: an affected row holds a schema constant's backfill (not applied with deletion);
// - `derived`: a derived table depends on an affected table (its `write.derived` events);
// - `item_numbered_anew`: a restatement gives an (event, target) an item index it did not have
//   (apply does not number items anew);
// - `referenced_revoke_awaiting`: an affected row refers to a row whose revoke awaits for its
//   referrers (high impact ②), or such a revoke, undecided, is on an affected row;
//   `revoke_conflict_cleared`, `revoke_noop_now_effective`: on a table that may be referred to, a
//   revoke that takes effect in the replay where, when written, it was a candidate whose conflict
//   the deletion clears, or a no-op (the row revoked already). A revoke awaits only for high
//   impact ②, so an awaiting one is the kind above (03-deletion «高影响（重算）»: who
//   refers to it is other rows', which the replay of the affected rows does not see). The replay
//   refuses the shapes on the row itself; the referrer on another row is refused here.

import { createHash } from "node:crypto";
import {
  type CompiledBaseTable,
  type CompiledSchema,
  canonicalize,
  type FieldId,
  type FieldValue,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import { slotVersions as shapesOf } from "../apply/shapes.ts";
import { positionsOf, readPositionIndex } from "../delete/positions.ts";
import { type BaseCitations, readCitations, takenAway } from "../delete/taken.ts";
import { JudgeError } from "../judge/errors.ts";
import type { BlockAddress, OpRecord, Restatement, TableShape } from "../judge/index.ts";
import { stateFromRecord, view } from "../judge/index.ts";
import { deletionResult, replayDeletion } from "../judge/replay-deletion.ts";
import { givenByRecords } from "../judge/restate.ts";
import { readTail } from "../log/log.ts";
import type { ReadTx } from "../store/ports.ts";
import { restoreHistory } from "../store/restore-point.ts";
import { WriteError } from "../write/errors.ts";
import { replayShape } from "../write/plan.ts";
import { readSlots, rowEvents } from "../write/reads.ts";
import { decodeRecords, type RowContext, type StoredEvent } from "../write/record.ts";
import { type ItemEventsOut, itemEventsOf, itemsFromLog, type LogItem } from "./deletion-items.ts";
import { priorDeletions, rowInputs } from "./deletion-row.ts";

/** The kinds of deletion this version refuses (see the file's head). */
export type RefusedKind =
  | "ops_after_deletion"
  | "executed_deletion_on_row"
  | "referenced_revoke_awaiting"
  | "external_key"
  | "premise"
  | "schema_const"
  /** A row written before a schema switch that rebuilt its table: the replay does not model it. */
  | "schema_switch"
  | "derived"
  | "item_numbered_anew"
  | "pending_items_touched"
  | "items_restored"
  | "succeeded_as_conflict"
  | "awaiting_not_a_write"
  /** Refused by the replay (judge/replay-deletion.ts), passed on with its kind. */
  | "revoke_conflict_cleared"
  | "revoke_noop_now_effective";

const refuse = (kind: RefusedKind, message: string, detail: Record<string, unknown> = {}) =>
  new WriteError("internal", `a deletion ${message} is not implemented`, {
    reason: "not_implemented",
    kind,
    ...detail,
  });

/** One affected row or entity, its replay worked out. */
export interface RowPlan {
  readonly table: CompiledBaseTable;
  readonly shape: TableShape;
  readonly id: string;
  readonly isState: boolean;
  readonly records: readonly OpRecord[];
  /** The row's events (its own and its items'). */
  readonly events: readonly StoredEvent[];
  /** Its pending items, as their events say. */
  readonly items: ReadonlyMap<string, LogItem>;
  /** The last event of the row's log (its own and its items'): what its version is in the summary. */
  readonly last: Seq;
  readonly result: ReturnType<typeof deletionResult>;
  /** This deletion's restatements alone, without the other pending deletions (its positions). */
  readonly restatedAlone: readonly Restatement[];
}

/** The affected set, canonical: what the impact summary's hash is of. */
export interface AffectedSet {
  readonly rows: readonly { readonly table: string; readonly id: string; readonly last: Seq }[];
  readonly sources: readonly { readonly seq: Seq; readonly state: string }[];
  /** The pending items on the affected rows, with their versions and how they stand. */
  readonly items: readonly {
    readonly id: string;
    readonly version: number;
    readonly standing: string;
  }[];
}

export interface DeletionPlan {
  readonly slot: string;
  readonly sources: readonly Seq[];
  readonly sourceIds: readonly string[];
  readonly bases: readonly BaseCitations[];
  /** The (event, target) contributions taken away. */
  readonly deleted: ReadonlySet<string>;
  readonly rows: readonly RowPlan[];
  readonly restated: readonly Restatement[];
  /** Each affected row's item events, worked out with placeholder IDs for new items. */
  readonly items: readonly ItemEventsOut[];
  /** The same, with the new items' IDs `newId` gives. */
  readonly itemEvents: (newId: () => string) => readonly ItemEventsOut[];
  /** The deletion event's own seq, if it were appended now. */
  readonly self: Seq;
  readonly positions: readonly BlockAddress[];
  readonly affected: AffectedSet;
  /** SHA-256 of the JCS of `affected`, hex. */
  readonly hash: string;
  /** The tail of the log the plan was worked out on. */
  readonly tail: Seq;
}

/** The impact summary's hash: SHA-256 over the JCS of the affected set. */
export const affectedHash = (a: AffectedSet): string =>
  createHash("sha256")
    .update(canonicalize(a as unknown as JsonValue))
    .digest("hex");

/** The sources by their external IDs: one slot, none deleted or pending deletion. */
async function sourcesOf(
  tx: ReadTx,
  ids: readonly string[],
): Promise<{ slot: string; seqs: Seq[]; states: Map<Seq, string> }> {
  if (ids.length === 0) {
    throw new WriteError("invalid_argument", "sources: at least one", {
      reason: "missing",
      param: "sources",
    });
  }
  const r = await tx.query<{
    seq: unknown;
    source_id: string;
    slot_id: string;
    deletion_state: string;
  }>("SELECT seq, source_id, slot_id, deletion_state FROM sources WHERE source_id = ANY($1)", [
    [...new Set(ids)] as never,
  ]);
  const found = new Map(r.rows.map((x) => [x.source_id, x]));
  const missing = ids.filter((id) => !found.has(id));
  if (missing.length > 0) {
    throw new WriteError("not_found", "no such source", {
      reason: "source",
      param: "sources",
      sources: missing,
    });
  }
  const slots = [...new Set(r.rows.map((x) => x.slot_id))];
  if (slots.length !== 1) {
    throw new WriteError("invalid_argument", "the sources are in more than one slot", {
      reason: "cross_slot",
      param: "sources",
    });
  }
  const gone = r.rows.filter((x) => x.deletion_state !== "present");
  if (gone.length > 0) {
    throw new WriteError("invalid_argument", "a source is deleted or pending deletion", {
      reason: "pending_deletion_source",
      param: "sources",
      sources: gone.map((x) => x.source_id),
    });
  }
  const seqs = r.rows.map((x) => Number(x.seq) as Seq).sort((a, b) => a - b);
  return {
    slot: slots[0] as string,
    seqs,
    states: new Map(r.rows.map((x) => [Number(x.seq) as Seq, x.deletion_state])),
  };
}

/**
 * The open items, other than conflicts and awaiting confirmations, the deletion touches: on an
 * affected row or entity, or with an entry block on the list of positions. The item events of this
 * version do not change them.
 */
async function otherItemsTouched(
  tx: ReadTx,
  positions: readonly BlockAddress[],
  rows: ReadonlySet<string>,
): Promise<string[]> {
  const r = await tx.query<{
    id: string;
    target_row: string | null;
    content_seq: unknown;
    content_path: string | null;
  }>(
    `SELECT i.id, i.target_row, e.content_seq, e.content_path FROM pending_items i
     LEFT JOIN pending_entries e ON e.item_id = i.id
     WHERE i.state = 'open' AND i.type NOT IN ('conflict', 'awaiting_confirmation')`,
  );
  const listed = new Set(positions.map((p) => `${p.seq}\u0000${p.path}`));
  return [
    ...new Set(
      r.rows
        .filter(
          (x) =>
            (x.target_row !== null && rows.has(x.target_row)) ||
            (x.content_path !== null &&
              listed.has(`${Number(x.content_seq)}\u0000${x.content_path}`)),
        )
        .map((x) => x.id),
    ),
  ].sort();
}

/** Every compiled schema version the slot has had: whether a table may be referred to. */
async function slotVersions(tx: ReadTx, slot: string): Promise<CompiledSchema[]> {
  const r = await tx.query<{ body: string }>(
    `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1 AND c.body IS NOT NULL`,
    [slot],
  );
  return r.rows.map((x) => JSON.parse(x.body) as CompiledSchema);
}

/**
 * The open items awaiting a revoke of high impact ② (`referencing_row` impact entries) one of whose
 * referrers is among `rows`: the deletion would change who refers to the revoked row, which the
 * replay of the affected rows does not see (03-deletion «高影响（重算）», this version's limit).
 */
async function awaitingReferredBy(tx: ReadTx, rows: ReadonlySet<string>): Promise<string[]> {
  if (rows.size === 0) return [];
  const r = await tx.query<{ item_id: string; body: string }>(
    `SELECT e.item_id, c.body FROM pending_entries e
     JOIN pending_items i ON i.id = e.item_id
     JOIN content c ON c.seq = e.content_seq AND c.path = e.content_path
     WHERE i.state = 'open' AND i.type = 'awaiting_confirmation'
       AND e.content_path LIKE 'impact/%' AND c.body IS NOT NULL`,
  );
  const out = new Set<string>();
  for (const x of r.rows) {
    const b = JSON.parse(x.body) as { kind?: string; row?: string; entity?: string };
    const id = b.row ?? b.entity;
    if (b.kind === "referencing_row" && id !== undefined && rows.has(id)) out.add(x.item_id);
  }
  return [...out].sort();
}

/** Whether a premise declaration names the row or entity, as its target or its dependent row. */
async function inPremise(tx: ReadTx, id: string): Promise<boolean> {
  const r = await tx.query<{ n: unknown }>(
    "SELECT 1 AS n FROM premise_decls WHERE target_row = $1 OR dep_row = $1 LIMIT 1",
    [id],
  );
  return r.rows.length > 0;
}

async function holdsSchemaConst(tx: ReadTx, id: string): Promise<boolean> {
  const r = await tx.query<{ n: unknown }>(
    "SELECT 1 AS n FROM base_sources WHERE row_id = $1 AND source_kind = 'schema_const' LIMIT 1",
    [id],
  );
  return r.rows.length > 0;
}

/**
 * Whether row `id` of table `table` has an item written before a schema switch that rebuilt the
 * table: its replay would read old shapes and recompute existence without the fields the switch
 * dropped, which the deletion's replay does not model yet.
 */
async function crossesRebuild(
  tx: ReadTx,
  slot: string,
  table: string,
  id: string,
): Promise<boolean> {
  const versions = await shapesOf(tx, slot);
  let prev: string | undefined;
  for (const v of versions) {
    const t = v.compiled.tables.find((x) => x.id === table);
    const phys = t?.kind === "base" ? t.physical.table : undefined;
    if (prev !== undefined && phys !== undefined && phys !== prev) {
      const r = await tx.query<{ n: unknown }>(
        "SELECT 1 AS n FROM base_sources WHERE row_id = $1 AND event_seq < $2 LIMIT 1",
        [id, v.switchedSeq],
      );
      if (r.rows.length > 0) return true;
    }
    prev = phys;
  }
  return false;
}

const lastOf = (events: readonly StoredEvent[]): Seq =>
  events.reduce((m, e) => Math.max(m, e.header.seq), 0) as Seq;

/**
 * Works out a deletion of `sourceIds` on the state `tx` reads. Refuses (`WriteError`) what this
 * version does not do, before anything else is worked out where it can.
 */
export async function planDeletion(
  tx: ReadTx,
  input: { readonly sourceIds: readonly string[] },
): Promise<DeletionPlan> {
  const { slot, seqs, states } = await sourcesOf(tx, input.sourceIds);
  return planDeletionOf(tx, { slot, sources: seqs, states, sourceIds: input.sourceIds });
}

/**
 * The same, from the sources' seqs in `slot`, already found to be there and not pending deletion
 * (`planDeletion` checks that from their IDs). `states`: each source's deletion state, for the
 * summary (`present` when not given).
 */
export async function planDeletionOf(
  tx: ReadTx,
  input: {
    readonly slot: string;
    readonly sources: readonly Seq[];
    readonly states?: ReadonlyMap<Seq, string>;
    readonly sourceIds?: readonly string[];
  },
): Promise<DeletionPlan> {
  const slot = input.slot;
  const seqs = [...new Set(input.sources)].sort((a, b) => a - b);
  const states = input.states ?? new Map<Seq, string>();
  const slotRow = (await readSlots(tx)).find((s) => s.slot === slot);
  if (slotRow === undefined) {
    throw new WriteError("internal", "the sources' slot has no current schema", {
      reason: "inconsistent",
    });
  }
  const compiled: CompiledSchema = slotRow.compiled;
  const tail = ((await readTail(tx))?.seq ?? 0) as Seq;
  const bases = await readCitations(tx, slot, seqs);
  const deleted = takenAway(bases, new Set(seqs));

  // The rows and entities a contribution is taken away from.
  const byRow = new Map<string, string>();
  for (const b of bases) {
    if (b.targets.some((t) => deleted.has(`${b.event}/${t}`))) byRow.set(b.row, b.table);
  }
  const prior = byRow.size === 0 ? { deletions: [], events: [] } : await priorDeletions(tx, slot);
  const versions = await slotVersions(tx, slot);
  // A referrer of a revoke awaiting for high impact ②, on another row: refused, as the replay
  // refuses such a revoke on the row itself (`referenced_revoke_awaiting`).
  const awaiting = await awaitingReferredBy(tx, new Set(byRow.keys()));
  if (awaiting.length > 0) {
    throw refuse("referenced_revoke_awaiting", "of a row referring to a revoke awaiting for it", {
      items: awaiting,
    });
  }
  const restores = await restoreHistory(tx);
  const rows: RowPlan[] = [];
  for (const [id, tableId] of [...byRow].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
    const table = compiled.tables.find((t) => t.id === tableId);
    if (table === undefined || table.kind !== "base") {
      throw new WriteError("internal", "a cited row's table is not a base table now", {
        reason: "inconsistent",
      });
    }
    if (table.external_key !== undefined) {
      throw refuse("external_key", "on a table with an external key", { table: tableId });
    }
    if (
      compiled.tables.some(
        (t) => t.kind === "derived" && t.rule.depends_on.some((d) => d.table === tableId),
      )
    ) {
      throw refuse("derived", "on a table a derived table depends on", { table: tableId });
    }
    if (await inPremise(tx, id)) {
      throw refuse("premise", "on a row a premise declaration names", { row: id });
    }
    if (await holdsSchemaConst(tx, id)) {
      throw refuse("schema_const", "on a row holding a schema constant", { row: id });
    }
    if (await crossesRebuild(tx, slot, tableId, id)) {
      throw refuse("schema_switch", "on a row written before a switch that rebuilt its table", {
        row: id,
      });
    }
    // Whether the table may be referred to, by every version the slot has had: the replay refuses a
    // revoke a candidate or a no-op when written that takes effect, on such a table
    // (`revoke_conflict_cleared`, `revoke_noop_now_effective`).
    const shape = replayShape(table, versions);
    const isState = shape.kind === "state";
    const ctx: RowContext = {
      table: table.id,
      target: isState ? { entity: id as never } : { row: id as never },
      shape,
      granularity: isState && table.time.type === "state" ? table.time.granularity : "date",
      restores,
    };
    // The row from every contribution, those earlier pending deletions list included: the replay
    // works out this deletion's positions as the confirmation will (each lists its own in full).
    const events = await rowEvents(tx, table.id, id, { includePendingDeletionBlocks: true });
    // Earlier deletions on the row: the other pending ones and the blocks they and the
    // cancellations gave (./deletion-row.ts); what this version does not read, refused.
    const inputs = rowInputs(ctx, events, prior);
    if ("kind" in inputs) {
      throw refuse(
        inputs.kind,
        inputs.kind === "ops_after_deletion"
          ? "on a row written or decided on after an earlier deletion"
          : "on a row a deletion carried out touched",
        { row: id, ...inputs },
      );
    }
    const records = inputs.records;
    // The state before this deletion: the records', with the other pending deletions (and what
    // cancellations kept in effect) replayed, as `deletionResult` takes it. An awaiting item an
    // earlier deletion opened has its members there, not in the records as written.
    const state =
      inputs.pendingBefore.size > 0 || inputs.keptEffective.size > 0
        ? replayDeletion(
            shape,
            records,
            inputs.pendingBefore,
            [],
            inputs.latest,
            new Set(),
            inputs.keptEffective,
          ).state
        : stateFromRecord(shape, records);
    // Which pending item each (event, target) is in, as the row's item events say.
    const logItems = itemsFromLog(
      events,
      state,
      inputs.pendingBefore.size > 0 || inputs.keptEffective.size > 0
        ? stateFromRecord(shape, records)
        : undefined,
    );
    let result: ReturnType<typeof deletionResult>;
    let restatedAlone: readonly Restatement[];
    try {
      const withOthers = inputs.pendingBefore.size > 0 || inputs.touchedBy.length > 0;
      // The list of positions is this deletion's alone, apart from the other pending ones
      // (03-deletion «多项删除各自列全位置»): its own replay's restatements.
      const alone = withOthers
        ? replayDeletion(
            shape,
            records,
            deleted,
            [],
            inputs.latestAlone,
            new Set(),
            inputs.keptEffective,
          ).restated
        : undefined;
      // What its own list clears, the event restates as it is too (09 §5.9 rule 2): by a dep
      // deleted or restated alone, or a carried item deleted or restated alone as dropped.
      const byRef = new Map(
        (alone ?? []).map((r) => [`${r.item.event}/${r.item.target}/${r.item.k}`, r]),
      );
      const ref = (d: { event: number; target: string; k: number }) =>
        `${d.event}/${d.target}/${d.k}`;
      const takenHere = (d: { event: number; target: string }) =>
        deleted.has(`${d.event}/${d.target}`);
      result = deletionResult(
        shape,
        records,
        new Set([...deleted, ...inputs.pendingBefore]),
        inputs.pendingBefore,
        logItems.given,
        () => [],
        inputs.latest,
        inputs.keptEffective,
        withOthers
          ? {
              dep: (d) => takenHere(d) || byRef.has(ref(d)),
              carried: (d) => takenHere(d) || byRef.get(ref(d))?.status === "dropped",
            }
          : undefined,
      );
      restatedAlone = alone ?? result.replay.restated;
    } catch (e) {
      // A shape the replay refuses (`not_implemented`, by its kind): refused as this version's.
      if (e instanceof JudgeError && e.reason === "not_implemented") {
        throw new WriteError("internal", e.message, {
          reason: "not_implemented",
          kind: String(e.detail["kind"] ?? "replay"),
          row: id,
        });
      }
      throw e;
    }
    // An item index a restatement gives that the (event, target) did not have.
    for (const r of result.replay.restated) {
      const had = result.before.items.some(
        (x) => x.event === r.item.event && x.target === r.item.target && x.k === r.item.k,
      );
      const given = records.some(
        (x) =>
          x.event === r.item.event &&
          "items" in x &&
          x.items.some((y) => y.target === r.item.target && y.k === r.item.k),
      );
      if (!had && !given) {
        throw refuse("item_numbered_anew", "numbering an item anew", {
          row: id,
          item: `${r.item.event}/${r.item.target}/${r.item.k}`,
        });
      }
    }
    rows.push({
      table,
      shape,
      id,
      isState,
      records,
      events,
      items: logItems.items,
      // The deletion and cancellation events that touched it count: cancelling another deletion
      // since the preview changes what this one does (preview_outdated).
      last: Math.max(lastOf(events), ...inputs.touchedBy) as Seq,
      result,
      restatedAlone,
    });
  }

  const restated = rows.flatMap((r) => r.result.replay.restated);
  const alone = rows.flatMap((r) => r.restatedAlone);
  const self = (tail + 1) as Seq;
  const index = await readPositionIndex(tx, {
    slot,
    sources: seqs,
    bases,
    deleted,
    restated: alone,
  });
  const positions = positionsOf({ sources: seqs, deleted, restated: alone, index, self });
  const listed = new Set(positions.map((p) => `${p.seq} ${p.path}`));
  const others = await otherItemsTouched(tx, positions, new Set(rows.map((r) => r.id)));
  if (others.length > 0) {
    throw refuse(
      "pending_items_touched",
      "changing a pending item other than a conflict or an awaiting confirmation",
      {
        items: others,
      },
    );
  }
  // The item events, worked out now so that a shape they do not cover refuses at the preview; the
  // confirmation works them out again with the new items' IDs.
  const itemEvents = (newId: () => string) =>
    rows.map((r) =>
      itemEventsOf({
        slot,
        table: r.table.id,
        target: r.isState ? { entity: r.id } : { row: r.id },
        events: r.events,
        items: r.items,
        layer: r.result.items,
        after: r.result.replay.state,
        records: r.records,
        listed,
        self,
        newId,
      }),
    );
  let n = 0;
  const items = itemEvents(() => `pi_${String(++n).padStart(16, "0")}`);

  const affected: AffectedSet = {
    rows: rows.map((r) => ({ table: r.table.id, id: r.id, last: r.last })),
    sources: seqs.map((seq) => ({ seq, state: states.get(seq) ?? "present" })),
    items: rows
      .flatMap((r) =>
        [...r.items.values()].map((x) => ({
          id: x.id,
          version: x.versionOp,
          standing: x.standing.kind,
        })),
      )
      .sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0)),
  };
  return {
    slot,
    sources: seqs,
    sourceIds: [...(input.sourceIds ?? [])],
    bases,
    deleted,
    rows,
    restated,
    self,
    positions,
    items,
    itemEvents,
    affected,
    hash: affectedHash(affected),
    tail,
  };
}

/** A row's or entity's line of the preview (04-contract-types §4.7 `DeletionRowResult`): outcome, what it is after, what it rests on. */
export interface PreviewRow {
  readonly target: { readonly table: string; readonly row?: string; readonly entity?: string };
  readonly result: string;
  readonly after?: {
    readonly values?: Readonly<Record<string, FieldValue>>;
    readonly spans?: readonly {
      readonly from?: string;
      readonly to?: string;
      readonly values: Readonly<Record<string, FieldValue>> | null;
    }[];
  };
  /** Each required field: the writes (their `write.base` seq) still giving it. */
  readonly basis?: Readonly<Record<string, readonly Seq[]>>;
}

/** The preview's rows: each listed row's outcome, what it is after, and what it rests on. */
export function previewRows(plan: DeletionPlan): PreviewRow[] {
  const out: PreviewRow[] = [];
  for (const r of plan.rows) {
    if (!r.result.result.listed) continue;
    const outcome = r.result.outcome as string;
    const nameOf = new Map(r.table.fields.map((f) => [f.id, f.name]));
    const name = (f: FieldId) => nameOf.get(f) ?? f;
    const state = r.result.replay.state;
    const v = view(state);
    const target = r.isState
      ? { table: r.table.name, entity: r.id }
      : { table: r.table.name, row: r.id };
    const basis: Record<string, Seq[]> = {};
    for (const f of r.shape.required) {
      basis[name(f)] = [
        ...new Set(
          state.items
            .filter(
              (x) => x.target === f && (x.status === "applied" || x.status === "corroborated"),
            )
            .map((x) => x.event),
        ),
      ].sort((a, b) => a - b);
    }
    if (outcome === "deleted") {
      out.push({ target, result: outcome, basis });
      continue;
    }
    let after: PreviewRow["after"];
    if (!r.isState) {
      const values: Record<string, FieldValue> = {};
      for (const [f, stretches] of Object.entries(v.fields)) {
        const s = stretches?.[0];
        if (s !== undefined && s.value !== null) values[name(f as FieldId)] = s.value;
      }
      after = { values };
    } else {
      // Spans: the pieces where the entity has a value and where it has none, each with every
      // field's value there.
      const ends = new Set<string | null>();
      for (const stretches of Object.values(v.fields)) {
        for (const s of stretches ?? []) for (const iv of s.valid) ends.add(iv.from).add(iv.to);
      }
      for (const g of v.gaps) ends.add(g.from).add(g.to);
      const points = [...ends].filter((p): p is string => p !== null).sort();
      const bounds: (string | null)[] = [null, ...points, null];
      const spans: NonNullable<NonNullable<PreviewRow["after"]>["spans"]>[number][] = [];
      for (let i = 0; i + 1 < bounds.length; i++) {
        const from = bounds[i] ?? null;
        const to = bounds[i + 1] ?? null;
        if (from !== null && to !== null && from >= to) continue;
        const inside = (iv: { from: string | null; to: string | null }) =>
          (iv.from === null || (from !== null && iv.from <= from)) &&
          (iv.to === null || (to !== null && to <= iv.to));
        const gap = v.gaps.some(inside);
        let values: Record<string, FieldValue> | null = null;
        if (!gap) {
          values = {};
          for (const [f, stretches] of Object.entries(v.fields)) {
            const s = stretches?.find((x) => x.valid.some(inside));
            if (s !== undefined && s.value !== null) values[name(f as FieldId)] = s.value;
          }
        }
        // The open ends before the first and after the last point carry nothing when nothing is
        // there: left out.
        if (gap && (from === null || to === null) && points.length > 0) continue;
        spans.push({
          ...(from !== null ? { from } : {}),
          ...(to !== null ? { to } : {}),
          values,
        });
      }
      after = { spans };
    }
    out.push({ target, result: outcome, after, basis });
  }
  return out;
}
