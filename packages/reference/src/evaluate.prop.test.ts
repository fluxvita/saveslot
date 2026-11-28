// Property tests on the reference evaluator alone (02-architecture §11, «删除的性质»): no kernel.

import fc from "fast-check";
import { describe, expect, it, vi } from "vitest";
import { evaluate, evaluateAsWritten, evaluateLog } from "./evaluate.ts";
import { covers, intersect, isEmpty, type Point } from "./interval.ts";
import type { Evaluation, ItemRef, Op, SourceKey } from "./model.ts";
import {
  EVENT,
  mostly,
  revertSkeleton,
  STATE,
  sameValue,
  scenario,
  stale,
  withSteps,
} from "./testing/arbitraries.fixture.ts";
import { Hits, propRuns } from "./testing/prop-coverage.fixture.ts";

// An explicit time limit; on a failure (including running out of time) fast-check reports the
// seed and path that reproduce it: `fc.assert(..., { seed, path, endOnFailure: true })`.
vi.setConfig({ testTimeout: 30_000 });
fc.configureGlobal({ interruptAfterTimeLimit: 25_000, markInterruptAsFailure: true });

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

const RUNS = propRuns(4000);
const pending = (s: string): boolean => s === "candidate" || s === "awaiting";
const effective = (s: string) => s === "applied" || s === "corroborated";
const etKey = (x: { event: number; target: string }) => `${x.event}/${x.target}`;

/** Whether any op cites one of `deleted` as a source or as evidence for its interval. */
function cites(ops: readonly Op[], deleted: readonly SourceKey[]): boolean {
  return ops.some((o) => {
    const own =
      o.kind === "write"
        ? [...Object.values(o.fields).flatMap((x) => x?.sources ?? []), ...(o.validSources ?? [])]
        : o.kind === "revoke"
          ? [...(o.validSources ?? [])]
          : [];
    return own.some((x) => deleted.includes(x));
  });
}

function comparable(ev: Evaluation) {
  return {
    ...ev,
    items: [...ev.items].sort(
      (x, y) => x.event - y.event || x.target.localeCompare(y.target) || x.k - y.k,
    ),
  };
}

/** Fields judged a no-op at write time: marked, or present in the request without any item. */
function writeTimeNoops(ops: readonly Op[], asWritten: Evaluation): string[] {
  const out: string[] = [];
  for (const o of ops) {
    if (o.kind !== "write") continue;
    for (const f of o.noop ?? []) out.push(etKey({ event: o.event, target: f }));
    for (const f of Object.keys(o.fields)) {
      if (!asWritten.items.some((x) => x.event === o.event && x.target === f)) {
        out.push(etKey({ event: o.event, target: f }));
      }
    }
  }
  return out;
}

/** Every source an item's value comes from, following carried references to the end. */
function valueSources(
  ops: readonly Op[],
  ev: Evaluation,
  ref: ItemRef,
  seen = new Set<string>(),
): SourceKey[] {
  const key = `${ref.event}/${ref.target}/${ref.k}`;
  if (seen.has(key)) return [];
  seen.add(key);
  const o = ops.find((x) => x.event === ref.event);
  if (o?.kind === "write") {
    const own = ref.target === "existence" ? [] : (o.fields[ref.target]?.sources ?? []);
    const evidence = Object.values(o.fields).flatMap((x) => x?.sources ?? []);
    return [...own, ...(o.valid !== undefined ? [...(o.validSources ?? evidence)] : [])];
  }
  if (o?.kind === "revoke") return [...(o.validSources ?? [])];
  const item = ev.items.find(
    (x) => x.event === ref.event && x.target === ref.target && x.k === ref.k,
  );
  return (item?.carried ?? []).flatMap((c) => valueSources(ops, ev, c, seen));
}

