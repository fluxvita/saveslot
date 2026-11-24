// Pure pieces of the write pipeline (02-architecture §4 L5 `write`): what a compiled table is to
// `judge`, whether a write must refresh derived tables, and "today" in the slot's time zone.

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import type { TableShape } from "../judge/index.ts";
import { valuedFields } from "../pending/index.ts";
import type { Visibility } from "../request/index.ts";

/**
 * Whether rows of `table` may be referred to (`TableShape.referable`): a ref field of the
 * slot names it in any of `versions`, every schema version the log has had for the slot (a
 * reference written under an earlier version stays in the log). Better refuse more than judge a
 * revoke again without its referrers.
 */
export function referableIn(versions: readonly CompiledSchema[], table: TableId): boolean {
  return versions.some((v) =>
    v.tables.some(
      (t) =>
        t.kind === "base" &&
        (t as CompiledBaseTable).fields.some(
          (f) => f.type === "ref" && (f as { ref?: { table: TableId } }).ref?.table === table,
        ),
    ),
  );
}

/**
 * The table as a deletion's replay sees it: `tableShape` with `referable` given, from every schema
 * version the slot has had (`referableIn`). The deletion phase builds its shapes with this: the
 * replay refuses a revoke it cannot judge without knowing (judge/replay-deletion.ts).
 */
export function replayShape(t: CompiledBaseTable, versions: readonly CompiledSchema[]): TableShape {
  return { ...tableShape(t), referable: referableIn(versions, t.id) };
}

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
    ...(t.time.type !== "state" && t.external_key !== undefined
      ? { keyFields: [...t.external_key] as FieldId[] }
      : {}),
  };
}

/**
 * Whether the caller may write `table` (its ID) of `slot`, or anything in `slot` when no table is
 * given: whatever is in its range (04-write-and-read «可见范围»: 写入, 待处理事项、resolve). A slot
 * out of range, or a table its range does not list, is not writable, as it is not visible.
 */
export function writable(visibility: Visibility, slot: string, table?: string): boolean {
  if (visibility.kind === "all") return true;
  const scope = visibility.slots.find((s) => s.slot === slot);
  if (scope === undefined) return false;
  return (
    table === undefined || scope.tables === undefined || scope.tables.some((t) => t.table === table)
  );
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
 * entity is `not_this_target`), given where it reads (`seenOfVer`): one that reads its own
 * operation (this restore count, or one less and not past the restore point) must be one of the
 * row's versions (01-objects «版本标记»); one that reads at the restore point is not checked, its
 * operation not being one of this timeline's.
 */
export function verOfRow(
  ver: { readonly op: number; readonly restoreCount: number },
  versions: ReadonlySet<number>,
  read: { readonly own: boolean },
): boolean {
  return !read.own || versions.has(ver.op);
}
