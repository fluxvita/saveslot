// `take_candidate` at write time (01-objects «各处理方式的执行语义»; 09-references-conflict-sync
// «撤销与并发修改»; 09-event-format §5.8 `take`).
//
// The candidate taken writes every one of its items in the item (K, by event and the item's unit),
// per target on the union of their intervals, its value carried from them and from the
// same-valued candidates of the item. A target whose whole interval already has the value gets no
// item (03-deletion «同值判断»: what a take writes is judged like any contribution). No high
// impact: taking a candidate is the confirmation of its impact. On an item whose unit is
// existence, a revoke taken takes effect; a modification taken restores the row on an event or
// timeless table, and on a state table fills where the entity has no value, the required fields
// the candidate does not give carried from the merge base. The merge base and the covered writes
// are recorded for a deletion's replay; they register nothing.

import type { FieldId, FieldValue, OpNumber, Seq } from "@fluxvita/saveslot-contract-core";
import { sameValue } from "../delta/index.ts";
import {
  canonical,
  type Interval,
  type IntervalSet,
  isNothing,
  meet,
  minus,
  parts,
  WHOLE,
} from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import type { ItemRef, RecordedItem, RevertEntry, TakeCandidateInput, Target } from "./model.ts";
import { uniqueRefs } from "./resolve.ts";
import { candidatesOf, coveredSince, mergeBaseOf } from "./revert.ts";
import { type Item, type Limit, type RowState, refOf, supersedes, valueToken } from "./state.ts";
import { checkGapsOf, type Draft, type GapEntry, numbered } from "./write.ts";

export interface TakeOutcome {
  readonly items: readonly RecordedItem[];
  readonly mergeBase: OpNumber;
  readonly cover: readonly RevertEntry[];
  /** The revokes the take filled (see `TakeCandidateRecord.filled`). */
  readonly filled: readonly Seq[];
}

/**
 * A take executed as recorded in a deletion's replay (03-deletion «搬运的值», «重放规则 · 人的
 * 决定»): K as the replay has it, and the merge base, the cover set O and the filled revokes as
 * recorded. What it writes lands again: per target the taken write's items in K (with none left,
 * the items in K of the candidates with the same value on that field), less where writes outside
 * O cover them (`coveredOutsideO`); the checks on the current state made when it was judged are
 * not made again.
 */
export interface TakeReplay {
  readonly k: readonly Item[];
  readonly mergeBase: OpNumber;
  readonly cover: readonly RevertEntry[];
  readonly filled: readonly Seq[];
  /**
   * The taken write's value on each field it gave in the item, as written (from its record and
   * the resolution's recorded `decided`), also on a field whose contribution the deletion took.
   */
  readonly values: ReadonlyMap<FieldId, FieldValue>;
}

export function judgeTakeCandidate(
  state: RowState,
  t: TakeCandidateInput,
  replay?: TakeReplay,
): TakeOutcome {
  if (!t.candidates.includes(t.take)) {
    throw new JudgeError("invalid", "the candidate taken is not in the item", { take: t.take });
  }
  const cur: Limit = { upTo: t.op - 1, request: { op: t.op, below: t.index } };
  const k = replay?.k ?? candidatesOf(state, t.unit, t.candidates);
  const mergeBase = replay?.mergeBase ?? mergeBaseOf(state, t.candidates);
  const cover = replay?.cover ?? coveredSince(state, t, mergeBase, k);
  const taken =
    replay === undefined ? k.filter((x) => x.event === t.take) : landing(state, t, replay, k);
  const drafts: Draft[] = [];

  // A revoke taken takes effect on its interval, also where there is already no value: as a
  // revoke written over a revoked stretch, it writes its item. Whether there is a value there is
  // not checked again in a deletion's replay, where later writes or deletions may change it
  // (03-deletion «重放规则 · 人的决定»), so the item is written either way.
  const revokes = taken.filter((x) => x.target === "existence");
  if (revokes.length > 0) {
    const valid = canonical(revokes.flatMap((x) => x.valid));
    // One item per stretch: an item has one interval (09 §5.7 `span/existence/<k>`).
    for (const part of parts(valid)) {
      drafts.push({
        target: "existence",
        status: "applied",
        valid: part,
        content: { kind: "revoke" },
        deps: revokes.map(refOf),
      });
    }
    return { items: numbered(drafts), mergeBase, cover, filled: replay?.filled ?? [] };
  }

  // A modification taken: per target, the union of its items.
  const targets = [...new Set(taken.map((x) => x.target))].sort() as FieldId[];
  for (const f of targets) {
    const mine = taken.filter((x) => x.target === f && x.content.kind === "value");
    const first = mine[0];
    if (first === undefined || first.content.kind !== "value") continue;
    const value = first.content.value;
    const v = valueToken(value);
    const valid = canonical(mine.flatMap((x) => x.valid));
    // Compared with what is in effect there: a stretch without a value is not "the same".
    const same = state.piecesIn(valid).every((s) => state.token(f, s, cur) === v);
    if (same) continue;
    const carried = uniqueRefs(
      k
        .filter(
          (x) => x.target === f && x.content.kind === "value" && sameValue(x.content.value, value),
        )
        .map(refOf),
    );
    // One item per stretch: an item has one interval (09 §5.7 `span/<f>/<k>`).
    for (const part of parts(valid)) {
      drafts.push({
        target: f,
        status: "applied",
        valid: part,
        content: { kind: "value", value },
        carried,
        deps: carried,
      });
    }
  }

  // A field unit: the checks on the current state an ordinary write passes, on what takes effect
  // (04-write-and-read «判定顺序» step 5): a revoked row, a gap without the required fields.
  if (t.unit !== "existence" && drafts.length > 0 && replay === undefined) {
    if (!state.isState && state.revoked(cur)) {
      throw new JudgeError("revoked", "the row is revoked", { ops: state.revokedBy(cur) });
    }
    if (state.isState) checkGapsOf(state, targets, drafts, cur);
  }

  if (t.unit === "existence" && !state.isState && taken.length > 0 && state.revoked(cur)) {
    // The row exists again; the revoke is not registered as reverted.
    drafts.push({
      target: "existence",
      status: "applied",
      valid: [WHOLE],
      content: { kind: "restore" },
      deps: taken.map(refOf),
    });
  }
  if (t.unit === "existence" && state.isState) {
    drafts.push(...carriedRequired(state, taken, targets, mergeBase, cur, replay !== undefined));
  }
  return {
    items: numbered(drafts),
    mergeBase,
    cover,
    filled: replay?.filled ?? filledBy(state, t, taken, cur),
  };
}

