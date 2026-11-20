// Reads as text (05-surfaces §6 `saveslot_pending`, `saveslot_history`, `saveslot_catalog`,
// `saveslot_query`; §4.1, §4.2), against golden files. The results are what a running service
// gave back (reads.samples.json): the pending list with items open, resolved and superseded; an
// awaiting item with its current values by stretch; conflicts open, resolved, superseded, and on a
// row revoked since; a timeline with a resolution and an undo, and one of a state table; a query
// of a state table and of an event table; the catalog's list, and its tables of each kind; a sql
// result with a disputed row among those it read. Update
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
  it("sql: the whole table inside one boundary; a cell's line break, bar and quote written as JSON; null as null", () => {
    const odd = {
      ...sample("sql"),
      marks_summary: undefined,
      notices: undefined,
      rows: [
        ["x | y", "1", "2", 'a\nb "c"'],
        [null, null, "0", "null"],
      ],
    };
    const out = text("saveslot_sql", odd);
    expect(out.split(B).length - 1).toBe(1);
    expect(out.split("\n").slice(1)).toEqual([
      "ledger schema v1 · 2 rows",
      `${B}"category" | "total (km)" | "n" | "tostring"`,
      '"x | y" | "1" | "2" | "a\\u000ab \\"c\\""',
      `null | null | "0" | "null"${E}`,
    ]);
  });

  it("sql: more rows than shown, by max_rows or by the budget: said, with no cursor to page by", () => {
    const base = { ...sample("sql"), notices: undefined };
    const more = { ...base, next_cursor: `cur_abc.${"A".repeat(43)}` };
    const out = text("saveslot_sql", more);
    expect(out).not.toContain("cur_");
    // Without a total, the count is not written as if it were all of them.
    expect(out.split("\n")[1]).toBe("ledger schema v1 · the first 2 rows");
    expect(out.split("\n").at(-1)).toBe(
      "Showing the first 2 rows; there are more. Add conditions or aggregate (max_rows is at most 1,000).",
    );
    const cut = { ...base, truncated: { shown: 2 } };
    expect(text("saveslot_sql", cut)).toContain("Showing the first 2 rows; there are more.");
    // With one, the total.
    const counted = text("saveslot_sql", { ...more, total: 5 });
    expect(counted.split("\n")[1]).toBe("ledger schema v1 · 2 of 5 rows");
    expect(counted.split("\n").at(-1)).toBe(
      "Showing the first 2 of 5 rows. Add conditions or aggregate (max_rows is at most 1,000).",
    );
  });

  it("sql: a row of another length than the columns is no shape the renderer knows", () => {
    expect(() => renderStrict("saveslot_sql", { ...sample("sql"), rows: [["food"]] })).toThrow();
  });

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

  it("aliases of a table and of a field are stored text: inside the boundary, after the description", () => {
    // Without the profile, which follows the aliases (its own cases below).
    const sampled = sample("catalog-table-state-event");
    const r = {
      ...sampled,
      tables: (sampled["tables"] as R[]).map((tb) => ({ ...tb, profile: undefined })),
    };
    const lines = text("saveslot_catalog", r).split("\n");
    expect(lines).toContain(
      `expenses (base · event, by date) ${B}one row per expense${E} · aliases: ${B}spending${E}, ${B}花销${E}`,
    );
    expect(lines).toContain(`  note  text  ${B}what for${E} · aliases: ${B}memo${E}, ${B}备注${E}`);
    // A table without aliases has no such part, and the list shows a table's aliases the same way.
    expect(lines.filter((l) => l.includes("aliases:"))).toHaveLength(4);
    expect(text("saveslot_catalog", sample("catalog-list"))).toContain(
      `expenses (base) ${B}one row per expense${E} · aliases: ${B}spending${E}, ${B}花销${E}`,
    );
  });

  it("a table's profile: its rows and range; the hint only over the comfortable line, with the lines the result gives", () => {
    const r = sample("catalog-table-state-event");
    const [budgets] = r["tables"] as R[];
    const head = (profile: R | undefined, extra: R = {}) =>
      text("saveslot_catalog", {
        ...r,
        tables: [{ ...budgets, aliases: undefined, ...extra, profile }],
      })
        .split("\n")
        .find((l) => l.startsWith("budgets ")) as string;
    const lines = { comfortable_rows: 100000, tested_rows: 1000000 };
    // No profile: nothing is said; an empty table: its row count and no range.
    expect(head(undefined)).not.toContain(" rows");
    expect(head({ rows: 0 })).toBe(
      `budgets (base · state, by date) ${B}monthly budget by category${E} · 0 rows`,
    );
    // At the comfortable line nothing; no thousands separators.
    expect(head({ rows: 100000 })).not.toContain("many rows");
    expect(head({ rows: 100000 })).toContain(" · 100000 rows");
    expect(head({ rows: 100001, scale: { level: "large", ...lines } })).toBe(
      `budgets (base · state, by date) ${B}monthly budget by category${E} · 100001 rows · many rows (over 100000): writes and derived-table refreshes on this table are slower than on a small table`,
    );
    expect(head({ rows: 1000001, scale: { level: "beyond_tested", ...lines } })).toContain(
      " · 1000001 rows · beyond the tested range (tested up to 1000000 rows): writes, derived-table refreshes and reads at a past time may be much slower",
    );
    // The lines of the result, not ones of the renderer's.
    expect(
      head({ rows: 7, scale: { level: "large", comfortable_rows: 5, tested_rows: 9 } }),
    ).toContain("(over 5)");
  });

  it("a table's range: an event table's ends; a state table's as the period of 05 §4.1", () => {
    const r = sample("catalog-table-state-event");
    const [budgets, expenses] = r["tables"] as R[];
    const line = (tb: R, from: string, to?: string) =>
      text("saveslot_catalog", {
        ...r,
        tables: [
          {
            ...tb,
            aliases: undefined,
            profile: { rows: 2, time_range: { from, ...(to ? { to } : {}) } },
          },
        ],
      })
        .split("\n")
        .find((l) => l.startsWith(`${tb["table"]} `)) as string;
    const head = (tb: R) =>
      `${tb["table"]} (base · ${(tb["time"] as R)["type"]}, by ${(tb["time"] as R)["field"] ?? (tb["time"] as R)["granularity"]}) ${B}${tb["description"]}${E} · 2 rows`;
    // A state table by date: open-ended; ended, the end exclusive written inclusive.
    expect(line(budgets as R, "2026-10-01")).toBe(`${head(budgets as R)} · from 2026-10-01`);
    expect(line(budgets as R, "2026-10-01", "2026-11-20")).toBe(
      `${head(budgets as R)} · 2026-10-01 to 2026-11-19 (inclusive)`,
    );
    // By instant: start and end as written.
    const rooms = { ...(budgets as R), time: { type: "state", granularity: "instant" } };
    expect(line(rooms, "2026-11-01T10:00:00.000Z", "2026-11-02T10:00:00.000Z")).toBe(
      `${head(rooms)} · 2026-11-01T10:00:00.000Z until 2026-11-02T10:00:00.000Z`,
    );
    // An event table: both ends, inclusive; instants as the slot's wall clock (Asia/Shanghai, UTC+8).
    expect(line(expenses as R, "2026-03-02", "2026-11-08")).toBe(
      `${head(expenses as R)} · 2026-03-02 to 2026-11-08`,
    );
    expect(line(expenses as R, "2026-11-02T15:30:00.000Z", "2026-11-02T16:30:00.000Z")).toBe(
      `${head(expenses as R)} · 2026-11-02 23:30 to 2026-11-03 00:30`,
    );
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
