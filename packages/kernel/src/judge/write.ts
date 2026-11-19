// Judging a write or a revoke (docs/zh-CN/spec/03-data-model/04-write-and-read.md «判定顺序»;
// 05-time «用同样的值写» «高影响写入» «无值区间» «状态类表上的撤销»; 09-references-conflict-sync
// «冲突判据» «撤销与并发修改»).

import type { BizPoint, FieldId, OpNumber } from "@fluxvita/saveslot-contract-core";
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
  WriteInput,
} from "./model.ts";
import { type Resolved, resolve, uniqueRefs } from "./resolve.ts";
import { type Item, type Limit, NO_VALUE, type RowState, refOf, valueToken } from "./state.ts";

/** What judging one write or revoke gives, before the record is assembled. */
export interface WriteOutcome {
  readonly items: readonly RecordedItem[];
  readonly noop: readonly FieldId[];
  readonly conflicts: readonly Conflict[];
  readonly erased: readonly { readonly field: FieldId; readonly at: readonly BizPoint[] }[];
  readonly overwritten: readonly Overwritten[];
  readonly acknowledged: boolean;
  readonly warnings: readonly CoveredCorroboration[];
}

/** One part of a field the write judges as an ordinary write (conflict criterion). */
interface Part {
  readonly f: FieldId;
  readonly input: FieldInput;
  /** The interval as resolved on the seen version (a candidate's interval). */
  readonly seenValid: IntervalSet;
  readonly defaultEnd: boolean;
  readonly from: BizPoint | null;
  /** Resolve again on the current state when merged (not for a part cut from a corroboration). */
  readonly reResolve: boolean;
  readonly deps: readonly ItemRef[];
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

export function judgeWrite(state: RowState, w: WriteInput): WriteOutcome {
  const n = w.op;
  const { seenAt, curAt, afterAt } = positions(w.seen, n, w.index);
  const fields = (Object.keys(w.fields) as FieldId[]).sort();
  const drafts: Draft[] = [];
  const noop: FieldId[] = [];
  const ordinary: Part[] = [];
  const seenRes = new Map<FieldId, Resolved>();

  // Same value (step 3): no-op, corroboration, or an ordinary write on the changed part.
  for (const f of fields) {
    const input = w.fields[f] as FieldInput;
    const res = resolve(state, w.valid, f, seenAt, w.now);
    if (res === null) {
      throw new JudgeError("invalid_argument", "the field has no value at now; give an interval", {
        reason: "no_value_now",
        field: f,
      });
    }
    seenRes.set(f, res);
    const v = valueToken(input.value);
    const segs = state.piecesIn(res.valid);
    const sameAsSeen = segs.every((s) => state.token(f, s, seenAt) === v);
    if (sameAsSeen && !input.explicit) {
      noop.push(f);
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
    // that part, with the writes that changed it among its deps.
    const same = canonical(segs.filter((s) => state.token(f, s, curAt) === v));
    const changed = minus(res.valid, same);
    const cutters = isNothing(changed) ? [] : changersOf(state, f, w.seen, n, res.valid);
    const split = !isNothing(changed);
    for (const piece of parts(same)) {
      drafts.push({
        target: f,
        status: "corroborated",
        valid: piece,
        content: { kind: "value", value: input.value },
        deps: uniqueRefs([...res.deps, ...(split ? cutters : [])]),
      });
    }
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
  for (const ps of units.values()) {
    const unit = state.unitOf.get((ps[0] as Part).f) ?? [];
    const withOps = new Set<OpNumber>();
    let withRevoke = false;
    for (const p of ps) {
      const c = conflictingOps(state, w, p, unit, seenRes, seenAt, curAt);
      for (const m of c.ops) withOps.add(m);
      withRevoke ||= c.revoke;
    }
    if (withOps.size > 0) {
      for (const p of ps) {
        drafts.push({
          target: p.f,
          status: "candidate",
          valid: p.seenValid,
          content: { kind: "value", value: p.input.value },
          deps: p.deps,
          ...(withRevoke ? { onExistence: true as const } : {}),
        });
      }
      conflicts.push({
        unit: withRevoke ? "existence" : { fields: unit },
        with: [...withOps].sort((x, y) => x - y),
        items: ps.map((p) => ({ event: w.event, target: p.f, k: -1 })),
      });
      continue;
    }
    for (const p of ps) {
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
  if (!state.isState && applied.length > 0 && state.revoked(curAt)) {
    throw new JudgeError("revoked", "the row is revoked", { ops: state.revokedBy(curAt) });
  }

  // Checks that depend on the current state, on the part taking effect only (step 5).
  if (state.isState) checkGaps(state, w, applied, curAt);

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
  for (const d of applied) drafts.push(awaiting ? { ...d, status: "awaiting" } : d);

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
  return { items, noop, conflicts: withItems, erased, overwritten, acknowledged, warnings };
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
  seenAt: Limit,
): string {
  return unit
    .map((g) => {
      const input = w.fields[g];
      const res = seenRes.get(g);
      if (input !== undefined && res !== undefined && within(seg, res.valid)) {
        return valueToken(input.value);
      }
      return state.token(g, seg, seenAt);
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
  seenAt: Limit,
  curAt: Limit,
): { ops: OpNumber[]; revoke: boolean } {
  const out: OpNumber[] = [];
  for (const m of state.opsBetween(w.seen, w.op)) {
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
  return !state.items.some((x) => x.op > w.seen && x.op < w.op && x.status === "applied");
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

export function judgeRevoke(state: RowState, r: RevokeInput): WriteOutcome {
  const n = r.op;
  const { seenAt, curAt } = positions(r.seen, n, r.index);
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
    .opsBetween(r.seen, n)
    .filter((m) =>
      state.table.fields.some((g) => !isNothing(meet(state.changedBy(m, g), seenValid))),
    );
  const conflict = withOps.length > 0;
  const items = numbered([
    conflict
      ? {
          target: "existence",
          status: "candidate",
          valid: seenValid,
          content: { kind: "revoke" },
          deps: seenDeps,
        }
      : { target: "existence", status: "applied", valid, content: { kind: "revoke" }, deps },
  ]);
  return {
    ...none,
    items,
    conflicts: conflict
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
