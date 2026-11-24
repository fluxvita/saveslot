// The item layer of a deletion (03-deletion «删除结果的定义» deviation two, «性质» «删除不增加未决事项»,
// «预览与回执要写明的内容»; 09 §5.9 `superseded_items`, §5.8 `item.refreshed`, `item.created`):
// what becomes of each (event, target) that is pending on one side of the deletion, and from that,
// which items are superseded, restored, refreshed or opened to succeed one.
//
// Pure, as the replay: which item each (event, target) is in, and how that item stands, are the
// caller's to work out from the log's item events (`ItemsGiven`, item IDs opaque here; the kernel's
// call site passes them). `itemsByRecords` derives them from the records as written, for fixed
// cases and comparisons only.

import { canonical, isNothing, meet, minus } from "../time/index.ts";
import { contributionKey, type OpRecord, type Target, type Unit } from "./model.ts";
import { EVERYTHING, type RowState } from "./state.ts";

/** How an item stands now, as the log's item events say. */
export type ItemStanding =
  | { readonly kind: "open" }
  | { readonly kind: "resolved" }
  | { readonly kind: "superseded"; readonly reason: string };

/** The kind of a pending item that a pending (event, target) is in. */
export type PendingKind = "conflict" | "awaiting";

/** Which item each (event, target) that was ever pending is in, and how each item stands. */
export interface ItemsGiven {
  /**
   * By `contributionKey`: the original item, the one the (event, target) was in when its write was
   * written (opened or joined then).
   */
  readonly original: ReadonlyMap<string, string>;
  /**
   * By `contributionKey`: the item it is in now: the original, or the latest item that succeeded
   * it after a deletion.
   */
  readonly of: ReadonlyMap<string, string>;
  readonly items: ReadonlyMap<
    string,
    { readonly kind: PendingKind; readonly unit: Unit; readonly standing: ItemStanding }
  >;
}

/**
 * What becomes of an (event, target) whose pending membership this deletion changes (03-deletion
 * «删除不增加未决事项»); one in the same open item before and after, or in a closed item on both
 * sides, has none. `item` is the item it is in now (`ItemsGiven.of`).
 * - `removed`: in an open item before; none of its items is left on the target.
 * - `now_effective`: in an open item before, in effect after.
 * - `closed_by_revert`: in an open item before; after, every one of its items is registered as
 *   reverted over the whole of it by a revert's record (it took effect and is taken back).
 * - `restored`: pending after, into an item superseded by a deletion (`restores`): its original
 *   item when of the original's kind, else the item succeeding it of that kind; that item's
 *   supersession is taken back. The item it is in now, when another and open, it leaves.
 * - `rejoined`: pending after, into an open item it was not pending in (`into`): its original
 *   item, still open (only refreshed), when of the original's kind; or the open item it is in now
 *   when it was in effect before (an earlier deletion put it in effect). The item refreshed.
 * - `succeeded`: pending after, of the other kind than its original item, and no item succeeding
 *   that one is of its kind: a new item succeeds the original one to one (`succeeds`).
 * - `returned`: a write in effect in part when written (by its record: on the target, items in
 *   effect and items not), a part of which in effect before is not after. When the item it is in
 *   is closed (a person's decision, or a supersession for another reason than a deletion), it
 *   closes with it. Otherwise it goes where its kind says (`destination`: its original item when
 *   of that kind, else the item it is in): `merged` into it, restored when a deletion superseded
 *   it; `closed_by_decision` / `closed_with_supersession` when that item is closed so (no new
 *   item). `to` names that item when it is not the one it is in; it then leaves the one it is in.
 *   With no item of its kind it is `succeeded` instead. A write a candidate or awaiting in full
 *   when written gets no `returned`.
 */
