// Event header (docs/zh-CN/spec/09-event-format.md §2.1, §4.1, §5) as a discriminated union on
// `type`. Each variant has exactly the header fields its type may carry:
//
// - `op` is absent on head events and required on every other event (§4.1).
// - `slot` is absent on tenant-level events (`tenant.*`, `principal.*`) and required elsewhere.
// - `trigger` appears only on head events whose `actor` is `system` (§2.1, §4.6, §6.9).
// - `node_id`, `restore_count`, `restore_id`, `restored_to`, `high_water`, `imported_upto` appear
//   only where §2.1 lists them.
// - `v` is 1 for every type: no type has a second format version yet (§1.6).

import type { Trigger } from "./enums.ts";
import type {
  CallerId,
  Hash,
  Instant,
  NodeId,
  OpNumber,
  PrincipalId,
  RestoreId,
  Seq,
  SlotId,
  SystemPrincipal,
  UserId,
} from "./values.ts";

/** Fields every header has. */
interface HeaderBase<T extends string> {
  readonly seq: Seq;
  readonly v: 1;
  readonly type: T;
  readonly actor: PrincipalId;
  readonly at: Instant;
  readonly prev_hash: Hash;
}

/** Head event (no `op`) caused by a caller: no `trigger`. */
type CallerHead<T extends string, A extends PrincipalId = CallerId> = HeaderBase<T> & {
  readonly actor: A;
  readonly op?: never;
  readonly trigger?: never;
};

/** Head event produced by the kernel itself: `actor` is `system`, with a `trigger`. */
type SystemHead<T extends string, G extends Trigger> = HeaderBase<T> & {
  readonly actor: SystemPrincipal;
  readonly op?: never;
  readonly trigger: G;
};

/** Non-head event: carries `op`, never `trigger`. Its `actor` is the head event's. */
type Member<T extends string> = HeaderBase<T> & {
  readonly op: OpNumber;
  readonly trigger?: never;
};

/** Slot events carry `slot`. */
type InSlot = { readonly slot: SlotId };
/** Tenant-level events carry no `slot`. */
type TenantLevel = { readonly slot?: never };

// --- §5.2 tenant -----------------------------------------------------------------------------

export type TenantGenesisHeader = CallerHead<"tenant.genesis", UserId> &
  TenantLevel & {
    /** Always the first event: `seq` 1, `prev_hash` 64 zeros. */
    readonly seq: 1;
    readonly node_id: NodeId;
  };

export type TenantRestoredHeader = SystemHead<"tenant.restored", "restore"> &
  TenantLevel & {
    readonly node_id: NodeId;
    readonly restore_id: RestoreId;
    readonly restore_count: number;
    readonly restored_to: Seq;
    readonly high_water: Seq;
  };

export type TenantImportedHeader = CallerHead<"tenant.imported", UserId> &
  TenantLevel & {
    readonly node_id: NodeId;
    readonly restore_count: number;
    readonly imported_upto: Seq;
  };

// --- §5.3 principals: head events by a user principal -------------------------------------------

export type PrincipalRegisteredHeader = CallerHead<"principal.registered", UserId> & TenantLevel;
export type PrincipalRenamedHeader = CallerHead<"principal.renamed", UserId> & TenantLevel;
export type PrincipalRevokedHeader = CallerHead<"principal.revoked", UserId> & TenantLevel;

// --- §5.4 slot policy -------------------------------------------------------------------------

/**
 * In v1 `slot.policy_set` only occurs as a member of the slot-creating operation. As a head
 * event it is a reserved shape (§4.1, §10), not part of v = 1, so `op` is required here.
 */
export type SlotPolicySetHeader = Member<"slot.policy_set"> & InSlot;

/** Removing an empty slot (§5.4): a head event by a user principal, in the slot removed. */
export type SlotRemovedHeader = CallerHead<"slot.removed", UserId> & InSlot;

// --- §5.5 schema ------------------------------------------------------------------------------

