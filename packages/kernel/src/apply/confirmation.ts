// The hash of what a decision confirms (docs/zh-CN/spec/09-event-format.md §5.8 `item.resolved`
// `confirmation`): SHA-256 of the checksums of the blocks confirmed, ordered by (seq, path), joined
// by newlines. The blocks confirmed are the item's entry blocks in effect, those `pending_entries`
// holds (the ones the item's events gave that no later event of the item replaced as a group); for a
// `schema_change` item, its draft's `schema.compiled` `compiled` block.
//
// One function for both sides: the pipeline computes it before appending `item.resolved`, and apply
// computes it again from the state it applies to and checks it.

import { createHash } from "node:crypto";
import type { ReadTx } from "../store/ports.ts";

/** An entry block of an item: where it is, and its checksum (none: removed by a tombstone). */
export interface EntryChecksum {
  readonly seq: number;
  readonly path: string;
  readonly checksum: string | null;
}

/**
 * The confirmation hash of entry blocks: undefined when there are none (no `confirmation` block),
 * `"removed"` when one of them was removed (the block goes with it).
 */
export function confirmationHash(
  entries: readonly EntryChecksum[],
): string | "removed" | undefined {
  if (entries.length === 0) return undefined;
  if (entries.some((e) => e.checksum === null)) return "removed";
  const sorted = [...entries].sort((a, b) =>
    a.seq !== b.seq ? a.seq - b.seq : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
  );
  return createHash("sha256")
    .update(sorted.map((e) => e.checksum).join("\n"), "utf8")
    .digest("hex");
}

/**
 * The blocks a decision on `item` confirms, with their checksums: a `schema_change` item's draft's
 * `compiled` block (the item has no entry blocks); any other item's entry blocks in effect.
 */
export async function confirmedChecksums(tx: ReadTx, item: string): Promise<EntryChecksum[]> {
  const r = await tx.query<{ seq: unknown; checksum: string | null }>(
    `SELECT c.seq, c.checksum FROM pending_items p
     JOIN content t ON t.path = 'target' AND t.body IS NOT NULL AND (t.body::jsonb ->> 'item') = p.id
     JOIN events e ON e.seq = t.seq AND e.type = 'item.created'
     JOIN schema_versions v ON v.slot_id = p.slot_id AND v.draft_id = (t.body::jsonb ->> 'draft')
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE p.id = $1 AND p.type = 'schema_change'`,
    [item],
  );
  const [x] = r.rows;
  if (x !== undefined) return [{ seq: Number(x.seq), path: "compiled", checksum: x.checksum }];
  return entryChecksums(tx, item);
}

/** The entry blocks of an item in effect, with their checksums. */
export async function entryChecksums(tx: ReadTx, item: string): Promise<EntryChecksum[]> {
  const r = await tx.query<{ seq: unknown; path: string; checksum: string | null }>(
    `SELECT e.content_seq AS seq, e.content_path AS path, c.checksum
     FROM pending_entries e JOIN content c ON c.seq = e.content_seq AND c.path = e.content_path
     WHERE e.item_id = $1`,
    [item],
  );
  return r.rows.map((x) => ({ seq: Number(x.seq), path: x.path, checksum: x.checksum }));
}
