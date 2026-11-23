// Reverting: `undo` and `take_previous` at write time (docs/zh-CN/spec/03-data-model/03-deletion.md
// «回掉的权威定义», the pseudocode; 04-write-and-read «回退到某个版本»; 05-time «高影响写入» ④;
// 09-event-format §5.7 `revert`).
//
// One implementation of the pseudocode, steps 1–8, with C the items of the row now. The
// registrations (step 5) are not stored: the state derives them from the record and the
// write-back items, as `apply` does.

import type { FieldId, OpNumber, Seq } from "@fluxvita/saveslot-contract-core";
import {
  canonical,
  type Interval,
  type IntervalSet,
  isNothing,
  meet,
  minus,
  unionOf,
  WHOLE,
  within,
} from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import type {
  CoveredCorroboration,
  ItemContent,
  ItemRef,
  Overwritten,
  RecordedItem,
  RevertEntry,
  TakePreviousInput,
  Target,
  UndoInput,
  Unit,
} from "./model.ts";
import { uniqueRefs } from "./resolve.ts";
import {
  effective,
  type Item,
  type Limit,
  later,
  type RowState,
  refOf,
  registrationsOf,
  supersedes,
  valueToken,
} from "./state.ts";
import { asItems, type Draft, numbered, overwrittenBy } from "./write.ts";

const etKey = (event: Seq, target: Target) => `${event}/${target}`;

/** Where the values are taken from: before an operation (`undo`), or as of one (`take_previous`). */
type Position = { readonly before: OpNumber } | { readonly asOf: OpNumber };

export interface RevertOutcome {
  readonly status: "applied" | "awaiting";
  readonly entries: readonly RevertEntry[];
  readonly skipped: readonly (RevertEntry & { readonly byOp: OpNumber })[];
  readonly items: readonly RecordedItem[];
  readonly erased: readonly { readonly field: FieldId; readonly at: readonly string[] }[];
  readonly overwritten: readonly Overwritten[];
  readonly acknowledged: boolean;
  readonly warnings: readonly CoveredCorroboration[];
  readonly takesBack: readonly OpNumber[];
  readonly hides: readonly ItemRef[];
}

interface Revert {
  readonly n: OpNumber;
  readonly index: number;
  readonly event: Seq;
  readonly entries: readonly RevertEntry[];
  readonly pos: Position;
  /** `take_previous`: the candidate items of the pending item (K). */
  readonly k: readonly Item[] | null;
}

/**
 * An undo's write-backs applied, from its record (the op, its entries and the undone operation):
 * the row before it (at `at`) and after it (at `afterAt`), for what a reader would see once it
 * takes effect. The record's own entries, not judged again.
 */
export function undoResult(
  state: RowState,
  r: { readonly op: OpNumber; readonly index: number; readonly event: Seq },
  revert: { readonly entries: readonly RevertEntry[]; readonly before: OpNumber },
): { readonly after: RowState; readonly at: Limit; readonly afterAt: Limit } {
  const c = compute(state, {
    n: r.op,
    index: r.index,
    event: r.event,
    entries: revert.entries,
    pos: { before: revert.before },
    k: null,
  });
  return {
    after: state.with(c.asWritten, c.regs),
    at: c.cur,
    afterAt: { upTo: r.op - 1, request: { op: r.op, below: r.index + 1 } },
  };
}

