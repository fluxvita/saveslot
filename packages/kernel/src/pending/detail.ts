// An item's contents as the contract gives them (docs/zh-CN/spec/04-contract-types.md §4.8
// `ConflictDetail`, `AwaitingDetail`; 09-event-format.md §5.8): its latest entries read from the
// item events, and pure functions putting them in the contract's shapes. The pending read gives
// them whole; the write receipt gives the parts it shares (effective, by, previous, impact).
//
// The callers say how an operation's actor and an interval are written (`Naming`), so the same
// functions serve both.

import type { CandidateCause, FieldValue, Intent, ItemId } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";

export type Blocks = Readonly<Record<string, unknown>>;
export type Span = { readonly from: string | null; readonly to: string | null };

const spanIn = (v: unknown): Span => {
  const o = (v ?? {}) as { from?: string; to?: string };
  return { from: o.from ?? null, to: o.to ?? null };
};

/**
 * The item version as callers see it (04-contract §2 `item_ver`): item ID, the operation of its
 * latest content change, restore count. The write receipt writes the same.
 */
export const itemVer = (item: string, op: number, restoreCount: number) =>
  `iv_${item.slice(3)}.${op}.${restoreCount}`;

/** An item's latest entries (09 §5.8: each group given whole by the last event giving it). */
export interface ItemEntries {
  readonly id: string;
  readonly type: string;
  readonly reason: string;
  readonly table: string | null;
  readonly row: string | null;
  /** Field IDs, or `existence`. */
  readonly unit: readonly string[];
  readonly originEvent?: number;
  readonly relatedItem?: ItemId;
  readonly mergeBase?: number;
  readonly scope: readonly Span[];
  readonly current: readonly Blocks[];
  readonly previous: readonly Blocks[];
  readonly proposed: readonly Blocks[];
  readonly impact: readonly Blocks[];
  /** The candidates in effect, by index. */
  readonly candidates: ReadonlyMap<number, Blocks>;
  /** The operation and actor of each event the entries name. */
  readonly opOfEvent: ReadonlyMap<number, number>;
  readonly actorOfOp: ReadonlyMap<number, string>;
}

/** The groups each item event gives whole (09 §5.8: zero blocks of a group given, an empty group). */
const GIVES: Readonly<Record<string, readonly string[]>> = {
  "item.created": ["current", "previous", "impact", "proposed", "scope_valid"],
  "item.merged": ["previous", "impact", "scope_valid"],
  "item.refreshed": ["current", "previous", "impact", "proposed", "scope_valid"],
};

