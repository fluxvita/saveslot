// `detail: "detailed"`: a field's literal result and level against a model (04-contract §10
// `detail`; 03-deletion «字段的来源级别»). Random requests on a timeless table: rows created, their
// value changed, or the same value written again with evidence (a corroboration, which counts
// while the value stands); each with evidence segments a user's or an agent's, naming the value
// or not, or with none (the request itself, `na`). The model keeps, per row, the evidence of the
// write giving the value and of each corroboration since, and works the result out on its own:
// any segment hit → hit with the highest level among the hits; else any miss → miss; else na.

import {
  createOpsContext,
  createTenant,
  query,
  schemaDraft,
  write,
} from "@fluxvita/saveslot-kernel";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const RUNS = propRuns(12);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"7".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;
// biome-ignore lint/suspicious/noExplicitAny: receipts and rows read loosely in a test
type Any = any;

const DOCUMENT = {
  slot: "food",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "meals",
      kind: "base",
      description: "a meal",
      time: { type: "none" },
      fields: [{ name: "name", type: "text", required: true, description: "what" }],
    },
  ],
};
const VALUES = ["lunch", "dinner", "brunch"] as const;

type Segment = { who: "user" | "agent"; names: boolean };
type Step =
  | { t: "create"; value: number; evidence: Segment[] }
  | { t: "change"; row: number; value: number; evidence: Segment[] }
  | { t: "again"; row: number; evidence: Segment[] };

const segment: fc.Arbitrary<Segment> = fc.record({
  who: fc.constantFrom("user" as const, "agent" as const),
  names: fc.boolean(),
});
const evidence = fc.array(segment, { maxLength: 3 });
const step: fc.Arbitrary<Step> = fc.oneof(
  fc.record({ t: fc.constant("create" as const), value: fc.nat(2), evidence }),
  fc.record({ t: fc.constant("change" as const), row: fc.nat(3), value: fc.nat(2), evidence }),
  fc.record({
    t: fc.constant("again" as const),
    row: fc.nat(3),
    evidence: fc.array(segment, { minLength: 1, maxLength: 3 }),
  }),
);
// Every sample starts with a row; a corroboration needs one.
const steps = fc
  .tuple(fc.nat(2), evidence, fc.array(step, { minLength: 1, maxLength: 8 }))
  .map(([value, ev, rest]): Step[] => [{ t: "create", value, evidence: ev }, ...rest]);

/** The model's result over the segments of a field's items (an item without evidence: `na`). */
type Result = {
  result: "hit" | "miss" | "na";
  level: "user_stated" | "agent_inferred" | null;
};
function modelOf(items: readonly (readonly Segment[])[]) {
  const results: Result[] = items.flatMap((ev): Result[] =>
    ev.length === 0
      ? [{ result: "na" as const, level: null }]
      : ev.map((x) => ({
          result: x.names ? ("hit" as const) : ("miss" as const),
          level: x.who === "user" ? ("user_stated" as const) : ("agent_inferred" as const),
        })),
  );
  const hits = results.filter((r) => r.result === "hit");
  if (hits.length > 0)
    return {
      literal: "hit",
      level: hits.some((h) => h.level === "user_stated") ? "user_stated" : "agent_inferred",
    };
  return { literal: results.some((r) => r.result === "miss") ? "miss" : "na" };
}

/**
 * Fixed samples, every run (counted among the runs): a hit, a miss, an `na`; and a corroboration
 * of a value changed away and back again, which still counts (01-objects «出处项»: "corroboration
 * proves this value, not that it did not change during that time"). Each reached by construction,
 * not by chance.
 */
const FIXED: [Step[]][] = [
  [[{ t: "create", value: 0, evidence: [{ who: "user", names: true }] }]],
  [[{ t: "create", value: 0, evidence: [{ who: "agent", names: false }] }]],
  [[{ t: "create", value: 0, evidence: [] }]],
  [
    [
      { t: "create", value: 0, evidence: [] },
      { t: "again", row: 0, evidence: [{ who: "agent", names: true }] },
      { t: "change", row: 0, value: 1, evidence: [] },
      { t: "change", row: 0, value: 0, evidence: [] },
    ],
  ],
];

let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: null,
    visibility: { kind: "all" } as never,
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T${String(3 + Math.floor(++minute / 60)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });

