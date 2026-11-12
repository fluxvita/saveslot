// The reference evaluator: replay of one row or entity under a set of deleted source data.
//
// Written as the most literal implementation of the definition (03-deletion «删除结果的定义»):
// the state after a privacy deletion is the state obtained by replaying the log by operation
// number as if the deleted source data had never existed, with two deviations — people's
// decisions are executed as recorded, and writes that were already in effect stay in effect.
// Reverting (`undo`, `take_previous`) follows the pseudocode in 03-deletion «回掉的权威定义»
// step by step. Nothing here imports the kernel (02-architecture §11 «测试矩阵»).
//
// The log of a row or entity is walked in order: operations, deletion confirmations and
// cancellations (`evaluateLog`). Each operation is judged when it enters the log, on the state
// with the deletions confirmed and not cancelled by then; that judgement is what the log records.
// Each deletion event replays the whole log with the deleted set it leaves and keeps from the
// record only what the definition keeps: revert records R and merge bases (03-deletion «回掉»
// ①、③), the write-time statuses deviation two protects ("already in effect" = in effect at
// write time or by a person's decision, corroborations included; not a write that took effect
// only through a deletion's recomputation), the fields judged no-op, and the item indices as last
// given (step 6). A cancellation also keeps what the grace period settled (03-deletion «撤回与
// 宽限期»): writes taken as a baseline stay in effect, items a grace-period write changed stay
// superseded, candidates put back after their item was resolved are judged at that point.

