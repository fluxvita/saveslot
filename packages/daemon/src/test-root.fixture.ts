// A test file's temporary directory, and what the file opened under it: the stores and servers not
// closed yet are named when the directory is removed, and the directory is checked to stay gone. A
// test runner that finds a temporary directory left after the files reports only its name; a store
// or a server still writing into it after its removal shows here by what it is.

import { existsSync, mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, expect } from "vitest";

interface Closable {
  close(): Promise<unknown>;
}

/** How long after the removal the directory is looked for again. */
const SETTLE_MS = 250;

/**
 * Makes the file's directory under the system's temporary one. Called at the top of a test file,
 * before its other hooks: vitest runs a file's `afterAll` hooks in the reverse of their order, so
 * the removal this registers runs after every other one.
 */
export function testRoot(prefix: string, timeoutMs: number) {
  const root = mkdtempSync(join(tmpdir(), prefix));
  const open = new Map<Closable, string>();
  afterAll(async () => {
    const still = [...open.values()];
    if (still.length > 0) {
      console.warn(`${prefix}: still open when its directory is removed: ${still.join(", ")}`);
    }
    rmSync(root, { recursive: true, force: true });
    // A writer still at work makes it again: looked for a moment later.
    await new Promise((r) => setTimeout(r, SETTLE_MS));
    expect(
      existsSync(root),
      `${root} is there again after its removal; still open then: ${still.join(", ") || "none"}`,
    ).toBe(false);
  }, timeoutMs);
  return {
    root,
    /** `x`, its closing recorded: until it is closed, it is named as still open. */
    track<T extends Closable>(what: string, x: T): T {
      open.set(x, what);
      const close = x.close.bind(x);
      return Object.assign(x, {
        close: async () => {
          try {
            // What it closed with, given back as it was.
            return await close();
          } finally {
            open.delete(x);
          }
        },
      });
    },
    /** Closes `x`; a failure is warned of, by what failed, rather than let go unseen. */
    async closeWarned(what: string, x: Closable): Promise<void> {
      try {
        await x.close();
      } catch (e) {
        console.warn(
          `${prefix}: closing ${what} failed: ${(e as Error)?.name}: ${(e as Error)?.message}`,
        );
      }
    },
  };
}
