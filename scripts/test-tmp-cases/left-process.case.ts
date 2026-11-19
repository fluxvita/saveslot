// A test that passes and leaves a process running, started from under the temporary directory.
// Not one of the repository's tests: `test-tmp.test.ts` runs it to see the run fail.

import { spawn } from "node:child_process";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { expect, it } from "vitest";

it("passes, and leaves a process behind", () => {
  const dir = mkdtempSync(join(tmpdir(), "left-"));
  const child = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)", join(dir, "home")], {
    detached: true,
    stdio: "ignore",
  });
  child.unref();
  expect(child.pid).toBeGreaterThan(0);
  writeFileSync(process.env["LEFT_PID_FILE"] as string, String(child.pid));
});
