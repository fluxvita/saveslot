// Property tests on the reference evaluator alone (02-architecture §11, «删除的性质»): no kernel.

import type { BizPoint, FieldId } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { evaluate, evaluateAsWritten } from "./evaluate.ts";
import { covers, intersect, isEmpty, type Point } from "./interval.ts";
import type {
  Evaluation,
  ItemRef,
  Op,
  SourceKey,
  TableSchema,
  ToParam,
  ValidParam,
  WriteOp,
} from "./model.ts";

const STATE: TableSchema = { kind: "state", required: ["f2"] };
const EVENT: TableSchema = { kind: "event", required: ["f2"] };
const DAYS = ["11-01", "11-03", "11-05", "11-07", "11-09", "11-11"].map(
  (x) => `2026-${x}` as BizPoint,
);
const SOURCES = ["S1", "S2", "S3", "S4", "S5", "S6"];

/** One generated step; turned into an op once its operation number is known. */
type Step =
  | {
      t: "write";
      f: FieldId;
      v: string;
      src: string[];
      from: number;
      to: number | "open" | "next";
      lag: number;
      explicit: boolean;
      ack: boolean;
    }
  /**
   * Resend an earlier write's value for its field (a whole-row resend or a restatement): same
   * value, new evidence, with or without `evidence_by_field`, marked `noop` or not.
   */
  | {
      t: "resend";
      back: number;
      src: string;
      explicit: boolean;
      mark: boolean;
      to: number | "same";
    }
  | { t: "revoke"; from: number; to: number; src: string; lag: number }
  | { t: "undo"; back: number; later: boolean; ack: boolean };

const step: fc.Arbitrary<Step> = fc.oneof(
  {
    weight: 6,
    arbitrary: fc.record({
      t: fc.constant("write" as const),
      f: fc.constantFrom<FieldId>("f2", "f2", "f3"),
      v: fc.constantFrom("1", "2", "3"),
      src: fc.subarray(SOURCES, { minLength: 1, maxLength: 2 }),
      from: fc.nat({ max: DAYS.length - 2 }),
      to: fc.oneof(
        fc.constantFrom<"open" | "next">("open", "next"),
        fc.nat({ max: DAYS.length - 1 }),
      ),
      lag: fc.constantFrom(0, 0, 0, 1, 3),
      explicit: fc.boolean(),
      ack: fc.constantFrom(true, true, false),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("resend" as const),
      back: fc.nat({ max: 3 }),
      src: fc.constantFrom(...SOURCES),
      explicit: fc.boolean(),
      mark: fc.boolean(),
      to: fc.oneof(fc.constant("same" as const), fc.nat({ max: DAYS.length - 1 })),
    }),
  },
  {
    weight: 1,
    arbitrary: fc.record({
      t: fc.constant("revoke" as const),
      from: fc.nat({ max: DAYS.length - 2 }),
      to: fc.nat({ max: DAYS.length - 1 }),
      src: fc.constantFrom(...SOURCES),
      lag: fc.nat({ max: 2 }),
    }),
  },
  {
    weight: 3,
    arbitrary: fc.record({
      t: fc.constant("undo" as const),
      back: fc.nat({ max: 3 }),
      later: fc.constantFrom(false, false, true),
      ack: fc.constantFrom(true, true, false),
    }),
  },
);

