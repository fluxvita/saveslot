// The deletion replay (D1-b2a–d2) against the reference evaluator: random logs of writes, revokes,
// people's confirmations and rejections, undos and the three conflict resolutions (no deletion
// events between operations) are judged op by op,
// then a set of source data is deleted. `replayDeletion` on the records, given the (event, target)
// those sources take away, must leave the row or entity the reference evaluator gives with the
// same deletion at the end of the log: the items (by event, target, status, interval, content,
// with indices), every field's timeline, the gaps.
//
// Covered here: writes and revokes judged again on the replay's state, no-ops kept, deviation two
// by the write on a target, corroborations and the same-value rule, conflicts and high impact
// worked out again; confirmations and rejections executed as recorded (deviation one); reverts
// with R and the value position as recorded, their write-backs worked out again; keep_effective
// and take_candidate as recorded. Not yet (refused with not_implemented, see
// replay-deletion.test.ts): an undecided awaiting undo no longer of high impact (or then on a
// revoked row), a take_previous or take_candidate whose candidate leaves no item, operations after
// a deletion event.

import type { FieldId } from "@fluxvita/saveslot-contract-core";
import { evaluateLog, type LogEntry, type Op, timeline } from "@fluxvita/saveslot-reference";
import { EVENT, Hits, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { canonical, type IntervalSet } from "../time/index.ts";
import { JudgeError } from "./errors.ts";
import { advance, openItems } from "./fates.fixture.ts";
import { type ItemsGiven, type ItemsResult, itemsByRecords, pendingIn } from "./fates.ts";
import { normalized, overlay } from "./given.fixture.ts";
import { judgeOp, view } from "./judge.ts";
import type { ExternalChange, OpRecord, Restatement, Target, WriteInput } from "./model.ts";
import {
  cancellationResult,
  contributionKey,
  deletionResult,
  replayDeletion,
} from "./replay-deletion.ts";
import { type GivenBlock, givenByRecords, onlyCancelledGave } from "./restate.ts";
import type { Stretch } from "./results.ts";
import {
  type Decision,
  deletedContributions,
  judged,
  scenario,
  shadowSkeleton,
  toInput,
} from "./scenarios.fixture.ts";
import { EVERYTHING, effective, RowState } from "./state.ts";

/** A cancellation with no operation after the deletion cancelled, nothing kept by earlier ones. */
const NO_GRACE = {
  cancelledOp: Number.MAX_SAFE_INTEGER,
  coveredSince: Number.MAX_SAFE_INTEGER,
  keptEffective: new Set<string>(),
  effectiveSince: () => 0,
};

vi.setConfig({ testTimeout: 120_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 110_000, markInterruptAsFailure: true });

const RUNS = propRuns(600);
/** A failing run replayed: `PROP_SEED` and `PROP_PATH` as fast-check printed them. */
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const REPLAY = {
  numRuns: RUNS,
  ...(SEED !== undefined ? { seed: SEED } : {}),
  ...(process.env["PROP_PATH"] ? { path: process.env["PROP_PATH"], endOnFailure: true } : {}),
};

/** The source data the ops cite, by op. */
function sourcesOf(o: Op): string[] {
  if (o.kind === "write") {
    return [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])];
  }
  if (o.kind === "revoke") return [...(o.validSources ?? [])];
  return [];
}

const itemKeys = (
  items: readonly {
    event: number;
    target: string;
    k: number;
    status: string;
    valid: unknown;
    content: unknown;
  }[],
  withIndex: (x: { event: number; target: string; k: number }) => boolean = () => true,
) =>
  items
    .filter((x) => x.status !== "dropped")
    .map(
      (x) =>
        // The reference names "no value at all" noValue, the kernel no_value (09 §5.7). With the
        // index (03-deletion «回掉的权威定义» step 6): the reference's clearing by ends plays no
        // part in where indices land, with one exception after a cancellation, where `withIndex`
        // leaves an index out (see the first deletion cancelled, in `compare`).
        `${x.event}/${x.target}${withIndex(x) ? `#${x.k}` : ""} ${x.status} ${JSON.stringify(x.valid)} ${JSON.stringify(x.content).replace('"kind":"noValue"', '"kind":"no_value"')}`,
    )
    .sort();

/** The blocks without those last given as dropped. */
/**
 * The blocks laid over without those last given as dropped, in judge's terms (what the replay's
 * records give): a restatement's block is marked as one (`restatement`), and on an event or timeless
 * table it lists its carried items in its deps only as the event writes them (`restatedDeps`); an
 * item there has no deps of its own. A state table's block is compared as it is.
 */
function withoutDropped(m: Map<string, GivenBlock[]>, isState: boolean): Map<string, GivenBlock[]> {
  const ref = (d: { event: number; target: string; k: number }) => `${d.event}/${d.target}/${d.k}`;
  return normalized(
    new Map(
      [...m].map(([et, bs]) => [
        et,
        bs
          .filter((b) => b.status !== "dropped")
          .map(({ restatement: _, ...b }) =>
            isState || b.carried === undefined
              ? b
              : { ...b, deps: b.deps.filter((d) => !b.carried?.some((c) => ref(c) === ref(d))) },
          ),
      ]),
    ),
  );
}

/** The replay's items as blocks, by (event, target), each list by index. */
function blocksOf(records: readonly OpRecord[]): Map<string, GivenBlock[]> {
  return normalized(givenByRecords(records));
}

/** Each field's timeline; a stretch with no value is left out (the reference lists it as null). */
const timelines = (fields: Readonly<Record<string, unknown>>, names: readonly string[]) =>
  Object.fromEntries(
    names.map((f) => [
      f,
      timeline({ fields } as never, f as never).filter((x) => !x.endsWith(" null")),
    ]),
  );

/** The two fields of the generator judged together (01-objects «冲突单元»). */
const GROUPS = [["f2", "f3"]] as const;

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
  ["state, group {f2, f3}", { ...STATE, groups: GROUPS }, true],
  ["event, group {f2, f3}", { ...EVENT, groups: GROUPS }, false],
] as const;

type Schema = (typeof both)[number][1];

/**
 * Judges the log op by op, deletes one or two of the cited sources, and holds `replayDeletion` to
 * the reference evaluator with the same deletion at the end. Returns whether the values changed
 * and whether a person's decision in the replay came out otherwise than recorded (left nothing, or
 * other items).
 */
