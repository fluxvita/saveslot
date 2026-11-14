// Time zone arithmetic for business time (docs/zh-CN/spec/03-data-model/05-time.md: a date is the
// slot time zone's natural day; 04-contract §1 «值的编码», §4 «日期与时刻的换算»): the day an
// instant falls on in a zone, the instant a local date-time names in a zone, the start of a day.
//
// Provisional: computed with the runtime's `Intl` time zone data, so results can change with the
// runtime's ICU version. The spec pins the time zone database to the saveslot version (11 «时间»;
// 02 §8 meta); pinning it is open, together with the time zone name check in the schema compiler.
//
// A local date-time that does not exist in the zone (skipped by a forward transition) resolves
// later, by the length of the gap; one that occurs twice (a backward transition) resolves to the
// earlier instant. This is RFC 9557 / Temporal's "compatible" disambiguation.

const HOUR = 3_600_000;

/** A time zone name's shape: `UTC` or Area/Location (the slot time zone's rule, 07 «文档结构»). */
const ZONE_SHAPE = /^(?:UTC|[A-Za-z0-9_+-]+(?:\/[A-Za-z0-9_+-]+)+)$/;

/**
 * Formatters by the runtime's own name for their zone, so the cache holds at most one per zone the
 * runtime knows, however callers spell the names.
 */
const formatters = new Map<string, Intl.DateTimeFormat>();

/** Throws a RangeError for a zone the runtime does not know. */
function makeFormatter(zone: string): Intl.DateTimeFormat {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: zone,
    hourCycle: "h23",
    era: "short",
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
    hour: "2-digit",
    minute: "2-digit",
    second: "2-digit",
  });
}

function formatter(zone: string): Intl.DateTimeFormat {
  const hit = formatters.get(zone);
  if (hit !== undefined) return hit;
  const f = makeFormatter(zone);
  const id = f.resolvedOptions().timeZone;
  const known = formatters.get(id);
  if (known !== undefined) return known;
  formatters.set(id, f);
  return f;
}

/**
 * The name to record for a time zone a caller wrote, or `undefined` when it is not accepted: it must
 * be `UTC` or Area/Location and known to the runtime. A name that differs from the runtime's own
 * name only in ASCII case takes the runtime's spelling (`asia/shanghai` → `Asia/Shanghai`); a name
 * the runtime maps to another one (an alias: `US/Eastern`) is kept as written. Unifying aliases
 * waits for the pinned time zone database (provisional, as above).
 */
export function zoneName(name: string): string | undefined {
  if (!ZONE_SHAPE.test(name)) return undefined;
  if (formatters.has(name)) return name;
  let id: string;
  try {
    id = formatter(name).resolvedOptions().timeZone;
  } catch {
    return undefined;
  }
  return id.toLowerCase() === name.toLowerCase() ? id : name;
}

/** The local wall-clock fields of an instant in a zone, as milliseconds since the epoch "in UTC". */
function localMs(epochMs: number, zone: string): number {
  const parts = formatter(zone).formatToParts(new Date(epochMs));
  const get = (type: Intl.DateTimeFormatPartTypes) =>
    Number(parts.find((p) => p.type === type)?.value);
  const bc = parts.find((p) => p.type === "era")?.value === "BC";
  const year = bc ? 1 - get("year") : get("year");
  const d = new Date(0);
  d.setUTCFullYear(year, get("month") - 1, get("day"));
  d.setUTCHours(get("hour"), get("minute"), get("second"), 0);
  return d.getTime() + (((epochMs % 1000) + 1000) % 1000);
}

/** The zone's offset from UTC at an instant, in milliseconds (local = instant + offset). */
export function offsetAt(epochMs: number, zone: string): number {
  return localMs(epochMs, zone) - epochMs;
}

/** `YYYY-MM-DD` of a time value read as UTC fields. */
function ymd(ms: number): string {
  const d = new Date(ms);
  const y = d.getUTCFullYear();
  const pad = (n: number, w = 2) => String(n).padStart(w, "0");
  return `${pad(y, 4)}-${pad(d.getUTCMonth() + 1)}-${pad(d.getUTCDate())}`;
}

/** The day an instant falls on in the zone. */
export function dateInZone(epochMs: number, zone: string): string {
  return ymd(localMs(epochMs, zone));
}

export interface LocalResolution {
  readonly epochMs: number;
  /** `gap`: the local time does not exist (resolved later); `overlap`: it occurs twice (earlier taken). */
  readonly kind: "exact" | "gap" | "overlap";
}

/**
 * The instant a local date-time names in the zone. `local` is the wall-clock fields as milliseconds
 * since the epoch "in UTC" (`Date.UTC(...)`).
 */
export function localToInstant(local: number, zone: string): LocalResolution {
  // Offsets a day around the local time cover any one transition.
  const before = offsetAt(local - 24 * HOUR, zone);
  const after = offsetAt(local + 24 * HOUR, zone);
  const candidates = [...new Set([local - before, local - after])]
    .filter((t) => localMs(t, zone) === local)
    .sort((a, b) => a - b);
  const [first] = candidates;
  if (first !== undefined) {
    return { epochMs: first, kind: candidates.length > 1 ? "overlap" : "exact" };
  }
  // Skipped: shift forward by the gap, i.e. read it with the offset in force before the gap.
  return { epochMs: local - before, kind: "gap" };
}

/** The first instant of a day in the zone (midnight, or the first local time after a gap at it). */
export function startOfDay(date: string, zone: string): number {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d);
  return localToInstant(t.getTime(), zone).epochMs;
}

/** The day after a `YYYY-MM-DD` date. */
export function nextDay(date: string): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d + 1);
  return ymd(t.getTime());
}