/** The pseudocode's steps 1–3 and 5–8 on the state now; step 4 is the caller's. */
function compute(state: RowState, r: Revert) {
  const cur: Limit = { upTo: r.n - 1, request: { op: r.n, below: r.index } };
  const entries = new Map(r.entries.map((e) => [etKey(e.event, e.target), e]));
  const inR = (x: Item) => entries.has(etKey(x.event, x.target));
  const isLater = (x: Item) => entries.get(etKey(x.event, x.target))?.later === true;
  const now = state.items.filter((x) => state.sees(x, cur));

  // Step 1: R' and the items of it in effect.
  const zai = now.filter((x) => inR(x) && effective(x.status));

  // Step 2: the domain.
  const kDomain: IntervalSet = r.k === null ? [WHOLE] : canonical(r.k.flatMap((c) => c.valid));
  const domainOf = (x: Item): IntervalSet =>
    r.k === null && isLater(x)
      ? canonical(zai.filter((y) => !isLater(y) && supersedes(x, y)).flatMap((y) => y.valid))
      : kDomain;

  // Step 3: what covers each item, and its range. A revoke a take_candidate wrote supersedes an
  // earlier revoke where it lies: a person's decision on the item, written even where there was
  // no value (03-deletion «重放规则 · 人的决定»), so undoing the earlier revoke does not bring the
  // row back under it.
  const takenRevoke = (x: Item) =>
    x.content.kind === "revoke" &&
    state.records.some((o) => o.kind === "take_candidate" && o.event === x.event);
  const coveringOf = (y: Item) =>
    now.filter(
      (x) =>
        x.status === "applied" &&
        !inR(x) &&
        later(x, y) &&
        x.content.kind !== "uncovered" &&
        (supersedes(x, y) || (y.content.kind === "revoke" && takenRevoke(x))) &&
        !isNothing(meet(minus(x.valid, state.registeredSet(x, cur)), y.valid)),
    );
  const scope = new Map<Item, IntervalSet>();
  for (const y of zai) {
    const covered = unionOf(
      ...coveringOf(y).map((x) => meet(minus(x.valid, state.registeredSet(x, cur)), y.valid)),
    );
    scope.set(y, meet(minus(y.valid, covered), domainOf(y)));
  }
  const targets = [...new Set(zai.map((y) => y.target))].sort();
  const tOf = (t: Target) =>
    unionOf(...zai.filter((y) => y.target === t).map((y) => scope.get(y) ?? []));

  // Step 6: the write-backs, from the state at the value position.
  const posAt: Limit = "before" in r.pos ? { upTo: r.pos.before - 1 } : { upTo: r.pos.asOf };
  const drafts: Draft[] = [];
  for (const t of targets) {
    const T = tOf(t);
    if (isNothing(T)) continue;
    let run:
      | {
          valid: Interval[];
          content: ItemContent;
          giver: Item | undefined;
          by: Item[];
          key: string;
        }
      | undefined;
    const flush = () => {
      if (run === undefined) return;
      const valid = canonical(run.valid);
      const giver = run.giver;
      drafts.push({
        target: t,
        status: "applied",
        valid,
        content: run.content,
        ...(run.content.kind === "value" && giver !== undefined ? { carried: [refOf(giver)] } : {}),
        deps: writeBackDeps(state, t, valid, run.by, zai, coveringOf, posAt, r.k),
      });
      run = undefined;
    };
    for (const s of state.piecesIn(T)) {
      const { content, giver, by } = stateAt(state, t, s, posAt);
      const key = `${content.kind === "value" ? valueToken(content.value) : content.kind}|${giver ? `${giver.event}/${giver.target}/${giver.k}` : ""}`;
      const last = run?.valid[run.valid.length - 1];
      if (run !== undefined && run.key === key && last !== undefined && last.to === s.from) {
        run.valid.push(s);
        run.by.push(...by);
      } else {
        flush();
        run = { valid: [s], content, giver, by: [...by], key };
      }
    }
    flush();
  }
  const items = numbered(drafts);
  const asWritten = asItems(items, { op: r.n, index: r.index, event: r.event });

  // Step 5: the registrations, as the state derives them from the record.
  const regs = registrationsOf(
    state.items,
    { op: r.n, index: r.index, entries: r.entries },
    asWritten,
  );

  // Step 7 is implied: with nothing in effect in R or every range empty there are no write-backs.
  return { cur, zai, scope, isLater, coveringOf, items, asWritten, regs, inR };
}

/**
 * Step 6: the state S of a target on a piece at the value position; `giver` is the item a value or
 * an `uncovered` write-back comes from (pieces join only with the same giver), `by` the items
 * giving S (step 8): that item, or on existence the revokes the piece is inside.
 */
function stateAt(
  state: RowState,
  t: Target,
  s: Interval,
  at: Limit,
): { content: ItemContent; giver: Item | undefined; by: readonly Item[] } {
  if (t === "existence") {
    const by = revokesOver(state, s, at);
    return { content: { kind: by.length > 0 ? "revoke" : "restore" }, giver: undefined, by };
  }
  const st = state.fieldState(t, s, at);
  if (st.kind === "value") {
    return { content: { kind: "value", value: st.value }, giver: st.by, by: [st.by] };
  }
  if (st.kind === "hole") return { content: { kind: "uncovered" }, giver: st.by, by: [st.by] };
  return { content: { kind: "no_value" }, giver: undefined, by: [] };
}

