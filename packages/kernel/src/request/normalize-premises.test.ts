// normalizeWrite on `premises` (04-contract §5 «写入的前提»; 02-integrity «一条声明有什么», «哪些 op
// 可以带»): step 1's reading of each premise, and each refusal with its code, reason and path. What
// depends on the tenant's state is step 5's (write/premises.ts).

import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { acceptPremisesForTests } from "./normalize.ts";
import { ENTITY, errorOf, insertExpense, normalize, onlyOp, ROW } from "./requests.fixture.ts";

const OTHER_ROW = `r_${"3".repeat(26)}`;
const OTHER = `e_${"4".repeat(26)}`;

const withPremises = (premises: unknown, op: Record<string, unknown> = {}) => {
  const r = insertExpense();
  const o = (r["ops"] as Record<string, unknown>[])[0] as Record<string, unknown>;
  return { ops: [{ ...o, ...op, premises }] };
};
const update = (premises: unknown, more: Record<string, unknown> = {}) => ({
  ops: [{ intent: "update", table: "settings", row: ROW, ver: "v3.0", premises, ...more }],
});

describe("premises refused while the write path does not take them", () => {
  it("not_in_this_version at the op's premises", () => {
    expect(errorOf(normalize(withPremises([{ table: "settings", row: OTHER_ROW }])))).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param: "ops/0/premises",
    });
  });
});

