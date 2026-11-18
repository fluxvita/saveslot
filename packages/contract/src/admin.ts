// Administrative operations (docs/zh-CN/spec/04-contract-types.md §8): `connections.*` (§8.1),
// `reads.list` (§8.3), `log.verify` (§8.4) and `log.end` (§8.5). They take a user session and are HTTP only; they
// have no `CommonParams` and, except where the spec says so, no `CommonResult`.

import type { PrincipalVia, Scope } from "@fluxvita/saveslot-contract-core";
import type {
  Actor,
  BizTime,
  ConnectionId,
  Cursor,
  Instant,
  PageParams,
  PageResult,
  ReadId,
  Seq,
  SlotId,
  SlotName,
  SourceId,
  Sv,
  TableName,
  TargetRef,
} from "./common.ts";

/** The scopes, in the order the event format lists them; the `task` of `saveslot connect`'s self-check (06-cli §3 step 7). */
export { SCOPES, SELFCHECK_TASK } from "@fluxvita/saveslot-contract-core";
/** 04-contract-types §8.1 `Scope` (same set as the event format's); §8.1 `Connection.via` (`PrincipalVia`). */
export type { PrincipalVia, Scope };

// ---------------------------------------------------------------------------------------------
// §8.1 `connections.*`

/** 04-contract-types §8.1 `ConnectionsIssueParams`. */
export interface ConnectionsIssueParams {
  /** Suggested "device · agent"; unique per user, revoked names included. */
  name: string;
  /** Must include `saveslot.read`. Default `["saveslot.read", "saveslot.write"]`. */
  scopes?: Scope[];
  /** Slot names or IDs; absent = all slots, including later ones. Not empty. */
  slots?: SlotName[];
}

/** 04-contract-types §8.1 `Connection`. */
export interface Connection {
  id: ConnectionId;
  name: string;
  scopes: Scope[];
  /** Slot scope; absent = all. */
  slots?: Array<{ slot: SlotName; slot_id: SlotId }>;
  via: PrincipalVia;
  /** Client identifier with `via: oauth`. */
  client?: string;
  created_at: Instant;
  /** Not given in this version. */
  last_used_at?: Instant;
  /** Given only when revoked or disabled by an import. */
  state?: "revoked" | "disabled";
  revoked_at?: Instant;
}

/** 04-contract-types §8.1 `ConnectionsIssueResult`. */
export interface ConnectionsIssueResult extends Connection {
  /** Returned only this once. */
  token: string;
}

/** 04-contract-types §8.1 `ConnectionsListParams`. */
export interface ConnectionsListParams {
  /** true: list revoked and disabled ones too. */
  include_revoked?: boolean;
  limit?: number;
  cursor?: Cursor;
}

/** 04-contract-types §8.1 `ConnectionsListResult`. */
export interface ConnectionsListResult extends PageResult {
  connections: Connection[];
}

/** 04-contract-types §8.1 `ConnectionsUpdateParams`: rename only. */
export interface ConnectionsUpdateParams {
  id: ConnectionId;
  name: string;
}

/** 04-contract-types §8.1 `ConnectionsRevokeParams`. */
export interface ConnectionsRevokeParams {
  id: ConnectionId;
}

/** 04-contract-types §8.1 `ConnectionsUpdateResult`. */
export type ConnectionsUpdateResult = Connection;

/** 04-contract-types §8.1 `ConnectionsRevokeResult`: `state` is `revoked`; repeating returns the same. */
export type ConnectionsRevokeResult = Connection;

// ---------------------------------------------------------------------------------------------
// §8.3 `reads.list`

/** 04-contract-types §8.3 `ReadsListParams`. */
export interface ReadsListParams extends PageParams {
  /** ID or name. */
  connection?: ConnectionId | string;
  slot?: SlotName;
  table?: TableName;
  /** Only reads carrying this task identifier (not `CommonParams.task`). */
  of_task?: string;
  /** [since, until). */
  since?: Instant;
  until?: Instant;
}

/** 04-contract-types §8.3 `ReadsListResult.reads[].operation`. */
export const READ_OPERATIONS = [
  "query",
  "sql",
  "history",
  "sources",
  "catalog",
  "pending",
  "deletion_preview",
] as const;
/** 04-contract-types §8.3 `ReadsListResult.reads[].operation`. */
export type ReadOperation = (typeof READ_OPERATIONS)[number];

/** 04-contract-types §8.3 one entry of `ReadsListResult.reads`. */
export interface ReadRecord {
  read: ReadId;
  at: Instant;
  actor: Actor;
  task?: string;
  operation: ReadOperation;
  /** The self-check when the connection was issued. */
  selfcheck?: true;
  /** Only when the read fell on one slot. */
  slot?: SlotName;
  sv?: Sv;
  table?: TableName;
  /** Rows and versions read, no values; at most 50. */
  rows?: Array<{ target: TargetRef; seq: Seq }>;
  rows_total?: number;
  /** Tables recorded at table level. */
  coarse?: Array<{ table: TableName; pos: Seq }>;
  /** The business time asked. */
  valid?: { at?: BizTime; during?: [BizTime, BizTime | null] };
  /** A source's text was read. */
  source?: SourceId;
}

/** 04-contract-types §8.3 `ReadsListResult`. */
export interface ReadsListResult extends PageResult {
  /** Read records are kept since this instant. */
  covered_since: Instant;
  reads: ReadRecord[];
}

// ---------------------------------------------------------------------------------------------
// §8.4 `log.verify` (no parameters)

/** 04-contract-types §8.4 `LogVerifyResult`. Positions only, never content. */
export interface LogVerifyResult {
  events: number;
  /** `broken_at`: the event's seq. */
  chain: { intact: true } | { intact: false; broken_at: number };
  checksum_mismatch: Array<{ seq: number; path: string }>;
  /** Events whose index columns disagree with the header and target block. */
  index_mismatch: Array<{ seq: number }>;
  /** Content blocks removed by deletions. */
  removed: number;
  /** Seq gaps a restore left; `restore` is the restore event's seq. */
  gaps: Array<{ after: number; before: number; restore: number }>;
}

// ---------------------------------------------------------------------------------------------
// §8.5 `log.end` (no parameters)

/**
 * 04-contract-types §8.5 `LogEndResult`: the newest event's seq and recorded time, as the log
 * records it (the same `Instant` as every recorded time); null for a log with no event.
 */
export type LogEndResult = { seq: Seq; recorded_at: Instant } | null;
