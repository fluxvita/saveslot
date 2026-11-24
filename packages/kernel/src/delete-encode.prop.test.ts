// The deletion events' blocks (09 §5.9) encoded by delete/encode.ts round-trip through the strict
// parse and `decodeDeletionRecords` (write/record.ts): every generated confirmation and
// cancellation passes `parseEvent`, and decodes into the record it was encoded from. At the kernel
// root: the two modules may not import each other.

import { type FieldValue, parseEvent } from "@fluxvita/saveslot-contract-core";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type CancellationContent,
  type DeletionContent,
  encodeCancellation,
  encodeDeletion,
} from "./delete/encode.ts";
import type { ItemRef, Restatement, ResultRow, ResultStretch } from "./judge/index.ts";
import type { Interval } from "./time/index.ts";
import { decodeDeletionRecords, type RowContext, type StoredEvent } from "./write/record.ts";

const USER = `u_${"1".repeat(26)}`;
const SLOT = `sl_${"2".repeat(16)}`;
const HASH = "a".repeat(64);
const ITEM = `pi_${"3".repeat(16)}`;
const CTX = {
  now: "2026-11-10T05:02:11.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
};
const SELF = 90;

const ctxOf = (isState: boolean) =>
  ({ shape: { kind: isState ? "state" : "event" }, granularity: "date" }) as unknown as RowContext;

const day = (n: number) => `2026-11-${String(n).padStart(2, "0")}`;
/** An interval with a start (a field item's, a stretch's). */
const closedStart = fc
  .tuple(fc.integer({ min: 1, max: 20 }), fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }))
  .map(([a, len]): Interval => ({ from: day(a), to: len === null ? null : day(a + len) }) as never);
/** Any interval, open at either end (an existence item's, a gap). */
const open = fc
  .tuple(
    fc.option(fc.integer({ min: 1, max: 20 }), { nil: null }),
    fc.option(fc.integer({ min: 1, max: 9 }), { nil: null }),
  )
  .map(
    ([a, len]): Interval =>
      ({
        from: a === null ? null : day(a),
        to: len === null ? null : day((a ?? 0) + len),
      }) as never,
  );

const field = fc.constantFrom("f1", "f2", "f3");
const fieldRef = fc
  .record({
    event: fc.integer({ min: 1, max: 60 }),
    target: field,
    k: fc.integer({ min: 0, max: 2 }),
  })
  .map((r) => r as ItemRef);
const existenceRef = fc
  .record({ event: fc.integer({ min: 1, max: 60 }), k: fc.integer({ min: 0, max: 2 }) })
  .map((r): ItemRef => ({ event: r.event, target: "existence", k: r.k }));
const anyRef = fc.oneof(fieldRef, existenceRef);
const value: fc.Arbitrary<FieldValue> = fc.oneof(
  fc.constantFrom("a", "b", "45"),
  fc.boolean(),
  fc.constantFrom({ value: "45", unit: "CNY" }, { value: "5000", unit: "CNY" }),
) as never;
const schemaConst = fc.record({ sv: fc.integer({ min: 1, max: 3 }), field });
const uniq = (xs: readonly ItemRef[]) => {
  const seen = new Set<string>();
  return xs.filter((x) => {
    const k = `${x.event}/${x.target}/${x.k}`;
    if (seen.has(k)) return false;
    seen.add(k);
    return true;
  });
};

/** A stretch: a value carried or a constant, or `null` (none, or an explicit clearing). */
const stretch = (isState: boolean, f: string, j: number): fc.Arbitrary<ResultStretch> =>
  fc
    .record({
      value: fc.option(value, { nil: null }),
      carried: fc.array(fieldRef, { maxLength: 2 }),
      constant: fc.option(schemaConst, { nil: undefined }),
      valid: closedStart,
      deps: fc.array(anyRef, { maxLength: 2 }),
    })
    .map((x) => {
      const carried = uniq(x.carried);
      // A value has its sources; a constant only with a value.
      const constant = x.value !== null ? x.constant : undefined;
      if (x.value !== null && carried.length === 0 && constant === undefined) {
        carried.push({ event: 1, target: f as never, k: 0 });
      }
      return {
        field: f as never,
        j,
        value: x.value,
        carried,
        ...(constant !== undefined ? { schemaConst: constant as never } : {}),
        ...(isState ? { valid: [x.valid] } : {}),
        deps: isState ? uniq([...carried, ...x.deps]) : [],
      };
    });

