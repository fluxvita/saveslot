// Several deletions of a row confirmed and cancelled in turn, against a model of the log's blocks
// (09 §3.5, §5.7, §5.9): the blocks as written and each event's `restated/<k>`, in log order; each
// deletion's list of positions worked out when it is confirmed, from its replay alone (09 §3.5
// rule 1); a cancelled deletion's blocks no longer counting (§5.7). With every deletion still
// pending carried out, the last readable block of each item is the live replay's item: a replay
// from an empty store gives the state the log gave live.
//
// The rest of the kernel's deletion tests compare restatements laid over (`overlay`) with the
// replay on both sides, and none models a block a deletion's own list clears; this one works the
// list out on its own, as the specification defines it, and is what catches rule 2 (09 §5.9).

import { evaluateLog, type Op } from "@fluxvita/saveslot-reference";
import {
  EVENT as EVENT_SCHEMA,
  propRuns,
  STATE as STATE_SCHEMA,
} from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { JudgeError } from "../judge/errors.ts";
import {
  type Decision,
  deletedContributions,
  judged,
  scenario,
} from "../judge/scenarios.fixture.ts";
import { BlockModel as Session } from "./blocks.fixture.ts";
import { BLOCK_CASES } from "./replay-blocks.cases.fixture.ts";

vi.setConfig({ testTimeout: 600_000 });

const RUNS = propRuns(300);
// A fixed seed by default, so that a run says the same as the last one; the soak runs
// (`PROP_COVERAGE` set, scripts/soak-props.ts) keep fast-check's fresh random seed, `PROP_SEED`
// replays one.
const SEED =
  process.env["PROP_SEED"] !== undefined
    ? Number(process.env["PROP_SEED"])
    : process.env["PROP_COVERAGE"] === undefined
      ? 20261126
      : undefined;

const sourcesOf = (ops: readonly Op[]) =>
  [
    ...new Set(
      ops.flatMap((o) =>
        o.kind === "write"
          ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
          : o.kind === "revoke"
            ? [...(o.validSources ?? [])]
            : [],
      ),
    ),
  ].sort();

type Step = { readonly c: number } | { readonly x: number };

/** The log judged, then each step in turn: confirm `D<c>` (deleting `dels[c]`), or cancel `D<x>`. */
function runScript(
  schema: typeof STATE_SCHEMA,
  ops: readonly Op[],
  decisions: readonly Decision[],
  dels: readonly (readonly string[])[],
  script: readonly Step[],
): Session {
  const isState = schema.kind === "state";
  const j = judged(schema, ops as Op[], decisions as Decision[]);
  const kept = j.steps.map((x) => x.op);
  const s = new Session(
    j.table,
    j.steps.map((x) => x.judgement.record),
  );
  for (const step of script) {
    if ("c" in step) {
      const id = `D${step.c}`;
      if (!s.deletions.has(id))
        s.confirm(id, deletedContributions(kept, new Set(dels[step.c] ?? []), isState));
    } else {
      const d = s.deletions.get(`D${step.x}`);
      if (d !== undefined && !d.cancelled) s.cancel(`D${step.x}`);
    }
  }
  return s;
}

const refused = (e: unknown) => e instanceof JudgeError && e.reason === "not_implemented";

