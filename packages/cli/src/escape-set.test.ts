// The set the CLI writes escaped, against the table shared with the MCP renderer (contract's
// testing fixtures, through the client): the two sets are written twice and must stay one.

import { CONTEXT_SAMPLES, ESCAPE_SAMPLES } from "@fluxvita/saveslot-client/testing";
import { describe, expect, it } from "vitest";
import { escapes, inEscapedSet } from "./untrusted.ts";

describe("the escaped set, as the MCP renderer has it too", () => {
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
