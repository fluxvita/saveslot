// A judgement's refusal as the contract's error (04-contract-types §9): the field judge names by
// its ID is given by name, at `ops/i/set/<name>` in a write and as `field` in a decision's write
// (which has no ops); an ID never reaches the caller.

import type { CompiledBaseTable } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { COMPILED_V1 } from "../apply/slot.fixture.ts";
import { JudgeError } from "../judge/index.ts";
import { judgeFailure } from "./pipeline.ts";

const table = COMPILED_V1.tables[0] as unknown as CompiledBaseTable;
const noValueNow = (field: string) =>
  new JudgeError("invalid_argument", "no value now", { reason: "no_value_now", field });
const detailOf = (e: JudgeError, index?: number) => {
  const w = judgeFailure(e, {
    ...(index !== undefined ? { index } : {}),
    slot: "ledger",
    table,
    id: "x",
  });
  return { code: w.code, ...w.detail };
};

describe("no_value_now names its field", () => {
  it("in a write: at the field of the op's set", () => {
    expect(detailOf(noValueNow("f1"), 2)).toEqual({
      code: "invalid_argument",
      reason: "no_value_now",
      param: "ops/2/set/date",
    });
  });

  it("in a decision's write: as field", () => {
    expect(detailOf(noValueNow("f1"))).toEqual({
      code: "invalid_argument",
      reason: "no_value_now",
      field: "date",
    });
  });

  it("a field the table does not have: neither, never the ID", () => {
    expect(detailOf(noValueNow("f99"), 0)).toEqual({
      code: "invalid_argument",
      reason: "no_value_now",
      param: "ops/0",
    });
    expect(detailOf(noValueNow("f99"))).toEqual({
      code: "invalid_argument",
      reason: "no_value_now",
    });
  });
});
