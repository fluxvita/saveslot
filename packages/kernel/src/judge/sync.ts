// The sync baseline of a write by external key (docs/zh-CN/spec/03-data-model/
// 09-references-conflict-sync.md «冲突判据», the paragraph on writes by external key;
// 04-write-and-read.md «按来源键写入 · 三方比较»), field by field, and the op's outcome
// (04-contract §5.4).
//
// - A sync contribution: an item a write by key gave a field, whatever its status (applied,
//   corroborated, candidate, awaiting); and the item taking such a candidate carried out. Not the
//   items `take_previous` and `undo` write back: a person's decision brought those values.
// - One in effect: applied or corroborated, and not registered as reverted.
// - The baseline value: the field's latest sync contribution's value; none before the first.
// - The baseline position: the operation of the field's latest sync contribution in effect; with
//   none, the operation the row got its key in (its key fields' applied items).
//
// Key fields are not in it: a write by key hitting a row leaves them as no-ops, not judged. Event
// and timeless tables only (a state table has no external key).

import type { FieldId, FieldValue, OpNumber } from "@fluxvita/saveslot-contract-core";
import { JudgeError } from "./errors.ts";
import type { ItemRef, ItemStatus } from "./model.ts";
import type { Item, Limit, RowState } from "./state.ts";

/** A field's sync baseline: its position, and its value once the field has a sync contribution. */
export interface SyncBaseline {
  readonly position: OpNumber;
  readonly value?: FieldValue;
}

const sameRef = (x: Item, r: ItemRef) =>
  x.event === r.event && x.target === r.target && x.k === r.k;

/**
 * Whether `x` is a sync contribution: given by a write by key, or carried out of one by taking a
 * candidate (followed to the end of `carried`). A write-back of `take_previous` or `undo` carries
 * too, and is not one.
 */
export function isSyncContribution(state: RowState, x: Item, seen = new Set<Item>()): boolean {
  if (x.sync === true) return true;
  if (seen.has(x) || x.carried === undefined || x.carried.length === 0) return false;
  const record = state.records.find((r) => r.event === x.event);
  if (record?.kind !== "take_candidate") return false;
  seen.add(x);
  return x.carried.some((r) => {
    const from = state.items.find((y) => sameRef(y, r));
    return from !== undefined && isSyncContribution(state, from, seen);
  });
}

const IN_EFFECT: ReadonlySet<ItemStatus> = new Set(["applied", "corroborated"]);
const later = (a: Item, b: Item) =>
  a.op !== b.op ? a.op > b.op : a.event !== b.event ? a.event > b.event : a.k > b.k;

/**
 * Field `f`'s sync baseline as op `op` (index `index` of its request) sees it: of the items before
 * it, as of `at` for their registrations. `keyFields`: the table's key fields, whose applied items
 * give the operation the row got its key in.
 */
export function syncBaseline(
  state: RowState,
  f: FieldId,
  before: { readonly op: OpNumber; readonly index: number },
  at: Limit,
  keyFields: readonly FieldId[],
): SyncBaseline {
  const earlier = (x: Item) => x.op < before.op || (x.op === before.op && x.index < before.index);
  let value: Item | undefined;
  let position: Item | undefined;
  for (const x of state.items) {
    if (x.target !== f || !earlier(x) || !isSyncContribution(state, x)) continue;
    if (value === undefined || later(x, value)) value = x;
    if (!IN_EFFECT.has(x.status) || state.registrations(x, at).length > 0) continue;
    if (position === undefined || later(x, position)) position = x;
  }
  const keyed = state.items.filter(
    (x) =>
      earlier(x) &&
      x.status === "applied" &&
      x.target !== "existence" &&
      keyFields.includes(x.target as FieldId),
  );
  const keyOp = keyed.length === 0 ? undefined : Math.min(...keyed.map((x) => x.op));
  const at_ = position?.op ?? keyOp;
  if (at_ === undefined) {
    throw new JudgeError("invalid", "a write by key hitting a row that has no key", { field: f });
  }
  const content = value?.content;
  return {
    position: at_ as OpNumber,
    ...(content !== undefined && content.kind === "value" ? { value: content.value } : {}),
  };
}

/** A write by key's outcome (04-contract §5.4), from its fields' results; `created`/`skipped` aside. */
export type SyncOutcome = "updated" | "unchanged" | "pending";

/**
 * Every field a no-op: `unchanged`; any field in effect (applied or corroborated: a write of only
 * corroborations leaves a record, so it is not `unchanged`): `updated`; else `pending`.
 */
export function syncOutcome(results: readonly ("noop" | ItemStatus)[]): SyncOutcome {
  if (results.some((r) => r === "applied" || r === "corroborated")) return "updated";
  if (results.some((r) => r === "candidate" || r === "awaiting")) return "pending";
  return "unchanged";
}
