// The run on PostgreSQL (./test-postgres.ts): what it leaves out is there to be left out.

import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";
import { EXCLUDED, TESTED } from "./test-postgres.ts";

const REPO = resolve(import.meta.dirname, "..");

describe("the run on PostgreSQL", () => {
  it("leaves out files that exist, are tests of what it runs, and each for a reason", () => {
    expect(EXCLUDED.length).toBeGreaterThan(0);
    for (const x of EXCLUDED) {
      expect(existsSync(resolve(REPO, x.file)), x.file).toBe(true);
      expect(
        TESTED.some((dir) => x.file.startsWith(`${dir}/`)),
        x.file,
      ).toBe(true);
      expect(x.file).toMatch(/\.test\.ts$/);
      expect(x.why.length, x.file).toBeGreaterThan(40);
    }
  });

  it("is a script of the repository: pnpm test:postgres", () => {
    const pkg = JSON.parse(readFileSync(resolve(REPO, "package.json"), "utf8")) as {
      scripts: Record<string, string>;
    };
    expect(pkg.scripts["test:postgres"]).toBe("node scripts/test-postgres.ts");
  });
});
