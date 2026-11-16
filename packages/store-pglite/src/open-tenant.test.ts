// Opening a tenant loads the restricted SQL parser (02-architecture §4 `openTenant`): in a process
// that has not loaded it, a tenant with derived tables, opened through the kernel's `openTenant` and
// without a schema document submitted, (a) reads a derived table, (b) refreshes the derived tables
// after a base change, (c) replays derived writes from an empty storage. Each runs in a process of
// its own (testing/derived-tenant.fixture.ts): this test file's module graph may have loaded it.

import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { promisify } from "node:util";
import { afterAll, describe, expect, it } from "vitest";

const run = promisify(execFile);
const FIXTURE = join(import.meta.dirname, "testing", "derived-tenant.fixture.ts");
const root = mkdtempSync(join(tmpdir(), "saveslot-open-tenant-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));

async function fixture(...args: string[]): Promise<unknown> {
  const { stdout } = await run(
    process.execPath,
    ["--conditions=source", "--no-warnings", FIXTURE, ...args],
    { timeout: 120_000 },
  );
  return JSON.parse(stdout.trim().split("\n").at(-1) as string);
}

describe("openTenant loads the restricted SQL parser", () => {
  it("a fresh process reads a derived table, refreshes one and replays derived writes", async () => {
    const dir = join(root, "tenant");
    expect(await fixture(dir, "setup")).toEqual({ setup: "ok" });
    expect(await fixture(dir, "serve", join(root, "replica"))).toEqual({
      before: false,
      decision: "serve",
      a: "ok",
      b: "ok",
      c: "ok",
    });
  }, 240_000);
});
