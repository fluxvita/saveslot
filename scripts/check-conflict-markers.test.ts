// The check for lines a merge conflict leaves behind (./check-conflict-markers.ts).

import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { checkConflictMarkers, markerLines } from "./check-conflict-markers.ts";

describe("conflict markers", () => {
  it("finds the lines that start with a marker, and no others", () => {
    const text = [
      "- one item",
      `${"<".repeat(7)} HEAD`,
      "ours",
      "=======",
      "theirs",
      `${">".repeat(7)} af99941b (chore(ci): a check)`,
      `  ${">".repeat(7)} indented: quoted in a document, not a marker`,
      `${">".repeat(7)}no space after it`,
      `${">".repeat(6)} six of them`,
    ].join("\n");
    expect(markerLines(text)).toEqual([2, 6]);
  });

  it("passes on the repository", () => {
    expect(checkConflictMarkers(join(import.meta.dirname, "..")).hits).toEqual([]);
  });
});
