// The anchor store port (docs/zh-CN/spec/02-architecture.md §8 "锚点存储";
// entries: docs/zh-CN/spec/03-data-model/03-deletion.md "删除登记").
//
// The anchor store keeps what must be remembered after a tenant's storage is replaced as a whole:
// the deletion registry, the `seq` high water mark, the restore count, and the "restore in progress"
// and "import in progress" markers. It must be stored and backed up separately from the tenant
// storage. Every write must be durable before the returned promise resolves.

/** Tenant ID (`tn_…`). */
export type TenantId = string;
/** Deletion ID; the same as the pending item ID of the deletion (`pi_…`). */
export type DeletionId = string;
/** Restore ID (`rs_…`). */
export type RestoreId = string;
/** Import ID: names the staging storage and pairs with the "import in progress" marker; not in any event. */
export type ImportId = string;
/** Log position. */
export type Seq = number;
/** UTC instant with millisecond precision, e.g. `2026-11-10T04:41:07.123Z`. */
export type Instant = string;

/**
 * Registry entry state.
 * - `intent`: written before the tenant transaction; whether that transaction committed is unknown.
 * - `pending`: confirmed, waiting to be executed.
 * - `cancelled`: cancelled within the grace period.
 * - `executed`: physically deleted.
 */
export const DELETION_ENTRY_STATES = ["intent", "pending", "cancelled", "executed"] as const;
export type DeletionEntryState = (typeof DELETION_ENTRY_STATES)[number];

/** Deletion kinds. v1 has privacy deletion by source data only; evidence deletion comes later. */
export const DELETION_KINDS = ["privacy"] as const;
export type DeletionKind = (typeof DELETION_KINDS)[number];

/** Opaque address of a content block: `(seq, path)`. Paths never contain user content. */
export interface BlockPosition {
  readonly seq: Seq;
  readonly path: string;
}

/**
 * One deletion in the registry. Stores no content: only IDs, kind, state, due time, the seq of
 * the confirmation event, and the opaque positions of the deleted sources and content blocks.
 */
export interface DeletionEntry {
  readonly deletion: DeletionId;
  readonly kind: DeletionKind;
  readonly state: DeletionEntryState;
  /** Due time of the physical deletion. Authoritative: restore keeps the registry's value. */
  readonly dueAt: Instant;
  /**
   * `seq` of the `deletion.confirmed` event. Every state has it: entries are written under the
   * tenant's serial write lock, so the seq the confirmation event will get is known when the
   * `intent` entry is written.
   */
  readonly confirmedSeq: Seq;
  /** The deleted source data, by the `seq` of their `source.recorded` events. */
  readonly sources: readonly Seq[];
  /** The content blocks the deletion removes at expiry. */
  readonly positions: readonly BlockPosition[];
}

/** Everything the anchor store holds for one tenant. */
export interface Anchor {
  readonly deletions: readonly DeletionEntry[];
  /** Highest `seq` known to have been allocated. Never decreases; never above the committed log end. */
  readonly highWater: Seq;
  /** Restore count; starts at 0, +1 on each restore and on import. */
  readonly restoreCount: number;
  /** Set while a restore is in progress; the restore flow re-enters on it. */
  readonly restoreInProgress?: RestoreId;
  /** Set while an import is in progress; `openTenant` checks it first. */
  readonly importInProgress?: ImportId;
}

export interface AnchorStore {
  read(tenant: TenantId): Promise<Anchor>;
  /** Adds an entry or replaces the entry with the same deletion ID as a whole. */
  putDeletion(tenant: TenantId, entry: DeletionEntry): Promise<void>;
  removeDeletion(tenant: TenantId, deletion: DeletionId): Promise<void>;
  /** Only increases; a lower value is ignored. */
  advanceHighWater(tenant: TenantId, seq: Seq): Promise<void>;
  /**
   * Sets "restore in progress" and increments the restore count. If a restore is already in
   * progress, returns the anchor unchanged.
   */
  beginRestore(tenant: TenantId, restore: RestoreId): Promise<Anchor>;
  endRestore(tenant: TenantId, restore: RestoreId, highWater: Seq): Promise<void>;
  /**
   * Sets "import in progress". Refused when the anchor is not empty: any deletion entry, a
   * non-zero restore count, or any in-progress marker.
   */
  beginImport(tenant: TenantId, importId: ImportId): Promise<void>;
  /**
   * Writes, in one durable write, the deletion entries derived from the imported log, the high
   * water mark and the restore count, and clears the marker.
   */
  endImport(
    tenant: TenantId,
    importId: ImportId,
    r: {
      readonly deletions: readonly DeletionEntry[];
      readonly highWater: Seq;
      readonly restoreCount: number;
    },
  ): Promise<void>;
  /** Clears only the "import in progress" marker, writes no entries (rollback). */
  abortImport(tenant: TenantId, importId: ImportId): Promise<void>;
}