export type PendingFate =
  | { readonly kind: "removed" | "now_effective" | "closed_by_revert"; readonly item: string }
  | { readonly kind: "restored"; readonly item: string; readonly restores: string }
  | { readonly kind: "rejoined"; readonly item: string; readonly into: string }
  | {
      readonly kind: "succeeded";
      readonly item: string;
      readonly succeeds: string;
      readonly as: PendingKind;
    }
  | {
      readonly kind: "returned";
      readonly item: string;
      readonly into: "merged" | "closed_by_decision" | "closed_with_supersession";
      /** The item it goes to when not `item`: its original item, of its kind again. */
      readonly to?: string;
    };

/** An item a deletion opens to succeed one (09 §5.8 `item.created`, after the deletion event). */
export interface OpenedItem {
  /** The original item it succeeds. */
  readonly succeeds: string;
  readonly kind: PendingKind;
  readonly unit: Unit;
  readonly reason: "conflict_cleared_by_deletion" | "stale_write";
  /** Its (event, target)s, by `contributionKey`, sorted. */
  readonly members: readonly string[];
}

export interface ItemsResult {
  /** By `contributionKey`, sorted. */
  readonly fates: ReadonlyMap<string, PendingFate>;
  /** Items every pending member of which leaves pending (09 §5.9 `superseded_items`), sorted. */
  readonly superseded: readonly string[];
  /** Items superseded by an earlier deletion whose pending comes back, sorted. */
  readonly restored: readonly string[];
  /**
   * Open items some members of which leave or come back while the item stays open (09 §5.8
   * `item.refreshed`, `entries_deleted`): the members leaving (`dropped_candidates`) and those
   * coming back, by `contributionKey`, sorted; by item, sorted.
   */
  readonly refreshed: readonly {
    readonly item: string;
    /** `entries_deleted` when some members leave (`back` given with it too), else `entries_restored`. */
    readonly cause: "entries_deleted" | "entries_restored";
    readonly left: readonly string[];
    readonly back: readonly string[];
  }[];
  /** One item for each original item succeeded, by the item succeeded. */
  readonly opened: readonly OpenedItem[];
}

/** The writes whose items stand for themselves in items: writes, revokes, and reverts. */
const pendingTargets = (records: readonly OpRecord[]): string[] => {
  const keys = new Set<string>();
  for (const r of records) {
    if (!("items" in r)) continue;
    for (const x of r.items) {
      if (x.status === "candidate" || x.status === "awaiting")
        keys.add(contributionKey(r.event, x.target));
    }
  }
  return [...keys];
};

/** The items of (event, target) in a state. */
const itemsOf = (s: RowState, event: number, target: Target) =>
  s.items.filter((x) => x.event === event && x.target === target);

/**
 * Whether (event, target) is pending in a state, and as what: a candidate no conflict resolution
 * closed, or an awaiting item no confirmation or rejection decided. (A revert registers only items
 * in effect, so no pending item is registered as reverted.)
 */
export function pendingIn(s: RowState, event: number, target: Target): PendingKind | undefined {
  const mine = itemsOf(s, event, target);
  if (mine.some((x) => x.status === "awaiting") && !s.resolvedAwaiting(event)) return "awaiting";
  if (mine.some((x) => x.status === "candidate") && !s.closedCandidate(event, target))
    return "conflict";
  return undefined;
}

const revertedWhole = (s: RowState, x: RowState["items"][number]) =>
  isNothing(minus(x.valid, s.registeredSet(x, EVERYTHING)));

/**
 * Where a pending (event, target) goes after a deletion or cancellation, by its kind after
 * (03-deletion «因先前的删除才生效、本次将回到未决的写入»: «种类与原事项相同的给出它回到的原事项
 * …；种类不同的…已有的同种类接替事项，或新开的»; kinds compared with the original item's): its
 * original item when of that kind; else the item it is in now when of that kind (a successor);
 * else none (a new item succeeds the original).
 */
function destination(
  kind: PendingKind,
  id: string,
  cur: { readonly kind: PendingKind },
  origId: string,
  orig: { readonly kind: PendingKind },
): string | undefined {
  return kind === orig.kind ? origId : kind === cur.kind ? id : undefined;
}

