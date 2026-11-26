// The item layer of a privacy deletion's confirmation (docs/zh-CN/spec/03-data-model/03-deletion.md
// «删除结果的定义» deviation two, «预览与回执要写明的内容»; 09-event-format §4.4, §5.8, §5.9
// `superseded_items`, §6.6): which pending item each (event, target) of an affected row is in, read
// from the row's item events, and the item events the deletion writes after its own, from judge's
// item layer (judge/fates.ts `itemsResult`).
//
// Only rows with no deletion on them yet: an item is the one its (event, target) was in when
// written (`original` and `of` the same), and no item was superseded by an earlier deletion.

import type { FieldId, Seq } from "@fluxvita/saveslot-contract-core";
import type { ItemStanding, ItemsGiven, ItemsResult, PendingKind } from "../judge/fates.ts";
import type { ItemRef, OpRecord, Target, Unit } from "../judge/index.ts";
import { uniqueRefs } from "../judge/index.ts";
import { contributionKey } from "../judge/model.ts";
import { type RowState, refOf } from "../judge/state.ts";
import type { NewEvent } from "../log/build.ts";
import { contentBlocks } from "../pending/index.ts";
import type { IntervalSet } from "../time/index.ts";
import { WriteError } from "../write/errors.ts";
import { itemContents, type TrackedItem, trackedItems, withProposals } from "../write/pipeline.ts";
import type { StoredEvent } from "../write/record.ts";

/** A pending item of the row, as its events say. */
export interface LogItem {
  readonly id: string;
  readonly type: "conflict" | "awaiting_confirmation";
  readonly unit: Unit;
  readonly origin: Seq;
  /** Conflict items: each candidate's block by its index (`candidates/<k>`), as last given. */
  readonly candidates: ReadonlyMap<number, Readonly<Record<string, unknown>>>;
  /** The event each candidate's block is in, by its index. */
  readonly candidateAt: ReadonlyMap<number, Seq>;
  readonly standing: ItemStanding;
  /** The operation of its latest event: its version (`item_ver`). */
  readonly versionOp: number;
}

const unitIn = (u: readonly string[] | undefined): Unit =>
  u === undefined || u[0] === "existence" ? "existence" : { fields: u as FieldId[] };

/** The targets a candidate block names: a field, or existence. */
export function candidateTargets(block: Readonly<Record<string, unknown>>): Target[] {
  const items = (block["items"] as { field?: FieldId; existence?: number }[] | undefined) ?? [];
  return [...new Set(items.map((y): Target => (y.field !== undefined ? y.field : "existence")))];
}

/**
 * The row's conflict and awaiting items from its events (`rowEvents`: its `item.created`, and the
 * `item.merged`, `item.refreshed`, `item.resolved`, `item.superseded` of its items), and which item
 * each (event, target) is in: a conflict item's candidates; an awaiting item's proposal (the
 * awaiting items of the write that opened it, in `state`). Flagged items are no (event, target)'s.
 */
export function itemsFromLog(
  events: readonly StoredEvent[],
  state: RowState,
  /**
   * The records' own state, when `state` has other pending deletions replayed: an awaiting item
   * opened when written (one such a deletion superseded since included) has its proposal there.
   */
  written?: RowState,
): { readonly given: ItemsGiven; readonly items: ReadonlyMap<string, LogItem> } {
  type Mutable = {
    id: string;
    type: LogItem["type"];
    unit: Unit;
    origin: Seq;
    candidates: Map<number, Readonly<Record<string, unknown>>>;
    candidateAt: Map<number, Seq>;
    standing: ItemStanding;
    versionOp: number;
  };
  const items = new Map<string, Mutable>();
  for (const e of [...events].sort((a, b) => a.header.seq - b.header.seq)) {
    const t = e.blocks["target"] as
      | { item?: string; type?: string; unit?: string[]; origin_event?: number; reason?: string }
      | undefined;
    if (t?.item === undefined) continue;
    const op = e.header.op ?? e.header.seq;
    if (e.header.type === "item.created") {
      if (t.type !== "conflict" && t.type !== "awaiting_confirmation") continue;
      items.set(t.item, {
        id: t.item,
        type: t.type,
        unit: unitIn(t.unit),
        origin: (t.origin_event ?? 0) as Seq,
        candidates: new Map(),
        candidateAt: new Map(),
        standing: { kind: "open" },
        versionOp: op,
      });
    }
    const x = items.get(t.item);
    if (x === undefined) continue;
    x.versionOp = Math.max(x.versionOp, op);
    for (const [p, b] of Object.entries(e.blocks)) {
      const m = /^candidates\/(\d+)$/.exec(p);
      if (m !== null) {
        x.candidates.set(Number(m[1]), b as Record<string, unknown>);
        x.candidateAt.set(Number(m[1]), e.header.seq);
      }
    }
    if (e.header.type === "item.resolved") x.standing = { kind: "resolved" };
    if (e.header.type === "item.superseded") {
      x.standing = { kind: "superseded", reason: t.reason ?? "" };
    }
  }
  const of = new Map<string, string>();
  for (const x of items.values()) {
    if (x.type === "conflict") {
      for (const b of x.candidates.values()) {
        const event = (b as { event: number }).event;
        for (const target of candidateTargets(b)) of.set(contributionKey(event, target), x.id);
      }
    } else {
      for (const y of [...(written?.items ?? []), ...state.items]) {
        if (y.event === x.origin && y.status === "awaiting") {
          of.set(contributionKey(y.event, y.target), x.id);
        }
      }
    }
  }
  const kindOf = (t: LogItem["type"]): PendingKind => (t === "conflict" ? "conflict" : "awaiting");
  return {
    given: {
      original: of,
      of,
      items: new Map(
        [...items.values()].map((x) => [
          x.id,
          { kind: kindOf(x.type), unit: x.unit, standing: x.standing },
        ]),
      ),
    },
    items,
  };
}

