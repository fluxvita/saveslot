// resolveWriteSlot (04-contract §1, §5): the request's slot from its tables, before the slot's
// compiled definition is read.

import { describe, expect, it } from "vitest";
import { resolveWriteSlot } from "./normalize.ts";

const SLOTS = [
  { name: "ledger", tables: ["expenses", "Budgets"] },
  { name: "health", tables: ["runs", "budgets"] },
  { name: "Notes", tables: ["notes"] },
];
const req = (...tables: unknown[]) => ({
  ops: tables.map((table) => ({ intent: "insert", table })),
});

describe("resolveWriteSlot", () => {
  it("takes the slot of a qualified name, or the one slot that has a bare name", () => {
    expect(resolveWriteSlot(req("ledger.expenses"), SLOTS)).toEqual({ ok: true, slot: "ledger" });
    expect(resolveWriteSlot(req("runs", "HEALTH.Runs"), SLOTS)).toEqual({
      ok: true,
      slot: "health",
    });
    expect(resolveWriteSlot(req("notes.NOTES"), SLOTS)).toEqual({ ok: true, slot: "Notes" });
  });

  it("refuses a bare name several slots have, with the qualified candidates", () => {
    expect(resolveWriteSlot(req("budgets"), SLOTS)).toEqual({
      ok: false,
      error: {
        code: "invalid_argument",
        reason: "ambiguous_table",
        param: "ops/0/table",
        candidates: ["ledger.Budgets", "health.budgets"],
      },
    });
    expect(resolveWriteSlot(req("health.budgets"), SLOTS)).toEqual({ ok: true, slot: "health" });
  });

  it("refuses ops in different slots at the first op that differs", () => {
    expect(resolveWriteSlot(req("expenses", "ledger.budgets", "runs", "notes"), SLOTS)).toEqual({
      ok: false,
      error: { code: "invalid_argument", reason: "cross_slot", param: "ops/2/table" },
    });
  });

  it("refuses unknown tables and slots, with the nearest names", () => {
    expect(resolveWriteSlot(req("expense"), SLOTS)).toEqual({
      ok: false,
      error: {
        code: "unknown_table",
        param: "ops/0/table",
        name: "expense",
        nearest: ["expenses", "notes", "runs"],
      },
    });
    expect(resolveWriteSlot(req("work.notes"), SLOTS)).toEqual({
      ok: false,
      error: {
        code: "unknown_table",
        param: "ops/0/table",
        name: "work.notes",
        nearest: ["Notes.notes", "health.runs", "health.budgets"],
      },
    });
    expect(resolveWriteSlot(req("ledger.runs"), SLOTS)).toEqual({
      ok: false,
      error: {
        code: "unknown_table",
        param: "ops/0/table",
        name: "ledger.runs",
        nearest: ["health.runs", "ledger.Budgets", "ledger.expenses"],
      },
    });
    expect(resolveWriteSlot(req("constructor"), SLOTS)).toMatchObject({
      error: { code: "unknown_table" },
    });
  });

  it.each<[string, unknown, string, string]>([
    ["not an object", null, "malformed", ""],
    ["no ops", {}, "missing", "ops"],
    ["empty ops", { ops: [] }, "malformed", "ops"],
    ["an op not an object", { ops: [1] }, "malformed", "ops/0"],
    ["an op without table", { ops: [{}] }, "missing", "ops/0/table"],
    ["a table not a string", { ops: [{ table: 3 }] }, "malformed", "ops/0/table"],
  ])("refuses %s", (_, params, reason, param) => {
    expect(resolveWriteSlot(params, SLOTS)).toEqual({
      ok: false,
      error: { code: "invalid_argument", reason, param },
    });
  });
});
