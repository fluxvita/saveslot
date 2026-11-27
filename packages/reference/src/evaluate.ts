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
// record only what the definition keeps: revert records R by (event, target) and merge bases
// (03-deletion «回掉» ①、③), the write-time statuses deviation two protects ("already in effect" = in effect at
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
  RejectionReason,
  ResolveOp,
  RevertEntry,
  RevertResult,
  RevokeOp,
  SourceKey,
  SyncFieldResult,
  SyncOutcome,
  TableSchema,
  UndoOp,
  ValidParam,
  WriteOp,
} from "./model.ts";
import { stateWithoutIndices } from "./views.ts";

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
  /**
   * A candidate put back by a cancellation and judged a corroboration (03-deletion «撤回与宽限期»):
   * it only closes the candidate and adds sources. No endpoints, gives no blocking points.
   */
  readonly putBack?: true;
  /** A put-back corroboration whose value is gone: the candidate the grace-period decision closed. */
  readonly closedByDecision?: true;
}

/** An interval block of an item as given by an event. */
interface Block {
  readonly k: number;
  readonly valid: IvSet;
}

/** One block in an item's history: who gave it; `dropped`: a restatement as dropped (no block). */
type HistoryEntry = Block & { readonly by: string; readonly dropped?: true };

/**
 * The block of each index as last given before this replay (03-deletion «回掉的权威定义» step 6,
 * 09 §5.7): going back in log order, blocks given by the confirmation of a deletion cancelled
 * since and restatements as dropped are skipped; the first block that gives an interval counts.
 * `alsoSkip`: one more deletion whose blocks to skip.
 */
function latestBlocks(rec: Recorded, key: string, alsoSkip?: string): Block[] {
  const out = new Map<number, Block>();
  const done = new Set<number>();
  const hist = rec.history.get(key) ?? [];
  for (let i = hist.length - 1; i >= 0; i--) {
    const h = hist[i] as HistoryEntry;
    if (done.has(h.k)) continue;
    if (h.dropped || rec.cancelled.has(h.by) || h.by === alsoSkip) continue;
    // Removed by a deletion carried out since (its list of positions): not readable.
    if (rec.removed.has(`${key}#${i}`)) continue;
    out.set(h.k, { k: h.k, valid: h.valid });
    done.add(h.k);
  }
  return [...out.values()];
}

/**
 * What a replay keeps from the log as written: the judgement each operation got at its own point
 * in the log (with the deletions confirmed and not cancelled by then), and what deletion events
 * recorded. Operations not in `judged` are judged afresh by the replay.
 */
interface Recorded {
  readonly judged: Set<OpNumber>;
  /**
   * Item statuses and interval blocks at write time: what deviation two protects (judged on the
   * write-time blocks, not on surviving indices); original indices and where they land (step 6).
   */
  readonly writeTime: Map<string, (Block & { status: Status; content: ItemContent })[]>;
  /**
   * Every interval block each item was given, in log order: by its write, by deletion
   * confirmations (`by`: the deletion ID) and by cancellations (`by`: "cancel"); `dropped` marks
   * a restatement as dropped. The block as last given is read from it (`latestBlocks`).
   */
  readonly history: Map<string, HistoryEntry[]>;
  /** Deletions cancelled so far: their confirmations' blocks never count (step 6). */
  readonly cancelled: Set<string>;
  readonly revertRecords: Map<OpNumber, RevertEntry[]>;
  readonly revertStatus: Map<OpNumber, RevertResult["status"]>;
  /** An undo rejected because the row stays revoked (`revoked`), as judged when written. */
  readonly revertRejectedRevoked: Set<OpNumber>;
  /** A resolution's merge base, recorded when it was judged and not recomputed. */
  readonly mergeBases: Map<OpNumber, { mergeBase: OpNumber }>;
  /** take_candidate: the cover set O, listed like a take_previous record (09 §5.8 `take`). */
  readonly coverSets: Map<OpNumber, RevertEntry[]>;
  /**
   * take_candidate on a field unit, state table: the revokes in effect over its range when it was
   * judged, by (event, target), and nothing of their intervals (03-deletion «搬运的值»: a filled
   * revoke is judged as a whole). In a replay a revoke listed here covers the take nowhere; one
   * outside O not listed covers it wholly. The kernel records it with the resolution
   * (`take.filled`).
   */
  readonly takeFilled: Map<OpNumber, Set<string>>;
  /**
   * A person's decision on items, by its operation (the kind is the operation's): for a conflict
   * resolution the (event, target) of the item's candidates as they were when it was judged, on
   * the history at that point (K: the taken ones and those it closed without taking); for a
   * confirmation or rejection those of the write's items awaiting confirmation then. In every
   * replay a decided (event, target) is as that decision recorded it (01-objects «处理之后事项不重开»).
   */
  readonly decidedItems: Map<OpNumber, Set<string>>;
  /**
   * take_candidate made while deletions were pending: the items in effect with those deletions
   * cancelled that the pending deletions had removed, by (event, target), with their intervals
   * then. Should a deletion be cancelled, what it brings back of these does not cover the take,
   * within those intervals (a take is a write in the grace period, 03-deletion «撤回与宽限期»).
   */
  readonly takeRestorable: Map<OpNumber, Map<string, IvSet>>;
  /**
   * Candidate fields as first judged, by (event, field): whether the field's conflict met a revoke
   * in effect over it. A write's candidates on a conflict unit belong to the item on existence when
   * any field of the unit met one (09 §5.8, as judge records it); read as recorded in every replay.
   */
  readonly metRevoke: Map<string, boolean>;
  /** (event, field) judged a no-op at write time: stays a no-op in every replay. */
  readonly noops: Set<string>;
  /** (event, target) a cancellation kept in effect (`kept_effective`). */
  readonly keptEffective: Set<string>;
  /** Events whose pending items a cancellation kept superseded (`kept_superseded`). */
  readonly keptSuperseded: Set<Seq>;
  /** Candidates put back by a cancellation after their item was resolved, judged at that point. */
  readonly rejudged: Map<string, "dropped" | "corroborated" | "candidate">;
  /** The cancellation that judged each put-back candidate: its corroboration is judged as of it. */
  readonly rejudgedAt: Map<string, OpNumber>;
  /** Deletion confirmations and cancellations, with where they changed each field's value. */
  readonly external: External[];
  /** The operation number of each deletion confirmed, by its ID (L's record on a list, 09 §3.5 rule 1). */
  readonly deletionOp: Map<string, OpNumber>;
  /**
   * The (event, target) each deletion restates on its own, by its ID: on the replay with the
   * deletions carried out by then and this one, against the replay with those carried out alone.
   * Its list of positions is its own, apart from the other pending deletions (03-deletion «多项删除
   * 各自列全位置»): the restatements of its event, made with them, do not tell it.
   */
  readonly restatedAlone: Map<string, Set<string>>;
  /**
   * Given by the caller (`evaluateLog` option `forcedWhole`): for a deletion event's operation and
   * the deleted set of a replay, the units whose record is on a current deletion's list of
   * positions — taken instead of `restsOnDeleted`, which approximates the list by ends.
   */
  forcedWhole?: (op: OpNumber, deleted: ReadonlySet<SourceKey>) => ReadonlySet<Target> | undefined;
  /** Told, where `forcedWhole` decides, what the approximation by ends would have said. */
  observeWhole?: (
    op: OpNumber,
    deleted: ReadonlySet<SourceKey>,
    unit: Target,
    byEnds: boolean,
  ) => void;
  /**
   * Interval blocks removed by a deletion carried out (`execute`), as `<event>/<target>#<index in
   * history>`: what its list of positions held, by the approximation of `removedBy`.
   */
  readonly removed: Set<string>;
}

function emptyRecorded(): Recorded {
  return {
    judged: new Set(),
    writeTime: new Map(),
    history: new Map(),
    removed: new Set(),
    cancelled: new Set(),
    revertRecords: new Map(),
    revertStatus: new Map(),
    revertRejectedRevoked: new Set(),
    mergeBases: new Map(),
    coverSets: new Map(),
    takeFilled: new Map(),
    decidedItems: new Map(),
    takeRestorable: new Map(),
    metRevoke: new Map(),
    noops: new Set(),
    keptEffective: new Set(),
    keptSuperseded: new Set(),
    rejudged: new Map(),
    rejudgedAt: new Map(),
    external: [],
    deletionOp: new Map(),
    restatedAlone: new Map(),
  };
}

const INF = Number.MAX_SAFE_INTEGER;

/**
 * How often original items of one (event, target) landed in one new item and merged (09 §5.7):
 * for occurrence checks in tests only.
 */
export const segmentStats = { merged: 0, removed: 0, reused: 0 };
const NO_VALUE = "novalue";

