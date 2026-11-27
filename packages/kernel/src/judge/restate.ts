// What a deletion's replay restates (docs/zh-CN/spec/09-event-format.md §5.9 `restated/<k>`;
// 03-deletion «回掉的权威定义» step 6, indices): the items of the replay numbered against the blocks
// the log last gave, and the items whose judgement differs from those blocks.
//
// Pure. The blocks the log last gave are the caller's to work out (`LatestGiven`): for each
// (event, target) and index, the last judgement the log gave it — the write's own item, or a later
// deletion's restatement, `dropped` included — skipping blocks of a cancelled deletion; and, for
// numbering only, the last block that gave an interval, skipping restatements as dropped (09 §5.7
// "最近一次给出的块只用于这类下标保留编号"). With none given, the records as written are the
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
  /**
   * Absent only on a block last given as dropped whose content is not known: an index with no
   * block before, of an (event, target) with no item when written (a write-back a deletion first
   * gave). Such an item comes back with its content: a restatement gives a write-back's.
   */
  readonly content?: ItemContent;
  readonly carried?: readonly ItemRef[];
  /**
   * The block is a deletion's `restated/<k>`: besides its deps it rests on the item it restates
   * (09 §3.5 rule 1; `apply/apply.ts`, the block's references), so a deletion restating that item
   * lists it.
   */
  readonly restatement?: true;
  /**
   * An index only cancelled deletions gave (09 §5.7: a deletion numbered it, and every block that
   * gave it an interval since came from a deletion cancelled): it has no original interval, lands
   * on nothing, and the cancellation restates it as dropped (09 §5.9 «哪些项要重述» item 4). Last
   * given as dropped here only for the cancellation's replay (`onlyCancelledGave`).
   */
  readonly unsaid?: true;
}

/**
 * The `deps` of a restatement's block as the event writes it (09 §5.9, §3.5 rule 1): a carried
 * item's new value names what it carries there too, each reference once, in their first order.
 */
