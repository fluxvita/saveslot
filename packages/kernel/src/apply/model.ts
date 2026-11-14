// What apply plans: the changes an event makes to the materialized state, and why apply stops.

import type { Seq } from "@fluxvita/saveslot-contract-core";
import type { SqlValue } from "../store/ports.ts";

export type ApplyErrorReason =
  /** Not a valid v1 event (§1.6). */
  | "invalid"
  /** A block shape the parser cannot check yet. */
  | "unsupported"
  /** A version string the kernel does not know (§1.6). */
  | "unknown_version"
  /** A type, or a form of one, apply does not implement yet. */
  | "not_implemented"
  /** The event does not fit the state: an unknown principal, a principal registered twice. */
  | "inconsistent";

/** apply stopped. An internal error to the caller: the log is ahead of what this kernel can apply. */
export class ApplyError extends Error {
  override readonly name = "ApplyError";
  readonly reason: ApplyErrorReason;
  readonly seq: Seq;
  constructor(reason: ApplyErrorReason, seq: Seq, message: string) {
    super(`apply stopped at seq ${seq}: ${message}`);
    this.reason = reason;
    this.seq = seq;
  }
}

/** A row of `principals`, as apply writes it. JSON columns hold JCS text. */
export interface PrincipalRow {
  readonly id: string;
  readonly kind: "user" | "connection" | "system";
  readonly name: string | null;
  readonly scopes: string | null;
  readonly slots: string | null;
  readonly via: string | null;
  readonly client: string | null;
  readonly state: "active" | "revoked" | "disabled";
  readonly registered_seq: Seq;
}

/** A row of `pending_items`. */
export interface ItemRow {
  readonly id: string;
  readonly type: string;
  readonly slot_id: string | null;
  readonly target_table: string | null;
  readonly target_row: string | null;
  readonly state: "open";
  readonly version_op: Seq;
}

/** A row of `flags`. `fields` is the JCS of the item's unit. */
export interface FlagRow {
  readonly table_id: string;
  readonly row_id: string;
  readonly flag: string;
  readonly item_id: string;
  readonly fields: string | null;
  readonly valid_from: string | null;
  readonly valid_to: string | null;
}

/** Where an entry block of an item is: `pending_entries`. */
export interface EntryRef {
  readonly item: string;
  readonly n: number;
  readonly seq: Seq;
  readonly path: string;
}

/** A row of `block_deps`: block `path` of event `seq` depends on a contribution. */
export interface BlockDepRow {
  readonly seq: Seq;
  readonly path: string;
  readonly n: number;
  readonly dep_event: Seq;
  /** Field ID, or `existence`. */
  readonly dep_field: string;
  readonly dep_k: number;
  readonly dep_kind: "deps" | "carried";
}

/** One change to the materialized state. */
export type Change =
  | { readonly kind: "principal_insert"; readonly row: PrincipalRow }
  | { readonly kind: "principal_rename"; readonly id: string; readonly name: string | null }
  | { readonly kind: "principal_revoke"; readonly id: string }
  | { readonly kind: "tenant_id"; readonly tenant_id: string }
  /** The request key index (§5.1 `request_key`, `idempotency`): the key now names this operation. */
  | {
      readonly kind: "request_key";
      readonly key: string;
      readonly op: Seq;
      readonly at: string;
      readonly fingerprint: string | null;
    }
  /** §5.6 */
  | {
      readonly kind: "source";
      readonly seq: Seq;
      readonly source_id: string;
      readonly source_kind: string;
      readonly level: string;
      readonly slot: string;
    }
  | {
      readonly kind: "slot_insert";
      readonly id: string;
      readonly name: string;
      readonly timezone: string;
    }
  | {
      readonly kind: "slot_policy";
      readonly id: string;
      readonly seq: Seq;
      readonly policy_version: number;
    }
  /** Physical tables of a version, from its compiled definition. */
  | { readonly kind: "ddl"; readonly sql: string }
  | {
      readonly kind: "catalog_insert";
      readonly table_id: string;
      readonly sv: number;
      readonly slot: string;
      readonly structure: string;
    }
  | { readonly kind: "counts_init"; readonly table_id: string }
  /** The slot's current version becomes `sv` (its first: this phase only creates slots). */
  | {
      readonly kind: "version_switch";
      readonly slot: string;
      readonly sv: number;
      readonly compiled_seq: Seq;
      readonly name: string;
      readonly timezone: string;
    }
  | { readonly kind: "item_insert"; readonly row: ItemRow }
  | {
      readonly kind: "item_update";
      readonly id: string;
      readonly state?: "resolved" | "superseded";
      readonly decision?: string;
      readonly version_op?: Seq;
    }
  | { readonly kind: "entries_insert"; readonly entries: readonly EntryRef[] }
  /** The item's entries in `groups` (and at exactly `paths`) stop counting. */
  | {
      readonly kind: "entries_drop";
      readonly item: string;
      readonly groups: readonly string[];
      readonly paths: readonly string[];
    }
  | { readonly kind: "flag_insert"; readonly row: FlagRow }
  | {
      readonly kind: "flag_valid";
      readonly item: string;
      readonly from: string | null;
      readonly to: string | null;
    }
  | { readonly kind: "flags_drop"; readonly item: string }
  /** Rows added to a kernel table (`base_sources`). */
  | {
      readonly kind: "rows_insert";
      readonly table: "base_sources";
      readonly columns: readonly string[];
      readonly rows: readonly (readonly SqlValue[])[];
    }
  /** An item's "reverted" registrations (`base_sources.reverted`, JCS) after a revert. */
  | {
      readonly kind: "base_sources_reverted";
      readonly row_id: string;
      readonly event: Seq;
      readonly field: string;
      readonly k: number;
      readonly reverted: string;
    }
  /** The write that first created the row or entity (`row_origins`). */
  | {
      readonly kind: "row_origin";
      readonly row_id: string;
      readonly table_id: string;
      readonly seq: Seq;
    }
  /** A row's or entity's rows of a business table, replaced by its settled current version. */
  | {
      readonly kind: "rows_replace";
      readonly table: string;
      readonly key: "row_id" | "entity_id";
      readonly id: string;
      readonly columns: readonly string[];
      readonly rows: readonly (readonly SqlValue[])[];
    }
  /**
   * A row's version cells: open cells no longer current end at `op` (or are dropped, when `op`
   * opened them), new ones open at `op`.
   */
  | {
      readonly kind: "cells";
      readonly table: string;
      readonly row_id: string;
      readonly state: boolean;
      readonly op: Seq;
      readonly close: readonly {
        readonly field: string;
        readonly valid_from: string | null;
        readonly rec_from: Seq;
      }[];
      readonly columns: readonly string[];
      readonly rows: readonly (readonly SqlValue[])[];
    }
  | { readonly kind: "counts_add"; readonly table_id: string; readonly delta: number }
  /** The block dependency index (§5.12): blocks → the contributions they depend on. */
  | { readonly kind: "block_deps"; readonly rows: readonly BlockDepRow[] };
