// What a reader sees of a row or entity, and which writes give it (04-write-and-read «撤回某次写入
// （undo）», the impact of an awaiting undo): the impact lists the writes whose result changes when
// the undo is confirmed, not the writes whose contributions it takes back. A write that only
// stops giving a result another one gives the same is not listed; one not in the undo's record
// whose result the write-backs change is.

import type { OpNumber } from "@fluxvita/saveslot-contract-core";
import type { ItemRef } from "./model.ts";
import { type Limit, NO_VALUE, type RowState, refOf } from "./state.ts";

/**
 * The writes after `since` whose result changes between `before` (at `at`) and `after` (at
 * `afterAt`, the same row with an operation's write-backs), and for each, its items whose result
 * changes: the item giving a field's result on a piece where that result changes (a value, or the
 * revoke leaving the row revoked or the stretch without a value). On a state table a stretch that
 * loses its value loses each field's: every write giving one there is listed.
 */
export function changedResults(
  before: RowState,
  at: Limit,
  after: RowState,
  afterAt: Limit,
  since: OpNumber,
): Map<OpNumber, ItemRef[]> {
  const out = new Map<OpNumber, ItemRef[]>();
  const add = (op: OpNumber, r: ItemRef) => {
    if (op <= since) return;
    const xs = out.get(op) ?? [];
    if (!xs.some((y) => y.event === r.event && y.target === r.target && y.k === r.k)) xs.push(r);
    out.set(op, xs);
  };
  const regs = [...after.regs.values()].flat().map((r) => r.valid);
  for (const seg of after.pieces(regs)) {
    for (const f of before.table.fields) {
      // A field's result on the piece is what `token` gives (a revoke and a gap are one result on
      // state tables, decided there).
      const was = before.token(f, seg, at);
      if (was === after.token(f, seg, afterAt)) continue;
      if (was === NO_VALUE) {
        // A stretch without a value before (state tables): what goes is the "no value", given by
        // the revokes leaving it so; a field's write there is revealed, not lost.
        for (const g of before.table.fields) {
          const s = before.fieldState(g, seg, at);
          if (s.kind === "hole") add(s.by.op, refOf(s.by));
        }
        continue;
      }
      // The write giving the result: a value; on an event or timeless table also the revoke the
      // row is revoked by. On a state table where the stretch has a value, a field without one
      // reads empty, which no write gives (a revoke there is not what a reader sees).
      const s = before.fieldState(f, seg, at);
      if (s.kind === "value" || (s.kind === "hole" && !before.isState)) add(s.by.op, refOf(s.by));
    }
  }
  return out;
}