export type SchemaDraftSubmittedHeader = CallerHead<"schema.draft_submitted"> & InSlot;
export type SchemaCompiledHeader = Member<"schema.compiled"> & InSlot;
export type SchemaConfirmedHeader = Member<"schema.confirmed"> & InSlot;
export type SchemaRejectedHeader = Member<"schema.rejected"> & InSlot;
export type SchemaSupersededHeader = Member<"schema.superseded"> & InSlot;
export type SchemaMigrationStartedHeader = Member<"schema.migration_started"> & InSlot;
/** A member of the submitting / confirming operation, or a head event after a background migration. */
export type SchemaSwitchedHeader =
  | (Member<"schema.switched"> & InSlot)
  | (SystemHead<"schema.switched", "migration"> & InSlot);
export type SchemaMigrationFailedHeader = SystemHead<"schema.migration_failed", "migration"> &
  InSlot;

// --- §5.6 – §5.10 -----------------------------------------------------------------------------

export type SourceRecordedHeader = Member<"source.recorded"> & InSlot;
export type WriteHeadHeader = CallerHead<"write.head"> & InSlot;
export type WriteBaseHeader = Member<"write.base"> & InSlot;
export type WriteDerivedHeader = Member<"write.derived"> & InSlot;
export type ItemCreatedHeader = Member<"item.created"> & InSlot;
export type ItemMergedHeader = Member<"item.merged"> & InSlot;
export type ItemRefreshedHeader = Member<"item.refreshed"> & InSlot;
export type ItemSupersededHeader = Member<"item.superseded"> & InSlot;
export type ItemResolvedHeader = CallerHead<"item.resolved"> & InSlot;
/** By the confirming caller, or by `system` in the restore flow (`trigger: "restore"`). */
export type DeletionConfirmedHeader =
  | (CallerHead<"deletion.confirmed"> & InSlot)
  | (SystemHead<"deletion.confirmed", "restore"> & InSlot);
/** By the cancelling caller, or by `system` in the restore flow (`trigger: "restore"`). */
export type DeletionCancelledHeader =
  | (CallerHead<"deletion.cancelled"> & InSlot)
  | (SystemHead<"deletion.cancelled", "restore"> & InSlot);
export type DeletionExecutedHeader = SystemHead<
  "deletion.executed",
  "deletion_expiry" | "restore_backfill" | "import"
> &
  InSlot;
export type PremiseChangedHeader = Member<"premise.changed"> & InSlot;

/** Header type per event type. */
export interface EventHeaders {
  "tenant.genesis": TenantGenesisHeader;
  "tenant.restored": TenantRestoredHeader;
  "tenant.imported": TenantImportedHeader;
  "principal.registered": PrincipalRegisteredHeader;
  "principal.renamed": PrincipalRenamedHeader;
  "principal.revoked": PrincipalRevokedHeader;
  "slot.policy_set": SlotPolicySetHeader;
  "slot.removed": SlotRemovedHeader;
  "schema.draft_submitted": SchemaDraftSubmittedHeader;
  "schema.compiled": SchemaCompiledHeader;
  "schema.confirmed": SchemaConfirmedHeader;
  "schema.rejected": SchemaRejectedHeader;
  "schema.superseded": SchemaSupersededHeader;
  "schema.migration_started": SchemaMigrationStartedHeader;
  "schema.switched": SchemaSwitchedHeader;
  "schema.migration_failed": SchemaMigrationFailedHeader;
  "source.recorded": SourceRecordedHeader;
  "write.head": WriteHeadHeader;
  "write.base": WriteBaseHeader;
  "write.derived": WriteDerivedHeader;
  "item.created": ItemCreatedHeader;
  "item.merged": ItemMergedHeader;
  "item.refreshed": ItemRefreshedHeader;
  "item.superseded": ItemSupersededHeader;
  "item.resolved": ItemResolvedHeader;
  "deletion.confirmed": DeletionConfirmedHeader;
  "deletion.cancelled": DeletionCancelledHeader;
  "deletion.executed": DeletionExecutedHeader;
  "premise.changed": PremiseChangedHeader;
}

/** Any v1 event header. */
export type EventHeader = EventHeaders[keyof EventHeaders];

