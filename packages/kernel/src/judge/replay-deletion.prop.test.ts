// The deletion replay (D1-b2a, b2b) against the reference evaluator: random logs of writes, revokes
// and people's confirmations and rejections of awaiting writes (no reverts, no conflict
// resolutions, no deletion events between operations) are judged op by op,
// then a set of source data is deleted. `replayDeletion` on the records, given the (event, target)
// those sources take away, must leave the row or entity the reference evaluator gives with the
// same deletion at the end of the log: the items (by event, target, status, interval, content,
// without indices: how original indices land is D1-b2e), every field's timeline, the gaps.
//
// Covered here: writes and revokes judged again on the replay's state, no-ops kept, deviation two
// by the write on a target, corroborations and the same-value rule, conflicts and high impact
// worked out again; confirmations and rejections executed as recorded (deviation one). Not yet
// (refused with not_implemented, see replay-deletion.test.ts): reverts, conflict resolutions,
// operations after a deletion event.

import { evaluateLog, type Op, timeline } from "@fluxvita/saveslot-reference";
import { EVENT, Hits, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { view } from "./judge.ts";
import type { OpRecord, Target } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { type Decision, judged, scenario } from "./scenarios.fixture.ts";
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

/**
 * The (event, target) the deleted source data take away (as the caller works out from
 * `base_sources`): a field whose value sources include one; every target of a write or revoke
 * whose interval's sources include one (03-deletion «区间参数»).
 */
function deletedContributions(ops: readonly Op[], deleted: ReadonlySet<string>): Set<string> {
  const out = new Set<string>();
  for (const o of ops) {
    if (o.kind !== "write" && o.kind !== "revoke") continue;
    const intervalGone = (o.validSources ?? []).some((s) => deleted.has(s));
    if (o.kind === "revoke") {
      if (intervalGone) out.add(contributionKey(o.event, "existence"));
      continue;
    }
    for (const [f, x] of Object.entries(o.fields)) {
      if (intervalGone || (x?.sources ?? []).some((s) => deleted.has(s)))
        out.add(contributionKey(o.event, f as Target));
    }
  }
  return out;
}

const itemKeys = (
  items: readonly {
    event: number;
    target: string;
    status: string;
    valid: unknown;
    content: unknown;
  }[],
) =>
  items
    .filter((x) => x.status !== "dropped")
    .map(
      (x) =>
        `${x.event}/${x.target} ${x.status} ${JSON.stringify(x.valid)} ${JSON.stringify(x.content)}`,
    )
    .sort();

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
): {
  changed: boolean;
  decided: boolean;
  decisionChanged: boolean;
  protectionMatters: (op: number) => boolean;
} {
  const { table, steps } = judged(schema, ops, decisions);
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
  const last = Math.max(...kept.map((o) => o.op));
  const ref = evaluateLog(schema, [
    ...kept,
    { kind: "deletion", op: last + 1, id: "pi_x", sources: [...deleted] },
  ]).final;
  const records = steps.map((x) => x.judgement.record);
  const replayed = replayDeletion(table, records, deletedContributions(kept, deleted));
  const { state } = replayed;
  const names = [...new Set([...Object.keys(ref.fields), ...Object.keys(view(state).fields)])];
  expect({
    items: itemKeys(state.items),
    fields: timelines(view(state).fields as never, names),
    gaps: isState ? view(state).gaps : [],
  }).toEqual({
    items: itemKeys(ref.items),
    fields: timelines(ref.fields as never, names),
    gaps: isState ? ref.gaps : [],
  });
  const isDecision = (r: OpRecord) => r.kind === "confirm" || r.kind === "reject";
  const decisionText = (rs: readonly OpRecord[]) =>
    JSON.stringify(rs.filter(isDecision).map((r) => [r.op, "items" in r ? r.items : []]));
  const before = steps.at(-1)?.state as RowState;
  return {
    changed: JSON.stringify(view(before).fields) !== JSON.stringify(view(state).fields),
    decided: records.some(isDecision),
    decisionChanged: decisionText(records) !== decisionText(replayed.records),
    // Whether the replay comes out otherwise with operation `op` recorded as a candidate when
    // written (not protected by deviation two).
    protectionMatters: (op) => {
      const flipped = records.map((r) =>
        r.kind === "write" && r.op === op
          ? { ...r, items: r.items.map((x) => ({ ...x, status: "candidate" as const })) }
          : r,
      );
      const naive = replayDeletion(table, flipped, deletedContributions(kept, deleted)).state;
      return JSON.stringify(itemKeys(naive.items)) !== JSON.stringify(itemKeys(state.items));
    },
  };
}

describe.each(both)("%s table", (_, schema, isState) => {
  it("a deletion's replay of writes and revokes leaves what the reference evaluator gives", () => {
    const hits = new Hits(0.3);
    const seen = { samples: 0, changed: 0, decided: 0 };
    fc.assert(
      fc.property(
        scenario(isState).map((s) => ({
          ops: s.ops.filter((o) => o.kind === "write" || o.kind === "revoke"),
          decisions: s.decisions.filter((d) => d.kind === "confirm" || d.kind === "reject"),
        })),
        fc.nat(),
        hits.track(({ ops, decisions }, pick) => {
          const c = compare(schema, isState, ops, decisions, pick);
          seen.samples++;
          if (c.decided) seen.decided++;
          if (c.changed) {
            seen.changed++;
            hits.hit();
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    console.log(schema.kind, JSON.stringify(seen));
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