function toOps(steps: Step[], state: boolean): Op[] {
  const ops: Op[] = [];
  const writes: WriteOp[] = [];
  steps.forEach((s, i) => {
    const op = 10 * (i + 1);
    const event = op + 1;
    const first = i === 0;
    const seen = Math.max(0, op - 10 * (1 + (s.t === "write" || s.t === "revoke" ? s.lag : 0)));
    if (s.t === "write" || (first && s.t !== "undo")) {
      const w = s.t === "write" ? s : undefined;
      const from = DAYS[w?.from ?? 0] ?? DAYS[0];
      const end = w ? (typeof w.to === "number" ? Math.max(w.to, w.from + 1) : w.to) : "open";
      const to: ToParam =
        end === "open"
          ? { mode: "open" }
          : end === "next"
            ? { mode: "next_change" }
            : { mode: "given", value: DAYS[end] ?? "2026-12-01" };
      const write: WriteOp = {
        kind: "write",
        op,
        event,
        seen,
        ...(state
          ? {
              valid: {
                from: { mode: "given", value: first ? "2026-10-01" : (from as BizPoint) },
                to: first ? { mode: "open" } : to,
              },
            }
          : {}),
        fields: first
          ? { f2: { value: w?.v ?? "1", sources: w?.src ?? ["S1"] } }
          : {
              [w?.f ?? "f2"]: {
                value: w?.v ?? "1",
                sources: w?.src ?? ["S1"],
                explicit: w?.explicit ?? false,
              },
            },
        ...((w?.ack ?? true) ? { acknowledge: ["overwrite"] as const } : {}),
      };
      ops.push(write);
      writes.push(write);
    } else if (s.t === "resend") {
      const prev = writes[writes.length - 1 - s.back];
      if (prev === undefined) return;
      const [f, input] = Object.entries(prev.fields)[0] ?? [];
      if (f === undefined || input === undefined) return;
      const fid = f as FieldId;
      let valid: ValidParam | undefined = prev.valid;
      if (state && s.to !== "same" && prev.valid !== undefined && prev.valid !== "corrected_span") {
        const pf = prev.valid.from.mode === "given" ? prev.valid.from.value : undefined;
        const end = DAYS[s.to];
        if (pf !== undefined && end !== undefined && end > pf) {
          valid = { from: prev.valid.from, to: { mode: "given", value: end } };
        }
      }
      const write: WriteOp = {
        kind: "write",
        op,
        event,
        seen: op - 10,
        ...(valid !== undefined ? { valid } : {}),
        // A field marked no-op carries no value (09 §5.7 `ops/<i>/noop`).
        fields: s.mark
          ? {}
          : { [fid]: { value: input.value, sources: [s.src], explicit: s.explicit } },
        ...(s.mark ? { noop: [fid] } : {}),
        acknowledge: ["overwrite"],
      };
      ops.push(write);
      writes.push(write);
    } else if (s.t === "revoke") {
      if (!state) return;
      const from = DAYS[s.from] ?? DAYS[0];
      const to = DAYS[Math.max(s.to, s.from + 1)] ?? "2026-12-01";
      if (from === undefined) return;
      ops.push({
        kind: "revoke",
        op,
        event,
        seen,
        valid: {
          from: { mode: "given", value: from },
          to: { mode: "given", value: to as BizPoint },
        },
        validSources: [s.src],
      });
    } else if (s.t === "undo") {
      const target = writes[writes.length - 1 - s.back]?.op;
      if (target === undefined || target === 10) return; // never the first creation
      ops.push({
        kind: "undo",
        op,
        event,
        target,
        includeLater: s.later,
        ...(s.ack ? { seen: op - 10, acknowledge: ["overwrite"] as const } : {}),
      });
    }
  });
  return ops;
}

const scenario = (state: boolean) =>
  fc.record({
    ops: fc.array(step, { minLength: 2, maxLength: 9 }).map((s) => toOps(s, state)),
    a: fc.subarray(SOURCES, { maxLength: 2 }),
    b: fc.subarray(SOURCES, { maxLength: 2 }),
  });

const both = [
  ["state", STATE, true],
  ["event", EVENT, false],
] as const;

