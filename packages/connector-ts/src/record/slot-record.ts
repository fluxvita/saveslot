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

/**
 * What a `write` did, summed over its writes. Each record given is counted once, in `created`,
 * `updated`, `unchanged`, `awaiting`, `skipped` or `replayed`, as its part of the write ended.
 */
export interface WriteResult {
  /** Records given. */
  records: number;
  /** Rows added by this call. */
  created: number;
  /** Records written by source key that changed the row they found. */
  updated: number;
  /**
   * Records written by source key that brought nothing new: as last delivered, or kept from a
   * change made in saveslot since. No event is recorded for them.
   */
  unchanged: number;
  /**
   * Records written by source key none of whose fields took effect, some of them waiting for the
   * user: a candidate (the field was changed in saveslot since the last delivery), or a change to
   * confirm. Their items are in `pending`. A record with any field in effect is `updated`.
   */
  awaiting: number;
  /**
   * Records written by source key and not written: the user revoked the row the key found, or a
   * deletion that can still be undone holds the key. They are not written back.
   */
  skipped: number;
  /**
   * Records in writes the service had already applied under the same key: sent again, applied
   * once, so not counted in `created` again.
   */
  replayed: number;
  /** Items left for the user to resolve (conflicts, confirmations, suspected duplicates). */
  pending: number;
}

export function emptyWriteResult(): WriteResult {
  return {
    records: 0,
    created: 0,
    updated: 0,
    unchanged: 0,
    awaiting: 0,
    skipped: 0,
    replayed: 0,
    pending: 0,
  };
}

/**
 * The writes by source key for one table's records: the key fields in `external_key`, the rest in
 * `set`, as `update` (04-write-and-read «按来源键写入»). Each record has every key field, not
 * null: checked before.
 */
export function toKeyedOps(
  table: string,
  key: readonly string[],
  records: readonly Readonly<Record<string, unknown>>[],
): WriteOp[] {
  return records.map((record) => {
    const external_key: Record<string, unknown> = Object.create(null);
    const set: Record<string, unknown> = Object.create(null);
    for (const [field, value] of Object.entries(record)) {
      if (key.includes(field)) external_key[field] = value;
      else set[field] = value;
    }
    return { intent: "update", table, external_key, set };
  });
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
