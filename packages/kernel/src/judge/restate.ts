// What a deletion's replay restates (docs/zh-CN/spec/09-event-format.md §5.9 `restated/<k>`;
// 03-deletion «回掉的权威定义» step 6, indices): the items of the replay numbered against the blocks
// the log last gave, and the items whose judgement differs from those blocks.
//
// Pure. The blocks the log last gave are the caller's to work out (`LatestGiven`): for each
// (event, target) and index, the last judgement the log gave it — the write's own item, or a later
// deletion's restatement, `dropped` included — skipping blocks of a cancelled deletion; and, for
// numbering only, the last block that gave an interval, skipping restatements as dropped (09 §5.7
// «最近一次给出的块只用于这类下标保留编号»). With none given, the records as written are the
// latest.

import { canonical, type IntervalSet, isNothing, meet, startOf } from "../time/index.ts";
import type {
  ItemContent,
  ItemRef,
  ItemStatus,
  OpRecord,
  RecordedItem,
  Restatement,
  Target,
} from "./model.ts";

/** One index of a contribution as the log last gave it. */
export interface GivenBlock {
  readonly k: number;
  /** The last judgement, `dropped` included (rule 1 compares with it). */
  readonly status: ItemStatus | "dropped";
  /** The interval (`seen_valid` for a candidate); state tables only. Empty when `dropped`. */
  readonly valid: IntervalSet;
  /**
   * For numbering (step 6): the last block that gave the index an interval, skipping restatements
   * as dropped. Absent: `valid`. None at all (every block dropped): absent and `valid` empty.
   */
  readonly landing?: IntervalSet;
  readonly deps: readonly ItemRef[];
  readonly content: ItemContent;
  readonly carried?: readonly ItemRef[];
}

/** By (event, target) as `${event}/${target}`: the blocks the log last gave, one per index. */
export type LatestGiven = ReadonlyMap<string, readonly GivenBlock[]>;

const key = (event: number, target: Target) => `${event}/${target}`;

/** The records as written, as the latest blocks (no deletion restated anything yet). */
export function givenByRecords(records: readonly OpRecord[]): Map<string, GivenBlock[]> {
  const out = new Map<string, GivenBlock[]>();
  for (const r of records) {
    if (!("items" in r)) continue;
    for (const x of r.items) {
      const k = key(r.event, x.target);
      out.set(k, [
        ...(out.get(k) ?? []),
        {
          k: x.k,
          status: x.status,
          valid: x.valid,
          deps: x.deps,
          content: x.content,
          ...(x.carried !== undefined ? { carried: x.carried } : {}),
        },
      ]);
    }
  }
  return out;
}

const byStart = (a: { valid: IntervalSet }, b: { valid: IntervalSet }) => {
  const x = startOf(a.valid);
  const y = startOf(b.valid);
  if (x === y) return 0;
  if (x === null) return -1;
  if (y === null) return 1;
  return x < y ? -1 : 1;
};

/**
 * The indices of a replayed operation's items on one target (03-deletion «回掉的权威定义» step 6):
 * each index the log last gave stays on the first new item meeting its write-time block (an index
 * a deletion first gave: its block as last given); several landing on one item merge, the smallest
 * index stays; an index with no readable block left takes its number back; new items continue after
 * the largest index given. `fresh`: the items as the replay
 * judged them, numbered from 0. `writeTime`: the operation's own items as written.
 */
export function renumber(
  fresh: readonly RecordedItem[],
  latest: readonly GivenBlock[],
  writeTime: readonly RecordedItem[],
): RecordedItem[] {
  const items = [...fresh].sort(byStart);
  const base = [...latest].sort((a, b) => a.k - b.k);
  const landing = new Map<number, number[]>();
  // An index with no readable block at all (only restated as dropped since, a contribution again)
  // takes its number back, by index order, before new numbers are given.
  const back: number[] = [];
  for (const b of base) {
    const at = writeTime.find((w) => w.k === b.k)?.valid ?? b.landing ?? b.valid;
    if (isNothing(at)) {
      back.push(b.k);
      continue;
    }
    const i = items.findIndex((it) => !isNothing(meet(it.valid, at)));
    if (i >= 0) landing.set(i, [...(landing.get(i) ?? []), b.k]);
  }
  let next = Math.max(-1, ...base.map((b) => b.k)) + 1;
  return items.map((it, i) => ({ ...it, k: landing.get(i)?.[0] ?? back.shift() ?? next++ }));
}