// --- the item events ---------------------------------------------------------------------------

/** An item a deletion opens, as the receipt lists it. */
export interface OpenedOut {
  readonly id: string;
  readonly succeeds: string;
  readonly type: LogItem["type"];
  readonly origin: Seq;
  readonly members: readonly string[];
}

export interface ItemEventsOut {
  /** `item.created`, then `item.superseded`, then `item.refreshed` (09 §4.4). */
  readonly events: readonly NewEvent[];
  /** `superseded_items` of the deletion event. */
  readonly superseded: readonly string[];
  readonly opened: readonly OpenedOut[];
}

/** All of business time, one interval with no ends (as write/record.ts writes a candidate's span). */
const isWhole = (v: IntervalSet) => v.length === 1 && v[0]?.from === null && v[0]?.to === null;

const unitOut = (u: Unit): string[] => (u === "existence" ? ["existence"] : [...u.fields].sort());

const endsOut = (v: IntervalSet): { from?: string; to?: string } => {
  const [x] = v;
  return x === undefined
    ? {}
    : { ...(x.from !== null ? { from: x.from } : {}), ...(x.to !== null ? { to: x.to } : {}) };
};

const refOut = (r: ItemRef) =>
  r.target === "existence"
    ? { event: r.event, existence: r.k }
    : { event: r.event, field: r.target, k: r.k };

/** A candidate's block re-given on the state after: its items there, what cut them. */
function candidateAfter(
  block: Readonly<Record<string, unknown>>,
  state: RowState,
): Record<string, unknown> | undefined {
  const event = (block as { event: number }).event;
  const targets = new Set(candidateTargets(block));
  const mine = state.items.filter(
    (x) => x.event === event && targets.has(x.target) && x.status === "candidate",
  );
  if (mine.length === 0) return undefined;
  return {
    ...block,
    items: mine.map((x) => {
      const valid = state.isState && !isWhole(x.valid) ? { valid: endsOut(x.valid) } : {};
      return x.target === "existence"
        ? { existence: x.k, ...valid }
        : {
            field: x.target,
            k: x.k,
            value: x.content.kind === "value" ? x.content.value : null,
            ...valid,
          };
    }),
    deps: uniqueRefs([...mine.map((x) => refOf(x)), ...mine.flatMap((x) => x.deps ?? [])]).map(
      refOut,
    ),
  };
}

/**
 * The item events of one affected row (09 §4.4, §5.8) from judge's item layer `layer`, worked out
 * on the state after the deletion (`after`). `listed`: the positions the deletion lists, by
 * `"<seq> <path>"`; `self`: the deletion event's seq (`by_event`, the contents' operation).
 */