/** The entries of items as of operation `op` (all operations when not given). */
export async function itemEntries(
  tx: ReadTx,
  ids: readonly string[],
  op?: number,
): Promise<Map<string, ItemEntries>> {
  const out = new Map<string, ItemEntries>();
  if (ids.length === 0) return out;
  const r = await tx.query<{
    seq: unknown;
    type: string;
    path: string;
    body: string;
    item: string;
  }>(
    `SELECT e.seq, e.type, c.path, c.body, t.body::jsonb ->> 'item' AS item
     FROM events e JOIN content t ON t.seq = e.seq AND t.path = 'target' AND t.body IS NOT NULL
     JOIN content c ON c.seq = e.seq AND c.body IS NOT NULL
     WHERE e.type IN ('item.created', 'item.merged', 'item.refreshed')
       AND ($2::bigint IS NULL OR e.op <= $2)
       AND (t.body::jsonb ->> 'item') = ANY($1)
     ORDER BY e.seq, c.path`,
    [ids, op ?? null] as never,
  );
  const bySeq = new Map<number, { item: string; type: string; blocks: Record<string, unknown> }>();
  for (const x of r.rows) {
    const e = bySeq.get(Number(x.seq)) ?? {
      item: x.item,
      type: x.type,
      blocks: Object.create(null),
    };
    e.blocks[x.path] = JSON.parse(x.body);
    bySeq.set(Number(x.seq), e);
  }
  type Acc = {
    -readonly [K in keyof ItemEntries]: K extends "candidates"
      ? Map<number, Blocks>
      : ItemEntries[K];
  };
  const acc = new Map<string, Acc>();
  const events = new Set<number>();
  for (const [, e] of [...bySeq].sort(([a], [b]) => a - b)) {
    const t = e.blocks["target"] as Record<string, unknown>;
    let cur = acc.get(e.item);
    if (cur === undefined) {
      cur = {
        id: e.item,
        type: String(t["type"] ?? ""),
        reason: String(t["reason"] ?? ""),
        table: (t["table"] as string | undefined) ?? null,
        row: ((t["row"] ?? t["entity"]) as string | undefined) ?? null,
        unit: (t["unit"] as string[] | undefined) ?? [],
        ...(typeof t["origin_event"] === "number" ? { originEvent: t["origin_event"] } : {}),
        ...(typeof t["related_item"] === "string"
          ? { relatedItem: t["related_item"] as ItemId }
          : {}),
        scope: [],
        current: [],
        previous: [],
        proposed: [],
        impact: [],
        candidates: new Map(),
        opOfEvent: new Map(),
        actorOfOp: new Map(),
      };
      acc.set(e.item, cur);
    }
    const group = (g: string) =>
      Object.entries(e.blocks)
        .filter(([p]) => p.startsWith(`${g}/`))
        .sort(([a], [b]) => Number(a.split("/")[1]) - Number(b.split("/")[1]))
        .map(([, v]) => v as Blocks);
    const gives = GIVES[e.type] ?? [];
    // An item.merged giving `current` gives it whole; one without keeps the earlier.
    if (gives.includes("current") || (e.type === "item.merged" && group("current").length > 0))
      cur.current = group("current");
    if (gives.includes("previous")) cur.previous = group("previous");
    if (gives.includes("impact")) cur.impact = group("impact");
    if (gives.includes("proposed")) cur.proposed = group("proposed");
    if (gives.includes("scope_valid")) {
      const sv = e.blocks["scope_valid"] as { spans: unknown[] } | undefined;
      cur.scope = (sv?.spans ?? []).map(spanIn);
    }
    if (typeof t["merge_base_op"] === "number") cur.mergeBase = t["merge_base_op"];
    // Candidates: a refresh gives some again by index, keeping the others; dropped ones go.
    for (const [p, b] of Object.entries(e.blocks)) {
      const m = /^candidates\/(\d+)$/.exec(p);
      if (m !== null) cur.candidates.set(Number(m[1]), b as Blocks);
    }
    for (const k of (t["dropped_candidates"] ?? []) as number[]) cur.candidates.delete(k);
  }
  for (const x of acc.values()) {
    for (const b of [...x.current, ...x.impact, ...x.proposed, ...x.previous])
      for (const d of (b["deps"] ?? []) as { event: number }[]) events.add(d.event);
    for (const c of x.candidates.values()) events.add(c["event"] as number);
    if (x.originEvent !== undefined) events.add(x.originEvent);
  }
  const ev = await tx.query<{ seq: unknown; op: unknown }>(
    "SELECT seq, op FROM events WHERE seq = ANY($1)",
    [[...events]] as never,
  );
  const opOfEvent = new Map(ev.rows.map((x) => [Number(x.seq), Number(x.op)]));
  const ops = new Set<number>(opOfEvent.values());
  for (const x of acc.values())
    for (const b of [...x.current, ...x.impact])
      if (typeof b["op"] === "number") ops.add(b["op"] as number);
  const ac = await tx.query<{ seq: unknown; actor: string }>(
    "SELECT seq, actor FROM events WHERE seq = ANY($1)",
    [[...ops]] as never,
  );
  const actorOfOp = new Map(ac.rows.map((x) => [Number(x.seq), x.actor]));
  for (const x of acc.values()) out.set(x.id, { ...x, opOfEvent, actorOfOp });
  return out;
}

/** How a caller writes names, intervals and actors. */
/**
 * How a caller writes names, intervals, actors and values: `A` an actor, `V` a value, `I` an
 * interval as the caller's results give them.
 */
export interface Naming<A, V = unknown, I = Record<string, unknown>> {
  readonly field: (id: string) => string;
  readonly interval: (s: Span) => I;
  readonly actor: (principal: string) => A;
  /** A field value as the caller gives it (a zoned date-time as text, 04-contract-types §1.4). */
  readonly value: (v: FieldValue) => V;
  readonly isState: boolean;
}

const actorAt = <A, V, I>(e: ItemEntries, n: Naming<A, V, I>, op: number) =>
  n.actor(e.actorOfOp.get(op) ?? "");

/**
 * The writes an item's carrying out would take back or hide, from its `reverted_write` impact
 * entries: each operation, its writer and the fields it loses (their names; "*": existence). One
 * shape for an awaiting item's `impact.reverted`, a conflict item's `reverted_by_previous` and a
 * take_previous's receipt (04-contract-types §4.8, §5.2).
 */
export function revertedOut<A, V, I>(
  e: ItemEntries,
  n: Naming<A, V, I>,
  blocks: readonly Blocks[],
) {
  return blocks
    .filter((b) => b["kind"] === "reverted_write")
    .map((b) => ({
      seq: b["op"] as number,
      actor: actorAt(e, n, b["op"] as number),
      fields: [
        ...new Set(
          ((b["deps"] ?? []) as { field?: string }[]).map((d) =>
            d.field !== undefined ? n.field(d.field) : "*",
          ),
        ),
      ].sort(),
    }));
}