const RUNS = 4000;
const pending = (s: string): boolean => s === "candidate" || s === "awaiting";
const effective = (s: string) => s === "applied" || s === "corroborated";
const etKey = (x: { event: number; target: string }) => `${x.event}/${x.target}`;

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
  it("deleting nothing is a plain replay", () => {
    fc.assert(
      fc.property(scenario(state), ({ ops }) => {
        expect(comparable(evaluate(schema, ops, []))).toEqual(
          comparable(evaluateAsWritten(schema, ops)),
        );
      }),
      { numRuns: 300 },
    );
  });

  it("the result does not depend on how the deleted set is listed", () => {
    // Not yet «顺序无关» itself (delete A, then B): successive deletions interleaved with
    // operations are not modelled; that property comes with deletion cancellation (D.5).
    fc.assert(
      fc.property(scenario(state), ({ ops, a, b }) => {
        const ab = evaluate(schema, ops, [...a, ...b]);
        expect(comparable(evaluate(schema, ops, [...b, ...a]))).toEqual(comparable(ab));
        expect(comparable(evaluate(schema, ops, [...a, ...b, ...a]))).toEqual(comparable(ab));
      }),
      { numRuns: 200 },
    );
  });

  it("a field judged a no-op at write time stays a no-op under any deletion", () => {
    // 03-deletion «删除结果的定义», deviation one; 02-architecture §11 «无操作保持无操作».
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        const noops = new Set(writeTimeNoops(ops, evaluateAsWritten(schema, ops)));
        const ev = evaluate(schema, ops, a);
        const revived = ev.items.filter((x) => noops.has(etKey(x)) && x.status !== "dropped");
        expect(revived).toEqual([]);
      }),
      { numRuns: RUNS },
    );
  });

  it("a same-value write without evidence produces no item after any deletion", () => {
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        const asWritten = evaluateAsWritten(schema, ops);
        const ev = evaluate(schema, ops, a);
        for (const o of ops) {
          if (o.kind !== "write") continue;
          for (const [f, input] of Object.entries(o.fields)) {
            if (input?.explicit) continue;
            if (asWritten.items.some((x) => x.event === o.event && x.target === f)) continue;
            const items = ev.items.filter(
              (x) => x.event === o.event && x.target === f && x.status !== "dropped",
            );
            expect(items).toEqual([]);
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a deletion adds no pending items", () => {
    // 03-deletion «推论» «删除不增加未决事项»: every new pending item is (1) an awaiting item
    // converted from a conflict item this deletion superseded, (2) an item an earlier deletion
    // superseded and this one restores, or (3) the same write's pending item changed kind
    // (awaiting ↔ conflict), the original superseded by this deletion. Branch (2) needs deletions
    // interleaved with operations and does not arise here. The evaluator gives statuses, not
    // items, so "one for one" is checked per (write, field or existence): a pending item now has
    // a pending item of the same write before, and there are no more of them than before.
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        const before = new Map<string, string[]>();
        for (const x of evaluateAsWritten(schema, ops).items) {
          before.set(etKey(x), [...(before.get(etKey(x)) ?? []), x.status]);
        }
        const now = new Map<string, string[]>();
        for (const x of evaluate(schema, ops, a).items) {
          if (pending(x.status)) now.set(etKey(x), [...(now.get(etKey(x)) ?? []), x.status]);
        }
        for (const [key, statuses] of now) {
          const was = (before.get(key) ?? []).filter(pending);
          for (const st of statuses) {
            const branch = was.includes(st)
              ? "not new"
              : st === "awaiting" && was.includes("candidate")
                ? "(1) conflict → awaiting"
                : st === "candidate" && was.includes("awaiting")
                  ? "(3) awaiting → conflict"
                  : "none";
            expect({ key, now: st, was, branch }).not.toMatchObject({ branch: "none" });
          }
          expect({ key, count: statuses.length }).toEqual({
            key,
            count: Math.min(statuses.length, was.length),
          });
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a deletion removes nothing that does not depend on the deleted sources", () => {
    // 02-architecture §11 «不多删»: a deleted set no op cites leaves the result unchanged.
    fc.assert(
      fc.property(scenario(state), ({ ops }) => {
        const unused = ["S_UNUSED"];
        expect(comparable(evaluate(schema, ops, unused))).toEqual(
          comparable(evaluate(schema, ops, [])),
        );
      }),
      { numRuns: 200 },
    );
  });

  it("no value and no endpoint in the result derives from a deleted source", () => {
    // 02-architecture §11 «不漏删»: every value's sources (through carried references) are
    // intact, and every segment or gap endpoint is a date some surviving op said itself.
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        const deleted = new Set(a);
        const ev = evaluate(schema, ops, a);
        const dates = survivingDates(ops, deleted);
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
      { numRuns: RUNS },
    );
  });

  it("what was in effect stays in effect: a deletion turns no effective item pending", () => {
    // 03-deletion «删除结果的定义», deviation two (corroborations included).
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        // Per (write, field) that was wholly in effect at write time; a corroboration split into a
        // corroborated part and a candidate part has a pending part that was never in effect.
        const was = new Map<string, string[]>();
        for (const x of evaluateAsWritten(schema, ops).items) {
          was.set(etKey(x), [...(was.get(etKey(x)) ?? []), x.status]);
        }
        for (const x of evaluate(schema, ops, a).items) {
          const before = was.get(etKey(x)) ?? [];
          if (pending(x.status) && before.length > 0 && before.every(effective)) {
            expect({ item: etKey(x), now: x.status }).toEqual({ item: etKey(x), now: before[0] });
          }
        }
      }),
      { numRuns: RUNS },
    );
  });

  it("a revert never falls back to the reverted value", () => {
    fc.assert(
      fc.property(scenario(state), ({ ops, a }) => {
        const ev = evaluate(schema, ops, a);
        for (const r of ev.items) {
          if (r.registrations.length === 0) continue;
          for (const [f, segs] of Object.entries(ev.fields)) {
            for (const seg of segs ?? []) {
              const by = seg.by;
              if (by === undefined || by.event !== r.event || by.target !== f || by.k !== r.k)
                continue;
              for (const reg of r.registrations) {
                // Where it is registered as reverted, the item gives no value.
                expect(isEmpty(intersect(seg.valid, reg.valid))).toBe(true);
              }
            }
          }
        }
      }),
      { numRuns: 300 },
    );
  });
});

it("an empty deletion keeps every segment inside the state's own intervals", () => {
  // Sanity check of the output shape: every state-table segment lies outside the gaps.
  fc.assert(
    fc.property(scenario(true), ({ ops, a }) => {
      const ev = evaluate(STATE, ops, a);
      for (const seg of ev.fields["f2"] ?? []) {
        for (const x of seg.valid) expect(ev.gaps.some((g) => covers([g], x))).toBe(false);
      }
    }),
    { numRuns: 200 },
  );
});
