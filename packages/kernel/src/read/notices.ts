// The `pending_items` notice (04-contract-types §7 `Notice`; 04-contract §13): for each slot a call
// involves, within the caller's visible range, the open pending items there and when the oldest was
// opened. Counted as `pending` lists them (the same items, the same range); computed as of now,
// never logged as a read.

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
