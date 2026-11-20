// The state of one row or entity as `judge` reads it: items, values, change points and blocking
// points as of a position in the log (docs/zh-CN/spec/03-data-model/05-time.md «状态类表的状态»,
// «写状态：参数与默认»; 03-deletion «重放规则» «行 / 实体的存在»).
//
// Items are never removed: the state as of an earlier position is the items written up to it.

import type {
  BizPoint,
  FieldId,
  FieldValue,
  OpNumber,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import { valueText } from "../delta/index.ts";
import { givenEnds } from "../time/given-ends.ts";
import {
  bounds,
  canonical,
  cut,
  cutPoints,
  holds,
  type Interval,
  type IntervalSet,
  meet,
  startOf,
  WHOLE,
  within,
} from "../time/index.ts";
import type {
  ItemContent,
  ItemRef,
  ItemStatus,
  OpRecord,
  TableShape,
  Target,
  Unit,
} from "./model.ts";

/** An item with what the judgements read from the raw parameters of its write. */
export interface Item {
  readonly event: Seq;
  readonly target: Target;
  readonly k: number;
  readonly op: OpNumber;
  readonly index: number;
  readonly status: ItemStatus;
  readonly valid: IntervalSet;
  readonly content: ItemContent;
  readonly carried?: readonly ItemRef[];
  readonly deps: readonly ItemRef[];
  /** A field candidate in an item whose unit is existence. */
  readonly onExistence?: true;
  /**
   * The start and explicit end the caller gave that lie on the item's interval: its
   * corroboration endpoints when it is a corroboration (09 §5.7).
   */
  readonly explicitEnds: readonly BizPoint[];
  /**
   * Written with a default end: the conflict criterion's "默认终点". The changed part of a stale
   * corroboration written to the next change is one too: it is judged as the write was written
   * (05-time «用同样的值写»), merged or a candidate like any write.
   */
  readonly defaultEnd: boolean;
}

/**
 * A position in the log: everything up to operation `upTo`, plus the ops of request `request.op`
 * before index `request.below` (the earlier ops of the request being judged).
 */
export interface Limit {
  readonly upTo: OpNumber;
  readonly request?: { readonly op: OpNumber; readonly below: number };
}

export const EVERYTHING: Limit = { upTo: Number.MAX_SAFE_INTEGER };

export const refOf = (x: { event: Seq; target: Target; k: number }): ItemRef => ({
  event: x.event,
  target: x.target,
  k: x.k,
});

export const refKey = (r: ItemRef): string => `${r.event}/${r.target}/${r.k}`;

export const effective = (s: ItemStatus): boolean => s === "applied" || s === "corroborated";

/** A field's state on a stretch, as a token comparable for equality. */
export const NO_VALUE = "no_value";
export const valueToken = (v: FieldValue): string => `v:${valueText(v)}`;

export type FieldState =
  | { readonly kind: "value"; readonly value: FieldValue; readonly by: Item }
  | { readonly kind: "none" }
  | { readonly kind: "hole"; readonly by: Item };

function itemsOf(records: readonly OpRecord[]): Item[] {
  const out: Item[] = [];
  for (const r of records) {
    if (r.kind === "reject" || r.kind === "keep_effective") continue;
    // A confirmation executes the awaiting write as proposed: for the conflict criterion its
    // items are written the way that write was (a default end or not). Write-backs of reverts
    // have no raw interval: no explicit ends, no default end.
    const written = r.kind === "write" || r.kind === "revoke";
    const proposal =
      r.kind === "confirm"
        ? records.find((y) => y.event === r.target && (y.kind === "write" || y.kind === "revoke"))
        : written
          ? r
          : undefined;
    const raw =
      proposal?.kind === "write" || proposal?.kind === "revoke" ? proposal.valid : undefined;
    const ends = r.kind === "write" || r.kind === "revoke" ? givenEnds(raw, r.now) : [];
    const nextChange =
      proposal !== undefined &&
      (raw === undefined || (raw !== "corrected_span" && raw.to.mode === "next_change"));
    for (const x of r.items) {
      out.push({
        event: r.event,
        target: x.target,
        k: x.k,
        op: r.op,
        index: r.index,
        status: x.status,
        valid: x.valid,
        content: x.content,
        ...(x.carried !== undefined ? { carried: x.carried } : {}),
        deps: x.deps,
        ...(x.onExistence ? { onExistence: true as const } : {}),
        explicitEnds: ends.filter((p) => bounds(x.valid, p)),
        defaultEnd: nextChange && x.target !== "existence",
      });
    }
  }
  return out;
}

/** "Registered as reverted by operation `op` on `valid`" (03-deletion «回掉的权威定义» step 5). */
export interface Registration {
  readonly op: OpNumber;
  readonly index: number;
  readonly valid: IntervalSet;
}

/** Step 3, "x 取代 r". */
export function supersedes(x: Item, r: Item): boolean {
  const xIsFieldValue = x.target !== "existence" && x.content.kind === "value";
  if (r.content.kind === "revoke") return x.content.kind === "restore" || xIsFieldValue;
  if (r.content.kind === "restore") return x.content.kind === "revoke";
  return (x.target === r.target && x.content.kind !== "uncovered") || x.content.kind === "revoke";
}

const etKey = (event: Seq, target: Target) => `${event}/${target}`;

/**
 * The registrations a revert in effect makes, from what its record holds (09 §5.7 `revert`, the
 * `apply` row): each item in effect of an entry is registered on its interval ∩ the union of the
 * revert's write-back intervals on its target; an item of an entry marked `later` only within
 * D(x), the items in effect of the undone operation's entries it supersedes.
 */
export function registrationsOf(
  items: readonly Item[],
  revert: {
    op: OpNumber;
    index: number;
    entries: readonly { event: Seq; target: Target; later?: true }[];
  },
  writeBacks: readonly Item[],
): { item: Item; reg: Registration }[] {
  const entries = new Map(revert.entries.map((e) => [etKey(e.event, e.target), e]));
  const before = (x: Item) => x.op < revert.op || (x.op === revert.op && x.index < revert.index);
  const inEffect = items.filter(
    (x) => entries.has(etKey(x.event, x.target)) && before(x) && effective(x.status),
  );
  const isLater = (x: Item) => entries.get(etKey(x.event, x.target))?.later === true;
  const out: { item: Item; reg: Registration }[] = [];
  for (const x of inEffect) {
    const t = canonical(writeBacks.filter((w) => w.target === x.target).flatMap((w) => w.valid));
    const domain = isLater(x)
      ? canonical(inEffect.filter((y) => !isLater(y) && supersedes(x, y)).flatMap((y) => y.valid))
      : [WHOLE];
    const valid = meet(meet(x.valid, t), domain);
    if (valid.length > 0) out.push({ item: x, reg: { op: revert.op, index: revert.index, valid } });
  }
  return out;
}

/** Orders items by when they were written: operation, place in the request, event. */
export function later(a: Item, b: Item): boolean {
  if (a.op !== b.op) return a.op > b.op;
  if (a.index !== b.index) return a.index > b.index;
  return a.event > b.event;
}

export class RowState {
  readonly table: TableShape;
  readonly records: readonly OpRecord[];
  readonly items: readonly Item[];
  readonly isState: boolean;
  /** Each field's conflict unit. */
  readonly unitOf: ReadonlyMap<FieldId, readonly FieldId[]>;

  /** Items not in the records: a tentative judgement being tried. */
  private readonly extra: readonly Item[];

  /** Registrations of reverts in effect, by item (refKey). */
  readonly regs: ReadonlyMap<string, readonly Registration[]>;
  /** Registrations of a tentative judgement being tried. */
  private readonly extraRegs: readonly { item: Item; reg: Registration }[];

  constructor(
    table: TableShape,
    records: readonly OpRecord[],
    extra: readonly Item[] = [],
    extraRegs: readonly { item: Item; reg: Registration }[] = [],
  ) {
    this.table = table;
    this.records = records;
    this.extra = extra;
    this.extraRegs = extraRegs;
    this.items = [...itemsOf(records), ...extra];
    const regs = new Map<string, Registration[]>();
    const add = (x: { item: Item; reg: Registration }) =>
      regs.set(refKey(x.item), [...(regs.get(refKey(x.item)) ?? []), x.reg]);
    for (const r of records) {
      const revert =
        (r.kind === "undo" || r.kind === "take_previous") && r.status === "applied"
          ? r.revert
          : r.kind === "confirm"
            ? r.revert
            : undefined;
      if (revert === undefined) continue;
      const writeBacks = this.items.filter((x) => x.op === r.op && x.event === r.event);
      for (const x of registrationsOf(
        this.items,
        { op: r.op, index: r.index, entries: revert.entries },
        writeBacks,
      )) {
        add(x);
      }
    }
    for (const x of extraRegs) add(x);
    this.regs = regs;
    this.isState = table.kind === "state";
    const units = new Map<FieldId, readonly FieldId[]>();
    for (const g of table.groups) for (const f of g) units.set(f, [...g].sort());
    for (const f of table.fields) if (!units.has(f)) units.set(f, [f]);
    this.unitOf = units;
  }

  /** The same state with `extra` items written (a tentative judgement), and their registrations. */
  with(extra: readonly Item[], regs: readonly { item: Item; reg: Registration }[] = []): RowState {
    return new RowState(
      this.table,
      this.records,
      [...this.extra, ...extra],
      [...this.extraRegs, ...regs],
    );
  }

  sees(x: Item, at: Limit): boolean {
    if (x.op <= at.upTo) return true;
    return at.request !== undefined && x.op === at.request.op && x.index < at.request.below;
  }

  unitKey(u: Unit): string {
    return u === "existence" ? "existence" : [...u.fields].sort().join(",");
  }

  /** The pieces of the timeline on which every item, and `extra`, is constant. */
  pieces(extra: readonly IntervalSet[] = []): Interval[] {
    if (!this.isState) return [WHOLE];
    return cut(cutPoints([...extra, ...this.items.map((x) => x.valid)]));
  }

  /** The pieces lying inside `a`. */
  piecesIn(a: IntervalSet): Interval[] {
    return this.pieces([a]).filter((s) => within(s, a));
  }

  /**
   * A field on a piece: the last item in effect covering it among the field's value items and the
   * revokes (03-deletion «重放规则», the value of a field).
   */
  fieldState(f: FieldId, seg: Interval, at: Limit): FieldState {
    // Write-backs that only register (`uncovered`) give nothing and cover nothing; restores only
    // cancel revokes, which the same revert registers (03-deletion «回掉的权威定义» step 6).
    let best: Item | undefined;
    for (const x of this.items) {
      if (x.status !== "applied" || !this.sees(x, at) || !within(seg, x.valid)) continue;
      const counts =
        (x.target === f && (x.content.kind === "value" || x.content.kind === "no_value")) ||
        x.content.kind === "revoke";
      if (!counts || this.registeredOn(x, seg, at)) continue;
      if (x.content.kind === "revoke" && this.restoredSince(x, seg, at)) continue;
      if (best === undefined || later(x, best)) best = x;
    }
    if (best === undefined) return { kind: "none" };
    if (best.content.kind === "revoke") return { kind: "hole", by: best };
    if (best.content.kind === "value")
      return { kind: "value", value: best.content.value, by: best };
    return { kind: "none" };
  }

  /** Registrations of an item visible at `at`. */
  registrations(x: Item, at: Limit): Registration[] {
    return (this.regs.get(refKey(x)) ?? []).filter(
      (r) =>
        r.op <= at.upTo ||
        (at.request !== undefined && r.op === at.request.op && r.index < at.request.below),
    );
  }

  /** Whether the item is registered as reverted on the whole piece, as of `at`. */
  registeredOn(x: Item, seg: Interval, at: Limit): boolean {
    return this.registrations(x, at).some((r) => within(seg, r.valid));
  }

  /** Whether a registration of the item reaches point `p`, its ends included. */
  registeredAtEnd(x: Item, p: BizPoint, at: Limit): boolean {
    return this.registrations(x, at).some((r) =>
      r.valid.some((v) => (v.from === null || v.from <= p) && (v.to === null || p <= v.to)),
    );
  }

  /** Where the item is registered as reverted, as of `at`. */
  registeredSet(x: Item, at: Limit): IntervalSet {
    return canonical(this.registrations(x, at).flatMap((r) => r.valid));
  }

  /** State tables: a point has a value when every required field has one (05-time «无值区间»). */
  hasValue(seg: Interval, at: Limit): boolean {
    const req = this.table.valued;
    if (req.length > 0) return req.every((f) => this.fieldState(f, seg, at).kind === "value");
    return this.table.fields.some((f) => this.fieldState(f, seg, at).kind === "value");
  }

  /**
   * A field's value as the judgements compare it, which is also its result as a reader sees it
   * (the impact compares these, judge/result.ts). State tables: the value, or "no value" wherever
   * the entity has none, whether a revoke or a gap leaves it so (05-time «状态类表上的撤销»: a
   * revoke is a write of "no value here", with no revoked state of its own; reads give the two the
   * same), so a revoke on a state table is never a result of its own. Event and timeless tables:
   * the value, or "hole" where the row is revoked, a state of the row.
   */
  token(f: FieldId, seg: Interval, at: Limit): string {
    if (this.isState && !this.hasValue(seg, at)) return NO_VALUE;
    const s = this.fieldState(f, seg, at);
    // Where the entity has a value, a field the filling writes did not give is empty, not a hole
    // (05-time «无值区间»: 可选字段不带就是空).
    if (this.isState && s.kind === "hole") return "none";
    return s.kind === "value" ? valueToken(s.value) : s.kind;
  }

  /** Value change points of a field, value ↔ no value included (05-time «状态类表的状态»). */
  changePoints(f: FieldId, at: Limit): BizPoint[] {
    const segs = this.pieces();
    const out: BizPoint[] = [];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1] as Interval;
      const b = segs[i] as Interval;
      if (b.from !== null && this.token(f, a, at) !== this.token(f, b, at)) out.push(b.from);
    }
    return out;
  }

  /**
   * The change points high impact ① protects (05-time «高影响写入»): a value ↔ no value boundary
   * counts only on the fields that define "has a value" (the required ones; every field when none
   * is required); other fields are compared only between points where the entity has a value.
   */
  impactPoints(f: FieldId, at: Limit): BizPoint[] {
    const defines = this.defines(f);
    const segs = this.pieces();
    const out: BizPoint[] = [];
    for (let i = 1; i < segs.length; i++) {
      const a = this.token(f, segs[i - 1] as Interval, at);
      const b = this.token(f, segs[i] as Interval, at);
      const from = (segs[i] as Interval).from;
      if (from === null || a === b) continue;
      if (!defines && (a === NO_VALUE || b === NO_VALUE)) continue;
      out.push(from);
    }
    return out;
  }

  /**
   * Corroboration endpoints of a field that still count: not covered over by a later item in
   * effect on the field or a revoke (05-time «用同样的值写»).
   */
  corroborationEnds(f: FieldId, at: Limit): BizPoint[] {
    const out: BizPoint[] = [];
    for (const c of this.items) {
      if (c.status !== "corroborated" || c.target !== f || !this.sees(c, at)) continue;
      for (const p of c.explicitEnds) {
        // Reverted by an undo or take_previous: the endpoint no longer counts. An end endpoint
        // belongs to the stretch just before it, so the registration is read as closed here.
        if (this.registeredAtEnd(c, p, at)) continue;
        const coveredOver = this.items.some(
          (x) =>
            x.status === "applied" &&
            this.sees(x, at) &&
            later(x, c) &&
            ((x.target === f && x.content.kind !== "uncovered") || x.content.kind === "revoke") &&
            holds(x.valid, p) &&
            !holds(this.registeredSet(x, at), p),
        );
        if (!coveredOver) out.push(p);
      }
    }
    return out;
  }

  /** Blocking points of a field, or of any field (05-time «状态类表的状态»). */
  blockingPoints(f: FieldId | "any", at: Limit): BizPoint[] {
    const fs = f === "any" ? this.table.fields : [f];
    const ps = new Set<BizPoint>();
    for (const g of fs) {
      for (const p of this.changePoints(g, at)) ps.add(p);
      for (const p of this.corroborationEnds(g, at)) ps.add(p);
    }
    return [...ps].sort();
  }

  /**
   * The contributions giving a blocking point (05-time «给出挡点的贡献»): every item in effect up
   * to `at` on the field (any field for "any") or on existence whose interval has the point as an
   * end, both sides, covered or not.
   */
  givers(p: BizPoint, f: FieldId | "any", at: Limit): ItemRef[] {
    // At a value ↔ no value boundary the items of the fields defining "has a value" give it too.
    const boundary = this.isState && this.hasValueBoundary(p, at);
    return this.items
      .filter(
        (x) =>
          effective(x.status) &&
          this.sees(x, at) &&
          (f === "any" ||
            x.target === f ||
            x.target === "existence" ||
            (boundary && this.defines(x.target))) &&
          bounds(x.valid, p),
      )
      .map(refOf);
  }

  /** Whether `f` is one of the fields that define "has a value" (every field when none is). */
  defines(f: FieldId | "existence"): boolean {
    if (f === "existence") return false;
    return this.table.valued.length === 0 || this.table.valued.includes(f);
  }

  /** Whether the entity has a value on one side of `p` and none on the other. */
  hasValueBoundary(p: BizPoint, at: Limit): boolean {
    const segs = this.pieces([[{ from: p, to: null }]]);
    const i = segs.findIndex((s) => s.from === p);
    const before = segs[i - 1];
    const after = segs[i];
    if (before === undefined || after === undefined) return false;
    return this.hasValue(before, at) !== this.hasValue(after, at);
  }

  /** Event and timeless tables: the row has a revoke in effect. */
  revoked(at: Limit): boolean {
    return this.revokedBy(at).length > 0;
  }

  /** Event and timeless tables: the operations whose revokes are in effect. */
  revokedBy(at: Limit): OpNumber[] {
    const live = (x: Item) =>
      x.status === "applied" &&
      x.content.kind === "revoke" &&
      this.sees(x, at) &&
      !this.registeredOn(x, WHOLE, at) &&
      !this.restoredSince(x, WHOLE, at);
    // A revoke a take_candidate wrote later supersedes an earlier one (as in an undo's range):
    // the revoke to undo first is the later one, so the earlier one is not listed.
    const takenLater = (x: Item) =>
      this.items.some(
        (y) =>
          y.op > x.op &&
          live(y) &&
          this.records.some((o) => o.kind === "take_candidate" && o.event === y.event),
      );
    // A revoke a revert wrote back (an undo, a take_previous, a confirmed undo) is "back to before
    // that operation": undoing it redoes what it took back, not the way to bring the row back. It
    // is listed only when no other revoke is in effect.
    const writtenBack = (x: Item) =>
      this.records.some(
        (o) =>
          o.event === x.event &&
          (o.kind === "undo" ||
            o.kind === "take_previous" ||
            (o.kind === "confirm" && o.revert !== undefined)),
      );
    const all = this.items.filter((x) => live(x) && !takenLater(x));
    const own = all.filter((x) => !writtenBack(x));
    return (own.length > 0 ? own : all).map((x) => x.op);
  }

  /**
   * Event and timeless tables: a restore in effect, not registered as reverted, after revoke `r`
   * covers the piece, so `r` no longer counts (03-deletion «重放规则», the value of a field). Any
   * restore does: a take_candidate's, which registers no revoke, or a revert's over a revoke the
   * revert did not register. State tables: never (a take there writes no restore).
   */
  restoredSince(r: Item, seg: Interval, at: Limit): boolean {
    if (this.isState) return false;
    return this.items.some(
      (y) =>
        y.content.kind === "restore" &&
        y.status === "applied" &&
        later(y, r) &&
        this.sees(y, at) &&
        within(seg, y.valid) &&
        !this.registeredOn(y, seg, at),
    );
  }

  /** Operations after `seen` and before `n` (other requests) with an item in effect. */
  opsBetween(seen: OpNumber, n: OpNumber): OpNumber[] {
    const ops = new Set<OpNumber>();
    for (const x of this.items)
      if (x.op > seen && x.op < n && x.status === "applied") ops.add(x.op);
    return [...ops].sort((a, b) => a - b);
  }

  /** Where operation `m` changed field `f` (state tables), or whether it did (others: WHOLE). */
  changedBy(m: OpNumber, f: FieldId): IntervalSet {
    const before: Limit = { upTo: m - 1 };
    const after: Limit = { upTo: m };
    return canonical(
      this.pieces().filter((s) => this.token(f, s, before) !== this.token(f, s, after)),
    );
  }

  /** Records of keep-effective decisions and confirmations: which pending items are closed. */
  closedCandidate(event: Seq, target: Target): boolean {
    return this.records.some((r) => {
      const item =
        r.kind === "keep_effective" || r.kind === "take_candidate"
          ? { unit: r.unit, candidates: r.candidates }
          : r.kind === "take_previous"
            ? { unit: r.revert.unit, candidates: r.revert.candidates ?? [] }
            : undefined;
      if (item === undefined || item.unit === undefined || !item.candidates.includes(event)) {
        return false;
      }
      return this.inUnit({ event, target }, item.unit);
    });
  }

  /**
   * Whether the candidates of (event, target) belong to an item on `unit`: existence takes the
   * revoke and the field candidates that met a revoke; a field unit the others on its fields.
   */
  inUnit(x: { event: Seq; target: Target }, unit: Unit): boolean {
    const onExistence =
      x.target === "existence" ||
      this.items.some(
        (y) => y.event === x.event && y.target === x.target && y.onExistence === true,
      );
    return unit === "existence"
      ? onExistence
      : !onExistence && x.target !== "existence" && unit.fields.includes(x.target);
  }

  resolvedAwaiting(event: Seq): boolean {
    return this.records.some(
      (r) => (r.kind === "confirm" || r.kind === "reject") && r.target === event,
    );
  }

  /** Where the items of a set lie, as one set. */
  span(xs: readonly Item[]): IntervalSet {
    return canonical(xs.flatMap((x) => x.valid));
  }

  /** The start of a set (the earliest point), or null. */
  start(a: IntervalSet): BizPoint | null {
    return startOf(a);
  }

  meet(a: IntervalSet, b: IntervalSet): IntervalSet {
    return meet(a, b);
  }
}