beforeAll(async () => {
  s = await openReusable("saveslot-read-detail-prop-");
}, 120_000);
afterAll(async () => {
  await s?.close();
}, 120_000);

describe("detail: detailed, a field's literal result and level, against a model", () => {
  it("each row's result is the model's, over the value's write and its corroborations", async () => {
    const seen = { hit: 0, miss: 0, na: 0, corroborated: 0 };
    await fc.assert(
      fc.asyncProperty(steps, async (sample) => {
        await s.reset();
        minute = 0;
        await createTenant(s.store, ctx());
        await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
        // The model: each row's value, version, and the evidence of the items its value rests on.
        // `items`: the evidence of the write giving the value now; `corroborations`: every
        // corroboration with its value. A corroboration counts while the value is its value again
        // (not reverted): the rule `delta/sources.ts` gives the origin items, as the marks of
        // premises take them; the spec (01-objects «出处项») says "the corroboration items that
        // still count" and no more.
        const rows: {
          row: string;
          ver: string;
          value: string;
          items: Segment[][];
          corroborations: { value: string; evidence: Segment[] }[];
        }[] = [];
        let requests = 0;
        const send = async (value: string, ev: Segment[], target?: (typeof rows)[number]) => {
          const texts = ev.map((x) => ({
            kind: x.who === "user" ? "user_message" : "agent_note",
            // A text naming the value, or naming none of them.
            text: x.names ? `it was ${value} today` : "nothing said of it",
          }));
          // Each request a key of its own: two steps may send the same body, which the service would
          // answer as a repeat with the first receipt, writing nothing.
          const r = (await write(s.store, ctx(), {
            sv: 1,
            idempotency_key: `step-${++requests}`,
            ...(texts.length > 0 ? { evidence: texts } : {}),
            ops: [
              {
                intent: target === undefined ? "insert" : "update",
                table: "meals",
                ...(target !== undefined ? { row: target.row, ver: target.ver } : {}),
                set: { name: value },
                ...(texts.length > 0
                  ? { evidence_by_field: { name: texts.map((_, i) => i) } }
                  : {}),
              },
            ],
          })) as Any;
          expect({ replayed: r.replayed === true }).toEqual({ replayed: false });
          return r.ops[0] as Any;
        };
        for (const st of sample) {
          if (st.t === "create") {
            const value = VALUES[st.value] as string;
            const o = await send(value, st.evidence);
            rows.push({
              row: o.target.row,
              ver: o.ver,
              value,
              items: [st.evidence],
              corroborations: [],
            });
            continue;
          }
          const target = rows[st.row % rows.length] as (typeof rows)[number];
          if (st.t === "change") {
            const value = VALUES[st.value] as string;
            // The same value without evidence changes nothing; with it, a corroboration.
            if (value === target.value) {
              if (st.evidence.length === 0) continue;
              const o = await send(value, st.evidence, target);
              target.ver = o.ver ?? target.ver;
              target.corroborations.push({ value, evidence: st.evidence });
              seen.corroborated++;
              continue;
            }
            const o = await send(value, st.evidence, target);
            Object.assign(target, { ver: o.ver, value, items: [st.evidence] });
            continue;
          }
          const o = await send(target.value, st.evidence, target);
          target.ver = o.ver ?? target.ver;
          target.corroborations.push({ value: target.value, evidence: st.evidence });
          seen.corroborated++;
        }
        const read = (await query(s.store, ctx(), { table: "meals", detail: "detailed" })) as Any;
        for (const m of rows) {
          const r = read.rows.find((x: Any) => x.row === m.row);
          const items = [
            ...m.items,
            ...m.corroborations.filter((c) => c.value === m.value).map((c) => c.evidence),
          ];
          const want = modelOf(items);
          seen[want.literal as "hit" | "miss" | "na"]++;
          const { field_id: _, ...got } = r.detail.fields.name;
          expect({ row: m.row, items, got }).toEqual({ row: m.row, items, got: want });
        }
      }),
      { numRuns: RUNS, examples: FIXED, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
    // The generator reaches each result and corroborations at all.
    for (const k of ["hit", "miss", "na", "corroborated"] as const)
      expect({ k, reached: seen[k] > 0 }).toEqual({ k, reached: true });
  }, 600_000);
});
