// A zoned date-time out and back in (04-contract-types §1.3 `ZonedDateTime`): written by the time
// module (../time `zonedText`), read by a write's parsing (./times.ts `parseDateTime`), which must
// give back the same instant and zone.

import { describe, expect, it } from "vitest";
import { offsetAt, offsetToMinute, valueOut, zonedText } from "../time/index.ts";
import { parseDateTime } from "./times.ts";
import { normalizeValue } from "./values.ts";

describe("a zoned date-time as the contract writes it (04-contract-types §1.3 `ZonedDateTime`)", () => {
  /** Written out, then read back as a write reads it: the same instant, the same zone. */
  const roundTrip = (instant: string, zone: string) => {
    const text = zonedText(instant, zone);
    const back = parseDateTime(text, "UTC", true);
    expect(back, text).toMatchObject({ ok: true, zoneText: zone });
    expect(new Date((back as { epochMs: number }).epochMs).toISOString(), text).toBe(instant);
    return text;
  };

  it("the wall-clock time, the offset and the zone; the fraction only when not zero", () => {
    expect(roundTrip("2026-11-10T04:31:00.000Z", "Asia/Shanghai")).toBe(
      "2026-11-10T12:31:00+08:00[Asia/Shanghai]",
    );
    expect(roundTrip("2026-11-11T14:00:00.250Z", "America/New_York")).toBe(
      "2026-11-11T09:00:00.250-05:00[America/New_York]",
    );
    expect(roundTrip("2026-11-10T04:31:00.007Z", "UTC")).toBe("2026-11-10T04:31:00.007+00:00[UTC]");
  });

  it("the hour a clock goes back: the same wall-clock time, each instant back to itself", () => {
    // America/New_York, 2026-11-01: 01:30 happens at -04:00, then again at -05:00.
    expect(roundTrip("2026-11-01T05:30:00.000Z", "America/New_York")).toBe(
      "2026-11-01T01:30:00-04:00[America/New_York]",
    );
    expect(roundTrip("2026-11-01T06:30:00.000Z", "America/New_York")).toBe(
      "2026-11-01T01:30:00-05:00[America/New_York]",
    );
  });

  it("the hour a clock goes forward: either side, each back to itself", () => {
    // America/New_York, 2026-03-08: 02:00–03:00 does not happen.
    expect(roundTrip("2026-03-08T06:59:59.999Z", "America/New_York")).toBe(
      "2026-03-08T01:59:59.999-05:00[America/New_York]",
    );
    expect(roundTrip("2026-03-08T07:00:00.000Z", "America/New_York")).toBe(
      "2026-03-08T03:00:00-04:00[America/New_York]",
    );
  });

  it("an offset with seconds: written rounded to the minute, read back to the instant", () => {
    // Before 1972 Africa/Monrovia was -00:44:30, an exact half minute: away from zero, -00:45.
    expect(offsetAt(Date.parse("1971-06-01T12:00:00Z"), "Africa/Monrovia")).toBe(-2_670_000);
    expect(roundTrip("1971-06-01T12:00:00.000Z", "Africa/Monrovia")).toBe(
      "1971-06-01T11:15:30-00:45[Africa/Monrovia]",
    );
    // Asia/Shanghai's mean solar time in year 1 is +08:05:43.
    expect(roundTrip("0001-01-01T00:00:00.000Z", "Asia/Shanghai")).toBe(
      "0001-01-01T08:05:43+08:06[Asia/Shanghai]",
    );
    // The offset written must be that one, rounded: the exact one and others are refused.
    for (const off of ["-00:44", "+00:00"])
      expect(parseDateTime(`1971-06-01T11:15:30${off}[Africa/Monrovia]`, "UTC", true)).toEqual({
        ok: false,
        why: "malformed",
      });
  });

  it("rounds to the nearest minute, an exact half minute away from zero", () => {
    expect(offsetToMinute(29_999)).toBe(0);
    expect(offsetToMinute(30_000)).toBe(60_000);
    expect(offsetToMinute(-30_000)).toBe(-60_000);
    expect(offsetToMinute(-29_999)).toBe(-0);
    expect(offsetToMinute(-2_670_000)).toBe(-2_700_000);
    expect(offsetToMinute(29_023_000)).toBe(29_040_000);
  });

  it("the ends of the range on the zone's wall clock; beyond them, an error", () => {
    expect(roundTrip("9999-12-31T15:59:59.999Z", "Asia/Shanghai")).toBe(
      "9999-12-31T23:59:59.999+08:00[Asia/Shanghai]",
    );
    expect(roundTrip("0001-01-01T05:00:00.000Z", "America/New_York")).toBe(
      "0001-01-01T00:03:58-04:56[America/New_York]",
    );
    // A write refuses these (the year on the wall clock is 10000, and 0): never written out.
    expect(() => zonedText("9999-12-31T16:00:00.000Z", "Asia/Shanghai")).toThrow();
    expect(() => zonedText("0001-01-01T00:00:00.000Z", "America/New_York")).toThrow();
    // Outside the instants the event format holds, or no instant at all: its own error, not the
    // runtime's (a RangeError from Intl).
    for (const bad of ["10000-01-01T00:00:00.000Z", "0000-12-31T23:59:59.999Z", "not an instant"])
      expect(() => zonedText(bad, "UTC"), bad).toThrow(/out of range/);
  });

  it("a zone the runtime maps to another name is written as recorded", () => {
    expect(roundTrip("2026-11-10T04:31:00.000Z", "US/Eastern")).toBe(
      "2026-11-09T23:31:00-05:00[US/Eastern]",
    );
  });

  it("valueOut changes a zoned value only", () => {
    expect(valueOut({ instant: "2026-11-10T04:31:00.000Z", zone: "Asia/Shanghai" } as never)).toBe(
      "2026-11-10T12:31:00+08:00[Asia/Shanghai]",
    );
    for (const v of ["x", true, null, { value: "1.5", unit: "km" }])
      expect(valueOut(v as never)).toEqual(v);
  });

  it("a value without a zone, kept in a slot west of UTC: the year on its wall clock in range", () => {
    const field = { id: "f1", name: "at", type: "zoned_datetime", description: "when" } as never;
    const write = (v: string) =>
      normalizeValue(field, v, { op: 0, name: "at", zone: "America/New_York", kept: true });
    // 0001-01-01T00:00Z is 0000-12-31 on New York's wall clock: out of range.
    expect(write("0001-01-01T00:00:00Z")).toMatchObject({
      ok: false,
      detail: { code: "out_of_range" },
    });
    // Its first moment of year 1 (local mean time, -04:56:02) is in range, and comes back as is.
    expect(write("0001-01-01T04:56:02Z")).toMatchObject({ ok: true });
    expect(roundTrip("0001-01-01T04:56:02.000Z", "America/New_York")).toBe(
      "0001-01-01T00:00:00-04:56[America/New_York]",
    );
  });

  it("an object {instant, zone} is refused with the string to write instead", () => {
    const field = { id: "f1", name: "at", type: "zoned_datetime", description: "when" } as never;
    const write = (v: unknown) =>
      normalizeValue(field, v, { op: 0, name: "at", zone: "Asia/Shanghai", kept: true });
    expect(write({ instant: "2026-11-10T04:31:00Z", zone: "Asia/Tokyo" })).toEqual({
      ok: false,
      detail: {
        op: 0,
        field: "at",
        code: "type_mismatch",
        suggestion: "2026-11-10T13:31:00+09:00[Asia/Tokyo]",
        // The type's example stays in the slot's zone: it does not depend on the value given.
        example: "2026-11-12T09:30:00+08:00[Asia/Shanghai]",
      },
    });
    // No zone named: the slot's.
    expect(write({ instant: "2026-11-10T04:31:00Z" })).toMatchObject({
      detail: { suggestion: "2026-11-10T12:31:00+08:00[Asia/Shanghai]" },
    });
    // Nothing to work from: no suggestion.
    for (const v of [
      42,
      { at: "x" },
      { instant: "soon" },
      { instant: "2026-11-10T04:31:00Z", zone: "Mars/Base" },
    ])
      expect(write(v), JSON.stringify(v)).toEqual({
        ok: false,
        detail: {
          op: 0,
          field: "at",
          code: "type_mismatch",
          example: "2026-11-12T09:30:00+08:00[Asia/Shanghai]",
        },
      });
  });

  it("Z with a zone: that UTC instant, in that zone; an offset of zero must still agree", () => {
    for (const z of ["Z", "z"]) {
      const p = parseDateTime(`2026-11-10T04:31:00${z}[Asia/Shanghai]`, "UTC", true);
      expect(p, z).toMatchObject({ ok: true, zone: "Asia/Shanghai", assumed: false });
      const instant = new Date((p as { epochMs: number }).epochMs).toISOString();
      expect(instant).toBe("2026-11-10T04:31:00.000Z");
      expect(roundTrip(instant, "Asia/Shanghai")).toBe("2026-11-10T12:31:00+08:00[Asia/Shanghai]");
    }
    for (const off of ["+00:00", "-00:00"])
      expect(parseDateTime(`2026-11-10T04:31:00${off}[Asia/Shanghai]`, "UTC", true), off).toEqual({
        ok: false,
        why: "malformed",
      });
    // Z without a zone: the instant in UTC, the zone the default one, as before.
    expect(parseDateTime("2026-11-10T04:31:00Z", "Asia/Shanghai", true)).toMatchObject({
      ok: true,
      zone: undefined,
      assumed: false,
    });
  });

  it("a clock going back by less than a minute: the exact offset first; a stored value names itself", () => {
    // America/Anchorage, 1900-08-20: -09:59:36 to -10:00:00, so 11:59:36 on the wall clock happens
    // at 21:59:12Z (-09:59:36, rounded -10:00) and again at 21:59:36Z (-10:00 exactly).
    const text = "1900-08-20T11:59:36-10:00[America/Anchorage]";
    expect(zonedText("1900-08-20T21:59:12.000Z", "America/Anchorage")).toBe(text);
    expect(roundTrip("1900-08-20T21:59:36.000Z", "America/Anchorage")).toBe(text);
    const field = { id: "f1", name: "at", type: "zoned_datetime", description: "when" } as never;
    const value = (v: string, kept?: true) =>
      normalizeValue(field, v, {
        op: 0,
        name: "at",
        zone: "America/Anchorage",
        ...(kept ? { kept } : {}),
      });
    // Stored: the earlier instant's text names the later one, so it cannot be stored.
    expect(value("1900-08-20T21:59:12Z", true)).toMatchObject({
      ok: false,
      detail: { code: "out_of_range" },
    });
    expect(value("1900-08-20T21:59:36Z", true)).toMatchObject({ ok: true });
    // Only compared (a condition): no such check.
    expect(value("1900-08-20T21:59:12Z")).toMatchObject({ ok: true });
  });

  it("a positive exact half minute rounds away from zero too", () => {
    expect(offsetAt(Date.parse("1900-01-01T00:00:00Z"), "Asia/Omsk")).toBe(17_610_000);
    expect(roundTrip("1900-01-01T00:00:00.000Z", "Asia/Omsk")).toBe(
      "1900-01-01T04:53:30+04:54[Asia/Omsk]",
    );
    expect(roundTrip("0001-06-01T00:00:00.000Z", "Europe/Amsterdam")).toBe(
      "0001-06-01T00:17:30+00:18[Europe/Amsterdam]",
    );
  });

  it("across midnight, and milliseconds written with three digits", () => {
    expect(roundTrip("2026-12-31T15:59:59.999Z", "Asia/Shanghai")).toBe(
      "2026-12-31T23:59:59.999+08:00[Asia/Shanghai]",
    );
    expect(roundTrip("2026-12-31T16:00:00.000Z", "Asia/Shanghai")).toBe(
      "2027-01-01T00:00:00+08:00[Asia/Shanghai]",
    );
    expect(roundTrip("2026-11-10T04:31:00.010Z", "UTC")).toBe("2026-11-10T04:31:00.010+00:00[UTC]");
    expect(roundTrip("2026-11-10T04:31:00.100Z", "UTC")).toBe("2026-11-10T04:31:00.100+00:00[UTC]");
  });

  it("a clock going back half an hour: each instant of the repeated half hour back to itself", () => {
    // Australia/Lord_Howe, 2026-04-05: +11:00 to +10:30 at 02:00, so 01:30–02:00 happens twice.
    expect(roundTrip("2026-04-04T14:30:00.000Z", "Australia/Lord_Howe")).toBe(
      "2026-04-05T01:30:00+11:00[Australia/Lord_Howe]",
    );
    expect(roundTrip("2026-04-04T15:00:00.000Z", "Australia/Lord_Howe")).toBe(
      "2026-04-05T01:30:00+10:30[Australia/Lord_Howe]",
    );
  });

  it("an offset and a zone written in the hour a clock skips: refused, either offset", () => {
    // America/New_York, 2026-03-08: 02:00–03:00 does not happen.
    for (const off of ["-05:00", "-04:00"])
      expect(
        parseDateTime(`2026-03-08T02:30:00${off}[America/New_York]`, "UTC", true),
        off,
      ).toEqual({ ok: false, why: "malformed" });
  });
});