export function itemEventsOf(input: {
  readonly slot: string;
  readonly table: string;
  readonly target: { readonly row: string } | { readonly entity: string };
  readonly events: readonly StoredEvent[];
  readonly items: ReadonlyMap<string, LogItem>;
  readonly layer: ItemsResult;
  readonly after: RowState;
  readonly records: readonly OpRecord[];
  readonly listed: ReadonlySet<string>;
  readonly self: Seq;
  readonly newId: () => string;
}): ItemEventsOut {
  const { layer, after, self } = input;
  // Members or candidates going back to their original item, one an earlier deletion superseded
  // (`restored`) or one still open (`back` of a refresh: an earlier deletion dropped them, this
  // one makes them pending again): the item events that put them back (`item.refreshed`
  // `restored_candidates`, 09 §5.8) are not made yet. Refused, both alike.
  if (layer.restored.length > 0 || layer.refreshed.some((r) => r.back.length > 0)) {
    throw new WriteError(
      "internal",
      "a deletion putting members back into an item is not implemented",
      {
        reason: "not_implemented",
        kind: "items_restored",
      },
    );
  }
  const at = { upTo: self as never };
  const open = new Map(
    [...input.items.values()]
      .filter((x) => x.standing.kind === "open")
      .map((x) => [x.id, x.versionOp as never]),
  );
  const tracked = new Map(
    withProposals(after, trackedItems(input.events, open)).map((t) => [t.item as string, t]),
  );
  const contentsOf = (t: TrackedItem) => contentBlocks(itemContents(after, t, at));
  const created: NewEvent[] = [];
  const opened: OpenedOut[] = [];
  for (const o of layer.opened) {
    if (o.kind !== "awaiting") {
      throw new WriteError("internal", "a deletion opening a conflict item is not implemented", {
        reason: "not_implemented",
        kind: "succeeded_as_conflict",
      });
    }
    const origin = Math.min(...o.members.map((k) => Number(k.split("/")[0]))) as Seq;
    // The awaiting item's impact is made from the state after (overwritten segments, filled
    // gaps); a revert's proposal also takes back later writes (`impact.reverted`) and a revoke's
    // has referrers (high impact ②), neither of which this works out: refused.
    const proposer = input.records.find((r) => r.event === origin);
    if (proposer === undefined || proposer.kind !== "write") {
      throw new WriteError(
        "internal",
        "a deletion opening an awaiting item for a revert or a revoke is not implemented",
        { reason: "not_implemented", kind: "awaiting_not_a_write" },
      );
    }
    const id = input.newId();
    const t: TrackedItem = {
      item: id as never,
      type: "awaiting_confirmation",
      unit: o.unit,
      candidates: 0,
      cands: [],
      mergeBase: 0 as never,
      refs: [],
      origin,
      versionOp: self as never,
      here: true,
      mergedHere: false,
      stored: {},
      reverted: [],
      fills: [],
    };
    withProposals(after, [t]);
    created.push({
      type: "item.created",
      slot: input.slot as never,
      blocks: {
        target: {
          item: id,
          type: "awaiting_confirmation",
          reason: o.reason,
          table: input.table,
          ...input.target,
          unit: unitOut(o.unit),
          origin_event: origin,
          ruleset_version: 1,
          policy_version: 1,
        },
        ...contentsOf(t),
      } as never,
    });
    opened.push({
      id,
      succeeds: o.succeeds,
      type: "awaiting_confirmation",
      origin,
      members: o.members,
    });
  }
  const supersededEvents: NewEvent[] = layer.superseded.map((item) => ({
    type: "item.superseded",
    slot: input.slot as never,
    blocks: { target: { item, reason: "deleted", by_event: self } } as never,
  }));
  // Refreshed: judge's (members leaving), and every other open item an entry of which is listed.
  const gone = new Set(layer.superseded);
  const refreshed = new Map(layer.refreshed.map((r) => [r.item, r]));
  for (const x of input.items.values()) {
    if (x.standing.kind !== "open" || gone.has(x.id) || refreshed.has(x.id)) continue;
    const t = tracked.get(x.id);
    const candidateListed = [...x.candidateAt].some(([k, seq]) =>
      input.listed.has(`${seq} candidates/${k}`),
    );
    // The entries as last given: listed when the block of one of them is, where it was last given
    // (an earlier block of the same path, given whole again since, is not an entry any more).
    const entryListed = Object.entries(t?.storedAt ?? {}).some(([p, seq]) =>
      input.listed.has(`${seq} ${p}`),
    );
    if (candidateListed || entryListed) {
      refreshed.set(x.id, { item: x.id, cause: "entries_deleted", left: [], back: [] });
    }
  }
  const refreshEvents: NewEvent[] = [];
  for (const r of [...refreshed.values()].sort((a, b) => (a.item < b.item ? -1 : 1))) {
    const x = input.items.get(r.item);
    const t = tracked.get(r.item);
    if (x === undefined || t === undefined) {
      throw new WriteError("internal", "a deletion refreshing an item the row does not hold", {
        reason: "inconsistent",
      });
    }
    const left = new Set(r.left);
    const dropped: number[] = [];
    const regiven: Record<string, unknown> = {};
    for (const [k, block] of [...x.candidates].sort(([a], [b]) => a - b)) {
      const event = (block as { event: number }).event;
      const keys = candidateTargets(block).map((g) => contributionKey(event, g));
      const again = candidateAfter(block, after);
      if (keys.every((key) => left.has(key)) || again === undefined) {
        dropped.push(k);
        continue;
      }
      const seq = x.candidateAt.get(k);
      const listedHere = seq !== undefined && input.listed.has(`${seq} candidates/${k}`);
      if (keys.some((key) => left.has(key)) || listedHere) regiven[`candidates/${k}`] = again;
    }
    // The item's members after: its candidates' or proposal's items on the state after.
    const remaining = new Set(
      [...x.candidates]
        .filter(([k]) => !dropped.includes(k))
        .flatMap(([, b]) =>
          candidateTargets(b).map((g) => contributionKey((b as { event: number }).event, g)),
        ),
    );
    const refs =
      x.type === "conflict"
        ? after.items
            .filter(
              (y) => y.status === "candidate" && remaining.has(contributionKey(y.event, y.target)),
            )
            .map(refOf)
        : t.refs;
    refreshEvents.push({
      type: "item.refreshed",
      slot: input.slot as never,
      blocks: {
        target: {
          item: r.item,
          cause: "entries_deleted",
          ...(dropped.length > 0 ? { dropped_candidates: dropped } : {}),
        },
        ...contentsOf({ ...t, refs }),
        ...regiven,
      } as never,
    });
  }
  return {
    events: [...created, ...supersededEvents, ...refreshEvents],
    superseded: [...layer.superseded],
    opened,
  };
}
