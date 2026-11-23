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

import { evaluateLog, type Op, timeline } from "@fluxvita/saveslot-reference";
import { EVENT, Hits, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "./errors.ts";
import { view } from "./judge.ts";
import type { OpRecord, Restatement } from "./model.ts";
import { replayDeletion } from "./replay-deletion.ts";
import { type GivenBlock, givenByRecords } from "./restate.ts";
import { type Decision, deletedContributions, judged, scenario } from "./scenarios.fixture.ts";
import type { RowState } from "./state.ts";

vi.setConfig({ testTimeout: 120_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 110_000, markInterruptAsFailure: true });

const RUNS = propRuns(600);

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
) =>
  items
    .filter((x) => x.status !== "dropped")
    .map(
      (x) =>
        // The reference names "no value at all" noValue, the kernel no_value (09 §5.7). With the
        // index (03-deletion «回掉的权威定义» step 6): no deletion is carried out in these logs, so
        // the reference's clearing by ends plays no part in where indices land.
        `${x.event}/${x.target}#${x.k} ${x.status} ${JSON.stringify(x.valid)} ${JSON.stringify(x.content).replace('"kind":"noValue"', '"kind":"no_value"')}`,
    )
    .sort();

/** The blocks last given, less the deleted (event, target)s, with the restatements laid over. */
function overlay(
  given: ReadonlyMap<string, readonly GivenBlock[]>,
  restated: readonly Restatement[],
  gone: ReadonlySet<string>,
): Map<string, GivenBlock[]> {
  const out = new Map<string, GivenBlock[]>();
  for (const [et, blocks] of given) if (!gone.has(et)) out.set(et, [...blocks]);
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const rest = (out.get(et) ?? []).filter((b) => b.k !== r.item.k);
    if (r.status === "dropped") {
      // Last given as dropped: kept so (rule 1 compares with it), landing on the last interval
      // given before (numbering only).
      const before = (out.get(et) ?? []).find((b) => b.k === r.item.k);
      const landing = before?.landing ?? before?.valid ?? [];
      out.set(et, [
        ...rest,
        {
          k: r.item.k,
          status: "dropped",
          valid: [],
          ...(landing.length > 0 ? { landing } : {}),
          deps: [],
          content: before?.content ?? { kind: "value", value: null },
        },
      ]);
      continue;
    }
    // A new index has no block of its own: its content is the write's (any other index of it),
    // on existence a restore or a revoke as the restatement says.
    const was =
      (given.get(et) ?? []).find((b) => b.k === r.item.k) ??
      (r.item.target === "existence"
        ? {
            k: r.item.k,
            status: r.status,
            // Event and timeless tables give no interval: an item is the whole of it.
            valid: [{ from: null, to: null }],
            deps: [],
            content: { kind: r.restored ? "restore" : "revoke" } as const,
          }
        : (given.get(et) ?? [])[0]);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        // A restatement without an interval is an event or timeless table's: the whole of it.
        valid: r.valid ?? [{ from: null, to: null }],
        deps: r.deps,
        // On existence a restatement is a restore exactly when it says so (09 §5.9 `restored`).
        content:
          r.item.target === "existence" && r.content === undefined
            ? { kind: r.restored ? "restore" : "revoke" }
            : (r.content ?? was?.content ?? { kind: "value", value: null }),
        // A restatement that gives the content gives the carried references with it (none for
        // a write-back with no value or that only registers).
        ...(r.content !== undefined
          ? r.carried !== undefined
            ? { carried: r.carried }
            : {}
          : was?.carried !== undefined
            ? { carried: was.carried }
            : {}),
      },
    ]);
  }
  return normalized(out);
}

/** The blocks without those last given as dropped. */
function withoutDropped(m: Map<string, GivenBlock[]>): Map<string, GivenBlock[]> {
  return normalized(
    new Map([...m].map(([et, bs]) => [et, bs.filter((b) => b.status !== "dropped")])),
  );
}

/** The replay's items as blocks, by (event, target), each list by index. */
function blocksOf(records: readonly OpRecord[]): Map<string, GivenBlock[]> {
  return normalized(givenByRecords(records));
}

function normalized(m: Map<string, GivenBlock[]>): Map<string, GivenBlock[]> {
  return new Map(
    [...m]
      .filter(([, bs]) => bs.length > 0)
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([et, bs]) => [et, [...bs].sort((x, y) => x.k - y.k)]),
  );
}

/** Each field's timeline; a stretch with no value is left out (the reference lists it as null). */
const timelines = (fields: Readonly<Record<string, unknown>>, names: readonly string[]) =>
  Object.fromEntries(
    names.map((f) => [
      f,
      timeline({ fields } as never, f as never).filter((x) => !x.endsWith(" null")),
    ]),
  );

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
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
  // The restatements, laid over the blocks the log last gave (here the records as written) less
  // the deleted ones, give the replay's items (09 §5.9 «以最近一次为准»): nothing restated is
  // missed, nothing restated that the replay does not have.
  expect(withoutDropped(overlay(givenByRecords(records), replayed.restated, gone))).toEqual(
    blocksOf(replayed.records),
  );
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
      const first = deletedContributions(kept, new Set([a]), isState);
      const once = replayDeletion(table, records, first);
      const afterFirst = overlay(givenByRecords(records), once.restated, first);
      const then = replayDeletion(table, records, gone, [], afterFirst);
      // The round trip across both: the second deletion's restatements laid over the blocks the
      // first left give its replay's items (an item back from dropped must be restated).
      expect(withoutDropped(overlay(afterFirst, then.restated, gone))).toEqual(
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
      { numRuns: RUNS },
    );
    hits.check();
    console.log(schema.kind, JSON.stringify(seen));
    partly.check();
  });
});

/**
 * The shapes this version refuses (see replay-deletion.ts): high impact ④ judged again (and, with
 * its own kind, an undo that would then take effect on a revoked row), and a take_previous whose
 * candidate leaves no item. A sample reaching one is set aside, and counted.
 */
const REFUSED = new Set([
  "undo no longer of high impact",
  "undo on a revoked row",
  "take_previous candidate",
  "take_candidate candidate",
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
          if (c.revertChanged) {
            seen.revertChanged++;
            hits.hit();
          }
        }),
      ),
      { numRuns: RUNS },
    );
    console.log(schema.kind, "reverts", JSON.stringify({ ...seen, refusedBy }));
    hits.check();
    // The refused shapes stay a minority, so the rest is what this version covers. Measured at
    // 600 runs: about 12% on state tables (most an include_later undo whose later write the
    // deletion took away, ④), about 1% on event tables.
    expect(seen.refused).toBeLessThan(seen.samples * 0.2);
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
      { numRuns: RUNS },
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
      { numRuns: RUNS },
    );
    hits.check();
    console.log("event deviation two", JSON.stringify(seen));
  });
});