/**
 * Where the take lands in a replay: per target, the taken write's items in K, or with none left
 * on a field, the items in K of the candidates with the same value there; each less where writes
 * outside O cover it. Items with nothing left are dropped.
 */
function landing(
  state: RowState,
  t: TakeCandidateInput,
  replay: TakeReplay,
  k: readonly Item[],
): Item[] {
  const own = k.filter((x) => x.event === t.take);
  const fields = new Set<Target>([...own.map((x) => x.target), ...replay.values.keys()]);
  const out: Item[] = [];
  for (const target of [...fields].sort()) {
    let giving = own.filter((x) => x.target === target);
    const value = target === "existence" ? undefined : replay.values.get(target);
    if (giving.length === 0 && value !== undefined) {
      giving = k.filter(
        (x) =>
          x.target === target && x.content.kind === "value" && sameValue(x.content.value, value),
      );
    }
    for (const x of giving) {
      const valid = minus(x.valid, coveredOutsideO(state, replay, t.op, x));
      if (!isNothing(valid)) out.push({ ...x, valid });
    }
  }
  return out;
}

/**
 * Where writes outside the cover set O cover a taken item in a replay (03-deletion «搬运的值»):
 * an item in effect after the merge base and before the take, not in O, that supersedes the taken
 * item (step 3), less where an earlier revert registered it and where a later item in O
 * supersedes it in turn. Revokes and field items: on a state table a revoke covers a taken field
 * item wholly unless the take filled it (listed in `filled`), judged by the revoke, not by an
 * interval; on an event or timeless table a revoke covers no field item, and a field write covers
 * no taken revoke (only a restore outside O does).
 */
export function coveredOutsideO(
  state: RowState,
  rec: {
    readonly mergeBase: OpNumber;
    readonly cover: readonly RevertEntry[];
    readonly filled: readonly Seq[];
  },
  n: OpNumber,
  taken: Item,
): IntervalSet {
  const at: Limit = { upTo: n - 1 };
  const inO = new Set(rec.cover.map((e) => `${e.event}/${e.target}`));
  const revokeOnField = (x: Item) => taken.target !== "existence" && x.target === "existence";
  const covering = state.items.filter(
    (x) =>
      x.status === "applied" &&
      x.op > rec.mergeBase &&
      x.op < n &&
      !inO.has(`${x.event}/${x.target}`) &&
      x.content.kind !== "uncovered" &&
      !(revokeOnField(x) && !state.isState) &&
      !(!state.isState && taken.target === "existence" && x.content.kind !== "restore") &&
      supersedes(x, taken),
  );
  const out: IntervalSet[] = [];
  for (const x of covering) {
    if (revokeOnField(x) && rec.filled.includes(x.event)) continue;
    const underO = state.items.filter(
      (y) =>
        y.status === "applied" &&
        y.op > x.op &&
        y.op < n &&
        inO.has(`${y.event}/${y.target}`) &&
        supersedes(y, x),
    );
    out.push(
      minus(
        meet(minus(x.valid, state.registeredSet(x, at)), taken.valid),
        canonical(underO.flatMap((y) => minus(y.valid, state.registeredSet(y, at)))),
      ),
    );
  }
  return canonical(out.flat());
}

/**
 * State tables, a take on a field unit: the revokes it fills (09 §5.8 `take.filled`; 03-deletion
 * «搬运的值»): in effect now, outside what reverts registered, meeting the stretch the taken
 * write's candidate items in the item lie on, whether or not every field there already has the
 * value. By event, sorted. None on an event or timeless table, where a revoke and a field item do
 * not cover each other, nor on an existence unit.
 */
