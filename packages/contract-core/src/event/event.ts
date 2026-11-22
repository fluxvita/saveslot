// A whole event (header + content blocks) and the export file shapes
// (docs/zh-CN/spec/09-event-format.md §1.1, §3.3, §8).

import type { EventType } from "./enums.ts";
import type { EventHeaders } from "./header.ts";
import type { Hash, Instant, JsonValue, Seq, TenantId } from "./values.ts";
import type { EventBlocks, OptionalBlocks, RequiredBlocks } from "./vocabulary.ts";

/** An event of type `T` with all of its blocks present. */
export interface EventOf<T extends EventType> {
  readonly header: EventHeaders[T];
  readonly blocks: EventBlocks<T>;
}

/** Any v1 event. */
export type Event = { [T in EventType]: EventOf<T> }[EventType];

// --- §3.3 block states as written in an export file ---------------------------------------------

/** A present block: its content and checksum (SHA-256 of the content's JCS bytes). */
export interface PresentBlock<V = JsonValue> {
  readonly v: V;
  readonly sum: Hash;
}

/** A block cleared by a tombstone: the tombstone's `seq`. No content, checksum or length. */
export interface RemovedBlock {
  readonly removed_by: Seq;
}

/** A block pending deletion, exported as a placeholder: the earliest confirming deletion's `seq`. */
export interface PendingDeletionBlock {
  readonly pending_deletion: Seq;
}

export type ExportBlockState<V = JsonValue> = PresentBlock<V> | RemovedBlock | PendingDeletionBlock;

// --- §8 export file ---------------------------------------------------------------------------

/** First line of an export file. */
export interface ExportManifest {
  readonly saveslot_export: 1;
  /** Current tenant ID: from the latest `tenant.genesis` or `tenant.imported`. */
  readonly tenant_id: TenantId;
  readonly event_format: 1;
  readonly restore_count: number;
  /** Continuation files only: the file holds events with `seq` greater than this. */
  readonly after?: Seq;
  readonly upto: Seq;
  /** The hash of the header at `upto` (§2.1, as `prev_hash` writes it). */
  readonly upto_hash: string;
  readonly events: number;
  readonly exported_at: Instant;
  readonly pending_deletions: "placeholder" | "included";
}

/** Block states of an export line: blocks every event of the type has are required. */
export type ExportBlocksOf<T extends EventType> = {
  readonly [P in keyof RequiredBlocks<T>]: ExportBlockState<RequiredBlocks<T>[P]>;
} & {
  readonly [P in keyof OptionalBlocks<T>]?: ExportBlockState<NonNullable<OptionalBlocks<T>[P]>>;
};

/**
 * One event line of an export file, typed by event type. `c` is absent when the event has no
 * blocks, so it is required for types with blocks every event has.
 */
export type ExportEventLineOf<T extends EventType> = {
  readonly h: EventHeaders[T];
} & ([keyof RequiredBlocks<T>] extends [never]
  ? { readonly c?: ExportBlocksOf<T> }
  : { readonly c: ExportBlocksOf<T> });

/** Any event line of an export file. */
export type ExportEventLine = { [T in EventType]: ExportEventLineOf<T> }[EventType];