const row = (isState: boolean, n: number): fc.Arbitrary<ResultRow> =>
  fc
    .record({
      outcome: fc.constantFrom(
        "deleted",
        "kept_fields_cleared",
        "fields_reverted",
        "resegmented",
        "sources_changed",
      ),
      counts: fc.record({
        f1: fc.integer({ min: 0, max: isState ? 2 : 1 }),
        f2: fc.integer({ min: 0, max: isState ? 2 : 1 }),
      }),
      gaps: fc.array(open, { maxLength: 2 }),
      gapDeps: fc.array(anyRef, { maxLength: 2 }),
    })
    .chain((x) =>
      fc
        .tuple(
          ...Object.entries(x.counts).flatMap(([f, c]) =>
            Array.from({ length: c }, (_, j) => stretch(isState, f, j)),
          ),
        )
        .map((stretches) => ({
          table: "t1",
          id: isState ? `e_${String(n).repeat(26)}` : `r_${String(n).repeat(26)}`,
          outcome: x.outcome,
          stretches,
          ...(isState ? { gaps: { gaps: x.gaps, deps: uniq(x.gapDeps) } } : {}),
        })),
    );

const restatement = (isState: boolean): fc.Arbitrary<Restatement> =>
  fc
    .record({
      item: anyRef,
      status: fc.constantFrom("applied", "corroborated", "candidate", "awaiting", "dropped"),
      valid: fc.option(fc.tuple(closedStart, open), { nil: undefined }),
      deps: fc.array(anyRef, { maxLength: 2 }),
      content: fc.constantFrom("none", "value", "no_value", "uncovered"),
      value,
      carried: fc.array(fieldRef, { maxLength: 2 }),
      constant: fc.option(schemaConst, { nil: undefined }),
      restored: fc.boolean(),
    })
    .map((x) => {
      const onExistence = x.item.target === "existence";
      // An existence item is never corroborated; a dropped one has no interval and no value.
      const status = onExistence && x.status === "corroborated" ? "applied" : x.status;
      const dropped = status === "dropped";
      // A field item's interval has a start; an existence item's may be open at either end.
      const valid =
        !isState || dropped || x.valid === undefined
          ? undefined
          : onExistence
            ? x.valid[1]
            : x.valid[0];
      const kind = onExistence || dropped ? "none" : x.content;
      const carried = kind === "value" ? uniq(x.carried) : [];
      const constant = kind === "value" ? x.constant : undefined;
      if (kind === "value" && carried.length === 0 && constant === undefined) {
        carried.push({ event: 1, target: "f1" as never, k: 0 });
      }
      const deps = uniq([...carried, ...x.deps]);
      return {
        item: x.item,
        status,
        ...(valid !== undefined ? { valid: [valid as Interval] } : {}),
        deps,
        ...(kind === "value"
          ? { content: { kind: "value", value: x.value } }
          : kind === "no_value"
            ? { content: { kind: "no_value" } }
            : kind === "uncovered"
              ? { content: { kind: "uncovered" } }
              : {}),
        ...(carried.length > 0 ? { carried } : {}),
        ...(constant !== undefined ? { schemaConst: constant as never } : {}),
        ...(onExistence && x.restored ? { restored: true as const } : {}),
      } as Restatement;
    });

const recreated = fc.array(
  fc.record({ event: fc.integer({ min: 1, max: 60 }), created: fc.boolean() }),
  { maxLength: 2 },
);
const replayed = fc.boolean().chain((isState) =>
  fc.record({
    isState: fc.constant(isState),
    results: fc
      .integer({ min: 0, max: 3 })
      .chain((n) => fc.tuple(...Array.from({ length: n }, (_, k) => row(isState, k + 1)))),
    restated: fc.array(restatement(isState), { maxLength: 4 }),
    recreated,
  }),
);

function stored(seq: number, type: string, blocks: Record<string, unknown>) {
  const header = { v: 1, seq, at: CTX.now, prev_hash: HASH, actor: USER, slot: SLOT, type };
  return { header, blocks, event: { header: { type, seq }, blocks } as unknown as StoredEvent };
}

