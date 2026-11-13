// The versions `judge` judges by are the versions the kernel accepts in recorded events
// (02-architecture §3 «判定的版本»): `judge` cannot import `rules`, so the two sets are checked here.

import { expect, it } from "vitest";
import { JUDGE_RULESET_VERSIONS } from "../judge/index.ts";
import { KNOWN_RULESET_VERSIONS, RULESET_VERSION } from "../rules/index.ts";

it("judge knows exactly the ruleset versions the kernel accepts", () => {
  expect([...JUDGE_RULESET_VERSIONS].sort()).toEqual([...KNOWN_RULESET_VERSIONS].sort());
  expect(JUDGE_RULESET_VERSIONS.has(RULESET_VERSION)).toBe(true);
});
