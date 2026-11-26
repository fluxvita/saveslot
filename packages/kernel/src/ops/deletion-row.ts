// What a deletion's replay of one row needs from a log that already has deletions on it
// (03-deletion «撤回与宽限期», «多项删除各自列全位置»; 09 §5.7 "被撤回的删除给出的块不算", §5.9):
// the other deletions still pending and what they take away, and the blocks last given with the
// earlier deletions' and cancellations' restatements laid over in log order.
//
// Two sets of blocks last given: the deletion's event (its `restated/<k>`, `results`, the item
// layer) is worked out with the other pending deletions; its list of positions with this deletion
// alone (no other pending deletion's restatements), as each deletion lists its positions apart
// from the others.
//
// This version reads a row only when nothing was done on it after its earliest deletion event
// (`ops_after_deletion`): an operation after a deletion or a cancellation meets it as L of the
// conflict criterion, which neither the write path nor this replay reads yet. A deletion carried
// out (`deletion.executed`) is not applied yet: a row one touched is refused
// (`executed_deletion_on_row`).

import type { Seq } from "@fluxvita/saveslot-contract-core";
import { readCitations, takenAway } from "../delete/taken.ts";
import type { CancellationRecord, DeletionRecord, OpRecord, Restatement } from "../judge/index.ts";
import { type GivenBlock, givenByRecords, type LatestGiven, overlay } from "../judge/restate.ts";
import type { ReadTx } from "../store/ports.ts";
import {
  decodeDeletionRecords,
  decodeRecords,
  type RowContext,
  type StoredEvent,
} from "../write/record.ts";

/** A deletion confirmed in the slot, as the deletion table and its event say. */
export interface PriorDeletion {
  readonly id: string;
  readonly seq: Seq;
  readonly state: "pending" | "cancelled" | "executed";
  /** The contributions it takes away (`pending` only; empty otherwise). */
  readonly deleted: ReadonlySet<string>;
}

/** The slot's deletions and the deletion events, as read once for every row. */
export interface PriorLog {
  readonly deletions: readonly PriorDeletion[];
  /** The slot's `deletion.confirmed` / `deletion.cancelled` / `deletion.executed` events. */
  readonly events: readonly StoredEvent[];
}

/** Reads the slot's deletions and their events. */
export async function priorDeletions(tx: ReadTx, slot: string): Promise<PriorLog> {
  const heads = await tx.query<{ seq: unknown; type: string; op: unknown }>(
    `SELECT seq, type, op FROM events WHERE slot = $1
       AND type IN ('deletion.confirmed', 'deletion.cancelled', 'deletion.executed') ORDER BY seq`,
    [slot],
  );
  if (heads.rows.length === 0) return { deletions: [], events: [] };
  const seqs = heads.rows.map((h) => Number(h.seq));
  const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    "SELECT seq, path, body FROM content WHERE seq = ANY($1) AND body IS NOT NULL",
    [seqs] as never,
  );
  const by = new Map<number, Record<string, unknown>>();
  for (const b of blocks.rows) {
    const s = Number(b.seq);
    const m = by.get(s) ?? Object.create(null);
    m[b.path] = JSON.parse(b.body as string);
    by.set(s, m);
  }
  const events: StoredEvent[] = heads.rows.map((h) => ({
    header: { type: h.type, seq: Number(h.seq) as Seq, op: Number(h.op) as never },
    blocks: by.get(Number(h.seq)) ?? {},
  }));
  const states = await tx.query<{ id: string; state: string; confirmed_seq: unknown }>(
    "SELECT id, state, confirmed_seq FROM deletions WHERE confirmed_seq = ANY($1)",
    [seqs] as never,
  );
  const deletions: PriorDeletion[] = [];
  for (const d of [...states.rows].sort(
    (a, b) => Number(a.confirmed_seq) - Number(b.confirmed_seq),
  )) {
    const seq = Number(d.confirmed_seq) as Seq;
    const state = d.state as PriorDeletion["state"];
    let deleted: ReadonlySet<string> = new Set();
    if (state === "pending") {
      const sources = ((by.get(seq)?.["target"] as { sources?: Seq[] } | undefined)?.sources ??
        []) as Seq[];
      deleted = takenAway(await readCitations(tx, slot, sources), new Set(sources));
    }
    deletions.push({ id: d.id, seq, state, deleted });
  }
  return { deletions, events };
}