const refKey = (r: { event: Seq; target: Target; k: number }) => `${r.event}/${r.target}/${r.k}`;
const etKey = (event: Seq, target: Target) => `${event}/${target}`;
const refOf = (it: Item): ItemRef => ({ event: it.event, target: it.target, k: it.k });
/** A value as read: empty reads as no contribution does (10-types-and-units «清空字段»). */
const tok = (v: FieldValue) => (v === null ? "none" : `v:${canonicalize(v as JcsValue)}`);
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
  /** Set by `write` for the write being judged: where it makes the entity begin to exist. */
  creating: (s: Iv, at: number) => boolean = () => false;
  readonly items: Item[] = [];
  /** Same-valued contributions that are no longer items, kept for the domain of step 2. */
  readonly shadows: Item[] = [];
  readonly regs = new Map<string, Registration[]>();
  readonly reverts: RevertResult[] = [];
  readonly revertRecords = new Map<OpNumber, RevertEntry[]>();
  readonly revertStatus = new Map<OpNumber, RevertResult["status"]>();
  readonly rejectedRevoked = new Set<OpNumber>();
  readonly mergeBases = new Map<OpNumber, { mergeBase: OpNumber }>();
  readonly coverSets = new Map<OpNumber, RevertEntry[]>();
  /** Conflict units (fields joined by ",") a field of the write being judged conflicted on. */
  readonly unitsInConflict = new Set<string>();
  /** Units judged as in conflict (conflict criterion ⑤), while a write's group is judged again. */
  readonly forcedUnits = new Set<string>();
  readonly takeFilled = new Map<OpNumber, Set<string>>();
  readonly decidedItems = new Map<OpNumber, Set<string>>();
  /** Candidate fields judged in this replay: whether the conflict met a revoke (see `Recorded`). */
  readonly metRevoke = new Map<string, boolean>();
  /** Resolutions rejected: a take_candidate of a modification with a required field nowhere. */
  readonly rejections: { op: OpNumber; reason: RejectionReason }[] = [];
  readonly noops = new Set<string>();
  readonly fieldIds: FieldId[];
  /** Conflict resolutions: what each closed is its recorded items (`Recorded.decidedItems`). */
  readonly resolves: readonly ResolveOp[];
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
    this.resolves = ops.filter((o): o is ResolveOp => o.kind === "resolve");
    this.resolvedAwaiting = new Set([
      ...ops.flatMap((o) => (o.kind === "confirm" || o.kind === "reject" ? [o.target] : [])),
      ...rec.keptSuperseded,
    ]);
    this.opsByEvent = new Map(ops.map((o) => [o.event, o]));
  }

  get isState(): boolean {
    return this.schema.kind === "state";
  }

  /** Whether a decision closed the candidate of write `event` on `target`. */
  /** Whether a person's confirmation or rejection recorded the awaiting item of `event` on `target`. */
  listedByConfirmation(event: Seq, target: Target): boolean {
    const key = etKey(event, target);
    return this.ops.some(
      (o) =>
        (o.kind === "confirm" || o.kind === "reject") &&
        (this.rec.decidedItems.get(o.op) ?? this.decidedItems.get(o.op))?.has(key),
    );
  }

  /** Whether a person's resolution recorded the candidate of write `event` on `target` in its item. */
  listedByResolution(event: Seq, target: Target): boolean {
    const key = etKey(event, target);
    return this.resolves.some((o) =>
      (this.rec.decidedItems.get(o.op) ?? this.decidedItems.get(o.op))?.has(key),
    );
  }

  closedCandidate(event: Seq, target: Target): boolean {
    if (this.rec.keptSuperseded.has(event)) return true;
    const key = etKey(event, target);
    return this.resolves.some((o) => {
      const recorded = this.rec.decidedItems.get(o.op) ?? this.decidedItems.get(o.op);
      if (recorded !== undefined) return recorded.has(key);
      // Not judged yet in this evaluation: by its candidates and unit, until it records its items.
      if (!o.candidates.includes(event)) return false;
      return target === "existence" || this.onExistence(event, target)
        ? o.unit === "existence"
        : o.unit !== "existence" && inUnit(o.unit, target);
    });
  }
  /** The conflict unit of field `f`: its group, or the field alone. */
  unitOf(f: FieldId): readonly FieldId[] {
    return this.schema.groups?.find((g) => g.includes(f)) ?? [f];
  }

  /**
   * Whether the candidates of (event, field f) belong to the item on existence: some field of f's
   * unit met a revoke when first judged (as recorded). A field never judged a candidate when
   * written (awaiting then, a candidate only in a replay) has no record: its conflict in this
   * replay decides. A candidate a person's resolution recorded belongs to that resolution's item
   * first (03-deletion «重放规则 · 人的决定»): its conflict is not judged again in a replay, and
   * what made it meet a revoke may be gone.
   */
  onExistence(event: Seq, f: Target): boolean {
    if (f === "existence") return true;
    for (const g of this.unitOf(f)) {
      const key = etKey(event, g);
      const by = this.resolves.find((o) =>
        (this.rec.decidedItems.get(o.op) ?? this.decidedItems.get(o.op))?.has(key),
      );
      if (by !== undefined) return by.unit === "existence";
    }
    return this.unitOf(f).some((g) => {
      const key = etKey(event, g);
      return this.rec.metRevoke.get(key) ?? this.metRevoke.get(key) ?? false;
    });
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
      if (!isField && !this.liveRevoke(it, seg, limit)) continue;
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
    const st = this.fieldState(f, seg, limit);
    // Where the entity has a value, a field the filling writes did not give is empty, not a hole
    // (05-time «无值区间»: 可选字段不带就是空).
    if (this.isState && st.kind === "hole") return "none";
    return stateTok(st);
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
   * The change points high impact ① protects (05-time «高影响写入»): a value ↔ no value boundary
   * counts only on the fields that define "has a value" (the required fields; every field when
   * none is required); the other fields are compared only between points where the entity has a
   * value, value ↔ empty still being a change.
   */
  impactChangePoints(f: FieldId, limit: number): Point[] {
    const defines = this.schema.required.length === 0 || this.schema.required.includes(f);
    const segs = this.segments();
    const out: Point[] = [];
    for (let i = 1; i < segs.length; i++) {
      const a = segs[i - 1];
      const b = segs[i];
      if (a === undefined || b === undefined || b.from === null) continue;
      const va = this.vis(f, a, limit);
      const vb = this.vis(f, b, limit);
      if (!defines && (va === NO_VALUE || vb === NO_VALUE)) continue;
      if (va !== vb) out.push(b.from);
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
   * The write-time status of (event, target) as a unit, the write on the target (03-deletion
   * «删除结果的定义» deviation two): "effective" when every item of it was in effect when written,
   * corroborations included, or it was kept in effect by a cancellation; otherwise the status of
   * an item not in effect (candidate first, then awaiting), and every item is judged again in the
   * replay. A write that took effect only through a deletion's recomputation is not protected.
   * `_valid` is not read: the unit has no interval (`writeTimeStatusAt` asks of a stretch).
   */
  recordedStatus(event: Seq, target: Target, _valid: IvSet): "effective" | Status | undefined {
    if (this.rec.keptEffective.has(etKey(event, target))) return "effective";
    const base = this.rec.writeTime.get(etKey(event, target));
    if (base === undefined) return undefined;
    // The unit is the write on the target, not an interval (03-deletion «删除结果的定义» deviation
    // two): protected only when every item of it was in effect when written; one that was not
    // makes the whole of it judged in the replay.
    const pool = base;
    if (pool.some((b) => b.status === "candidate")) return "candidate";
    if (pool.some((b) => b.status === "awaiting")) return "awaiting";
    if (pool.some((b) => effective(b.status))) return "effective";
    return undefined;
  }

  /**
   * The write-time status of the part of (event, target) intersecting `valid`: whether that part
   * was a candidate when written. Not deviation two (`recordedStatus` judges that by the unit):
   * the sameness rule asks it of a stretch, a candidate when written now the same as the value
   * before it still counting as the candidate a resolution took or kept (`kOf`).
   */
  writeTimeStatusAt(event: Seq, target: Target, valid: IvSet): Status | undefined {
    const key = etKey(event, target);
    const base = this.rec.writeTime.get(key);
    if (base === undefined) return undefined;
    // The status is the write's own (its status blocks go only with its own sources). The
    // interval of an item's write-time block is not to be trusted once a contribution giving one
    // of its ends is in the deleted set (pending or carried out alike: by the deleted set, not by whether it ran): then it is read from the
    // block as last given. Approximated by ends: an end neither the write's own (its start, its
    // explicit ends) nor an end of any item of this replay that may give it.
    const latest = latestBlocks(this.rec, key);
    const own = this.items.filter((x) => etKey(x.event, x.target) === key);
    const ownEnds = new Set(
      own.flatMap((x) => [...(x.from !== null ? [x.from] : []), ...x.explicitEnds]),
    );
    const others = [...this.items, ...this.shadows].filter(
      (x) => etKey(x.event, x.target) !== key && mayGiveEnd(x, target, this.schema.required),
    );
    const at = (b: { k: number; valid: IvSet }) => {
      const ends = b.valid.flatMap((v) => [v.from, v.to]).filter((q): q is Point => q !== null);
      const lost = ends.some((q) => !ownEnds.has(q) && !others.some((x) => endsAt(x, q)));
      return lost ? (latest.find((l) => l.k === b.k)?.valid ?? b.valid) : b.valid;
    };
    const hit = base.filter((b) => !isEmpty(intersect(at(b), valid)));
    const pool = hit.length > 0 ? hit : base;
    if (pool.some((b) => b.status === "candidate")) return "candidate";
    if (pool.some((b) => b.status === "awaiting")) return "awaiting";
    return pool.find((b) => effective(b.status))?.status;
  }

  /**
   * Indices of new items of one (event, target), sorted by start (03-deletion «回掉的权威定义»
   * step 6, 09 §5.7). First pass: from 0 by start. Later passes: an item that existed keeps its
   * index and stays on the first new item intersecting its write-time block (an index first given
   * by a deletion: its block as last given); when several land on the same new item they merge
   * into one, the smallest index stays and the others are dropped. New items continue after the
   * largest index used. Reverts cover by (event, target), so items are never cut apart by what
   * covers them.
   */
  assignIndices(event: Seq, target: Target, fresh: Item[]): Item[] {
    fresh.sort((a, b) => ((a.valid[0]?.from ?? "") < (b.valid[0]?.from ?? "") ? -1 : 1));
    const key = etKey(event, target);
    const base = latestBlocks(this.rec, key).sort((a, b) => a.k - b.k);
    const writeTime = this.rec.writeTime.get(key) ?? [];
    const hist = this.rec.history.get(key) ?? [];
    // The write-time block, unless a deletion carried out removed it: then the block as last
    // given, as for an index a deletion gave (09 §5.7).
    const writeTimeOf = (k: number): IvSet | undefined => {
      const i = hist.findIndex((h) => h.by === "write" && h.k === k);
      if (i >= 0 && this.rec.removed.has(`${key}#${i}`)) return undefined;
      return writeTime.find((w) => w.k === k)?.valid;
    };
    const landing = new Map<Item, { k: number; valid: IvSet }[]>();
    for (const b of base) {
      const at = writeTimeOf(b.k) ?? b.valid;
      const hit = fresh.find((it) => !isEmpty(intersect(it.valid, at)));
      if (hit !== undefined) landing.set(hit, [...(landing.get(hit) ?? []), b]);
    }
    for (const it of fresh) {
      const originals = landing.get(it) ?? [];
      if (originals.length > 1) segmentStats.merged++;
      it.k = originals[0]?.k ?? -1;
    }
    // An original index with no readable block left (every block of it removed by deletions
    // carried out; restated as dropped, now a contribution again) takes its number back, by
    // start, before new numbers are given.
    const readable = new Set(base.map((b) => b.k));
    const back = [
      ...new Set(
        hist
          .filter(
            (h, i) =>
              !h.dropped && !this.rec.cancelled.has(h.by) && this.rec.removed.has(`${key}#${i}`),
          )
          .map((h) => h.k),
      ),
    ]
      .filter((k) => !readable.has(k))
      .sort((a, b) => a - b);
    let next = Math.max(-1, ...base.map((b) => b.k), ...back) + 1;
    for (const it of fresh) {
      if (it.k >= 0) continue;
      const k = back.shift();
      if (k !== undefined) segmentStats.reused++;
      it.k = k ?? next++;
    }
    return fresh;
  }

  push(fresh: Item[]): void {
    const groups = new Map<string, Item[]>();
    for (const it of fresh) {
      const key = etKey(it.event, it.target);
      groups.set(key, [...(groups.get(key) ?? []), it]);
    }
    for (const g of groups.values()) {
      const first = g[0];
      if (first !== undefined) this.items.push(...this.assignIndices(first.event, first.target, g));
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
    met?: { revoke: boolean },
    o?: WriteOp,
  ): boolean {
    if (o !== undefined && this.unitOf(f).length > 1) {
      return this.groupConflicts(o, f, value, seenValid, defaultEnd, from, seen, cur, met);
    }
    let found = false;
    // The conflict met a revoke when one of the conflicting operations has a revoke in effect over
    // the part (as judge's conflict record has it).
    const note = (op: number, part: IvSet) => {
      found = true;
      if (met !== undefined && !met.revoke) {
        met.revoke = this.items.some(
          (x) =>
            x.op === op &&
            x.status === "applied" &&
            x.content.kind === "revoke" &&
            !isEmpty(intersect(x.valid, part)),
        );
      }
    };
    for (const l of this.changesSince(f, seen, cur)) {
      if (!this.isState) {
        note(l.op, [ALL]);
        if (met === undefined) return true;
        continue;
      }
      const lItems = this.items.filter(
        (x) =>
          x.op === l.op && x.status === "applied" && (x.target === f || x.target === "existence"),
      );
      const lField = lItems.filter((x) => x.target === f);
      if (defaultEnd && lField.length > 0 && lField.every((x) => x.defaultEnd)) {
        const lv = lField[0];
        if (lv !== undefined && lv.from === from && lv.content.kind === "value") {
          if (tok(lv.content.value) !== value) {
            note(l.op, seenValid);
            if (met === undefined) return true;
          }
        }
        continue;
      }
      const lValid = lItems.length > 0 ? union(...lItems.map((x) => x.valid)) : l.changed;
      const inter = intersect(seenValid, lValid);
      if (this.segments([inter]).some((s) => covers(inter, s) && this.vis(f, s, cur) !== value)) {
        note(l.op, seenValid);
        if (met === undefined) return true;
      }
    }
    if (found) return true;
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

  /**
   * The conflict criterion on a field group (09-references-conflict-sync «冲突单元», «组值»): an
   * operation L after V that changed any field of the group meets W where the group value differs.
   * W's group value: for each field of the group, W's value where W gives it (and it is not a
   * no-op or deleted), else the value in V; the current group value: each field's value now. A
   * default end against a default end compares W's group value with the group value L left at the
   * start. The same-value step (①) stays field by field: this judges only what reaches `ordinary`.
   */
  groupConflicts(
    o: WriteOp,
    f: FieldId,
    value: string,
    seenValid: IvSet,
    defaultEnd: boolean,
    from: Point | null,
    seen: number,
    cur: number,
    met?: { revoke: boolean },
  ): boolean {
    const unit = this.unitOf(f);
    const given = (h: FieldId) => {
      const input = o.fields[h];
      return input !== undefined &&
        !o.noop?.includes(h) &&
        !this.rec.noops.has(etKey(o.event, h)) &&
        !this.isDeleted(input.sources)
        ? tok(input.value)
        : undefined;
    };
    // W's group value at a point (09-references «冲突判据», 组值): a field W wrote whose own seen
    // interval holds the point gives W's value; the others, those W did not write and those it
    // wrote whose seen interval does not hold the point, the value in V. Each field's seen interval
    // is resolved on its own (a default end stops at that field's next change in V).
    const seenOf = new Map<FieldId, IvSet>();
    const seenValidOf = (h: FieldId) => {
      let x = seenOf.get(h);
      if (x === undefined) {
        x = h === f ? seenValid : (this.resolve(o.valid, h, seen, o.now)?.valid ?? []);
        seenOf.set(h, x);
      }
      return x;
    };
    // W's side of the group value (09-references «组值»): a field W did not write takes its value
    // in V, and where V has no value it is empty, as W's write leaves the entity there. The current
    // side is as it is: no value there is the entity not being there, not an empty field.
    const asGroup = (t: string) => (t === NO_VALUE ? "none" : t);
    const mine = (h: FieldId, s: Iv) => {
      if (h === f) return value;
      const w = given(h);
      return w !== undefined && covers(seenValidOf(h), s) ? w : asGroup(this.vis(h, s, seen));
    };
    const differs = (s: Iv, at: number) => unit.some((h) => this.vis(h, s, at) !== mine(h, s));
    let found = false;
    const note = (op: number, part: IvSet) => {
      found = true;
      if (met !== undefined && !met.revoke) {
        met.revoke = this.items.some(
          (x) =>
            x.op === op &&
            x.status === "applied" &&
            x.content.kind === "revoke" &&
            !isEmpty(intersect(x.valid, part)),
        );
      }
    };
    // The operations that changed some field of the group, each with where it changed one.
    const byOp = new Map<number, IvSet[]>();
    for (const h of unit) {
      for (const c of this.changesSince(h, seen, cur)) {
        byOp.set(c.op, [...(byOp.get(c.op) ?? []), c.changed]);
      }
    }
    for (const [op, changed] of [...byOp].sort((a, b) => a[0] - b[0])) {
      if (!this.isState) {
        note(op, [ALL]);
        if (met === undefined) return true;
        continue;
      }
      const lItems = this.items.filter(
        (x) =>
          x.op === op &&
          x.status === "applied" &&
          (x.target === "existence" || unit.includes(x.target as FieldId)),
      );
      const lFields = lItems.filter((x) => x.target !== "existence");
      if (defaultEnd && lFields.length > 0 && lFields.every((x) => x.defaultEnd)) {
        if (lFields.some((x) => x.from === from)) {
          const start = this.segments([seenValid]).find((g) => covers(seenValid, g));
          if (start !== undefined && differs(start, op)) {
            note(op, seenValid);
            if (met === undefined) return true;
          }
        }
        continue;
      }
      const lValid = lItems.length > 0 ? union(...lItems.map((x) => x.valid)) : union(...changed);
      const inter = intersect(seenValid, lValid);
      if (this.segments([inter]).some((g) => covers(inter, g) && differs(g, cur))) {
        note(op, seenValid);
        if (met === undefined) return true;
      }
    }
    if (found) return true;
    for (const h of unit) {
      for (const changed of this.externalChanges(h, seen, cur)) {
        if (!this.isState) return true;
        const inter = intersect(seenValid, changed);
        if (this.segments([inter]).some((g) => covers(inter, g) && differs(g, cur))) return true;
      }
    }
    return false;
  }

  /** Where deletion events after `seen` and up to `cur` changed the value of `f`. */
  externalChanges(f: FieldId, seen: number, cur: number): IvSet[] {
    // Where the event's record of the change on the unit rests on a contribution in the deleted
    // set (pending or carried out: its blocks are on that deletion's list), the record is not to
    // be trusted and the event counts as a change over the whole unit (09-references «冲突判据»,
    // L's interval). By the deleted set, not by whether the deletion was carried out, so that the
    // result depends on the log and the deleted set only.
    return this.rec.external
      .filter((e) => e.op > seen && e.op <= cur)
      .map((e) => (this.wholeOn(e, f) ? [ALL] : (e.changed.get(f) ?? [])))
      .filter((c) => !isEmpty(c));
  }

  /** Whether deletion event `e` counts as changing `unit` whole in this replay. */
  wholeOn(e: External, unit: Target): boolean {
    const forced = this.rec.forcedWhole?.(e.op, this.deleted);
    if (forced !== undefined) {
      this.rec.observeWhole?.(
        e.op,
        this.deleted,
        unit,
        this.restsOnDeleted(e.deps.get(unit), e.op),
      );
      return forced.has(unit);
    }
    return this.restsOnDeleted(e.deps.get(unit), e.op);
  }

  /**
   * Whether the record of a deletion event (operation `op`) resting on these (event, target) is on
   * the list of positions of a deletion in the current deleted set (09-references «冲突判据», L's
   * interval, by 09 §3.5 rule 1): one of them is deleted (in this replay it has no item: present
   * when the record was made, absent now), or a deletion confirmed after it, not cancelled,
   * restated it. Asked while judging a later operation, when every earlier operation is in.
   */
  restsOnDeleted(deps: ReadonlySet<string> | undefined, op: OpNumber): boolean {
    if (deps === undefined || deps.size === 0) return false;
    const here = new Set([...this.items, ...this.shadows].map((x) => etKey(x.event, x.target)));
    const restatedAfter = (k: string) =>
      [...this.rec.restatedAlone].some(
        ([by, keys]) =>
          keys.has(k) && !this.rec.cancelled.has(by) && (this.rec.deletionOp.get(by) ?? 0) > op,
      );
    // "Restated" is the other half of 09 §3.5 rule 1, by what the later deletion restates on its
    // own (`restatedAlone`), not by its event's restatements: those are made with the other
    // pending deletions, and one cancelled since would leave its share behind. Under `forcedWhole`
    // this is not asked at all.
    return [...deps].some((k) => !here.has(k) || restatedAfter(k));
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
        const s = new Set(this.impactChangePoints(f, seen));
        return [f, this.impactChangePoints(f, cur).filter((p) => s.has(p))];
      }),
    );
    // A value ↔ no value boundary is a change of the fields that define "has a value" together:
    // gone only when none of them differs across it any more (05-time «高影响写入»). Every other
    // change point is the field's own.
    const defines = (f: FieldId) =>
      this.schema.required.length === 0 || this.schema.required.includes(f);
    const sides = (p: Point): [Iv, Iv] | undefined => {
      const segs = this.segments();
      const i = segs.findIndex((s) => s.from === p);
      const a = segs[i - 1];
      const b = segs[i];
      return a === undefined || b === undefined ? undefined : [a, b];
    };
    const boundary = new Set(
      [...before.values()].flat().filter((p) => {
        const s = sides(p);
        return s !== undefined && this.hasValue(s[0], cur) !== this.hasValue(s[1], cur);
      }),
    );
    apply();
    const after = new Map(this.fieldIds.map((f) => [f, new Set(this.impactChangePoints(f, n))]));
    const stillChanges = (p: Point) => {
      const s = sides(p);
      return (
        s !== undefined &&
        this.fieldIds.filter(defines).some((g) => this.vis(g, s[0], n) !== this.vis(g, s[1], n))
      );
    };
    const gone = (f: FieldId, p: Point) =>
      defines(f) && boundary.has(p) ? !stillChanges(p) : !after.get(f)?.has(p);
    const out = this.fieldIds.some((f) => (before.get(f) ?? []).some((p) => gone(f, p)));
    rollback();
    return out;
  }

  // -------------------------------------------------------------------------------------------
  // Operations.

  /**
   * A sync contribution (09-references-conflict-sync «冲突判据»): an item a write by source key
   * gave, whatever its status, or the item a take_candidate carried out of one. Not a write-back
   * of `undo` or `take_previous`: those are values a person's handling brought back.
   */
  isSync(x: Item): boolean {
    if (x.content.kind !== "value") return false;
    const o = this.opsByEvent.get(x.event);
    if (o?.kind === "write") return o.byKey === true;
    if (o?.kind !== "resolve" || o.decision !== "take_candidate") return false;
    return (x.carried ?? []).some((c) => {
      const from = this.opsByEvent.get(c.event);
      return from?.kind === "write" && from.byKey === true;
    });
  }

  /**
   * The sync baseline of field `f` for operation `n` (09-references-conflict-sync «冲突判据»): the
   * value of the latest sync contribution, and the operation of the latest one in effect (applied
   * or corroborated, not registered as reverted); with none in effect, the operation the row got
   * its key from (the write by key that created it, or the key added to it); with none of those
   * either (the op creating the row), the state just before `n`.
   */
  syncBaseline(
    f: FieldId,
    n: OpNumber,
  ): { readonly has: boolean; readonly value: FieldValue; readonly position: OpNumber } {
    const sync = this.items
      .filter((x) => x.target === f && x.op < n && this.isSync(x))
      .sort((a, b) => a.op - b.op);
    const last = sync.at(-1);
    const inEffect = sync.filter((x) => effective(x.status) && isEmpty(this.registeredSet(x, n)));
    const keyed = this.ops
      .filter(
        (o): o is WriteOp =>
          o.kind === "write" && o.op < n && (o.byKey === true || o.keyAdded === true),
      )
      .map((o) => o.op);
    const position = inEffect.at(-1)?.op ?? (keyed.length > 0 ? Math.min(...keyed) : n - 1);
    return last?.content.kind === "value"
      ? { has: true, value: last.content.value, position }
      : { has: false, value: null, position };
  }

  write(o: WriteOp): void {
    const n = o.op;
    const evidence = [...new Set(Object.values(o.fields).flatMap((x) => x?.sources ?? []))];
    // The interval parameters are content: their sources gone, the write has no contribution on
    // the entity at all (03-deletion «区间参数»).
    if (this.isState && this.isDeleted(o.validSources ?? evidence)) return;
    const seen = o.seenCurrent ? n - 1 : (o.seen ?? n - 1);
    const cur = n - 1;
    const fresh: Item[] = [];
    // Where this write itself makes the entity begin to exist, at the position compared (the
    // version seen, or the current one for whether a corroboration still holds): every required
    // field given by it (not empty) or with a value there already (with none required, any field
    // it gives). There an optional field written empty is as one not given (10-types-and-units
    // «清空字段»).
    const givenOn = (g: FieldId, s: Iv, at: number) => {
      const x = o.fields[g];
      if (x === undefined || x.value === null || this.isDeleted(x.sources)) return false;
      const r = this.resolve(o.valid, g, at, o.now);
      return r !== null && covers(r.valid, s);
    };
    const req = this.schema.required;
    this.creating = (s: Iv, at: number) =>
      this.isState &&
      (req.length > 0
        ? req.every((g) => givenOn(g, s, at) || this.fieldState(g, s, at).kind === "value")
        : (Object.keys(o.fields) as FieldId[]).some((g) => givenOn(g, s, at)));
    for (const [fid, input] of Object.entries(o.fields)) {
      const f = fid as FieldId;
      if (input === undefined) continue;
      // A field judged a no-op at write time stays a no-op in every replay: its same-value
      // judgement is not recomputed (03-deletion «两条原则», deviation one; «重放规则», no-op row).
      if (o.noop?.includes(f) || this.rec.noops.has(etKey(o.event, f))) continue;
      if (this.isDeleted(input.sources)) continue;
      if (o.byKey) {
        // Judged as any write, with two inputs replaced (04-write-and-read «三方比较»): the
        // version seen is the field's baseline position; the same-value step compares with the
        // baseline value, and a value equal to it is a no-op whatever evidence it points at,
        // unless the value in effect is that value too (then pointed evidence corroborates). A
        // field with no baseline value is judged as an ordinary write on its baseline position.
        const b = this.syncBaseline(f, n);
        const same = b.has && tok(input.value) === tok(b.value);
        const sync = b.has
          ? {
              same,
              explicit: same && input.explicit === true && this.vis(f, ALL, cur) === tok(b.value),
            }
          : undefined;
        this.judgeField(o, f, input, b.position, cur, fresh, sync);
      } else this.judgeField(o, f, input, seen, cur, fresh);
    }
    // Conflict criterion ⑤ on a field group: a conflict on any field the write gives in the group
    // makes its parts on the group's other fields candidates too. Those fields are judged again
    // with the unit forced; their corroborated parts stay as they are.
    const groupsHit = [...this.unitsInConflict].filter((u) => u.includes(","));
    this.unitsInConflict.clear();
    if (groupsHit.length > 0) {
      const again = (Object.keys(o.fields) as FieldId[]).filter(
        (f) =>
          groupsHit.includes(this.unitOf(f).join(",")) &&
          fresh.some((x) => x.target === f && x.status === "applied"),
      );
      if (again.length > 0) {
        for (const f of again) {
          for (let i = fresh.length - 1; i >= 0; i--)
            if (fresh[i]?.target === f) fresh.splice(i, 1);
        }
        for (const u of groupsHit) this.forcedUnits.add(u);
        try {
          for (const f of again) {
            const input = o.fields[f];
            if (input !== undefined) this.judgeField(o, f, input, seen, cur, fresh);
          }
        } finally {
          this.forcedUnits.clear();
          this.unitsInConflict.clear();
        }
      }
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
      // A rejection is of the whole write (01-objects, the `reject` row: "提议不生效"): a target of a write a
      // person rejected takes effect in no replay, whatever made it a candidate or awaiting then.
      const rejected = this.ops.some((x) => x.kind === "reject" && x.target === o.event);
      for (const it of applied) {
        const r = this.recordedStatus(it.event, it.target, it.valid);
        if (
          (r === "awaiting" && this.resolvedAwaiting.has(o.event)) ||
          this.listedByConfirmation(it.event, it.target) ||
          (rejected && r !== "effective")
        )
          it.status = "awaiting";
        else if (hi && r !== "effective") it.status = "awaiting";
      }
    }
    this.push(fresh);
  }

  /**
   * `sync`: a write by source key with a baseline value (see `write`): whether the value is the
   * baseline value, and whether the evidence it points at counts. Replaces the same-value step.
   */
  judgeField(
    o: WriteOp,
    f: FieldId,
    input: FieldInput,
    seen: number,
    cur: number,
    out: Item[],
    sync?: { readonly same: boolean; readonly explicit: boolean },
  ) {
    const n = o.op;
    const res = this.resolve(o.valid, f, seen, o.now);
    if (res === null) return;
    const v = tok(input.value);
    const segs = this.segments([res.valid]).filter((s) => covers(res.valid, s));
    // Empty where this write makes the entity begin to exist (`write`'s `creating`).
    const visFor = (s: Iv, at: number) => {
      const t = this.vis(f, s, at);
      return t === NO_VALUE && v === "none" && this.creating(s, at) ? "none" : t;
    };
    const sameAsSeen = sync !== undefined ? sync.same : segs.every((s) => visFor(s, seen) === v);
    const explicit = sync !== undefined ? sync.explicit : input.explicit === true;
    const base = {
      event: o.event,
      target: f,
      k: 0,
      op: n,
      content: { kind: "value" as const, value: input.value },
    };
    // A candidate put back by a cancellation after its item was resolved keeps the judgement it
    // got then (03-deletion «撤回与宽限期»).
    // Only the candidate part is put back: the write's corroborated part is judged as usual.
    const key = etKey(o.event, f);
    const rejudged = this.rec.rejudged.get(key);
    if (rejudged !== undefined) {
      const usual: Item[] = [];
      this.rec.rejudged.delete(key);
      try {
        this.judgeField(o, f, input, seen, cur, usual, sync);
      } finally {
        this.rec.rejudged.set(key, rejudged);
      }
      for (const it of usual) {
        if (it.status === "corroborated") out.push(it);
        else if (rejudged === "dropped") this.shadows.push({ ...it, status: "candidate" });
        // A put-back corroboration has no endpoints; whether the value it corroborates is still
        // there is settled once the replay is complete (`settlePutBack`).
        else if (rejudged === "corroborated") {
          out.push({ ...it, status: "corroborated", explicitEnds: [], putBack: true });
        } else out.push({ ...it, status: rejudged, explicitEnds: [] });
      }
      return;
    }
    if (sameAsSeen && !explicit) {
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
      // ordinary write, as the write was written (05-time «用同样的值写»).
      const corroborate = (eq: IvSet, ends: readonly Point[], into: Item[]) => {
        for (const piece of pieces(eq)) {
          into.push({
            ...base,
            status: "corroborated",
            valid: piece,
            explicitEnds: ends.filter((t) => piece.some((x) => x.from === t || x.to === t)),
            defaultEnd: false,
            from: piece[0]?.from ?? null,
          });
        }
      };
      const eq = normalize(segs.filter((s) => visFor(s, cur) === v));
      const changed = subtract(res.valid, eq);
      if (isEmpty(changed) || !res.defaultEnd) {
        corroborate(eq, res.explicitEnds, out);
        for (const piece of pieces(changed)) {
          this.ordinary(o, f, input, piece, false, piece[0]?.from ?? null, false, seen, cur, out);
        }
        return;
      }
      // A default end: the changed part is the write's, from its start, to the next change.
      const judged: Item[] = [];
      this.ordinary(o, f, input, changed, true, res.from, false, seen, cur, judged);
      if (judged.some((x) => x.status !== "applied")) {
        // Not merged: its corroborations as they are, the changed part a candidate a piece.
        corroborate(eq, res.explicitEnds, out);
        for (const x of judged)
          for (const piece of pieces(x.valid)) out.push({ ...x, valid: piece });
        return;
      }
      // Merged (conflict criterion ④): the write's interval on the current state, cut there. As
      // judge has it: under the rules as they are the interval ends at the field's next blocking
      // point, so it is all the same or all changed; kept as a cut so that it stays right if
      // what blocks a default end changes.
      const now = this.resolve(o.valid, f, cur, o.now);
      if (now === null) return;
      const nowSegs = this.segments([now.valid]).filter((s) => covers(now.valid, s));
      const eqNow = normalize(nowSegs.filter((s) => this.vis(f, s, cur) === v));
      corroborate(eqNow, now.explicitEnds, out);
      for (const piece of pieces(subtract(now.valid, eqNow))) {
        out.push({
          ...base,
          status: "applied",
          valid: piece,
          explicitEnds: now.explicitEnds,
          defaultEnd: true,
          from: now.from,
        });
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
    const met = { revoke: false };
    // A candidate a person's resolution listed stays the candidate it closed, whatever it was when
    // written (candidate, or awaiting and made a candidate by a deletion) and whether or not the
    // conflict is still there (01-objects «处理之后事项不重开»).
    let conflict =
      (r === "candidate" && this.closedCandidate(o.event, f)) || this.listedByResolution(o.event, f)
        ? true
        : this.conflicts(f, v, seenValid, defaultEnd, from, seen, cur, met, o);
    // Conflict criterion ⑤: a conflict anywhere in the unit makes every part of the write judged
    // there a candidate (`write` judges a group's fields again with the unit forced).
    if (this.forcedUnits.has(this.unitOf(f).join(","))) conflict = true;
    if (conflict) {
      const key = etKey(o.event, f);
      this.metRevoke.set(key, (this.metRevoke.get(key) ?? false) || met.revoke);
      this.unitsInConflict.add(this.unitOf(f).join(","));
    }
    if (r === "effective") conflict = false; // deviation two: what was in effect stays in effect
    // An awaiting write a person confirmed or rejected is a recorded decision (deviation one): it
    // stays awaiting for its confirmation to execute, and is not judged into a candidate.
    if (r === "awaiting" && this.resolvedAwaiting.has(o.event)) conflict = false;
    // A resolution's record comes first: a write it listed is its closed candidate, also where a
    // cancellation counted the write's awaiting item as superseded. Likewise a confirmation's or
    // rejection's: the item it decided stays that awaiting item, whatever it was when written.
    if (this.listedByResolution(o.event, f)) conflict = true;
    else if (this.listedByConfirmation(o.event, f)) conflict = false;
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
    const seen = o.seenCurrent ? n - 1 : (o.seen ?? n - 1);
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
    } else if (!this.isState && this.revokedRow()) {
      // Revoking a revoked row again is a no-op (04-write-and-read «已撤销的行不可写»).
      return;
    }
    const r = this.recordedStatus(o.event, "existence", seenValid);
    let conflict = seen < cur && this.revokeConflicts(seenValid, seen, cur);
    if (
      (r === "candidate" && this.closedCandidate(o.event, "existence")) ||
      this.listedByResolution(o.event, "existence")
    )
      conflict = true;
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
    // High impact ②: a revoke of a row or a whole entity still referred to awaits confirmation;
    // stale, it is a candidate first (09-references-conflict-sync «既版本对不上、又是高影响»).
    const awaiting = !conflict && o.referenced === true && (!this.isState || o.valid === undefined);
    this.push([
      conflict
        ? { ...base, status: "candidate", valid: seenValid }
        : { ...base, status: awaiting ? "awaiting" : "applied", valid },
    ]);
  }

  /**
   * The `undo` record (03-deletion «回掉的权威定义», step 1; 04-write-and-read «回退»), by (event,
   * target):
   * - the undone operation m is a revert: m's event on every target its own record lists, whether
   *   or not m wrote back there then;
   * - m a confirmation of a write: the confirmation's event on every target of the confirmed write
   *   as of that write;
   * - otherwise: every target of m's event as of its write (its write-time blocks, existence
   *   included), whatever its status then and whatever items remain now. No-op fields have no
   *   item and are not targets. `skipped` (entries already superseded when the undo is written,
   *   for history and receipts only) is not produced: it plays no part in coverage;
   * - with `include_later`: the (event, target) of each later item in effect (`applied`) that
   *   supersedes one of m's items in effect by step 3 and intersects it (marked `later`), on any
   *   target.
   */
  undoRecord(target: OpNumber, includeLater: boolean, n: number): RevertEntry[] {
    const m = this.ops.find((x) => x.op === target);
    const out = new Map<string, RevertEntry>();
    const add = (e: RevertEntry) => {
      const key = etKey(e.event, e.target);
      if (!out.has(key)) out.set(key, e);
    };
    const mRecord = this.rec.revertRecords.get(target) ?? this.revertRecords.get(target);
    if (m !== undefined && mRecord !== undefined) {
      for (const t of new Set(mRecord.map((e) => e.target))) add({ event: m.event, target: t });
    } else if (m !== undefined) {
      // By m's targets as of its write (its write-time blocks, existence included), whatever
      // their status then and whatever items remain now. m a confirmation: the confirmation's
      // event on every target of the confirmed write as of that write, not only those awaiting
      // when it was confirmed — a target a deletion later puts in effect at the confirmation is
      // undone with it, whether the deletion comes before the undo or after. All by the record,
      // nothing from the state when the undo is written.
      const of = m.kind === "confirm" ? m.target : m.event;
      for (const key of this.rec.writeTime.keys()) {
        const [ev, t] = key.split("/") as [string, Target];
        if (Number(ev) === m.event || Number(ev) === of) add({ event: m.event, target: t });
      }
    }
    if (includeLater) {
      const own = this.items.filter((x) => x.op === target && effective(x.status));
      for (const x of this.items) {
        if (x.op <= target || x.op >= n || x.status !== "applied") continue;
        if (own.some((r) => supersedes(x, r) && !isEmpty(intersect(x.valid, r.valid)))) {
          add({ event: x.event, target: x.target, later: true });
        }
      }
    }
    return [...out.values()];
  }

  /**
   * `acknowledge: ["overwrite"]` takes high impact ① into effect directly only when the op
   * explicitly carries the current `ver` (05-time «高影响写入»).
   */
  acknowledged(o: WriteOp | UndoOp): boolean {
    if (o.acknowledge === undefined || o.seen === undefined) return false;
    const seen = o.seenCurrent ? o.op - 1 : o.seen;
    // A deletion or cancellation that changed the entity gave it a new ver (03-deletion «重放规则»,
    // ver row): a ver before it is not current. A corroboration makes no version and leaves the
    // ver as it was (05-time «用同样的值写»): only items applied after it count.
    return (
      !this.items.some((x) => x.op > seen && x.op < o.op && x.status === "applied") &&
      !this.rec.external.some(
        (e) => e.op > seen && e.op < o.op && (e.changedEntity || this.wholeOn(e, "existence")),
      )
    );
  }

  /**
   * The operation an undo of `target` takes back: `target`, or, when it proposed a revert that a
   * confirmation put into effect, that confirmation: its base write and revert record are the ones
   * taken, not the proposal's (09 §5.7 «回退记录里列哪些条目»).
   */
  undone(target: OpNumber): OpNumber {
    const m = this.ops.find((x) => x.op === target);
    if (m?.kind !== "undo" || this.revertStatus.get(target) !== "awaiting") return target;
    const c = this.ops.find(
      (x) =>
        x.kind === "confirm" && x.target === m.event && this.revertStatus.get(x.op) === "applied",
    );
    return c?.op ?? target;
  }

  undo(input: UndoOp): void {
    const o = { ...input, target: this.undone(input.target) };
    const n = o.op;
    // `undo_target` (04-write-and-read «撤回某次写入（undo）», «第 n 次写入是什么»): rejected when no
    // item of the target on this row is applied when the undo is written, pending deletions
    // included. So a candidate, an awaiting write (its confirmation is a separate operation), a
    // write of nothing but no-ops or corroborations (it changed no value: nothing to undo), or a
    // revert with no write-back (a pending deletion may have restated them all as dropped) is
    // rejected. A write with a part applied is accepted; its corroborated part is in the record
    // too and is registered with the rest. The answer is the write-time one and is kept in every
    // replay.
    // The write that counts as the first creation cannot be undone either: revoke instead
    // (04-write-and-read «第 n 次写入是什么»).
    const creation = this.created();
    const rejected = this.rec.revertStatus.has(n)
      ? this.rec.revertStatus.get(n) === "rejected"
      : !this.items.some((x) => x.op === o.target && x.status === "applied") ||
        (creation !== undefined && this.opsByEvent.get(creation)?.op === o.target);
    if (rejected) {
      // As recorded, with the reason it was rejected for when judged.
      const revoked = this.rec.revertRejectedRevoked.has(n);
      this.reverts.push({
        op: n,
        event: o.event,
        status: "rejected",
        ...(revoked ? { reason: "revoked" as const } : {}),
        record: [],
      });
      this.revertStatus.set(n, "rejected");
      this.revertRecords.set(n, []);
      return;
    }
    const record =
      this.rec.revertRecords.get(n) ?? this.undoRecord(o.target, o.includeLater ?? false, n);
    this.revert(
      o.event,
      n,
      record,
      { before: o.target },
      null,
      (inScope, apply, rollback, laterInRange, hides, currentRevoke) => {
        const recStatus = this.rec.revertStatus.get(n);
        if (recStatus === "applied") return "applied"; // deviation two
        if (recStatus === "awaiting" && this.resolvedAwaiting.has(o.event)) return "awaiting";
        // Event and timeless tables: an undo of a revoked row is rejected (`revoked`) when the row
        // is still revoked once it is written (04-write-and-read «撤回某次写入（undo）»). An undo of
        // the revoke itself, or one taking it back with `include_later` (④), leaves it existing.
        // An undo of a revoke in effect now is accepted even when another revoke keeps the row
        // revoked: it registers what it takes back, so that revoke can be undone in turn.
        if (!this.isState && !currentRevoke && this.revokedRow()) {
          apply();
          const still = this.revokedRow();
          rollback();
          if (still) return "revoked";
        }
        // High impact ④: an item marked `later` has a non-empty range (05-time «高影响写入»).
        // and a write-back revoke that hides later field writes.
        if (laterInRange || hides) return "awaiting";
        if (this.acknowledged(o) || inScope.every((r) => r.content.kind === "revoke")) {
          return "applied";
        }
        return this.highImpact(n - 1, n - 1, n, apply, rollback) ? "awaiting" : "applied";
      },
    );
  }

  confirm(o: ConfirmOp): void {
    const target = this.opsByEvent.get(o.target);
    // The items it decides: those awaiting when it is judged, recorded for every replay.
    if (target?.kind !== "undo") {
      const recorded = this.rec.decidedItems.get(o.op) ?? this.decidedItems.get(o.op);
      if (recorded === undefined) {
        this.decidedItems.set(
          o.op,
          new Set(
            this.items
              .filter((x) => x.event === o.target && x.status === "awaiting")
              .map((x) => etKey(x.event, x.target)),
          ),
        );
      }
    }
    if (o.kind === "reject") return;
    if (target?.kind === "undo") {
      if (this.revertStatus.get(target.op) !== "awaiting") return;
      // The confirmation lists its own record as of the confirmation (09 §5.8 `item.resolved`).
      const m = this.undone(target.target);
      const record =
        this.rec.revertRecords.get(o.op) ?? this.undoRecord(m, target.includeLater ?? false, o.op);
      this.revert(o.event, o.op, record, { before: m }, null, () => "applied");
      return;
    }
    // Executes the proposal (05-time «高影响写入»): every item of the write awaiting now. The
    // confirmation is of the write's high impact, not of the targets awaiting at that point: a
    // target then in a conflict item stays a candidate while the conflict is there (the
    // confirmation resolves no conflict), and once a deletion removes the conflict, the only gate
    // left is the one this confirmation passed (03-deletion «重放规则 · 冲突消失之后»).
    const awaiting = this.items.filter((x) => x.event === o.target && x.status === "awaiting");
    this.push(
      awaiting.map((x) => ({
        ...x,
        event: o.event,
        op: o.op,
        status: "applied" as const,
        // A value carries the proposed one; existence (a revoke awaiting for its referrers,
        // high impact ②) has no sources to carry (09 §5.7).
        ...(x.target !== "existence" ? { carried: [refOf(x)] } : {}),
        explicitEnds: [],
      })),
    );
  }

  /**
   * K (03-deletion «回掉的权威定义» step 2; 01-objects «各处理方式的执行语义»): the items of the
   * item's candidates, taken by the (event, target) the resolution recorded when it was judged —
   * the candidates in the item at that point — that are candidates in this replay (or
   * same-valued, still counted). Never by index, and never by the event as a whole: a target not
   * in the item then (removed by a pending deletion, put back later into an item of its own) is
   * not in K and not closed by it. When judged: the recorded candidate writes' items on the unit
   * that are candidates; between an existence unit and a field unit, the recorded unit decides
   * (a write's candidates on a unit are all in one item, on existence when the conflict met a
   * revoke, 09 §5.8 `candidates/<k>`).
   */
  kOf(events: readonly Seq[], unit: ResolveOp["unit"], at: OpNumber): Item[] {
    // A candidate when written that is the same as the value before it in this replay still
    // counts (a shadow, in the pool with the status candidate, or a corroboration now): only
    // being deleted takes it out.
    const stillCandidate = (x: Item) =>
      x.status === "candidate" ||
      (x.status === "corroborated" &&
        x.putBack === undefined &&
        this.writeTimeStatusAt(x.event, x.target, x.valid) === "candidate");
    const pool = [...this.items, ...this.shadows];
    const recorded = this.rec.decidedItems.get(at) ?? this.decidedItems.get(at);
    if (recorded !== undefined) {
      return pool.filter((x) => recorded.has(etKey(x.event, x.target)) && stillCandidate(x));
    }
    // Judged now: the item's candidates as they are, recorded for every replay. A candidate put
    // back by a later cancellation was not in the item then, so it is never in this K.
    const k = pool.filter((x) => {
      if (!events.includes(x.event)) return false;
      // The item a candidate belongs to: existence for the revoke and for the fields of a unit
      // that met a revoke; a field unit for the others on its fields (by the record).
      const onExistence = this.onExistence(x.event, x.target);
      if (unit === "existence" ? !onExistence : onExistence || !inUnit(unit, x.target))
        return false;
      return stillCandidate(x);
    });
    this.decidedItems.set(at, new Set(k.map((x) => etKey(x.event, x.target))));
    return k;
  }

  /**
   * The merge base and the cover set O of a take_candidate (09 §5.8 `take`): recorded when it is
   * judged, then read from the record in every replay.
   */
  takeRecord(
    o: ResolveOp,
    k: Item[],
  ): { mergeBase: OpNumber; cover: Set<string>; restorable: Map<string, IvSet> | undefined } {
    const n = o.op;
    let mb = this.rec.mergeBases.get(n) ?? this.mergeBases.get(n);
    if (mb === undefined) {
      mb = { mergeBase: this.mergeBaseOf(o.candidates, o.unit) };
      this.mergeBases.set(n, mb);
      this.coverSets.set(n, this.takePreviousRecord(o, mb.mergeBase, k, n));
    }
    const listed = this.rec.coverSets.get(n) ?? this.coverSets.get(n) ?? [];
    return {
      mergeBase: mb.mergeBase,
      cover: new Set(listed.map((e) => etKey(e.event, e.target))),
      restorable: this.rec.takeRestorable.get(n),
    };
  }

  /**
   * The revokes a take_candidate on a field unit filled (see `Recorded.takeFilled`): recorded when
   * it is judged, on the state of the history at that point, then read from the record.
   */
  filledBy(o: ResolveOp, taken: Item[]): Set<string> {
    const n = o.op;
    const recorded = this.rec.takeFilled.get(n) ?? this.takeFilled.get(n);
    if (recorded !== undefined) return recorded;
    const out = new Set<string>();
    if (this.isState) {
      const range = union(...taken.map((x) => x.valid));
      for (const x of this.items) {
        if (x.status !== "applied" || x.target !== "existence" || x.content.kind !== "revoke")
          continue;
        if (x.op >= n) continue;
        const valid = subtract(x.valid, this.registeredSet(x, n));
        if (isEmpty(intersect(valid, range))) continue;
        out.add(etKey(x.event, x.target));
      }
    }
    this.takeFilled.set(n, out);
    return out;
  }

  /**
   * Where writes outside the cover set cover what a take_candidate writes on `target`: a write in
   * effect after the merge base and before the resolution, not in O, that supersedes an item of
   * the kind taken there (step 3), less where an earlier revert registered it and where a later
   * write in O supersedes it in turn. A revoke does not
   * cover a taken field item: when the take is judged a revoke there is the ordinary check on the
   * current state (a revoked event row: rejected; a state table: filling the hole), so covering
   * would turn that judgement into a take that silently writes nothing.
   */
  coveredOutsideO(
    rec: {
      mergeBase: OpNumber;
      cover: Set<string>;
      filled?: Set<string>;
      restorable?: Map<string, IvSet> | undefined;
    },
    n: OpNumber,
    taken: Item,
  ): IvSet {
    // A revoke and a field take (deviation (2)): on an event table a revoke is no value item and
    // never covers a field take; on a state table it does not when the take is judged (the take
    // fills the hole), and in a replay a revoke the take filled covers it nowhere, one it did not
    // fill covers it wholly (judged by the revoke, not by an interval).
    const revokeOnField = (x: Item) => taken.target !== "existence" && x.target === "existence";
    const judging = !this.rec.judged.has(n);
    return union(
      ...this.items
        .filter(
          (x) =>
            x.status === "applied" &&
            x.op > rec.mergeBase &&
            x.op < n &&
            !rec.cover.has(etKey(x.event, x.target)) &&
            x.content.kind !== "uncovered" &&
            !(revokeOnField(x) && (!this.isState || judging)) &&
            // On an event table existence and field values do not cover each other: a taken
            // revoke stops counting only where a restore outside O is in effect.
            !(!this.isState && taken.target === "existence" && x.content.kind !== "restore") &&
            supersedes(x, taken),
        )
        .map((x) => {
          // Only where no later write in O supersedes it (step 3): a write outside O that a write
          // in O covers in turn covers nothing, so the take does not uncover what O wrote.
          const underO = this.items.filter(
            (y) =>
              y.status === "applied" &&
              y.op > x.op &&
              y.op < n &&
              rec.cover.has(etKey(y.event, y.target)) &&
              supersedes(y, x),
          );
          // A revoke the take filled (listed in its record) covers it nowhere, whatever its
          // interval in this replay; one not listed covers it wholly (03-deletion «搬运的值»).
          const filled =
            revokeOnField(x) && rec.filled?.has(etKey(x.event, x.target)) === true ? [ALL] : [];
          // Removed by a deletion pending when the take was judged and back since: not covering.
          const back = rec.restorable?.get(etKey(x.event, x.target)) ?? [];
          return subtract(
            subtract(subtract(subtract(x.valid, this.registeredSet(x, n)), filled), back),
            union(...underO.map((y) => subtract(y.valid, this.registeredSet(y, n)))),
          );
        }),
    );
  }

  resolveItem(o: ResolveOp): void {
    const n = o.op;
    // Its validity is judged once, on the state without it (`evaluateLog`, `validDecision`); in
    // every replay it is executed as recorded.
    if (o.decision === "keep_effective") {
      // It closes the item's candidates as they are (recorded); it writes nothing.
      this.kOf(o.candidates, o.unit, o.op);
      return;
    }
    if (o.decision === "take_candidate" && o.unit === "existence") {
      this.takeExistence(o);
      return;
    }
    if (o.decision === "take_candidate") {
      if (o.take === undefined || o.unit === "existence") {
        throw new Error("take_candidate needs `take`");
      }
      this.takeCandidate(o, o.take, unitTargets(o.unit) as FieldId[]);
      return;
    }
    // take_previous: revert to the merge base (01-objects «各处理方式的执行语义»).
    // K is taken by (event, unit) in every replay; the merge base and the record are recorded.
    const kItems = this.kOf(o.candidates, o.unit, o.op);
    let rec = this.rec.mergeBases.get(n);
    if (rec === undefined) {
      const mergeBase = this.mergeBaseOf(o.candidates, o.unit);
      this.revertRecords.set(n, this.takePreviousRecord(o, mergeBase, kItems, n));
      rec = { mergeBase };
      this.mergeBases.set(n, rec);
    }
    const record = this.rec.revertRecords.get(n) ?? this.revertRecords.get(n) ?? [];
    this.revert(
      o.event,
      n,
      record,
      { asOf: rec.mergeBase },
      kItems,
      // A take_previous takes effect directly: it is a person's decision, made on the item's
      // details, which list what it takes back and what it hides (a field outside its unit written
      // after the merge base, over a stretch it leaves without a value). It writes no revoke back:
      // its record lists the field writes of its unit (09 §5.7).
      () => "applied",
    );
  }

  /**
   * Whether a person's decision is valid when judged, as the kernel judges it (`invalid`). Asked of
   * the replay of the log before the decision, so of the state without it: a replay holding the
   * decision already executes it (a resolution closes its candidates there).
   * - A resolution: each candidate it lists has candidate items on its unit, none of them closed
   *   (by an earlier resolution's record, or kept superseded by a cancellation), and the one taken
   *   is listed. A candidate a deletion has put in effect has no candidate item left. An empty
   *   list is accepted, as by the kernel.
   * - A confirmation or rejection: the write (or undo) it names awaits and was not decided before.
   */
  validDecision(o: ResolveOp | ConfirmOp): boolean {
    if (o.kind !== "resolve") {
      if (this.resolvedAwaiting.has(o.target)) return false;
      const target = this.opsByEvent.get(o.target);
      if (target?.kind === "undo") return this.revertStatus.get(target.op) === "awaiting";
      return this.items.some((x) => x.event === o.target && x.status === "awaiting");
    }
    if (o.take !== undefined && !o.candidates.includes(o.take)) return false;
    return o.candidates.every((e) => {
      const mine = this.items.filter(
        (x) =>
          x.event === e &&
          x.status === "candidate" &&
          (o.unit === "existence"
            ? this.onExistence(e, x.target)
            : !this.onExistence(e, x.target) && inUnit(o.unit, x.target)),
      );
      return mine.length > 0 && !mine.some((x) => this.closedCandidate(e, x.target));
    });
  }

  /**
   * A resolution rejected when judged: it writes nothing, and the log refuses it (`evaluateLog`), so
   * it closes nothing either.
   */
  reject(o: ResolveOp, reason: RejectionReason): void {
    this.rejections.push({ op: o.op, reason });
  }

  /**
   * The merge base of a conflict item: the earliest version its candidates carried. A write by
   * source key carries its fields' baseline positions, the earliest over the unit's fields it
   * wrote (04-write-and-read «三方比较»), the fields it wrote as a no-op left out: they carry no
   * baseline (09 §5.8 `ops/<i>/baseline`, §5.7). On `existence` that is every field it wrote.
   */
  /** Whether write `o` gave field `f` as a no-op, as judged when it was written. */
  wroteNoop(o: WriteOp, f: FieldId): boolean {
    const key = etKey(o.event, f);
    return o.noop?.includes(f) === true || this.rec.noops.has(key) || this.noops.has(key);
  }

  mergeBaseOf(candidates: readonly Seq[], unit: ResolveOp["unit"]): OpNumber {
    return Math.min(
      ...candidates.map((e) => {
        const c = this.opsByEvent.get(e);
        if (c?.kind === "write" && c.byKey) {
          const fields = (
            unit === "existence" ? Object.keys(c.fields) : unitTargets(unit)
          ) as FieldId[];
          const at = fields
            .filter((f) => c.fields[f] !== undefined && !this.wroteNoop(c, f))
            .map((f) => this.syncBaseline(f, c.op).position);
          return at.length > 0 ? Math.min(...at) : c.op - 1;
        }
        return c !== undefined && (c.kind === "write" || c.kind === "revoke")
          ? (c.seen ?? c.op - 1)
          : (c?.op ?? 0);
      }),
    );
  }

  /**
   * take_candidate on a field or field-group unit (01-objects «各处理方式的执行语义»; 03-deletion
   * «搬运的值»). The merge base and the cover set O are recorded when it is judged. Per field of
   * the unit, the taken value is written on the taken write's items in K; with none there (all
   * deleted, or put back into an item of their own), on the items in K of the candidates with the
   * same value on that field. Where a write in effect after the merge base and before the
   * resolution, not in O, supersedes it, that write covers it and stays in effect. Value sources:
   * every candidate in K with the same value on that field. In a replay the take is executed as
   * recorded: the checks an ordinary write passes are made only when it is judged.
   */
  takeCandidate(o: ResolveOp, take: Seq, fields: readonly FieldId[]): void {
    const n = o.op;
    const k = this.kOf(o.candidates, o.unit, o.op);
    const takenOp = this.opsByEvent.get(take);
    // The take's range: the taken write's items in K; with none, the same-valued candidates'
    // (where it lands, as below).
    const own = k.filter((x) => x.event === take);
    const sameValued = k.filter((x) => {
      const input = takenOp?.kind === "write" ? takenOp.fields[x.target as FieldId] : undefined;
      return (
        input !== undefined &&
        x.content.kind === "value" &&
        tok(x.content.value) === tok(input.value)
      );
    });
    const rec = {
      ...this.takeRecord(o, k),
      filled: this.filledBy(o, own.length > 0 ? own : sameValued),
    };
    const fresh: Item[] = [];
    const written: IvSet[] = [];
    /** The fields the take writes an item on. */
    const writes: FieldId[] = [];
    for (const f of fields) {
      const input = takenOp?.kind === "write" ? takenOp.fields[f] : undefined;
      if (input === undefined) continue;
      // A field the taken write gave as a no-op when written had no item: there is nothing of it
      // to take, and no same-valued candidate stands in for it (03-deletion «搬运的值»: they stand in
      // for the taken write's items, gone in a replay).
      if (takenOp?.kind === "write" && this.wroteNoop(takenOp, f)) continue;
      const v = tok(input.value);
      const same = k.filter(
        (x) => x.target === f && x.content.kind === "value" && tok(x.content.value) === v,
      );
      const own = same.filter((x) => x.event === take);
      const giving = own.length > 0 ? own : same;
      if (giving.length === 0) continue;
      const covered = union(...giving.map((x) => this.coveredOutsideO(rec, n, x)));
      const valid = subtract(union(...giving.map((x) => x.valid)), covered);
      if (isEmpty(valid)) continue;
      const segs = this.segments([valid]).filter((g) => covers(valid, g));
      if (segs.every((g) => this.vis(f, g, n - 1) === v)) continue; // same value: no contribution
      written.push(valid);
      writes.push(f);
      // One item per stretch: an item has one interval (09 §5.7 `span/<f>/<k>`).
      for (const part of pieces(valid)) {
        fresh.push({
          event: o.event,
          target: f,
          k: 0,
          op: n,
          status: "applied",
          valid: part,
          content: { kind: "value", value: input.value },
          carried: same.map(refOf),
          explicitEnds: [],
          defaultEnd: false,
          from: null,
        });
      }
    }
    if (fresh.length === 0) return;
    // The checks on the current state an ordinary write passes, on what takes effect
    // (04-write-and-read «判定顺序» step 5), when the take is judged: a revoked row cannot be
    // written; on a state table, where the entity has no value every required field must be given
    // (05-time «无值区间»). A take that entered the log is a person's decision, executed as
    // recorded in a replay (03-deletion «两条原则», deviation one): what it writes then lands by the
    // ordinary rules, a stretch without every required field has no value.
    const judging = !this.rec.judged.has(n);
    if (judging && !this.isState && this.revokedRow()) {
      this.reject(o, "revoked");
      return;
    }
    const all = union(...written);
    // The fields the take writes an item on, not the unit's nor the request's: a field of a group
    // the taken write does not give, or gives as a no-op (no item, so nothing to take), has no value
    // written into the hole (as judge checks a take: on what takes effect).
    if (
      judging &&
      this.isState &&
      this.schema.required.some((r) => !writes.includes(r)) &&
      this.segments([all])
        .filter((g) => covers(all, g))
        .some((g) => !this.hasValue(g, n - 1))
    ) {
      this.reject(o, "missing_required");
      return;
    }
    this.push(fresh);
  }

  /**
   * take_candidate on an item whose unit is existence (09-references-conflict-sync «撤销与并发
   * 修改»; 01-objects «各处理方式的执行语义»). The candidate taken is a revoke: it takes effect on
   * its interval. It is a modification: its fields take effect on their intervals; on an event
   * table the row exists again (a restore, the revoke not registered as reverted); on a state
   * table where the entity has no value inside the candidate's interval, the required fields the
   * candidate does not give are carried from the merge base there, and with none there the
   * resolution is rejected (`required_in_gap`); optional fields not given are empty.
   */
  takeExistence(o: ResolveOp): void {
    const n = o.op;
    if (o.take === undefined) throw new Error("take_candidate needs `take`");
    const cands = this.kOf(o.candidates, "existence", o.op);
    const rec = this.takeRecord(o, cands);
    // Where writes outside the cover set O cover a taken item, that write stays in effect. A
    // shadow of the taken write is its item in K (03-deletion «搬运的值»), as on a field unit.
    const taken = cands
      .filter((x) => x.event === o.take)
      .map((x) => ({ ...x, valid: subtract(x.valid, this.coveredOutsideO(rec, n, x)) }))
      .filter((x) => !isEmpty(x.valid));
    const base = {
      event: o.event,
      op: n,
      status: "applied" as const,
      explicitEnds: [],
      defaultEnd: false,
      from: null,
    };
    const fresh: Item[] = [];
    const revokes = taken.filter((x) => x.target === "existence");
    if (revokes.length > 0) {
      const valid = union(...revokes.map((x) => x.valid));
      // A taken revoke always writes its item over the taken range less what covers it, also
      // where there is already no value then, as a revoke written over a revoked stretch: whether
      // there is a value there is not checked again in a replay, where later writes or deletions
      // may change it (03-deletion «重放规则 · 人的决定»).
      for (const part of pieces(valid)) {
        fresh.push({
          ...base,
          target: "existence",
          k: 0,
          valid: part,
          content: { kind: "revoke" },
        });
      }
      this.push(fresh);
      return;
    }
    // Per field of the taken write in this item: its items in K; with none left (all deleted, or
    // put back into an item of their own), the items in K of the candidates with the same value
    // on that field take over (03-deletion «搬运的值»), as on a field unit.
    const takenOp = this.opsByEvent.get(o.take);
    const takenFields = (
      takenOp?.kind === "write" ? (Object.keys(takenOp.fields) as FieldId[]) : []
    ).filter((f) => this.onExistence(o.take as Seq, f));
    const giving: Item[] = [];
    for (const f of takenFields.sort()) {
      const input = takenOp?.kind === "write" ? takenOp.fields[f] : undefined;
      if (input === undefined) continue;
      const v = tok(input.value);
      const same = cands.filter(
        (x) => x.target === f && x.content.kind === "value" && tok(x.content.value) === v,
      );
      const own = same.filter((x) => x.event === o.take);
      for (const x of own.length > 0 ? own : same) {
        const valid = subtract(x.valid, this.coveredOutsideO(rec, n, x));
        if (!isEmpty(valid)) giving.push({ ...x, valid });
      }
    }
    const targets = [...new Set(giving.map((x) => x.target))].sort() as FieldId[];
    for (const f of targets) {
      const mine = giving.filter((x) => x.target === f && x.content.kind === "value");
      const first = mine[0];
      if (first === undefined || first.content.kind !== "value") continue;
      const value = first.content.value;
      const valid = union(...mine.map((x) => x.valid));
      const v = tok(value);
      const segs = this.segments([valid]).filter((s) => covers(valid, s));
      if (segs.every((s) => this.vis(f, s, n - 1) === v)) continue;
      const carried = cands.filter(
        (x) => x.target === f && x.content.kind === "value" && tok(x.content.value) === v,
      );
      for (const part of pieces(valid)) {
        fresh.push({
          ...base,
          target: f,
          k: 0,
          valid: part,
          content: first.content,
          carried: carried.map(refOf),
        });
      }
    }
    if (!this.isState) {
      // Nothing of the take is left: it does not restore the row either.
      if (giving.length > 0 && this.revokedRow()) {
        fresh.push({
          ...base,
          target: "existence",
          k: 0,
          valid: [ALL],
          content: { kind: "restore" },
        });
      }
      this.push(fresh);
      return;
    }
    // State tables: the required fields the candidate does not give, carried from the merge base
    // where the entity has no value inside the candidate's interval.
    if (giving.length === 0) return;
    const scope = union(...giving.map((x) => x.valid));
    const gap = normalize(
      this.segments([scope]).filter((s) => covers(scope, s) && !this.hasValue(s, n - 1)),
    );
    const mergeBase = rec.mergeBase;
    const req = this.schema.required.length > 0 ? this.schema.required : [];
    for (const f of req.filter((r) => !targets.includes(r))) {
      let k = 0;
      let run: { valid: Iv[]; value: FieldValue; by: Item } | undefined;
      const flush = () => {
        if (run === undefined) return;
        fresh.push({
          ...base,
          target: f,
          k: k++,
          valid: normalize(run.valid),
          content: { kind: "value", value: run.value },
          carried: [refOf(run.by)],
        });
        run = undefined;
      };
      for (const s of this.segments([gap]).filter((x) => covers(gap, x))) {
        const st = this.fieldState(f, s, mergeBase);
        if (st.kind !== "value") {
          // Checked when the take is judged; in a replay it is executed as recorded and where the
          // merge base has no value now nothing is carried: the stretch lands by the existence
          // rule (03-deletion «重放规则 · 人的决定»).
          if (!this.rec.judged.has(n)) {
            this.reject(o, "required_in_gap");
            return;
          }
          flush();
          continue;
        }
        const last = run?.valid[run.valid.length - 1];
        if (run !== undefined && run.by === st.by && last !== undefined && last.to === s.from) {
          run.valid.push(s);
        } else {
          flush();
          run = { valid: [s], value: st.value, by: st.by };
        }
      }
      flush();
    }
    this.push(fresh);
  }

  /**
   * The take_previous record (03-deletion «回掉的权威定义» ①): the (event, target) with an item in
   * effect after the merge base and before operation `n`, in the item's unit and interval.
   */
  takePreviousRecord(o: ResolveOp, mergeBase: OpNumber, cands: Item[], n: OpNumber): RevertEntry[] {
    const domain = union(...cands.map((c) => c.valid));
    const listed = new Map<string, RevertEntry>();
    for (const x of this.items) {
      if (
        x.op > mergeBase &&
        x.op < n &&
        effective(x.status) &&
        inUnit(o.unit, x.target) &&
        !isEmpty(intersect(x.valid, domain))
      ) {
        listed.set(etKey(x.event, x.target), { event: x.event, target: x.target });
      }
    }
    return [...listed.values()];
  }

  /** 03-deletion «回掉的权威定义», steps 1–8 (without `deps`). */
  revert(
    event: Seq,
    n: OpNumber,
    record: readonly RevertEntry[],
    pos: { before: OpNumber } | { asOf: OpNumber },
    k: Item[] | null,
    decide: (
      inScope: Item[],
      apply: () => void,
      rollback: () => void,
      laterInRange: boolean,
      hides: boolean,
      currentRevoke: boolean,
    ) => RevertResult["status"] | "revoked",
  ): void {
    // Step 1: R' = every item of every (event, target) R lists, whatever its index (given at
    // write time or by a deletion) and whatever its status at write time.
    const entries = new Map(record.map((e) => [etKey(e.event, e.target), e]));
    const rPrime = this.items.filter((x) => entries.has(etKey(x.event, x.target)));
    const zai = rPrime.filter((x) => effective(x.status));
    const isLater = (x: Item) => entries.get(etKey(x.event, x.target))?.later === true;

    // Step 2: the domain. take_previous: the candidates' intervals. undo: all business time for
    // the undone operation's entries; for an item x of an entry marked `later`, D(x) = the union of
    // the intervals of the items in effect, not marked `later`, that x supersedes by step 3.
    const kDomain: IvSet = k === null ? [ALL] : union(...k.map((c) => c.valid));
    const domainOf = (x: Item): IvSet =>
      k === null && isLater(x)
        ? union(...zai.filter((r) => !isLater(r) && supersedes(x, r)).map((r) => r.valid))
        : kDomain;

    // Step 3: ranges. A revoke a take_candidate wrote supersedes an earlier revoke where it
    // lies: a person's decision on the item, written even where there was no value (03-deletion
    // «重放规则 · 人的决定»), so undoing the earlier revoke does not bring the row back under it.
    // As the kernel: a take_candidate's revoke only. A revoke is never awaiting (a candidate or
    // applied), so no confirmation writes one of its own; a confirmed undo's write-backs are the
    // confirmation's, a take_previous writes back field writes only, keep_effective nothing.
    const takenRevoke = (x: Item) => {
      const o = this.opsByEvent.get(x.event);
      return (
        x.content.kind === "revoke" && o?.kind === "resolve" && o.decision === "take_candidate"
      );
    };
    const scope = new Map<Item, IvSet>();
    for (const r of zai) {
      const covering = this.items
        .filter(
          (x) =>
            x.status === "applied" &&
            !entries.has(etKey(x.event, x.target)) &&
            r.op < x.op &&
            x.op < n &&
            x.content.kind !== "uncovered" &&
            (supersedes(x, r) || (r.content.kind === "revoke" && takenRevoke(x))),
        )
        .map((x) => intersect(subtract(x.valid, this.registeredSet(x, n)), r.valid));
      scope.set(r, intersect(subtract(r.valid, union(...covering)), domainOf(r)));
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
    // Step 5: each item in effect is registered on its interval ∩ T(its target) ∩ its domain; for
    // the undone operation's own items the domain is all of business time, an item marked
    // `later` is registered only within D(x).
    const registrations = zai.flatMap((r) => {
      const valid = intersect(intersect(r.valid, tOf(r.target)), domainOf(r));
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
    const laterInRange = zai.some((r) => isLater(r) && !isEmpty(scope.get(r) ?? []));
    // Write-backs hiding a later field write (05-time «高影响写入» ④): a field item in effect, not
    // under R, after the undone operation (or the merge base) and before n, over a stretch the
    // write-backs take from it beyond what earlier reverts registered. They take it where they
    // write a revoke back (undo only: a take_previous lists the field writes of its unit), and
    // where the entity had a value before them and has none once they are written (05-time
    // «无值区间»): the item's value goes with the stretch's. The second is found by writing them:
    // every elementary segment's "has a value" before and after, the write-backs then taken out.
    // A hidden corroboration: a warning.
    const lower = "before" in pos ? pos.before : pos.asOf;
    let emptied: Iv[] = [];
    if (this.isState) {
      const segs = this.segments(fresh.map((w) => w.valid));
      const valuedBefore = segs.map((s) => this.hasValue(s, n - 1));
      apply();
      emptied = segs.filter((s, i) => valuedBefore[i] === true && !this.hasValue(s, n));
      rollback();
    }
    const under = (x: Item, area: IvSet) =>
      !isEmpty(subtract(intersect(area, x.valid), this.registeredSet(x, n)));
    const revokedBack: IvSet = union(
      ...fresh
        .filter((w) => "before" in pos && w.target === "existence" && w.content.kind === "revoke")
        .map((w) => w.valid),
    );
    const hidden = (status: Status) =>
      this.items.some(
        (x) =>
          x.target !== "existence" &&
          x.status === status &&
          (x.content.kind === "value" || x.content.kind === "noValue") &&
          !entries.has(etKey(x.event, x.target)) &&
          x.op > lower &&
          x.op < n &&
          // A no-value item gives no value to lose with the stretch's.
          (under(x, revokedBack) || (x.content.kind === "value" && under(x, normalize(emptied)))),
      );
    // The target is a revoke on existence in effect now: one of its items is not covered (step 3).
    // Its own items only: a revoke an include_later takes back with it is not the target.
    const currentRevoke = zai.some(
      (r) =>
        !isLater(r) &&
        r.target === "existence" &&
        r.content.kind === "revoke" &&
        !isEmpty(scope.get(r) ?? []),
    );
    const verdict = decide(zai, apply, rollback, laterInRange, hidden("applied"), currentRevoke);
    if (verdict === "revoked") {
      this.reverts.push({ op: n, event, status: "rejected", reason: "revoked", record: [] });
      this.revertStatus.set(n, "rejected");
      this.rejectedRevoked.add(n);
      this.revertRecords.set(n, []);
      return;
    }
    const status = verdict;
    this.reverts.push({
      op: n,
      event,
      status,
      record,
      ...(status === "applied" && hidden("corroborated")
        ? { warnings: ["overwrote_corroborated" as const] }
        : {}),
    });
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
    this.settlePutBack();
  }

  /**
   * A put-back corroboration corroborates only where the value it carries is still the value in
   * effect as of the cancellation that judged it (a later deletion may have removed that value;
   * later writes do not count); elsewhere it is the candidate that decision closed (03-deletion
   * «撤回与宽限期»). It gives no value, endpoint or blocking point, so settling it after the
   * replay changes nothing else.
   */
  settlePutBack(): void {
    for (const it of this.items.filter((x) => x.putBack && x.status === "corroborated")) {
      if (it.content.kind !== "value" || it.target === "existence") continue;
      const v = tok(it.content.value);
      const at = this.rec.rejudgedAt.get(etKey(it.event, it.target)) ?? INF;
      const segs = this.segments([it.valid]).filter((g) => covers(it.valid, g));
      const same = normalize(segs.filter((g) => this.vis(it.target as FieldId, g, at) === v));
      const gone = subtract(it.valid, same);
      if (isEmpty(gone)) continue;
      this.items.splice(this.items.indexOf(it), 1);
      const { putBack: _, ...closed } = it;
      const parts = [
        ...pieces(same).map((valid): Item => ({ ...it, valid })),
        ...pieces(gone).map(
          (valid): Item => ({ ...closed, status: "candidate", valid, closedByDecision: true }),
        ),
      ].sort((a, b) => ((a.valid[0]?.from ?? "") < (b.valid[0]?.from ?? "") ? -1 : 1));
      // The first part keeps the index; the others continue after the largest index used.
      let next =
        Math.max(
          ...this.items
            .filter((x) => x.event === it.event && x.target === it.target)
            .map((x) => x.k),
          it.k,
        ) + 1;
      parts.forEach((x, i) => {
        x.k = i === 0 ? it.k : next++;
        this.items.push(x);
      });
    }
  }

  // -------------------------------------------------------------------------------------------
  // Results.

  /**
   * Event and timeless tables: a revoke in effect, not registered as reverted, and not restored
   * since (a take_candidate restores the row without registering the revoke).
   */
  revokedRow(): boolean {
    return this.items.some((x) => this.liveRevoke(x, ALL, INF));
  }

  /**
   * A revoke in effect at a segment: not registered there and, on event and timeless tables, with
   * no restore in effect after it (a restore a take_candidate wrote; a revert's restore registers
   * the revoke as well).
   */
  liveRevoke(x: Item, seg: Iv, limit: number): boolean {
    if (x.content.kind !== "revoke" || x.status !== "applied" || x.op > limit) return false;
    if (!covers(x.valid, seg) || this.registeredOn(x, seg, limit)) return false;
    if (this.isState) return true;
    return !this.items.some(
      (y) =>
        y.content.kind === "restore" &&
        y.status === "applied" &&
        y.op > x.op &&
        y.op <= limit &&
        covers(y.valid, seg) &&
        !this.registeredOn(y, seg, limit),
    );
  }

  rowExists(): boolean {
    if (this.revokedRow()) return false;
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
    // The first write giving every required field in effect; with none required, any field (a
    // clearing too), so that a write's mark does not wait on fields written after it (03-deletion
    // «首次创建标记»).
    const gives = (w: WriteOp, f: FieldId) =>
      this.items.some((x) => x.event === w.event && x.target === f && effective(x.status));
    return writes.find((w) =>
      this.schema.required.length > 0
        ? this.schema.required.every((f) => gives(w, f))
        : this.fieldIds.some((f) => gives(w, f)),
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
      ...((x.status === "candidate" &&
        (this.closedCandidate(x.event, x.target) || x.closedByDecision)) ||
      (x.status === "awaiting" && this.resolvedAwaiting.has(x.event))
        ? { closed: true as const }
        : {}),
    }));
    // Items as last given that are no longer items and were not deleted: `dropped`.
    {
      const present = new Set(this.items.map(refKey));
      // Every index the log has given: one given only by a cancelled deletion was restated as
      // dropped by the cancellation.
      for (const [et, hist] of this.rec.history) {
        const ks = [...new Set(hist.map((h) => h.k))].sort((a, b) => a - b);
        const [ev, target] = et.split("/") as [string, Target];
        const event = Number(ev);
        for (const b of ks.map((k) => ({ k }))) {
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
      takeCandidates: this.ops.flatMap((o) => {
        if (o.kind !== "resolve" || o.decision !== "take_candidate") return [];
        const mb = this.rec.mergeBases.get(o.op) ?? this.mergeBases.get(o.op);
        const cover = this.rec.coverSets.get(o.op) ?? this.coverSets.get(o.op);
        return mb === undefined || cover === undefined
          ? []
          : [
              {
                op: o.op,
                mergeBase: mb.mergeBase,
                cover,
                ...(this.rec.takeRestorable.has(o.op)
                  ? {
                      restorable: [...(this.rec.takeRestorable.get(o.op) ?? new Map())].map(
                        ([key, valid]) => ({ key, valid }),
                      ),
                    }
                  : {}),
              },
            ];
      }),
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
        xs.map((x) => ({ k: x.k, valid: x.valid, status: x.status, content: x.content })),
      );
      rec.history.set(key, [
        ...(rec.history.get(key) ?? []),
        ...xs.map((x) => ({ k: x.k, valid: x.valid, by: "write" })),
      ]);
    }
    for (const key of this.noops) if (key.startsWith(`${o.event}/`)) rec.noops.add(key);
    if (o.kind === "write") for (const f of o.noop ?? []) rec.noops.add(etKey(o.event, f));
    const record = this.revertRecords.get(o.op);
    if (record !== undefined) rec.revertRecords.set(o.op, record);
    const status = this.revertStatus.get(o.op);
    if (status !== undefined) rec.revertStatus.set(o.op, status);
    if (this.rejectedRevoked.has(o.op)) rec.revertRejectedRevoked.add(o.op);
    const mb = this.mergeBases.get(o.op);
    if (mb !== undefined) rec.mergeBases.set(o.op, mb);
    const cover = this.coverSets.get(o.op);
    if (cover !== undefined) rec.coverSets.set(o.op, cover);
    const filled = this.takeFilled.get(o.op);
    if (filled !== undefined && !rec.takeFilled.has(o.op)) rec.takeFilled.set(o.op, filled);
    const resolved = this.decidedItems.get(o.op);
    if (resolved !== undefined && !rec.decidedItems.has(o.op)) rec.decidedItems.set(o.op, resolved);
    // Candidate fields: recorded when first judged, never judged again.
    for (const [key, met] of this.metRevoke) {
      if (key.startsWith(`${o.event}/`) && !rec.metRevoke.has(key)) rec.metRevoke.set(key, met);
    }
  }

  /**
   * After a deletion event (`by`: the deletion ID for a confirmation, "cancel" for a
   * cancellation), what it restates: every item whose interval differs from its block as last
   * given gets a new block, with its deps as of this replay; an item whose interval did not change
   * is not restated and keeps its block. Indices of a present (event, target) no longer given are
   * restated as dropped. A cancellation (`cancelled`: the deletion it cancels) also restates, as
   * they are, the items whose block as last given came from the cancelled deletion (03-deletion
   * «结果怎么落进日志»), so that going back past that deletion does not reach an outdated block.
   */
  recordLatest(by: string, cancelled?: string): void {
    const groups = new Map<string, Item[]>();
    for (const x of this.items) {
      const key = etKey(x.event, x.target);
      groups.set(key, [...(groups.get(key) ?? []), x]);
    }
    for (const [key, xs] of groups) {
      const before = latestBlocks(this.rec, key);
      const added: HistoryEntry[] = [];
      for (const x of xs) {
        const prev = before.find((b) => b.k === x.k);
        const same = prev !== undefined && JSON.stringify(prev.valid) === JSON.stringify(x.valid);
        const fromCancelled =
          cancelled !== undefined && this.lastGivenBy(key, x.k, cancelled) === cancelled;
        if (same && !fromCancelled) continue;
        added.push({ k: x.k, valid: x.valid, by });
      }
      for (const b of before) {
        if (xs.some((x) => x.k === b.k)) continue;
        added.push({ k: b.k, valid: b.valid, by, dropped: true });
      }
      if (added.length > 0)
        this.rec.history.set(key, [...(this.rec.history.get(key) ?? []), ...added]);
    }
  }

  /** Who gave the index's block as last given, counting the deletion `cancelled` as not cancelled. */
  lastGivenBy(key: string, k: number, cancelled: string): string | undefined {
    const hist = this.rec.history.get(key) ?? [];
    for (let i = hist.length - 1; i >= 0; i--) {
      const h = hist[i] as HistoryEntry;
      if (h.k !== k || h.dropped) continue;
      if (h.by !== cancelled && this.rec.cancelled.has(h.by)) continue;
      return h.by;
    }
    return undefined;
  }

  statusOf(event: Seq, target: Target): Status[] {
    return this.items.filter((x) => x.event === event && x.target === target).map((x) => x.status);
  }
}

/** The targets of a conflict unit: a field, the fields of a group, or existence. */
function unitTargets(unit: ResolveOp["unit"]): readonly Target[] {
  return typeof unit === "string" ? [unit] : unit;
}

/** Whether `target` is in a conflict unit; the unit "existence" covers every target. */
function inUnit(unit: ResolveOp["unit"], target: Target): boolean {
  return unit === "existence" || unitTargets(unit).includes(target);
}

/** Step 3, "x 取代 r". */
function supersedes(x: Item, r: Item): boolean {
  const xIsFieldValue = x.target !== "existence" && x.content.kind === "value";
  if (r.content.kind === "revoke") return x.content.kind === "restore" || xIsFieldValue;
  if (r.content.kind === "restore") return x.content.kind === "revoke";
  return (x.target === r.target && x.content.kind !== "uncovered") || x.content.kind === "revoke";
}

/**
 * A deletion event's change as L of the conflict criterion (`externalChange`), with what its
 * record rests on: by unit (a field, or "existence"), the (event, target) of the contributions its
 * listed segments rest on (`deps`, see `externalDeps`). A unit resting on a contribution in the
 * deleted set counts as changed over the whole unit (`restsOnDeleted`).
 */
interface External {
  readonly op: OpNumber;
  readonly changed: Map<FieldId, IvSet>;
  readonly changedEntity: boolean;
  readonly deps: Map<Target, Set<string>>;
}

/**
 * Whether item `x` can give a block on `target` an end at a point (05-time «给出挡点的贡献»): an
 * item on the same field, on existence, or on a required field (at the boundary between a value
 * and none, a required field's end is the entity's). Every such item counts, both sides, covered
 * ones too — more than the recorded `deps`, never fewer for the ends.
 */
function mayGiveEnd(x: Item, target: string, required: readonly string[]): boolean {
  return (
    x.target === target ||
    x.target === "existence" ||
    target === "existence" ||
    required.includes(x.target)
  );
}

/** Whether `x` has an interval end at `p`. */
function endsAt(x: Item, p: Point): boolean {
  return x.valid.some((v) => (v.from !== null && v.from === p) || (v.to !== null && v.to === p));
}

/**
 * The contributions a deletion event's record of its change rests on (`External.deps`, by unit),
 * in its replay (09 §5.9 `results/<k>/fields/<f>/<j>`: the giver, carried, "and the other
 * contributions that cut the segment to what it is", the segment listed whole). The segments
 * listed are those whose value changed and those whose value is the same and given by another
 * item; for each, its giver and every item that may give one of its ends.
 */
function externalDeps(
  r: Replay,
  x: External,
  before: Evaluation,
  after: Evaluation,
  required: readonly string[],
): void {
  const fields = new Set<string>([...Object.keys(after.fields), ...Object.keys(before.fields)]);
  for (const f of fields) {
    const changed = x.changed.get(f as FieldId) ?? [];
    const was = before.fields[f as FieldId] ?? [];
    const giverAt = (seg: { valid: IvSet }) =>
      was.find((w) => covers(w.valid, seg.valid[0] ?? ALL))?.by;
    const listed = (after.fields[f as FieldId] ?? []).filter((seg) => {
      if (!isEmpty(intersect(seg.valid, changed))) return true;
      const b = giverAt(seg);
      return b === undefined || seg.by === undefined || b.event !== seg.by.event;
    });
    if (listed.length === 0 && isEmpty(changed)) continue;
    const deps = new Set<string>();
    for (const seg of listed) {
      if (seg.by !== undefined) deps.add(etKey(seg.by.event, seg.by.target as Target));
      const ends = seg.valid.flatMap((v) => [v.from, v.to]).filter((q): q is Point => q !== null);
      for (const i of r.items) {
        if (mayGiveEnd(i, f, required) && ends.some((q) => endsAt(i, q)))
          deps.add(etKey(i.event, i.target));
      }
    }
    // Where the value changed over no listed segment (a stretch left without a value), the items
    // in effect over it.
    for (const i of r.items) {
      if (
        (i.target === f || i.target === "existence") &&
        effective(i.status) &&
        !isEmpty(intersect(i.valid, changed))
      )
        deps.add(etKey(i.event, i.target));
    }
    x.deps.set(f as FieldId, deps);
  }
  if (x.changedEntity) {
    const on = r.items.filter((i) => i.target === "existence" && effective(i.status));
    x.deps.set("existence", new Set(on.map((i) => etKey(i.event, i.target))));
  }
}

/**
 * What a deletion's list of positions holds among interval blocks (09 §3.5 rule 1): every block
 * one of whose ends may be given by a contribution this deletion deletes or restates
 * (`mayGiveEnd`: its field, existence, a required field; other than the item itself). Used for
 * the indices once it is carried out (09 §5.7); L's interval and the write-time status go by the
 * deleted set instead (`restsOnDeleted`, `writeTimeStatusAt`).
 * `affected`: the (event, target) this deletion deletes (present before, absent after) or
 * restates; the caller takes it to a fixed point with the items restated as they are.
 *
 * Approximated by ends, not by the blocks' recorded `deps`: a giver is an item of the replay
 * before this deletion with an interval end at that point. Two ways it differs from the deps:
 * - more: an item ending at the point that did not give it (an end the block's own write gave);
 * - fewer: a giver that gave the end when the block was written and no longer ends there. E.g.
 *   #21's block ends at 11-10, given by #11; a pending deletion restates #11 to end at 11-08 (the
 *   block is on that deletion's list, removed only if it is carried out); a second deletion then
 *   deletes #11: #11 no longer ends at 11-10 in the replay before it, so #21's block is not on
 *   the second list, where the kernel, reading the deps, lists it.
 */
function removedBy(
  rec: Recorded,
  prev: Replay,
  affected: ReadonlySet<string>,
  by: string,
  required: readonly string[],
): { blocks: string[] } {
  const blocks: string[] = [];
  for (const [key, hist] of rec.history) {
    const target = key.slice(key.indexOf("/") + 1);
    hist.forEach((h, i) => {
      // Its own blocks (restated by it) are given on the state after it: not on its list.
      if (h.by === by) return;
      if (h.dropped || rec.cancelled.has(h.by) || rec.removed.has(`${key}#${i}`)) return;
      const ends = h.valid.flatMap((v) => [v.from, v.to]).filter((p): p is Point => p !== null);
      const given = ends.some((p) =>
        prev.items.some(
          (x) =>
            etKey(x.event, x.target) !== key &&
            mayGiveEnd(x, target, required) &&
            affected.has(etKey(x.event, x.target)) &&
            endsAt(x, p),
        ),
      );
      if (given) blocks.push(`${key}#${i}`);
    });
  }
  return { blocks };
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
): External {
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
  return { op, changed, changedEntity, deps: new Map() };
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

/** There is an item, and every item is in effect. */
const allEffective = (xs: readonly Status[]): boolean => xs.length > 0 && xs.every(effective);

const pendingStatus = (x: { status: string; closed?: true }) =>
  (x.status === "candidate" || x.status === "awaiting") && x.closed === undefined;

/**
 * The (event, target) a deletion of `sources` restates on its own (09 §5.9 «哪些项要重述», rule 1):
 * on the replay with the deletions carried out by then and these sources, a target whose items
 * differ from those on the replay with the carried-out deletions alone — an index, its status,
 * interval, content (a value, a write-back with no value or that only registers) or carried
 * references — or that is no longer there. Deps are not modelled (approximated by ends), so they
 * are not compared.
 */
function restatedOnItsOwn(
  replay: (deleted: ReadonlySet<SourceKey>) => Replay,
  executed: ReadonlyMap<string, readonly SourceKey[]>,
  sources: readonly SourceKey[],
): Set<string> {
  const carriedOut = [...executed.values()].flatMap((x) => [...x]);
  const judged = (r: Replay) => {
    const by = new Map<string, string[]>();
    for (const x of r.items) {
      const key = etKey(x.event, x.target);
      const j = JSON.stringify([x.k, x.status, x.valid, x.content, x.carried ?? []]);
      by.set(key, [...(by.get(key) ?? []), j]);
    }
    return new Map([...by].map(([k, v]) => [k, v.sort().join()]));
  };
  const before = judged(replay(new Set(carriedOut)));
  const after = judged(replay(new Set([...carriedOut, ...sources])));
  return new Set([...before].filter(([k, v]) => after.get(k) !== v).map(([k]) => k));
}

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
  options: {
    readonly forcedEffective?: readonly { event: Seq; target: Target }[];
    readonly forcedSuperseded?: readonly Seq[];
    /**
     * People's decisions on items as another evaluation of the same operations recorded them, by
     * operation (`LogStep.decided`): the baseline executes them on these items, not on the items
     * its own replay would find (a decision is as recorded in every replay).
     */
    readonly forcedDecided?: ReadonlyMap<OpNumber, readonly string[]>;
    /**
     * Decisions and `undo` in the grace period on a row or entity pending deletions affect:
     * refused, as the first version has it (the default; 03-deletion «撤回与宽限期»), or `allowed`,
     * as the rule set aside for a later version would have them: put-back candidates judged
     * again at the cancellation, a decision as recorded in every replay (decision record
     * grace-period-no-decisions.md, "之后要放开时"; not the spec). Only the default is compared with
     * the kernel.
     */
    readonly graceDecisions?: "refused" | "allowed";
    /**
     * Candidates a cancellation put back, with the judgement it gave them on the state at the
     * cancellation and the cancellation's operation (`LogStep.putBack`): the baseline keeps that
     * judgement, as the replays after the cancellation do (03-deletion «撤回与宽限期»).
     */
    readonly forcedRejudged?: readonly {
      readonly event: Seq;
      readonly target: Target;
      readonly judged: "dropped" | "corroborated" | "candidate";
      readonly at: OpNumber;
    }[];
    /**
     * For a deletion event's operation and a replay's deleted set, the units (fields, "existence")
     * whose record is on a current deletion's list of positions (09-references «冲突判据», L's
     * interval), as the log's blocks and their deps say; `undefined` leaves it to the
     * approximation by ends (`restsOnDeleted`).
     */
    readonly forcedWhole?: (
      op: OpNumber,
      deleted: ReadonlySet<SourceKey>,
    ) => ReadonlySet<Target> | undefined;
    /** Where `forcedWhole` decides, what the approximation by ends would have said (tests). */
    readonly observeWhole?: (
      op: OpNumber,
      deleted: ReadonlySet<SourceKey>,
      unit: Target,
      byEnds: boolean,
    ) => void;
  } = {},
): LogEvaluation {
  // Writes by source key are modelled on event and timeless tables, without the version seen,
  // and not with deletions (P3): anything else is refused, never judged by guess.
  const byKey = log.filter((e): e is WriteOp => e.kind === "write" && e.byKey === true);
  if (byKey.length > 0) {
    if (schema.kind === "state")
      throw new Error("not modelled: writes by source key on a state table");
    if (byKey.some((e) => e.seen !== undefined || e.seenCurrent !== undefined))
      throw new Error("not modelled: a write by source key carries no version seen");
    if (log.some((e) => e.kind === "deletion" || e.kind === "cancel" || e.kind === "execute"))
      throw new Error("not modelled: writes by source key in a log with deletions");
  }
  const rec: Recorded = {
    ...emptyRecorded(),
    ...(options.forcedWhole !== undefined ? { forcedWhole: options.forcedWhole } : {}),
    ...(options.observeWhole !== undefined ? { observeWhole: options.observeWhole } : {}),
  };
  const ops: Op[] = [];
  const pending = new Map<
    string,
    {
      op: OpNumber;
      sources: readonly SourceKey[];
      before: Replay;
      beforeState: Evaluation;
      removes?: { blocks: string[] };
    }
  >();
  // Deletions carried out (`execute`): deleted for good, no longer pending or cancellable.
  const executed = new Map<string, readonly SourceKey[]>();
  const steps: LogStep[] = [];
  // Every deletion confirmed, with the candidates and awaiting items in an item just before it and
  // the operation that cancelled it, if any: whether a write fell while a candidate was taken out
  // by a pending deletion (`removedAt`).
  const confirmed: { op: OpNumber; cancelledAt?: OpNumber; pendingBefore: Set<string> }[] = [];
  const pendingKeys = (ev: Evaluation) =>
    new Set(ev.items.filter(pendingStatus).map((x) => etKey(x.event, x.target)));
  /**
   * Whether the item of (event, target) was out of every item at operation `at` because a deletion
   * pending then had taken it out: in an item just before some deletion confirmed before `at` and
   * not cancelled by then, and just before `at` neither in an item nor in effect.
   */
  const removedAt = (key: string, at: OpNumber): boolean => {
    // Out of every item and not in effect either: one a deletion put in effect at that point is
    // the cancellation's "保持生效" case (`kept_effective`), not this one.
    const before = [...steps].reverse().find((x) => !x.refused && x.entry.op < at)?.state;
    if (
      before?.items.some(
        (x) =>
          etKey(x.event, x.target) === key && (pendingStatus(x) || effective(x.status as Status)),
      )
    )
      return false;
    return confirmed.some(
      (c) =>
        c.op < at &&
        (c.cancelledAt === undefined || c.cancelledAt > at) &&
        c.pendingBefore.has(key),
    );
  };
  const deletedNow = () =>
    new Set<SourceKey>([
      ...[...pending.values()].flatMap((d) => [...d.sources]),
      ...[...executed.values()].flatMap((x) => [...x]),
    ]);
  // Revert statuses are decided one by one in operation order and never judged again (09 §5.7,
  // 05-time «高影响写入»): a replay runs the operations in order, so deciding revert n sees the
  // earlier reverts by their decided status, and judges n itself as in effect (its write-backs
  // applied while high impact is judged).
  const replay = (deleted: ReadonlySet<SourceKey>) => {
    const r = new Replay(schema, ops, deleted, rec);
    r.run();
    return r;
  };
  let prev = replay(new Set());
  let prevState = prev.result();
  const fieldIds = (r: Replay) => r.fieldIds;

  for (const e of [...log].sort((a, b) => a.op - b.op)) {
    const deleted = deletedNow();
    if (e.kind === "deletion") {
      if (pending.has(e.id) || e.sources.some((x) => deleted.has(x))) {
        steps.push({ entry: e, refused: true, state: prevState });
        continue;
      }
      pending.set(e.id, { op: e.op, sources: e.sources, before: prev, beforeState: prevState });
      rec.deletionOp.set(e.id, e.op);
      rec.restatedAlone.set(e.id, restatedOnItsOwn(replay, executed, e.sources));
      confirmed.push({ op: e.op, pendingBefore: pendingKeys(prevState) });
      const r = replay(deletedNow());
      const state = r.result();
      const change = externalChange(e.op, prevState, state, fieldIds(r));
      externalDeps(r, change, prevState, state, schema.required);
      r.recordLatest(e.id);
      // What its list of positions would remove when carried out, and (09 §5.9 «哪些项要重述»
      // rule 2) the items whose block as last given is among them and still contributions:
      // restated as they are, so that a block stays readable after it is carried out.
      const after = new Set(r.items.map((x) => etKey(x.event, x.target)));
      const affected = new Set<string>();
      for (const x of prev.items) {
        const key = etKey(x.event, x.target);
        if (!after.has(key)) affected.add(key);
      }
      for (const [key, hist] of rec.history) if (hist.some((h) => h.by === e.id)) affected.add(key);
      // To a fixed point (09 §3.5 rule 1 with §5.9 rule 2): an item restated as it is because its
      // block is on the list is restated, so a block resting on it is on the list too.
      let removes = removedBy(rec, prev, affected, e.id, schema.required);
      for (let round = 0; ; round++) {
        if (round > rec.history.size + 1) throw new Error("removal list: no fixed point");
        const going = new Set(removes.blocks);
        let grew = false;
        for (const x of r.items) {
          const key = etKey(x.event, x.target);
          const hist = rec.history.get(key) ?? [];
          let last = -1;
          for (let i = hist.length - 1; i >= 0; i--) {
            const h = hist[i] as HistoryEntry;
            if (
              h.k !== x.k ||
              h.dropped ||
              rec.cancelled.has(h.by) ||
              rec.removed.has(`${key}#${i}`)
            )
              continue;
            last = i;
            break;
          }
          if (last >= 0 && going.has(`${key}#${last}`) && hist[last]?.by !== e.id) {
            rec.history.set(key, [...hist, { k: x.k, valid: x.valid, by: e.id }]);
            if (!affected.has(key)) {
              affected.add(key);
              grew = true;
            }
          }
        }
        if (!grew) break;
        removes = removedBy(rec, prev, affected, e.id, schema.required);
      }
      rec.external.push(change);
      const d = pending.get(e.id);
      if (d !== undefined) d.removes = removes;
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
      rec.cancelled.add(e.id);
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
          // The operation from which every item of the write on the target has been in effect
          // without interruption (the latest such stretch before the cancellation).
          let since: OpNumber = e.op;
          for (let i = steps.length - 1; i >= 0; i--) {
            const st = steps[i];
            if (st === undefined || st.refused) continue;
            // The view lists dropped items too: they are no contribution, not counted.
            const on = allEffective(
              st.state.items
                .filter((x) => etKey(x.event, x.target) === key && x.status !== "dropped")
                .map((x) => x.status as Status),
            );
            if (!on) break;
            since = st.entry.op;
          }
          return since;
        },
        removedAt,
      );
      const c = confirmed.find((x) => x.op === d.op);
      if (c !== undefined) c.cancelledAt = e.op;
      const r = replay(deletedNow());
      const state = r.result();
      const change = externalChange(e.op, prevState, state, fieldIds(r));
      externalDeps(r, change, prevState, state, schema.required);
      rec.external.push(change);
      r.recordLatest("cancel", e.id);
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
    if (e.kind === "execute") {
      // Carried out at expiry: what its list of positions holds is removed; the state is the
      // same. Not pending (nor cancellable) any more; still deleted.
      const d = pending.get(e.id);
      if (d === undefined) {
        steps.push({ entry: e, refused: true, state: prevState });
        continue;
      }
      pending.delete(e.id);
      executed.set(e.id, d.sources);
      for (const b of d.removes?.blocks ?? []) rec.removed.add(b);
      if ((d.removes?.blocks.length ?? 0) > 0) segmentStats.removed++;
      steps.push({ entry: e, refused: false, state: prevState });
      continue;
    }
    if (refused(e, deleted)) {
      steps.push({ entry: e, refused: true, state: prevState });
      continue;
    }
    // Removed whole by pending deletions (03-deletion «撤回与宽限期»), judged on the sets only: the
    // row or entity does not exist with the current deleted set and exists without the pending
    // deletions (here, every confirmed deletion is pending). Any other case follows the ordinary
    // rules. `not_found` lists every pending deletion touching its contributions there.
    if (
      (e.kind === "write" || e.kind === "revoke" || e.kind === "undo") &&
      pending.size > 0 &&
      !prevState.exists
    ) {
      const without = replay(new Set());
      if (without.result().exists) {
        const notFound = [...pending.entries()]
          .filter(([, d]) => touches(schema, ops, rec, without, d.sources))
          .sort(([, a], [, b]) => a.op - b.op)
          .map(([id]) => id);
        steps.push({ entry: e, refused: true, state: prevState, notFound });
        continue;
      }
    }
    // Nothing of the row or entity is left in the current replay (no item on any field or on
    // existence), and pending deletions are not the cause: as never created in this log, a write
    // to it by its ID is refused with the ordinary `not_found` (03-deletion «撤回与宽限期»). The
    // model has one row or entity and no `entity_key`: a write once it had an item is a write by
    // ID; before that it creates it (a write by `entity_key` would create a new entity instead).
    if (
      (e.kind === "write" || e.kind === "revoke" || e.kind === "undo") &&
      steps.some((x) => !x.refused && x.state.items.some((i) => i.status !== "dropped")) &&
      prevState.items.every((x) => x.status === "dropped")
    ) {
      steps.push({ entry: e, refused: true, state: prevState, notFound: [] });
      continue;
    }
    // In the grace period, no decision and no `undo` on a row or entity pending deletions affect
    // (03-deletion «撤回与宽限期»): affected when the replay with the current deleted set and the
    // one without any pending deletion (executed ones still deleted) differ on it, in a value, who
    // gives it, an item's sources, interval or judgement, or whether it exists. Refused as
    // `invalid_argument` (`pending_deletion_target`), with the pending deletions touching its
    // contributions. A decision the model finds invalid (its item not there or closed, 04-contract
    // `resolve` steps 1 and 2) is refused as invalid first, below. A request is one operation in
    // this model: the whole of it does not take effect.
    if (
      pending.size > 0 &&
      options.graceDecisions !== "allowed" &&
      (e.kind === "undo" ||
        ((e.kind === "resolve" || e.kind === "confirm" || e.kind === "reject") &&
          (options.forcedDecided?.has(e.op) === true || prev.validDecision(e))))
    ) {
      const without = replay(new Set([...executed.values()].flatMap((x) => [...x])));
      if (
        JSON.stringify(stateWithoutIndices(without.result())) !==
        JSON.stringify(stateWithoutIndices(prevState))
      ) {
        const by = [...pending.entries()]
          .filter(([, d]) => touches(schema, ops, rec, without, d.sources))
          .sort(([, a], [, b]) => a.op - b.op)
          .map(([id]) => id);
        steps.push({ entry: e, refused: true, state: prevState, pendingDeletionTarget: by });
        continue;
      }
    }
    // A take made while deletions are pending: what those deletions removed that is in effect
    // without them (`Recorded.takeRestorable`), on the history at this point.
    let restorable: Map<string, IvSet> | undefined;
    if (e.kind === "resolve" && e.decision === "take_candidate" && pending.size > 0) {
      const without = replay(new Set());
      restorable = new Map();
      for (const x of without.items) {
        if (x.status !== "applied") continue;
        const key = etKey(x.event, x.target);
        const now = union(
          ...prev.items
            .filter((y) => etKey(y.event, y.target) === key && y.status === "applied")
            .map((y) => y.valid),
        );
        const gone = subtract(x.valid, now);
        if (!isEmpty(gone)) restorable.set(key, union(restorable.get(key) ?? [], gone));
      }
    }
    // A decision is judged valid on the state without it; an invalid one never enters the log, as
    // a refused request. One forced as another evaluation recorded it (the baseline of «撤回还原»)
    // is executed as recorded, not judged again.
    if (
      (e.kind === "resolve" || e.kind === "confirm" || e.kind === "reject") &&
      !options.forcedDecided?.has(e.op) &&
      !prev.validDecision(e)
    ) {
      steps.push({ entry: e, refused: true, rejected: "invalid", state: prevState });
      continue;
    }
    // A write by source key on the row it finds (04-write-and-read «写法与定位»): revoked, it is
    // skipped; otherwise judged, and if every field is a no-op it is unchanged. Neither enters
    // the log. Whether the row has its key: an earlier write by key or key added is in the log.
    let sync: { keyed: boolean; fields: Partial<Record<FieldId, SyncFieldResult>> } | undefined;
    if (e.kind === "write" && e.byKey) {
      const keyed = ops.some((o) => o.kind === "write" && (o.byKey || o.keyAdded));
      // A row already there without a key is not what a write by key finds: the kernel locates by
      // key and would create another row, which this model of one row cannot say.
      if (!keyed && ops.length > 0)
        throw new Error("not modelled: a write by source key on a row without a key");
      const revoke = keyed ? prev.items.find((x) => prev.liveRevoke(x, ALL, INF)) : undefined;
      if (revoke !== undefined) {
        steps.push({
          entry: e,
          refused: false,
          outcome: "skipped",
          revokedBy: revoke.op,
          state: prevState,
        });
        continue;
      }
      const fields: Partial<Record<FieldId, SyncFieldResult>> = {};
      for (const f of Object.keys(e.fields) as FieldId[]) {
        const b = prev.syncBaseline(f, e.op);
        fields[f] = {
          status: "noop",
          baseline: b.has ? { value: b.value, position: b.position } : { position: b.position },
        };
      }
      sync = { keyed, fields };
    }
    ops.push(e);
    const r = replay(deleted);
    if (sync !== undefined) {
      const mine = r.items.filter((x) => x.event === e.event && x.target !== "existence");
      for (const x of mine) {
        const f = x.target as FieldId;
        const was = sync.fields[f];
        if (was !== undefined) sync.fields[f] = { ...was, status: x.status };
      }
      if (mine.length === 0) {
        ops.pop();
        steps.push({
          entry: e,
          refused: false,
          outcome: "unchanged",
          syncFields: sync.fields,
          state: prevState,
        });
        continue;
      }
    }
    // An operation rejected when judged never enters the log, as a refused request.
    const rejected = r.rejections.find((x) => x.op === e.op);
    if (rejected !== undefined) {
      ops.pop();
      steps.push({ entry: e, refused: true, rejected: rejected.reason, state: prevState });
      continue;
    }
    r.recordOp(e);
    if (restorable !== undefined && restorable.size > 0) rec.takeRestorable.set(e.op, restorable);
    const state = r.result();
    const decided = rec.decidedItems.get(e.op);
    steps.push({
      entry: e,
      refused: false,
      state,
      ...(decided !== undefined ? { decided: [...decided].sort() } : {}),
      ...(sync !== undefined
        ? { outcome: syncOutcome(sync.keyed, Object.values(sync.fields)), syncFields: sync.fields }
        : {}),
    });
    prev = r;
    prevState = state;
  }
  // The baseline of «撤回还原»: a replay of this log as written, with the given writes counted as
  // already in effect and so taking effect at their own write numbers, the given writes whose
  // items were kept superseded closed (as at a cancellation: they do not take effect), and the
  // given put-back candidates judged as the cancellation judged them. The write-time judgements
  // stay those of the log; only the final replay sees the forced sets.
  const forced = options.forcedEffective ?? [];
  const superseded = options.forcedSuperseded ?? [];
  const decidedAs = options.forcedDecided ?? new Map<OpNumber, readonly string[]>();
  const rejudged = options.forcedRejudged ?? [];
  if (forced.length > 0 || superseded.length > 0 || decidedAs.size > 0 || rejudged.length > 0) {
    for (const x of forced) rec.keptEffective.add(etKey(x.event, x.target));
    for (const e of superseded) rec.keptSuperseded.add(e);
    for (const [op, keys] of decidedAs) rec.decidedItems.set(op, new Set(keys));
    for (const x of rejudged) {
      rec.rejudged.set(etKey(x.event, x.target), x.judged);
      rec.rejudgedAt.set(etKey(x.event, x.target), x.at);
    }
    return { steps, final: replay(deletedNow()).result(), removed: [...rec.removed].sort() };
  }
  return { steps, final: prevState, removed: [...rec.removed].sort() };
}

/**
 * What a judged write by source key came to (04-contract §5.4): `created` when the row had no key
 * yet; `updated` when a field is in effect, a corroboration included (a corroboration is recorded,
 * so the op is not `unchanged`), with candidates possibly beside it; `pending` when no field is
 * in effect and some field is a candidate or awaiting.
 */
function syncOutcome(
  keyed: boolean,
  fields: readonly (SyncFieldResult | undefined)[],
): SyncOutcome {
  if (!keyed) return "created";
  return fields.some((x) => x?.status === "applied" || x?.status === "corroborated")
    ? "updated"
    : "pending";
}

/**
 * Requests refused while a deletion is pending (03-deletion «撤回与宽限期»): citing a source
 * pending deletion as evidence. (Writing to a row or entity pending deletions removed whole is
 * judged in `evaluateLog`, on two replays; so are decisions and `undo` on a row pending deletions
 * affect.)
 */
function refused(o: Op, deleted: ReadonlySet<SourceKey>): boolean {
  const cites: SourceKey[] =
    o.kind === "write"
      ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
      : o.kind === "revoke"
        ? [...(o.validSources ?? [])]
        : [];
  return cites.some((x) => deleted.has(x));
}

/**
 * Whether deleting `sources` touches a contribution of the row or entity in `replay`: an item
 * whose own value or interval sources are among them, or an item carried from one that is.
 */
function touches(
  schema: TableSchema,
  ops: readonly Op[],
  rec: Recorded,
  replay: Replay,
  sources: readonly SourceKey[],
): boolean {
  const probe = new Replay(schema, ops, new Set(sources), rec);
  const byRef = new Map(replay.items.map((x) => [refKey(x), x]));
  const seen = new Set<string>();
  const hit = (x: Item): boolean => {
    const key = refKey(x);
    if (seen.has(key)) return false;
    seen.add(key);
    if (probe.deletedItem(x.event, x.target)) return true;
    return (x.carried ?? []).some((r) => {
      const y = byRef.get(refKey(r));
      return y !== undefined ? hit(y) : probe.deletedItem(r.event, r.target);
    });
  };
  return replay.items.some(hit);
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
  removedAt: (key: string, at: OpNumber) => boolean,
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
  // Pending without this deletion, the others still applied: an item not pending now but pending
  // there was superseded by this deletion; one not pending there either, by another. Only this
  // replay decides, not the state before this deletion was confirmed (another deletion may have
  // taken the item out by then), so the order of cancellations does not matter.
  const withoutThisState = replayAfter().result();
  const pendingWithoutThis = pendingIn(withoutThisState);
  // Item membership, approximated (the evaluator does not track item identities): the other
  // candidates pending on the same unit just before the deletion share the item.
  const siblings = (key: string, target: Target): Seq[] =>
    d.beforeState.items
      .filter(
        (x) =>
          x.target === target &&
          etKey(x.event, x.target) !== key &&
          x.status === "candidate" &&
          pendingStatus(x),
      )
      .map((x) => x.event);
  // The item stayed open after the deletion removed this candidate, and a grace-period decision
  // resolved it: a resolve on the unit whose candidates include one of the siblings. An item that
  // lost its only candidate was superseded by the deletion instead (and is restored). Reached only
  // with `graceDecisions: "allowed"`: in the first version a row a deletion took a candidate from
  // is affected, so no decision falls on it in the grace period (03-deletion «撤回与宽限期»).
  const resolvedInGrace = (key: string, target: Target): boolean => {
    const sib = siblings(key, target);
    return grace.some(
      (y) =>
        y.kind === "resolve" && inUnit(y.unit, target) && y.candidates.some((c) => sib.includes(c)),
    );
  };

  for (const key of new Set([...ets(preCancel), ...ets(d.before), ...pendingWithoutThis])) {
    const [ev, target] = key.split("/") as [string, Target];
    const event = Number(ev);
    const atWrite = rec.writeTime.get(key) ?? [];
    // By the unit, the write on the target (03-deletion «撤回与宽限期»): not every item in effect
    // when written (so not protected by deviation two: a corroboration when written does not
    // prevent this, it is not protected either), every item in effect before the cancellation,
    // and not so without this deletion. Kept when, besides, a baseline write saw a version not
    // earlier than the operation from which every item has been in effect (`effectiveSince`).
    const madeEffective =
      atWrite.length > 0 &&
      !atWrite.every((x) => effective(x.status)) &&
      allEffective(preCancel.statusOf(event, target)) &&
      !allEffective(withoutThis.statusOf(event, target));
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
    // Items this deletion superseded stay superseded when a grace-period write changed what they
    // concern, by the conflict criterion (`kept_superseded`); the others are restored. An item
    // another pending deletion superseded is not this cancellation's to keep or restore.
    // The item counts as superseded by the deletion when no other candidate of the same unit
    // stayed pending and no grace-period resolution closed it (same modelling limit as below).
    const itemLives =
      siblings(key, target).some((other) => nowPending.has(etKey(other, target))) ||
      resolvedInGrace(key, target);
    if (!nowPending.has(key) && pendingWithoutThis.has(key) && !itemLives) {
      // The candidate as it would be pending without this deletion.
      const was = withoutThisState.items.filter((x) => x.event === event && x.target === target);
      // "Changed" by the conflict criterion (09-references-conflict-sync «冲突判据» ②): a write
      // made while the candidate was taken out by a pending deletion — by this one or by another,
      // in no item at that point — changed the unit's value in effect where the candidate lies,
      // and the candidate's value differs from the new one there. Judged as the write was judged
      // when written (its items as recorded then: a change in effect, not a corroboration, a
      // candidate or a no-op), once for each write: not on the state at this cancellation, which
      // the deletions pending now would change. So the order in which the deletions are cancelled
      // does not matter, nor which of them the write fell after, and a cancellation in whose grace
      // period nothing was written keeps nothing superseded.
      const changedBy = (y: Op): boolean =>
        was.some((w) => {
          const mine = w.content.kind === "value" ? tok(w.content.value) : undefined;
          const fields = target === "existence" ? preCancel.fieldIds : [target as FieldId];
          return [...fields, "existence" as const].some((t) =>
            (rec.writeTime.get(etKey(y.event, t)) ?? []).some((b) => {
              if (b.status !== "applied" || isEmpty(intersect(b.valid, w.valid))) return false;
              // On a field candidate, a revoke over it changes the field; a restore or a
              // write-back that only registers does not.
              if (t === "existence") return target === "existence" || b.content.kind === "revoke";
              if (b.content.kind === "uncovered") return false;
              if (mine === undefined) return true;
              return b.content.kind !== "value" || tok(b.content.value) !== mine;
            }),
          );
        });
      const touched = ops.some((y) => y.op < cancelOp && removedAt(key, y.op) && changedBy(y));
      if (touched) rec.keptSuperseded.add(event);
    }
  }

  // Candidates the deletion removed, of an item resolved in the grace period, are put back and
  // judged on the state at the cancellation: same value as in effect → no-op or corroboration,
  // otherwise a new conflict item. A re-judged candidate stays at its own write number. Only with
  // `graceDecisions: "allowed"`, the rule set aside for a later version (decision record
  // grace-period-no-decisions.md); the first version has no put-back candidates.
  // Modelling limit: the evaluator does not track item identities; "its item was resolved" is
  // taken as "a grace-period resolve on the unit lists a candidate pending alongside it just
  // before the deletion" (see `resolvedInGrace`).
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
    return sources.some((x) => d.sources.includes(x)) && resolvedInGrace(key, target);
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
    rec.rejudgedAt.set(key, cancelOp);
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
