// The reference evaluator: replay of one row or entity under a set of deleted source data.
//
// Written as the most literal implementation of the definition (03-deletion «删除结果的定义»):
// the state after a privacy deletion is the state obtained by replaying the log by operation
// number as if the deleted source data had never existed, with two deviations — people's
// decisions are executed as recorded, and writes that were already in effect stay in effect.
// Reverting (`undo`, `take_previous`) follows the pseudocode in 03-deletion «回掉的权威定义»
// step by step. Nothing here imports the kernel (02-architecture §11 «测试矩阵»).
//
// Two passes: the first replays with nothing deleted and is the write-time judgement (what the
// log records); the second replays with the deleted set and reads from the first only what the
// definition says is kept as recorded: revert records R and merge bases (03-deletion «回掉»
// ①、③), the statuses that deviation two protects, the fields judged no-op, and the item
// indices that step 6 keeps.
//
// Assumption: every deletion comes after every operation in the input; deletions interleaved
// with operations (and deletion cancellation) are not modelled. Under it the first pass is the
// write-time judgement, so "already in effect" (deviation two) means in effect at write time or
// by a person's decision, corroborations included; a write that took effect only through a
// deletion's recomputation is never protected. Once deletions may precede later operations, the
// first pass must replay the log in its real order, confirmed deletions included.

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

/** What the second pass keeps from the first (the log as written). */
interface Recorded {
  readonly items: ReadonlyMap<string, readonly { k: number; valid: IvSet; status: Status }[]>;
  readonly revertRecords: ReadonlyMap<OpNumber, readonly ItemRef[]>;
  readonly revertStatus: ReadonlyMap<OpNumber, RevertResult["status"]>;
  readonly mergeBases: ReadonlyMap<OpNumber, { mergeBase: OpNumber; k: readonly ItemRef[] }>;
  /** (event, field) judged a no-op at write time: stays a no-op in every replay. */
  readonly noops: ReadonlySet<string>;
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
  readonly rec: Recorded | null;

  constructor(
    schema: TableSchema,
    ops: readonly Op[],
    deleted: ReadonlySet<SourceKey>,
    rec: Recorded | null,
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
    this.closedCandidates = new Set(ops.flatMap((o) => (o.kind === "resolve" ? o.candidates : [])));
    this.resolvedAwaiting = new Set(
      ops.flatMap((o) => (o.kind === "confirm" || o.kind === "reject" ? [o.target] : [])),
    );
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
    if (this.rec === null) return undefined;
    const base = this.rec.items.get(etKey(event, target)) ?? [];
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
    if (this.rec === null) {
      fresh.forEach((it, i) => {
        it.k = i;
      });
      return;
    }
    const base = [...(this.rec.items.get(etKey(event, target)) ?? [])].sort((a, b) => a.k - b.k);
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
    return false;
  }

  /** Whether a revoke over `valid` meets a change in effect since `seen` (conflict criterion). */
  revokeConflicts(valid: IvSet, seen: number, cur: number): boolean {
    return this.fieldIds.some((f) =>
      this.changesSince(f, seen, cur).some((c) => !isEmpty(intersect(c.changed, valid))),
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
      if (o.noop?.includes(f) || this.rec?.noops.has(etKey(o.event, f))) continue;
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
    if (sameAsSeen && !input.explicit) {
      // Same value as seen, no evidence pointed at: not a contribution (03-deletion «贡献»). At
      // write time that is a no-op, kept as recorded; in a replay a former change becomes
      // `dropped`.
      if (this.rec === null) this.noops.add(etKey(o.event, f));
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
    return !this.items.some((x) => x.op > seen && x.op < o.op && effective(x.status));
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
    const rejected =
      this.rec !== null
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
      this.rec?.revertRecords.get(n) ?? this.undoRecord(o.target, o.includeLater ?? false, n);
    this.revert(o.event, n, record, { before: o.target }, null, (inScope, apply, rollback) => {
      const recStatus = this.rec?.revertStatus.get(n);
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
        this.rec?.revertRecords.get(o.op) ??
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
    let rec = this.rec?.mergeBases.get(n);
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
    const record = this.rec?.revertRecords.get(n) ?? this.revertRecords.get(n) ?? [];
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
      if (this.rec === null) return false;
      const base = this.rec.items.get(etKey(x.event, x.target)) ?? [];
      return !base.some((b) => b.k === x.k);
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
    }));
    // Items of the first pass that are no longer items and were not deleted: `dropped`.
    if (this.rec !== null) {
      const present = new Set(this.items.map(refKey));
      for (const [et, base] of this.rec.items) {
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

  recorded(): Recorded {
    const items = new Map<string, { k: number; valid: IvSet; status: Status }[]>();
    for (const x of this.items) {
      const key = etKey(x.event, x.target);
      items.set(key, [...(items.get(key) ?? []), { k: x.k, valid: x.valid, status: x.status }]);
    }
    return {
      items,
      revertRecords: this.revertRecords,
      revertStatus: this.revertStatus,
      mergeBases: this.mergeBases,
      noops: new Set([
        ...this.noops,
        ...this.ops.flatMap((o) =>
          o.kind === "write" ? (o.noop ?? []).map((f) => etKey(o.event, f)) : [],
        ),
      ]),
    };
  }
}

/** Step 3, "x 取代 r". */
function supersedes(x: Item, r: Item): boolean {
  const xIsFieldValue = x.target !== "existence" && x.content.kind === "value";
  if (r.content.kind === "revoke") return x.content.kind === "restore" || xIsFieldValue;
  if (r.content.kind === "restore") return x.content.kind === "revoke";
  return (x.target === r.target && x.content.kind !== "uncovered") || x.content.kind === "revoke";
}

/**
 * Evaluates one row or entity: `ops` are its operations (any order; replayed by operation
 * number), `deleted` the source data removed by privacy deletion.
 */
export function evaluate(
  schema: TableSchema,
  ops: readonly Op[],
  deleted: Iterable<SourceKey> = [],
): Evaluation {
  const base = new Replay(schema, ops, new Set(), null);
  base.run();
  const replay = new Replay(schema, ops, new Set(deleted), base.recorded());
  replay.run();
  return replay.result();
}

/** The write-time judgement alone (the first pass), for comparing with a replay. */
export function evaluateAsWritten(schema: TableSchema, ops: readonly Op[]): Evaluation {
  const base = new Replay(schema, ops, new Set(), null);
  base.run();
  return base.result();
}
