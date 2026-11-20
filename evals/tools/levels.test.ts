import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse } from "yaml";
import { badLevels } from "./levels.ts";

const EVALS = new URL("..", import.meta.url).pathname;

describe("assertion levels", () => {
  it("every variant here gives each assertion S, H, R or N", () => {
    const files = readdirSync(EVALS).filter((f) => f.endsWith(".yaml"));
    expect(files.length).toBeGreaterThan(0);
    for (const f of files) {
      const v = parse(readFileSync(join(EVALS, f), "utf8")) as Record<string, unknown>;
      expect(badLevels(v), f).toEqual([]);
    }
  });

  it("another value, a lower-case one or none is reported with its path", () => {
    expect(
      badLevels({
        assert: {
          calls: [{ level: "H" }, { level: "X" }],
          state: [{ text: "no level" }],
          reply: [{ level: "n" }, { level: "N" }],
        },
      }),
    ).toEqual([
      { path: "assert.calls[1]", level: "X" },
      { path: "assert.state[0]", level: undefined },
      { path: "assert.reply[0]", level: "n" },
    ]);
  });

  it("no assertions: nothing to report; a list that is not one is reported", () => {
    expect(badLevels({})).toEqual([]);
    expect(badLevels({ assert: { calls: { level: "H" } } })).toEqual([
      { path: "assert.calls", level: undefined },
    ]);
  });
});