/** The `prev_hash` of the first event (tenant genesis): 64 zeros (§1.5). */
export const GENESIS_PREV_HASH = "0".repeat(64);

/**
 * The header fields that exist in v1 (§2.1: "除此之外，事件头没有别的字段"). Which of them a given
 * type may carry is defined by the types above and by HEADER_RULES.
 */
export const HEADER_FIELDS = [
  "seq",
  "v",
  "type",
  "actor",
  "at",
  "prev_hash",
  "op",
  "slot",
  "trigger",
  "node_id",
  "restore_count",
  "restore_id",
  "restored_to",
  "high_water",
  "imported_upto",
] as const;
export type HeaderField = (typeof HEADER_FIELDS)[number];

/**
 * Runtime summary of the header rules per type, for strict parsing:
 * - `head`: whether the event is a head event (`op` absent), a member (`op` required), or either
 *   (`schema.switched`: a head event only when produced by `system` with `trigger: "migration"`).
 * - `actor`: who may be the actor of a head event: `user` (a user principal), `caller` (user or
 *   connection), `system`, or `caller_or_system`. Members take the head event's actor (`any`).
 * - `slot`: whether `slot` is required (otherwise it is absent).
 * - `triggers`: the triggers a head event by `system` may carry; `trigger` is present exactly when
 *   the head event's actor is `system`.
 * - `extra`: type-specific header fields, all required.
 */
export const HEADER_RULES = {
  "tenant.genesis": { head: "head", actor: "user", slot: false, triggers: [], extra: ["node_id"] },
  "tenant.restored": {
    head: "head",
    actor: "system",
    slot: false,
    triggers: ["restore"],
    extra: ["node_id", "restore_id", "restore_count", "restored_to", "high_water"],
  },
  "tenant.imported": {
    head: "head",
    actor: "user",
    slot: false,
    triggers: [],
    extra: ["node_id", "restore_count", "imported_upto"],
  },
  "principal.registered": { head: "head", actor: "user", slot: false, triggers: [], extra: [] },
  "principal.renamed": { head: "head", actor: "user", slot: false, triggers: [], extra: [] },
  "principal.revoked": { head: "head", actor: "user", slot: false, triggers: [], extra: [] },
  "slot.policy_set": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "slot.removed": { head: "head", actor: "user", slot: true, triggers: [], extra: [] },
  "schema.draft_submitted": { head: "head", actor: "caller", slot: true, triggers: [], extra: [] },
  "schema.compiled": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "schema.confirmed": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "schema.rejected": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "schema.superseded": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "schema.migration_started": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "schema.switched": {
    head: "either",
    actor: "system",
    slot: true,
    triggers: ["migration"],
    extra: [],
  },
  "schema.migration_failed": {
    head: "head",
    actor: "system",
    slot: true,
    triggers: ["migration"],
    extra: [],
  },
  "source.recorded": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "write.head": { head: "head", actor: "caller", slot: true, triggers: [], extra: [] },
  "write.base": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "write.derived": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "item.created": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "item.merged": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "item.refreshed": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "item.superseded": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
  "item.resolved": { head: "head", actor: "caller", slot: true, triggers: [], extra: [] },
  "deletion.confirmed": {
    head: "head",
    actor: "caller_or_system",
    slot: true,
    triggers: ["restore"],
    extra: [],
  },
  "deletion.cancelled": {
    head: "head",
    actor: "caller_or_system",
    slot: true,
    triggers: ["restore"],
    extra: [],
  },
  "deletion.executed": {
    head: "head",
    actor: "system",
    slot: true,
    triggers: ["deletion_expiry", "restore_backfill", "import"],
    extra: [],
  },
  "premise.changed": { head: "member", actor: "any", slot: true, triggers: [], extra: [] },
} as const satisfies Record<
  keyof EventHeaders,
  {
    head: "head" | "member" | "either";
    actor: "user" | "caller" | "system" | "caller_or_system" | "any";
    slot: boolean;
    triggers: readonly Trigger[];
    extra: readonly HeaderField[];
  }
>;