/**
 * The revokes a piece is inside at the position: in effect, not registered there, and not restored
 * or filled since. None: the piece exists.
 */
function revokesOver(state: RowState, s: Interval, at: Limit): Item[] {
  const live = (x: Item) =>
    x.status === "applied" &&
    state.sees(x, at) &&
    within(s, x.valid) &&
    !state.registeredOn(x, s, at);
  return state.items.filter(
    (r) =>
      r.content.kind === "revoke" &&
      live(r) &&
      !state.items.some(
        (x) =>
          later(x, r) &&
          live(x) &&
          (x.content.kind === "restore" ||
            (x.target !== "existence" && x.content.kind === "value")),
      ),
  );
}

/**
 * Step 8: the contributions a write-back depends on: the items in effect of R, the ones giving its
 * state S (a value, or the revoke it is inside), the ones covering the items of R on its target,
 * the candidates (take_previous), and at each end of its interval the givers of the states on both
 * sides at the value position.
 */
function writeBackDeps(
  state: RowState,
  t: Target,
  valid: IntervalSet,
  by: readonly Item[],
  zai: readonly Item[],
  coveringOf: (y: Item) => Item[],
  posAt: Limit,
  k: readonly Item[] | null,
): ItemRef[] {
  const ends: Item[] = [];
  for (const v of valid) {
    for (const p of [v.from, v.to]) {
      if (p === null) continue;
      const segs = state.pieces([[{ from: p, to: null }]]);
      const i = segs.findIndex((s) => s.from === p);
      for (const s of [segs[i - 1], segs[i]]) {
        if (s === undefined) continue;
        ends.push(...stateAt(state, t, s, posAt).by);
      }
    }
  }
  return uniqueRefs([
    ...zai.map(refOf),
    ...by.map(refOf),
    ...zai.filter((y) => y.target === t).flatMap((y) => coveringOf(y).map(refOf)),
    // A shadow in K: the interval it gives the domain rests on what cuts it (09 §3.5).
    ...(k ?? []).flatMap((c) => [refOf(c), ...(c.shadow === true ? c.deps : [])]),
    ...ends.map(refOf),
  ]);
}

// ---------------------------------------------------------------------------------------------
// undo

/**
 * The record of an `undo` of operation `m` (03-deletion «回掉的权威定义» ①; 04-write-and-read
 * «撤回某次写入（undo）»): every (event, target) of m's base writes on this row as written,
 * whatever their status then; when m is itself a revert, every target of its own record on m's
 * event; with `include_later`, each later item in effect that supersedes an item in effect of m
 * and meets it (marked `later`).
 */
export function undoEntries(
  state: RowState,
  m: OpNumber,
  includeLater: boolean,
  n: OpNumber,
  index: number,
): RevertEntry[] {
  const out = new Map<string, RevertEntry>();
  // Key fields are in no revert record: an undo never takes a row's key back.
  const keyFields: readonly string[] = state.table.keyFields ?? [];
  const add = (e: RevertEntry) => {
    if (keyFields.includes(e.target)) return;
    const key = etKey(e.event, e.target);
    if (!out.has(key)) out.set(key, e);
  };
  for (const rec of state.records.filter((x) => x.op === m)) {
    const own =
      rec.kind === "undo" || rec.kind === "take_previous" || rec.kind === "confirm"
        ? rec.revert
        : undefined;
    if (own !== undefined) {
      for (const t of [...new Set(own.entries.map((e) => e.target))].sort()) {
        add({ event: rec.event, target: t });
      }
    } else if (
      rec.kind === "write" ||
      rec.kind === "revoke" ||
      rec.kind === "confirm" ||
      rec.kind === "take_candidate"
    ) {
      for (const t of [...new Set(rec.items.map((x) => x.target))].sort()) {
        add({ event: rec.event, target: t });
      }
    }
  }
  if (includeLater) {
    const cur: Limit = { upTo: n - 1, request: { op: n, below: index } };
    const own = state.items.filter((x) => x.op === m && effective(x.status));
    for (const x of state.items) {
      if (x.op <= m || !state.sees(x, cur) || x.status !== "applied") continue;
      if (own.some((y) => supersedes(x, y) && !isNothing(meet(x.valid, y.valid)))) {
        add({ event: x.event, target: x.target, later: true });
      }
    }
  }
  return [...out.values()];
}

