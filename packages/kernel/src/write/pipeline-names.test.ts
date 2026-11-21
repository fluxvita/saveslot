// A write at an earlier version (03-data-model/07-schema-evolution.md «旧名字还认多久»): the names it
// resolves by (`namedAt`: that version's tables and fields only), and the slot it is judged,
// logged and answered with (`namedAsWritten`: every table and field now, named as the request
// names them where that version has them).

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { namedAsWritten, namedAt } from "./pipeline.ts";

const field = (id: string, name: string) => ({ id, name, type: "text", description: name });
const base = (id: string, name: string, fields: [string, string][]) => ({
  id,
  name,
  kind: "base",
  description: name,
  time: { type: "none" },
  physical: { table: `t_${id}_v1` },
  fields: fields.map(([i, n]) => field(i, n)),
});
const schema = (sv: number, tables: unknown[]): CompiledSchema =>
  ({
    compiler: 1,
    rsql: "rsql@1",
    slot: `sl_${"4".repeat(16)}`,
    name: "ledger",
    sv,
    timezone: "Asia/Shanghai",
    tables,
  }) as unknown as CompiledSchema;

// Version 1: pairs (a, b), settings (key). Now: pairs renamed couples, a renamed c, a field d added;
// settings dropped; notes added.
const THEN = schema(1, [
  base("t1", "pairs", [
    ["f1", "a"],
    ["f2", "b"],
  ]),
  base("t2", "settings", [["f1", "key"]]),
]);
const NOW = schema(3, [
  base("t1", "couples", [
    ["f1", "c"],
    ["f2", "b"],
    ["f3", "d"],
  ]),
  base("t3", "notes", [["f1", "text"]]),
]);
const shape = (c: CompiledSchema) =>
  c.tables.map((t) => [t.id, t.name, t.kind === "base" ? t.fields.map((f) => f.name) : []]);

describe("names of a write at an earlier version", () => {
  it("to resolve by: that version's tables and fields, the dropped one included, nothing added since", () => {
    expect(shape(namedAt(NOW, THEN))).toEqual([
      ["t1", "pairs", ["a", "b"]],
      ["t2", "settings", ["key"]],
    ]);
  });

  it("to judge, log and answer with: every table and field now, named as then where then has them", () => {
    expect(shape(namedAsWritten(NOW, THEN))).toEqual([
      ["t1", "pairs", ["a", "b", "d"]],
      ["t3", "notes", ["text"]],
      ["t2", "settings", ["key"]],
    ]);
  });
});
