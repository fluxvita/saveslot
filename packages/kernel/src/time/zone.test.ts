// Time zone arithmetic (provisional, on Intl): days of instants, instants of local times across
// transitions (a skipped local time resolves later by the gap, a repeated one to the earlier
// instant), the start of a day, UTC.

import { describe, expect, it } from "vitest";
import { dateInZone, localToInstant, nextDay, offsetAt, startOfDay, zoneName } from "./zone.ts";

const L = (s: string) => Date.parse(`${s}Z`);
const iso = (ms: number) => new Date(ms).toISOString();

describe("time zones", () => {
  it.each<[string, string, string, string]>([
    ["UTC", "2026-03-08T02:30:00", "2026-03-08T02:30:00.000Z", "exact"],
    ["Asia/Shanghai", "2026-11-10T00:00:00", "2026-11-09T16:00:00.000Z", "exact"],
    ["America/New_York", "2026-07-01T12:00:00", "2026-07-01T16:00:00.000Z", "exact"],
    // Spring forward: 02:00–03:00 does not exist; 02:30 resolves to 03:30 EDT.
    ["America/New_York", "2026-03-08T02:30:00", "2026-03-08T07:30:00.000Z", "gap"],
    ["America/New_York", "2026-03-08T03:00:00", "2026-03-08T07:00:00.000Z", "exact"],
    // Fall back: 01:00–02:00 occurs twice; the earlier (EDT) is taken.
    ["America/New_York", "2026-11-01T01:30:00", "2026-11-01T05:30:00.000Z", "overlap"],
    ["America/New_York", "2026-11-01T02:00:00", "2026-11-01T07:00:00.000Z", "exact"],
    // A half-hour transition.
    ["Australia/Lord_Howe", "2026-10-04T02:15:00", "2026-10-03T15:45:00.000Z", "gap"],
    // A transition at midnight: the day starts at 01:00.
    ["America/Sao_Paulo", "2018-11-04T00:00:00", "2018-11-04T03:00:00.000Z", "gap"],
  ])("%s %s → %s (%s)", (zone, local, instant, kind) => {
    const r = localToInstant(L(local), zone);
    expect([iso(r.epochMs), r.kind]).toEqual([instant, kind]);
  });

  it("gives the day an instant falls on", () => {
    expect(dateInZone(Date.parse("2026-11-10T16:00:00Z"), "Asia/Shanghai")).toBe("2026-11-11");
    expect(dateInZone(Date.parse("2026-11-10T15:59:59.999Z"), "Asia/Shanghai")).toBe("2026-11-10");
    expect(dateInZone(Date.parse("2026-11-10T03:59:59Z"), "America/New_York")).toBe("2026-11-09");
    expect(dateInZone(Date.parse("2026-11-10T23:59:59Z"), "UTC")).toBe("2026-11-10");
    expect(dateInZone(Date.parse("0001-01-01T00:00:00Z"), "UTC")).toBe("0001-01-01");
    expect(dateInZone(Date.parse("9999-12-31T23:59:59Z"), "UTC")).toBe("9999-12-31");
  });

  it("gives the start of a day, and the next day", () => {
    expect(iso(startOfDay("2026-11-10", "Asia/Shanghai"))).toBe("2026-11-09T16:00:00.000Z");
    expect(iso(startOfDay("2018-11-04", "America/Sao_Paulo"))).toBe("2018-11-04T03:00:00.000Z");
    expect(iso(startOfDay("2026-03-08", "America/New_York"))).toBe("2026-03-08T05:00:00.000Z");
    expect(nextDay("2026-02-28")).toBe("2026-03-01");
    expect(nextDay("2024-02-28")).toBe("2024-02-29");
    expect(nextDay("2026-12-31")).toBe("2027-01-01");
  });

  it("gives offsets", () => {
    expect(offsetAt(Date.parse("2026-07-01T00:00:00Z"), "America/New_York")).toBe(-4 * 3_600_000);
    expect(offsetAt(Date.parse("2026-01-01T00:00:00Z"), "America/New_York")).toBe(-5 * 3_600_000);
    expect(offsetAt(Date.parse("2026-01-01T00:00:00Z"), "Asia/Kolkata")).toBe(5.5 * 3_600_000);
  });

  it("names zones: the shape, the runtime's spelling for a case difference, aliases as written", () => {
    expect(zoneName("Asia/Shanghai")).toBe("Asia/Shanghai");
    expect(zoneName("asia/shanghai")).toBe("Asia/Shanghai");
    expect(zoneName("ASIA/SHANGHAI")).toBe("Asia/Shanghai");
    expect(zoneName("UTC")).toBe("UTC");
    expect(zoneName("America/Argentina/Buenos_Aires")).toBe("America/Argentina/Buenos_Aires");
    // The runtime maps these to another name: kept as written.
    expect(zoneName("US/Eastern")).toBe("US/Eastern");
    expect(zoneName("Etc/UTC")).toBe("Etc/UTC");
    for (const bad of ["Mars/Olympus", "PRC", "EST", "+08:00", "+0800", "utc", "Z", "", "Asia/"])
      expect(zoneName(bad), bad).toBeUndefined();
  });
});
