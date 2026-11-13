import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { expect, it } from "vitest";
import { normalize, union } from "./interval.ts";

const d = (md: string) => `2026-${md}` as BizPoint;

it("intervals that both start from the earliest are joined", () => {
  expect(
    normalize([
      { from: null, to: d("11-07") },
      { from: null, to: d("11-01") },
    ]),
  ).toEqual([{ from: null, to: d("11-07") }]);
  expect(union([{ from: null, to: d("11-01") }], [{ from: null, to: d("11-07") }])).toEqual([
    { from: null, to: d("11-07") },
  ]);
});