/** Business dates a surviving op said itself (explicit interval ends with their sources intact). */
function survivingDates(ops: readonly Op[], deleted: ReadonlySet<SourceKey>): Set<Point> {
  const out = new Set<Point>();
  for (const o of ops) {
    if (
      (o.kind !== "write" && o.kind !== "revoke") ||
      o.valid === undefined ||
      o.valid === "corrected_span"
    ) {
      continue;
    }
    const evidence =
      o.kind === "write" ? Object.values(o.fields).flatMap((x) => x?.sources ?? []) : [];
    const sources = o.validSources ?? evidence;
    if (sources.some((s) => deleted.has(s))) continue;
    if (o.valid.from.mode === "given") out.add(o.valid.from.value);
    if (o.valid.to.mode === "given") out.add(o.valid.to.value);
  }
  return out;
}

describe.each(both)("%s table", (_, schema, state) => {
  it("a deletion that removes nothing, at any point of the log, leaves the replay unchanged", () => {
    // 02-architecture §11 «不多删», with the deletion between operations: a deletion event that
    // changed nothing is no change for the operations after it.
    // Measured share of hits: 1 (every sample).
    const hits = new Hits(0.95);
    fc.assert(
      fc.property(
        scenario(state),
        fc.nat(),
        hits.track(({ ops }, at) => {
          const after = ops[at % ops.length]?.op ?? 0;
          const log = [
            ...ops,
            { kind: "deletion" as const, op: after + 5, id: "none", sources: ["S_UNUSED"] },
          ];
          hits.hit();
          expect(comparable(evaluateLog(schema, log).final)).toEqual(
            comparable(evaluateAsWritten(schema, ops)),
          );
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("the result does not depend on how the deleted set is listed", () => {
    // Not yet «顺序无关» itself (delete A, then B): that is a property of logs (log.prop.test.ts).
    // Measured share of hits: about 0.83 on both tables.
    const hits = new Hits(0.7);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops, a, b }) => {
          if (cites(ops, a) && cites(ops, b)) hits.hit();
          const ab = evaluate(schema, ops, [...a, ...b]);
          expect(comparable(evaluate(schema, ops, [...b, ...a]))).toEqual(comparable(ab));
          expect(comparable(evaluate(schema, ops, [...a, ...b, ...a]))).toEqual(comparable(ab));
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a field judged a no-op at write time stays a no-op under any deletion", () => {
    // 03-deletion «删除结果的定义», deviation one; 02-architecture §11 «无操作保持无操作».
    // Measured share of hits: about 0.67 (state) and 0.71 (event).
    const hits = new Hits(0.55);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, sameValue, 2)),
        hits.track(({ ops, a }) => {
          const noops = new Set(writeTimeNoops(ops, evaluateAsWritten(schema, ops)));
          if (noops.size > 0 && cites(ops, a)) hits.hit();
          const ev = evaluate(schema, ops, a);
          const revived = ev.items.filter((x) => noops.has(etKey(x)) && x.status !== "dropped");
          expect(revived).toEqual([]);
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a same-value write without evidence produces no item after any deletion", () => {
    // Measured share of hits: about 0.62 (state) and 0.66 (event).
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, sameValue, 2)),
        hits.track(({ ops, a }) => {
          const asWritten = evaluateAsWritten(schema, ops);
          const ev = evaluate(schema, ops, a);
          for (const o of ops) {
            if (o.kind !== "write") continue;
            for (const [f, input] of Object.entries(o.fields)) {
              if (input?.explicit) continue;
              if (asWritten.items.some((x) => x.event === o.event && x.target === f)) continue;
              if (cites(ops, a)) hits.hit();
              const items = ev.items.filter(
                (x) => x.event === o.event && x.target === f && x.status !== "dropped",
              );
              expect(items).toEqual([]);
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a deletion adds no pending items", () => {
    // 03-deletion «推论» «删除不增加未决事项»: every new pending item is an awaiting item converted
    // from a conflict item this deletion superseded, or the same write's pending item changed
    // kind (awaiting ↔ conflict), the original superseded by this deletion, a new item replacing
    // it one for one. Items an earlier deletion superseded need deletions interleaved with
    // operations (log.prop.test.ts). The evaluator gives statuses, not items, so "one for one" is
    // checked per (write, field or existence): a pending item now has a pending item of the same
    // write before, and there are no more of them than before.
    // Measured share of hits: about 0.37 (state) and 0.50 (event).
    const hits = new Hits(0.25);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, stale, 3)),
        hits.track(({ ops, a }) => {
          const before = new Map<string, string[]>();
          for (const x of evaluateAsWritten(schema, ops).items) {
            before.set(etKey(x), [...(before.get(etKey(x)) ?? []), x.status]);
          }
          const now = new Map<string, string[]>();
          for (const x of evaluate(schema, ops, a).items) {
            if (pending(x.status)) now.set(etKey(x), [...(now.get(etKey(x)) ?? []), x.status]);
          }
          if (now.size > 0 && cites(ops, a)) hits.hit();
          for (const [key, statuses] of now) {
            const was = (before.get(key) ?? []).filter(pending);
            for (const st of statuses) {
              const branch = was.includes(st)
                ? "not new"
                : st === "awaiting" && was.includes("candidate")
                  ? "conflict → awaiting"
                  : st === "candidate" && was.includes("awaiting")
                    ? "awaiting → conflict"
                    : "none";
              expect({ key, now: st, was, branch }).not.toMatchObject({ branch: "none" });
            }
            // One pending item per write and field and kind: a judgement carried by several
            // contribution items (a segment cut by 09 §5.7) is still one pending item.
            const kinds = new Set(statuses).size;
            expect({ key, kinds }).toEqual({ key, kinds: Math.min(kinds, new Set(was).size) });
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a deletion removes nothing that does not depend on the deleted sources", () => {
    // 02-architecture §11 «不多删»: a deleted set no op cites leaves the result unchanged.
    // Measured share of hits: 1 (every sample).
    const hits = new Hits(0.95);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops }) => {
          hits.hit();
          expect(comparable(evaluate(schema, ops, ["S_UNUSED"]))).toEqual(
            comparable(evaluate(schema, ops, [])),
          );
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("no value and no endpoint in the result derives from a deleted source", () => {
    // 02-architecture §11 «不漏删»: every value's sources (through carried references) are
    // intact, and every segment or gap endpoint is a date some surviving op said itself.
    // Measured share of hits: about 0.53 on both tables.
    const hits = new Hits(0.4);
    fc.assert(
      fc.property(
        scenario(state),
        hits.track(({ ops, a }) => {
          const deleted = new Set(a);
          const ev = evaluate(schema, ops, a);
          const dates = survivingDates(ops, deleted);
          if (cites(ops, a) && Object.values(ev.fields).some((x) => (x ?? []).length > 0)) {
            hits.hit();
          }
          for (const segs of Object.values(ev.fields)) {
            for (const seg of segs ?? []) {
              if (seg.by !== undefined) {
                const leaked = valueSources(ops, ev, seg.by).filter((s) => deleted.has(s));
                expect({ by: seg.by, leaked }).toEqual({ by: seg.by, leaked: [] });
              }
              for (const x of seg.valid) {
                for (const p of [x.from, x.to]) if (p !== null) expect(dates).toContain(p);
              }
            }
          }
          for (const g of ev.gaps)
            for (const p of [g.from, g.to]) if (p !== null) expect(dates).toContain(p);
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("what was in effect stays in effect: a deletion turns no effective item pending", () => {
    // 03-deletion «删除结果的定义», deviation two (corroborations included). The assertion fires
    // only on a violation; a hit is a sample in which the deletion removed some item and an item
    // wholly in effect at write time is still there.
    // Measured share of hits: about 0.76 (state) and 0.70 (event).
    const hits = new Hits(0.6);
    fc.assert(
      fc.property(
        mostly(scenario(state), withSteps(state, stale, 3)),
        hits.track(({ ops, a }) => {
          // Per (write, field) that was wholly in effect at write time; a corroboration split
          // into a corroborated part and a candidate part has a pending part that was never in
          // effect.
          const asWritten = evaluateAsWritten(schema, ops);
          const was = new Map<string, string[]>();
          for (const x of asWritten.items) {
            was.set(etKey(x), [...(was.get(etKey(x)) ?? []), x.status]);
          }
          const ev = evaluate(schema, ops, a);
          const present = new Set(
            ev.items.filter((x) => x.status !== "dropped").map((x) => etKey(x)),
          );
          const removedSome = asWritten.items.some((x) => !present.has(etKey(x)));
          for (const x of ev.items) {
            const before = was.get(etKey(x)) ?? [];
            if (before.length === 0 || !before.every(effective)) continue;
            if (removedSome && x.status !== "dropped") hits.hit();
            if (pending(x.status)) {
              expect({ item: etKey(x), now: x.status }).toEqual({
                item: etKey(x),
                now: before[0],
              });
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });

  it("a revert never falls back to the reverted value", () => {
    // 03-deletion «回掉的权威定义» step 3: "In no case does it fall back to the value of the reverted item
    // itself." Two checks, each a hit: a segment given by a revert's write-back item carries its
    // value from no write the revert lists; and a segment given by an item registered as reverted
    // lies outside its registrations. On an event table an item is registered as a whole and gives
    // no value at all: an item registered as reverted is a hit.
    // Measured share of hits: about 0.67 (state) and 0.75 (event).
    const hits = new Hits(0.5);
    fc.assert(
      fc.property(
        mostly(scenario(state), revertSkeleton(state)),
        hits.track(({ ops, a }) => {
          const ev = evaluate(schema, ops, a);
          const segs = Object.entries(ev.fields).flatMap(([f, xs]) =>
            (xs ?? []).map((seg) => ({ f, seg })),
          );
          for (const rv of ev.reverts) {
            if (rv.status !== "applied") continue;
            const listed = new Set(rv.record.map((x) => x.event));
            for (const { seg } of segs) {
              if (seg.by?.event !== rv.event) continue;
              hits.hit();
              const item = ev.items.find(
                (x) => x.event === rv.event && x.target === seg.by?.target && x.k === seg.by?.k,
              );
              const from = (item?.carried ?? []).map((x) => x.event).filter((e) => listed.has(e));
              expect({ revert: rv.event, carriedFromListed: from }).toEqual({
                revert: rv.event,
                carriedFromListed: [],
              });
            }
          }
          for (const r of ev.items) {
            if (r.registrations.length === 0) continue;
            if (!state) hits.hit();
            for (const { f, seg } of segs) {
              const by = seg.by;
              if (by === undefined || by.event !== r.event || by.target !== f || by.k !== r.k)
                continue;
              hits.hit();
              for (const reg of r.registrations) {
                // Where it is registered as reverted, the item gives no value.
                expect(isEmpty(intersect(seg.valid, reg.valid))).toBe(true);
              }
            }
          }
        }),
      ),
      { numRuns: RUNS },
    );
    hits.check();
  });
});

it("every segment lies outside the gaps after any deletion", () => {
  // Sanity check of the output shape on a state table.
  // Measured share of hits: about 0.60.
  const hits = new Hits(0.45);
  fc.assert(
    fc.property(
      scenario(true),
      hits.track(({ ops, a }) => {
        const ev = evaluate(STATE, ops, a);
        const segs = ev.fields["f2"] ?? [];
        if (ev.gaps.length > 0 && segs.length > 0) hits.hit();
        for (const seg of segs) {
          for (const x of seg.valid) expect(ev.gaps.some((g) => covers([g], x))).toBe(false);
        }
      }),
    ),
    { numRuns: RUNS },
  );
  hits.check();
});
