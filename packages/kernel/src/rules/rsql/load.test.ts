// The parser is loaded by loadRsql() only: compiling before it is an error, never a silent load.
// A file of its own, so that no other test has loaded the module before.

import { describe, expect, it } from "vitest";
import { checkBoundRule, compileDerivedRule } from "./derived.ts";
import { loadRsql } from "./load.ts";
import { rule } from "./rules.fixture.ts";

describe("loadRsql", () => {
  const r = rule("SELECT count(date) AS x FROM runs", ["x"]);

  it("must come first: compiling before it throws, and loads nothing", () => {
    expect(() => compileDerivedRule(r)).toThrow(
      "restricted SQL is not loaded: await loadRsql() first",
    );
    expect(() => checkBoundRule(r)).toThrow("restricted SQL is not loaded");
    expect(() => compileDerivedRule(r)).toThrow("not loaded");
  });

  it("loads once; loading again is harmless", async () => {
    await Promise.all([loadRsql(), loadRsql()]);
    await loadRsql();
    expect(compileDerivedRule(r).ok).toBe(true);
  });
});