function compare(
  schema: Schema,
  isState: boolean,
  ops: readonly Op[],
  decisions: readonly Decision[],
  pick: number | readonly string[],
  /** Writes given a second field with sources of its own (by op), no interval sources mapped. */
  second: readonly number[] = [],
): {
  partly: boolean;
  changed: boolean;
  decided: boolean;
  decisionChanged: boolean;
  /** A revert in the log; one whose write-backs came out otherwise in the replay. */
  reverted: boolean;
  revertChanged: boolean;
  /** A take_candidate in the log; one with filled revokes. */
  took: boolean;
  tookFilled: boolean;
  /**
   * A conflict resolution whose K holds a shadow in the replay: a candidate it recorded, not
   * deleted, with no item left (the same as its seen version, no evidence pointed at).
   */
  shadowed: boolean;
  protectionMatters: (op: number) => boolean;
} {
  const widened = ops.map((o) =>
    o.kind === "write" && second.includes(o.op) && o.validSources === undefined
      ? {
          ...o,
          fields: {
            ...o.fields,
            [o.fields["f2"] === undefined ? "f2" : "f3"]: { value: "m", sources: [`M${o.op}`] },
          },
        }
      : o,
  );
  const { table, steps } = judged(schema, widened, decisions);
  const kept = steps.map((x) => x.op);
  const cited = [...new Set(kept.flatMap(sourcesOf))].sort();
  fc.pre(cited.length > 0);
  // One or two of the cited sources deleted, or the ones given.
  const deleted =
    typeof pick === "number"
      ? new Set([
          cited[pick % cited.length] as string,
          cited[Math.floor(pick / 7) % cited.length] as string,
        ])
      : new Set(pick);
  // After every operation and event of the log: a deletion event has a number of its own.
  const last = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
  const ref = evaluateLog(schema, [
    ...kept,
    { kind: "deletion", op: last + 1, id: "pi_x", sources: [...deleted] },
  ]).final;
  const records = steps.map((x) => x.judgement.record);
  const gone = deletedContributions(kept, deleted, isState);
  const replayed = replayDeletion(table, records, gone);
  const { state } = replayed;
  // What the event says of the row (09 §5.9 «列哪些», `outcome`), against the reference's states
  // before and after: every piece of a field whose value or giver changed is in a listed stretch
  // with the value the reference gives now; `deleted` exactly when the row existed before only.
  {
    const given = itemsByRecords(new RowState(table, records));
    const res = deletionResult(table, records, gone, new Set(), given, () => []);
    // The item layer (03-deletion «删除不增加未决事项»): every (event, target) pending after was
    // pending when written (`itemsResult` refuses one with no item given); a fate exactly where its
    // pending membership changes. On the items as the records give them, and on two variants the
    // records alone do not make: a conflict unit's candidates of several writes in one item, and an
    // item superseded for another reason (overwritten).
    for (const g of [given, joined(given), overwritten(given)]) {
      const r = g === given ? res : deletionResult(table, records, gone, new Set(), g, () => []);
      itemsHold(r.before, r.replay.state, records, g, r.items);
    }
    // The deps of each listed stretch are complete (09 §3.5, §5.9 «段的定义»): deleting one more
    // contribution related to its value or ends (an item on its field, on existence or on a field
    // deciding "has a value", with an end where the stretch has one, or the stretch's giver) leaves
    // the stretch as it is, unless its deps hold that contribution or one the deletion restates.
    if (isState)
      depsComplete(table, records, gone, replayed.restated, res.result.stretches, replayed.state);
    const refBefore = evaluateLog(schema, kept).final;
    expect(res.outcome === "deleted").toBe(refBefore.exists && !ref.exists);
    if (ref.exists) {
      type RefStretch = {
        valid: { from: string | null; to: string | null }[];
        value: unknown;
        by?: { event: number; target: string };
      };
      const fieldsOf = (x: typeof ref) => x.fields as unknown as Record<string, RefStretch[]>;
      const at = (xs: RefStretch[] | undefined, p: string | null) =>
        (xs ?? []).find((x) =>
          x.valid.some(
            (v) =>
              (v.from === null || (p !== null && v.from <= p)) &&
              (v.to === null || (p !== null && p < v.to)),
          ),
        );
      const key = (x: RefStretch | undefined) =>
        x === undefined || x.value === null
          ? "none"
          : `${JSON.stringify(x.value)}|${x.by?.event}/${x.by?.target}`;
      for (const f of new Set([
        ...Object.keys(fieldsOf(ref)),
        ...Object.keys(fieldsOf(refBefore)),
      ])) {
        const now = fieldsOf(ref)[f];
        const was = refBefore.exists ? fieldsOf(refBefore)[f] : undefined;
        // Start points of every stretch on either side: each piece starts at one of them.
        const starts = [
          ...new Set([...(now ?? []), ...(was ?? [])].flatMap((x) => x.valid.map((v) => v.from))),
        ];
        // A piece inside a gap after is the existence entry's (`results/<k>/existence`), not a
        // field stretch.
        const inGap = (p: string | null) =>
          (ref.gaps as { from: string | null; to: string | null }[]).some(
            (g) =>
              (g.from === null || (p !== null && g.from <= p)) &&
              (g.to === null || (p !== null && p < g.to)),
          );
        for (const p of starts) {
          const n = at(now, p);
          if (n === undefined || inGap(p) || key(n) === key(at(was, p))) continue;
          const listed = res.result.stretches.find(
            (x) =>
              x.field === f &&
              (x.valid === undefined ||
                x.valid.some(
                  (v) =>
                    (v.from === null || (p !== null && v.from <= p)) &&
                    (v.to === null || (p !== null && p < v.to)),
                )),
          );
          // A listed stretch's value may be null (nothing gives it): only no stretch is "not listed".
          expect({
            field: f,
            at: p,
            value: listed === undefined ? "not listed" : listed.value,
          }).toEqual({
            field: f,
            at: p,
            value: n.value,
          });
        }
      }
    }
  }
  // The restatements, laid over the blocks the log last gave (here the records as written) less
  // the deleted ones, give the replay's items (09 §5.9 «以最近一次为准»): nothing restated is
  // missed, nothing restated that the replay does not have.
  expect(
    withoutDropped(overlay(givenByRecords(records), replayed.restated, gone, records), isState),
  ).toEqual(blocksOf(replayed.records));
  // No restatement names a deleted contribution, as its item, in its deps or in what it carries.
  const named = (x: { event: number; target: string }) => gone.has(`${x.event}/${x.target}`);
  expect(
    replayed.restated.filter(
      (r) => named(r.item) || r.deps.some(named) || (r.carried ?? []).some(named),
    ),
  ).toEqual([]);
  // The order of deletions does not matter (03-deletion «推论»), checked the way a log has it: the
  // first deletion's restatements laid over the blocks as written (dropped kept) are the latest
  // blocks for the second; the replay of both, numbered against them, gives the items (indices
  // included) and values the reference evaluator gives with the two deletion events in that order.
  if (deleted.size === 2) {
    for (const [a, b] of [[...deleted], [...deleted].reverse()] as [string, string][]) {
      graceWrite(schema, isState, table, kept, records, a, b, last);
      const first = deletedContributions(kept, new Set([a]), isState);
      const once = replayDeletion(table, records, first);
      const afterFirst = overlay(givenByRecords(records), once.restated, first, records);
      const then = replayDeletion(table, records, gone, [], afterFirst);
      // The item layer across both, each deletion given the items as the one before left them:
      // nothing pending is left without an item to be in.
      for (const given of [
        itemsByRecords(new RowState(table, records)),
        joined(itemsByRecords(new RowState(table, records))),
      ]) {
        const one = deletionResult(table, records, first, new Set(), given, () => []);
        const between = advance(given, one.items);
        const two = deletionResult(table, records, gone, first, between, () => []);
        itemsHold(two.before, two.replay.state, records, between, two.items);
        const end = advance(between, two.items);
        // The order of deletions does not matter to the open items either (03-deletion
        // «删除不增加未决事项»: the original item is the one when written).
        const once = advance(
          given,
          deletionResult(table, records, gone, new Set(), given, () => []).items,
        );
        expect(openItems(end, two.replay.state)).toEqual(openItems(once, two.replay.state));
        for (const [key, f] of two.items.fates) {
          const [ev, target] = key.split("/") as [string, Target];
          if (pendingIn(two.replay.state, Number(ev), target) === undefined) continue;
          if (f.kind === "returned" && f.into !== "merged") continue;
          expect({ key, standing: end.items.get(end.of.get(key) ?? "")?.standing }).toEqual({
            key,
            standing: { kind: "open" },
          });
        }
      }
      // Nothing the first deletion left as it is restated again (09 §5.9 rules 1 and 2): each
      // restatement of the second, not dropped, either differs, in judge's terms, from the block
      // the first left, or that block rests on something the second deletes or restates (a dep;
      // a carried item deleted or dropped). The comparison above cannot see one restated more.
      {
        const r = (d: { event: number; target: string; k: number }) =>
          `${d.event}/${d.target}/${d.k}`;
        const left = withoutDropped(afterFirst, isState);
        const byRef = new Map(then.restated.map((x) => [r(x.item), x]));
        const goneHere = (d: { event: number; target: string; k: number }) =>
          gone.has(`${d.event}/${d.target}`);
        for (const x of then.restated) {
          if (x.status === "dropped") continue;
          const lb = left.get(`${x.item.event}/${x.item.target}`)?.find((b) => b.k === x.item.k);
          const before = afterFirst
            .get(`${x.item.event}/${x.item.target}`)
            ?.find((b) => b.k === x.item.k);
          const changed =
            lb === undefined ||
            lb.status !== x.status ||
            (isState && JSON.stringify(lb.valid) !== JSON.stringify(x.valid)) ||
            JSON.stringify(lb.deps.map(r).sort()) !== JSON.stringify(x.deps.map(r).sort()) ||
            (x.content !== undefined && JSON.stringify(lb.content) !== JSON.stringify(x.content)) ||
            // A revert's write-back restated as a restore where a revoke was left, or the reverse:
            // a restatement gives that kind as `restored`, not as its content.
            ((lb.content?.kind === "restore" || lb.content?.kind === "revoke") &&
              (x.restored === true) !== (lb.content.kind === "restore")) ||
            JSON.stringify((lb.carried ?? []).map(r)) !== JSON.stringify((x.carried ?? []).map(r));
          const rests =
            (before?.deps ?? []).some((d) => goneHere(d) || byRef.has(r(d))) ||
            (before?.carried ?? []).some(
              (d) => goneHere(d) || byRef.get(r(d))?.status === "dropped",
            );
          expect({ restated: r(x.item), changed, rests }).not.toEqual({
            restated: r(x.item),
            changed: false,
            rests: false,
          });
        }
      }
      // The round trip across both: the second deletion's restatements laid over the blocks the
      // first left give its replay's items (an item back from dropped must be restated).
      expect(withoutDropped(overlay(afterFirst, then.restated, gone, records), isState)).toEqual(
        blocksOf(then.records),
      );
      const two = evaluateLog(schema, [
        ...kept,
        { kind: "deletion", op: last + 1, id: "pi_a", sources: [a] },
        { kind: "deletion", op: last + 2, id: "pi_b", sources: [b] },
      ]).final;
      const proposalsThen = new Set(
        then.state.records
          .filter((r) => r.kind === "undo" && r.status === "awaiting")
          .map((r) => r.event),
      );
      expect(itemKeys(then.state.items.filter((x) => !proposalsThen.has(x.event)))).toEqual(
        itemKeys(two.items),
      );
      // The first deletion cancelled, with no write between (03-deletion «撤回与宽限期»): the
      // state is the second's alone, as the reference evaluator gives it; the blocks without the
      // first's (09 §5.7) with the cancellation's restatements laid over give its replay's items
      // (rule 3: an item whose last block was the first deletion's is restated); and the open
      // items are those after the second alone.
      {
        const second = deletedContributions(kept, new Set([b]), isState);
        const given = itemsByRecords(new RowState(table, records));
        const one = deletionResult(table, records, first, new Set(), given, () => []);
        const two = deletionResult(
          table,
          records,
          gone,
          first,
          advance(given, one.items),
          () => [],
        );
        const before = advance(advance(given, one.items), two.items);
        const withoutFirst = overlay(givenByRecords(records), then.restated, second, records);
        const bySecond = new Set(
          then.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
        );
        // Last interval blocks only (09 §5.9 rule 3): a restatement as dropped is no interval.
        const interval = (rs: readonly Restatement[]) =>
          rs
            .filter((r) => r.status !== "dropped")
            .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`);
        const fromFirst = new Set(interval(once.restated).filter((k) => !bySecond.has(k)));
        const c = cancellationResult(
          table,
          records,
          second,
          first,
          before,
          onlyCancelledGave(withoutFirst, once.restated),
          fromFirst,
          () => [],
          NO_GRACE,
        );
        expect(
          withoutDropped(overlay(withoutFirst, c.replay.restated, second, records), isState),
        ).toEqual(blocksOf(c.replay.records));
        const cancelled = evaluateLog(schema, [
          ...kept,
          { kind: "deletion", op: last + 1, id: "pi_a", sources: [a] },
          { kind: "deletion", op: last + 2, id: "pi_b", sources: [b] },
          { kind: "cancel", op: last + 3, id: "pi_a" },
        ]).final;
        const proposalsC = new Set(
          c.replay.state.records
            .filter((r) => r.kind === "undo" && r.status === "awaiting")
            .map((r) => r.event),
        );
        const namesC = [
          ...new Set([
            ...Object.keys(cancelled.fields),
            ...Object.keys(view(c.replay.state).fields),
          ]),
        ];
        // Indices are not compared after a cancellation; status, interval and value are. An index
        // the cancelled deletion alone gave is left without a block, and the kernel and the
        // reference number the items left on that target differently, one 0 and the other 1
        // (decision record `index-given-only-by-cancelled-deletion.md` §1). Its §7: "撤回之后的性质
        // 比较继续不比下标". The second part of that decision (spec, kernel, reference) restates
        // such an index as dropped and gives the item left a new number; its fixed cases (§8)
        // compare the indices again then. Seed -1335765174 is held below.
        const indexed = () => false;
        expect({
          items: itemKeys(
            c.replay.state.items.filter((x) => !proposalsC.has(x.event)),
            indexed,
          ),
          fields: timelines(view(c.replay.state).fields as never, namesC),
        }).toEqual({
          items: itemKeys(cancelled.items, indexed),
          fields: timelines(cancelled.fields as never, namesC),
        });
        const alone = deletionResult(table, records, second, new Set(), given, () => []);
        expect(openItems(advance(before, c.items), c.replay.state)).toEqual(
          openItems(advance(given, alone.items), c.replay.state),
        );
        // The second deletion cancelled instead (the one confirmed after): the state is the
        // first's alone, as the reference evaluator gives it; then the first cancelled too: the
        // records' state and items, as the reference gives both cancellations. Without indices, as
        // above: after a cancellation the two may number the items left otherwise
        // (`index-given-only-by-cancelled-deletion.md` §1, §7).
        const sameAsRef = (state: RowState, ref: ReturnType<typeof evaluateLog>["final"]): void => {
          const proposals = new Set(
            state.records
              .filter((r) => r.kind === "undo" && r.status === "awaiting")
              .map((r) => r.event),
          );
          const names = [
            ...new Set([...Object.keys(ref.fields), ...Object.keys(view(state).fields)]),
          ];
          expect({
            items: itemKeys(
              state.items.filter((x) => !proposals.has(x.event)),
              () => false,
            ),
            fields: timelines(view(state).fields as never, names),
          }).toEqual({
            items: itemKeys(ref.items, () => false),
            fields: timelines(ref.fields as never, names),
          });
        };
        const fromSecond = new Set(interval(then.restated));
        const cB = cancellationResult(
          table,
          records,
          first,
          second,
          before,
          onlyCancelledGave(afterFirst, then.restated),
          fromSecond,
          () => [],
          NO_GRACE,
        );
        expect(
          withoutDropped(overlay(afterFirst, cB.replay.restated, first, records), isState),
        ).toEqual(blocksOf(cB.replay.records));
        const del = (id: string, op: number, src: string): LogEntry => ({
          kind: "deletion",
          op,
          id,
          sources: [src],
        });
        sameAsRef(
          cB.replay.state,
          evaluateLog(schema, [
            ...kept,
            del("pi_a", last + 1, a),
            del("pi_b", last + 2, b),
            { kind: "cancel", op: last + 3, id: "pi_b" },
          ]).final,
        );
        expect(openItems(advance(before, cB.items), cB.replay.state)).toEqual(
          openItems(advance(given, one.items), cB.replay.state),
        );
        const afterCB = advance(before, cB.items);
        const latestBoth = overlay(givenByRecords(records), cB.replay.restated, new Set(), records);
        const byCB = new Set(
          cB.replay.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
        );
        const fromFirstThen = new Set(interval(once.restated).filter((k) => !byCB.has(k)));
        const cA = cancellationResult(
          table,
          records,
          new Set(),
          first,
          afterCB,
          onlyCancelledGave(latestBoth, [...once.restated, ...then.restated]),
          fromFirstThen,
          () => [],
          NO_GRACE,
        );
        expect(
          withoutDropped(overlay(latestBoth, cA.replay.restated, new Set(), records), isState),
        ).toEqual(blocksOf(cA.replay.records));
        sameAsRef(
          cA.replay.state,
          evaluateLog(schema, [
            ...kept,
            del("pi_a", last + 1, a),
            del("pi_b", last + 2, b),
            { kind: "cancel", op: last + 3, id: "pi_b" },
            { kind: "cancel", op: last + 4, id: "pi_a" },
          ]).final,
        );
        expect(view(cA.replay.state)).toEqual(view(new RowState(table, records)));
        expect(openItems(advance(afterCB, cA.items), cA.replay.state)).toEqual(
          openItems(given, cA.replay.state),
        );
      }
    }
  }
  const names = [...new Set([...Object.keys(ref.fields), ...Object.keys(view(state).fields)])];
  // The proposal of an awaiting undo (its write-backs, awaiting) is left out: the reference keeps
  // it in the revert's result only.
  const proposals = new Set(
    state.records.filter((r) => r.kind === "undo" && r.status === "awaiting").map((r) => r.event),
  );
  expect({
    items: itemKeys(state.items.filter((x) => !proposals.has(x.event))),
    fields: timelines(view(state).fields as never, names),
    gaps: isState ? view(state).gaps : [],
    // Which candidates a resolution keeps closed (03-deletion deviation one).
    closed: state.items
      .filter((x) => x.status === "candidate" && !proposals.has(x.event))
      .map((x) => `${x.event}/${x.target} ${state.closedCandidate(x.event, x.target)}`)
      .sort(),
  }).toEqual({
    items: itemKeys(ref.items),
    fields: timelines(ref.fields as never, names),
    gaps: isState ? ref.gaps : [],
    closed: ref.items
      .filter((x) => x.status === "candidate")
      .map((x) => `${x.event}/${x.target} ${x.closed === true}`)
      .sort(),
  });
  const isDecision = (r: OpRecord) => r.kind === "confirm" || r.kind === "reject";
  const decisionText = (rs: readonly OpRecord[]) =>
    JSON.stringify(rs.filter(isDecision).map((r) => [r.op, "items" in r ? r.items : []]));
  const isRevert = (r: OpRecord) =>
    r.kind === "undo" ||
    r.kind === "take_previous" ||
    (r.kind === "confirm" && r.revert !== undefined);
  const revertText = (rs: readonly OpRecord[]) =>
    JSON.stringify(
      rs
        .filter(isRevert)
        .map((r) => [
          r.op,
          "items" in r ? itemKeys(r.items.map((x) => ({ ...x, event: r.event }))) : [],
        ]),
    );
  const before = steps.at(-1)?.state as RowState;
  // A write with fields of different sources, one field's sources deleted, not all of them.
  const partly = kept.some((o) => {
    if (o.kind !== "write" || o.validSources !== undefined) return false;
    const per = Object.values(o.fields).map((x) => (x?.sources ?? []).some((y) => deleted.has(y)));
    return per.length > 1 && per.some((x) => x) && !per.every((x) => x);
  });
  return {
    partly,
    changed: JSON.stringify(view(before).fields) !== JSON.stringify(view(state).fields),
    decided: records.some(isDecision),
    decisionChanged: decisionText(records) !== decisionText(replayed.records),
    reverted: records.some(isRevert),
    took: records.some((r) => r.kind === "take_candidate"),
    tookFilled: records.some((r) => r.kind === "take_candidate" && r.filled.length > 0),
    shadowed: records.some(
      (r) =>
        (r.kind === "take_candidate" || r.kind === "take_previous") &&
        (r.decided ?? []).some(
          (x) =>
            !gone.has(contributionKey(x.event, x.target)) &&
            !replayed.state.items.some((y) => y.event === x.event && y.target === x.target),
        ),
    ),
    revertChanged: revertText(records) !== revertText(replayed.records),
    // Whether the replay comes out otherwise with operation `op` recorded as a candidate when
    // written (not protected by deviation two).
    protectionMatters: (op) => {
      const flipped = records.map((r) =>
        r.kind === "write" && r.op === op
          ? { ...r, items: r.items.map((x) => ({ ...x, status: "candidate" as const })) }
          : r,
      );
      const naive = replayDeletion(
        table,
        flipped,
        deletedContributions(kept, deleted, isState),
      ).state;
      return JSON.stringify(itemKeys(naive.items)) !== JSON.stringify(itemKeys(state.items));
    },
  };
}

/** How many fates and refreshed items the samples gave (the item layer's coverage). */
const itemCover: Record<string, number> = {};
/**
 * What the grace-period writes reached (`graceWrite`): W compared after `a`; W not applied there
 * (a candidate against `a` or awaiting for its version); `a` counted whole on some unit when `b`
 * was deleted too; that replay compared.
 */
const graceCover = {
  judged: 0,
  notApplied: 0,
  candidate: 0,
  whole: 0,
  compared: 0,
  // Counted, not asserted: neither set holds the other. At default runs about 1204 units both
  // count whole, 688 only the approximation, 660 only the kernel's blocks. The reference lists by
  // ends; it does not list the segments given by items this deletion restates, nor those meeting
  // an existence item deleted or restated, nor take the givers of a gap's ends (09 §5.9
  // «列哪些»). Which blocks are on a list is checked on real logs by the deletion encoding's
  // property (nothing removed that should stay, nothing left that should go).
  /** Units the reference evaluator's approximation by ends counts whole, also in `forcedWhole`. */
  endsAgree: 0,
  /** Units it counts whole that the kernel's blocks do not put on b's list. */
  endsMore: 0,
  /** Units the kernel's blocks put on b's list that the approximation does not count whole. */
  kernelOnly: 0,
};
/** The largest share of `graceCancel`'s samples set aside for W2 pending (measured: see the test). */
const W2_PENDING_MAX = 0.2;
/** Cancellations with a write in the grace period (`graceCancel`): compared, keeping something, refused. */
const cancelCover = {
  /** W2 judged: the samples that reach the cancellation's comparison or are set aside below. */
  tried: 0,
  compared: 0,
  kept: 0,
  refused: 0,
  /** Set aside: W2 itself pending, its own item not modelled. */
  w2Pending: 0,
};

/** The items with each conflict unit's candidates in one item (the earliest's), all open. */
function joined(g: ItemsGiven): ItemsGiven {
  const first = new Map<string, string>();
  const to = (id: string) => {
    const x = g.items.get(id);
    if (x?.kind !== "conflict") return id;
    const unit = x.unit === "existence" ? "existence" : [...x.unit.fields].sort().join(",");
    if (!first.has(unit)) first.set(unit, id);
    return first.get(unit) as string;
  };
  const of = new Map(
    [...g.of]
      .sort(([a], [b]) => Number(a.split("/")[0]) - Number(b.split("/")[0]))
      .map(([k, id]) => [k, to(id)]),
  );
  return { original: of, of, items: g.items };
}

/** The items with the first conflict item superseded as overwritten. */
function overwritten(g: ItemsGiven): ItemsGiven {
  const id = [...g.items].find(([, x]) => x.kind === "conflict" && x.standing.kind === "open")?.[0];
  if (id === undefined) return g;
  const items = new Map(g.items);
  const x = items.get(id);
  if (x !== undefined)
    items.set(id, { ...x, standing: { kind: "superseded", reason: "overwritten" } });
  return { ...g, items };
}

/**
 * A write in the grace period of deletion `a` (09-references «冲突判据»: `a` among its L), then
 * deletion `b`, against the reference evaluator with the same log: the write as judged with `a`
 * as L, and the state after `b`'s replay, `a`'s record taken as changed over the whole unit
 * where it rests on what `b` deletes or restates (09 §3.5 rule 1). The L of `a` is worked out the way the
 * caller does (its result against the state before it).
 */
function graceWrite(
  schema: Schema,
  isState: boolean,
  table: RowState["table"],
  kept: readonly Op[],
  records: readonly OpRecord[],
  a: string,
  b: string,
  last: number,
): void {
  const ga = deletedContributions(kept, new Set([a]), isState);
  const both = deletedContributions(kept, new Set([a, b]), isState);
  let first: ReturnType<typeof deletionResult>;
  try {
    first = deletionResult(
      table,
      records,
      ga,
      new Set(),
      itemsByRecords(new RowState(table, records)),
      () => [],
    );
  } catch (e) {
    if (e instanceof JudgeError && e.reason === "not_implemented") return;
    throw e;
  }
  const before = view(first.before, [], true);
  const after = view(first.replay.state, Object.keys(before.fields) as never, true);
  // Where `a` changed each field's value or whether it has one (its L, by field).
  const changed = new Map<FieldId, IntervalSet | "whole">();
  const fields = [...new Set([...Object.keys(before.fields), ...Object.keys(after.fields)])];
  const pieces = (v: typeof before) => [
    ...Object.values(v.fields).flatMap((xs) => (xs ?? []).flatMap((x) => x.valid)),
    ...v.gaps,
  ];
  const cuts = first.replay.state.pieces([...pieces(before), ...pieces(after)].map((x) => [x]));
  const tokenAt = (v: typeof before, f: string, s: { from: string | null; to: string | null }) => {
    if (
      isState &&
      v.gaps.some(
        (g) =>
          (g.from === null || (s.from !== null && g.from <= s.from)) &&
          (g.to === null || (s.to !== null && s.to <= g.to)),
      )
    )
      return "gap";
    const x = (v.fields[f as FieldId] ?? []).find((y) =>
      y.valid.some(
        (g) =>
          (g.from === null || (s.from !== null && g.from <= s.from)) &&
          (g.to === null || (s.to !== null && s.to <= g.to)),
      ),
    );
    return x === undefined ? "none" : JSON.stringify(x.value);
  };
  for (const f of fields) {
    const c = (isState ? cuts : [{ from: null, to: null }]).filter(
      // On a state table a gap is a token of its own: where the entity gained or lost a value is
      // where it changed. Only an event or timeless table's row exists over the whole time.
      (s) =>
        tokenAt(before, f, s) !== tokenAt(after, f, s) ||
        (!isState && before.exists !== after.exists),
    );
    if (c.length > 0) changed.set(f as FieldId, canonical(c as never));
  }
  // It changed the entity (a new version, 03-deletion «重放规则» ver row): a value, whether it
  // exists, or the judgement of any item (its index, status or interval).
  const sig = (st: RowState) =>
    JSON.stringify(st.items.map((x) => [x.event, x.target, x.k, x.status, x.valid]).sort());
  const changedEntity =
    changed.size > 0 ||
    before.exists !== after.exists ||
    sig(first.before) !== sig(first.replay.state);
  const D = { op: (last + 1) as never, changed, changedEntity };
  graceCancel(schema, isState, table, kept, records, a, ga, first, D, last);
  // The write: f2 = "w", having seen the last operation before `a`.
  const seen = Math.max(...kept.map((o) => o.op));
  const W: Op = {
    kind: "write",
    op: last + 2,
    event: last + 3,
    seen,
    ...(isState
      ? { valid: { from: { mode: "given", value: "2026-11-02" }, to: { mode: "open" } } }
      : {}),
    fields: { f2: { value: "w", sources: ["SW"] } },
    acknowledge: ["overwrite"],
  } as Op;
  let judgedW: ReturnType<typeof judgeOp>;
  try {
    judgedW = judgeOp(first.replay.state, { ...(toInput(W) as WriteInput), external: [D] });
  } catch (e) {
    if (e instanceof JudgeError) return;
    throw e;
  }
  const del = (id: string, op: number, src: string): LogEntry => ({
    kind: "deletion",
    op,
    id,
    sources: [src],
  });
  const refW = evaluateLog(schema, [...kept, del("pi_a", last + 1, a), W]);
  if (refW.steps.at(-1)?.refused === true) return;
  const wOf = (items: readonly { event: number; status: string }[]) =>
    items
      .filter((x) => x.event === last + 3)
      .map((x) => x.status)
      .sort();
  expect({ write: wOf(judgedW.state.items) }).toEqual({ write: wOf(refW.final.items) });
  graceCover.judged++;
  if (wOf(judgedW.state.items).some((x) => x !== "applied")) graceCover.notApplied++;
  if (wOf(judgedW.state.items).includes("candidate")) graceCover.candidate++;
  // Then `b`: where `a`'s record (its blocks, by their deps) rests on what `b` deletes or restates,
  // it is on `b`'s list of positions (09 §3.5 rule 1) and counts as changing the whole unit
  // (09-references «冲突判据», L's interval). Worked out here from the kernel's blocks, as
  // the caller will from the log, and given to both sides: the reference evaluator, which has no
  // real deps, takes it instead of its approximation by ends (`forcedWhole`).
  const withW = [...records, judgedW.judgement.record];
  const unitOf = (f: string) =>
    (table.groups.find((g) => g.includes(f as FieldId)) ?? [f]) as string[];
  let second: ReturnType<typeof replayDeletion>;
  let whole: Set<Target>;
  try {
    const bOnly = deletedContributions(kept, new Set([b]), isState);
    // The blocks as the log has them after `a`: its restatements over the records (W's as written).
    const afterA = overlay(givenByRecords(withW), first.replay.restated, ga, withW);
    const probe = replayDeletion(table, withW, both, [D], afterA);
    const hit = new Set([
      ...[...bOnly].filter((k) => !ga.has(k)),
      ...probe.restated.map((r) => `${r.item.event}/${r.item.target}`),
    ]);
    const on = (deps: readonly { event: number; target: string }[]) =>
      deps.some((x) => hit.has(`${x.event}/${x.target}`));
    whole = new Set<Target>(
      first.result.stretches
        .filter((st) => on(st.deps))
        .flatMap((st) => unitOf(st.field)) as Target[],
    );
    if (on(first.result.gaps?.deps ?? [])) whole.add("existence");
    const Db: ExternalChange = {
      op: D.op,
      changedEntity: changedEntity || whole.has("existence"),
      changed: new Map<FieldId, IntervalSet | "whole">([
        ...[...changed].filter(([f]) => !whole.has(f)),
        ...[...whole].filter((f) => f !== "existence").map((f) => [f as FieldId, "whole"] as const),
      ]),
    };
    second = replayDeletion(table, withW, both, [Db], afterA);
    if (whole.size > 0) graceCover.whole++;
  } catch (e) {
    if (e instanceof JudgeError && e.reason === "not_implemented") return;
    throw e;
  }
  const bothSources = new Set([a, b]);
  const refB = evaluateLog(
    schema,
    [...kept, del("pi_a", last + 1, a), W, del("pi_b", last + 4, b)],
    {
      forcedWhole: (op, deleted) =>
        op === D.op && [...bothSources].every((x) => deleted.has(x as never)) ? whole : undefined,
      observeWhole: (op, _deleted, unit, byEnds) => {
        if (op !== D.op) return;
        if (byEnds && whole.has(unit)) graceCover.endsAgree++;
        else if (byEnds) graceCover.endsMore++;
        else if (whole.has(unit)) graceCover.kernelOnly++;
      },
    },
  ).final;
  const proposals = new Set(
    second.state.records
      .filter((r) => r.kind === "undo" && r.status === "awaiting")
      .map((r) => r.event),
  );
  const names = [
    ...new Set([...Object.keys(refB.fields), ...Object.keys(view(second.state).fields)]),
  ];
  expect({
    items: itemKeys(second.state.items.filter((x) => !proposals.has(x.event))),
    fields: timelines(view(second.state).fields as never, names),
  }).toEqual({
    items: itemKeys(refB.items),
    fields: timelines(refB.fields as never, names),
  });
  graceCover.compared++;
}

/**
 * See its call: a write W2 in `a`'s grace period, having seen `a` (its baseline the state `a`
 * left), then `a` cancelled. What the cancellation keeps in effect, the items and the values, as
 * the reference evaluator gives; a cancellation that would have to keep something superseded is
 * refused (`cancellation_keeping_superseded`) and set aside.
 */
function graceCancel(
  schema: Schema,
  isState: boolean,
  table: RowState["table"],
  kept: readonly Op[],
  records: readonly OpRecord[],
  a: string,
  ga: ReadonlySet<string>,
  first: ReturnType<typeof deletionResult>,
  D: ExternalChange,
  last: number,
): void {
  const W2: Op = {
    kind: "write",
    op: last + 2,
    event: last + 3,
    seen: last + 1,
    ...(isState
      ? { valid: { from: { mode: "given", value: "2026-11-02" }, to: { mode: "open" } } }
      : {}),
    fields: { f3: { value: "v", sources: ["SV"] } },
    acknowledge: ["overwrite"],
  } as Op;
  let judged2: ReturnType<typeof judgeOp>;
  try {
    judged2 = judgeOp(first.replay.state, { ...(toInput(W2) as WriteInput), external: [D] });
  } catch (e) {
    if (e instanceof JudgeError) return;
    throw e;
  }
  cancelCover.tried++;
  // W2 pending (a candidate or awaiting) would open an item of its own in the log, which this
  // comparison does not model (the item layer is given as the log has it after `a`): set aside,
  // counted, and kept a minority below.
  if (judged2.state.items.some((x) => x.event === W2.event && !effective(x.status))) {
    cancelCover.w2Pending++;
    return;
  }
  const withW = [...records, judged2.judgement.record];
  // The items whose last interval block was `a`'s: restated by it, not as dropped.
  const restatedByA = new Set(
    first.replay.restated
      .filter((r) => r.status !== "dropped")
      .map((r) => `${r.item.event}/${r.item.target}`),
  );
  const fromA = new Set(
    first.replay.restated
      .filter((r) => r.status !== "dropped")
      .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
  );
  // Since when every item of an (event, target) has been in effect, as the log says: `a`'s
  // confirmation when it restated it, else its own operation.
  const opOf = new Map(records.map((r) => [r.event, r.op]));
  const since = (key: string) =>
    restatedByA.has(key) ? last + 1 : (opOf.get(Number(key.split("/")[0])) ?? 0);
  let c: ReturnType<typeof cancellationResult>;
  try {
    c = cancellationResult(
      table,
      withW,
      new Set(),
      ga,
      // The items as the log has them after `a`: the records' items, then `a`'s item layer.
      advance(itemsByRecords(new RowState(table, records)), first.items),
      givenByRecords(withW),
      fromA,
      () => [D],
      {
        cancelledOp: last + 1,
        coveredSince: last + 1,
        keptEffective: new Set(),
        effectiveSince: since,
      },
    );
  } catch (e) {
    if (e instanceof JudgeError && e.reason === "not_implemented") {
      if (String(e.detail["kind"]) === "cancellation_keeping_superseded") cancelCover.refused++;
      return;
    }
    throw e;
  }
  const ref = evaluateLog(schema, [
    ...kept,
    { kind: "deletion", op: last + 1, id: "pi_a", sources: [a] },
    W2,
    { kind: "cancel", op: last + 4, id: "pi_a" },
  ]);
  // W2 refused where the pipeline checks what judge does not (a row gone, its required field
  // missing): not a grace-period write.
  if (ref.steps.find((x) => x.entry.op === last + 2)?.refused === true) return;
  const step = ref.steps.at(-1);
  expect(step?.refused).toBe(false);
  // Not refused: nothing can be kept superseded, which the refusal is to cover in every case.
  expect(step?.keptSuperseded ?? []).toEqual([]);
  expect(c.keptEffective.map((x) => `${x.event}/${x.target}`).sort()).toEqual(
    (step?.keptEffective ?? []).map((x) => `${x.event}/${x.target}`).sort(),
  );
  const proposals = new Set(
    c.replay.state.records
      .filter((r) => r.kind === "undo" && r.status === "awaiting")
      .map((r) => r.event),
  );
  const names = [
    ...new Set([...Object.keys(ref.final.fields), ...Object.keys(view(c.replay.state).fields)]),
  ];
  expect({
    items: itemKeys(c.replay.state.items.filter((x) => !proposals.has(x.event))),
    fields: timelines(view(c.replay.state).fields as never, names),
  }).toEqual({
    items: itemKeys(ref.final.items),
    fields: timelines(ref.final.fields as never, names),
  });
  cancelCover.compared++;
  if (c.keptEffective.length > 0) cancelCover.kept++;
}

/** See its call: a listed stretch changed by one more deletion has a cleared dep. */
function depsComplete(
  table: RowState["table"],
  records: readonly OpRecord[],
  gone: ReadonlySet<string>,
  restated: readonly Restatement[],
  stretches: readonly Stretch[],
  after: RowState,
): void {
  const latest = overlay(givenByRecords(records), restated, gone, records);
  const ends = (v: IntervalSet) => v.flatMap((x) => [x.from, x.to]).filter((p) => p !== null);
  const valued = table.valued.length > 0 ? table.valued : table.fields;
  // The contributions in effect after the replay (09 §3.5: candidates and awaiting items do not
  // give a blocking point; one taking effect later changes the state, and that deletion lists it).
  const items = after.items.filter((x) => x.status === "applied" || x.status === "corroborated");
  const pieces = after.pieces();
  /** Whether point p is a boundary between a value and none (09 §3.5). */
  const boundary = (p: string) => {
    const l = pieces.find((x) => x.to === p);
    const r = pieces.find((x) => x.from === p);
    return (
      l !== undefined &&
      r !== undefined &&
      after.hasValue(l, EVERYTHING) !== after.hasValue(r, EVERYTHING)
    );
  };
  for (const s of stretches) {
    const at = ends(s.valid ?? []);
    const related = new Set(
      items
        .filter((x) =>
          at.some(
            (p) =>
              ends(x.valid).includes(p) &&
              (x.target === s.field ||
                x.target === "existence" ||
                (boundary(p) && valued.includes(x.target as never))),
          ),
        )
        .map((x) => `${x.event}/${x.target}`),
    );
    for (const c of s.carried) related.add(`${c.event}/${c.target}`);
    for (const c of related) {
      if (gone.has(c) || s.deps.some((x) => `${x.event}/${x.target}` === c)) continue;
      const more = new Set([...gone, c]);
      let again: ReturnType<typeof replayDeletion>;
      try {
        again = replayDeletion(table, records, more, [], latest);
      } catch (e) {
        if (e instanceof JudgeError && e.reason === "not_implemented") continue;
        throw e;
      }
      const cleared = new Set([
        c,
        ...again.restated.map((x) => `${x.item.event}/${x.item.target}`),
      ]);
      if (s.deps.some((x) => cleared.has(`${x.event}/${x.target}`))) continue;
      const key = (x: { valid: IntervalSet; value: unknown; by?: unknown; noValueBy?: unknown }) =>
        JSON.stringify([x.valid, x.value, x.by ?? x.noValueBy ?? null]);
      // The stretch as the replay has it, with its giver (a no_value write-back's included).
      const was = key(
        (view(after, [s.field], true).fields[s.field] ?? []).find(
          (x) => JSON.stringify([x.valid, x.value]) === JSON.stringify([s.valid, s.value]),
        ) ?? { valid: s.valid ?? [], value: "not in the replay" },
      );
      const holds = (view(again.state, [s.field], true).fields[s.field] ?? []).some(
        (x) => key(x) === was,
      );
      expect({ stretch: was, deleted: c, holds }).toEqual({
        stretch: was,
        deleted: c,
        holds: true,
      });
    }
  }
}

/**
 * The item layer's own rules, on any deletion: each fate agrees with the (event, target)'s pending
 * on either side; a new item succeeds one superseded or refreshed; no item is both.
 */
function itemsHold(
  before: RowState,
  after: RowState,
  records: readonly OpRecord[],
  given: ItemsGiven,
  r: ItemsResult,
): void {
  for (const f of r.fates.values()) itemCover[f.kind] = (itemCover[f.kind] ?? 0) + 1;
  // Writes in effect in part when written, by their records (an item in effect and one pending on the same target when written): `returned` only for them.
  const inPart = new Set<string>();
  for (const rec of records) {
    if (!("items" in rec) || (rec.kind !== "write" && rec.kind !== "revoke")) continue;
    for (const t of new Set(rec.items.map((x) => x.target))) {
      const st = rec.items.filter((x) => x.target === t).map((x) => x.status);
      if (
        st.some((x) => x === "applied" || x === "corroborated") &&
        st.some((x) => x === "candidate" || x === "awaiting")
      )
        inPart.add(`${rec.event}/${t}`);
    }
  }
  if (r.refreshed.length > 0) itemCover["refreshed"] = (itemCover["refreshed"] ?? 0) + 1;
  for (const rec of records) {
    if (!("items" in rec)) continue;
    for (const x of rec.items) {
      const key = `${rec.event}/${x.target}`;
      const b = pendingIn(before, rec.event, x.target);
      const a = pendingIn(after, rec.event, x.target);
      const cur = given.items.get(given.of.get(key) ?? "");
      const open = cur?.standing.kind === "open";
      const f = r.fates.get(key);
      // Leaving an open item: only from one it was pending in; into an item: only when pending
      // after; with no fate and pending after in an open item, it was pending in it before.
      const returned = inPart.has(key) ? ["returned"] : [];
      const kinds =
        a !== undefined
          ? ["succeeded", "restored", "rejoined", "none", ...returned]
          : b !== undefined && open
            ? ["removed", "now_effective", "closed_by_revert", ...returned]
            : ["none", ...returned];
      const fate = f?.kind ?? "none";
      expect({ key, fate, ok: kinds.includes(fate) }).toEqual({ key, fate, ok: true });
      if (a !== undefined && fate === "none" && open)
        expect({ key, pendingBefore: b !== undefined }).toEqual({ key, pendingBefore: true });
    }
  }
  // The item a new one succeeds: superseded or refreshed by this deletion, kept superseded after
  // an earlier one, or still open with other members pending (only refreshed by an earlier one):
  // 03-deletion «删除不增加未决事项», the kind changed.
  const earlier = [...given.items]
    .filter(
      ([, x]) =>
        (x.standing.kind === "superseded" && x.standing.reason === "deleted") ||
        x.standing.kind === "open",
    )
    .map(([id]) => id);
  for (const o of r.opened) {
    expect([...r.superseded, ...r.refreshed.map((x) => x.item), ...earlier]).toContain(o.succeeds);
  }
  expect(r.superseded.filter((x) => r.refreshed.some((y) => y.item === x))).toEqual([]);
}

describe.each(both)("%s table", (_, schema, isState) => {
  it("a deletion's replay of writes and revokes leaves what the reference evaluator gives", () => {
    const hits = new Hits(0.3);
    // Hits: a write whose fields have sources of their own, some of them deleted.
    const partly = new Hits(0.1);
    const seen = { samples: 0, changed: 0, decided: 0, partly: 0 };
    fc.assert(
      fc.property(
        scenario(isState).map((s) => ({
          ops: s.ops.filter((o) => o.kind === "write" || o.kind === "revoke"),
          decisions: s.decisions.filter((d) => d.kind === "confirm" || d.kind === "reject"),
        })),
        fc.nat(),
        fc.array(fc.constantFrom(10, 20, 30, 40, 50, 60), { maxLength: 3 }),
        partly.track(
          hits.track(
            (
              { ops, decisions }: { ops: Op[]; decisions: Decision[] },
              pick: number,
              second: number[],
            ) => {
              const c = compare(schema, isState, ops, decisions, pick, second);
              seen.samples++;
              if (c.decided) seen.decided++;
              if (c.partly) {
                seen.partly++;
                partly.hit();
              }
              if (c.changed) {
                seen.changed++;
                hits.hit();
              }
            },
          ),
        ),
      ),
      REPLAY,
    );
    hits.check();
    console.log(schema.kind, JSON.stringify(seen));
    partly.check();
  });
});

describe("two deletions on one row, the first cancelled (a property counterexample)", () => {
  // Seven writes of f2 and a confirmation; S1 (#31, #61) and S6 (#21) deleted in turn. The first
  // deletion splits #51's one item into #0 and #1, the second merges them back (#1 restated as
  // dropped); cancelling the first makes #1 an item again, restated without a value as it is not
  // carried. Its value is #51's own ("9"), never one made up for a block it had none of.
  it("the cancellation's restatements laid over the blocks without the first deletion's give its replay's items", () => {
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "9", sources: ["S4"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "9", sources: ["S5"], explicit: false } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "9", sources: ["S4"], explicit: true } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "9", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "9", sources: ["S3"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as Op[];
    const decisions: Decision[] = [
      { after: 1240855324, pick: 0, kind: "confirm", flag: 0, focus: false },
    ];
    compare(STATE, true, ops, decisions, ["S1", "S6"]);
  });
});

describe("a group value past a field's seen interval (a property counterexample)", () => {
  // The state table with group {f2, f3}, seed -1881329432 of the property above. #61 writes f2 to
  // the next change, its seen version taken before #41 and #51. The group value takes #61's value
  // for a field only where that field's own seen interval reaches (09-references «冲突判据»);
  // elsewhere V's. Taking #61's value for f2 everywhere merged a write the kernel judged a conflict.
  it("the deletion's replay leaves what the reference evaluator gives", () => {
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "3", sources: ["S4"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f3: { value: "1", sources: ["S5"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "9", sources: ["S4"], explicit: false } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "1", sources: ["S5"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 20,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "next_change" } },
        fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as Op[];
    compare({ ...STATE, groups: GROUPS }, true, ops, [], 112260546, [60]);
  });
});

describe("two deletions, the first cancelled: the items left numbered otherwise (a property counterexample)", () => {
  // State table, seed -1335765174 of the reverts property. #61 takes the previous value against
  // #41 and #51; #71 writes f2 = 2 from 11-01 to the next change; the decision inserts an undo
  // (event 74) of #61 with nothing to write back on f2 when written. Deleting S40 (#41) gives 74 a
  // first write-back on f2, index 0, [11-03, 11-07) = 3, from the deletion alone. Deleting S3 (#71)
  // too and cancelling the first leaves 74 two write-backs on f2, [11-01, 11-03) = 2 and
  // [11-03, 11-07) = 3: the same status, interval and value on both sides, the kernel numbering
  // them 0 and 1, the reference 1 and 0 (decision record `index-given-only-by-cancelled-deletion.md`
  // §1). Indices are not compared after a cancellation (its §7); the second part of that decision
  // numbers them again, and this case compares them then.
  it("the deletion's replay and both cancellations leave what the reference evaluator gives", () => {
    const span = (from: string, to: string) => ({
      from: { mode: "given", value: from },
      to: { mode: "given", value: to },
    });
    const write = (op: number, seen: number, valid: unknown, v: string, ack = true) => ({
      kind: "write",
      op,
      event: op + 1,
      seen,
      valid,
      fields: { f2: { value: v, sources: [`S${op}`] } },
      ...(ack ? { acknowledge: ["overwrite"] } : {}),
    });
    const ops = [
      write(10, 0, { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } }, "1"),
      write(20, 10, span("2026-11-01", "2026-11-07"), "2"),
      write(30, 20, span("2026-11-03", "2026-11-09"), "3"),
      write(40, 10, span("2026-11-01", "2026-11-05"), "4", false),
      write(50, 20, span("2026-11-03", "2026-11-07"), "5", false),
      {
        kind: "resolve",
        op: 60,
        event: 61,
        decision: "take_previous",
        candidates: [41, 51],
        unit: "f2",
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "next_change" } },
        fields: { f2: { value: "2", sources: ["S3", "S4"], explicit: true } },
        acknowledge: ["overwrite"],
      },
    ] as Op[];
    const decisions: Decision[] = [
      { after: 303906791, pick: 0, kind: "undo", flag: 0, focus: true },
    ];
    compare(STATE, true, ops, decisions, ["S40", "S3"]);
  });
});

describe("an undo of a confirmation lists every target of the confirmed write (a property counterexample)", () => {
  // State table, f2 and f3 required; seed 1473863789 of the reference property's tier. #61 (seen
  // #21) writes (9, b) over [11-01, 11-11): f2 is a candidate against #31 and #51, f3 awaiting (①,
  // the f3 change at 11-03 erased). #63 confirms it: f3 takes effect, f2 stays a candidate. #65
  // undoes #63. Its record is #64 on every target #61 wrote, f2 and f3, not only f3, which the
  // confirmation put into effect then (09 §5.7 «回退记录里列哪些条目»).
  const schema = { ...STATE, required: ["f2", "f3"] as FieldId[] };
  const span = (from: string, to: string) => ({
    from: { mode: "given", value: from },
    to: { mode: "given", value: to },
  });
  const open = (from: string) => ({ from: { mode: "given", value: from }, to: { mode: "open" } });
  const ops = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      valid: open("2026-11-01"),
      fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      valid: open("2026-11-09"),
      fields: { f2: { value: "7", sources: ["S12"] }, f3: { value: "1", sources: ["S12"] } },
      acknowledge: ["overwrite"],
      seenCurrent: true,
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      valid: span("2026-11-03", "2026-11-05"),
      fields: { f2: { value: "2", sources: ["S20"] } },
      acknowledge: ["overwrite"],
      seenCurrent: true,
    },
    {
      kind: "revoke",
      op: 40,
      event: 41,
      seen: 30,
      valid: open("2026-11-11"),
      validSources: ["S30"],
      seenCurrent: true,
    },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 20,
      valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "next_change" } },
      fields: { f2: { value: "5", sources: ["S40"] }, f3: { value: "b", sources: ["S40"] } },
    },
    {
      kind: "resolve",
      op: 53,
      event: 53,
      decision: "keep_effective",
      candidates: [51],
      unit: "f2",
    },
    {
      kind: "write",
      op: 60,
      event: 61,
      seen: 20,
      valid: span("2026-11-01", "2026-11-11"),
      fields: {
        f2: { value: "9", sources: ["S6"], explicit: false },
        f3: { value: "b", sources: ["S6"] },
      },
    },
    { kind: "confirm", op: 63, event: 64, target: 61 },
    { kind: "undo", op: 65, event: 66, target: 63, includeLater: false },
  ] as Op[];

  it("the record as the reference evaluator gives it: #64 on f2 and on f3", () => {
    const { steps, refused } = judged(schema, ops, []);
    expect(refused).toEqual([]);
    const confirmed = steps.find((x) => x.judgement.record.event === 64)?.judgement.record;
    expect(confirmed?.kind === "confirm" ? confirmed.items.map((x) => x.target) : []).toEqual([
      "f3",
    ]);
    const undo = steps.find((x) => x.judgement.record.event === 66)?.judgement.record;
    const kernel =
      undo?.kind === "undo" ? undo.revert.entries.map((e) => `${e.event}/${e.target}`) : [];
    const ref = evaluateLog(schema, ops)
      .final.reverts.filter((r) => r.event === 66)
      .flatMap((r) => r.record.map((e) => `${e.event}/${e.target}`));
    expect(kernel.sort()).toEqual(["64/f2", "64/f3"]);
    expect(ref.sort()).toEqual(["64/f2", "64/f3"]);
  });

  // Deleting #31's words (S20) leaves #61's f2 no conflict: in the replay it is awaiting at #61 and
  // the confirmation #64 puts it into effect. The undo of #63 takes it back with f3: f2 on 11-01 is
  // #11's 1 again, as the reference evaluator gives it. With f3 alone in the record it stayed 9.
  it("a deletion putting f2 into effect through the confirmation: the undo takes it back too", () => {
    compare(schema, true, ops, [], ["S20"]);
  });
});

describe("a revert's write-back restated as a restore after a revoke was left (a property counterexample)", () => {
  // The state table with group {f2, f3}, seed -1366647956 of the reverts property. #10 (1, a) from
  // 10-01; #20 revokes [11-03, 11-09); #30 (2, b) over [11-05, 11-07); #40 f2 = 9 over
  // [11-01, 11-03); #50 f2 = 9 from 11-01; #60 revokes [11-05, 11-07); the decision inserts an undo
  // whose write-back (event 64) is over [11-05, 11-07).
  // Deleting S3 (#50) leaves that write-back a revoke; deleting S10 (#10) as well restates it as a
  // restore, the same interval and deps. That restatement is a change (09 §5.9 rule 1): the kind of
  // a write-back is given as `restored`, not as content.
  it("the deletion's replay leaves what the reference evaluator gives, in both orders", () => {
    const span = (from: string, to: string) => ({
      from: { mode: "given", value: from },
      to: { mode: "given", value: to },
    });
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: span("2026-11-03", "2026-11-09"),
        validSources: ["S20"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: span("2026-11-05", "2026-11-07"),
        fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 0,
        valid: span("2026-11-01", "2026-11-03"),
        fields: { f2: { value: "9", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "9", sources: ["S3"], explicit: false } },
      },
      {
        kind: "revoke",
        op: 60,
        event: 61,
        seen: 50,
        valid: span("2026-11-05", "2026-11-07"),
        validSources: ["S1"],
      },
    ] as Op[];
    const decisions: Decision[] = [
      { after: 1138313729, pick: 1248658181, kind: "undo", flag: 0, focus: false },
    ];
    compare({ ...STATE, groups: GROUPS }, true, ops, decisions, ["S3", "S10"]);
  });
});

describe("a write in a deletion's grace period, the deletion giving the entity a value on part of its time (a property counterexample)", () => {
  // State table. #10 f2 = 1 from 10-01; #20 and #30 revoke the entity (#30 a candidate, taken);
  // #40 f2 = 1 from 11-01; #50 f2 = 1 over [10-01, 11-01), awaiting behind #40. Deleting #40's words
  // gives the entity a value over [10-01, 11-01) only: the deletion's L there, not over the whole
  // time. A write in its grace period from 11-02 does not meet it and takes effect, as the
  // reference evaluator gives it (09-references «冲突判据», L's interval). Seed -1057634552.
  it("the write's judgement as the reference evaluator gives it", () => {
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      { kind: "revoke", op: 20, event: 21, seen: 10 },
      { kind: "revoke", op: 30, event: 31, seen: 10 },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S5"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-10-01" },
          to: { mode: "given", value: "2026-11-01" },
        },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as Op[];
    const decisions: Decision[] = [
      { after: 954842038, pick: 0, kind: "take", flag: 0, focus: false },
    ];
    compare(STATE, true, ops, decisions, 23);
  });
});

/**
 * The shapes this version refuses (see replay-deletion.ts): high impact ④ judged again (and, with
 * its own kind, an undo that would then take effect on a revoked row), and a resolution whose
 * candidate leaves neither an item nor a shadow (a same-valued one counts its shadow, `kOf`). A
 * sample reaching one is set aside, and counted.
 */
const REFUSED = new Set([
  "undo no longer of high impact",
  "undo on a revoked row",
  "take_previous candidate",
  "take_candidate candidate",
  "referenced_revoke_awaiting",
  "revoke_conflict_cleared",
  "revoke_noop_now_effective",
]);

function refusedShape(e: unknown): boolean {
  return (
    e instanceof JudgeError &&
    e.reason === "not_implemented" &&
    REFUSED.has(String((e.detail as { kind?: unknown } | undefined)?.kind))
  );
}

describe.each(both)("%s table, reverts", (_, schema, isState) => {
  it("undos, take_previous and confirmed undos replayed leave what the reference evaluator gives", () => {
    // Hits: a revert whose write-backs came out otherwise in the replay than recorded.
    const hits = new Hits(0.05);
    const seen = {
      samples: 0,
      reverted: 0,
      revertChanged: 0,
      took: 0,
      tookFilled: 0,
      shadowed: 0,
      refused: 0,
    };
    const refusedBy: Record<string, number> = {};
    fc.assert(
      fc.property(
        scenario(isState).map((s) => ({
          ops: s.ops,
          decisions: s.decisions,
        })),
        fc.nat(),
        hits.track(({ ops, decisions }: { ops: Op[]; decisions: Decision[] }, pick: number) => {
          seen.samples++;
          let c: ReturnType<typeof compare>;
          try {
            c = compare(schema, isState, ops, decisions, pick);
          } catch (e) {
            if (!refusedShape(e)) throw e;
            seen.refused++;
            const kind = String((e as JudgeError).detail["kind"]);
            refusedBy[kind] = (refusedBy[kind] ?? 0) + 1;
            return;
          }
          if (c.reverted) seen.reverted++;
          if (c.took) seen.took++;
          if (c.tookFilled) seen.tookFilled++;
          if (c.shadowed) seen.shadowed++;
          if (c.revertChanged) {
            seen.revertChanged++;
            hits.hit();
          }
        }),
      ),
      REPLAY,
    );
    console.log(schema.kind, "reverts", JSON.stringify({ ...seen, refusedBy }));
    hits.check();
    // The refused shapes stay a minority, so the rest is what this version covers. Measured at
    // 600 runs: about 12% on state tables (most an include_later undo whose later write the
    // deletion took away, ④), about 1% on event tables.
    expect(seen.refused).toBeLessThan(seen.samples * 0.2);
  });

  it("a resolution whose candidate is a shadow in the replay leaves what the reference evaluator gives", () => {
    // Hits: a shadow in a resolution's K (`shadowSkeleton`: S20 deleted leaves #41 the same as
    // its seen version, no evidence pointed at), the rest of the comparison as above.
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        shadowSkeleton(isState),
        fc.subarray(["S10", "S30", "S40", "S50"], { maxLength: 1 }),
        hits.track((ops: Op[], more: string[]) => {
          let c: ReturnType<typeof compare>;
          try {
            c = compare(schema, isState, ops, [], ["S20", ...more]);
          } catch (e) {
            if (!refusedShape(e)) throw e;
            return;
          }
          if (c.shadowed) hits.hit();
        }),
      ),
      { numRuns: Math.max(50, Math.floor(RUNS / 4)) },
    );
    hits.check();
  });
});

describe("an undo's write-backs after two deletions, the first cancelled (a property counterexample)", () => {
  // A take, then an undo of #70 on group {f2, f3}; S1 (#61) and S4 (#71, #81) deleted in turn. Both
  // indices of the undo's write-back on f2 were first given by the first deletion alone; after its
  // cancellation the kernel restates both as dropped and numbers the write-back left #2 (09 §5.7),
  // the reference evaluator (clearing by ends) keeps it as #1. Status, interval and value agree:
  // the write-back is compared without the index, every other item with it. The kernel's indices
  // are the fixed case in cancelled-index.test.ts.
  it("the state after the cancellation is the second deletion's alone, as the reference evaluator gives it", () => {
    const ops: Op[] = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: {
          from: { mode: "given", value: "2026-11-07" },
          to: { mode: "given", value: "2026-11-09" },
        },
        fields: { f2: { value: "2", sources: ["S30"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-09" },
        },
        fields: { f2: { value: "1", sources: ["S40"], explicit: true } },
      },
      {
        kind: "resolve",
        op: 50,
        event: 51,
        decision: "take_candidate",
        candidates: [41],
        take: 41,
        unit: "f2",
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "3", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        seen: 60,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S4", "S5"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 80,
        event: 81,
        seen: 70,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-03" },
        },
        fields: { f2: { value: "1", sources: ["S4", "S6"], explicit: true } },
        acknowledge: ["overwrite"],
      },
    ] as Op[];
    const decisions: Decision[] = [
      { after: 52038118, pick: 0, kind: "undo", flag: 0, focus: true },
    ];
    compare({ ...STATE, groups: GROUPS }, true, ops, decisions, ["S1", "S4"]);
  });
});

/** A person's decision on an awaiting write: a confirmation or a rejection. */
const confirmOrReject: fc.Arbitrary<Decision> = fc.record({
  after: fc.nat(),
  pick: fc.nat(),
  kind: fc.constantFrom<Decision["kind"]>("confirm", "reject"),
  flag: fc.nat({ max: 7 }),
  focus: fc.boolean(),
});

describe("state table, people's confirmations and rejections", () => {
  it("decided writes replayed as recorded leave what the reference evaluator gives", () => {
    // Hits: a decision that came out otherwise in the replay than recorded. Only a log with an
    // awaiting write gets a decision (about one in six); about 5% of all samples hit at 600 runs.
    const hits = new Hits(0.025);
    const seen = { samples: 0, decided: 0, decisionChanged: 0 };
    fc.assert(
      fc.property(
        scenario(true),
        fc.array(confirmOrReject, { minLength: 1, maxLength: 4 }),
        fc.nat(),
        hits.track((s, decisions, pick) => {
          const ops = s.ops.filter((o) => o.kind === "write" || o.kind === "revoke");
          const c = compare(STATE, true, ops, decisions, pick);
          seen.samples++;
          if (c.decided) seen.decided++;
          if (c.decisionChanged) {
            seen.decisionChanged++;
            hits.hit();
          }
        }),
      ),
      REPLAY,
    );
    hits.check();
    console.log("decisions", JSON.stringify(seen));
  });
});

/**
 * Deviation two on an event table (where no change point makes a write await): a value, a later
 * write pointing at evidence for the same value (a corroboration), perhaps a write to another
 * field, then a write having seen only the first: in effect when written, it meets a change once
 * the first value's source is deleted.
 */
const protectedOnEvent = fc
  .record({
    v: fc.constantFrom("1", "2"),
    corroborate: fc.constantFrom(true, true, true, false),
    // Without a write giving a new version after the first, `seen` is the current version and the
    // last write sees the state just before it: nothing between to meet.
    other: fc.constantFrom(true, true, true, false),
    later: fc.constantFrom("5", "1"),
    seen: fc.constantFrom(10, 10, 20),
    deleted: fc.constantFrom(["S10"], ["S10"], ["S10", "S25"], ["S20"], ["S30"]),
  })
  .map(({ v, corroborate, other, later, seen, deleted }) => ({
    deleted,
    ops: [
      { kind: "write", op: 10, event: 11, seen: 0, fields: { f2: { value: v, sources: ["S10"] } } },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: v, sources: ["S20"], ...(corroborate ? { explicit: true } : {}) } },
      },
      ...(other
        ? [
            {
              kind: "write",
              op: 25,
              event: 26,
              seen: 20,
              fields: { f3: { value: "y", sources: ["S25"] } },
            },
          ]
        : []),
      {
        kind: "write",
        op: 30,
        event: 31,
        seen,
        fields: { f2: { value: later, sources: ["S30"] } },
      },
    ] as Op[],
  }));

describe("event table, deviation two", () => {
  it("a write in effect when written stays in effect, as the reference evaluator gives", () => {
    // Hits: protection decides the replay (with the write recorded as a candidate it differs).
    const hits = new Hits(0.08);
    const seen = { samples: 0, protectionMatters: 0 };
    fc.assert(
      fc.property(
        fc.oneof(
          { weight: 3, arbitrary: protectedOnEvent },
          {
            weight: 1,
            arbitrary: fc.tuple(scenario(false), fc.nat()).map(([s, pick]) => ({
              ops: s.ops.filter((o) => o.kind === "write" || o.kind === "revoke"),
              deleted: pick,
            })),
          },
        ),
        hits.track(({ ops, deleted }) => {
          const c = compare(EVENT, false, ops, [], deleted);
          seen.samples++;
          if (ops.some((o) => o.op === 30) && c.protectionMatters(30)) {
            seen.protectionMatters++;
            hits.hit();
          }
        }),
      ),
      REPLAY,
    );
    hits.check();
    console.log("event deviation two", JSON.stringify(seen));
  });
});

// The item layer's coverage over the samples above (it relies on the file's tests running in
// order, as vitest runs them): each kind of fate a deletion's rules give, and refreshed items.
// `returned` and `closed_by_revert` are left to the fixed cases (fates.test.ts): a write in effect
// in part when written, or a candidate an undo's record covers, is not drawn every run.
describe("the item layer's coverage", () => {
  it("the samples gave each kind of fate and refreshed items", () => {
    const need = ["removed", "now_effective", "succeeded", "restored", "rejoined", "refreshed"];
    expect(Object.fromEntries(need.map((k) => [k, (itemCover[k] ?? 0) > 0]))).toEqual(
      Object.fromEntries(need.map((k) => [k, true])),
    );
  });

  it("the samples gave cancellations with a write in the grace period, some keeping in effect", () => {
    console.log("cancel", JSON.stringify(cancelCover));
    expect(cancelCover.compared).toBeGreaterThan(0);
    expect(cancelCover.kept).toBeGreaterThan(0);
    expect(cancelCover.refused).toBeGreaterThan(0);
    expect(cancelCover.w2Pending).toBeLessThan(cancelCover.tried * W2_PENDING_MAX);
  });

  it("the samples gave grace-period writes of each kind", () => {
    console.log("grace", JSON.stringify(graceCover));
    const { endsAgree: _a, endsMore: _m, kernelOnly: _k, ...kinds } = graceCover;
    expect(Object.fromEntries(Object.entries(kinds).map(([k, n]) => [k, n > 0]))).toEqual(
      Object.fromEntries(Object.keys(kinds).map((k) => [k, true])),
    );
  });
});
