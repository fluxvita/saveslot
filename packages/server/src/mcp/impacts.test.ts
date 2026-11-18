// Derived values and impacts as text (05-surfaces §6 `saveslot_write`, `saveslot_pending`): one
// line per derived row; what carrying out an item would change (overwrite, fill a gap, undo), in a
// receipt's awaiting or candidate part and in an item's detail alike, with the line that says to
// tell the user first. The samples (impacts.samples.json) are what a running service gave back.
// Update the golden files with `pnpm exec vitest run packages/server/src/mcp/impacts.test.ts -u`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolName } from "./names.ts";
import { renderStrict } from "./render.ts";

type R = Record<string, unknown>;
const SAMPLES = JSON.parse(
  readFileSync(new URL("./impacts.samples.json", import.meta.url), "utf8"),
) as Record<string, { tool: ToolName; result: R }>;

/** The text with the boundary's number, drawn anew for each result, made one fixed value. */
const fixed = (s: string) => s.replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data-N");
/** A fixed "now", for how long an item has been open. */
const NOW = new Date("2026-11-18T15:00:00Z");
const text = (tool: ToolName, result: R) => fixed(renderStrict(tool, result, NOW));

describe("derived values and impacts as text (golden)", () => {
  it.each(Object.keys(SAMPLES))("%s", async (name) => {
    const { tool, result } = SAMPLES[name] as { tool: ToolName; result: R };
    await expect(`${text(tool, result)}\n`).toMatchFileSnapshot(`./__golden__/${name}.txt`);
  });
});

const ACTOR = { kind: "user", id: "u_YGEAVZA4KGXYZJZ2M8F93HZGJ4", name: "Me" };

describe("derived values and impacts: what the samples do not show", () => {
  it("a gap filled with no stretch given, the same entry twice, and a kind not known: each said once", () => {
    const detail = {
      ...(SAMPLES["pending-awaiting-overwrite"] as { result: R }).result,
      impact: {
        filled_gaps: [{ revoked_by: 9 }, { revoked_by: 9 }],
        reverted: [{ seq: 12, actor: ACTOR, fields: ["amount"] }],
        hidden_by_gap: [{ seq: 14 }],
      },
    };
    const lines = text("saveslot_pending", detail).split("\n");
    expect(lines.filter((l) => l.includes("fill the whole time"))).toEqual([
      "    fill the whole time, which has no value (revoked by #9)",
    ]);
    expect(lines).toContain("    undo #12 (<untrusted-data-N>Me</untrusted-data-N>): amount");
    expect(lines).toContain(
      '    <untrusted-data-N>hidden_by_gap</untrusted-data-N>: <untrusted-data-N>[{"seq":14}]</untrusted-data-N>',
    );
  });

  it("more derived changes than listed; a replay's derived writes without values", () => {
    const base = (SAMPLES["write-derived-correct"] as { result: R }).result;
    expect(text("saveslot_write", { ...base, derived_total: 7 })).toContain(
      "6 more derived changes are not listed in this receipt.",
    );
    expect(
      text("saveslot_write", { ...base, replayed: true, derived: [], derived_total: 2 }),
    ).toContain("Derived: 2 derived rows were written; a replay does not give their values.");
  });

  it("a derived row of a tenant-wide rule has no key: its table only", () => {
    const base = (SAMPLES["write-derived-correct"] as { result: R }).result;
    const derived = [{ table: "health.totals", key: {}, field: "n", before: "1", after: "2" }];
    expect(text("saveslot_write", { ...base, derived, derived_total: 1 })).toContain(
      "Derived: health.totals: n <untrusted-data-N>1</untrusted-data-N> → <untrusted-data-N>2</untrusted-data-N>",
    );
  });
});
