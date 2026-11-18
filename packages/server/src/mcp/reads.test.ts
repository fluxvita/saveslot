// Reads as text (05-surfaces §6 `saveslot_pending`, `saveslot_history`, `saveslot_catalog`,
// `saveslot_query`; §4.1, §4.2), against golden files. The results are what a running service
// gave back (reads.samples.json): the pending list with items open, resolved and superseded; an
// awaiting item with its current values by stretch; conflicts open, resolved, superseded, and on a
// row revoked since; a timeline with a resolution and an undo, and one of a state table; a query
// of a state table and of an event table; the catalog's list, and its tables of each kind. Update
// the golden files with `pnpm exec vitest run packages/server/src/mcp/reads.test.ts -u`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolName } from "./names.ts";
import { renderStrict } from "./render.ts";

type R = Record<string, unknown>;
const SAMPLES = JSON.parse(
  readFileSync(new URL("./reads.samples.json", import.meta.url), "utf8"),
) as Record<string, { tool: ToolName; result: R }>;

/** A fixed "now", for how long an item has been open. */
const NOW = new Date("2026-11-18T15:00:00Z");
/** The text with the boundary's number, drawn anew for each result, made one fixed value. */
const fixed = (s: string) => s.replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data-N");
const text = (tool: ToolName, result: R) => fixed(renderStrict(tool, result, NOW));
const sample = (name: string) => (SAMPLES[name] as { result: R }).result;

describe("reads as text (golden)", () => {
  it.each(Object.keys(SAMPLES))("%s", async (name) => {
    const { tool, result } = SAMPLES[name] as { tool: ToolName; result: R };
    await expect(`${text(tool, result)}\n`).toMatchFileSnapshot(`./__golden__/${name}.txt`);
  });
});

const ACTOR = { kind: "user", id: "u_YGEAVZA4KGXYZJZ2M8F93HZGJ4", name: "Me" };
const B = "<untrusted-data-N>";
const E = "</untrusted-data-N>";

describe("reads as text: what the samples do not show", () => {
  it("how long an item has been open: minutes, hours, days from 48 hours", () => {
    const list = sample("pending-list");
    const item = (opened_at: string) => ({ ...(list["items"] as R[])[0], opened_at });
    const at = (opened_at: string) =>
      text("saveslot_pending", { ...list, items: [item(opened_at)] })
        .split("\n")
        .find((l) => l.startsWith("pi_"));
    expect(at("2026-11-18T14:15:00Z")).toContain("opened 45 min ago");
    expect(at("2026-11-16T15:30:00Z")).toContain("opened 47 h ago");
    expect(at("2026-11-16T15:00:00Z")).toContain("opened 2 d ago");
  });

  it("items of more than one slot: no slot heads the list", () => {
    const list = sample("pending-list");
    const items = list["items"] as R[];
    const other = { ...items[0], slot: "health", target: { table: "health.runs" } };
    expect(text("saveslot_pending", { ...list, items: [items[0], other] })).toMatch(
      /^\d+ of \d+ pending items$/m,
    );
  });

  it("a conflict of several candidates: take_candidate once for each", () => {
    const detail = sample("pending-conflict-open");
    const first = (detail["candidates"] as R[])[0];
    const two = { ...detail, candidates: [first, { ...first, index: 1, seq: 99 }] };
    const lines = text("saveslot_pending", two).split("\n");
    expect(lines).toContain("    take_candidate candidate=0: put candidate 0 in effect");
    expect(lines).toContain("    take_candidate candidate=1: put candidate 1 in effect");
  });

  it("a stretch without a value; a decision this text does not explain, by its code", () => {
    const detail = sample("pending-awaiting-current");
    const current = { spans: [{ valid_from: "2026-11-03", valid_to: null, values: null }] };
    const lines = text("saveslot_pending", { ...detail, current }).split("\n");
    expect(lines).toContain("  In effect now: from 2026-11-03 no value");
    const conflict = {
      ...sample("pending-conflict-open"),
      decisions: ["keep_effective", "cancel"],
    };
    expect(text("saveslot_pending", conflict).split("\n")).toContain("    cancel");
  });

  it("a via of a shape not known: as written, inside the boundary", () => {
    const tl = sample("history-timeline-via");
    const entries = tl["entries"] as R[];
    const via = { deletion: "pi_0000000000000000", action: "confirm" };
    const t2 = text("saveslot_history", { ...tl, entries: [{ ...entries[0], via }] });
    expect(t2).toContain(`, by ${B}{"deletion":"pi_0000000000000000","action":"confirm"}${E}`);
  });

  it("a field's range, its values, what it refers to; a rule's dependencies", () => {
    const r = sample("catalog-table-state-event");
    const [budgets] = r["tables"] as R[];
    const fields = [
      {
        name: "payee",
        type: "ref",
        description: "who",
        ref: { table: "plan.payees", target: "entity" },
      },
      { name: "level", type: "integer", description: "how", min: "1", max: "x9" },
    ];
    const lines = text("saveslot_catalog", { ...r, tables: [{ ...budgets, fields }] }).split("\n");
    expect(lines).toContain(`  payee  ref  ${B}who${E} · refers to plan.payees (entity)`);
    expect(lines).toContain(`  level  integer  ${B}how${E} · ≥ 1 · ≤ ${B}x9${E}`);
  });

  it("a query of one entity: its key heads the result", () => {
    const r = sample("query-state");
    const [row] = r["rows"] as R[];
    expect(text("saveslot_query", { ...r, rows: [row], total: 1 }).split("\n")[1]).toMatch(
      new RegExp(`^plan\\.budgets · plan schema v1 · entity category ${B}food${E} · 1 of 1 rows$`),
    );
  });

  void ACTOR;
});