export function restatedDeps(r: Restatement): readonly ItemRef[] {
  if (r.item.target === "existence" || r.content?.kind !== "value") return r.deps;
  const seen = new Set<string>();
  return [...r.deps, ...(r.carried ?? [])].filter((x) => {
    const k = `${x.event}/${x.target}/${x.k}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
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

/**
 * The blocks last given without the cancelled deletions' (09 §5.7), for a cancellation's replay,
 * with each index only cancelled deletions gave laid over as dropped and still to be said
 * (`unsaid`): an index not written by the operation itself (every index as written stays in
 * `latest`), that `cancelledGave` gives an interval and no block counted gives at all. One a block
 * counted last gave as dropped (a pending deletion's) is not said again: that block keeps its
 * number already. On an (event, target) a deletion still pending removes whole it is not said
 * either: the restatement step skips what is deleted (`restatements`). `cancelledGave`: the
 * restatements of the deletion cancelled and of those cancelled before it.
 */
export function onlyCancelledGave(
  latest: LatestGiven,
  cancelledGave: readonly Restatement[],
): Map<string, GivenBlock[]> {
  const out = new Map<string, GivenBlock[]>([...latest].map(([et, bs]) => [et, [...bs]]));
  for (const r of cancelledGave) {
    if (r.status === "dropped") continue;
    const et = key(r.item.event, r.item.target);
    const blocks = out.get(et) ?? [];
    // Any block counted gives it already (an interval, or a restatement as dropped that keeps
    // its number): nothing to say.
    if (blocks.some((b) => b.k === r.item.k)) continue;
    out.set(et, [
      ...blocks,
      { k: r.item.k, status: "dropped", valid: [], deps: [], restatement: true, unsaid: true },
    ]);
  }
  return normalized(out);
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
 * the largest index given (an index last given as dropped included). `fresh`: the items as the replay
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
  // An index as written with no readable block at all (only restated as dropped since, a
  // contribution again) takes its number back, by index order, before new numbers are given. An
  // index a deletion numbered never does (09 §5.7): with no interval block left it lands nowhere,
  // and its number counts as used.
  const back: number[] = [];
  for (const b of base) {
    const at = writeTime.find((w) => w.k === b.k)?.valid ?? b.landing ?? b.valid;
    if (isNothing(at)) {
      if (writeTime.some((w) => w.k === b.k)) back.push(b.k);
      continue;
    }
    const i = items.findIndex((it) => !isNothing(meet(it.valid, at)));
    if (i >= 0) landing.set(i, [...(landing.get(i) ?? []), b.k]);
  }
  let next = Math.max(-1, ...base.map((b) => b.k)) + 1;
  return items.map((it, i) => ({ ...it, k: landing.get(i)?.[0] ?? back.shift() ?? next++ }));
}

/**
 * A block's deps in judge's terms (rule 1 compares them so): an event or timeless table's item has
 * no deps of its own, and a valued restatement's block lists its carried items there only as the
 * event writes them (`restatedDeps`).
 */
function depsAsJudged(b: GivenBlock, isState: boolean): readonly ItemRef[] {
  if (isState || b.carried === undefined) return b.deps;
  const carried = new Set(b.carried.map((c) => `${c.event}/${c.target}/${c.k}`));
  return b.deps.filter((d) => !carried.has(`${d.event}/${d.target}/${d.k}`));
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
 * an item and was not deleted: `dropped`. `deleted`: by `${event}/${target}`. A cancellation's
 * rule 3: `cancelled`, the items (`${event}/${target}/${k}`) whose last interval block (not a
 * restatement as dropped) came from the deletion cancelled — `latest` is then the blocks without that deletion's (09 §5.7) — each still an
 * item restated as it is. A cancellation's rule 4: an index only cancelled deletions gave (`unsaid`
 * in `latest`, `onlyCancelledGave`) is restated as dropped.
 */
export function restatements(
  replayed: readonly OpRecord[],
  latest: LatestGiven,
  deleted: ReadonlySet<string>,
  isState: boolean,
  cancelled: ReadonlySet<string> = new Set(),
  /**
   * The blocks this deletion's own list of positions clears besides (a deletion worked out with
   * other pending deletions lists its positions by its replay alone, 03-deletion «多项删除各自列全
   * 位置»): by a dep, and by a carried item, of the last block. Rule 2 restates an item still a
   * contribution whose last block is cleared so (09 §5.9 rule 2: the blocks this deletion clears).
   */
  cleared?: { readonly dep: (d: ItemRef) => boolean; readonly carried: (d: ItemRef) => boolean },
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
      !sameRefs(depsAsJudged(given, isState), x.deps) ||
      (x.carried !== undefined &&
        (JSON.stringify(given.content) !== JSON.stringify(x.content) ||
          !sameRefs(given.carried, x.carried))) ||
      (x.carried === undefined && given.content?.kind !== x.content.kind)
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
      if (now.has(ref) || out.has(ref)) continue;
      // Last given as dropped already: nothing new to say, unless this deletion's own list clears
      // that block (an earlier deletion's restatement, resting on the item it restates, which this
      // deletion alone restates): given again as dropped, or a replay from an empty store falls
      // back to the item's block as written (09 §5.9 rule 2).
      // An index only cancelled deletions gave is said once, by the cancellation (09 §5.9
      // «哪些项要重述» item 4): without deps, value or sources.
      if (
        b.status === "dropped" &&
        b.unsaid !== true &&
        !(
          cleared !== undefined &&
          b.restatement === true &&
          cleared.dep({ event: Number(ev), target, k: b.k })
        )
      )
        continue;
      out.set(ref, { item: { event: Number(ev), target, k: b.k }, status: "dropped", deps: [] });
    }
  }
  // Rule 3 (a cancellation): an item whose last block came from the deletion cancelled.
  for (const ref of cancelled) {
    const x = now.get(ref);
    if (x !== undefined && !out.has(ref)) restate(ref, x.event, x.item);
  }
  // Rule 2, to a fixed point: a last block resting on a deleted or restated contribution. A
  // carried item's sources without an interval have no deps: they go when an item they carry is
  // deleted or restated as dropped (09 §3.5 rule 1), so the item is restated too.
  const gone = (d: ItemRef) =>
    deleted.has(key(d.event, d.target)) || out.has(`${d.event}/${d.target}/${d.k}`);
  const carriedGone = (d: ItemRef) =>
    deleted.has(key(d.event, d.target)) ||
    out.get(`${d.event}/${d.target}/${d.k}`)?.status === "dropped";
  for (let changed = true; changed; ) {
    changed = false;
    for (const [ref, { event, item: x }] of now) {
      if (out.has(ref)) continue;
      const given = latest.get(key(event, x.target))?.find((b) => b.k === x.k);
      if (
        given?.deps.some(gone) ||
        given?.carried?.some(carriedGone) ||
        (cleared !== undefined &&
          (given?.deps.some(cleared.dep) ||
            given?.carried?.some(cleared.carried) ||
            (given?.restatement === true && cleared.dep({ event, target: x.target, k: x.k }))))
      ) {
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

// The blocks last given of a row (09 §5.7 «以最近一次为准») with a deletion's or a cancellation's
// restatements laid over, in log order: what the deletion replay reads as `LatestGiven` on a row
// earlier deletions touched.

/**
 * The blocks last given, less the deleted (event, target)s, with the restatements laid over.
 * `written`: the records as written, where the content of an item that is not carried comes from.
 */
export function overlay(
  given: ReadonlyMap<string, readonly GivenBlock[]>,
  restated: readonly Restatement[],
  gone: ReadonlySet<string>,
  written: readonly OpRecord[],
): Map<string, GivenBlock[]> {
  const own = ownContent(written);
  const out = new Map<string, GivenBlock[]>();
  for (const [et, blocks] of given) if (!gone.has(et)) out.set(et, [...blocks]);
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const rest = (out.get(et) ?? []).filter((b) => b.k !== r.item.k);
    if (r.status === "dropped") {
      // Last given as dropped: kept so (rule 1 compares with it), landing on the last interval
      // given before (numbering only).
      const before = (out.get(et) ?? []).find((b) => b.k === r.item.k);
      const landing = before?.landing ?? before?.valid ?? [];
      const dropped = droppedContent(own, r, before);
      out.set(et, [
        ...rest,
        {
          k: r.item.k,
          status: "dropped",
          valid: [],
          ...(landing.length > 0 ? { landing } : {}),
          deps: [],
          ...(dropped !== undefined ? { content: dropped } : {}),
          // A restatement's block as dropped, resting on the item it restates as any other.
          restatement: true,
        },
      ]);
      continue;
    }
    // The block last given for the index, for the carried references of a restatement that does
    // not give the content.
    const was = (given.get(et) ?? []).find((b) => b.k === r.item.k);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        // A restatement without an interval is an event or timeless table's: the whole of it.
        valid: r.valid ?? [{ from: null, to: null }],
        // As the event writes it: the same block whether read from the log or laid over.
        deps: restatedDeps(r),
        content: r.content ?? contentOf(own, r),
        // A restatement that gives the content gives the carried references with it (none for
        // a write-back with no value or that only registers).
        ...(r.content !== undefined
          ? r.carried !== undefined
            ? { carried: r.carried }
            : {}
          : was?.carried !== undefined
            ? { carried: was.carried }
            : {}),
        restatement: true,
      },
    ]);
  }
  return normalized(out);
}

/** The content of each item as written, by `${event}/${target}/${k}` and, for any index, `${event}/${target}`. */
function ownContent(written: readonly OpRecord[]): Map<string, ItemContent> {
  const out = new Map<string, ItemContent>();
  for (const r of written) {
    if (!("items" in r)) continue;
    for (const x of r.items) {
      const et = `${r.event}/${x.target}`;
      out.set(`${et}/${x.k}`, x.content);
      if (!out.has(et)) out.set(et, x.content);
    }
  }
  return out;
}

/** The content as written of a restatement's item: its own index's, else any index's of it. */
function writtenContent(
  own: ReadonlyMap<string, ItemContent>,
  r: Restatement,
): ItemContent | undefined {
  const et = `${r.item.event}/${r.item.target}`;
  return own.get(`${et}/${r.item.k}`) ?? own.get(et);
}

/**
 * The content of an index restated as dropped: the block it last had, else that index's own as
 * written. With neither (an index numbered anew, or one only a cancelled or a since-dropped
 * deletion gave) none: nothing is made up, not even another index's (a carried write-back's
 * indices hold values of their own), and not a kind that would be read (the deletion replay asks
 * whether a restated item's last block only registers, `uncovered`).
 */
function droppedContent(
  own: ReadonlyMap<string, ItemContent>,
  r: Restatement,
  before: GivenBlock | undefined,
): ItemContent | undefined {
  return before?.content ?? own.get(`${r.item.event}/${r.item.target}/${r.item.k}`);
}

/**
 * The content of a restatement that does not give it (09 §5.9: `value` and `sources` only for
 * carried items; `no_value` and `uncovered` said as such): on existence a restore exactly when it
 * says so (`restored`), else a revoke; on a field the write's own value, fixed in the write event,
 * whatever block a deletion gave the index since. Never another block's, never a made-up null.
 *
 * An (event, target) with no item when written that a deletion makes a contribution: a field judged
 * a no-op stays one in every replay (09 §5.7 `ops/<i>/noop`, `ReplayOptions.noop`; the fixed case
 * in replay-deletion.test.ts); a revoke's existence (a no-op on a row revoked already) is restated
 * with `restored` as it is; a revert's write-back is carried or says `no_value` or `uncovered`, so
 * its restatement gives the content. None reaches the records here; one that did would throw.
 */
function contentOf(own: ReadonlyMap<string, ItemContent>, r: Restatement): ItemContent {
  if (r.item.target === "existence") return { kind: r.restored ? "restore" : "revoke" };
  const c = writtenContent(own, r);
  if (c === undefined) {
    throw new Error(
      `overlay: ${r.item.event}/${r.item.target} is restated without content and has no item as written`,
    );
  }
  return c;
}

/** Each (event, target)'s blocks, by index; those with none left out. */
export function normalized(m: Map<string, GivenBlock[]>): Map<string, GivenBlock[]> {
  return new Map(
    [...m]
      .filter(([, bs]) => bs.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([et, bs]) => [et, [...bs].sort((x, y) => x.k - y.k)]),
  );
}
