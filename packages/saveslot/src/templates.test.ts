// The three templates of 06-cli §3.1 end to end, on a real service: `saveslot slot create
// --template` makes the slot, a row is written to its base table, and the derived table (or the
// state of the entity, for the budget) reads back what the row says. `saveslot slot show` shows
// the tables, and a template with no --timezone takes this computer's time zone and says so.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createClient, request, resolveCredential } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-templates-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
let token = "";

async function saveslot(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await dispatch(
    [...argv, "--home", home],
    { NO_COLOR: "1" },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: true,
      stderrIsTTY: true,
    },
  );
  return { code, out, err };
}

/** One write as the user session (POST /v1/writes, 05-surfaces §14). */
async function write(body: unknown) {
  return (await request({
    socketPath: socketFile(home),
    method: "POST",
    path: "/v1/writes",
    token,
    body,
  })) as { status: string };
}

beforeAll(async () => {
  expect((await saveslot("init")).code).toBe(0);
  expect((await saveslot("start")).code).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

const query = (table: string) =>
  createClient({ socketPath: socketFile(home), token }).query({ table });

describe("the templates, end to end", () => {
  it("running: a run is written; weekly_mileage has its week", async () => {
    const c = await saveslot(
      "slot",
      "create",
      "health",
      "--template",
      "running",
      "--timezone",
      "Asia/Shanghai",
    );
    expect(c.code).toBe(0);
    expect(c.out.split("\n")[0]).toBe(
      "Created slot health · schema v1 · 2 tables (runs, weekly_mileage)",
    );
    const w = await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: "ran 5.2 km this morning" }],
      ops: [
        {
          intent: "insert",
          table: "runs",
          set: { date: "2026-11-11", distance: { value: "5.2", unit: "km" } },
        },
      ],
    });
    expect(w.status).toBe("saved");
    const r = await query("health.weekly_mileage");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.values).toMatchObject({
      week_start: "2026-11-09",
      // Integers come as decimal text (04-contract-types §1.4 Value).
      run_count: "1",
      days_recorded: "1",
      first_date: "2026-11-11",
      last_date: "2026-11-11",
    });
    expect(JSON.stringify(r.rows[0]?.values["total_distance"])).toContain("5.2");
  });

  it("spending: an expense is written; monthly_total has its month", async () => {
    const c = await saveslot(
      "slot",
      "create",
      "ledger",
      "--template",
      "spending",
      "--timezone",
      "Asia/Shanghai",
    );
    expect(c.code).toBe(0);
    const w = await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: "lunch was 45" }],
      ops: [
        {
          intent: "insert",
          table: "expenses",
          set: { date: "2026-11-10", category: "food", amount: { value: "45", unit: "CNY" } },
        },
      ],
    });
    expect(w.status).toBe("saved");
    const r = await query("ledger.monthly_total");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.values).toMatchObject({ month: "2026-11-01", days_recorded: "1" });
    expect(JSON.stringify(r.rows[0]?.values["total"])).toContain("45");
  });

  it("budget: a budget is written; its state reads back", async () => {
    const c = await saveslot(
      "slot",
      "create",
      "plan",
      "--template",
      "budget",
      "--timezone",
      "Asia/Shanghai",
    );
    expect(c.code).toBe(0);
    const w = await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: "food budget is 3000 from November" }],
      ops: [
        {
          // A state table is written by its entity key (04-contract-types §5.1, example 3).
          intent: "update",
          table: "budgets",
          entity_key: { category: "food" },
          valid_from: "2026-11-01",
          set: { amount: { value: "3000", unit: "CNY" } },
        },
      ],
    });
    expect(w.status).toBe("saved");
    const r = await query("plan.budgets");
    expect(r.rows).toHaveLength(1);
    expect(r.rows[0]?.values).toMatchObject({ category: "food" });
    expect(JSON.stringify(r.rows[0]?.values["amount"])).toContain("3000");
  });

  it("slot show: the tables of a slot, the derived one with its rule", async () => {
    const r = await saveslot("slot", "show", "health");
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines).toContain("runs (base · event, by date)  「每次跑步一行」");
    expect(lines).toContain("  distance  quantity 「km」 6 decimal places · required  「距离」");
    expect(lines.some((l) => l.startsWith("weekly_mileage (derived, read-only)  「"))).toBe(true);
    expect(lines.some((l) => l.startsWith("  rule (bucketed): 「SELECT date_trunc('week'"))).toBe(
      true,
    );
  });

  it("a template with no --timezone: this computer's, said so", async () => {
    const r = await saveslot("slot", "create", "health2", "--template", "running");
    expect(r.code).toBe(0);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect(r.out).toContain(`time zone: this computer's, as no --timezone was given: 「${zone}」`);
  });

  it("a compile failure: refused, each problem with where it is", async () => {
    const r = await saveslot("slot", "create", "_bad", "--template", "running");
    expect(r.code).toBe(5);
    expect(r.err).toMatch(/^error validation_failed/);
    expect(r.err).toMatch(/reserved_name {2}at path /);
  });
});
