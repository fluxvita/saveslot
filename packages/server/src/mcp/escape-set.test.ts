// The set the MCP renderer writes escaped, against the table shared with the CLI's renderer
// (contract's testing fixtures): the two sets are written twice and must stay one.

import { CONTEXT_SAMPLES, ESCAPE_SAMPLES } from "@fluxvita/saveslot-contract/testing";
import { describe, expect, it } from "vitest";
import { escapes, inEscapedSet } from "./text.ts";

describe("the escaped set, as the CLI has it too", () => {
  it.each(ESCAPE_SAMPLES.map(([cp, escaped]) => [cp.toString(16), cp, escaped] as const))(
    "U+%s",
    (_, cp, escaped) => {
      expect(inEscapedSet(String.fromCodePoint(cp))).toBe(escaped);
    },
  );
});

describe("the context rules, as the other renderer has them too", () => {
  it.each(
    CONTEXT_SAMPLES.map(
      ([cps, escaped]) => [cps.map((c) => c.toString(16)).join(" "), cps, escaped] as const,
    ),
  )("%s", (_, cps, escaped) => {
    expect(
      escapes(
        cps.map((c) => String.fromCodePoint(c)),
        () => false,
      ),
    ).toEqual(escaped);
  });
});
