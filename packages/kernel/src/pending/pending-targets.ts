// The rows and entities a deletion still pending affects (03-deletion «撤回与宽限期»: in the grace
// period no decision is taken on them; 04-contract `resolve` step 3, `undo`, the item's `blocked`).
//
// A pending deletion affects a row when its own event lists it: a result for the row, a
// restatement of one of the row's contributions, or a position on one of the row's events. A
// position on a head event shared by several operations' rows counts for each of them (it refuses
// more, never less). Read once for a request from the pending deletions alone, so its cost does not
// grow with the rows or items asked about.

import type { Instant, ItemId, Seq } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";

/** What blocks a row or entity: the pending deletions affecting it, by operation, and the latest due. */
export interface PendingBlock {
  readonly deletions: readonly ItemId[];
  readonly expiresAt: Instant;
}

/** The rows and entities pending deletions affect, by table ID and row or entity ID. */
export interface PendingTargets {
  on(table: string, row: string): PendingBlock | undefined;
}

const NONE: PendingTargets = { on: () => undefined };
const key = (table: string, row: string) => `${table}\u0000${row}`;

/** Reads the pending deletions and what each affects. */
export async function readPendingTargets(tx: ReadTx): Promise<PendingTargets> {
  const pending = await tx.query<{ id: string; due_at: string; confirmed_seq: unknown }>(
    "SELECT id, due_at, confirmed_seq FROM deletions WHERE state = 'pending' ORDER BY confirmed_seq",
  );
  if (pending.rows.length === 0) return NONE;
  const own = pending.rows.map((d) => Number(d.confirmed_seq));
  const blocks = await tx.query<{ seq: unknown; path: string; body: string }>(
    `SELECT seq, path, body FROM content WHERE seq = ANY($1) AND body IS NOT NULL
       AND (path = 'positions' OR path LIKE 'restated/%' OR path LIKE 'results/%/target')`,
    [own] as never,
  );
  // Each deletion's rows named directly, and the events it points at.
  const rowsOf = new Map<number, Set<string>>();
  const eventsOf = new Map<number, Set<number>>();
  const add = <T>(m: Map<number, Set<T>>, d: number, v: T) => {
    const s = m.get(d) ?? new Set<T>();
    s.add(v);
    m.set(d, s);
  };
  for (const b of blocks.rows) {
    const d = Number(b.seq);
    const v = JSON.parse(b.body) as unknown;
    if (b.path === "positions") {
      for (const p of v as { seq: number }[]) if (p.seq !== d) add(eventsOf, d, Number(p.seq));
    } else if (b.path.startsWith("restated/")) {
      add(eventsOf, d, Number((v as { event: Seq }).event));
    } else {
      const t = v as { table: string; row?: string; entity?: string };
      add(rowsOf, d, key(t.table, (t.row ?? t.entity) as string));
    }
  }
  // The events' rows: their own target, or (a head event) its operation's rows.
  const seqs = [...new Set([...eventsOf.values()].flatMap((s) => [...s]))];
  const rowOfEvent = new Map<number, string[]>();
  if (seqs.length > 0) {
    const r = await tx.query<{
      seq: unknown;
      target_table: string | null;
      target_row: string | null;
    }>(
      `SELECT e.seq, e.target_table, e.target_row FROM events e WHERE e.seq = ANY($1)
         AND e.target_row IS NOT NULL
       UNION ALL
       SELECT b.op AS seq, b.target_table, b.target_row FROM events b
         WHERE b.type = 'write.base' AND b.op = ANY($1) AND b.target_row IS NOT NULL`,
      [seqs] as never,
    );
    for (const x of r.rows) {
      const s = Number(x.seq);
      rowOfEvent.set(s, [
        ...(rowOfEvent.get(s) ?? []),
        key(x.target_table as string, x.target_row as string),
      ]);
    }
  }
  const by = new Map<string, { id: ItemId; due: string }[]>();
  for (const d of pending.rows) {
    const seq = Number(d.confirmed_seq);
    const rows = new Set(rowsOf.get(seq));
    for (const e of eventsOf.get(seq) ?? []) for (const k of rowOfEvent.get(e) ?? []) rows.add(k);
    for (const k of rows) by.set(k, [...(by.get(k) ?? []), { id: d.id as ItemId, due: d.due_at }]);
  }
  return {
    on(table, row) {
      const ds = by.get(key(table, row));
      if (ds === undefined) return undefined;
      return {
        deletions: ds.map((x) => x.id),
        // The latest due (instants compare as text).
        expiresAt: ds
          .map((x) => x.due)
          .sort()
          .at(-1) as Instant,
      };
    },
  };
}

/**
 * The detail of `invalid_argument` (`pending_deletion_target`, 04-contract-types §9): the row or
 * entity at `param` is affected by pending deletions; the target, the deletions by operation and
 * the latest due.
 */
export function pendingDeletionTargetDetail(
  param: string,
  t: { table: string; isState: boolean; row: string; blocked: PendingBlock },
) {
  return {
    reason: "pending_deletion_target" as const,
    param,
    target: { table: t.table, ...(t.isState ? { entity: t.row } : { row: t.row }) },
    deletions: [...t.blocked.deletions],
    expires_at: t.blocked.expiresAt,
  };
}

/** The message of `pending_deletion_target`. */
export const PENDING_DELETION_TARGET =
  "the target is affected by a deletion still in its grace period: decide after it runs, or cancel it first";
