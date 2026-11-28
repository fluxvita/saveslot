// The anchor store port (docs/zh-CN/spec/02-architecture.md §8 «锚点存储»;
// entries: docs/zh-CN/spec/03-data-model/03-deletion.md «删除登记»).
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

/**
 * Why an anchor store refused or failed an operation. `code` is stable; the message is for people
 * and never carries the stored content.
 * - `invalid_entry`: a deletion entry, seq or count given to a write is not of the port's shape.
 * - `not_in_progress`: `endRestore` / `endImport` / `abortImport` with no such marker, or with
 *   another ID.
 * - `import_refused`: `beginImport` on an anchor that is not empty.
 * - `corrupt`: the stored anchor cannot be read (implementation).
 * - `conflict`: another writer changed the stored anchor (implementation).
 */
export type AnchorStoreErrorCode =
  | "invalid_entry"
  | "not_in_progress"
  | "import_refused"
  | "corrupt"
  | "conflict";

export class AnchorStoreError extends Error {
  readonly code: AnchorStoreErrorCode;
  constructor(code: AnchorStoreErrorCode, message: string, opts: { cause?: unknown } = {}) {
    super(message, opts.cause === undefined ? undefined : { cause: opts.cause });
    this.name = "AnchorStoreError";
    this.code = code;
  }
}

/**
 * The anchor store port. The high water mark never decreases on any path: `advanceHighWater`,
 * `endRestore` and `endImport` each keep the larger of the stored and the given value.
 */
export interface AnchorStore {
  /** The tenant's anchor; a tenant never written has the empty anchor (no entries, 0, 0). */
  read(tenant: TenantId): Promise<Anchor>;
  /** Adds an entry or replaces the entry with the same deletion ID as a whole. */
  putDeletion(tenant: TenantId, entry: DeletionEntry): Promise<void>;
  /** Removes the entry with this deletion ID; nothing when there is none. */
  removeDeletion(tenant: TenantId, deletion: DeletionId): Promise<void>;
  /** Only increases; a lower value is ignored. */
  advanceHighWater(tenant: TenantId, seq: Seq): Promise<void>;
  /**
   * Sets "restore in progress" and increments the restore count. If a restore is already in
   * progress, returns the anchor unchanged.
   */
  beginRestore(tenant: TenantId, restore: RestoreId): Promise<Anchor>;
  /**
   * Clears "restore in progress" and advances the high water mark to `highWater` (never lowers
   * it). `not_in_progress` when no restore, or another restore, is in progress.
   */
  endRestore(tenant: TenantId, restore: RestoreId, highWater: Seq): Promise<void>;
  /**
   * Sets "import in progress". Refused (`import_refused`) when the anchor is not empty: any
   * deletion entry, a non-zero restore count, or any in-progress marker, including this import's.
   */
  beginImport(tenant: TenantId, importId: ImportId): Promise<void>;
  /**
   * Writes, in one durable write, the deletion entries derived from the imported log, the high
   * water mark (never lowering it) and the restore count, and clears the marker.
   * `not_in_progress` when no import, or another import, is in progress.
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
  /**
   * Clears only the "import in progress" marker, writes no entries (rollback). Nothing when no
   * import is in progress (re-entry may call it twice); `not_in_progress` for another import.
   */
  abortImport(tenant: TenantId, importId: ImportId): Promise<void>;
}
