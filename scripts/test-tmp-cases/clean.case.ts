// A test that passes and leaves a directory, but no process; and puts a file among the run's store
// templates (SAVESLOT_TEST_TEMPLATES), as the test backend does, and names them in TEMPLATES_FILE. Not one of the repository's tests:
// `test-tmp.test.ts` runs it to see the run pass, the directory said, and the templates not said
// and gone with the run.

import { mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes, and leaves a directory behind", () => {
  expect(mkdtempSync(join(tmpdir(), "left-dir-"))).toContain("left-dir-");
  const templates = process.env["SAVESLOT_TEST_TEMPLATES"] as string;
  mkdirSync(join(templates, "a-template"), { recursive: true });
  writeFileSync(join(templates, "a-template", "PG_VERSION"), "18\n");
  const at = process.env["TEMPLATES_FILE"];
  if (at !== undefined) writeFileSync(at, templates);
});
