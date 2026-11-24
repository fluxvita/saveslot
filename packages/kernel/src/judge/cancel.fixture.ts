// Shared by the judge's and the log's tests of the item layer across deletions and their
// cancellations (cancel.test.ts, write/cancel-items.log.test.ts).

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import type { Op } from "@fluxvita/saveslot-reference";
import { advance } from "./fates.fixture.ts";
import { itemsByRecords } from "./fates.ts";
import type { OpRecord, Restatement, TableShape } from "./model.ts";
import { cancellationResult, deletionResult } from "./replay-deletion.ts";
import { type GivenBlock, givenByRecords, type LatestGiven } from "./restate.ts";
import { deletedContributions } from "./scenarios.fixture.ts";
import { RowState } from "./state.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const w = (
  op: number,
  seen: number,
  _f: Record<string, string>,
  o: { from?: string; to?: string } = {},
): Op =>
  ({
    kind: "write",
    op,
    event: op + 1,
    seen,
    now: d("11-05"),
    valid: {
      from: { mode: "given", value: d(o.from ?? "10-01") },
      to: o.to === undefined ? { mode: "open" } : { mode: "given", value: d(o.to) },
    },
    fields: {},
  }) as Op;

/** The blocks after a deletion's restatements: each restated index replaced, as the log reads. */
export function laid(
  base: LatestGiven,
  restated: readonly Restatement[],
): Map<string, GivenBlock[]> {
  const out = new Map([...base].map(([k, bs]) => [k, [...bs]]));
  for (const r of restated) {
    const et = `${r.item.event}/${r.item.target}`;
    const was = (out.get(et) ?? []).find((b) => b.k === r.item.k) ?? (out.get(et) ?? [])[0];
    const rest = (out.get(et) ?? []).filter((b) => b.k !== r.item.k);
    out.set(et, [
      ...rest,
      {
        k: r.item.k,
        status: r.status,
        valid: r.status === "dropped" ? [] : (r.valid ?? [{ from: null, to: null }]),
        deps: r.deps,
        content: r.content ?? was?.content ?? { kind: "value", value: null },
        ...(r.carried !== undefined ? { carried: r.carried } : {}),
      },
    ]);
  }
  return out;
}

/**
 * A deleted, then B; B cancelled, then A, each event given what the log says before it. The open
 * items at the end are those as written.
 */
export function cancelBoth(
  table: TableShape,
  records: readonly OpRecord[],
  kept: readonly Op[],
  a: string[],
  b: string[],
) {
  const gone = (s: string[]) => deletedContributions(kept, new Set(s), true);
  const [ga, gb] = [gone(a), gone(b)];
  const both = new Set([...ga, ...gb]);
  const base = givenByRecords(records);
  const interval = (rs: readonly Restatement[]) =>
    rs
      .filter((r) => r.status !== "dropped")
      .map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`);
  const g0 = itemsByRecords(new RowState(table, records));
  const delA = deletionResult(table, records, ga, new Set(), g0, [], base);
  const afterA = laid(base, delA.replay.restated);
  const g1 = advance(g0, delA.items);
  const delB = deletionResult(table, records, both, ga, g1, [], afterA);
  const g2 = advance(g1, delB.items);
  // B cancelled: the blocks without B's are A's over the records; B's last interval blocks.
  const cB = cancellationResult(
    table,
    records,
    ga,
    gb,
    g2,
    afterA,
    new Set(interval(delB.replay.restated)),
    [],
  );
  const g3 = advance(g2, cB.items);
  // A cancelled: the blocks without A's are B's cancellation's over the records.
  const byCB = new Set(
    cB.replay.restated.map((r) => `${r.item.event}/${r.item.target}/${r.item.k}`),
  );
  const cA = cancellationResult(
    table,
    records,
    new Set(),
    ga,
    g3,
    laid(base, cB.replay.restated),
    new Set(interval(delA.replay.restated).filter((k) => !byCB.has(k))),
    [],
  );
  return { table, records, g0, g2, g3, cB, cA, end: advance(g3, cA.items) };
}

/**
 * #10 f2=9 from 10-01 (S5); #20 f2=9 on [11-01, 11-03) (S6); #40 revokes [11-01, 11-03) (S1);
 * #60 (seen #20) f2=9 from 11-01 pointing at its evidence (S3): a candidate on [11-01, 11-03) on
 * the existence item 61:existence (it met the revoke), a corroboration from 11-03; #70 revokes
 * [11-01, 11-03) again (S1).
 */
export const PART_BACK_OPS: Op[] = [
  { ...w(10, 0, {}), fields: { f2: { value: "9", sources: ["S5"] } } } as Op,
  {
    ...w(20, 0, {}, { from: "11-01", to: "11-03" }),
    fields: { f2: { value: "9", sources: ["S6"] } },
  } as Op,
  {
    kind: "revoke",
    op: 40,
    event: 41,
    seen: 20,
    valid: {
      from: { mode: "given", value: d("11-01") },
      to: { mode: "given", value: d("11-03") },
    },
    validSources: ["S1"],
  } as Op,
  {
    ...w(60, 20, {}, { from: "11-01" }),
    fields: { f2: { value: "9", sources: ["S3"], explicit: true } },
  } as Op,
  {
    kind: "revoke",
    op: 70,
    event: 71,
    seen: 60,
    valid: {
      from: { mode: "given", value: d("11-01") },
      to: { mode: "given", value: d("11-03") },
    },
    validSources: ["S1"],
  } as Op,
];
