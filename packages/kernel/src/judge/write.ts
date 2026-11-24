// Judging a write or a revoke (docs/zh-CN/spec/03-data-model/04-write-and-read.md «判定顺序»;
// 05-time «用同样的值写» «高影响写入» «无值区间» «状态类表上的撤销»; 09-references-conflict-sync
// «冲突判据» «撤销与并发修改»).

import type {
  BizPoint,
  FieldId,
  FieldValue,
  OpNumber,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import { sameValue } from "../delta/index.ts";
import {
  canonical,
  type Interval,
  type IntervalSet,
  isNothing,
  meet,
  minus,
  parts,
  startOf,
  unionOf,
  WHOLE,
  within,
} from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import type {
  Conflict,
  CoveredCorroboration,
  FieldInput,
  ItemRef,
  ItemStatus,
  Overwritten,
  RecordedItem,
  RevokeInput,
  Shown,
  Target,
  WriteInput,
} from "./model.ts";
import { seenOf } from "./model.ts";
import { type Resolved, resolve, uniqueRefs } from "./resolve.ts";
import { type Item, type Limit, NO_VALUE, type RowState, refOf, valueToken } from "./state.ts";
import { type SyncBaseline, syncBaseline } from "./sync.ts";

/** What judging one write or revoke gives, before the record is assembled. */
export interface WriteOutcome {
  readonly items: readonly RecordedItem[];
  readonly noop: readonly FieldId[];
  readonly conflicts: readonly Conflict[];
  readonly erased: readonly { readonly field: FieldId; readonly at: readonly BizPoint[] }[];
  readonly overwritten: readonly Overwritten[];
  readonly acknowledged: boolean;
  readonly warnings: readonly CoveredCorroboration[];
  /**
   * A write by external key hitting a row: the sync baseline position each field it gives a value
   * was judged on (no-op fields left out: they leave no value).
   */
  readonly baseline?: Readonly<Partial<Record<FieldId, OpNumber>>>;
}

/** One part of a field the write judges as an ordinary write (conflict criterion). */
interface Part {
  readonly f: FieldId;
  readonly input: FieldInput;
  /** The interval as resolved on the seen version (a candidate's interval). */
  readonly seenValid: IntervalSet;
  readonly defaultEnd: boolean;
  readonly from: BizPoint | null;
  /**
   * Resolve again on the current state when merged. A corroboration's changed part is resolved
   * again too, by its own path (`corroboration` below), so this is not set for it.
   */
  readonly reResolve: boolean;
  readonly deps: readonly ItemRef[];
  /**
   * The part of a corroboration written with a default end that changed since the seen version
   * (05-time «用同样的值写»): judged as the write was written. A candidate as it stands, beside
   * the corroborations `same` gives; merged, the write's interval is resolved on the current state
   * and cut there into what is still the same (corroborations) and what changed (in effect).
   */
  readonly corroboration?: {
    readonly same: readonly Draft[];
    readonly cutters: readonly ItemRef[];
  };
}

export interface Draft {
  readonly target: FieldId | "existence";
  readonly status: ItemStatus;
  readonly valid: IntervalSet;
  readonly content: RecordedItem["content"];
  readonly carried?: readonly ItemRef[];
  readonly deps: readonly ItemRef[];
  readonly onExistence?: true;
}

/** Positions of op `index` of request `n`: its seen version, the current state, after it. */
function positions(seen: OpNumber, n: OpNumber, index: number) {
  return {
    seenAt: { upTo: seen, request: { op: n, below: index } } as Limit,
    curAt: { upTo: n - 1, request: { op: n, below: index } } as Limit,
    afterAt: { upTo: n - 1, request: { op: n, below: index + 1 } } as Limit,
  };
}

/** Indices by interval start from 0, per target (09 §5.7). */
export function numbered(drafts: readonly Draft[]): RecordedItem[] {
  const out: RecordedItem[] = [];
  const targets = [...new Set(drafts.map((d) => d.target))].sort();
  for (const t of targets) {
    const ds = drafts
      .filter((d) => d.target === t)
      .sort((a, b) => {
        const x = startOf(a.valid);
        const y = startOf(b.valid);
        if (x === y) return 0;
        if (x === null) return -1;
        if (y === null) return 1;
        return x < y ? -1 : 1;
      });
    ds.forEach((d, k) => {
      out.push({
        target: d.target,
        k,
        status: d.status,
        valid: d.valid,
        content: d.content,
        ...(d.carried !== undefined ? { carried: d.carried } : {}),
        deps: d.deps,
        ...(d.onExistence ? { onExistence: true as const } : {}),
      });
    });
  }
  return out;
}

export function asItems(
  items: readonly RecordedItem[],
  o: { op: OpNumber; index: number; event: number },
): Item[] {
  return items.map((x) => ({
    event: o.event,
    target: x.target,
    k: x.k,
    op: o.op,
    index: o.index,
    status: x.status,
    valid: x.valid,
    content: x.content,
    ...(x.carried !== undefined ? { carried: x.carried } : {}),
    deps: x.deps,
    ...(x.onExistence ? { onExistence: true as const } : {}),
    explicitEnds: [],
    defaultEnd: false,
  }));
}

/**
 * Only when a deletion's replay judges a write again (`replayDeletion`, 03-deletion «删除结果的
 * 定义»): what the record keeps from the write as judged when written.
 */
export interface ReplayOptions {
  /** Fields judged a no-op when written: a no-op in every replay (09 §5.7 `ops/<i>/noop`). */
  readonly noop: ReadonlySet<FieldId>;
  /**
   * Targets on which every item of the write was in effect when written (deviation two, by the
   * write on a target): judged without the conflict step and never awaiting; their intervals and
   * values are worked out again.
   */
  readonly protect: ReadonlySet<Target>;
  /**
   * Targets whose awaiting item a person's later confirmation or rejection decided (deviation
   * one): judged without the conflict step and awaiting, for the decision to execute as recorded.
   */
  readonly decided: ReadonlySet<Target>;
  /**
   * A person rejected the write (03-deletion «重放规则 · 冲突消失之后»): the rejection is of the
   * whole write, so no target of it takes effect but those protected by deviation two.
   */
  readonly rejected: boolean;
  /**
   * Targets a person's conflict resolution listed among the candidates it decided (deviation one,
   * 01-objects «处理之后事项不重开»): a candidate in every replay, whether or not the conflict is
   * still there, so the resolution's record still closes it. The value: whether the candidate was
   * in an item on existence (it met a revoke), as recorded when written. Absent: none.
   */
  readonly resolved?: ReadonlyMap<Target, boolean>;
  /**
   * Collects the shadows (state.ts `Item.shadow`): each field the same as its seen version with no
   * evidence pointed at, its value and its interval as written-time rules resolve it on the
   * replay's state, with what cuts it. A deletion's replay only: when written such a field is a
   * no-op, never a candidate, so nothing there needs it.
   */
  readonly shadows?: Shadow[];
}

/** A field a write gives no item on in a replay, as a conflict resolution's K still counts it. */
export interface Shadow {
  readonly event: Seq;
  readonly target: FieldId;
  readonly value: FieldValue;
  readonly valid: IntervalSet;
  readonly deps: readonly ItemRef[];
  /** Written with a default end, as the item it would be (state.ts `Item.defaultEnd`). */
  readonly defaultEnd: boolean;
}

export function judgeWrite(state: RowState, w: WriteInput, replay?: ReplayOptions): WriteOutcome {
  const n = w.op;
  const { seenAt, curAt, afterAt } = positions(seenOf(w), n, w.index);
  const fields = (Object.keys(w.fields) as FieldId[]).sort();
  // A write by external key hitting a row (09-references-conflict-sync «冲突判据», the paragraph
  // on writes by external key): each field's version seen is its own sync baseline position, and
  // its same-value step compares with the baseline value. Every other write: one version seen.
  const sync =
    w.sync !== undefined && w.sync.creates !== true ? baselines(state, w, curAt) : undefined;
  const seenFor = (f: FieldId): OpNumber => sync?.get(f)?.position ?? seenOf(w);
  const seenAtFor = (f: FieldId): Limit =>
    sync === undefined ? seenAt : positions(seenFor(f), n, w.index).seenAt;
  const drafts: Draft[] = [];
  const noop: FieldId[] = [];
  const ordinary: Part[] = [];
  const seenRes = new Map<FieldId, Resolved>();

  // Where this write itself makes the entity begin to exist (state tables): on a piece without a
  // value at the position compared, every field that defines "has a value" is given by it (not
  // empty) or has a value there already (with none, any field it gives). There an optional field
  // written empty is as one not given: read as empty, not as no value (10-types-and-units «清空字段»:
  // 新增时显式写 null 与"原来没有值"同值). Elsewhere a piece without a value stays one (a write of
  // optional fields alone does not fill it). Judged at the position compared, as the token is: the
  // version seen for the same-value step, the current one for whether a corroboration still holds
  // (05-time «用同样的值写»: a part changed since the version seen is an ordinary write). The fields
  // are those of existence (`valued`, 05-time «无值区间»), the ones a token of "no value" reads.
  const givenRes = new Map<string, Resolved | null>();
  const givenOn = (g: FieldId, s: Interval, at: Limit) => {
    const x = w.fields[g];
    if (x === undefined || x.value === null) return false;
    const key = `${g}@${at.upTo}/${at.request?.op ?? ""}/${at.request?.below ?? ""}`;
    if (!givenRes.has(key)) givenRes.set(key, resolve(state, w.valid, g, at, w.now));
    const r = givenRes.get(key);
    return r !== null && r !== undefined && within(s, r.valid);
  };
  const valued = state.table.valued;
  const createdHere = (s: Interval, atOf: (g: FieldId) => Limit) =>
    state.isState &&
    (valued.length > 0
      ? valued.every(
          (g) => givenOn(g, s, atOf(g)) || state.fieldState(g, s, atOf(g)).kind === "value",
        )
      : fields.some((g) => givenOn(g, s, atOf(g))));
  /**
   * A field's token on a piece at a position, empty where this write makes the entity begin to
   * exist there. `atOf`: the position for each field (per field as seen, by a sync's baselines).
   */
  const tokenFor = (f: FieldId, s: Interval, atOf: (g: FieldId) => Limit, v: string) => {
    const t = state.token(f, s, atOf(f));
    return t === NO_VALUE && v === "none" && createdHere(s, atOf) ? "none" : t;
  };
  const atCur = () => curAt;

  // Same value (step 3): no-op, corroboration, or an ordinary write on the changed part.
  for (const f of fields) {
    const input = w.fields[f] as FieldInput;
    if (replay?.noop.has(f)) {
      noop.push(f);
      continue;
    }
    const res = resolve(state, w.valid, f, seenAtFor(f), w.now);
    // Checked when written only: in a replay, a field resolving to nothing gives nothing.
    if (res === null && replay !== undefined) continue;
    if (res === null) {
      throw new JudgeError("invalid_argument", "the field has no value at now; give an interval", {
        reason: "no_value_now",
        field: f,
      });
    }
    seenRes.set(f, res);
    const v = valueToken(input.value);
    const segs = state.piecesIn(res.valid);
    const base = sync?.get(f);
    if (base?.value !== undefined && valueToken(base.value) === v) {
      // The source has not changed: a no-op whatever evidence is pointed at, unless the value in
      // effect is that value too; then pointed evidence corroborates (taken below).
      if (!input.explicit || !segs.every((s) => tokenFor(f, s, atCur, v) === v)) {
        noop.push(f);
        continue;
      }
    }
    // With a baseline value, the same-value step compares with it alone (the three-way table's
    // step ①): another value is the source changed, judged for conflicts on the baseline position,
    // whatever the value there. Without one, as an ordinary write on the baseline position.
    const sameAsSeen =
      base?.value !== undefined
        ? valueToken(base.value) === v
        : segs.every((s) => tokenFor(f, s, seenAtFor, v) === v);
    if (sameAsSeen && !input.explicit) {
      noop.push(f);
      replay?.shadows?.push({
        event: w.event,
        target: f,
        value: input.value,
        valid: res.valid,
        deps: res.deps,
        defaultEnd: res.defaultEnd,
      });
      continue;
    }
    if (!sameAsSeen) {
      ordinary.push({
        f,
        input,
        seenValid: res.valid,
        defaultEnd: res.defaultEnd,
        from: res.from,
        reResolve: true,
        deps: res.deps,
      });
      continue;
    }
    // Corroboration: still the same now → corroborated; changed since → an ordinary write on
    // that part, as the write was written, with the writes that changed it among its deps.
    const same = canonical(segs.filter((s) => tokenFor(f, s, atCur, v) === v));
    const changed = minus(res.valid, same);
    const cutters = isNothing(changed) ? [] : changersOf(state, f, seenFor(f), n, res.valid);
    const split = !isNothing(changed);
    const corroborations = parts(same).map(
      (piece): Draft => ({
        target: f,
        status: "corroborated",
        valid: piece,
        content: { kind: "value", value: input.value },
        deps: uniqueRefs([...res.deps, ...(split ? cutters : [])]),
      }),
    );
    if (split && res.defaultEnd) {
      // A default end: the changed part is the write's, from its start, to the next change.
      ordinary.push({
        f,
        input,
        seenValid: changed,
        defaultEnd: true,
        from: res.from,
        reResolve: true,
        deps: uniqueRefs([...res.deps, ...cutters]),
        corroboration: { same: corroborations, cutters },
      });
      continue;
    }
    drafts.push(...corroborations);
    // An interval given (or a correction's span): each changed piece as an explicit interval.
    for (const piece of parts(changed)) {
      ordinary.push({
        f,
        input,
        seenValid: piece,
        defaultEnd: false,
        from: startOf(piece),
        reResolve: false,
        deps: uniqueRefs([...res.deps, ...cutters]),
      });
    }
  }

  // `ver` and conflicts (step 4), by conflict unit: a conflict anywhere in the unit makes every
  // part W judges there a candidate, as a whole (conflict criterion ⑤). Corroborated parts above
  // stay as they are. A conflict with a revoke targets existence (撤销与并发修改).
  const conflicts: Conflict[] = [];
  const units = new Map<string, Part[]>();
  for (const p of ordinary) {
    const key = (state.unitOf.get(p.f) ?? [p.f]).join(",");
    units.set(key, [...(units.get(key) ?? []), p]);
  }
  const applied: Draft[] = [];
  for (const all of units.values()) {
    const unit = state.unitOf.get((all[0] as Part).f) ?? [];
    // In a replay, a target protected by deviation two, or decided by a person, is not judged for
    // conflicts.
    const exempt = (p: Part) =>
      replay?.protect.has(p.f) === true || replay?.decided.has(p.f) === true;
    const protectedParts = all.filter(exempt);
    const ps = all.filter((p) => !exempt(p));
    const withOps = new Set<OpNumber>();
    let withRevoke = false;
    for (const p of ps) {
      const c = conflictingOps(state, w, p, unit, seenRes, seenFor(p.f), seenAtFor, curAt);
      for (const m of c.ops) withOps.add(m);
      withRevoke ||= c.revoke;
    }
    // A candidate a resolution decided stays one, in the item it was in when written.
    const resolvedHere = ps.filter((p) => replay?.resolved?.has(p.f) === true);
    if (resolvedHere.length > 0 && withOps.size === 0) {
      withRevoke = resolvedHere.some((p) => replay?.resolved?.get(p.f) === true);
    }
    if (withOps.size > 0 || resolvedHere.length > 0) {
      for (const p of ps) {
        // A corroboration's changed part: a candidate a piece, its corroborations as they are.
        if (p.corroboration !== undefined) drafts.push(...p.corroboration.same);
        for (const piece of p.corroboration !== undefined ? parts(p.seenValid) : [p.seenValid]) {
          drafts.push({
            target: p.f,
            status: "candidate",
            valid: piece,
            content: { kind: "value", value: p.input.value },
            deps: p.deps,
            ...(withRevoke ? { onExistence: true as const } : {}),
          });
        }
      }
      if (withOps.size > 0) {
        conflicts.push({
          unit: withRevoke ? "existence" : { fields: unit },
          with: [...withOps].sort((x, y) => x - y),
          items: ps.map((p) => ({ event: w.event, target: p.f, k: -1 })),
        });
      }
    }
    for (const p of withOps.size > 0 || resolvedHere.length > 0 ? protectedParts : all) {
      if (p.corroboration !== undefined) {
        // Merged: the write's interval resolved on the current state (conflict criterion ④),
        // cut there into what is still the same and what changed; the blocking points' givers
        // among the deps (09 §3.5), the writes that changed it too. Under the rules as they are,
        // only one of the two is ever there: the interval ends at the field's next blocking
        // point, so the value is one all along it, the same as the write's or not. It is kept as
        // a cut, not as a test of the one value, so that it stays right if what blocks a default
        // end changes (a corroboration's ends, 08 «P3 前»).
        const now = resolve(state, w.valid, p.f, curAt, w.now);
        if (now === null) continue;
        const v = valueToken(p.input.value);
        const sameNow = canonical(
          state.piecesIn(now.valid).filter((s) => state.token(p.f, s, curAt) === v),
        );
        const deps = uniqueRefs([...now.deps, ...p.corroboration.cutters]);
        const content = { kind: "value" as const, value: p.input.value };
        for (const piece of parts(sameNow)) {
          drafts.push({ target: p.f, status: "corroborated", valid: piece, content, deps });
        }
        for (const piece of parts(minus(now.valid, sameNow))) {
          applied.push({ target: p.f, status: "applied", valid: piece, content, deps });
        }
        continue;
      }
      // Merged: the interval is resolved on the current state (conflict criterion ④).
      const cur = p.reResolve ? resolve(state, w.valid, p.f, curAt, w.now) : null;
      applied.push({
        target: p.f,
        status: "applied",
        valid: cur?.valid ?? p.seenValid,
        content: { kind: "value", value: p.input.value },
        deps: cur?.deps ?? p.deps,
      });
    }
  }

  // Event and timeless tables: a revoked row cannot be written; checked on the part taking effect
  // only, after the conflict step, so a stale write meeting a revoke is a candidate (step 5).
  // Checked when written only, not in a replay: the write is in the log.
  if (!state.isState && applied.length > 0 && state.revoked(curAt) && replay === undefined) {
    throw new JudgeError("revoked", "the row is revoked", { ops: state.revokedBy(curAt) });
  }

  // Checks that depend on the current state, on the part taking effect only (step 5).
  if (state.isState && replay === undefined) checkGaps(state, w, applied, curAt);

  // High impact ① (step 6).
  let erased: { field: FieldId; at: BizPoint[] }[] = [];
  let overwritten: Overwritten[] = [];
  let acknowledged = false;
  if (state.isState && applied.length > 0) {
    const tentative = state.with(
      asItems(numbered(applied), { op: n, index: w.index, event: w.event }),
    );
    erased = state.table.fields
      .map((f) => {
        const seenPoints = new Set(state.impactPoints(f, seenAt));
        const before = state.impactPoints(f, curAt).filter((p) => seenPoints.has(p));
        const after = new Set(tentative.impactPoints(f, afterAt));
        return { field: f, at: before.filter((p) => !after.has(p)) };
      })
      .filter((x) => x.at.length > 0);
    if (erased.length > 0) {
      overwritten = applied.flatMap((d) => overwrittenBy(state, d, curAt));
      acknowledged = acknowledges(state, w);
    }
  }
  const awaiting = erased.length > 0 && !acknowledged;
  // A target protected by deviation two never awaits (03-deletion «重放规则» 已生效的保持生效).
  for (const d of applied) {
    const protects = replay?.protect.has(d.target) === true;
    // Decided by a person, or of a rejected write: awaiting, whatever its impact now.
    const held =
      replay !== undefined && (replay.decided.has(d.target) || (replay.rejected && !protects));
    drafts.push((awaiting && !protects) || held ? { ...d, status: "awaiting" } : d);
  }

  const warnings = awaiting || !state.isState ? [] : coveredCorroborations(state, applied, curAt);
  const items = numbered(drafts);
  // A write is one candidate in one item: every part of it that met a revoke goes to the one
  // conflict on existence (09-references-conflict-sync «撤销与并发修改»; 09 §5.8 "同一条
  // write.base 在同一个事项里至多是一个候选").
  const onExistence = conflicts.filter((c) => c.unit === "existence");
  if (onExistence.length > 1) {
    const first = conflicts.indexOf(onExistence[0] as Conflict);
    const merged: Conflict = {
      unit: "existence",
      with: [...new Set(onExistence.flatMap((c) => c.with))].sort((x, y) => x - y),
      items: onExistence.flatMap((c) => c.items),
    };
    const rest = conflicts.filter((c) => c.unit !== "existence");
    conflicts.length = 0;
    conflicts.push(...rest.slice(0, first), merged, ...rest.slice(first));
  }
  const withItems = conflicts.map((c) => {
    const targets = new Set(c.items.map((x) => x.target));
    return {
      ...c,
      items: items
        .filter((x) => x.status === "candidate" && targets.has(x.target))
        .map((x) => ({ event: w.event, target: x.target, k: x.k })),
    };
  });
  return {
    items,
    noop,
    conflicts: withItems,
    erased,
    overwritten,
    acknowledged,
    warnings,
    ...(sync !== undefined
      ? {
          baseline: Object.fromEntries(
            fields.filter((f) => !noop.includes(f)).map((f) => [f, seenFor(f)]),
          ) as Partial<Record<FieldId, OpNumber>>,
        }
      : {}),
  };
}

/**
 * Each field's sync baseline for a write by key hitting a row (./sync.ts), as of the state before
 * it. A key field among the fields is the caller's mistake: hitting a row, they are no-ops.
 */
function baselines(state: RowState, w: WriteInput, curAt: Limit): Map<FieldId, SyncBaseline> {
  const keyFields = w.sync?.keyFields ?? [];
  const out = new Map<FieldId, SyncBaseline>();
  for (const f of Object.keys(w.fields) as FieldId[]) {
    if (keyFields.includes(f)) {
      throw new JudgeError("invalid", "a key field judged in a write by key hitting a row", {
        field: f,
      });
    }
    out.set(f, syncBaseline(state, f, { op: w.op, index: w.index }, curAt, keyFields));
  }
  return out;
}

/** The items in effect after the seen version that changed `f` (or existence) inside `valid`. */
function changersOf(
  state: RowState,
  f: FieldId,
  seen: OpNumber,
  n: OpNumber,
  valid: IntervalSet,
): ItemRef[] {
  return state.items
    .filter(
      (x) =>
        x.op > seen &&
        x.op < n &&
        x.status === "applied" &&
        (x.target === f || x.target === "existence") &&
        !isNothing(meet(x.valid, valid)),
    )
    .map(refOf);
}

/**
 * The group value of W on a piece (09-references-conflict-sync «冲突判据»): W's value for the
 * fields of the unit it writes there, the seen version's value for the others.
 */
function groupOfWrite(
  state: RowState,
  w: WriteInput,
  unit: readonly FieldId[],
  seenRes: ReadonlyMap<FieldId, Resolved>,
  seg: Interval,
  seenAt: (g: FieldId) => Limit,
): string {
  return unit
    .map((g) => {
      const input = w.fields[g];
      const res = seenRes.get(g);
      if (input !== undefined && res !== undefined && within(seg, res.valid)) {
        return valueToken(input.value);
      }
      return state.token(g, seg, seenAt(g));
    })
    .join("|");
}

function groupAt(state: RowState, unit: readonly FieldId[], seg: Interval, at: Limit): string {
  return unit.map((g) => state.token(g, seg, at)).join("|");
}

/**
 * The operations after the seen version (other requests) that W's part conflicts with
 * (09-references-conflict-sync «冲突判据» ②③).
 */
function conflictingOps(
  state: RowState,
  w: WriteInput,
  p: Part,
  unit: readonly FieldId[],
  seenRes: ReadonlyMap<FieldId, Resolved>,
  seen: OpNumber,
  seenAt: (g: FieldId) => Limit,
  curAt: Limit,
): { ops: OpNumber[]; revoke: boolean } {
  const out: OpNumber[] = [];
  for (const m of state.opsBetween(seen, w.op)) {
    const changed = unionOf(...unit.map((g) => state.changedBy(m, g)));
    if (isNothing(changed)) continue;
    if (!state.isState) {
      out.push(m);
      continue;
    }
    const lItems = state.items.filter(
      (x) =>
        x.op === m &&
        x.status === "applied" &&
        (x.target === "existence" || unit.includes(x.target)),
    );
    const lFields = lItems.filter((x) => x.target !== "existence");
    if (p.defaultEnd && lFields.length > 0 && lFields.every((x) => x.defaultEnd)) {
      // Both with a default end: a conflict when they start together and the group values differ.
      const lFrom = startOf((lFields[0] as Item).valid);
      if (lFrom !== null && lFrom === p.from) {
        const seg = state.pieces([[{ from: lFrom, to: null }]]).find((s) => s.from === lFrom);
        if (
          seg !== undefined &&
          groupOfWrite(state, w, unit, seenRes, seg, seenAt) !==
            groupAt(state, unit, seg, { upTo: m })
        ) {
          out.push(m);
        }
      }
      continue;
    }
    const lValid = lItems.length > 0 ? unionOf(...lItems.map((x) => x.valid)) : changed;
    const inter = meet(p.seenValid, lValid);
    if (
      state
        .piecesIn(inter)
        .some(
          (s) =>
            groupOfWrite(state, w, unit, seenRes, s, seenAt) !== groupAt(state, unit, s, curAt),
        )
    ) {
      out.push(m);
    }
  }
  // The conflict is with a revoke when one of these operations revoked where the part lies.
  const revoke = state.items.some(
    (x) =>
      out.includes(x.op) &&
      x.status === "applied" &&
      x.content.kind === "revoke" &&
      !isNothing(meet(x.valid, p.seenValid)),
  );
  return { ops: out, revoke };
}

/**
 * The part taking effect that falls where the entity has no value must carry every required
 * field (05-time «无值区间»).
 */
function checkGaps(state: RowState, w: WriteInput, applied: readonly Draft[], curAt: Limit): void {
  checkGapsOf(state, Object.keys(w.fields) as FieldId[], applied, curAt);
}

/**
 * The parts taking effect that fall where the entity has no value must give every required field
 * (05-time «无值区间»): `validation_failed` otherwise, with each missing field and where (`gaps`).
 */
export function checkGapsOf(
  state: RowState,
  given: readonly FieldId[],
  applied: readonly Draft[],
  curAt: Limit,
): void {
  const missing = state.table.required.filter((f) => !given.includes(f));
  if (missing.length === 0) return;
  const gap = canonical(
    applied.flatMap((d) => state.piecesIn(d.valid).filter((s) => !state.hasValue(s, curAt))),
  );
  if (isNothing(gap)) return;
  const gaps: GapEntry[] = missing.map((field) => ({ field, valid: gap }));
  throw new JudgeError("validation_failed", "the write falls where the entity has no value", {
    gaps,
  });
}

/** A required field without a value over `valid` (`validation_failed`, `required_in_gap`). */
export interface GapEntry {
  readonly field: FieldId;
  readonly valid: IntervalSet;
}

/**
 * `acknowledge: ["overwrite"]` takes a high impact write into effect only with an explicit `ver`
 * that is current: nothing was applied after it (05-time «高影响写入»).
 */
function acknowledges(state: RowState, w: WriteInput): boolean {
  if (w.acknowledge !== true || !w.seenExplicit) return false;
  // A corroboration makes no version (05-time «用同样的值写»): only applied items make it stale.
  const seen = seenOf(w);
  return !state.items.some((x) => x.op > seen && x.op < w.op && x.status === "applied");
}

function shownAt(state: RowState, f: FieldId, seg: Interval, at: Limit): Shown {
  const s = state.fieldState(f, seg, at);
  if (state.isState && !state.hasValue(seg, at)) {
    return s.kind === "hole"
      ? { kind: "no_value", by: refOf(s.by), op: s.by.op }
      : { kind: "no_value" };
  }
  if (s.kind === "value") return { kind: "value", value: s.value, by: refOf(s.by), op: s.by.op };
  return { kind: "none" };
}

function shownKey(s: Shown): string {
  if (s.kind === "value") return `${valueToken(s.value)}@${s.by.event}/${s.by.target}/${s.by.k}`;
  if (s.kind === "no_value") return `no_value@${s.by ? `${s.by.event}/${s.by.k}` : ""}`;
  return "none";
}

/** The stretches an item in effect overwrites: where the field shows another value now. */
export function overwrittenBy(state: RowState, d: Draft, curAt: Limit): Overwritten[] {
  if (d.target === "existence") return [];
  if (d.content.kind !== "value" && d.content.kind !== "no_value") return [];
  const f = d.target;
  // A write-back of "no value" overwrites wherever the field shows something else.
  const v = d.content.kind === "value" ? valueToken(d.content.value) : "none";
  const out: { valid: Interval[]; was: Shown; key: string }[] = [];
  for (const s of state.piecesIn(d.valid)) {
    if (state.token(f, s, curAt) === v) continue;
    const was = shownAt(state, f, s, curAt);
    const key = shownKey(was);
    const last = out[out.length - 1];
    const lastEnd = last?.valid[last.valid.length - 1]?.to;
    if (last !== undefined && last.key === key && lastEnd === s.from) last.valid.push(s);
    else out.push({ valid: [s], was, key });
  }
  return out.map((o) => {
    const valid = canonical(o.valid);
    const ends = [startOf(valid), valid[valid.length - 1]?.to ?? null];
    const giver = o.was.kind === "value" || o.was.kind === "no_value" ? o.was.by : undefined;
    return {
      field: f,
      valid,
      was: o.was,
      deps: uniqueRefs([
        ...(giver !== undefined ? [giver] : []),
        ...ends.flatMap((p) => (p === null ? [] : state.givers(p, f, curAt))),
      ]),
    };
  });
}

/**
 * A write in effect covering a corroboration with another value, without erasing a change point
 * (05-time «用同样的值写»): `overwrote_corroborated`.
 */
function coveredCorroborations(
  state: RowState,
  applied: readonly Draft[],
  curAt: Limit,
): CoveredCorroboration[] {
  const out: CoveredCorroboration[] = [];
  for (const d of applied) {
    if (d.target === "existence" || d.content.kind !== "value") continue;
    const f = d.target;
    for (const c of state.items) {
      if (c.status !== "corroborated" || c.target !== f || !state.sees(c, curAt)) continue;
      if (c.content.kind !== "value" || sameValue(c.content.value, d.content.value)) continue;
      const cv = valueToken(c.content.value);
      const hit = canonical(
        state.piecesIn(meet(d.valid, c.valid)).filter((s) => state.token(f, s, curAt) === cv),
      );
      if (!isNothing(hit)) out.push({ field: f, valid: hit, corroboration: refOf(c) });
    }
  }
  return out;
}

export function judgeRevoke(state: RowState, r: RevokeInput, replay?: ReplayOptions): WriteOutcome {
  const n = r.op;
  const { seenAt, curAt } = positions(seenOf(r), n, r.index);
  const none: WriteOutcome = {
    items: [],
    noop: [],
    conflicts: [],
    erased: [],
    overwritten: [],
    acknowledged: false,
    warnings: [],
  };
  let seenValid: IntervalSet = [WHOLE];
  let valid: IntervalSet = [WHOLE];
  let seenDeps: readonly ItemRef[] = [];
  let deps: readonly ItemRef[] = [];
  if (r.valid !== undefined) {
    if (!state.isState)
      throw new JudgeError("invalid", "a revoke with an interval needs a state table");
    const s = resolve(state, r.valid, "any", seenAt, r.now);
    const c = resolve(state, r.valid, "any", curAt, r.now);
    if ((s === null || c === null) && replay !== undefined) return none;
    if (s === null || c === null) throw new JudgeError("invalid", "unresolvable revoke interval");
    seenValid = s.valid;
    valid = c.valid;
    seenDeps = s.deps;
    deps = c.deps;
  } else if (!state.isState && state.revoked(curAt)) {
    return none; // Revoking a revoked row again is a no-op.
  }
  // A revoke changes existence, which meets every conflict unit (撤销与并发修改).
  const withOps = state
    .opsBetween(seenOf(r), n)
    .filter((m) =>
      state.table.fields.some((g) => !isNothing(meet(state.changedBy(m, g), seenValid))),
    );
  // In a replay, a revoke in effect when written stays in effect (deviation two).
  // A revoke a resolution decided as a candidate stays one (deviation one).
  const conflict =
    (withOps.length > 0 || replay?.resolved?.has("existence") === true) &&
    replay?.protect.has("existence") !== true;
  // High impact ② (05-time «高影响写入»): revoking a row still referenced awaits confirmation; a
  // stale revoke is a candidate first («既版本对不上、又是高影响»). Who refers to it is the write
  // path's to find (other rows); a whole revoke only on a state table. (A conflict makes it a
  // candidate below whatever this says.)
  const awaiting = r.referenced === true && (!state.isState || r.valid === undefined);
  const items = numbered([
    conflict
      ? {
          target: "existence",
          status: "candidate",
          valid: seenValid,
          content: { kind: "revoke" },
          deps: seenDeps,
        }
      : {
          target: "existence",
          status: awaiting ? "awaiting" : "applied",
          valid,
          content: { kind: "revoke" },
          deps,
        },
  ]);
  return {
    ...none,
    items,
    conflicts:
      conflict && withOps.length > 0
        ? [
            {
              unit: "existence",
              with: withOps,
              items: [{ event: r.event, target: "existence", k: 0 }],
            },
          ]
        : [],
  };
}

export { NO_VALUE };
