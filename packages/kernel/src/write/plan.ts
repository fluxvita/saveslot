// Pure pieces of the write pipeline (02-architecture §4 L5 `write`): what a compiled table is to
// `judge`, whether a write must refresh derived tables, and "today" in the slot's time zone.

import type { CompiledBaseTable, FieldId } from "@fluxvita/saveslot-contract-core";
import type { TableShape } from "../judge/index.ts";
import { valuedFields } from "../pending/index.ts";

/** The table as `judge` sees it (judge/model.ts `TableShape`). */
export function tableShape(t: CompiledBaseTable): TableShape {
  const required = t.fields.filter((f) => f.required === true).map((f) => f.id);
  return {
    kind: t.time.type === "state" ? "state" : t.time.type === "event" ? "event" : "timeless",
    fields: t.fields.map((f) => f.id),
    // "Has a value" is judged on the required fields without a constant backfill (05-time «无值区间»).
    // Apply's settle, and the readers of the version table after it, count every required field:
    // the two differ only on a required field with a constant backfill, which this version's schema
    // cannot create; to be made one with schema evolution (../pending `valuedFields`).
    valued: valuedFields(t),
    required,
    groups: (t.together ?? []).map((g) => [...g] as FieldId[]),
  };
}

/**
 * Whether the caller may write `table` of `slot`. The first version always passes every slot and
 * table (`visibility: all`); scoped visibility is not implemented, and this is where it will be
 * decided (04-write-and-read «可见范围»).
 */
export function writable(visibility: { readonly kind: string }, _slot: string, _table?: string) {
  return visibility.kind === "all";
}

/** The date of `now` in time zone `tz`, as YYYY-MM-DD (05-time «今天»). */
export function todayIn(now: string, tz: string): string {
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date(now));
  const get = (k: string) => parts.find((p) => p.type === k)?.value ?? "";
  return `${get("year")}-${get("month")}-${get("day")}`;
}

/**
 * Whether a `ver` names a version of the row (04-contract `ver`: an operation not of this row or
 * entity is `not_this_target`): its operation one of the row's versions (01-objects «版本标记»),
 * its restore count the current one. Restoring backups is not done yet, so a count other than the
 * current one cannot come from this timeline.
 */
export function verOfRow(
  ver: { readonly op: number; readonly restoreCount: number },
  versions: ReadonlySet<number>,
  currentRestoreCount: number,
): boolean {
  return ver.restoreCount === currentRestoreCount && versions.has(ver.op);
}