/**
 * The operation an undo of `m` takes back (09-event-format §5.7 «回退记录里列哪些条目»): `m`, or,
 * when nothing of `m` on this row is applied and `m` has exactly one awaiting revert on it that a
 * confirmation put into effect, that confirmation: its base write and revert record are the ones
 * taken, not the proposal's. With an applied item of its own, `m`'s own change is undone; the
 * confirmed revert is undone by the confirming operation.
 */
export function undoneOp(state: RowState, m: OpNumber): OpNumber {
  // A key field's item is not one of the operation's changes in effect (an undo never takes a key
  // back), as in `judgeUndo`.
  const keyFields: readonly string[] = state.table.keyFields ?? [];
  if (
    state.items.some((x) => x.op === m && x.status === "applied" && !keyFields.includes(x.target))
  )
    return m;
  const confirmations = state.records
    .filter((x) => x.op === m && x.kind === "undo" && x.status === "awaiting")
    .flatMap((p) =>
      state.records.filter(
        (x) => x.kind === "confirm" && x.target === p.event && x.revert !== undefined,
      ),
    );
  const only = confirmations.length === 1 ? confirmations[0] : undefined;
  return only?.op ?? m;
}

export function judgeUndo(state: RowState, u: UndoInput): RevertOutcome & { before: OpNumber } {
  const m = undoneOp(state, u.target);
  const targets = state.records.filter((x) => x.op === m);
  if (targets.length === 0) {
    // A schema switch's operation (its constant backfill) is `undo_target` by the contract, but is
    // not in the row's records, so it lands here: not reached in this version; to handle when
    // schema changes come (P4).
    throw new JudgeError("invalid_argument", "not a write of this row", {
      reason: "not_this_target",
      param: "revert/undo",
    });
  }
  // The first creation cannot be undone: revoke instead (04-write-and-read «第 n 次写入是什么»).
  const created = state.records.find((x) => x.kind === "write" && createdBy(state, x.event));
  if (created !== undefined && created.op === m) {
    throw new JudgeError("invalid_argument", "the first creation cannot be undone; revoke it", {
      reason: "undo_target",
      param: "revert/undo",
    });
  }
  // Nothing applied on this row (a candidate, an awaiting write, only corroborations or no-ops,
  // a revert with no write-back, only the row's key added): no change to undo.
  const keyFields: readonly string[] = state.table.keyFields ?? [];
  if (
    !state.items.some((x) => x.op === m && x.status === "applied" && !keyFields.includes(x.target))
  ) {
    throw new JudgeError("invalid_argument", "no change to undo", {
      reason: "undo_target",
      param: "revert/undo",
    });
  }
  const entries = undoEntries(state, m, u.includeLater === true, u.op, u.index);
  return { ...judgeRevertOf(state, u, entries, { before: m }, null, true), before: m };
}

function createdBy(state: RowState, event: Seq): boolean {
  const req = state.table.required;
  const gives = (f: FieldId) =>
    state.items.some((x) => x.event === event && x.target === f && effective(x.status));
  return req.length > 0 ? req.every(gives) : state.table.fields.some(gives);
}

/**
 * A revert's outcome; `judged` says whether high impact applies (an undo when written), or it
 * takes effect as it is (a take_previous; a confirmed undo).
 */
