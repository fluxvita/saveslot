// Reads as text (05-surfaces §6 `saveslot_pending`, `saveslot_history`, `saveslot_catalog`,
// `saveslot_query`; §4.1, §4.2), against golden files. The results are what a running service
// gave back (reads.samples.json): the pending list with items open, resolved and superseded; an
// awaiting item with its current values by stretch; conflicts open, resolved, superseded, and on a
// row revoked since; a schema_change item open, and one superseded; a timeline with a resolution and an undo, and one of a state table; a query
// of a state table and of an event table; the catalog's list, and its tables of each kind; a sql
// result with a disputed row among those it read; the catalog's list with no slot, for each kind of
// credential. Update
// the golden files with `pnpm exec vitest run packages/server/src/mcp/reads.test.ts -u`.

import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it } from "vitest";
import { slotList } from "./instructions.ts";
import type { ToolName } from "./names.ts";
import { type RenderFor, renderError, renderPhases, renderStrict } from "./render.ts";

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

describe("the catalog's list with no slot: the credential's next step (golden)", () => {
  const empty = { level: "list", total: 0, slots: [] };
  const CREDENTIALS: Readonly<Record<string, RenderFor>> = {
    // The default connection instance: every slot, and saveslot.schema.
    schema: { scoped: false, schema: true },
    "no-schema": { scoped: false, schema: false },
    // Scoped to some slots: with or without saveslot.schema, the same sentence.
    scoped: { scoped: true, schema: true },
  };
  it.each(Object.keys(CREDENTIALS))("%s", async (kind) => {
    const who = CREDENTIALS[kind] as RenderFor;
    const out = fixed(renderStrict("saveslot_catalog", empty, NOW, who));
    await expect(`${out}\n`).toMatchFileSnapshot(`./__golden__/catalog-list-empty-${kind}.txt`);
    // The sentence `instructions` has in place of the slot list (05 §9 «slot 清单» 4), word for word.
    expect(out).toContain(slotList([], who));
  });

  it("scoped without saveslot.schema: the scoped sentence too", () => {
    const who = { scoped: true, schema: false };
    expect(fixed(renderStrict("saveslot_catalog", empty, NOW, who))).toContain(slotList([], who));
  });

  it("with slots, the credential changes nothing; with no credential given, the bare fact", () => {
    const list = sample("catalog-list");
    expect(fixed(renderStrict("saveslot_catalog", list, NOW, CREDENTIALS["schema"]))).toBe(
      fixed(renderStrict("saveslot_catalog", list, NOW)),
    );
    expect(fixed(renderStrict("saveslot_catalog", empty, NOW))).toContain("No slots yet.");
  });
});

const ACTOR = { kind: "user", id: "u_YGEAVZA4KGXYZJZ2M8F93HZGJ4", name: "Me" };
const B = "<untrusted-data-N>";
const E = "</untrusted-data-N>";

describe("an item a deletion still pending blocks: cancelling it comes with P3 (05 §9 «这一版不出现的句子»)", () => {
  afterEach(() => {
    renderPhases.open = new Set();
  });
  const B = "<untrusted-data-N>";
  const blocked = (deletions: string[]) => ({
    ...sample("pending-conflict-blocked"),
    blocked: { reason: "pending_deletion", deletions, expires_at: "2026-11-19T12:40:00.000Z" },
  });
  const last = (r: Record<string, unknown>) =>
    text("saveslot_pending", r).split("\n").at(-1) as string;

  it("in this version: which deletions, when due, decide after; nothing of cancelling", () => {
    const line = last(blocked(["pi_D3X7T10N0000AAAA"]));
    expect(line).not.toContain("cancel");
    expect(line).not.toContain("saveslot_resolve");
  });

  it("with P3 let in: cancelling each by name, what it brings back, only if the user asks, and the scope it needs", () => {
    renderPhases.open = new Set(["P3"]);
    expect(last(blocked(["pi_D3X7T10N0000AAAA"]))).toBe(
      "  No decision for now: its target is affected by a deletion still pending (pi_D3X7T10N0000AAAA; due 2026-11-19T12:40:00.000Z): decide after it has run. Cancelling it (saveslot_resolve pi_D3X7T10N0000AAAA cancel, which needs saveslot.delete) brings back what it removed: do it only if the user asks.",
    );
    expect(last(blocked(["pi_D3X7T10N0000AAAA", "pi_D3X7T10N0000BBBB"]))).toBe(
      "  No decision for now: its target is affected by deletions still pending (pi_D3X7T10N0000AAAA, pi_D3X7T10N0000BBBB; due at the latest 2026-11-19T12:40:00.000Z): decide after they have all run. Cancelling them (saveslot_resolve pi_D3X7T10N0000AAAA cancel, saveslot_resolve pi_D3X7T10N0000BBBB cancel, which need saveslot.delete) brings back what they removed: do it only if the user asks.",
    );
    const refusal = fixed(
      renderError(
        {
          code: "invalid_argument",
          reason: "pending_deletion_target",
          message: "m",
          deletions: ["pi_D3X7T10N0000AAAA"],
          expires_at: "2026-11-19T12:40:00.000Z",
        },
        NOW,
      ),
    );
    expect(refusal).toContain("do it only if the user asks.");
  });

  it("no deletion named (the contract never sends one so): no empty list, no call", () => {
    renderPhases.open = new Set(["P3"]);
    const line = last(blocked([]));
    expect(line).toBe(
      "  No decision for now: its target is affected by a deletion still pending: decide after it has run.",
    );
    expect(line).not.toContain(B);
  });
});

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

  it("a schema_change item in the list: its slot, no empty target, its type said once", () => {
    const item = sample("pending-schema-change-open");
    const list = {
      total: 1,
      items: [
        {
          id: item["id"],
          type: "schema_change",
          status: "open",
          slot: "diet",
          reason: "schema_change",
          opened_at: item["opened_at"],
          opened_by: item["opened_by"],
        },
      ],
    };
    const line = text("saveslot_pending", list)
      .split("\n")
      .find((x) => x.startsWith(String(item["id"])));
    expect(line).toMatch(/^pi_\w+ schema_change · slot diet · opened /);
    expect(line).not.toContain("untrusted-data-N></untrusted-data-N");
  });

  void ACTOR;
});