describe("deletion event blocks round-trip (09 §5.9)", () => {
  it("a deletion.confirmed parses and decodes into what it was encoded from", () => {
    fc.assert(
      fc.property(
        replayed,
        fc.uniqueArray(fc.integer({ min: 1, max: 60 }), { minLength: 1, maxLength: 3 }),
        fc.uniqueArray(fc.constantFrom(`pi_${"4".repeat(16)}`, `pi_${"5".repeat(16)}`)),
        fc.constantFrom("request", "restored_unconfirmed", "restored_pending", "restored_executed"),
        (r, sources, superseded, origin) => {
          const positions = [
            ...sources.map((s) => ({ seq: s, path: "text" })),
            { seq: SELF, path: "summary" },
          ];
          const content: DeletionContent = {
            id: ITEM,
            sources,
            dueAt: "2026-11-11T05:02:11.000Z",
            origin,
            positions,
            summaryHash: HASH,
            results: r.results,
            restated: r.restated,
            recreated: r.recreated,
            superseded,
          };
          const e = stored(SELF, "deletion.confirmed", { ctx: CTX, ...encodeDeletion(content) });
          expect(parseEvent(e.header, e.blocks as never)).toEqual({
            ok: true,
            type: "deletion.confirmed",
          });
          const [d] = decodeDeletionRecords(ctxOf(r.isState), [e.event]);
          expect(d).toEqual({
            kind: "deletion",
            event: SELF,
            op: SELF,
            id: ITEM,
            sources,
            dueAt: content.dueAt,
            origin,
            positions,
            results: r.results,
            restated: r.restated,
            recreated: r.recreated,
            superseded,
          });
        },
      ),
    );
  });

  it("a deletion.cancelled parses and decodes into what it was encoded from", () => {
    fc.assert(
      fc.property(
        replayed,
        fc.uniqueArray(fc.constantFrom(`pi_${"4".repeat(16)}`, `pi_${"5".repeat(16)}`)),
        fc.array(fc.record({ item: fc.constant(`pi_${"6".repeat(16)}`), byEvent: fc.nat(50) })),
        fc.array(
          fc.record({
            event: fc.integer({ min: 1, max: 60 }),
            items: fc.array(anyRef, { minLength: 1, maxLength: 3 }),
            byEvent: fc.integer({ min: 1, max: 60 }),
          }),
          { maxLength: 2 },
        ),
        fc.constantFrom("request", "restore_cancel"),
        (r, restoredItems, kept, keptEffective, origin) => {
          const content: CancellationContent = {
            id: ITEM,
            origin,
            results: r.results,
            restated: r.restated,
            recreated: r.recreated,
            restoredItems,
            keptSuperseded: kept.map((k) => ({ item: k.item, byEvent: k.byEvent + 1 })),
            keptEffective,
          };
          const e = stored(SELF, "deletion.cancelled", {
            ctx: CTX,
            ...encodeCancellation(content),
          });
          expect(parseEvent(e.header, e.blocks as never)).toEqual({
            ok: true,
            type: "deletion.cancelled",
          });
          const [c] = decodeDeletionRecords(ctxOf(r.isState), [e.event]);
          expect(c).toEqual({
            kind: "cancellation",
            event: SELF,
            op: SELF,
            id: ITEM,
            origin,
            results: r.results,
            restated: r.restated,
            recreated: r.recreated,
            restoredItems,
            keptSuperseded: content.keptSuperseded,
            keptEffective: keptEffective.map((x) => ({
              event: x.event,
              targets: [...new Set(x.items.map((i) => i.target))].sort(),
              byEvent: x.byEvent,
            })),
          });
        },
      ),
    );
  });

  it("a field's stretches listed are numbered from 0 in their order, whatever judge numbered them", () => {
    const content: DeletionContent = {
      id: ITEM,
      sources: [1],
      dueAt: "2026-11-11T05:02:11.000Z",
      origin: "request",
      positions: [{ seq: SELF, path: "summary" }],
      summaryHash: HASH,
      results: [
        {
          table: "t1",
          id: `e_${"1".repeat(26)}`,
          outcome: "resegmented",
          stretches: [
            {
              field: "f2" as never,
              j: 3,
              value: "b",
              carried: [{ event: 7, target: "f2" as never, k: 0 }],
              valid: [{ from: day(5), to: null } as Interval],
              deps: [{ event: 7, target: "f2" as never, k: 0 }],
            },
            {
              field: "f2" as never,
              j: 1,
              value: "a",
              carried: [{ event: 6, target: "f2" as never, k: 0 }],
              valid: [{ from: day(1), to: day(3) } as Interval],
              deps: [{ event: 6, target: "f2" as never, k: 0 }],
            },
          ],
          gaps: { gaps: [], deps: [] },
        },
      ],
      restated: [],
      recreated: [],
      superseded: [],
    };
    const blocks = encodeDeletion(content);
    expect(Object.keys(blocks).filter((p) => p.includes("/fields/"))).toEqual([
      "results/0/fields/f2/0",
      "results/0/fields/f2/1",
    ]);
    expect((blocks["results/0/fields/f2/0"] as { value: string }).value).toBe("a");
    const e = stored(SELF, "deletion.confirmed", { ctx: CTX, ...blocks });
    expect(parseEvent(e.header, e.blocks as never)).toEqual({
      ok: true,
      type: "deletion.confirmed",
    });
  });

  it("a carried item's new value names what it carries in deps, though judge gave none (an event table)", () => {
    const blocks = encodeDeletion({
      id: ITEM,
      sources: [1],
      dueAt: "2026-11-11T05:02:11.000Z",
      origin: "request",
      positions: [{ seq: SELF, path: "summary" }],
      summaryHash: HASH,
      results: [],
      restated: [
        {
          item: { event: 44, target: "f2" as never, k: 0 },
          status: "applied",
          deps: [],
          content: { kind: "value", value: "1" },
          carried: [{ event: 11, target: "f2" as never, k: 0 }],
        },
      ],
      recreated: [],
      superseded: [],
    });
    expect(blocks["restated/0"]).toMatchObject({ deps: [{ event: 11, field: "f2", k: 0 }] });
    const e = stored(SELF, "deletion.confirmed", { ctx: CTX, ...blocks });
    expect(parseEvent(e.header, e.blocks as never)).toEqual({
      ok: true,
      type: "deletion.confirmed",
    });
  });
});
