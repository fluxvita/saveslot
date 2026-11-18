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

  it("a change awaiting confirmation that is not an undo, with nothing in its impact: no heading over nothing", async () => {
    const detail = {
      ...(SAMPLES["pending-awaiting-overwrite"] as { result: R }).result,
      impact: {},
    };
    await expect(`${text("saveslot_pending", detail)}\n`).toMatchFileSnapshot(
      "./__golden__/pending-awaiting-empty-impact.txt",
    );
  });

  it("an undo awaiting confirmation in a receipt, with nothing in its impact: confirming changes no value read now", () => {
    const base = (SAMPLES["write-awaiting-undo-later"] as { result: R }).result;
    const ops = (base["ops"] as R[]).map((o) => ({
      ...o,
      fields: Object.fromEntries(
        Object.entries(o["fields"] as R).map(([f, v]) => [
          f,
          (Array.isArray(v) ? v : [v]).map((c: R) =>
            c["result"] === "awaiting" ? { ...c, impact: {} } : c,
          ),
        ]),
      ),
    }));
    const lines = text("saveslot_write", { ...base, ops }).split("\n");
    expect(lines.some((l) => l.includes("Carrying it out would:"))).toBe(false);
    expect(lines).toContain("  Confirming it records this undo; no value read now changes.");
  });

  it("a merge base where an event or timeless table's row did not exist: no row, as before", () => {
    const base = (SAMPLES["pending-conflict-take-previous-fields"] as { result: R }).result;
    const target = { table: "ledger.rows", row: "r_00000000000000000000000009", unit: ["b"] };
    const lines = text("saveslot_pending", {
      ...base,
      target,
      previous: { seq: 30, exists: false },
    }).split("\n");
    expect(lines).toContain("  Before (#30): no row");
    expect(lines).toContain(
      "    take_previous: go back to the value at #30 (no row); see what it would undo above",
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
