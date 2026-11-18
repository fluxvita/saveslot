// The static texts against what this version takes (05-surfaces §9 «这一版不出现的句子»): no
// sentence about what comes with a later phase reaches a tool's description or a parameter's, for
// any credential; and with every later sentence let in, each text still reads as sentences, so
// that letting one in when its phase comes does not break the text around it.

import { expect, describe as group, it } from "vitest";
import {
  CATALOG,
  COMMON,
  compose,
  HISTORY,
  INSTRUCTIONS,
  PENDING,
  type Piece,
  QUERY,
  RESOLVE,
  type Text,
  WRITE,
} from "./texts.ts";
import { describe, TOOLS, type ToolName } from "./tools.ts";

const ALL: ReadonlySet<ToolName> = new Set([
  "saveslot_catalog",
  "saveslot_query",
  "saveslot_sql",
  "saveslot_history",
  "saveslot_sources",
  "saveslot_pending",
  "saveslot_write",
  "saveslot_resolve",
  "saveslot_schema_draft",
  "saveslot_delete",
]);

/** Every static text, by where it is. */
const TEXTS: [string, Text][] = [
  ...Object.entries({ CATALOG, QUERY, HISTORY, PENDING, WRITE, RESOLVE }).flatMap(([k, v]) => [
    [`${k}.description`, v.description] as [string, Text],
    ...Object.entries(v.params as Record<string, Text>).map(
      ([p, t]) => [`${k}.params.${p}`, t] as [string, Text],
    ),
  ]),
  ...Object.entries(COMMON).map(([p, t]) => [`COMMON.${p}`, t] as [string, Text]),
  ...INSTRUCTIONS.lines.map((l, k) => [`INSTRUCTIONS.lines[${k}]`, l] as [string, Text]),
];

const later = (p: Piece): p is Extract<Piece, { later: string }> =>
  typeof p !== "string" && "later" in p;
const LATER = TEXTS.flatMap(([, t]) => t.filter(later).map((p) => p.text));

group("sentences of a later phase", () => {
  it("there are some, each a sentence of its own", () => {
    expect(LATER.length).toBeGreaterThan(10);
    for (const s of LATER) expect(s).toMatch(/^[A-Z`'"(].*[.)]$/s);
  });

  it("none is in any tool's description or parameters, whichever tools are listed", () => {
    for (const listed of [ALL, new Set(TOOLS.map((t) => t.name))]) {
      for (const tool of TOOLS) {
        const text = JSON.stringify(describe(tool, listed));
        for (const s of LATER) expect(text).not.toContain(JSON.stringify(s).slice(1, -1));
      }
    }
  });

  it("let in, every text still reads: sentences joined by one space, nothing left empty", () => {
    for (const [where, t] of TEXTS) {
      const now = compose(t, ALL);
      const then = compose(t, ALL, { later: true });
      expect(then, where).not.toMatch(/ {2}|^ | $/);
      expect(then.length, where).toBeGreaterThanOrEqual(now.length);
      for (const p of t.filter(later)) expect(then, where).toContain(p.text);
    }
  });
});
