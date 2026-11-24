// What a privacy deletion would do, worked out on the state now (docs/zh-CN/spec/03-data-model/
// 03-deletion.md «预览与回执要写明的内容», «删除结果的定义»; 09-event-format §5.9): the (event, target)
// contributions its sources take away, each affected row's or entity's replay, the positions it
// lists, and the impact summary its confirmation handle binds. Read only, in one read transaction;
// the preview and the confirmation both start here, so what is confirmed is what was previewed
// unless the impact summary changed (`preview_outdated`).
//
// This version works out a deletion only when no affected row's log has a deletion event yet and
// the deletion changes no pending item (no item's members, none of an open item's entry blocks
// listed). Every other shape, and each shape the later parts of the deletion do not apply yet, is
// refused before anything is appended, as `not_implemented` with a kind of its own:
//
// - `prior_deletion_on_row`: an affected row or entity already has a deletion or cancellation on it
//   (its earlier deletions' item layer, restatements and pending sets are not read yet);
// - `pending_items_touched`: the deletion would change a pending item (its item events are not
//   written yet);
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
import { positionsOf, readPositionIndex } from "../delete/positions.ts";
import { type BaseCitations, readCitations, takenAway } from "../delete/taken.ts";
import { JudgeError } from "../judge/errors.ts";
import { itemsByRecords } from "../judge/fates.ts";
import type { BlockAddress, OpRecord, Restatement, TableShape } from "../judge/index.ts";
import { stateFromRecord, view } from "../judge/index.ts";
import { deletionResult } from "../judge/replay-deletion.ts";
import { givenByRecords } from "../judge/restate.ts";
import { readTail } from "../log/log.ts";
import type { ReadTx } from "../store/ports.ts";
import { restoreHistory } from "../store/restore-point.ts";
import { WriteError } from "../write/errors.ts";
import { replayShape } from "../write/plan.ts";
import { readSlots, rowEvents } from "../write/reads.ts";
import { decodeRecords, type RowContext, type StoredEvent } from "../write/record.ts";

/** The kinds of deletion this version refuses (see the file's head). */
export type RefusedKind =
  | "prior_deletion_on_row"
  | "referenced_revoke_awaiting"
  | "pending_items_touched"
  | "external_key"
  | "premise"
  | "schema_const"
  | "derived"
  | "item_numbered_anew"
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
  /** The last event of the row's log (its own and its items'): what its version is in the summary. */
  readonly last: Seq;
  readonly result: ReturnType<typeof deletionResult>;
}

/** The affected set, canonical: what the impact summary's hash is of. */
export interface AffectedSet {
  readonly rows: readonly { readonly table: string; readonly id: string; readonly last: Seq }[];
  readonly sources: readonly { readonly seq: Seq; readonly state: string }[];
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
 * The rows and entities of the slot that an earlier deletion or cancellation touched: a row its
 * results list, or one holding an event a block of which it lists or an item of which it restates.
 */
async function rowsWithDeletions(tx: ReadTx, slot: string): Promise<Set<string>> {
  const r = await tx.query<{ path: string; body: string }>(
    `SELECT c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.slot = $1 AND e.type IN ('deletion.confirmed', 'deletion.cancelled')
       AND c.body IS NOT NULL
       AND (c.path = 'positions' OR c.path LIKE 'results/%/target' OR c.path LIKE 'restated/%')`,
    [slot],
  );
  const out = new Set<string>();
  const events = new Set<number>();
  for (const x of r.rows) {
    const b = JSON.parse(x.body) as JsonValue;
    if (x.path === "positions") {
      for (const p of b as { seq: number }[]) events.add(p.seq);
    } else if (x.path.endsWith("/target")) {
      const t = b as { row?: string; entity?: string };
      const id = t.row ?? t.entity;
      if (id !== undefined) out.add(id);
    } else {
      events.add((b as { event: number }).event);
    }
  }
  if (events.size > 0) {
    const rows = await tx.query<{ target_row: string | null }>(
      "SELECT target_row FROM events WHERE seq = ANY($1) AND target_row IS NOT NULL",
      [[...events] as never],
    );
    for (const x of rows.rows) if (x.target_row !== null) out.add(x.target_row);
  }
  return out;
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

/** The entry blocks of open items the positions list. */
async function openEntriesListed(
  tx: ReadTx,
  positions: readonly BlockAddress[],
): Promise<string[]> {
  if (positions.length === 0) return [];
  const r = await tx.query<{ item_id: string; content_seq: unknown; content_path: string }>(
    `SELECT e.item_id, e.content_seq, e.content_path FROM pending_entries e
     JOIN pending_items i ON i.id = e.item_id
     WHERE i.state = 'open' AND e.content_seq = ANY($1)`,
    [[...new Set(positions.map((p) => p.seq))] as never],
  );
  const listed = new Set(positions.map((p) => `${p.seq}\u0000${p.path}`));
  return [
    ...new Set(
      r.rows
        .filter((x) => listed.has(`${Number(x.content_seq)}\u0000${x.content_path}`))
        .map((x) => x.item_id),
    ),
  ].sort();
}

const lastOf = (events: readonly StoredEvent[]): Seq =>
  events.reduce((m, e) => Math.max(m, e.header.seq), 0) as Seq;

/** Whether the item layer of a row's replay changes anything. */
function itemsChanged(r: ReturnType<typeof deletionResult>): boolean {
  const x = r.items;
  return (
    x.fates.size > 0 ||
    x.superseded.length > 0 ||
    x.restored.length > 0 ||
    x.refreshed.length > 0 ||
    x.opened.length > 0
  );
}

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
  const prior = byRow.size === 0 ? new Set<string>() : await rowsWithDeletions(tx, slot);
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
    if (prior.has(id)) {
      throw refuse("prior_deletion_on_row", "on a row an earlier deletion touched", { row: id });
    }
    if (await inPremise(tx, id)) {
      throw refuse("premise", "on a row a premise declaration names", { row: id });
    }
    if (await holdsSchemaConst(tx, id)) {
      throw refuse("schema_const", "on a row holding a schema constant", { row: id });
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
    const events = await rowEvents(tx, table.id, id);
    const records = decodeRecords(ctx, events);
    const state = stateFromRecord(shape, records);
    // The item layer is only looked at for whether it changes (this version refuses any change):
    // the records' approximation of the items is enough to tell.
    let result: ReturnType<typeof deletionResult>;
    try {
      result = deletionResult(
        shape,
        records,
        deleted,
        new Set(),
        itemsByRecords(state),
        () => [],
        givenByRecords(records),
      );
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
    if (itemsChanged(result)) {
      throw refuse("pending_items_touched", "changing a pending item", { row: id });
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
      last: lastOf(events),
      result,
    });
  }

  const restated = rows.flatMap((r) => r.result.replay.restated);
  const self = (tail + 1) as Seq;
  const index = await readPositionIndex(tx, { slot, sources: seqs, bases, deleted, restated });
  const positions = positionsOf({ sources: seqs, deleted, restated, index, self });
  const touchedItems = await openEntriesListed(tx, positions);
  if (touchedItems.length > 0) {
    throw refuse("pending_items_touched", "listing a pending item's entry", {
      items: touchedItems,
    });
  }

  const affected: AffectedSet = {
    rows: rows.map((r) => ({ table: r.table.id, id: r.id, last: r.last })),
    sources: seqs.map((seq) => ({ seq, state: states.get(seq) ?? "present" })),
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