/** Why a row with earlier deletions is not read in this version. */
export type PriorRefusal =
  | { readonly kind: "ops_after_deletion"; readonly op: number }
  | { readonly kind: "executed_deletion_on_row"; readonly deletion: string };

/** One row's inputs to the deletion replay, with earlier deletions on it. */
export interface RowInputs {
  readonly records: readonly OpRecord[];
  /** What the other deletions still pending take away. */
  readonly pendingBefore: ReadonlySet<string>;
  /** The blocks last given, with the other pending deletions (for the event). */
  readonly latest: LatestGiven;
  /** The blocks last given without the other pending deletions' (for the list of positions). */
  readonly latestAlone: LatestGiven;
  /** Kept in effect by cancellations (`kept_effective/<k>`), by (event, target). */
  readonly keptEffective: ReadonlySet<string>;
  /** The deletion events that touched the row. */
  readonly touchedBy: readonly Seq[];
}

/**
 * The deletion replay's inputs for one row: `events`, the row's own (`rowEvents`); `prior`, the
 * slot's deletions. Refused (`PriorRefusal`) where this version does not read the row.
 */
export function rowInputs(
  ctx: RowContext,
  events: readonly StoredEvent[],
  prior: PriorLog,
): RowInputs | PriorRefusal {
  // The item events a deletion or cancellation appended after its own event (same operation):
  // not the row's operations. An item.refreshed re-giving candidates is one of them.
  const deletionOps = new Set(prior.events.map((e) => e.header.seq as number));
  const own = events.filter((e) => !deletionOps.has(e.header.op ?? e.header.seq));
  const records = decodeRecords(ctx, own);
  const rowSeqs = new Set(events.map((e) => e.header.seq as number));
  const decoded = decodeDeletionRecords(ctx, prior.events).filter(
    (r): r is DeletionRecord | CancellationRecord =>
      r.kind === "deletion" || r.kind === "cancellation",
  );
  const onRow = (r: readonly Restatement[]) => r.filter((x) => rowSeqs.has(x.item.event));
  const rowId = "row" in ctx.target ? ctx.target.row : ctx.target.entity;
  const listsRow = (r: DeletionRecord | CancellationRecord) =>
    r.results.some((x) => x.id === rowId) ||
    onRow(r.restated).length > 0 ||
    (r.kind === "deletion" && r.positions.some((p) => rowSeqs.has(p.seq)));
  const touchedBy = decoded.filter(listsRow).map((r) => r.event);
  const executed = prior.events.find((e) => {
    if (e.header.type !== "deletion.executed") return false;
    const positions = (e.blocks["positions"] ?? []) as { seq: number }[];
    return positions.some((p) => rowSeqs.has(p.seq));
  });
  if (executed !== undefined) {
    const t = executed.blocks["target"] as { deletion?: string } | undefined;
    return { kind: "executed_deletion_on_row", deletion: t?.deletion ?? "" };
  }
  const first = touchedBy.length === 0 ? undefined : Math.min(...touchedBy);
  if (first !== undefined) {
    const after = own.find((e) => (e.header.op ?? e.header.seq) > first);
    if (after !== undefined) return { kind: "ops_after_deletion", op: after.header.op ?? 0 };
  }
  const byId = new Map(prior.deletions.map((d) => [d.id, d]));
  const pending = prior.deletions.filter((d) => d.state === "pending");
  const pendingBefore = new Set(pending.flatMap((d) => [...d.deleted]));
  const idOf = (r: DeletionRecord) => r.id;
  const latestWith = (skipPending: boolean): LatestGiven => {
    const gone = skipPending ? new Set<string>() : pendingBefore;
    let m: Map<string, GivenBlock[]> = new Map(
      [...givenByRecords(records)].filter(([et]) => !gone.has(et)),
    );
    for (const r of decoded) {
      if (r.kind === "deletion") {
        const d = byId.get(idOf(r));
        // A cancelled deletion's blocks never count (09 §5.7); alone, nor the pending ones'.
        if (d === undefined || d.state === "cancelled" || (skipPending && d.state === "pending"))
          continue;
      }
      m = overlay(m, onRow(r.restated), gone, records);
    }
    return m;
  };
  const keptEffective = new Set(
    decoded.flatMap((r) =>
      r.kind === "cancellation"
        ? r.keptEffective.flatMap((k) => k.targets.map((t) => `${k.event}/${t}`))
        : [],
    ),
  );
  return {
    records,
    pendingBefore,
    latest: latestWith(false),
    latestAlone: latestWith(true),
    keptEffective,
    touchedBy,
  };
}
