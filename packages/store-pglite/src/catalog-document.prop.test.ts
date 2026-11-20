// The catalog's schema document, submitted as it is, changes nothing (04-contract §10 `catalog`,
// `schema_draft`): after any history of automatic changes (descriptions, aliases, loosened
// constraints, added tables), each made by changing the catalog's document and submitting it.
// A slot with a derived table, whose rule text comes from the draft that wrote it.

import {
  catalog,
  createOpsContext,
  createTenant,
  loadRsql,
  schemaDraft,
} from "@fluxvita/saveslot-kernel";
import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { afterAll, beforeAll, expect, it } from "vitest";
import { openReusable, type ReusableStore } from "./testing/reusable-store.fixture.ts";

const T = 600_000;
const RUNS = propRuns(15);
const SEED = process.env["PROP_SEED"] === undefined ? undefined : Number(process.env["PROP_SEED"]);
const TENANT = `tn_${"8".repeat(26)}`;
const USER = `u_${"1".repeat(26)}`;

const DOCUMENT = {
  slot: "ledger",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
        {
          name: "amount",
          type: "quantity",
          unit: "CNY",
          required: true,
          min: 0,
          description: "how much",
        },
        { name: "rate", type: "decimal", scale: 2, description: "a rate" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "totals",
      kind: "derived",
      description: "spent by kind",
      rule: {
        sql: "SELECT category AS k, sum(amount) AS spent FROM expenses GROUP BY category",
        time_dependency: "none",
      },
      fields: [
        { name: "k", description: "the kind" },
        { name: "spent", description: "how much" },
      ],
    },
  ],
};

// biome-ignore lint/suspicious/noExplicitAny: documents are edited as JSON
type Doc = any;

/** One automatic change, made on the expenses table of a document. */
const step = fc.oneof(
  fc.record({ kind: fc.constant("description" as const), n: fc.nat(99) }),
  fc.record({ kind: fc.constant("field_description" as const), i: fc.nat(4), n: fc.nat(99) }),
  fc.record({ kind: fc.constant("alias" as const), n: fc.nat(99) }),
  fc.record({ kind: fc.constant("enum_value" as const), n: fc.nat(99) }),
  fc.record({ kind: fc.constant("scale" as const) }),
  fc.record({ kind: fc.constant("optional" as const) }),
  fc.record({ kind: fc.constant("add_table" as const), n: fc.nat(99) }),
);
type Step = typeof step extends fc.Arbitrary<infer S> ? S : never;

function apply(doc: Doc, s: Step, k: number): void {
  const t = (doc.tables as Doc[]).find((x) => x.name === "expenses");
  switch (s.kind) {
    case "description":
      t.description = `expenses, ${k}.${s.n}`;
      return;
    case "field_description":
      t.fields[s.i].description = `field ${k}.${s.n}`;
      return;
    case "alias":
      t.aliases = [...(t.aliases ?? []), `spend${k}x${s.n}`];
      return;
    case "enum_value":
      t.fields[1].values = [...t.fields[1].values, `kind${k}x${s.n}`];
      return;
    case "scale":
      t.fields[3].scale = Math.min(12, t.fields[3].scale + 1);
      return;
    case "optional":
      // Written as the catalog writes an optional field: no `required` key.
      delete t.fields[2].required;
      return;
    case "add_table":
      doc.tables.push({
        name: `extra${k}x${s.n}`,
        kind: "base",
        description: "added",
        time: { type: "none" },
        fields: [{ name: "label", type: "text", description: "what" }],
      });
      return;
  }
}

let s: ReusableStore;
let minute = 0;
const ctx = () =>
  createOpsContext({
    tenant: TENANT,
    actor: USER,
    trigger: null,
    task: `t${++minute}`,
    visibility: { kind: "all" },
    idempotency_window: 600_000,
    idempotency_key_window: 86_400_000,
    now: `2026-11-05T${String(3 + (Math.floor(minute / 60) % 20)).padStart(2, "0")}:${String(minute % 60).padStart(2, "0")}:00.000Z`,
    confirmation: null,
  });
const documentNow = async (): Promise<Doc> =>
  (
    (await catalog(s.store, ctx(), { level: "schema", slot: "ledger" })) as unknown as {
      document: Doc;
    }
  ).document;
async function noChange(doc: Doc): Promise<void> {
  await expect(schemaDraft(s.store, ctx(), { document: doc })).rejects.toMatchObject({
    code: "invalid_argument",
    detail: { reason: "no_change", param: "document" },
  });
}

beforeAll(async () => {
  await loadRsql();
  s = await openReusable("saveslot-catalog-document-");
}, T);
afterAll(async () => {
  await s?.close();
}, T);

it(
  "the catalog's document, submitted as it is, is no_change after any automatic changes",
  async () => {
    await fc.assert(
      fc.asyncProperty(fc.array(step, { minLength: 1, maxLength: 4 }), async (steps) => {
        await s.reset();
        minute = 0;
        await createTenant(s.store, { ...ctx(), task: null } as never);
        await schemaDraft(s.store, ctx(), { document: structuredClone(DOCUMENT) });
        await noChange(await documentNow());
        for (const [k, st] of steps.entries()) {
          const doc = await documentNow();
          const before = JSON.stringify(doc);
          apply(doc, st, k);
          // A step that changes nothing (a scale at its bound, a field already optional): skip.
          if (JSON.stringify(doc) === before) continue;
          const r = (await schemaDraft(s.store, ctx(), { document: doc })) as unknown as {
            outcome: string;
          };
          expect(r.outcome).toBe("applied");
          const now = await documentNow();
          // The derived table is still there, its rule as written.
          expect((now.tables as Doc[]).find((x) => x.name === "totals")?.rule.sql).toBe(
            DOCUMENT.tables[1]?.rule?.sql,
          );
          await noChange(now);
        }
      }),
      { numRuns: RUNS, ...(SEED !== undefined ? { seed: SEED } : {}) },
    );
  },
  T,
);