export function judgeRevertOf(
  state: RowState,
  o: {
    op: OpNumber;
    index: number;
    event: Seq;
    seen?: OpNumber;
    seenExplicit?: boolean;
    seenCurrent?: true;
    acknowledge?: boolean;
  },
  entries: readonly RevertEntry[],
  pos: Position,
  k: readonly Item[] | null,
  judged: boolean,
  /**
   * Whether a revoked row refuses it (an undo when written). A deletion's replay judges an
   * awaiting undo's high impact again without it: the refusal is the request's, made once.
   */
  refuseRevoked: boolean = judged,
): RevertOutcome {
  const c = compute(state, { n: o.op, index: o.index, event: o.event, entries, pos, k });
  const lower = "before" in pos ? pos.before : pos.asOf;
  const afterAt: Limit = { upTo: o.op - 1, request: { op: o.op, below: o.index + 1 } };

  // Event and timeless tables: an undo of a revoked row is `revoked` when the row is still revoked
  // once it is written (04-write-and-read «撤回某次写入（undo）»). An undo of the revoke itself, or
  // one taking it back with `include_later` (④, awaiting), leaves the row existing. An undo of a
  // revoke in effect now (an item of it not covered, step 3) is accepted even when another revoke
  // keeps the row revoked: it registers what it takes back, so that revoke can be undone in turn.
  // Its own items only: a revoke an include_later takes back with it is not the target.
  const currentRevoke = c.zai.some(
    (y) =>
      !c.isLater(y) &&
      y.target === "existence" &&
      y.content.kind === "revoke" &&
      !isNothing(c.scope.get(y) ?? []),
  );
  if (refuseRevoked && !state.isState && !currentRevoke && state.revoked(c.cur)) {
    const after = state.with(c.asWritten, c.regs);
    if (after.revoked(afterAt)) {
      throw new JudgeError("revoked", "the row is revoked", { ops: after.revokedBy(afterAt) });
    }
  }

  // Skipped entries (undo only): an own entry an item of which later writes cover now.
  const skipped: (RevertEntry & { byOp: OpNumber })[] = [];
  if ("before" in pos) {
    for (const y of c.zai) {
      if (c.isLater(y)) continue;
      for (const op of new Set(c.coveringOf(y).map((x) => x.op))) {
        if (!skipped.some((s) => s.event === y.event && s.target === y.target && s.byOp === op)) {
          skipped.push({ event: y.event, target: y.target, byOp: op });
        }
      }
    }
  }

  // High impact ④: a `later` entry with a non-empty range; a later field write in effect that the
  // write-backs hide (a hidden corroboration is a warning). They hide it where they write a revoke
  // back over it (undo only: a take_previous lists the same stretch's writes of its unit), or where
  // they leave the entity without a value it had (05-time «无值区间»; a required field written back
  // without one): its value goes with the stretch's, though it is not in the record.
  const takesBack = [
    ...new Set(
      c.zai.filter((y) => c.isLater(y) && !isNothing(c.scope.get(y) ?? [])).map((y) => y.op),
    ),
  ].sort((a, b) => a - b);
  const written = state.isState ? state.with(c.asWritten, c.regs) : undefined;
  /**
   * Where `x`, beyond what earlier reverts registered, has a value before and none after. Only an
   * item that gives a value (a clear included) loses one: a no-value item gives none to lose.
   */
  const losesValue = (x: Item) =>
    written !== undefined &&
    x.content.kind === "value" &&
    written
      .piecesIn(minus(x.valid, state.registeredSet(x, c.cur)))
      .some((seg) => state.hasValue(seg, c.cur) && !written.hasValue(seg, afterAt));
  const hidden = (status: "applied" | "corroborated") =>
    state.items.filter(
      (x) =>
        state.sees(x, c.cur) &&
        x.target !== "existence" &&
        x.status === status &&
        (x.content.kind === "value" || x.content.kind === "no_value") &&
        !c.inR(x) &&
        x.op > lower &&
        (("before" in pos &&
          c.asWritten.some(
            (w) =>
              w.target === "existence" &&
              w.content.kind === "revoke" &&
              !isNothing(minus(meet(w.valid, x.valid), state.registeredSet(x, c.cur))),
          )) ||
          losesValue(x)),
    );
  const hides = hidden("applied").map(refOf);

  let status: "applied" | "awaiting" = "applied";
  let erased: { field: FieldId; at: string[] }[] = [];
  let overwritten: Overwritten[] = [];
  let acknowledged = false;
  if (judged) {
    if (takesBack.length > 0 || hides.length > 0) status = "awaiting";
    else {
      const ack =
        o.acknowledge === true &&
        o.seenExplicit === true &&
        o.seen !== undefined &&
        !state.items.some(
          (x) =>
            x.op > (o.seenCurrent === true ? o.op - 1 : (o.seen as number)) &&
            x.op < o.op &&
            x.status === "applied",
        );
      // Undoing a revoke restores what it took away: not ① (05-time «高影响写入»).
      const onlyRevokes = c.zai.every((y) => y.content.kind === "revoke");
      if (!onlyRevokes) {
        const after = state.with(c.asWritten, c.regs);
        erased = state.table.fields
          .map((f) => {
            const before = state.impactPoints(f, c.cur);
            const now = new Set(after.impactPoints(f, afterAt));
            return { field: f, at: before.filter((p) => !now.has(p)) };
          })
          .filter((x) => x.at.length > 0);
        if (erased.length > 0) {
          overwritten = c.items.flatMap((d) => overwrittenBy(state, d, c.cur));
          if (ack) acknowledged = true;
          else status = "awaiting";
        }
      }
    }
  }
  const items: RecordedItem[] =
    status === "awaiting" ? c.items.map((x) => ({ ...x, status: "awaiting" })) : c.items;
  const warnings: CoveredCorroboration[] =
    status === "applied"
      ? hidden("corroborated").map((x) => ({
          field: x.target as FieldId,
          valid: x.valid,
          corroboration: refOf(x),
        }))
      : [];
  return {
    status,
    entries,
    skipped,
    items,
    erased,
    overwritten,
    acknowledged,
    warnings,
    takesBack,
    hides,
  };
}