function filledBy(
  state: RowState,
  t: TakeCandidateInput,
  taken: readonly Item[],
  cur: Limit,
): Seq[] {
  if (!state.isState || t.unit === "existence") return [];
  const range = canonical(taken.flatMap((x) => x.valid));
  const out = new Set<Seq>();
  for (const x of state.items) {
    if (x.status !== "applied" || x.target !== "existence" || x.content.kind !== "revoke") continue;
    if (!state.sees(x, cur)) continue;
    if (isNothing(meet(minus(x.valid, state.registeredSet(x, cur)), range))) continue;
    out.add(x.event);
  }
  return [...out].sort((a, b) => a - b);
}

/**
 * State tables, a modification taken on existence: where the entity has no value inside the
 * candidate's interval, each required field the candidate does not give, carried from the merge
 * base; `validation_failed` (`required_in_gap`) where the merge base has no value either.
 *
 * Its interval comes from other contributions, so it depends on: the taken write's candidate items
 * in the item; what makes the stretch have no value (the revokes over it, and at its ends the
 * givers of a value ↔ no value boundary, as 05-time «给出挡点的贡献»); and at its ends the givers on
 * both sides at the merge base, where the value carried changes there.
 */
function carriedRequired(
  state: RowState,
  taken: readonly Item[],
  targets: readonly FieldId[],
  mergeBase: OpNumber,
  cur: Limit,
  /** In a replay, executed as recorded: where the merge base has no value, nothing is carried. */
  replaying = false,
): Draft[] {
  const scope = canonical(taken.flatMap((x) => x.valid));
  const gap = canonical(state.piecesIn(scope).filter((s) => !state.hasValue(s, cur)));
  if (isNothing(gap)) return [];
  const at: Limit = { upTo: mergeBase };
  const out: Draft[] = [];
  // Every required field and stretch without a value to carry, reported together.
  const lacking: GapEntry[] = [];
  for (const f of state.table.required.filter((r) => !targets.includes(r))) {
    const none = state.piecesIn(gap).filter((s) => state.fieldState(f, s, at).kind !== "value");
    if (none.length > 0) lacking.push({ field: f, valid: canonical(none) });
  }
  if (lacking.length > 0 && !replaying) {
    throw new JudgeError("validation_failed", "a required field has no value to carry", {
      gaps: lacking,
    });
  }
  for (const f of state.table.required.filter((r) => !targets.includes(r))) {
    let run: { valid: Interval[]; by: Item } | undefined;
    const flush = () => {
      if (run === undefined || run.by.content.kind !== "value") return;
      const ref: ItemRef = refOf(run.by);
      const valid = canonical(run.valid);
      out.push({
        target: f,
        status: "applied",
        valid,
        content: { kind: "value", value: run.by.content.value },
        carried: [ref],
        deps: carriedDeps(state, f, valid, ref, taken, cur, at),
      });
      run = undefined;
    };
    for (const s of state.piecesIn(gap)) {
      const st = state.fieldState(f, s, at);
      // Every stretch has a value to carry: checked above.
      if (st.kind !== "value") continue;
      const last = run?.valid[run.valid.length - 1];
      if (run !== undefined && run.by === st.by && last !== undefined && last.to === s.from) {
        run.valid.push(s);
      } else {
        flush();
        run = { valid: [s], by: st.by };
      }
    }
    flush();
  }
  return out;
}

function carriedDeps(
  state: RowState,
  f: FieldId,
  valid: IntervalSet,
  carried: ItemRef,
  taken: readonly Item[],
  cur: Limit,
  at: Limit,
): ItemRef[] {
  const out: ItemRef[] = [carried];
  // The taken write's candidate items in the item.
  out.push(...taken.map(refOf));
  // The revokes making the stretch have no value.
  for (const s of state.piecesIn(valid)) {
    for (const r of state.table.required) {
      const st = state.fieldState(r, s, cur);
      if (st.kind === "hole") out.push(refOf(st.by));
    }
  }
  // At each end: the givers of a value ↔ no value boundary; the givers on both sides at the merge
  // base where the value carried changes.
  for (const v of valid) {
    for (const p of [v.from, v.to]) {
      if (p === null) continue;
      if (state.hasValueBoundary(p, cur)) out.push(...state.givers(p, f, cur));
      const segs = state.pieces([[{ from: p, to: null }]]);
      const i = segs.findIndex((s) => s.from === p);
      const sides = [segs[i - 1], segs[i]].map((s) =>
        s === undefined ? undefined : state.fieldState(f, s, at),
      );
      const [a, b] = sides;
      const tok = (x: typeof a) => (x?.kind === "value" ? `${x.by.event}/${x.by.k}` : "none");
      if (tok(a) !== tok(b)) {
        for (const x of sides) if (x !== undefined && x.kind !== "none") out.push(refOf(x.by));
      }
    }
  }
  return uniqueRefs(out);
}