/**
 * The item layer of a deletion. `before`: the state before it (the replay of the deletions still
 * pending before it, or the records as written); `after`: its replay; `records`: the records as
 * written (every (event, target) ever pending is among theirs); `given`: the items.
 */
export function itemsResult(
  before: RowState,
  after: RowState,
  records: readonly OpRecord[],
  given: ItemsGiven,
): ItemsResult {
  const fates = new Map<string, PendingFate>();
  const inPart = writtenInPart(records);
  /** Items a part going back restores (merged into an item a deletion superseded). */
  const restoredToo = new Set<string>();
  /** The open item each (event, target) is a pending member of before, and leaves. */
  const memberOf = new Map<string, string>();
  const leaving = new Set<string>();
  /** Members coming into an open item, by item. */
  const joining = new Map<string, string[]>();
  const itemOf = (id: string | undefined, key: string) => {
    const x = id === undefined ? undefined : given.items.get(id);
    if (id === undefined || x === undefined)
      throw new Error(`no item given for the pending ${key}`);
    return x;
  };
  const isOpen = (x: { standing: ItemStanding }) => x.standing.kind === "open";
  const byDeletion = (x: { standing: ItemStanding }) =>
    x.standing.kind === "superseded" && x.standing.reason === "deleted";
  const join = (id: string, key: string) => joining.set(id, [...(joining.get(id) ?? []), key]);
  for (const key of pendingTargets(records).sort()) {
    const [ev, target] = splitKey(key);
    const b = pendingIn(before, ev, target);
    const a = pendingIn(after, ev, target);
    // A write in effect in part when written (by its record), a part of it in effect before and
    // not after (a candidate or awaiting, a decision closing it or not).
    const partBack = inPart.has(key) && goneBack(before, after, ev, target);
    if (b === undefined && a === undefined && !partBack) continue;
    const id = given.of.get(key) as string;
    const cur = itemOf(given.of.get(key), key);
    const origId = given.original.get(key) as string;
    const orig = itemOf(given.original.get(key), key);
    if (b !== undefined && isOpen(cur)) memberOf.set(key, id);
    const member = memberOf.has(key);
    // How a stand closes it: a person's decision, or a supersession for another reason than a
    // deletion. Neither puts a candidate back (03-deletion «撤回与宽限期»: «事项已关闭的…不放回，
    // 候选随它关闭»).
    const closedBy = (x: { standing: ItemStanding }) =>
      x.standing.kind === "resolved"
        ? ("closed_by_decision" as const)
        : x.standing.kind === "superseded" && x.standing.reason !== "deleted"
          ? ("closed_with_supersession" as const)
          : undefined;
    // Where it is pending after (03-deletion «因先前的删除才生效、本次将回到未决的写入»: kinds are
    // compared with the original item's): `destination`. A part going back with no item of its
    // kind (a candidate whose conflict a deletion cleared, still of high impact: awaiting) is
    // succeeded below, as any pending of another kind.
    const to = a === undefined ? id : destination(a, id, cur, origId, orig);
    if (partBack) {
      // The item it is in closed: it closes with it, as the other branch below.
      const closedHere = closedBy(cur);
      if (closedHere !== undefined) {
        fates.set(key, { kind: "returned", item: id, into: closedHere });
        continue;
      }
    }
    if (partBack && to !== undefined) {
      // Back where it goes: merged into it when open (restored when a deletion superseded it),
      // closed with it when a decision or another supersession closed it (no new item).
      const into = to === origId ? orig : cur;
      const how = closedBy(into) ?? "merged";
      fates.set(key, { kind: "returned", item: id, into: how, ...(to !== id ? { to } : {}) });
      // Gone from the item it is in when it goes to another.
      if (member && to !== id) leaving.add(key);
      if (how === "merged") {
        join(to, key);
        if (byDeletion(into)) restoredToo.add(to);
      }
      continue;
    }
    if (a === undefined && !partBack) {
      if (!member) continue;
      const mine = itemsOf(after, ev, target);
      const kind =
        mine.length === 0
          ? "removed"
          : mine.every((x) => revertedWhole(after, x))
            ? "closed_by_revert"
            : "now_effective";
      fates.set(key, { kind, item: id });
      leaving.add(key);
      continue;
    }
    // Closed by a person's decision or superseded for another reason: closed on both sides.
    if (closedBy(cur) !== undefined) continue;
    // Not pending after (a decision closes the part gone back) with its item open: as closed.
    if (a === undefined) continue;
    if (to === undefined) {
      fates.set(key, { kind: "succeeded", item: id, succeeds: origId, as: a });
      if (member) leaving.add(key);
      continue;
    }
    // In the same open item before and after: nothing changes.
    if (to === id && member) continue;
    const into = to === origId ? orig : cur;
    if (byDeletion(into)) fates.set(key, { kind: "restored", item: id, restores: to });
    else if (isOpen(into)) fates.set(key, { kind: "rejoined", item: id, into: to });
    else continue;
    join(to, key);
    if (member && to !== id) leaving.add(key);
  }

  // Items: an open one every pending member of which leaves, with none coming in, is superseded;
  // some leaving or coming in, refreshed: the item stays pending (03-deletion «推论»: a candidate
  // taking effect while others of its item stay pending). A new item succeeds each original item
  // one to one.
  const superseded: string[] = [];
  const refreshed: {
    item: string;
    cause: "entries_deleted" | "entries_restored";
    left: string[];
    back: string[];
  }[] = [];
  const restored = new Set<string>();
  for (const f of fates.values()) if (f.kind === "restored") restored.add(f.restores);
  for (const id of restoredToo) restored.add(id);
  const touched = new Set([...leaving].map((k) => memberOf.get(k) as string));
  for (const id of joining.keys()) touched.add(id);
  for (const id of [...touched].sort()) {
    if (given.items.get(id)?.standing.kind !== "open") continue;
    const members = [...memberOf].filter(([, i]) => i === id).map(([k]) => k);
    const left = members.filter((k) => leaving.has(k)).sort();
    const back = [...(joining.get(id) ?? [])].sort();
    if (members.length > 0 && left.length === members.length && back.length === 0)
      superseded.push(id);
    else if (left.length > 0 || back.length > 0) {
      // One `item.refreshed` an item an operation (09 §4.2): members leaving make it
      // `entries_deleted`, with those coming back too; only coming back, `entries_restored`.
      const cause = left.length > 0 ? "entries_deleted" : "entries_restored";
      refreshed.push({ item: id, cause, left, back });
    }
  }
  const bySucceeded = new Map<string, string[]>();
  for (const [k, f] of fates) {
    if (f.kind === "succeeded")
      bySucceeded.set(f.succeeds, [...(bySucceeded.get(f.succeeds) ?? []), k]);
  }
  const opened: OpenedItem[] = [];
  for (const [id, keys] of bySucceeded) {
    const next = keys.sort();
    const as = (fates.get(next[0] as string) as { as: PendingKind }).as;
    const targets = next.map((k) => splitKey(k)[1]);
    const onExistence = targets.includes("existence") || existenceUnit(given, id);
    opened.push({
      succeeds: id,
      kind: as,
      // A conflict's unit is the conflict unit (a group as a whole, 09-references-conflict-sync
      // «冲突单元»); an awaiting item's, the fields of its proposal.
      unit: onExistence
        ? "existence"
        : {
            fields: [
              ...new Set(
                targets.flatMap(
                  (t) =>
                    (as === "conflict" ? (after.unitOf.get(t as never) ?? [t]) : [t]) as string[],
                ) as string[],
              ),
            ].sort() as never,
          },
      reason: as === "awaiting" ? "conflict_cleared_by_deletion" : "stale_write",
      members: next,
    });
  }
  return {
    fates,
    superseded: superseded.sort(),
    restored: [...restored].sort(),
    refreshed,
    opened: opened.sort((x, y) => (x.succeeds < y.succeeds ? -1 : 1)),
  };
}