describe("premises taken (the kernel's test entry)", () => {
  beforeAll(() => acceptPremisesForTests(true));
  afterAll(() => acceptPremisesForTests(false));

  it("a premise on a row, on fields, with its version: field IDs and the version read", () => {
    const op = onlyOp(
      normalize(
        withPremises([{ table: "settings", row: OTHER_ROW, fields: ["key"], ver: "v7.0" }]),
      ),
    );
    expect(op.premises).toEqual([
      {
        table: "t4",
        target: { kind: "row", row: OTHER_ROW },
        fields: ["f1"],
        ver: { op: 7, restoreCount: 0 },
      },
    ]);
  });

  it("on an entity by entity_key, over a stretch; on an entity at a point", () => {
    const op = onlyOp(
      normalize(
        withPremises([
          { table: "accounts", entity_key: { name: "cash" }, valid_during: ["2026-11-01", null] },
          { table: "rooms", entity: OTHER, valid_at: "2026-11-05T10:00:00+08:00" },
        ]),
      ),
    );
    expect(op.premises).toEqual([
      {
        table: "t2",
        target: { kind: "entity_key", key: { f1: { value: "cash", raw: "cash" } } },
        valid: { during: { from: "2026-11-01", to: null } },
      },
      {
        table: "t3",
        target: { kind: "entity", entity: OTHER },
        valid: { at: "2026-11-05T02:00:00.000Z" },
      },
    ]);
  });

  it("an update without set: a restatement with premises, a clearing with none", () => {
    const restated = onlyOp(normalize(update([{ table: "accounts", entity: ENTITY }])));
    expect(restated.fields).toBeUndefined();
    expect(restated.premises).toHaveLength(1);
    expect(onlyOp(normalize(update([]))).premises).toEqual([]);
    // Neither set nor premises: missing set, as before.
    expect(
      errorOf(normalize({ ops: [{ intent: "update", table: "settings", row: ROW }] })),
    ).toMatchObject({ code: "invalid_argument", reason: "missing", param: "ops/0/set" });
  });

  it("refuses premises on an op that cannot take them", () => {
    const revert = { ops: [{ table: "settings", row: ROW, revert: { undo: 3 }, premises: [] }] };
    expect(errorOf(normalize(revert))).toEqual({
      code: "invalid_argument",
      reason: "premises_with_revert",
      param: "ops/0/premises",
    });
    const revoke = {
      ops: [{ intent: "revoke", table: "settings", row: ROW, ver: "v3.0", premises: [] }],
    };
    expect(errorOf(normalize(revoke))).toEqual({
      code: "invalid_argument",
      reason: "premises_with_revoke",
      param: "ops/0/premises",
    });
    // A clearing is an update's.
    expect(errorOf(normalize(withPremises([])))).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises",
    });
  });

  it("refuses more than 16", () => {
    const many = Array.from({ length: 17 }, () => ({ table: "settings", row: OTHER_ROW }));
    expect(errorOf(normalize(withPremises(many)))).toEqual({
      code: "too_large",
      reason: "premise_entries",
      param: "ops/0/premises",
      limit: 16,
      actual: 17,
    });
    expect(onlyOp(normalize(withPremises(many.slice(1)))).premises).toHaveLength(16);
  });

  it("refuses a target given two ways, or none, or of the wrong kind", () => {
    const at = (p: Record<string, unknown>) => errorOf(normalize(withPremises([p])));
    expect(at({ table: "accounts", entity: OTHER, entity_key: { name: "x" } })).toMatchObject({
      reason: "mutually_exclusive",
      param: "ops/0/premises/0/entity_key",
    });
    expect(at({ table: "accounts" })).toMatchObject({
      reason: "missing",
      param: "ops/0/premises/0/entity",
    });
    expect(at({ table: "accounts", row: OTHER_ROW })).toMatchObject({
      reason: "state_table",
      param: "ops/0/premises/0/row",
    });
    expect(at({ table: "settings", entity: OTHER })).toMatchObject({
      reason: "not_state_table",
      param: "ops/0/premises/0/entity",
    });
    expect(at({ table: "settings", row: "r_x" })).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises/0/row",
    });
    expect(at({ table: "settings", row: OTHER_ROW, extra: 1 })).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises/0/extra",
    });
  });

  it("a temporary name is with `as`: not in this version", () => {
    expect(errorOf(normalize(withPremises([{ table: "settings", row: "@p1" }])))).toEqual({
      code: "not_in_this_version",
      reason: "parameter",
      param: "ops/0/premises/0/row",
    });
  });

  it("tables: a derived one is not in this version, an unknown one unknown_table", () => {
    expect(errorOf(normalize(withPremises([{ table: "weekly", row: OTHER_ROW }])))).toEqual({
      code: "not_in_this_version",
      reason: "value",
      param: "ops/0/premises/0/table",
    });
    expect(errorOf(normalize(withPremises([{ table: "nope", row: OTHER_ROW }])))).toMatchObject({
      code: "unknown_table",
      param: "ops/0/premises/0/table",
    });
  });

  it("fields: known names, each once, not an empty list", () => {
    const at = (fields: unknown) =>
      errorOf(normalize(withPremises([{ table: "expenses", row: OTHER_ROW, fields }])));
    expect(at([])).toMatchObject({ reason: "malformed", param: "ops/0/premises/0/fields" });
    expect(at(["note", "NOTE"])).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises/0/fields/1",
    });
    expect(at(["notes"])).toMatchObject({
      code: "unknown_field",
      param: "ops/0/premises/0/fields/0",
      nearest: ["note", "date", "rate"],
    });
  });

  it("ver: a historical version (as_of's h…) is refused by its own reason; v… of the same op is read", () => {
    const at = (ver: unknown) =>
      normalize(withPremises([{ table: "settings", row: OTHER_ROW, ver }]));
    expect(errorOf(at("h41.0"))).toEqual({
      code: "invalid_argument",
      reason: "premise_historical_ver",
      param: "ops/0/premises/0/ver",
    });
    expect(onlyOp(at("v41.0")).premises?.[0]?.ver).toEqual({ op: 41, restoreCount: 0 });
    expect(errorOf(at("41"))).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises/0/ver",
    });
  });

  it("business time: state tables only, a point or a stretch, not both, the stretch in order", () => {
    const at = (p: Record<string, unknown>) => errorOf(normalize(withPremises([p])));
    expect(at({ table: "settings", row: OTHER_ROW, valid_at: "2026-11-01" })).toMatchObject({
      reason: "not_state_table",
      param: "ops/0/premises/0/valid_at",
    });
    expect(
      at({
        table: "accounts",
        entity: OTHER,
        valid_at: "2026-11-01",
        valid_during: ["2026-11-01", null],
      }),
    ).toMatchObject({ reason: "mutually_exclusive", param: "ops/0/premises/0/valid_during" });
    expect(
      at({ table: "accounts", entity: OTHER, valid_during: ["2026-11-05", "2026-11-01"] }),
    ).toMatchObject({ reason: "malformed", param: "ops/0/premises/0/valid_during/1" });
    expect(at({ table: "accounts", entity: OTHER, valid_during: ["2026-11-05"] })).toMatchObject({
      reason: "malformed",
      param: "ops/0/premises/0/valid_during",
    });
  });

  it("a premise's key value wrong: the detail names the premise's table and its place", () => {
    const r = normalize(withPremises([{ table: "accounts", entity_key: { name: null } }]));
    expect(errorOf(r)).toEqual({
      code: "validation_failed",
      reason: "write",
      details: [
        {
          op: 0,
          table: "ledger.accounts",
          field: "name",
          code: "required_missing",
          path: "ops/0/premises/0/entity_key/name",
        },
      ],
    });
  });

  it("another slot's table: cross_slot when in range, unknown_table when not", () => {
    const inRange = [
      { name: "ledger", tables: ["expenses", "accounts", "settings"] },
      { name: "health", tables: ["weights"] },
    ];
    const at = (table: string) =>
      errorOf(normalize(withPremises([{ table, row: OTHER_ROW }]), { inRange }));
    expect(at("health.weights")).toMatchObject({
      code: "invalid_argument",
      reason: "cross_slot",
      param: "ops/0/premises/0/table",
    });
    expect(at("hidden.notes")).toMatchObject({
      code: "unknown_table",
      param: "ops/0/premises/0/table",
    });
  });
});
