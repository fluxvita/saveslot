// For tests that append decisions the record mapping encodes (which knows nothing of the store):
// the `confirmation` the pipeline gives an `item.resolved` (09 §5.8), from the item's entries as
// the store holds them when it is appended.

import type { NewEvent } from "../log/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { confirmationHash, entryChecksums } from "./confirmation.ts";

/** `events` with each `item.resolved` given its confirmation, as of the state in `tx`. */
export async function withConfirmations(
  tx: ReadTx,
  events: readonly NewEvent[],
): Promise<NewEvent[]> {
  const out: NewEvent[] = [];
  for (const e of events) {
    const target = e.blocks["target"] as { item?: string } | undefined;
    if (e.type !== "item.resolved" || target?.item === undefined || "confirmation" in e.blocks) {
      out.push(e);
      continue;
    }
    const hash = confirmationHash(await entryChecksums(tx, target.item));
    out.push(
      hash === undefined || hash === "removed"
        ? e
        : { ...e, blocks: { ...e.blocks, confirmation: { hash } } },
    );
  }
  return out;
}
