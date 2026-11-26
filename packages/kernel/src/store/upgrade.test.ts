// The upgrade steps: the kernel's list chains from the oldest upgradable format to its own.

import { describe, expect, it } from "vitest";
import { STORAGE_FORMAT_VERSION } from "./format-v1.ts";
import { OLDEST_UPGRADABLE_FORMAT, UPGRADE_STEPS, upgradePath } from "./upgrade.ts";

describe("upgrade steps", () => {
  it("the kernel's steps go from the oldest upgradable format to its own, one each", () => {
    expect(upgradePath(OLDEST_UPGRADABLE_FORMAT, STORAGE_FORMAT_VERSION)).toHaveLength(
      STORAGE_FORMAT_VERSION - OLDEST_UPGRADABLE_FORMAT,
    );
    expect(UPGRADE_STEPS.every((s) => s.from >= OLDEST_UPGRADABLE_FORMAT)).toBe(true);
  });

  it("a path is the steps in order; a missing or doubled step is an error", () => {
    const steps = [
      { from: 5, sql: "A" },
      { from: 6, sql: "B" },
    ];
    expect(upgradePath(5, 7, steps).map((s) => s.sql)).toEqual(["A", "B"]);
    expect(upgradePath(6, 7, steps).map((s) => s.sql)).toEqual(["B"]);
    expect(upgradePath(7, 7, steps)).toEqual([]);
    expect(() => upgradePath(5, 8, steps)).toThrow("0 steps from format 7");
    expect(() => upgradePath(5, 6, [...steps, { from: 5, sql: "C" }])).toThrow(
      "2 steps from format 5",
    );
  });
});
