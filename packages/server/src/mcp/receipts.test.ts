// Write and resolve receipts as text (05-surfaces §6 `saveslot_write`, `saveslot_resolve`, §4.3),
// against golden files. The receipts are what a running service gave back (receipts.samples.json,
// taken from a real service): a rounded amount and a moment without a zone, a unit converted, a
// new entity (a moment cut to the day; the keys the table had), a write partly a candidate, one
// merged into an open item, an undo with a part changed since and one with the later writes, a
// fallback ver and sv with an item refreshed, a resolution with a fallback item_ver, a
// take_previous with the writes it undid; on state tables, how each field's interval resolved (an
// unchanged next change, a start taken as now, a correction's stretch, a stretch without a value
// filled, ending or lasting); an applied part merged; evidence no op cites; a clock behind the log;
// the pending_items notice; and premises: declared (one had changed already), restated and cleared,
// rows marked by a change and unmarked by its change back (these four from kernel's test switch,
// on a real store: the service does not take premises yet). Update the golden files with
// `pnpm exec vitest run packages/server/src/mcp/receipts.test.ts -u`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolName } from "./names.ts";
import { renderStrict } from "./render.ts";

type R = Record<string, unknown>;
const SAMPLES = JSON.parse(
  readFileSync(new URL("./receipts.samples.json", import.meta.url), "utf8"),
) as Record<string, { tool: ToolName; result: R }>;

/** A fixed "now", for how long a notice's oldest item has been open. */
const NOW = new Date("2026-11-05T05:00:00Z");
/** The text with the boundary's number, drawn anew for each result, made one fixed value. */
const fixed = (s: string) => s.replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data-N");

describe("receipts as text (golden)", () => {
  it.each(Object.keys(SAMPLES))("%s", async (name) => {
    const { tool, result } = SAMPLES[name] as { tool: ToolName; result: R };
    // The renderer, not its JSON fallback: a shape it does not know fails here.
    await expect(`${fixed(renderStrict(tool, result, NOW))}\n`).toMatchFileSnapshot(
      `./__golden__/${name}.txt`,
    );
  });
});

describe("premise_affected in a receipt (05 §6)", () => {
  it("one row each way: the verbs agree; a row under two declarations is listed once", () => {
    const actor = { kind: "user", id: "u_1", name: "u_1" };
    const row = (seq: number) => ({
      target: { table: "ledger.tasks", row: "r_4KWKRM296X61WJ89DY5XJNVA4A" },
      fields: ["title"],
      declared: { seq, actor },
    });
    const text = renderStrict(
      "saveslot_write",
      {
        status: "saved",
        sv: 1,
        seq: 40,
        ops: [],
        derived: [],
        derived_total: 0,
        pending: [],
        superseded: [],
        premise_affected: {
          count: 1,
          matched: 1,
          by_reason: { update: 1 },
          rows: [row(30), row(31)],
        },
      },
      NOW,
    ).split("\n");
    expect(text).toContain(
      '1 row rests on what this change touched and now carries "premise changed": ledger.tasks r_4KWKRM296X61WJ89DY5XJNVA4A',
    );
    expect(text).toContain(
      '1 row rests on premises back to the values declared and no longer carries "premise changed"',
    );
  });
});
