// The notices of a call (04-contract-types §7 `Notice`; 04-contract §13), for each slot it involves
// within the caller's visible range, computed as of now and never logged as a read:
// - `pending_items`: the open pending items there and when the oldest was opened, counted as
//   `pending` lists them (the same items, the same range);
// - `schema_updated`: the version the caller last read of the slot (04-contract §2 "什么算读到 sv",
//   by actor and task as the `sv` fallback has it) is behind the current one, and what changed since.

import type { CompiledSchema, PrincipalId } from "@fluxvita/saveslot-contract-core";
import { lastRead, readBufferOf } from "../audit/index.ts";
import { fold } from "../request/names.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { ITEMS, type ItemRow, placeOf } from "./pending.ts";
import { resolveTable, type Visibility, type VisibleSlot, visibleSlots } from "./slots.ts";

/** At most this many notices in a result (04-contract-types `CommonResult.notices`). */
export const MAX_NOTICES = 3;

export interface PendingItemsNotice {
  readonly code: "pending_items";
  readonly slot: string;
  readonly count: number;
  readonly oldest_opened_at: string;
}

/** What a call involves, as the service has it: slots by name, tables by name, items by ID. */
export interface NoticeRefs {
  readonly slots?: readonly string[];
  readonly tables?: readonly string[];
  readonly items?: readonly string[];
  /**
   * Operations the call logged (a write's `seq`): the slot of each, from its head event. A write
   * is placed by the slot it wrote, not by the names it used, which may be an earlier version's.
   */
  readonly operations?: readonly number[];
}

/** The visible slots a call's references name; a reference that names none is left out. */
async function involved(
  tx: ReadTx,
  slots: readonly VisibleSlot[],
  refs: NoticeRefs,
): Promise<Set<string>> {
  const out = new Set<string>();
  for (const name of refs.slots ?? []) {
    const s = slots.find((x) => fold(x.name) === fold(name));
    if (s !== undefined) out.add(s.slot);
  }
  for (const name of refs.tables ?? []) {
    try {
      out.add(resolveTable(name, "table", slots).slot.slot);
    } catch {
      // Not a table the caller sees (the call itself answered for it): nothing to tell.
    }
  }
  if ((refs.items ?? []).length > 0) {
    const r = await tx.query<{ slot_id: string | null }>(
      "SELECT slot_id FROM pending_items WHERE id = ANY($1)",
      [[...(refs.items ?? [])]] as never,
    );
    for (const x of r.rows) {
      if (x.slot_id !== null && slots.some((s) => s.slot === x.slot_id)) out.add(x.slot_id);
    }
  }
  if ((refs.operations ?? []).length > 0) {
    const r = await tx.query<{ slot: string | null }>(
      "SELECT DISTINCT slot FROM events WHERE seq = ANY($1) AND slot IS NOT NULL",
      [[...(refs.operations ?? [])]] as never,
    );
    for (const x of r.rows) {
      if (x.slot !== null && slots.some((s) => s.slot === x.slot)) out.add(x.slot);
    }
  }
  return out;
}

/**
 * The `pending_items` notices of a call: one a slot with open items, none for a slot without;
 * the oldest first (by when its oldest item was opened, then by slot name), at most three.
 */
export async function pendingItemsNotices(
  store: TenantStore,
  visibility: Visibility,
  refs: NoticeRefs,
): Promise<PendingItemsNotice[]> {
  return store.read(async (tx) => {
    const slots = await visibleSlots(tx, visibility);
    const ids = await involved(tx, slots, refs);
    if (ids.size === 0) return [];
    const r = await tx.query<ItemRow>(`${ITEMS} WHERE p.state = 'open' AND p.slot_id = ANY($1)`, [
      [...ids],
    ] as never);
    const bySlot = new Map<string, { name: string; count: number; oldest: string }>();
    for (const x of r.rows) {
      // An item outside the visible range (a table the range leaves out) is not counted.
      const place = placeOf(x, slots);
      if (place === undefined) continue;
      const cur = bySlot.get(place.slot.slot);
      bySlot.set(place.slot.slot, {
        name: place.slot.name,
        count: (cur?.count ?? 0) + 1,
        oldest: cur === undefined || x.opened_at < cur.oldest ? x.opened_at : cur.oldest,
      });
    }
    return [...bySlot.values()]
      .sort((a, b) =>
        a.oldest !== b.oldest ? (a.oldest < b.oldest ? -1 : 1) : a.name < b.name ? -1 : 1,
      )
      .slice(0, MAX_NOTICES)
      .map((x) => ({
        code: "pending_items" as const,
        slot: x.name,
        count: x.count,
        oldest_opened_at: x.oldest,
      }));
  });
}

