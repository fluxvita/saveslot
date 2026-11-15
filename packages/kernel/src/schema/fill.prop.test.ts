// The filled schema document (03-data-model/07-schema-evolution.md «schema 文档格式»; 04-contract §10
// `catalog`), over documents varied from two that compile (field order, name case, descriptions,
// optional fields, a derived field's declared precision):
// 1. filling only adds what saveslot assigns or infers, where the caller did not write it, and
//    `base_version`: every key the caller wrote keeps its value;
// 2. what it adds is the compiled definition's: table, field and rule IDs, the rule's version,
//    dependencies and scope, a derived field's type, unit and precision;
// 3. the document with the filled keys taken out again compiles to the same definition.
// (A filled document with IDs is a draft changing a slot, which this compiler does not take yet:
// the round trip goes through the document as submitted.)

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { Hits, propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { loadRsql } from "../rules/index.ts";
import { compile, type Doc, ledger } from "./documents.fixture.ts";
import { filledDocument } from "./fill.ts";

beforeAll(() => loadRsql());

/** 07 «例：新建 slot（v1 草稿）», with a derived table. */
function health(): Doc {
  return {
    slot: "health",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [
      {
        name: "runs",
        kind: "base",
        description: "每次跑步一行",
        time: { type: "event", field: "date" },
        fields: [
          { name: "date", type: "date", required: true, description: "跑步当天" },
          {
            name: "distance",
            type: "quantity",
            unit: "km",
            required: true,
            min: 0,
            description: "距离",
          },
          { name: "duration", type: "quantity", unit: "min", min: 0, description: "用时" },
          { name: "feeling", type: "text", description: "跑后感受" },
        ],
        duplicate_keys: [["date", "distance"]],
      },
      {
        name: "weekly_mileage",
        kind: "derived",
        description: "每周跑量",
        rule: {
          sql: "SELECT date_trunc('week', date::timestamp)::date AS week_start, sum(distance) AS total_distance, count(*) AS run_count FROM runs GROUP BY 1",
          time_dependency: "bucketed",
        },
        fields: [
          { name: "week_start", description: "该周周一" },
          { name: "total_distance", description: "该周总距离" },
          { name: "run_count", description: "该周跑步次数" },
        ],
      },
    ],
  };
}

/** Keys filling may add, by place. */
const ADDED = {
  table: new Set(["id"]),
  baseField: new Set(["id"]),
  derivedField: new Set(["id", "type", "unit", "scale", "rounding"]),
  rule: new Set(["id", "version", "depends_on", "scope"]),
};

/** Fields no key or reference names (safe to drop). */
const OPTIONAL: Record<string, string[]> = {
  expenses: ["note", "pieces", "rate", "paid", "at"],
  accounts: ["limit"],
  runs: ["duration", "feeling"],
};

const variant = fc.record({
  base: fc.constantFrom("ledger", "health"),
  drop: fc.array(fc.nat(), { maxLength: 3 }),
  shuffle: fc.array(fc.nat(), { maxLength: 4 }),
  upper: fc.array(fc.nat(), { maxLength: 3 }),
  description: fc.string({ unit: "grapheme", minLength: 1, maxLength: 12 }),
  precision: fc.option(fc.constant(true as const), { nil: undefined }),
});

function make(x: {
  base: string;
  drop: number[];
  shuffle: number[];
  upper: number[];
  description: string;
  precision?: true;
}): Doc {
  const d = x.base === "ledger" ? ledger() : health();
  for (const t of d.tables) {
    const optional = OPTIONAL[t.name] ?? [];
    for (const k of x.drop) {
      const name = optional[k % Math.max(optional.length, 1)];
      t.fields = t.fields.filter((f: { name: string }) => f.name !== name);
    }
    for (const k of x.shuffle) {
      const i = k % t.fields.length;
      const [f] = t.fields.splice(i, 1);
      t.fields.push(f);
    }
    t.description = `${t.description} ${x.description}`;
  }
  // A derived field's precision written by the caller, as inferred (the sum of km at scale 6):
  // kept as written, not filled.
  if (x.precision !== undefined && x.base === "health") {
    const total = d.tables[1].fields.find((f: { name: string }) => f.name === "total_distance");
    total.scale = 6;
  }
  // Name case: one field per table spelled upper case, wherever names refer to it too: only
  // fields nothing refers to.
  for (const k of x.upper) {
    const t = d.tables[k % d.tables.length];
    const optional = OPTIONAL[t.name] ?? [];
    const f = t.fields.find((y: { name: string }) => optional.includes(y.name));
    if (f !== undefined) f.name = f.name.toUpperCase();
  }
  return d;
}

/** Compares the filled document with the submitted one: same values where written; added keys only where allowed. */
function onlyAdds(doc: Doc, filled: Doc, compiled: CompiledSchema): string[] {
  const problems: string[] = [];
  const same = (a: unknown, b: unknown, at: string) => {
    if (JSON.stringify(a) !== JSON.stringify(b)) problems.push(`${at}: changed`);
  };
  for (const k of Object.keys(doc))
    if (k !== "tables" && k !== "base_version") same(doc[k], filled[k], k);
  if (filled.base_version !== compiled.sv) problems.push("base_version");
  doc.tables.forEach((t: Doc, i: number) => {
    const ft = filled.tables[i];
    const derived = t.kind === "derived";
    for (const k of Object.keys(t))
      if (k !== "fields" && k !== "rule") same(t[k], ft[k], `tables/${i}/${k}`);
    for (const k of Object.keys(ft))
      if (!(k in t) && !ADDED.table.has(k)) problems.push(`tables/${i}/${k}: added`);
    t.fields.forEach((f: Doc, j: number) => {
      const ff = ft.fields[j];
      for (const k of Object.keys(f)) same(f[k], ff[k], `tables/${i}/fields/${j}/${k}`);
      const allowed = derived ? ADDED.derivedField : ADDED.baseField;
      for (const k of Object.keys(ff))
        if (!(k in f) && !allowed.has(k)) problems.push(`tables/${i}/fields/${j}/${k}: added`);
    });
    if (derived) {
      for (const k of Object.keys(t.rule)) same(t.rule[k], ft.rule[k], `tables/${i}/rule/${k}`);
      for (const k of Object.keys(ft.rule))
        if (!(k in t.rule) && !ADDED.rule.has(k)) problems.push(`tables/${i}/rule/${k}: added`);
    }
  });
  return problems;
}

/** The submitted document back: the filled keys taken out, base_version null. */
function unfilled(doc: Doc, filled: Doc): Doc {
  const out = structuredClone(filled);
  out.base_version = null;
  out.tables.forEach((t: Doc, i: number) => {
    const o = doc.tables[i];
    for (const k of Object.keys(t)) if (!(k in o)) delete t[k];
    t.fields.forEach((f: Doc, j: number) => {
      for (const k of Object.keys(f)) if (!(k in o.fields[j])) delete f[k];
    });
    if (t.rule !== undefined)
      for (const k of Object.keys(t.rule)) if (!(k in o.rule)) delete t.rule[k];
  });
  return out;
}

describe("filledDocument", () => {
  it("adds only what saveslot assigns or infers, the compiled definition's, and compiles back the same", () => {
    const hits = new Hits(0.8);
    fc.assert(
      fc.property(
        variant,
        hits.track((x) => {
          const doc = make(x as never);
          const r = compile(doc);
          if (!r.ok) return;
          hits.hit();
          const compiled = r.compiled as CompiledSchema;
          const filled = filledDocument(doc, compiled) as Doc;
          expect(onlyAdds(doc, filled, compiled)).toEqual([]);
          // What it adds is the definition's.
          for (const t of filled.tables) {
            const c = compiled.tables.find((y) => y.name === t.name);
            expect(t.id).toBe(c?.id);
            for (const f of t.fields) {
              const cf = c?.fields.find((y) => y.name === f.name);
              expect(f.id).toBe(cf?.id);
              if (t.kind === "derived") {
                expect(f.type).toBe(cf?.type);
                if (cf?.type === "quantity") expect(f.unit).toBe(cf.unit.code);
              }
            }
            if (c?.kind === "derived") {
              expect(t.rule.id).toBe(c.rule.id);
              expect(t.rule.version).toBe(c.rule.version);
              expect(t.rule.depends_on).toEqual(
                c.rule.depends_on.map((d) => {
                  const dt = compiled.tables.find((y) => y.id === d.table);
                  return `${dt?.name}.${dt?.fields.find((y) => y.id === d.field)?.name}`;
                }),
              );
            }
          }
          const back = unfilled(doc, filled);
          expect(back).toEqual(doc);
          const again = compile(back);
          expect(again.ok && again.compiled).toEqual(compiled);
        }),
      ),
      { numRuns: propRuns(200) },
    );
    hits.check();
  });
});
