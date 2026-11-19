// A test that passes and leaves a directory, but no process. Not one of the repository's tests:
// `test-tmp.test.ts` runs it to see the run pass and the directory said.

import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes, and leaves a directory behind", () => {
  expect(mkdtempSync(join(tmpdir(), "left-dir-"))).toContain("left-dir-");
});