/**
 * The (event, target)s of writes in effect in part when written (03-deletion deviation two): on the
 * target, the write's record has items in effect (applied or corroborated) and items not
 * (candidate or awaiting).
 */
function writtenInPart(records: readonly OpRecord[]): Set<string> {
  const out = new Set<string>();
  for (const r of records) {
    if (!("items" in r) || (r.kind !== "write" && r.kind !== "revoke")) continue;
    for (const t of new Set(r.items.map((x) => x.target))) {
      const mine = r.items.filter((x) => x.target === t);
      if (
        mine.some((x) => x.status === "applied" || x.status === "corroborated") &&
        mine.some((x) => x.status === "candidate" || x.status === "awaiting")
      )
        out.add(contributionKey(r.event, t));
    }
  }
  return out;
}

/** Whether a part of (event, target) in effect before is not in effect after. */
function goneBack(before: RowState, after: RowState, event: number, target: Target): boolean {
  const of = (s: RowState, statuses: readonly string[]) =>
    canonical(
      itemsOf(s, event, target)
        .filter((x) => statuses.includes(x.status))
        .flatMap((x) => x.valid),
    );
  return !isNothing(
    meet(of(before, ["applied", "corroborated"]), of(after, ["candidate", "awaiting"])),
  );
}

const existenceUnit = (given: ItemsGiven, id: string) => given.items.get(id)?.unit === "existence";