const sameRefs = (a: readonly ItemRef[] = [], b: readonly ItemRef[] = []) => {
  const s = (xs: readonly ItemRef[]) =>
    xs
      .map((r) => `${r.event}/${r.target}/${r.k}`)
      .sort()
      .join(",");
  return s(a) === s(b);
};

const sameSet = (a: IntervalSet, b: IntervalSet) =>
  JSON.stringify(canonical([...a])) === JSON.stringify(canonical([...b]));

/**
 * The restatements of a replay (09 §5.9, rules 1 and 2): every item whose judgement — status,
 * interval, deps, for a carried item its value and carried references, a write-back with no value
 * or that only registers — differs from the block the log last gave; every item whose last block
 * rests on a contribution the deletion takes away or that is restated (the block is cleared), still
 * a contribution: restated as it is, to a fixed point; every index the log gave that is no longer
 * an item and was not deleted: `dropped`. `deleted`: by `${event}/${target}`.
 */
export function restatements(
  replayed: readonly OpRecord[],
  latest: LatestGiven,
  deleted: ReadonlySet<string>,
  isState: boolean,
): Restatement[] {
  const now = new Map<string, { event: number; item: RecordedItem }>();
  for (const r of replayed) {
    if (!("items" in r)) continue;
    for (const x of r.items) now.set(`${r.event}/${x.target}/${x.k}`, { event: r.event, item: x });
  }
  const out = new Map<string, Restatement>();
  const restate = (ref: string, event: number, x: RecordedItem) => {
    // A carried item gives its value and carried references; a write-back with no value or that
    // only registers says so (`no_value`, `uncovered`), without value or sources (09 §5.9).
    const writeBackKind = x.content.kind === "no_value" || x.content.kind === "uncovered";
    out.set(ref, {
      item: { event, target: x.target, k: x.k },
      status: x.status,
      ...(isState ? { valid: x.valid } : {}),
      deps: x.deps,
      ...(x.carried !== undefined
        ? { content: x.content, carried: x.carried }
        : writeBackKind
          ? { content: x.content }
          : {}),
      ...(x.target === "existence" && x.content.kind === "restore"
        ? { restored: true as const }
        : {}),
    });
  };
  // Rule 1, and new indices.
  for (const [ref, { event, item: x }] of now) {
    const given = latest.get(key(event, x.target))?.find((b) => b.k === x.k);
    if (
      given === undefined ||
      given.status !== x.status ||
      (isState && !sameSet(given.valid, x.valid)) ||
      !sameRefs(given.deps, x.deps) ||
      (x.carried !== undefined &&
        (JSON.stringify(given.content) !== JSON.stringify(x.content) ||
          !sameRefs(given.carried, x.carried))) ||
      (x.carried === undefined && given.content.kind !== x.content.kind)
    ) {
      restate(ref, event, x);
    }
  }
  // Indices given that are no longer items, not deleted: dropped.
  for (const [et, blocks] of latest) {
    if (deleted.has(et)) continue;
    const [ev, target] = et.split("/") as [string, Target];
    for (const b of blocks) {
      const ref = `${et}/${b.k}`;
      // Last given as dropped already: nothing new to say.
      if (now.has(ref) || out.has(ref) || b.status === "dropped") continue;
      out.set(ref, { item: { event: Number(ev), target, k: b.k }, status: "dropped", deps: [] });
    }
  }
  // Rule 2, to a fixed point: a last block resting on a deleted or restated contribution.
  const gone = (d: ItemRef) =>
    deleted.has(key(d.event, d.target)) || out.has(`${d.event}/${d.target}/${d.k}`);
  for (let changed = true; changed; ) {
    changed = false;
    for (const [ref, { event, item: x }] of now) {
      if (out.has(ref)) continue;
      const given = latest.get(key(event, x.target))?.find((b) => b.k === x.k);
      if (given?.deps.some(gone)) {
        restate(ref, event, x);
        changed = true;
      }
    }
  }
  return [...out.values()].sort(
    (a, b) =>
      a.item.event - b.item.event ||
      a.item.target.localeCompare(b.item.target) ||
      a.item.k - b.item.k,
  );
}
