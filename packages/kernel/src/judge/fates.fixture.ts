// The items as the log would stand after a deletion's item events, for the next deletion; and the
// open items, compared across orders of deletions (fates.ts).

import type { ItemsGiven, ItemsResult } from "./fates.ts";
import { pendingIn } from "./fates.ts";
import type { Target } from "./model.ts";
import type { RowState } from "./state.ts";

/** The items as the log would stand after a deletion's item events (for the next deletion). */
export function advance(g: ItemsGiven, r: ItemsResult): ItemsGiven {
  const items = new Map(g.items);
  const of = new Map(g.of);
  for (const id of r.superseded) {
    const x = items.get(id);
    if (x !== undefined)
      items.set(id, { ...x, standing: { kind: "superseded", reason: "deleted" } });
  }
  for (const id of r.restored) {
    const x = items.get(id);
    if (x !== undefined) items.set(id, { ...x, standing: { kind: "open" } });
  }
  for (const [k, f] of r.fates) {
    if (f.kind === "restored") of.set(k, f.restores);
    if (f.kind === "rejoined") of.set(k, f.into);
  }
  for (const o of r.opened) {
    const id = `${o.succeeds}>${o.kind}`;
    items.set(id, { kind: o.kind, unit: o.unit, standing: { kind: "open" } });
    for (const k of o.members) of.set(k, id);
  }
  return { original: g.original, of, items };
}

/**
 * The open items after a deletion, as (the original items of their members, kind) → members: new
 * items' IDs are not compared, what they succeed and hold is. Members going back closed with a
 * closed item are in none.
 */
export function openItems(g: ItemsGiven, after: RowState): string[] {
  const out = new Map<string, string[]>();
  for (const [k, id] of g.of) {
    const x = g.items.get(id);
    const [ev, target] = k.split("/") as [string, Target];
    if (x?.standing.kind !== "open" || pendingIn(after, Number(ev), target) === undefined) continue;
    out.set(id, [...(out.get(id) ?? []), k]);
  }
  return [...out]
    .map(([id, ks]) => {
      const origins = [...new Set(ks.map((k) => g.original.get(k)))].sort();
      return `${origins.join(",")} ${g.items.get(id)?.kind}: ${ks.sort().join(",")}`;
    })
    .sort();
}