/** What carrying an item out would change (04-contract-types `AwaitingImpact`), from impact entries. */
export function impactOut<A, V, I>(e: ItemEntries, n: Naming<A, V, I>, blocks: readonly Blocks[]) {
  const segs = blocks.filter((b) => b["kind"] === "overwritten_segment");
  // A gap (a stretch without a value, `gap: true`) is filled (`filled_gaps`); a value, cleared to
  // null included, is overwritten (09 §5.8 `impact/<k>`).
  const overwritten = segs
    .filter((b) => b["gap"] !== true)
    .map((b) => ({
      field: n.field(b["field"] as string),
      ...(b["valid"] !== undefined ? { valid: n.interval(spanIn(b["valid"])) } : {}),
      value: n.value((b["value"] ?? null) as FieldValue),
      seq: b["op"] as number,
      actor: actorAt(e, n, b["op"] as number),
    }));
  // One gap per stretch and revoke: the entries are per field (a write of two fields over one gap
  // gives two), a filled gap is the stretch's (04-contract-types `AwaitingImpact.filled_gaps`).
  const gapKeys = new Set<string>();
  const filled = segs
    .filter((b) => b["gap"] === true)
    .filter((b) => {
      const key = JSON.stringify([b["valid"] ?? null, b["op"] ?? null]);
      if (gapKeys.has(key)) return false;
      gapKeys.add(key);
      return true;
    })
    .map((b) => ({
      ...(b["valid"] !== undefined ? { valid: n.interval(spanIn(b["valid"])) } : {}),
      ...(typeof b["op"] === "number" ? { revoked_by: b["op"] as number } : {}),
    }));
  const reverted = revertedOut(e, n, blocks);
  return {
    ...(overwritten.length > 0 ? { overwritten } : {}),
    ...(filled.length > 0 ? { filled_gaps: filled } : {}),
    ...(reverted.length > 0 ? { reverted } : {}),
  };
}

/** The impact entries of one candidate: the overwritten segments naming its write's event. */
export function candidateImpactBlocks(e: ItemEntries, event: number): Blocks[] {
  return e.impact.filter(
    (b) =>
      b["kind"] === "overwritten_segment" &&
      ((b["deps"] ?? []) as { event: number }[]).some((d) => d.event === event),
  );
}

const valuesOf = <A, V, I>(n: Naming<A, V, I>, blocks: readonly Blocks[]): Record<string, V> =>
  Object.fromEntries(
    blocks
      .filter((b) => b["field"] !== "existence")
      .map((b) => [n.field(b["field"] as string), n.value((b["value"] ?? null) as FieldValue)]),
  );

/** The candidates (`ConflictDetail.candidates`), by index. */
export function candidatesOut<A, V, I>(e: ItemEntries, n: Naming<A, V, I>) {
  return [...e.candidates]
    .sort(([a], [b]) => a - b)
    .map(([index, c]) => {
      const event = c["event"] as number;
      const op = e.opOfEvent.get(event) ?? event;
      const seen = c["seen"] as { op: number; restore_count: number };
      const items = (c["items"] ?? []) as { field?: string; value?: unknown; valid?: unknown }[];
      const valued = items.filter((x) => x.field !== undefined);
      const spans = items.filter((x) => x.valid !== undefined).map((x) => spanIn(x.valid));
      // The hull's start drops a null start. Not reached wrong: a field's items always have a
      // start (09 §1.2), and an existence item is the caller's revoke, its own interval or the
      // whole time `{}`, alone in the candidate, whose null start the fallback gives anyway. An
      // existence item open at the start among others would need this read as open.
      const from =
        spans
          .map((s) => s.from)
          .filter((x): x is string => x !== null)
          .sort()[0] ?? null;
      const to = spans.some((s) => s.to === null)
        ? null
        : (spans
            .map((s) => s.to as string)
            .sort()
            .at(-1) ?? null);
      return {
        index,
        seq: op,
        actor: actorAt(e, n, op),
        intent: c["intent"] as Intent,
        ver: `v${seen.op}.${seen.restore_count}`,
        ...(valued.length > 0
          ? {
              values: Object.fromEntries(
                valued.map((x) => [
                  n.field(x.field as string),
                  n.value((x.value ?? null) as FieldValue),
                ]),
              ) as Record<string, V>,
            }
          : {}),
        ...(n.isState && spans.length > 0 ? { valid: n.interval({ from, to }) } : {}),
        cause: c["cause"] as CandidateCause,
      };
    });
}

/** The proposed side of an awaiting item (`AwaitingDetail.proposal`, without `seq`, `actor`, `intent`). */
export function proposalOut<A, V, I>(e: ItemEntries, n: Naming<A, V, I>) {
  const existence = e.unit.includes("existence");
  const spans = e.proposed.filter((b) => b["valid"] !== undefined).map((b) => spanIn(b["valid"]));
  // As above: a proposed entry is a field's, which always has a start (09 §1.2).
  const from =
    spans
      .map((s) => s.from)
      .filter((x): x is string => x !== null)
      .sort()[0] ?? null;
  const to = spans.some((s) => s.to === null)
    ? null
    : (spans
        .map((s) => s.to as string)
        .sort()
        .at(-1) ?? null);
  return {
    ...(e.proposed.length > 0 ? { set: existence ? null : valuesOf(n, e.proposed) } : {}),
    ...(n.isState && spans.length > 0 ? { valid: n.interval({ from, to }) } : {}),
  };
}

/** The item's target (`ItemTarget`): the unit's field names ("*" for existence) and its spans. */
export function targetOut<A, V, I>(e: ItemEntries, n: Naming<A, V, I>) {
  return {
    unit: e.unit.map((f) => (f === "existence" ? "*" : n.field(f))),
    ...(n.isState && e.scope.length > 0 ? { spans: e.scope.map((s) => n.interval(s)) } : {}),
  };
}
