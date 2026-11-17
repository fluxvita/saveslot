// Date and time text of requests (docs/zh-CN/spec/04-contract-types.md §1.3; 04-contract §1, §4):
// dates `YYYY-MM-DD` from 0001 to 9999; instants by RFC 3339 with an offset, or without one (read in
// the slot's time zone, with a `timezone_assumed` warning); zoned date-times by RFC 9557, an instant
// with an optional `[Zone]` suffix (`UTC` or Area/Location, known to the runtime). Every instant lies
// in 0001–9999 in UTC. Precision is the millisecond: finer digits must be zeros. A
// local time a transition skips resolves later by the gap, one it repeats to the earlier instant
// (../time/zone.ts).

import type { DateStr, Instant } from "@fluxvita/saveslot-contract-core";
import { isDate } from "@fluxvita/saveslot-contract-core";
import { instantsAt, localToInstant, offsetAt, offsetToMinute, zoneName } from "../time/index.ts";

const DATE_TIME =
  /^(\d{4})-(\d{2})-(\d{2})[Tt ](\d{2}):(\d{2}):(\d{2})(?:\.(\d{1,9}))?(Z|z|[+-]\d{2}:\d{2})?(?:\[([^\]!=\s]+)\])?$/;

export function validDate(s: string): s is DateStr {
  return isDate(s) && s >= "0001-01-01" && s <= "9999-12-31";
}

/** The instants the event format can write: 0001-01-01 to 9999-12-31, in UTC. */
const FIRST_MS = Date.parse("0001-01-01T00:00:00.000Z");
const LAST_MS = Date.parse("9999-12-31T23:59:59.999Z");
export const instantInRange = (ms: number): boolean => ms >= FIRST_MS && ms <= LAST_MS;

/** An instant as the event format writes it: UTC, milliseconds, `Z`. */
export const instantText = (ms: number): Instant => new Date(ms).toISOString() as Instant;

export type ParsedDateTime =
  | {
      readonly ok: true;
      readonly epochMs: number;
      /** Neither an offset nor a zone was written: read in the default zone. */
      readonly assumed: boolean;
      /** The zone written in brackets, normalized (../time/zone.ts `zoneName`), if any. */
      readonly zone: string | undefined;
      /** The zone as written in brackets, if any. */
      readonly zoneText: string | undefined;
    }
  /** `out_of_range`: a valid date-time whose instant lies outside 0001–9999 in UTC. */
  | { readonly ok: false; readonly why: "malformed" | "out_of_range" };

const MALFORMED = { ok: false, why: "malformed" } as const;

/**
 * Date-time text: with an offset, read as written; without one, in the bracketed zone if given,
 * else in `defaultZone`. `malformed` when it is not of the form, not a calendar time, finer than a
 * millisecond, has an offset outside RFC 3339's hours 00–23 and minutes 00–59, names a zone that is
 * not accepted, or has an offset that is not its zone's at that wall-clock time, rounded to the
 * minute.
 */
export function parseDateTime(s: string, defaultZone: string, allowZone: boolean): ParsedDateTime {
  const m = DATE_TIME.exec(s);
  if (m === null) return MALFORMED;
  const [, y, mo, d, h, mi, se, frac = "", off, zoneText] = m;
  let zone: string | undefined;
  if (zoneText !== undefined) {
    zone = allowZone ? zoneName(zoneText) : undefined;
    if (zone === undefined) return MALFORMED;
  }
  if (!/^0*$/.test(frac.slice(3))) return MALFORMED;
  const ms = Number(frac.slice(0, 3).padEnd(3, "0"));
  if (!validDate(`${y}-${mo}-${d}`)) return MALFORMED;
  if (Number(h) > 23 || Number(mi) > 59 || Number(se) > 59) return MALFORMED;
  const t = new Date(0);
  t.setUTCFullYear(Number(y), Number(mo) - 1, Number(d));
  t.setUTCHours(Number(h), Number(mi), Number(se), ms);
  const local = t.getTime();
  let epochMs: number;
  if (off === undefined) {
    epochMs = localToInstant(local, zone ?? defaultZone).epochMs;
  } else {
    let offsetMs = 0;
    if (off !== "Z" && off !== "z") {
      const oh = Number(off.slice(1, 3));
      const om = Number(off.slice(4, 6));
      if (oh > 23 || om > 59) return MALFORMED;
      offsetMs = (off.startsWith("-") ? -1 : 1) * (oh * 60 + om) * 60_000;
    }
    // `Z` says the instant is UTC and the local offset unknown (RFC 9557): with a zone, that UTC
    // instant in that zone, nothing to agree with. Any written offset, `+00:00` too, must agree.
    if (zone === undefined || off === "Z" || off === "z") {
      epochMs = local - offsetMs;
    } else {
      // With a zone, the offset must be the zone's own offset at that wall-clock time, exactly or
      // rounded to the minute as a zoned date-time is written (04-contract-types §1.3): the instant
      // is then the zone's, to the second. Of two at that wall-clock time (a clock going back), the
      // one whose offset is exactly the one written, else the one it rounds to. Otherwise the
      // offset disagrees with the zone (RFC 9557): refused.
      const candidates = instantsAt(local, zone);
      const at =
        candidates.find((t) => offsetAt(t, zone) === offsetMs) ??
        candidates.find((t) => offsetToMinute(offsetAt(t, zone)) === offsetMs);
      if (at === undefined) return MALFORMED;
      epochMs = at;
    }
  }
  if (!instantInRange(epochMs)) return { ok: false, why: "out_of_range" };
  return { ok: true, epochMs, assumed: off === undefined && zone === undefined, zone, zoneText };
}
