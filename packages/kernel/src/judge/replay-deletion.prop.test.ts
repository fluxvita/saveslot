// The deletion replay (D1-b2a) against the reference evaluator: random logs of writes and revokes
// (no people's decisions, no reverts, no deletion events between operations) are judged op by op,
// then a set of source data is deleted. `replayDeletion` on the records, given the (event, target)
// those sources take away, must leave the row or entity the reference evaluator gives with the
// same deletion at the end of the log: the items (by event, target, status, interval, content,
// without indices: how original indices land is D1-b2e), every field's timeline, the gaps.
//
// Covered here: writes and revokes judged again on the replay's state, no-ops kept, deviation two
// by the write on a target, corroborations and the same-value rule, conflicts and high impact
// worked out again. Not yet (refused with not_implemented, see replay-deletion.test.ts):
// confirmations, rejections, reverts, conflict resolutions, operations after a deletion event.

import { evaluateLog, type Op, timeline } from "@fluxvita/saveslot-reference";
import { EVENT, Hits, propRuns, STATE } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { view } from "./judge.ts";
import type { Target } from "./model.ts";
import { contributionKey, replayDeletion } from "./replay-deletion.ts";
import { judged, scenario } from "./scenarios.fixture.ts";
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

describe.each(both)("%s table", (_, schema, isState) => {
  it("a deletion's replay of writes and revokes leaves what the reference evaluator gives", () => {
    const hits = new Hits(0.3);
    const seen = { samples: 0, changed: 0 };
    fc.assert(
      fc.property(
        scenario(isState).map((s) => ({
          ops: s.ops.filter((o) => o.kind === "write" || o.kind === "revoke"),
          decisions: [],
        })),
        fc.nat(),
        hits.track(({ ops }, pick) => {
          const { table, steps } = judged(schema, ops, []);
          const kept = steps.map((x) => x.op);
          const cited = [...new Set(kept.flatMap(sourcesOf))].sort();
          fc.pre(cited.length > 0);
          // One or two of the cited sources deleted.
          const first = cited[pick % cited.length] as string;
          const second = cited[Math.floor(pick / 7) % cited.length] as string;
          const deleted = new Set([first, second]);
          const last = Math.max(...kept.map((o) => o.op));
          const ref = evaluateLog(schema, [
            ...kept,
            { kind: "deletion", op: last + 1, id: "pi_x", sources: [...deleted] },
          ]).final;
          const records = steps.map((x) => x.judgement.record);
          const { state } = replayDeletion(table, records, deletedContributions(kept, deleted));
          seen.samples++;
          const before = steps.at(-1)?.state as RowState;
          if (JSON.stringify(view(before).fields) !== JSON.stringify(view(state).fields)) {
            seen.changed++;
            hits.hit();
          }
          const names = [
            ...new Set([...Object.keys(ref.fields), ...Object.keys(view(state).fields)]),
          ];
          expect({
            items: itemKeys(state.items),
            fields: timelines(view(state).fields as never, names),
            gaps: isState ? view(state).gaps : [],
          }).toEqual({
            items: itemKeys(ref.items),
            fields: timelines(ref.fields as never, names),
            gaps: isState ? ref.gaps : [],
          });
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
    console.log(schema.kind, JSON.stringify(seen));
  });
});
