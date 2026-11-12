// The cut of 09 §5.7, on its own: original items of one write landing in one segment.

import type { BizPoint } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { cutSegment, type Original } from "./evaluate.ts";
import type { IvSet } from "./interval.ts";
import { showIv } from "./views.ts";

const d = (md: string) => `2026-${md}` as BizPoint;
const iv = (from: string | null, to: string | null): IvSet => [
  { from: from === null ? null : d(from), to: to === null ? null : d(to) },
];
const orig = (k: number, from: string, to: string, key: string, cleared = false): Original => ({
  k,
  start: d(from),
  key,
  cleared,
  union: iv(from, to),
});
const show = (pieces: ReturnType<typeof cutSegment>) =>
  pieces.map((p) => `${Math.min(...p.ks)} ${showIv(p.valid).replaceAll("2026-", "")}`);

describe("cutSegment", () => {
  it("different listing records: cut at the original starts", () => {
    expect(
      show(
        cutSegment(iv("11-02", "11-20"), [
          orig(0, "11-02", "11-10", "35"),
          orig(1, "11-10", "11-20", ""),
        ]),
      ),
    ).toEqual(["0 [11-02, 11-10)", "1 [11-10, 11-20)"]);
  });

  it("re-merge goes by the cut provider's records, not a joined item's", () => {
    // k1's interval is cleared: it gives no cut and joins k0, whose records ('') match k2's.
    // Compared by k1's own records ('40') the pieces would stay apart.
    const pieces = cutSegment(iv("11-02", "11-20"), [
      orig(0, "11-02", "11-08", ""),
      orig(1, "11-08", "11-12", "40", true),
      orig(2, "11-12", "11-20", ""),
    ]);
    expect(show(pieces)).toEqual(["0 [11-02, 11-20)"]);
  });

  it("a cleared first item joins the piece to its right", () => {
    const pieces = cutSegment(iv("11-02", "11-20"), [
      orig(0, "11-02", "11-08", "40", true),
      orig(1, "11-08", "11-12", ""),
      orig(2, "11-12", "11-20", "35"),
    ]);
    expect(show(pieces)).toEqual(["0 [11-02, 11-12)", "2 [11-12, 11-20)"]);
  });

  it("no usable cut point: one item", () => {
    const pieces = cutSegment(iv("11-02", "11-20"), [
      orig(0, "11-02", "11-10", "35", true),
      orig(1, "11-10", "11-20", "", true),
    ]);
    expect(show(pieces)).toEqual(["0 [11-02, 11-20)"]);
  });

  it("beyond the union: the end goes to the last item, the start to the first, gaps to the left", () => {
    const pieces = cutSegment(iv("10-28", "11-25"), [
      orig(0, "11-02", "11-06", "35"),
      orig(1, "11-10", "11-20", ""),
    ]);
    expect(show(pieces)).toEqual(["0 [10-28, 11-10)", "1 [11-10, 11-25)"]);
  });

  it("three items, two with the same records: regrouped, smallest index kept", () => {
    const pieces = cutSegment(iv("11-02", "11-20"), [
      orig(0, "11-02", "11-10", "35"),
      orig(2, "11-15", "11-20", ""),
      orig(1, "11-10", "11-15", ""),
    ]);
    expect(show(pieces)).toEqual(["0 [11-02, 11-10)", "1 [11-10, 11-20)"]);
  });
});