import {
  canonicalize,
  type FieldId,
  type FieldValue,
  type JcsValue,
  type OpNumber,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import {
  ALL,
  containsPoint,
  covers,
  elementarySegments,
  endpoints,
  type Iv,
  type IvSet,
  intersect,
  isEmpty,
  normalize,
  type Point,
  pieces,
  subtract,
  union,
} from "./interval.ts";
import type {
  ConfirmOp,
  Evaluation,
  FieldInput,
  FieldSegment,
  ItemContent,
  ItemRef,
  ItemResult,
  LogEntry,
  LogEvaluation,
  LogStep,
  Op,
  Registration,
  ResolveOp,
  RevertResult,
  RevokeOp,
  SourceKey,
  TableSchema,
  UndoOp,
  ValidParam,
  WriteOp,
} from "./model.ts";

type Target = FieldId | "existence";
type Status = "applied" | "corroborated" | "candidate" | "awaiting";

interface Item {
  readonly event: Seq;
  readonly target: Target;
  k: number;
  readonly op: OpNumber;
  status: Status;
  readonly valid: IvSet;
  readonly content: ItemContent;
  readonly carried?: readonly ItemRef[];
  /** Start and explicit end the caller gave: candidate corroboration endpoints (05-time «挡点»). */
  readonly explicitEnds: readonly Point[];
  /** Resolved with a default end (`next_change`), and its start: for the conflict criterion. */
  readonly defaultEnd: boolean;
  readonly from: Point | null;
}

/**
 * What a replay keeps from the log as written: the judgement each operation got at its own point
 * in the log (with the deletions confirmed and not cancelled by then), and what deletion events
 * recorded. Operations not in `judged` are judged afresh by the replay.
 */
interface Recorded {
  readonly judged: Set<OpNumber>;
  /** Item statuses and intervals at write time: what deviation two protects; original indices. */
  readonly writeTime: Map<string, { k: number; valid: IvSet; status: Status }[]>;
  /** Item intervals as last given (by the write or a later deletion event): for indices. */
  readonly latest: Map<string, { k: number; valid: IvSet }[]>;
  readonly revertRecords: Map<OpNumber, ItemRef[]>;
  readonly revertStatus: Map<OpNumber, RevertResult["status"]>;
  readonly mergeBases: Map<OpNumber, { mergeBase: OpNumber; k: ItemRef[] }>;
  /** (event, field) judged a no-op at write time: stays a no-op in every replay. */
  readonly noops: Set<string>;
  /** (event, target) a cancellation kept in effect (`kept_effective`). */
  readonly keptEffective: Set<string>;
  /** Events whose pending items a cancellation kept superseded (`kept_superseded`). */
  readonly keptSuperseded: Set<Seq>;
  /** Candidates put back by a cancellation after their item was resolved, judged at that point. */
  readonly rejudged: Map<string, "dropped" | "corroborated" | "candidate">;
  /** Deletion confirmations and cancellations, with where they changed each field's value. */
  readonly external: { op: OpNumber; changed: Map<FieldId, IvSet>; changedEntity: boolean }[];
}

function emptyRecorded(): Recorded {
  return {
    judged: new Set(),
    writeTime: new Map(),
    latest: new Map(),
    revertRecords: new Map(),
    revertStatus: new Map(),
    mergeBases: new Map(),
    noops: new Set(),
    keptEffective: new Set(),
    keptSuperseded: new Set(),
    rejudged: new Map(),
    external: [],
  };
}

const INF = Number.MAX_SAFE_INTEGER;
const NO_VALUE = "novalue";

const refKey = (r: { event: Seq; target: Target; k: number }) => `${r.event}/${r.target}/${r.k}`;
const etKey = (event: Seq, target: Target) => `${event}/${target}`;
const refOf = (it: Item): ItemRef => ({ event: it.event, target: it.target, k: it.k });
const tok = (v: FieldValue) => `v:${canonicalize(v as JcsValue)}`;
const effective = (s: Status) => s === "applied" || s === "corroborated";

type FieldState =
  | { kind: "value"; value: FieldValue; by: Item }
  | { kind: "none" }
  | { kind: "hole"; by: Item };

function stateTok(s: FieldState): string {
  if (s.kind === "value") return tok(s.value);
  return s.kind;
}

class Replay {
  readonly items: Item[] = [];
  /** Same-valued contributions that are no longer items, kept for the domain of step 2. */
  readonly shadows: Item[] = [];
  readonly regs = new Map<string, Registration[]>();
  readonly reverts: RevertResult[] = [];
  readonly revertRecords = new Map<OpNumber, ItemRef[]>();
  readonly revertStatus = new Map<OpNumber, RevertResult["status"]>();
  readonly mergeBases = new Map<OpNumber, { mergeBase: OpNumber; k: ItemRef[] }>();
  readonly noops = new Set<string>();
  readonly fieldIds: FieldId[];
  readonly closedCandidates: Set<Seq>;
  readonly resolvedAwaiting: Set<Seq>;
  readonly opsByEvent: Map<Seq, Op>;

  readonly schema: TableSchema;
  readonly ops: readonly Op[];
  readonly deleted: ReadonlySet<SourceKey>;
  readonly rec: Recorded;

  constructor(
    schema: TableSchema,
    ops: readonly Op[],
    deleted: ReadonlySet<SourceKey>,
    rec: Recorded,
  ) {
    this.schema = schema;
    this.ops = ops;
    this.deleted = deleted;
    this.rec = rec;
    const ids = new Set<FieldId>(schema.required);
    for (const o of ops) {
      if (o.kind === "write") for (const f of Object.keys(o.fields)) ids.add(f as FieldId);
    }
    this.fieldIds = [...ids].sort();
    // People's decisions are executed as recorded (03-deletion «两条原则», deviation one): a
    // candidate whose item a person resolved stays closed, an awaiting write a person confirmed
    // or rejected is not re-judged.
    this.closedCandidates = new Set([
      ...ops.flatMap((o) => (o.kind === "resolve" ? o.candidates : [])),
      ...rec.keptSuperseded,
    ]);
    this.resolvedAwaiting = new Set([
      ...ops.flatMap((o) => (o.kind === "confirm" || o.kind === "reject" ? [o.target] : [])),
      ...rec.keptSuperseded,
    ]);
    this.opsByEvent = new Map(ops.map((o) => [o.event, o]));
  }

  get isState(): boolean {
    return this.schema.kind === "state";
  }

  isDeleted(sources: readonly SourceKey[]): boolean {
    return sources.some((s) => this.deleted.has(s));
  }

  // -------------------------------------------------------------------------------------------
  // State reads. `limit` is an operation number: only contributions and registrations made by
  // operations up to it count ("the state as of operation `limit`").

  segments(extra: readonly IvSet[] = []): Iv[] {
    const sets: IvSet[] = [...extra];
    for (const it of this.items) sets.push(it.valid);
    for (const rs of this.regs.values()) for (const r of rs) sets.push(r.valid);
    return this.isState ? elementarySegments(endpoints(sets)) : [ALL];
  }

  registeredOn(it: Item, seg: Iv, limit: number): boolean {
    return (this.regs.get(refKey(it)) ?? []).some((r) => r.byOp <= limit && covers(r.valid, seg));
  }

  registeredAtPoint(it: Item, p: Point, limit: number): boolean {
    return (this.regs.get(refKey(it)) ?? []).some(
      (r) => r.byOp <= limit && containsPoint(r.valid, p),
    );
  }

  /** Whether a registration of the item reaches point `p`, its ends included. */
  registeredAtEnd(it: Item, p: Point, limit: number): boolean {
    return (this.regs.get(refKey(it)) ?? []).some(
      (r) =>
        r.byOp <= limit &&
        r.valid.some((x) => (x.from === null || x.from <= p) && (x.to === null || p <= x.to)),
    );
  }

  registeredSet(it: Item, beforeOp: number): IvSet {
    return union(
      ...(this.regs.get(refKey(it)) ?? []).filter((r) => r.byOp < beforeOp).map((r) => r.valid),
    );
  }

  /**
   * The field at a segment: the last item in effect, not registered as reverted there, among the
   * field's items and the revokes (03-deletion «回掉的权威定义» step 6, the ordinary rule).
   * `uncovered` write-backs give nothing and cover nothing; restores only cancel revokes, which
   * the same revert registers, so they play no part here.
   */
  fieldState(f: FieldId, seg: Iv, limit: number): FieldState {
    let best: Item | undefined;
    for (const it of this.items) {
      if (it.op > limit || it.status !== "applied" || !covers(it.valid, seg)) continue;
      const isField =
        it.target === f && (it.content.kind === "value" || it.content.kind === "noValue");
      if (!isField && it.content.kind !== "revoke") continue;
      if (this.registeredOn(it, seg, limit)) continue;
      if (best === undefined || it.op > best.op || (it.op === best.op && it.event > best.event)) {
        best = it;
      }
    }
    if (best === undefined) return { kind: "none" };
    if (best.content.kind === "revoke") return { kind: "hole", by: best };
    if (best.content.kind === "value")
      return { kind: "value", value: best.content.value, by: best };
    return { kind: "none" };
  }

  /** State tables: a point has a value when every required field has one (05-time «无值区间»). */
  hasValue(seg: Iv, limit: number): boolean {
    const req = this.schema.required.length > 0 ? this.schema.required : this.fieldIds;
    const states = req.map((f) => this.fieldState(f, seg, limit).kind);
    return this.schema.required.length > 0
      ? states.every((k) => k === "value")
      : states.some((k) => k === "value");
  }

  /** The value of `f` as the judgements see it: "no value" wherever the entity has none. */
  vis(f: FieldId, seg: Iv, limit: number): string {
    if (this.isState && !this.hasValue(seg, limit)) return NO_VALUE;
    return stateTok(this.fieldState(f, seg, limit));
  }

  /** Value change points of `f`, including value ↔ no value (05-time «挡点»). */
  valueChangePoints(f: FieldId, limit: number): Point[] {
    const segs = this.segments();
    const out: Point[] = [];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1];
      const b = segs[i];
      if (a === undefined || b === undefined || b.from === null) continue;
      if (this.vis(f, a, limit) !== this.vis(f, b, limit)) out.push(b.from);
    }
    return out;
  }

  /**
   * Corroboration endpoints of `f` that still count: not covered over by a later write in
   * effect, not reverted (05-time «挡点»).
   */
  corroborationEndpoints(f: FieldId, limit: number): Point[] {
    const out: Point[] = [];
    for (const it of this.items) {
      if (it.op > limit || it.status !== "corroborated" || it.target !== f) continue;
      for (const t of it.explicitEnds) {
        // Reverted by an undo or take_previous: the endpoint no longer counts. An end endpoint
        // belongs to the stretch just before it, so the registration is read as closed here.
        if (this.registeredAtEnd(it, t, limit)) continue;
        const coveredOver = this.items.some(
          (x) =>
            x.op > it.op &&
            x.op <= limit &&
            x.status === "applied" &&
            ((x.target === f && x.content.kind !== "uncovered") || x.content.kind === "revoke") &&
            containsPoint(x.valid, t) &&
            !this.registeredAtPoint(x, t, limit),
        );
        if (!coveredOver) out.push(t);
      }
    }
    return out;
  }

  blockingPoints(f: FieldId | "any", limit: number): Point[] {
    const fs = f === "any" ? this.fieldIds : [f];
    const ps = new Set<Point>();
    for (const g of fs) {
      for (const p of this.valueChangePoints(g, limit)) ps.add(p);
      for (const p of this.corroborationEndpoints(g, limit)) ps.add(p);
    }
    return [...ps].sort();
  }

  /**
   * Resolves interval parameters against the state as of `limit` (05-time «写状态：参数与默认»):
   * a default end stops at the first blocking point strictly after the start; `corrected_span`
   * is the stretch around "now" bounded by blocking points. Returns null where `corrected_span`
   * finds no value at "now" (the write is rejected).
   */
  resolve(
    param: ValidParam | undefined,
    f: FieldId | "any",
    limit: number,
    now: Point | undefined,
  ): { valid: IvSet; defaultEnd: boolean; from: Point | null; explicitEnds: Point[] } | null {
    if (!this.isState) return { valid: [ALL], defaultEnd: false, from: null, explicitEnds: [] };
    const p = param ?? { from: { mode: "now" as const }, to: { mode: "next_change" as const } };
    const bps = this.blockingPoints(f, limit);
    if (p === "corrected_span") {
      if (now === undefined) throw new Error("corrected_span needs `now`");
      const at = this.segments([[{ from: now, to: null }]]).find((s) => s.from === now);
      if (at === undefined) return null;
      const fs = f === "any" ? this.fieldIds : [f];
      if (fs.every((g) => this.vis(g, at, limit) === NO_VALUE)) return null;
      const from = bps.filter((b) => b <= now).pop() ?? null;
      const to = bps.find((b) => b > now) ?? null;
      return { valid: normalize([{ from, to }]), defaultEnd: false, from, explicitEnds: [] };
    }
    let from: Point;
    if (p.from.mode === "given") from = p.from.value;
    else if (now !== undefined) from = now;
    else throw new Error("`from: now` needs `now`");
    let to: Point | null;
    if (p.to.mode === "given") to = p.to.value;
    else if (p.to.mode === "open") to = null;
    else to = bps.find((b) => b > from) ?? null;
    const explicitEnds = p.to.mode === "given" ? [from, p.to.value] : [from];
    return {
      valid: normalize([{ from, to }]),
      defaultEnd: p.to.mode === "next_change",
      from,
      explicitEnds,
    };
  }

  // -------------------------------------------------------------------------------------------
  // Recorded judgements (second pass only).

  /**
   * The first pass's status of the items of (event, target) that intersect `valid`. "effective"
   * is what deviation two protects (03-deletion «删除结果的定义»): in effect at write time,
   * corroborations included. A write that took effect only through a deletion's recomputation is
   * not protected; with deletions not interleaved with operations the first pass is the
   * write-time judgement, so it never counts here. Where a candidate or an awaiting item
   * intersects, that item was never in effect and is judged again.
   */
  recordedStatus(event: Seq, target: Target, valid: IvSet): "effective" | Status | undefined {
    if (this.rec.keptEffective.has(etKey(event, target))) return "effective";
    const base = this.rec.writeTime.get(etKey(event, target));
    if (base === undefined) return undefined;
    const hit = base.filter((b) => !isEmpty(intersect(b.valid, valid)));
    const pool = hit.length > 0 ? hit : base;
    if (pool.some((b) => b.status === "candidate")) return "candidate";
    if (pool.some((b) => b.status === "awaiting")) return "awaiting";
    if (pool.some((b) => effective(b.status))) return "effective";
    return undefined;
  }

  /**
   * Indices of new items of one (event, target), sorted by start. First pass: from 0 by start.
   * Second pass (03-deletion «回掉的权威定义» step 6, 09 §5.7): an item that existed keeps its
   * index and stays on the first new item intersecting its interval at the time it was last given;
   * when two land on the same one the smallest index stays (the other is dropped); new items
   * continue after the largest index used.
   */
  assignIndices(event: Seq, target: Target, fresh: Item[]): void {
    fresh.sort((a, b) => ((a.valid[0]?.from ?? "") < (b.valid[0]?.from ?? "") ? -1 : 1));
    const base = [...(this.rec.latest.get(etKey(event, target)) ?? [])].sort((a, b) => a.k - b.k);
    const assigned = new Map<Item, number>();
    for (const b of base) {
      const hit = fresh.find((it) => !isEmpty(intersect(it.valid, b.valid)));
      if (hit !== undefined && !assigned.has(hit)) assigned.set(hit, b.k);
    }
    let next = Math.max(-1, ...base.map((b) => b.k)) + 1;
    for (const it of fresh) {
      const k = assigned.get(it);
      it.k = k ?? next++;
    }
  }

  push(fresh: Item[]): void {
    const groups = new Map<string, Item[]>();
    for (const it of fresh) {
      const key = etKey(it.event, it.target);
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    for (const g of groups.values()) {
      const first = g[0];
      if (first !== undefined) this.assignIndices(first.event, first.target, g);
      this.items.push(...g);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Judgements (03-deletion «重放规则»; 09-references-conflict-sync «冲突判据»; 05-time
  // «高影响写入»).

  /** Operations after `seen` and up to `cur` that changed the value of `f` somewhere. */
  changesSince(f: FieldId, seen: number, cur: number): { op: number; changed: IvSet }[] {
    const ops = [
      ...new Set(
        this.items
          .filter((x) => x.op > seen && x.op <= cur && x.status === "applied")
          .map((x) => x.op),
      ),
    ].sort((a, b) => a - b);
    const segs = this.segments();
    return ops
      .map((m) => ({
        op: m,
        changed: normalize(segs.filter((s) => this.vis(f, s, m) !== this.vis(f, s, m - 1))),
      }))
      .filter((c) => c.changed.length > 0);
  }

  conflicts(
    f: FieldId,
    value: string,
    seenValid: IvSet,
    defaultEnd: boolean,
    from: Point | null,
    seen: number,
    cur: number,
  ): boolean {
    for (const l of this.changesSince(f, seen, cur)) {
      if (!this.isState) return true;
      const lItems = this.items.filter(
        (x) =>
          x.op === l.op && x.status === "applied" && (x.target === f || x.target === "existence"),
      );
      const lField = lItems.filter((x) => x.target === f);
      if (defaultEnd && lField.length > 0 && lField.every((x) => x.defaultEnd)) {
        const lv = lField[0];
        if (lv !== undefined && lv.from === from && lv.content.kind === "value") {
          if (tok(lv.content.value) !== value) return true;
        }
        continue;
      }
      const lValid = lItems.length > 0 ? union(...lItems.map((x) => x.valid)) : l.changed;
      const inter = intersect(seenValid, lValid);
      for (const s of this.segments([inter])) {
        if (covers(inter, s) && this.vis(f, s, cur) !== value) return true;
      }
    }
    // Deletion confirmations and cancellations are operations that change values too (conflict
    // criterion ②); L's interval is where they changed the unit's value.
    for (const changed of this.externalChanges(f, seen, cur)) {
      if (!this.isState) return true;
      const inter = intersect(seenValid, changed);
      for (const s of this.segments([inter])) {
        if (covers(inter, s) && this.vis(f, s, cur) !== value) return true;
      }
    }
    return false;
  }

  /** Where deletion events after `seen` and up to `cur` changed the value of `f`. */
  externalChanges(f: FieldId, seen: number, cur: number): IvSet[] {
    return this.rec.external
      .filter((e) => e.op > seen && e.op <= cur)
      .map((e) => e.changed.get(f) ?? [])
      .filter((c) => !isEmpty(c));
  }

  /** Whether a revoke over `valid` meets a change in effect since `seen` (conflict criterion). */
  revokeConflicts(valid: IvSet, seen: number, cur: number): boolean {
    return this.fieldIds.some(
      (f) =>
        this.changesSince(f, seen, cur).some((c) => !isEmpty(intersect(c.changed, valid))) ||
        this.externalChanges(f, seen, cur).some((c) => !isEmpty(intersect(c, valid))),
    );
  }

  /**
   * High impact ①: after the write, a value change point of some field that the writer's seen
   * version had (and that still existed just before) is no longer one (05-time «高影响写入»).
   */
  highImpact(
    seen: number,
    cur: number,
    n: number,
    apply: () => void,
    rollback: () => void,
  ): boolean {
    if (!this.isState) return false;
    const before = new Map(
      this.fieldIds.map((f) => {
        const s = new Set(this.valueChangePoints(f, seen));
        return [f, this.valueChangePoints(f, cur).filter((p) => s.has(p))];
      }),
    );
    apply();
    const after = new Map(this.fieldIds.map((f) => [f, new Set(this.valueChangePoints(f, n))]));
    rollback();
    return this.fieldIds.some((f) => (before.get(f) ?? []).some((p) => !after.get(f)?.has(p)));
  }

  // -------------------------------------------------------------------------------------------
  // Operations.

  write(o: WriteOp): void {
    const n = o.op;
    const evidence = [...new Set(Object.values(o.fields).flatMap((x) => x?.sources ?? []))];
    // The interval parameters are content: their sources gone, the write has no contribution on
    // the entity at all (03-deletion «区间参数»).
    if (this.isState && this.isDeleted(o.validSources ?? evidence)) return;
    const seen = o.seen ?? n - 1;
    const cur = n - 1;
    const fresh: Item[] = [];
    for (const [fid, input] of Object.entries(o.fields)) {
      const f = fid as FieldId;
      if (input === undefined) continue;
      // A field judged a no-op at write time stays a no-op in every replay: its same-value
      // judgement is not recomputed (03-deletion «两条原则», deviation one; «重放规则», no-op row).
      if (o.noop?.includes(f) || this.rec.noops.has(etKey(o.event, f))) continue;
      if (this.isDeleted(input.sources)) continue;
      this.judgeField(o, f, input, seen, cur, fresh);
    }
    const applied = fresh.filter((it) => it.status === "applied");
    if (applied.length > 0) {
      const hi =
        !this.acknowledged(o) &&
        this.highImpact(
          seen,
          cur,
          n,
          () => this.items.push(...applied),
          () => this.items.splice(this.items.length - applied.length, applied.length),
        );
      for (const it of applied) {
        const r = this.recordedStatus(it.event, it.target, it.valid);
        if (r === "awaiting" && this.resolvedAwaiting.has(o.event)) it.status = "awaiting";
        else if (hi && r !== "effective") it.status = "awaiting";
      }
    }
    this.push(fresh);
  }

  judgeField(o: WriteOp, f: FieldId, input: FieldInput, seen: number, cur: number, out: Item[]) {
    const n = o.op;
    const res = this.resolve(o.valid, f, seen, o.now);
    if (res === null) return;
    const v = tok(input.value);
    const segs = this.segments([res.valid]).filter((s) => covers(res.valid, s));
    const sameAsSeen = segs.every((s) => this.vis(f, s, seen) === v);
    const base = {
      event: o.event,
      target: f,
      k: 0,
      op: n,
      content: { kind: "value" as const, value: input.value },
    };
    // A candidate put back by a cancellation after its item was resolved keeps the judgement it
    // got then (03-deletion «撤回与宽限期»).
    const rejudged = this.rec.rejudged.get(etKey(o.event, f));
    if (rejudged !== undefined) {
      const item = {
        ...base,
        valid: res.valid,
        explicitEnds: rejudged === "corroborated" ? res.explicitEnds : [],
        defaultEnd: res.defaultEnd,
        from: res.from,
      };
      if (rejudged === "dropped") this.shadows.push({ ...item, status: "candidate" });
      else out.push({ ...item, status: rejudged });
      return;
    }
    if (sameAsSeen && !input.explicit) {
      // Same value as seen, no evidence pointed at: not a contribution (03-deletion «贡献»). At
      // write time that is a no-op, kept as recorded; in a replay a former change becomes
      // `dropped`.
      if (!this.rec.judged.has(o.op)) this.noops.add(etKey(o.event, f));
      this.shadows.push({
        ...base,
        status: "candidate",
        valid: res.valid,
        explicitEnds: [],
        defaultEnd: res.defaultEnd,
        from: res.from,
      });
      return;
    }
    if (sameAsSeen) {
      // Corroboration: still the same as now → corroborated; changed since → judged as an
      // ordinary write (05-time «用同样的值写»).
      const eq = normalize(segs.filter((s) => this.vis(f, s, cur) === v));
      for (const piece of pieces(eq)) {
        const ends = res.explicitEnds.filter((t) => piece.some((x) => x.from === t || x.to === t));
        out.push({
          ...base,
          status: "corroborated",
          valid: piece,
          explicitEnds: ends,
          defaultEnd: false,
          from: piece[0]?.from ?? null,
        });
      }
      for (const piece of pieces(subtract(res.valid, eq))) {
        this.ordinary(o, f, input, piece, false, piece[0]?.from ?? null, false, seen, cur, out);
      }
      return;
    }
    this.ordinary(o, f, input, res.valid, res.defaultEnd, res.from, true, seen, cur, out);
  }

  ordinary(
    o: WriteOp,
    f: FieldId,
    input: FieldInput,
    seenValid: IvSet,
    defaultEnd: boolean,
    from: Point | null,
    reResolve: boolean,
    seen: number,
    cur: number,
    out: Item[],
  ): void {
    const v = tok(input.value);
    const r = this.recordedStatus(o.event, f, seenValid);
    let conflict =
      r === "candidate" && this.closedCandidates.has(o.event)
        ? true
        : this.conflicts(f, v, seenValid, defaultEnd, from, seen, cur);
    if (r === "effective") conflict = false; // deviation two: what was in effect stays in effect
    // An awaiting write a person confirmed or rejected is a recorded decision (deviation one): it
    // stays awaiting for its confirmation to execute, and is not judged into a candidate.
    if (r === "awaiting" && this.resolvedAwaiting.has(o.event)) conflict = false;
    const content = { kind: "value" as const, value: input.value };
    if (conflict) {
      out.push({
        event: o.event,
        target: f,
        k: 0,
        op: o.op,
        status: "candidate",
        valid: seenValid,
        content,
        explicitEnds: [],
        defaultEnd,
        from,
      });
      return;
    }
    // Merged: the interval is resolved against the current state (conflict criterion ④).
    const res = reResolve ? this.resolve(o.valid, f, cur, o.now) : null;
    const valid = res?.valid ?? seenValid;
    const ends = res?.explicitEnds ?? [];
    out.push({
      event: o.event,
      target: f,
      k: 0,
      op: o.op,
      status: "applied",
      valid,
      content,
      explicitEnds: ends,
      defaultEnd,
      from: res?.from ?? from,
    });
  }

  revoke(o: RevokeOp): void {
    const n = o.op;
    const seen = o.seen ?? n - 1;
    const cur = n - 1;
    let valid: IvSet = [ALL];
    let seenValid: IvSet = [ALL];
    if (o.valid !== undefined) {
      if (!this.isState) throw new Error("revoke with an interval needs a state table");
      // A revoke with an interval is content; its sources gone, it has no contribution
      // (03-deletion «撤销分两种»).
      if (this.isDeleted(o.validSources ?? [])) return;
      const s = this.resolve(o.valid, "any", seen, o.now);
      const c = this.resolve(o.valid, "any", cur, o.now);
      if (s === null || c === null) return;
      seenValid = s.valid;
      valid = c.valid;
    }
    const r = this.recordedStatus(o.event, "existence", seenValid);
    let conflict = seen < cur && this.revokeConflicts(seenValid, seen, cur);
    if (r === "candidate" && this.closedCandidates.has(o.event)) conflict = true;
    if (r === "effective") conflict = false;
    const base = {
      event: o.event,
      target: "existence" as const,
      k: 0,
      op: n,
      content: { kind: "revoke" as const },
      explicitEnds: [],
      defaultEnd: false,
      from: null,
    };
    this.push([
      conflict
        ? { ...base, status: "candidate", valid: seenValid }
        : { ...base, status: "applied", valid },
    ]);
  }

  /** `undo` list: all items of the undone operation, plus the later items it reverts. */
  undoRecord(target: OpNumber, includeLater: boolean, n: number): ItemRef[] {
    const own = this.items.filter((x) => x.op === target && effective(x.status));
    const out = own.map(refOf);
    if (includeLater) {
      for (const x of this.items) {
        if (x.op <= target || x.op >= n || x.status !== "applied") continue;
        if (own.some((r) => supersedes(x, r) && !isEmpty(intersect(x.valid, r.valid)))) {
          out.push(refOf(x));
        }
      }
    }
    return out;
  }

  /**
   * `acknowledge: ["overwrite"]` takes high impact ① into effect directly only when the op
   * explicitly carries the current `ver` (05-time «高影响写入»).
   */
  acknowledged(o: WriteOp | UndoOp): boolean {
    if (o.acknowledge === undefined || o.seen === undefined) return false;
    const seen = o.seen;
    // A deletion or cancellation that changed the entity gave it a new ver (03-deletion «重放规则»,
    // ver row): a ver before it is not current.
    return (
      !this.items.some((x) => x.op > seen && x.op < o.op && effective(x.status)) &&
      !this.rec.external.some((e) => e.op > seen && e.op < o.op && e.changedEntity)
    );
  }

  undo(o: UndoOp): void {
    const n = o.op;
    // `undo_target` (04-write-and-read «撤回某次写入（undo）»): rejected when no item of the
    // target on this row ever took effect — in effect or corroborated. So a candidate, an awaiting
    // write (its confirmation is a separate operation) or a write of nothing but no-ops is
    // rejected; a corroboration-only write can be undone (its corroboration and endpoints stop
    // counting, values stay). A target that is itself a revert in effect is accepted even when it
    // has no write-back now: a deletion's recomputation may give it some. The answer is the
    // write-time one and is kept in every replay.
    const rejected = this.rec.revertStatus.has(n)
      ? this.rec.revertStatus.get(n) === "rejected"
      : this.revertStatus.get(o.target) !== "applied" &&
        !this.items.some((x) => x.op === o.target && effective(x.status));
    if (rejected) {
      this.reverts.push({ op: n, event: o.event, status: "rejected", record: [] });
      this.revertStatus.set(n, "rejected");
      this.revertRecords.set(n, []);
      return;
    }
    const record =
      this.rec.revertRecords.get(n) ?? this.undoRecord(o.target, o.includeLater ?? false, n);
    this.revert(o.event, n, record, { before: o.target }, null, (inScope, apply, rollback) => {
      const recStatus = this.rec.revertStatus.get(n);
      if (recStatus === "applied") return "applied"; // deviation two
      if (recStatus === "awaiting" && this.resolvedAwaiting.has(o.event)) return "awaiting";
      // High impact ④: an undo that reverts later writes (05-time «高影响写入»).
      if (o.includeLater && inScope.some((r) => r.op !== o.target)) return "awaiting";
      if (this.acknowledged(o) || inScope.every((r) => r.content.kind === "revoke")) {
        return "applied";
      }
      return this.highImpact(n - 1, n - 1, n, apply, rollback) ? "awaiting" : "applied";
    });
  }

  confirm(o: ConfirmOp): void {
    if (o.kind === "reject") return;
    const target = this.opsByEvent.get(o.target);
    if (target?.kind === "undo") {
      if (this.revertStatus.get(target.op) !== "awaiting") return;
      // The confirmation lists its own record as of the confirmation (09 §5.8 `item.resolved`).
      const record =
        this.rec.revertRecords.get(o.op) ??
        this.undoRecord(target.target, target.includeLater ?? false, o.op);
      this.revert(o.event, o.op, record, { before: target.target }, null, () => "applied");
      return;
    }
    // Executes the proposal as recorded in the item (05-time «高影响写入»).
    const awaiting = this.items.filter((x) => x.event === o.target && x.status === "awaiting");
    this.push(
      awaiting.map((x) => ({
        ...x,
        event: o.event,
        op: o.op,
        status: "applied" as const,
        carried: [refOf(x)],
        explicitEnds: [],
      })),
    );
  }

  /** Items of the conflict item: the candidates of `events` on the unit (present, or same-valued). */
  candidatesOf(events: readonly Seq[], unit: Target): Item[] {
    return [...this.items, ...this.shadows].filter(
      (x) =>
        events.includes(x.event) &&
        (unit === "existence" || x.target === unit) &&
        (x.status === "candidate" || this.shadows.includes(x)),
    );
  }

  resolveItem(o: ResolveOp): void {
    const n = o.op;
    if (o.decision === "keep_effective") return;
    if (o.decision === "take_candidate") {
      if (o.take === undefined || o.unit === "existence") {
        throw new Error("take_candidate needs `take` and a field unit");
      }
      const f = o.unit;
      const cands = this.candidatesOf(o.candidates, f);
      const taken = cands.filter((x) => x.event === o.take);
      const value = taken.find((x) => x.content.kind === "value")?.content;
      // Same-valued candidates of the item are value sources too (03-deletion «搬运的值»).
      const carried = value
        ? cands.filter(
            (x) =>
              x.content.kind === "value" &&
              tok(x.content.value) === tok(value.kind === "value" ? value.value : null),
          )
        : [];
      const giver = taken[0] ?? carried[0];
      if (giver === undefined || giver.content.kind !== "value") return;
      const v = tok(giver.content.value);
      const segs = this.segments([giver.valid]).filter((s) => covers(giver.valid, s));
      if (segs.every((s) => this.vis(f, s, n - 1) === v)) return; // same value: not a contribution
      this.push([
        {
          event: o.event,
          target: f,
          k: 0,
          op: n,
          status: "applied",
          valid: giver.valid,
          content: giver.content,
          carried: carried.map(refOf),
          explicitEnds: [],
          defaultEnd: false,
          from: null,
        },
      ]);
      return;
    }
    // take_previous: revert to the merge base (01-objects «各处理方式的执行语义»).
    let rec = this.rec.mergeBases.get(n);
    if (rec === undefined) {
      const cands = this.candidatesOf(o.candidates, o.unit);
      const seens = o.candidates.map((e) => {
        const c = this.opsByEvent.get(e);
        return c !== undefined && (c.kind === "write" || c.kind === "revoke")
          ? (c.seen ?? c.op - 1)
          : (c?.op ?? 0);
      });
      const mergeBase = Math.min(...seens);
      const domain = union(...cands.map((c) => c.valid));
      const record = this.items
        .filter(
          (x) =>
            x.op > mergeBase &&
            x.op < n &&
            effective(x.status) &&
            (o.unit === "existence" || x.target === o.unit) &&
            !isEmpty(intersect(x.valid, domain)),
        )
        .map(refOf);
      rec = { mergeBase, k: cands.filter((c) => !this.shadows.includes(c)).map(refOf) };
      this.mergeBases.set(n, { mergeBase, k: rec.k as ItemRef[] });
      this.revertRecords.set(n, record);
    }
    const record = this.rec.revertRecords.get(n) ?? this.revertRecords.get(n) ?? [];
    const kKeys = new Set(rec.k.map(refKey));
    const kEts = new Set(rec.k.map((r) => etKey(r.event, r.target)));
    // K present in the replay: not deleted; same-valued in the replay still counts (step 2).
    const kItems = [...this.items, ...this.shadows].filter(
      (x) =>
        kKeys.has(refKey(x)) || (this.shadows.includes(x) && kEts.has(etKey(x.event, x.target))),
    );
    this.revert(o.event, n, record, { asOf: rec.mergeBase }, kItems, () => "applied");
  }

  /** 03-deletion «回掉的权威定义», steps 1–8 (without `deps`). */
  revert(
    event: Seq,
    n: OpNumber,
    record: readonly ItemRef[],
    pos: { before: OpNumber } | { asOf: OpNumber },
    k: Item[] | null,
    decide: (inScope: Item[], apply: () => void, rollback: () => void) => RevertResult["status"],
  ): void {
    // Step 1: R' = the listed items, plus indices of the same (event, target) first given by a
    // deletion's restatement (not present when the event was written).
    const rKeys = new Set(record.map(refKey));
    const rEts = new Set(record.map((r) => etKey(r.event, r.target)));
    const isNewIndex = (x: Item) => {
      const base = this.rec.writeTime.get(etKey(x.event, x.target));
      return base !== undefined && !base.some((b) => b.k === x.k);
    };
    const rPrime = this.items.filter(
      (x) => rKeys.has(refKey(x)) || (rEts.has(etKey(x.event, x.target)) && isNewIndex(x)),
    );
    const zai = rPrime.filter((x) => effective(x.status));

    // Step 2: the domain.
    const domain: IvSet = k === null ? [ALL] : union(...k.map((c) => c.valid));

    // Step 3: ranges.
    const scope = new Map<Item, IvSet>();
    for (const r of zai) {
      const covering = this.items
        .filter(
          (x) =>
            x.status === "applied" &&
            !rPrime.includes(x) &&
            r.op < x.op &&
            x.op < n &&
            x.content.kind !== "uncovered" &&
            supersedes(x, r),
        )
        .map((x) => intersect(subtract(x.valid, this.registeredSet(x, n)), r.valid));
      scope.set(r, intersect(subtract(r.valid, union(...covering)), domain));
    }
    const targets = [...new Set(zai.map((r) => r.target))];
    const tOf = (t: Target) =>
      union(...zai.filter((r) => r.target === t).map((r) => scope.get(r) ?? []));

    // Steps 5 and 6, built first so that step 4 can judge the result.
    const limit = "before" in pos ? pos.before - 1 : pos.asOf;
    const fresh: Item[] = [];
    for (const t of targets) {
      const T = tOf(t);
      if (isEmpty(T)) continue;
      const segs = this.segments([T]).filter((s) => covers(T, s));
      let run:
        | { valid: Iv[]; content: ItemContent; giver: Item | undefined; key: string }
        | undefined;
      const flush = () => {
        if (run === undefined) return;
        const g = run.giver;
        fresh.push({
          event,
          target: t,
          k: 0,
          op: n,
          status: "applied",
          valid: normalize(run.valid),
          content: run.content,
          ...(run.content.kind === "value" && g !== undefined ? { carried: [refOf(g)] } : {}),
          explicitEnds: [],
          defaultEnd: false,
          from: null,
        });
        run = undefined;
      };
      for (const s of segs) {
        const { content, giver } = this.stateAtPosition(t, s, limit);
        const key = `${content.kind === "value" ? tok(content.value) : content.kind}|${giver ? refKey(giver) : ""}`;
        const last = run?.valid[run.valid.length - 1];
        if (run !== undefined && run.key === key && last !== undefined && last.to === s.from) {
          run.valid.push(s);
        } else {
          flush();
          run = { valid: [s], content, giver, key };
        }
      }
      flush();
    }
    const registrations = zai.flatMap((r) => {
      const valid = intersect(r.valid, tOf(r.target));
      return isEmpty(valid) ? [] : [{ key: refKey(r), reg: { byOp: n, valid } }];
    });
    const apply = () => {
      this.items.push(...fresh);
      for (const { key, reg } of registrations)
        this.regs.set(key, [...(this.regs.get(key) ?? []), reg]);
    };
    const rollback = () => {
      this.items.splice(this.items.length - fresh.length, fresh.length);
      for (const { key } of registrations)
        this.regs.set(key, (this.regs.get(key) ?? []).slice(0, -1));
    };

    // Step 4: a revert that is not in effect registers nothing and writes nothing back.
    const status = decide(zai, apply, rollback);
    this.reverts.push({ op: n, event, status, record });
    this.revertStatus.set(n, status);
    if (!this.revertRecords.has(n)) this.revertRecords.set(n, [...record]);
    if (status !== "applied") return;
    // Step 7: no write-back when nothing in R is still a contribution or every range is empty.
    for (const { key, reg } of registrations)
      this.regs.set(key, [...(this.regs.get(key) ?? []), reg]);
    this.push(fresh);
  }

  /** Step 6: the state at the value position, as content to write back and who gives it. */
  stateAtPosition(
    t: Target,
    s: Iv,
    limit: number,
  ): { content: ItemContent; giver: Item | undefined } {
    if (t === "existence") {
      return { content: { kind: this.absent(s, limit) ? "revoke" : "restore" }, giver: undefined };
    }
    const st = this.fieldState(t, s, limit);
    if (st.kind === "value") return { content: { kind: "value", value: st.value }, giver: st.by };
    if (st.kind === "hole") return { content: { kind: "uncovered" }, giver: st.by };
    return { content: { kind: "noValue" }, giver: undefined };
  }

  /** Inside a revoke in effect, not registered there, and not restored or filled since. */
  absent(s: Iv, limit: number): boolean {
    const live = (x: Item) =>
      x.op <= limit &&
      x.status === "applied" &&
      covers(x.valid, s) &&
      !this.registeredOn(x, s, limit);
    return this.items.some(
      (r) =>
        r.content.kind === "revoke" &&
        live(r) &&
        !this.items.some(
          (x) =>
            x.op > r.op &&
            live(x) &&
            (x.content.kind === "restore" ||
              (x.target !== "existence" && x.content.kind === "value")),
        ),
    );
  }

  run(): void {
    for (const o of [...this.ops].sort((a, b) => a.op - b.op)) {
      if (o.kind === "write") this.write(o);
      else if (o.kind === "revoke") this.revoke(o);
      else if (o.kind === "undo") this.undo(o);
      else if (o.kind === "resolve") this.resolveItem(o);
      else this.confirm(o);
    }
  }

  // -------------------------------------------------------------------------------------------
  // Results.

  rowExists(): boolean {
    if (
      this.items.some(
        (x) =>
          x.content.kind === "revoke" && x.status === "applied" && !this.registeredOn(x, ALL, INF),
      )
    ) {
      return false;
    }
    const contributes = (f: FieldId, nonNull: boolean) =>
      this.items.some(
        (x) =>
          x.target === f &&
          effective(x.status) &&
          x.content.kind === "value" &&
          (!nonNull || x.content.value !== null),
      );
    // Every required field has a contribution and some field has a non-empty one
    // (03-deletion «重放规则», «行 / 实体的存在»).
    return (
      this.schema.required.every((f) => contributes(f, false)) &&
      this.fieldIds.some((f) => contributes(f, true))
    );
  }

  created(): Seq | undefined {
    const writes = this.ops
      .filter((o): o is WriteOp => o.kind === "write")
      .sort((a, b) => a.op - b.op);
    const req = this.schema.required.length > 0 ? this.schema.required : this.fieldIds;
    return writes.find((w) =>
      req.every((f) =>
        this.items.some((x) => x.event === w.event && x.target === f && effective(x.status)),
      ),
    )?.event;
  }

  result(): Evaluation {
    const fields: Partial<Record<FieldId, FieldSegment[]>> = {};
    let gaps: IvSet = [];
    let exists: boolean;
    if (this.isState) {
      const segs = this.segments();
      gaps = normalize(segs.filter((s) => !this.hasValue(s, INF)));
      exists = segs.some((s) => this.hasValue(s, INF));
      for (const f of this.fieldIds) {
        const out: FieldSegment[] = [];
        let last: { seg: FieldSegment; key: string; to: Point | null } | undefined;
        for (const s of segs) {
          if (!this.hasValue(s, INF)) {
            last = undefined;
            continue;
          }
          const st = this.fieldState(f, s, INF);
          const seg: FieldSegment =
            st.kind === "value"
              ? { valid: [s], value: st.value, by: refOf(st.by) }
              : { valid: [s], value: null };
          const key = `${st.kind === "value" ? tok(st.value) : "none"}|${seg.by ? refKey({ ...seg.by }) : ""}`;
          if (last !== undefined && last.key === key && last.to === s.from) {
            const merged: FieldSegment = { ...last.seg, valid: normalize([...last.seg.valid, s]) };
            out[out.length - 1] = merged;
            last = { seg: merged, key, to: s.to };
          } else {
            out.push(seg);
            last = { seg, key, to: s.to };
          }
        }
        fields[f] = out;
      }
    } else {
      exists = this.rowExists();
      if (exists) {
        for (const f of this.fieldIds) {
          const st = this.fieldState(f, ALL, INF);
          fields[f] = [
            st.kind === "value"
              ? { valid: [ALL], value: st.value, by: refOf(st.by) }
              : { valid: [ALL], value: null },
          ];
        }
      }
    }
    const items: ItemResult[] = this.items.map((x) => ({
      ...refOf(x),
      op: x.op,
      status: x.status,
      valid: x.valid,
      content: x.content,
      ...(x.carried ? { carried: x.carried } : {}),
      registrations: this.regs.get(refKey(x)) ?? [],
      ...((x.status === "candidate" && this.closedCandidates.has(x.event)) ||
      (x.status === "awaiting" && this.resolvedAwaiting.has(x.event))
        ? { closed: true as const }
        : {}),
    }));
    // Items as last given that are no longer items and were not deleted: `dropped`.
    {
      const present = new Set(this.items.map(refKey));
      for (const [et, base] of this.rec.latest) {
        const [ev, target] = et.split("/") as [string, Target];
        const event = Number(ev);
        for (const b of base) {
          const ref = { event, target, k: b.k };
          if (present.has(refKey(ref)) || this.deletedItem(event, target)) continue;
          const op = this.opsByEvent.get(event)?.op ?? 0;
          items.push({
            ...ref,
            op,
            status: "dropped",
            valid: [],
            content: { kind: "noValue" },
            registrations: [],
          });
        }
      }
    }
    return {
      kind: this.schema.kind,
      exists,
      gaps,
      fields,
      items,
      reverts: this.reverts,
      created: this.created(),
    };
  }

  /** Whether the contributions of (event, target) were removed by the deletion itself. */
  deletedItem(event: Seq, target: Target): boolean {
    const o = this.opsByEvent.get(event);
    if (o === undefined) return false;
    if (o.kind === "write") {
      const evidence = Object.values(o.fields).flatMap((x) => x?.sources ?? []);
      if (this.isState && this.isDeleted(o.validSources ?? evidence)) return true;
      const input = target === "existence" ? undefined : o.fields[target];
      return input !== undefined && this.isDeleted(input.sources);
    }
    if (o.kind === "revoke") return o.valid !== undefined && this.isDeleted(o.validSources ?? []);
    return false;
  }

  /** Copies the write-time judgement of operation `o` into the record. */
  recordOp(o: Op): void {
    const rec = this.rec;
    rec.judged.add(o.op);
    const groups = new Map<string, Item[]>();
    for (const x of this.items) {
      if (x.op !== o.op) continue;
      const key = etKey(x.event, x.target);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    for (const [key, xs] of groups) {
      rec.writeTime.set(
        key,
        xs.map((x) => ({ k: x.k, valid: x.valid, status: x.status })),
      );
      rec.latest.set(
        key,
        xs.map((x) => ({ k: x.k, valid: x.valid })),
      );
    }
    for (const key of this.noops) if (key.startsWith(`${o.event}/`)) rec.noops.add(key);
    if (o.kind === "write") for (const f of o.noop ?? []) rec.noops.add(etKey(o.event, f));
    const record = this.revertRecords.get(o.op);
    if (record !== undefined) rec.revertRecords.set(o.op, record);
    const status = this.revertStatus.get(o.op);
    if (status !== undefined) rec.revertStatus.set(o.op, status);
    const mb = this.mergeBases.get(o.op);
    if (mb !== undefined) rec.mergeBases.set(o.op, mb);
  }

  /**
   * After a deletion event: every item as now given becomes the latest given. Indices no longer
   * given keep their last interval, so that an item that comes back keeps its index.
   */
  recordLatest(): void {
    const groups = new Map<string, Item[]>();
    for (const x of this.items) {
      const key = etKey(x.event, x.target);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    for (const [key, xs] of groups) {
      const now = xs.map((x) => ({ k: x.k, valid: x.valid }));
      const kept = (this.rec.latest.get(key) ?? []).filter((b) => !now.some((x) => x.k === b.k));
      this.rec.latest.set(key, [...now, ...kept]);
    }
  }

  statusOf(event: Seq, target: Target): Status[] {
    return this.items.filter((x) => x.event === event && x.target === target).map((x) => x.status);
  }
}

/** Step 3, "x 取代 r". */
function supersedes(x: Item, r: Item): boolean {
  const xIsFieldValue = x.target !== "existence" && x.content.kind === "value";
  if (r.content.kind === "revoke") return x.content.kind === "restore" || xIsFieldValue;
  if (r.content.kind === "restore") return x.content.kind === "revoke";
  return (x.target === r.target && x.content.kind !== "uncovered") || x.content.kind === "revoke";
}

interface KnockOn {
  readonly event: Seq;
  readonly target: Target;
  readonly before: string;
  readonly after: string;
  readonly because: readonly { event: Seq; target: Target }[];
}

/**
 * What a deletion event changed: where each field's value changed (its L for the conflict
 * criterion) and whether it changed the entity at all — values, or the judgement of any item —
 * which gives the entity a new ver (03-deletion «重放规则», ver row).
 */
function externalChange(
  op: OpNumber,
  before: Evaluation,
  after: Evaluation,
  fields: readonly FieldId[],
): { op: OpNumber; changed: Map<FieldId, IvSet>; changedEntity: boolean } {
  const changed = changedRegions(before, after, fields);
  const sig = (ev: Evaluation) =>
    JSON.stringify(
      ev.items
        .filter((x) => x.status !== "dropped")
        .map((x) => [x.event, x.target, x.k, x.status, x.valid])
        .sort(),
    );
  const changedEntity =
    [...changed.values()].some((c) => !isEmpty(c)) ||
    sig(before) !== sig(after) ||
    before.exists !== after.exists;
  return { op, changed, changedEntity };
}

/** The value of `f` on segment `seg` as an evaluation shows it, as a comparable token. */
function shownTok(ev: Evaluation, f: FieldId, seg: Iv): string {
  if (ev.kind === "state" && ev.gaps.some((g) => covers([g], seg))) return NO_VALUE;
  const hit = (ev.fields[f] ?? []).find((x) => covers(x.valid, seg));
  if (hit === undefined || hit.by === undefined) return "none";
  return tok(hit.value);
}

/** Where each field's value differs between two states (a deletion event's L, conflict ②). */
function changedRegions(
  before: Evaluation,
  after: Evaluation,
  fields: readonly FieldId[],
): Map<FieldId, IvSet> {
  const sets: IvSet[] = [before.gaps, after.gaps];
  for (const ev of [before, after]) {
    for (const segs of Object.values(ev.fields)) for (const x of segs ?? []) sets.push(x.valid);
  }
  const segs = after.kind === "state" ? elementarySegments(endpoints(sets)) : [ALL];
  return new Map(
    fields.map((f) => [
      f,
      normalize(segs.filter((g) => shownTok(before, f, g) !== shownTok(after, f, g))),
    ]),
  );
}

const pendingStatus = (x: { status: string; closed?: true }) =>
  (x.status === "candidate" || x.status === "awaiting") && x.closed === undefined;

/**
 * Evaluates the log of one row or entity: operations interleaved with deletion confirmations and
 * cancellations, by operation number. Each operation is judged at its own point in the log, on
 * the state with the deletions confirmed and not cancelled by then (03-deletion «撤回与宽限期»:
 * writes in the grace period run on the state after the deletion); every deletion event replays
 * the whole log with the deleted set it leaves, keeping what the definition keeps as recorded.
 */
export function evaluateLog(
  schema: TableSchema,
  log: readonly LogEntry[],
  options: { readonly forcedEffective?: readonly { event: Seq; target: Target }[] } = {},
): LogEvaluation {
  const rec = emptyRecorded();
  const ops: Op[] = [];
  const pending = new Map<
    string,
    { op: OpNumber; sources: readonly SourceKey[]; before: Replay; beforeState: Evaluation }
  >();
  const steps: LogStep[] = [];
  const deletedNow = () => new Set<SourceKey>([...pending.values()].flatMap((d) => [...d.sources]));
  const replay = (deleted: ReadonlySet<SourceKey>) => {
    const r = new Replay(schema, ops, deleted, rec);
    r.run();
    return r;
  };
  let prev = replay(new Set());
  let prevState = prev.result();
  // A pending deletion removed the row or entity: writes to it are refused until it comes back.
  let removed = false;
  const fieldIds = (r: Replay) => r.fieldIds;

  for (const e of [...log].sort((a, b) => a.op - b.op)) {
    const deleted = deletedNow();
    if (e.kind === "deletion") {
      if (pending.has(e.id) || e.sources.some((x) => deleted.has(x))) {
        steps.push({ entry: e, refused: true, state: prevState });
        continue;
      }
      pending.set(e.id, { op: e.op, sources: e.sources, before: prev, beforeState: prevState });
      const r = replay(deletedNow());
      const state = r.result();
      rec.external.push(externalChange(e.op, prevState, state, fieldIds(r)));
      r.recordLatest();
      if (prevState.exists && !state.exists) removed = true;
      steps.push({ entry: e, refused: false, state });
      prev = r;
      prevState = state;
      continue;
    }
    if (e.kind === "cancel") {
      const d = pending.get(e.id);
      if (d === undefined) {
        steps.push({ entry: e, refused: true, state: prevState });
        continue;
      }
      pending.delete(e.id);
      const supersededBefore = new Set(rec.keptSuperseded);
      const rejudgedBefore = new Set(rec.rejudged.keys());
      const kept = cancelDeletion(
        rec,
        ops,
        d,
        e.op,
        prev,
        prevState,
        () => replay(deletedNow()),
        (key) => {
          // The operation from which the write has been in effect without interruption.
          let since: OpNumber = e.op;
          for (let i = steps.length - 1; i >= 0; i--) {
            const st = steps[i];
            if (st === undefined || st.refused) continue;
            const on = st.state.items.some(
              (x) => etKey(x.event, x.target) === key && effective(x.status as Status),
            );
            if (!on) break;
            since = st.entry.op;
          }
          return since;
        },
      );
      const r = replay(deletedNow());
      const state = r.result();
      rec.external.push(externalChange(e.op, prevState, state, fieldIds(r)));
      r.recordLatest();
      if (state.exists || pending.size === 0) removed = false;
      // Writes whose judgement changed because of the writes kept in effect: this replay
      // against the same replay without them.
      const knockOn: KnockOn[] = [];
      if (kept.length > 0) {
        const keys = kept.map((k) => etKey(k.event, k.target));
        for (const k of keys) rec.keptEffective.delete(k);
        const without = replay(deletedNow());
        for (const k of keys) rec.keptEffective.add(k);
        const judged = (x: Replay) =>
          new Map(
            [...new Set(x.items.map((i) => etKey(i.event, i.target)))].map((k) => {
              const [ev, t] = k.split("/") as [string, Target];
              return [k, x.statusOf(Number(ev), t).sort().join()];
            }),
          );
        const a = judged(r);
        const b = judged(without);
        for (const k of new Set([...a.keys(), ...b.keys()])) {
          if (keys.includes(k) || a.get(k) === b.get(k)) continue;
          const [ev, t] = k.split("/") as [string, Target];
          knockOn.push({
            event: Number(ev),
            target: t,
            before: b.get(k) ?? "none",
            after: a.get(k) ?? "none",
            because: kept,
          });
        }
      }
      const keptSuperseded = [...rec.keptSuperseded].filter((x) => !supersededBefore.has(x));
      const putBack = [...rec.rejudged.entries()]
        .filter(([k]) => !rejudgedBefore.has(k))
        .map(([k, judged]) => {
          const [ev, t] = k.split("/") as [string, Target];
          return { event: Number(ev), target: t, judged };
        });
      steps.push({
        entry: e,
        refused: false,
        state,
        keptEffective: kept,
        knockOn,
        keptSuperseded,
        putBack,
      });
      prev = r;
      prevState = state;
      continue;
    }
    if (refused(e, deleted, removed && pending.size > 0)) {
      steps.push({ entry: e, refused: true, state: prevState });
      continue;
    }
    ops.push(e);
    const r = replay(deleted);
    r.recordOp(e);
    const state = r.result();
    steps.push({ entry: e, refused: false, state });
    prev = r;
    prevState = state;
  }
  // The baseline of «撤回还原»: a replay of this log as written, with the given writes counted as
  // already in effect and so taking effect at their own write numbers. The write-time judgements
  // stay those of the log; only the final replay sees the forced set.
  const forced = options.forcedEffective ?? [];
  if (forced.length > 0) {
    for (const x of forced) rec.keptEffective.add(etKey(x.event, x.target));
    return { steps, final: replay(deletedNow()).result() };
  }
  return { steps, final: prevState };
}

/**
 * Requests refused while a deletion is pending (03-deletion «撤回与宽限期»): citing a source
 * pending deletion as evidence, or writing to a row or entity a pending deletion removed
 * (`not_found`: nothing is created, nothing revived). Resolving and confirming items is not a
 * write to the row and goes ahead.
 */
function refused(o: Op, deleted: ReadonlySet<SourceKey>, removed: boolean): boolean {
  const cites: SourceKey[] =
    o.kind === "write"
      ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
      : o.kind === "revoke"
        ? [...(o.validSources ?? [])]
        : [];
  if (cites.some((x) => deleted.has(x))) return true;
  return removed && (o.kind === "write" || o.kind === "revoke" || o.kind === "undo");
}

/** The version an operation saw: its `ver`, or the version just before it. */
function seenOf(o: Op): OpNumber {
  if (o.kind === "write" || o.kind === "revoke" || o.kind === "undo") return o.seen ?? o.op - 1;
  return o.op - 1;
}

/**
 * What a cancellation keeps from the grace period (03-deletion «撤回与宽限期»). The replay that
 * follows recomputes everything else as if the deletion had never been confirmed.
 */
function cancelDeletion(
  rec: Recorded,
  ops: readonly Op[],
  d: { op: OpNumber; sources: readonly SourceKey[]; before: Replay; beforeState: Evaluation },
  cancelOp: OpNumber,
  preCancel: Replay,
  preCancelState: Evaluation,
  replayAfter: () => Replay,
  effectiveSince: (key: string) => OpNumber,
): { event: Seq; target: Target }[] {
  const kept: { event: Seq; target: Target }[] = [];
  // The state without this deletion, every other pending deletion still applied: what this
  // deletion alone made effective shows against it.
  const withoutThis = replayAfter();
  const grace = ops.filter((o) => o.op > d.op && o.op < cancelOp);
  const inEffectAtWriteTime = (o: Op) =>
    [...rec.writeTime.entries()].some(
      ([key, xs]) => key.startsWith(`${o.event}/`) && xs.some((x) => effective(x.status)),
    );
  const ets = (r: Replay) => new Set(r.items.map((x) => etKey(x.event, x.target)));
  const pendingIn = (ev: Evaluation) =>
    new Set(ev.items.filter(pendingStatus).map((x) => etKey(x.event, x.target)));
  const wasPending = pendingIn(d.beforeState);
  const nowPending = pendingIn(preCancelState);

  for (const key of new Set([...ets(preCancel), ...ets(d.before)])) {
    const [ev, target] = key.split("/") as [string, Target];
    const event = Number(ev);
    const atWrite = rec.writeTime.get(key) ?? [];
    const madeEffective =
      atWrite.length > 0 &&
      !atWrite.some((x) => effective(x.status)) &&
      preCancel.statusOf(event, target).some(effective) &&
      !withoutThis.statusOf(event, target).some(effective);
    // Writes that took effect because of the deletion go back, unless a write in the grace
    // period took the version they made as its baseline (`kept_effective`): a write on this row
    // or entity, any field, with a ver not before the confirmation, that took effect (at write
    // time, by a person's decision, or as a corroboration; a write of only no-ops does not).
    // The protection lasts: from here on the write counts as already in effect (deviation two).
    // The baseline write comes after the write took effect and saw it: its ver is not earlier.
    const since = madeEffective ? effectiveSince(key) : Number.POSITIVE_INFINITY;
    if (
      madeEffective &&
      grace.some((y) => inEffectAtWriteTime(y) && y.op > since && seenOf(y) >= since)
    ) {
      rec.keptEffective.add(key);
      kept.push({ event, target });
      continue;
    }
    // Items the deletion superseded stay superseded when a grace-period write changed what they
    // concern, by the conflict criterion (`kept_superseded`); the others are restored.
    // The item counts as superseded by the deletion when no other candidate of the same unit
    // stayed pending and no grace-period resolution closed it (same modelling limit as below).
    const itemLives =
      [...wasPending].some(
        (other) => other !== key && other.endsWith(`/${target}`) && nowPending.has(other),
      ) || grace.some((y) => y.kind === "resolve" && (y.unit === target || y.unit === "existence"));
    if (wasPending.has(key) && !nowPending.has(key) && !itemLives) {
      const was = d.before.items.filter((x) => x.event === event && x.target === target);
      // "Changed" by the conflict criterion (09-references-conflict-sync «冲突判据» ②): the
      // grace-period write changed the unit's value in effect where the candidate lies, and the
      // candidate's value differs from the new one there. Corroborations and same-value writes do
      // not change the value in effect.
      const touched = grace.some((y) =>
        was.some((w) => {
          const fields = target === "existence" ? preCancel.fieldIds : [target];
          return fields.some((f) =>
            preCancel.changesSince(f, y.op - 1, y.op).some((c) => {
              const inter = intersect(c.changed, w.valid);
              if (isEmpty(inter)) return false;
              if (w.content.kind !== "value") return true;
              const mine = tok(w.content.value);
              return preCancel
                .segments([inter])
                .some((g) => covers(inter, g) && preCancel.vis(f, g, y.op) !== mine);
            }),
          );
        }),
      );
      if (touched) rec.keptSuperseded.add(event);
    }
  }

  // Candidates the deletion removed, of an item resolved in the grace period, are put back and
  // judged on the state at the cancellation: same value as in effect → no-op or corroboration,
  // otherwise a new conflict item. A re-judged candidate stays at its own write number.
  // Modelling limit: the evaluator does not track item identities, so "its item was resolved"
  // is taken as "a `resolve` on the same conflict unit in the grace period".
  const putBack = [...wasPending].filter((key) => {
    const [ev, target] = key.split("/") as [string, Target];
    const o = ops.find((x) => x.event === Number(ev));
    if (o?.kind !== "write" || target === "existence") return false;
    // Only candidates: an awaiting write the deletion removed comes back to its own item.
    const wasCandidate = d.beforeState.items.some(
      (x) => x.event === Number(ev) && x.target === target && x.status === "candidate",
    );
    if (!wasCandidate) return false;
    const input = o.fields[target];
    const sources = [...(input?.sources ?? []), ...(o.validSources ?? [])];
    return (
      sources.some((x) => d.sources.includes(x)) &&
      grace.some((y) => y.kind === "resolve" && (y.unit === target || y.unit === "existence"))
    );
  });
  if (putBack.length === 0) return kept;
  // Judged once, on the cancellation's replay with none of the put-back candidates in it yet;
  // the result is recorded and the replay that follows does not judge them again.
  for (const key of putBack) rec.rejudged.set(key, "dropped");
  const after = replayAfter();
  const afterState = after.result();
  for (const key of putBack) {
    const [ev, target] = key.split("/") as [string, FieldId];
    // Left out of this replay, the candidate is a shadow there: its value and the interval it
    // resolves to at its own write number.
    const item = after.shadows.find((x) => x.event === Number(ev) && x.target === target);
    const o = ops.find((x) => x.event === Number(ev));
    if (item === undefined || item.content.kind !== "value" || o?.kind !== "write") continue;
    const value = tok(item.content.value);
    const sets: IvSet[] = [item.valid, afterState.gaps];
    for (const x of afterState.fields[target] ?? []) sets.push(x.valid);
    const segs = (afterState.kind === "state" ? elementarySegments(endpoints(sets)) : [ALL]).filter(
      (g) => covers(item.valid, g),
    );
    const same = segs.every((g) => shownTok(afterState, target, g) === value);
    rec.rejudged.set(
      key,
      same ? (o.fields[target]?.explicit ? "corroborated" : "dropped") : "candidate",
    );
  }
  return kept;
}

/**
 * Evaluates one row or entity: `ops` are its operations (any order; replayed by operation
 * number), `deleted` the source data removed by one privacy deletion confirmed after all of them.
 */
export function evaluate(
  schema: TableSchema,
  ops: readonly Op[],
  deleted: Iterable<SourceKey> = [],
): Evaluation {
  const sources = [...new Set(deleted)];
  const last = Math.max(0, ...ops.map((o) => o.op));
  const log: LogEntry[] =
    sources.length > 0
      ? [...ops, { kind: "deletion", op: last + 1, id: "deletion", sources }]
      : [...ops];
  return evaluateLog(schema, log).final;
}

/** The write-time judgement alone: nothing deleted. */
export function evaluateAsWritten(schema: TableSchema, ops: readonly Op[]): Evaluation {
  return evaluateLog(schema, ops).final;
}
