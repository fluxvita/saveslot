// The soak script's replay lines: a failed property run must leave its seed, replay path and
// counterexample in the report.

import { describe, expect, it } from "vitest";
import { replayLines, slug } from "./soak-props.ts";

const FAILED = ` FAIL  packages/reference/src/log.prop.test.ts > state table > «撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay
Error: Property failed after 1083 tests
{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }
Counterexample: [{"st":[{"t":"cancel","back":0}]},false]
Shrunk 5 time(s)

Hint: Enable verbose mode in order to have the list of all failing values encountered during the run
 ❯ buildError node_modules/.pnpm/fast-check/lib/fast-check.js:2469:16
   × state table > «撤回还原» 12ms
{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }
`;

describe("replayLines", () => {
  it("keeps the failure, the seed and path, and the counterexample, once each", () => {
    expect(replayLines(FAILED)).toEqual([
      " FAIL  packages/reference/src/log.prop.test.ts > state table > «撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay",
      "Error: Property failed after 1083 tests",
      '{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }',
      'Counterexample: [{"st":[{"t":"cancel","back":0}]},false]',
      "   × state table > «撤回还原» 12ms",
    ]);
  });

  it("finds nothing in a passing run", () => {
    expect(
      replayLines(" ✓ packages/a.prop.test.ts (2 tests) 300ms\n Test Files  1 passed (1)\n"),
    ).toEqual([]);
  });

  it("names a file by its last parts", () => {
    expect(slug("packages/kernel/src/write/record.prop.test.ts")).toBe("src-write-record");
  });
});
