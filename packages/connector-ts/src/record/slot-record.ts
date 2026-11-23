// What a connector writes: records. The developer extends `SlotRecord` with its own record
// classes; the SDK turns them into writes.

import type { WriteOp } from "../client/api.ts";

/**
 * One record to write. Extend it for each kind of record the connector collects, e.g. a
 * `MailMessage` that maps a fetched message to the `messages` table.
 */
export abstract class SlotRecord {
  /** The table the record goes into, as declared in `defineSchema`. */
  abstract table(): string;
  /**
   * Field name → value, written as the operation contract writes values: text for `text` and
   * `enum`, `"5 km"` for a `quantity`, RFC 3339 text for a time.
   */
  abstract fields(): Readonly<Record<string, unknown>>;
}

/** What a `write` did, summed over its writes. */
export interface WriteResult {
  /** Records given. */
  records: number;
  /** Rows added by this call. */
  created: number;
  /**
   * Records in writes the service had already applied under the same key: sent again, applied
   * once, so not counted in `created` again.
   */
  replayed: number;
  /** Items left for the user to resolve (conflicts, confirmations, suspected duplicates). */
  pending: number;
}

export function emptyWriteResult(): WriteResult {
  return { records: 0, created: 0, replayed: 0, pending: 0 };
}

/**
 * The inserts for one table's records. `set` is built on an object with no prototype, so every
 * field name, `__proto__` included, is an own key of it and is sent.
 */
export function toOps(
  table: string,
  records: readonly Readonly<Record<string, unknown>>[],
): WriteOp[] {
  return records.map((record) => {
    const set: Record<string, unknown> = Object.create(null);
    for (const [field, value] of Object.entries(record)) set[field] = value;
    return { intent: "insert", table, set };
  });
}