// ---------------------------------------------------------------------------------------------
// take_previous

/**
 * The candidate items of a pending item (K): of `candidates`, still candidates, belonging to an
 * item on `unit` (09 §5.8 `candidates/<k>`: by event and the item's unit, not by index).
 */
export function candidatesOf(state: RowState, unit: Unit, candidates: readonly Seq[]): Item[] {
  return state.items.filter(
    (x) => candidates.includes(x.event) && x.status === "candidate" && state.inUnit(x, unit),
  );
}

/**
 * The merge base: the earliest version the candidates carried (01-objects «各处理方式的执行语义»).
 * A candidate of a write by external key carried its baseline position, the earliest over the
 * fields of `unit` it wrote (09-references-conflict-sync «冲突判据»): not the write's `seen`, the
 * earliest over all its fields.
 */
export function mergeBaseOf(state: RowState, candidates: readonly Seq[], unit: Unit): OpNumber {
  return Math.min(
    ...candidates.map((e) => {
      const r = state.records.find((x) => x.event === e);
      if (r === undefined || (r.kind !== "write" && r.kind !== "revoke")) return r?.op ?? 0;
      if (r.kind === "write" && r.baseline !== undefined && unit !== "existence") {
        const at = unit.fields.flatMap((f) => {
          const n = r.baseline?.[f];
          return n === undefined ? [] : [n];
        });
        if (at.length > 0) return Math.min(...at);
      }
      return r.seen;
    }),
  );
}

/**
 * The (event, target)s with an item in effect after the merge base and before this resolution, in
 * the item's unit and interval: take_previous's revert record (03-deletion «回掉的权威定义» ①), and
 * take_candidate's covered writes (09 §5.8 `take`). On existence every target counts.
 */
export function coveredSince(
  state: RowState,
  r: { op: OpNumber; index: number; unit: Unit },
  mergeBase: OpNumber,
  k: readonly Item[],
): RevertEntry[] {
  const cur: Limit = { upTo: r.op - 1, request: { op: r.op, below: r.index } };
  const domain = canonical(k.flatMap((c) => c.valid));
  const entries = new Map<string, RevertEntry>();
  for (const x of state.items) {
    if (
      x.op > mergeBase &&
      state.sees(x, cur) &&
      effective(x.status) &&
      (r.unit === "existence" || (x.target !== "existence" && r.unit.fields.includes(x.target))) &&
      !isNothing(meet(x.valid, domain))
    ) {
      const key = etKey(x.event, x.target);
      if (!entries.has(key)) entries.set(key, { event: x.event, target: x.target });
    }
  }
  return [...entries.values()];
}

export function judgeTakePrevious(
  state: RowState,
  t: TakePreviousInput,
): RevertOutcome & { mergeBase: OpNumber } {
  const k = candidatesOf(state, t.unit, t.candidates);
  const mergeBase = mergeBaseOf(state, t.candidates, t.unit);
  const entries = coveredSince(state, t, mergeBase, k);
  return {
    ...judgeRevertOf(state, t, entries, { asOf: mergeBase }, k, false),
    mergeBase,
  };
}