describe.each([
  ["state", STATE_SCHEMA, true],
  ["event", EVENT_SCHEMA, false],
] as const)("%s table", (_, schema, isState) => {
  it("a replay from an empty store gives what the deletions gave live", () => {
    const seen = { runs: 0, refused: 0, several: 0 };
    fc.assert(
      fc.property(
        scenario(isState),
        fc.array(fc.nat(), { minLength: 2, maxLength: 4 }),
        fc.array(
          fc.oneof(fc.record({ c: fc.nat({ max: 3 }) }), fc.record({ x: fc.nat({ max: 3 }) })),
          { minLength: 2, maxLength: 6 },
        ),
        ({ ops, decisions }, picks, script) => {
          const srcs = sourcesOf(ops);
          if (srcs.length < 2) return;
          // One source each, none twice (a deletion of a source deleted already deletes nothing).
          const used = new Set<string>();
          const dels = picks.map((p) => {
            const x = srcs[p % srcs.length] as string;
            if (used.has(x)) return [] as string[];
            used.add(x);
            return [x];
          });
          seen.runs++;
          let s: Session;
          try {
            s = runScript(schema, ops, decisions, dels, script);
          } catch (e) {
            if (refused(e)) {
              seen.refused++;
              return;
            }
            throw e;
          }
          if (s.deletions.size >= 2) seen.several++;
          expect({ ops, decisions, dels, script, fromEmpty: s.fromEmpty() }).toEqual({
            ops,
            decisions,
            dels,
            script,
            fromEmpty: s.liveItems(),
          });
        },
      ),
      { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
    // Against a generator gone degenerate: most samples replay, and many hold several deletions.
    expect(seen.refused).toBeLessThan(seen.runs / 2);
    expect(seen.several).toBeGreaterThan(seen.runs / 8);
  });
});

describe("fixed cases", () => {
  for (const c of BLOCK_CASES) {
    for (const table of c.tables) {
      it(`${c.name}, ${table} table`, () => {
        const s = runScript(
          table === "state" ? STATE_SCHEMA : EVENT_SCHEMA,
          c.ops,
          c.decisions,
          c.dels,
          c.script,
        );
        expect(s.fromEmpty()).toEqual(s.liveItems());
      });
    }
  }

  it("a deletion cancelled after another cleared the block of an item it had dropped", () => {
    // #50 writes "1" from 11-01 to the next change, resting on #40. A deletes S2 and restates #50 as
    // dropped; B deletes SZ, restating #40 on its own, so B's list clears #50's blocks (by its dep)
    // and A's block saying it is dropped. A cancelled: #50 is in effect again, live; replayed from
    // an empty store with B carried out, it must be given by an event still readable.
    const g = (from: string, to: string | null | "next") => ({
      valid: {
        from: { mode: "given", value: from },
        to:
          to === null
            ? { mode: "open" }
            : to === "next"
              ? { mode: "next_change" }
              : { mode: "given", value: to },
      },
    });
    const ops = [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        ...g("2026-10-01", null),
        fields: { f2: { value: "1", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        ...g("2026-11-01", null),
        fields: { f2: { value: "2", sources: ["S2"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        ...g("2026-11-20", null),
        fields: { f2: { value: "9", sources: ["SZ"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        ...g("2026-11-10", "next"),
        fields: { f2: { value: "3", sources: ["SY"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        ...g("2026-11-01", "next"),
        fields: { f2: { value: "1", sources: ["SX"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as unknown as Op[];
    const s = runScript(STATE_SCHEMA, ops, [], [["S2"], ["SZ"]], [{ c: 0 }, { c: 1 }, { x: 0 }]);
    expect(s.liveItems().some((x) => x.startsWith("51/f2/0 applied"))).toBe(true);
    expect(s.fromEmpty()).toEqual(s.liveItems());
  });
});

/** The block model replayed from an empty store, against the reference evaluator given the same
 * deletion and cancellation events in turn: an oracle of its own, not the kernel's blocks. */
function againstReference(
  schema: typeof STATE_SCHEMA,
  ops: readonly Op[],
  dels: readonly (readonly string[])[],
  script: readonly Step[],
): { fromEmpty: string[]; reference: string[] } {
  const s = runScript(schema, ops, [], dels, script);
  const kept = judged(schema, ops as Op[], []).steps.map((x) => x.op);
  let op = Math.max(...kept.map((o) => Math.max(o.op, o.event)));
  const entries: unknown[] = [...kept];
  for (const t of s.trace) {
    const [kind, id] = t.split(" ") as [string, string];
    entries.push(
      kind === "confirm"
        ? { kind: "deletion", op: ++op, id, sources: dels[Number(id.slice(1))] }
        : { kind: "cancel", op: ++op, id },
    );
  }
  const valid = (v: unknown) => (schema.kind === "state" ? JSON.stringify(v) : "");
  const reference = evaluateLog(schema, entries as never)
    .final.items.filter((x) => x.status !== "dropped")
    .map((x) => `${x.event}/${x.target}/${x.k} ${x.status} ${valid(x.valid)}`)
    .sort();
  const fromEmpty = s
    .fromEmpty()
    .map((x) => x.slice(0, x.lastIndexOf(" ")))
    .sort();
  return { fromEmpty, reference };
}

describe("histories around an item an earlier deletion dropped, against the reference evaluator", () => {
  // #50 writes "1" from 11-01 to the next change, resting on #40 ("3" from 11-10 to the next
  // change, resting on #30). A deletes S2 (#20's words) and restates #50 as dropped. Each history
  // goes on otherwise: a later deletion whose list does not touch A's block, one that deletes #50
  // itself, one or two that clear it, cancellations between and after, the order swapped.
  const g = (from: string, to: string | null | "next") => ({
    valid: {
      from: { mode: "given", value: from },
      to:
        to === null
          ? { mode: "open" }
          : to === "next"
            ? { mode: "next_change" }
            : { mode: "given", value: to },
    },
  });
  const OPS = [
    {
      kind: "write",
      op: 10,
      event: 11,
      seen: 0,
      ...g("2026-10-01", null),
      fields: { f2: { value: "1", sources: ["S1"] } },
    },
    {
      kind: "write",
      op: 20,
      event: 21,
      seen: 10,
      ...g("2026-11-01", null),
      fields: { f2: { value: "2", sources: ["S2"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 30,
      event: 31,
      seen: 20,
      ...g("2026-11-20", null),
      fields: { f2: { value: "9", sources: ["SZ"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 40,
      event: 41,
      seen: 30,
      ...g("2026-11-10", "next"),
      fields: { f2: { value: "3", sources: ["SY"] } },
      acknowledge: ["overwrite"],
    },
    {
      kind: "write",
      op: 50,
      event: 51,
      seen: 40,
      ...g("2026-11-01", "next"),
      fields: { f2: { value: "1", sources: ["SX"], explicit: false } },
      acknowledge: ["overwrite"],
    },
  ] as unknown as Op[];
  const HISTORIES: [string, string[][], Step[]][] = [
    ["B's list does not touch A's dropped block", [["S2"], ["S1"]], [{ c: 0 }, { c: 1 }]],
    [
      "the item brought back between A and B (A cancelled, then B)",
      [["S2"], ["SZ"]],
      [{ c: 0 }, { x: 0 }, { c: 1 }],
    ],
    ["B deletes the dropped item itself", [["S2"], ["SX"]], [{ c: 0 }, { c: 1 }]],
    ["B and C both clear it, A pending", [["S2"], ["SZ"], ["SY"]], [{ c: 0 }, { c: 1 }, { c: 2 }]],
    [
      "B and C both clear it, then A cancelled",
      [["S2"], ["SZ"], ["SY"]],
      [{ c: 0 }, { c: 1 }, { c: 2 }, { x: 0 }],
    ],
    [
      "B clears it, B cancelled, then C",
      [["S2"], ["SZ"], ["SY"]],
      [{ c: 0 }, { c: 1 }, { x: 1 }, { c: 2 }],
    ],
    ["B clears it, then A cancelled", [["S2"], ["SZ"]], [{ c: 0 }, { c: 1 }, { x: 0 }]],
    ["the order swapped: B first, then A", [["S2"], ["SZ"]], [{ c: 1 }, { c: 0 }]],
  ];
  for (const [name, dels, script] of HISTORIES) {
    it(name, () => {
      const r = againstReference(STATE_SCHEMA, OPS, dels, script);
      expect(r.fromEmpty).toEqual(r.reference);
    });
  }
});

describe("a block resting on a carried item, the only deletion on the row", () => {
  it("event table: a take's block, the item it carries restated as dropped", () => {
    // #20 writes f2 = 5; #50, stale, writes f2 = 1 (a candidate); #53 revokes the row; #60 writes
    // f2 = 1 (a candidate on existence); #63 takes #60's candidate: it restores the row and carries
    // #60's f2. Deleting #20's words puts #50 into effect and restates #60 as dropped (the same
    // value, no evidence); #63's f2 block rests on #60 by the carried item only (an event table's
    // block has no deps), and is cleared. With no other deletion on the row the delete operation
    // passes no list of its own (`cleared`): rule 2 alone, by the carried item, restates #63's f2.
    // Found by the property with that branch taken away (seed 646220842), then shrunk.
    const ops = [
      {
        kind: "write",
        op: 20,
        event: 21,
        seen: 10,
        fields: { f2: { value: "5", sources: ["S20"] } },
        acknowledge: ["overwrite"],
        seenCurrent: true,
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        fields: { f2: { value: "1", sources: ["S1", "S4"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      { kind: "revoke", op: 53, event: 54, seen: 52 },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        fields: { f2: { value: "1", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "resolve",
        op: 63,
        event: 64,
        decision: "take_candidate",
        candidates: [61],
        unit: "existence",
        take: 61,
      },
    ] as unknown as Op[];
    const s = runScript(EVENT_SCHEMA, ops, [], [["S20"]], [{ c: 0 }]);
    expect(s.deletions.size).toBe(1);
    expect(
      s.log[0]?.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k} ${r.status}`),
    ).toEqual(["51/f2/0 applied", "61/f2/0 dropped", "64/f2/0 applied"]);
    expect(s.fromEmpty()).toEqual(s.liveItems());
  });
});
