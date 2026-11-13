import { describe, expect, it } from "vitest";
import { isKnownRulesetVersion, KNOWN_RULESET_VERSIONS, RULESET_VERSION } from "./version.ts";

describe("ruleset version", () => {
  it("knows the version it records", () => {
    expect(isKnownRulesetVersion(RULESET_VERSION)).toBe(true);
  });

  it("knows only version 1 in this release", () => {
    expect([...KNOWN_RULESET_VERSIONS]).toEqual([1]);
    expect(isKnownRulesetVersion(2)).toBe(false);
    expect(isKnownRulesetVersion(0)).toBe(false);
  });
});