export interface SchemaUpdatedNotice {
  readonly code: "schema_updated";
  readonly slot: string;
  readonly from: number;
  readonly to: number;
  /** What the versions since changed, as `表` or `表.字段` (04-contract-types §7). */
  readonly changed: readonly string[];
}

/** Who the call is from: the unit "last read" is kept by (04-contract §2). */
export interface NoticeCaller {
  readonly actor: PrincipalId;
  readonly task: string | null;
}

/**
 * The version of a slot the caller last read, as the `sv` fallback takes it (04-contract §2): the
 * later of its last read and its own last write's `sv`. Given by the caller of this module, which
 * can reach the write receipts.
 */
export type LastSv = (tx: ReadTx, slot: string) => Promise<number | undefined>;

/**
 * The version a caller last read of each slot, by its reads alone (the buffered ones included); the
 * ops entry adds its own writes (`LastSv`).
 */
export function lastReadSv(store: TenantStore, caller: NoticeCaller): LastSv {
  const reads = readBufferOf(store);
  return async (tx, slot) =>
    (
      await lastRead(tx, reads, {
        actor: caller.actor,
        task: caller.task,
        kind: "sv",
        target: slot,
      })
    )?.op;
}

/**
 * The `schema_updated` notices of a call: a slot it involves whose version the caller last read
 * (`lastSv`) is behind the current one. `changed`: the target of every change of the versions switched to after
 * the one read, up to the current one, compatible or not, as `table` or `table.field` by the names
 * now, or by the names before a drop for what a version dropped, and the slot's name now for a
 * change to the slot itself (its name, its time zone); each once, by name. A slot the
 * caller never read gets none (a write without a version read first is `read_first`), and so does
 * one where nothing the caller sees changed. By slot name.
 */
export async function schemaUpdatedNoticesWith(
  store: TenantStore,
  visibility: Visibility,
  lastSv: LastSv,
  refs: NoticeRefs,
): Promise<SchemaUpdatedNotice[]> {
  return store.read(async (tx) => {
    const slots = await visibleSlots(tx, visibility);
    const ids = await involved(tx, slots, refs);
    const out: SchemaUpdatedNotice[] = [];
    for (const s of slots) {
      if (!ids.has(s.slot)) continue;
      const from = await lastSv(tx, s.slot);
      if (from === undefined || from >= s.sv) continue;
      const changed = await changedBetween(tx, s, from);
      // Nothing the caller sees changed (a range leaving out every table changed): nothing to tell.
      if (changed.length === 0) continue;
      out.push({ code: "schema_updated", slot: s.name, from, to: s.sv, changed });
    }
    return out.sort((a, b) => (a.slot < b.slot ? -1 : a.slot > b.slot ? 1 : 0));
  });
}

/** The targets the versions after `from` up to the slot's current one changed, named (above). */
async function changedBetween(tx: ReadTx, s: VisibleSlot, from: number): Promise<string[]> {
  const r = await tx.query<{ sv: unknown; compiled: string | null; changes: string | null }>(
    `SELECT v.sv, c.body AS compiled, ch.body AS changes FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     JOIN content ch ON ch.seq = v.compiled_seq AND ch.path = 'changes'
     WHERE v.slot_id = $1 AND v.state IN ('current', 'retired') AND v.sv <= $2 ORDER BY v.sv DESC`,
    [s.slot, s.sv],
  );
  // Newest first: the first definition that has a table or field gives its name (the current one,
  // or the last before it was dropped).
  const versions = r.rows.map((x) => ({
    sv: Number(x.sv),
    compiled: x.compiled === null ? undefined : (JSON.parse(x.compiled) as CompiledSchema),
    changes:
      x.changes === null
        ? []
        : (JSON.parse(x.changes) as { target: { table?: string; field?: string } }[]),
  }));
  const tableName = (id: string) => {
    for (const v of versions) {
      const t = v.compiled?.tables.find((x) => x.id === id);
      if (t !== undefined) return t.name;
    }
    return undefined;
  };
  const fieldName = (table: string, id: string) => {
    for (const v of versions) {
      const t = v.compiled?.tables.find((x) => x.id === table);
      const f = t?.kind === "base" ? t.fields.find((x) => x.id === id) : undefined;
      if (f !== undefined) return f.name;
    }
    return undefined;
  };
  const names = new Set<string>();
  for (const v of versions) {
    if (v.sv <= from) continue;
    for (const c of v.changes) {
      const t = c.target.table;
      // A slot-level change (its name, its time zone) is the slot itself, by its name now.
      if (t === undefined) {
        names.add(s.name);
        continue;
      }
      // One outside the range is not told.
      if (s.rangeTables !== undefined && !s.rangeTables.has(t)) continue;
      const table = tableName(t);
      if (table === undefined) continue;
      const field = c.target.field === undefined ? undefined : fieldName(t, c.target.field);
      names.add(field === undefined ? table : `${table}.${field}`);
    }
  }
  return [...names].sort();
}
