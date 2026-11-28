// The lock's addon has prebuilds for glibc only. Where it cannot load (musl), lock.ts is still
// imported, so a command that takes no lock runs; taking a lock is what fails.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it, vi } from "vitest";
import { osFileLock } from "./lock.ts";

vi.mock("fs-native-extensions", () => {
  throw new Error("no prebuild for this platform");
});

const dir = mkdtempSync(join(tmpdir(), "saveslot-lock-"));
afterAll(() => rmSync(dir, { recursive: true, force: true }));

describe("osFileLock where its addon cannot load", () => {
  it("lock.ts is imported without loading it", () => {
    expect(osFileLock.name).toBe("os-file-lock");
  });

  it("taking a lock loads it, and fails", async () => {
    await expect(osFileLock.acquire(dir)).rejects.toThrow();
  });
});
