// The depending row's own business time aligned to the premise target's granularity
// (02-integrity «写入的前提» «按粒度对齐»): a day for an instant on a date table; that day's bounds
// for a date on an instant table; every day a stretch of instants meets, more rather than less.

import type { BizPoint, CompiledBaseTable } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { alignedTo, hull } from "./premises.ts";

const ZONE = "Asia/Shanghai";
const table = (granularity: "date" | "instant") =>
  ({ time: { type: "state", granularity } }) as unknown as CompiledBaseTable;
const p = (s: string) => s as BizPoint;

describe("alignedTo", () => {
  it("a date target: an instant's day in the slot's zone", () => {
    expect(alignedTo(table("date"), { at: p("2026-11-05T17:00:00.000Z") }, ZONE)).toEqual({
      at: "2026-11-06",
    });
    expect(alignedTo(table("date"), { at: p("2026-11-05") }, ZONE)).toEqual({ at: "2026-11-05" });
  });

  it("an instant target: a day is its bounds in the slot's zone", () => {
    expect(alignedTo(table("instant"), { at: p("2026-11-05") }, ZONE)).toEqual({
      during: { from: "2026-11-04T16:00:00.000Z", to: "2026-11-05T16:00:00.000Z" },
    });
    expect(
      alignedTo(table("instant"), { during: { from: p("2026-11-05"), to: p("2026-11-07") } }, ZONE),
    ).toEqual({ during: { from: "2026-11-04T16:00:00.000Z", to: "2026-11-06T16:00:00.000Z" } });
  });

  it("a date target, a stretch of instants: every day it meets; an end at midnight is that day", () => {
    // [11-05 10:00, 11-07 18:00) in Shanghai: days 11-05 to 11-07, so to 11-08.
    expect(
      alignedTo(
        table("date"),
        { during: { from: p("2026-11-05T02:00:00.000Z"), to: p("2026-11-07T10:00:00.000Z") } },
        ZONE,
      ),
    ).toEqual({ during: { from: "2026-11-05", to: "2026-11-08" } });
    // Ending exactly at 11-08 00:00 in Shanghai: 11-08 is not met.
    expect(
      alignedTo(
        table("date"),
        { during: { from: p("2026-11-05T02:00:00.000Z"), to: p("2026-11-07T16:00:00.000Z") } },
        ZONE,
      ),
    ).toEqual({ during: { from: "2026-11-05", to: "2026-11-08" } });
    // Open: still open.
    expect(
      alignedTo(table("date"), { during: { from: p("2026-11-05T02:00:00.000Z"), to: null } }, ZONE),
    ).toEqual({ during: { from: "2026-11-05" } });
  });
});

describe("hull", () => {
  it("pieces run together, gaps included; none, or one open at the start, has no hull", () => {
    expect(
      hull([
        { from: p("2026-11-01"), to: p("2026-11-03") },
        { from: p("2026-11-05"), to: null },
      ]),
    ).toEqual({ from: "2026-11-01", to: null });
    expect(hull([])).toBeUndefined();
    expect(hull([{ from: null, to: p("2026-11-03") }])).toBeUndefined();
  });
});
