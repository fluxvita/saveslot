// The business time interval of read results (04-contract-types §1 `Interval`): the start, the end
// (null: open), and on date-grained state tables the last day of an interval that ends.

import type { BizPoint, DateStr } from "@fluxvita/saveslot-contract-core";
import type { Interval } from "./types.ts";

/** The day before a date (`YYYY-MM-DD`). */
export function dayBefore(d: string): DateStr {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, day - 1);
  return t.toISOString().slice(0, 10) as DateStr;
}

/** `[from, to)` as an `Interval`; `byDate`: the table's granularity is date. */
export function intervalOf(
  from: string | null,
  to: string | null | undefined,
  byDate: boolean,
): Interval {
  const end = to ?? null;
  return {
    valid_from: from as BizPoint | null,
    valid_to: end as BizPoint | null,
    ...(byDate && end !== null ? { valid_to_inclusive: dayBefore(end) } : {}),
  };
}