const splitKey = (key: string): [number, Target] => {
  const at = key.indexOf("/");
  return [Number(key.slice(0, at)), key.slice(at + 1) as Target];
};

/**
 * The items as the records written would have them: each write's candidates one item a conflict
 * unit, its awaiting items one item; resolved when a person's decision recorded closes them (a
 * conflict resolution that decided a candidate of it; a confirmation or rejection of the write),
 * open otherwise. No supersession: the records do not say what an item event would. For fixed cases and comparisons only; the
 * kernel's call site passes what the log's item events say.
 */
export function itemsByRecords(state: RowState): ItemsGiven {
  const of = new Map<string, string>();
  const items = new Map<string, { kind: PendingKind; unit: Unit; standing: ItemStanding }>();
  for (const r of state.records) {
    if (!("items" in r)) continue;
    for (const x of r.items) {
      const key = contributionKey(r.event, x.target);
      if (x.status === "awaiting") {
        const id = `${r.event}:awaiting`;
        of.set(key, id);
        const prev = items.get(id);
        const unit: Unit =
          x.target === "existence" || prev?.unit === "existence"
            ? "existence"
            : {
                fields: [
                  ...new Set([...(prev?.unit !== undefined ? fieldsOf(prev.unit) : []), x.target]),
                ].sort() as never,
              };
        items.set(id, {
          kind: "awaiting",
          unit,
          standing: state.resolvedAwaiting(r.event) ? { kind: "resolved" } : { kind: "open" },
        });
      } else if (x.status === "candidate") {
        const unit: Unit = state.inUnit({ event: r.event, target: x.target }, "existence")
          ? "existence"
          : { fields: [...(state.unitOf.get(x.target as never) ?? [x.target as never])] };
        const id = `${r.event}:${state.unitKey(unit)}`;
        of.set(key, id);
        const closed =
          state.closedCandidate(r.event, x.target) || items.get(id)?.standing.kind === "resolved";
        items.set(id, {
          kind: "conflict",
          unit,
          standing: closed ? { kind: "resolved" } : { kind: "open" },
        });
      }
    }
  }
  return { original: of, of, items };
}

const fieldsOf = (u: Unit): string[] => (u === "existence" ? [] : [...u.fields]);
