// Cross-checks the storage format v1 table list against the spec's table list
// (docs/zh-CN/spec/02-architecture.md §8 "存储格式 v1"), so that either side changing alone fails.

import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { KERNEL_TABLES, type StateClass } from "./format-v1.ts";

const SPEC = resolve(import.meta.dirname, "../../../../docs/zh-CN/spec/02-architecture.md");

interface SpecTable {
  name: string;
  class: StateClass;
  reconcile: string | undefined;
}

/** Fixed kernel tables listed in §8, with their class and "对拍" cell. Dynamic tables are skipped. */
function specTables(): SpecTable[] {
  const text = readFileSync(SPEC, "utf8");
  const start = text.indexOf("### 存储格式 v1");
  const end = text.indexOf("### 容量边界");
  expect(start).toBeGreaterThan(-1);
  expect(end).toBeGreaterThan(start);
  const out: SpecTable[] = [];
  let cls: StateClass | undefined;
  for (const line of text.slice(start, end).split("\n")) {
    if (line.startsWith("**(a)")) cls = "fact";
    else if (line.startsWith("**(b)")) cls = "materialized";
    else if (line.startsWith("**(c)")) cls = "local";
    const m = /^\| `([a-z_]+)`/.exec(line);
    if (m?.[1] === undefined || cls === undefined) continue;
    const cells = line.split("|").map((c) => c.trim());
    out.push({
      name: m[1],
      class: cls,
      reconcile: cls === "materialized" ? cells.at(-2) : undefined,
    });
  }
  return out;
}

describe("storage format v1", () => {
  const spec = specTables();
  // Listed in §8 but explicitly not built in v1.
  const notInV1 = new Set(["fts"]);

  it("parses the spec's table list", () => {
    expect(spec.length).toBeGreaterThan(20);
  });

  it("creates exactly the fixed tables the spec lists, in the same class", () => {
    const expected = spec
      .filter((t) => !notInV1.has(t.name))
      .map((t) => `${t.class}:${t.name}`)
      .sort();
    const actual = KERNEL_TABLES.map((t) => `${t.class}:${t.name}`).sort();
    expect(actual).toEqual(expected);
  });

  it("marks tables compared by log.reconcile as the spec does", () => {
    for (const t of spec.filter((s) => s.class === "materialized" && !notInV1.has(s.name))) {
      const table = KERNEL_TABLES.find((k) => k.name === t.name);
      const expected =
        t.reconcile === "是" ? true : t.reconcile?.startsWith("结构是") ? "structure" : false;
      expect({ table: t.name, reconciled: table?.reconciled }).toEqual({
        table: t.name,
        reconciled: expected,
      });
    }
  });

  it("uses the C collation for every text column", () => {
    for (const t of KERNEL_TABLES) {
      const bareText = t.ddl
        .split("\n")
        .filter((l) => /\bTEXT\b/.test(l) && !/COLLATE "C"/.test(l));
      expect({ table: t.name, bareText }).toEqual({ table: t.name, bareText: [] });
    }
  });
});
