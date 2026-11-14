// compileNewSlot before loadRsql(): a document without derived tables compiles; one with a derived
// table throws, the restricted SQL parser being loaded only by loadRsql(). A file of its own, so
// that no other test has loaded the parser before.

import { describe, expect, it } from "vitest";
import { compile, edit, ledger } from "./documents.fixture.ts";

describe("compiling before loadRsql()", () => {
  it("compiles a document without derived tables", () => {
    expect(compile(ledger()).ok).toBe(true);
  });

  it("throws on a document with a derived table, loading nothing", () => {
    const d = edit((x) =>
      x.tables.push({
        name: "per_day",
        kind: "derived",
        description: "expenses per day",
        rule: {
          sql: "SELECT date, count(*) AS n FROM expenses GROUP BY 1",
          time_dependency: "bucketed",
        },
        fields: [
          { name: "date", description: "the day" },
          { name: "n", description: "how many" },
        ],
      }),
    );
    expect(() => compile(d)).toThrow("restricted SQL is not loaded: await loadRsql() first");
    expect(() => compile(d)).toThrow("not loaded");
  });
});
