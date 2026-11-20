// The lowest Node saveslot runs on (./runtime.ts), against what `engines` says in package.json.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { nodeSupported } from "./runtime.ts";

describe("the Node floor", () => {
  it.each([
    ["22.20.0", false],
    ["24.14.0", false],
    ["24.22.0", false],
    ["24.22.1", true],
    ["24.22.3", true],
    ["24.23.0", true],
    ["25.9.0", false],
    ["26.12.0", false],
    ["26.12.1", true],
    ["26.13.1", true],
    ["27.0.0", true],
    ["not a version", false],
  ])("%s: %s", (v, ok) => {
    expect(nodeSupported(v)).toBe(ok);
  });

  it("is what engines says in this package", () => {
    const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
      engines: { node: string };
    };
    expect(pkg.engines.node).toBe(">=24.22.1 <25 || >=26.12.1");
  });
});
