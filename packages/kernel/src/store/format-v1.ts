// Storage format v1: the kernel's own tables in a tenant's storage
// (docs/zh-CN/spec/02-architecture.md §8 "存储格式 v1"). One DDL script shared by both backends.
//
// The spec lists each table's primary key, key columns and maintainer; the remaining columns here
// are the implementation's. Until the first public release of local mode the format is not frozen:
// modules implemented in P1 and later may refine columns, and such changes stay at version 1.
//
// Not here: business tables `t_<table>_v<n>`, version tables `t_<table>_v<n>__ver` and derived
// tables `d_<table>_v<n>`. Their shape follows each slot's compiled schema and they are created by
// `apply` / `schema`.
//
// Conventions:
// - Every text column uses the "C" collation (fixed session settings: kernel tables sort by "C").
// - `seq`, operation numbers and counts are BIGINT. Instants are TEXT in the event format's fixed
//   form (`2026-11-10T04:41:07.123Z`), which sorts correctly under "C"; the database never parses
//   them, so no time zone database is involved.
// - Values that are JSON in the event format are stored as their JCS text (TEXT), never as JSONB,
//   so bytes, key order and decimal strings survive unchanged on both backends.
// - Columns holding user content (or values computed from it) are marked "content" in comments:
//   physical deletion must clear them.

export const STORAGE_FORMAT_VERSION = 1;

/** Where a table's state comes from (§3 "日志是唯一事实来源"). */
export type StateClass = "fact" | "materialized" | "local";

export interface KernelTable {
  readonly name: string;
  readonly class: StateClass;
  /** Materialized tables only: compared by `log.reconcile` (§8 "对拍" column). */
  readonly reconciled?: boolean | "structure";
  readonly ddl: string;
}

const T = 'TEXT COLLATE "C"';

/**
 * Fixed session settings (§8 "固定的会话设置"). Applied on every connection by the backend.
 * The database encoding must be UTF8 (checked at open; it cannot be set per session).
 */
export const SESSION_SETTINGS = [
  "SET client_encoding = 'UTF8'",
  "SET TIME ZONE 'UTC'",
  "SET datestyle = 'ISO, YMD'",
  "SET intervalstyle = 'iso_8601'",
  "SET extra_float_digits = 3",
] as const;

export const KERNEL_TABLES: readonly KernelTable[] = [
  // ---- (a) facts ----
  {
    name: "events",
    class: "fact",
    ddl: `CREATE TABLE events (
  seq BIGINT PRIMARY KEY CHECK (seq >= 1),
  header ${T} NOT NULL,             -- JCS text of the event header; authoritative
  header_hash ${T} NOT NULL,        -- SHA-256 of the header bytes, lowercase hex
  -- Index columns, derived from the header; verify checks them against it.
  type ${T} NOT NULL,
  actor ${T} NOT NULL,
  at ${T} NOT NULL,
  op BIGINT NOT NULL,               -- operation number; equals seq for a head event
  slot ${T},
  -- Index columns derived from the metadata block "target".
  target_table ${T},
  target_row ${T},                  -- row or entity ID
  target_event BIGINT               -- referenced event seq (origin_event, by_event)
);
CREATE INDEX events_op ON events (op);
CREATE INDEX events_type ON events (type);
CREATE INDEX events_slot ON events (slot, seq);
CREATE INDEX events_target_row ON events (target_table, target_row, seq);
CREATE INDEX events_target_event ON events (target_event);`,
  },
  {
    name: "content",
    class: "fact",
    ddl: `CREATE TABLE content (
  seq BIGINT NOT NULL,
  path ${T} NOT NULL,
  body ${T},                        -- JCS text of the block; content for data blocks
  checksum ${T},                    -- SHA-256 of the body bytes
  removed_by BIGINT,                -- seq of the tombstone that cleared the block
  key_id ${T},                      -- reserved for encryption
  placeholder_of BIGINT,            -- staging storage of an import only: pending-deletion placeholder
  PRIMARY KEY (seq, path),
  CHECK ((body IS NULL) = (checksum IS NULL)),
  CHECK (removed_by IS NULL OR body IS NULL),
  CHECK (placeholder_of IS NULL OR (body IS NULL AND removed_by IS NULL))
);`,
  },

  // ---- (b) materialized state, maintained only by apply ----
  {
    name: "principals",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE principals (
  id ${T} PRIMARY KEY,
  kind ${T} NOT NULL CHECK (kind IN ('user', 'connection', 'system')),
  name ${T},                        -- user-given name of a connection
  scopes ${T},                      -- JCS array of scopes
  slots ${T},                       -- JCS array of slot IDs; NULL = all slots
  via ${T},
  client ${T},
  state ${T} NOT NULL CHECK (state IN ('active', 'revoked', 'disabled')),
  registered_seq BIGINT NOT NULL
);`,
  },
  {
    name: "slots",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE slots (
  id ${T} PRIMARY KEY,
  name ${T} NOT NULL,
  timezone ${T} NOT NULL,
  current_sv INTEGER,
  policy_seq BIGINT,
  policy_version INTEGER
);`,
  },
  {
    name: "schema_versions",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE schema_versions (
  slot_id ${T} NOT NULL,
  sv INTEGER NOT NULL,
  compiled_seq BIGINT NOT NULL,     -- seq of the schema.compiled event holding the definition
  state ${T} NOT NULL CHECK (state IN ('current', 'retired')),
  PRIMARY KEY (slot_id, sv)
);`,
  },
  {
    name: "migrations",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE migrations (
  id ${T} PRIMARY KEY,
  slot_id ${T} NOT NULL,
  draft_id ${T} NOT NULL,
  from_sv INTEGER NOT NULL,
  target_sv INTEGER NOT NULL,
  state ${T} NOT NULL
);`,
  },
  {
    name: "catalog",
    class: "materialized",
    reconciled: "structure",
    ddl: `CREATE TABLE catalog (
  table_id ${T} NOT NULL,
  sv INTEGER NOT NULL,
  slot_id ${T} NOT NULL,
  structure ${T} NOT NULL,          -- JCS: names, types, units, descriptions of the table and fields
  profile ${T},                     -- JCS; not reconciled
  samples ${T},                     -- JCS; value samples, content; not reconciled
  PRIMARY KEY (table_id, sv)
);`,
  },
  {
    name: "base_sources",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE base_sources (
  event_seq BIGINT NOT NULL,        -- write.base, deletion event (restated items) or schema.switched
  row_id ${T} NOT NULL,             -- row or entity ID
  field_id ${T} NOT NULL,           -- field ID, or 'existence'
  k INTEGER NOT NULL,               -- item index
  n INTEGER NOT NULL,               -- position in the item's source list
  source_kind ${T} NOT NULL CHECK (source_kind IN ('value', 'operation', 'schema_const')),
  source_seq BIGINT,                -- source.recorded seq
  carried_event BIGINT,             -- carried contribution: write.base seq, field, item
  carried_field ${T},
  carried_k INTEGER,
  schema_const_sv INTEGER,
  status ${T} NOT NULL,             -- current status of the item (latest event that gave it)
  valid_from ${T},                  -- state tables: resolved interval; content
  valid_to ${T},
  corroborated BOOLEAN NOT NULL DEFAULT FALSE,
  corroboration_ends ${T},          -- JCS: explicit corroboration endpoints; content
  reverted ${T},                    -- JCS: [{op, intervals}] registered by undo / take_previous
  PRIMARY KEY (event_seq, row_id, field_id, k, n)
);
CREATE INDEX base_sources_row ON base_sources (row_id, field_id);
CREATE INDEX base_sources_source ON base_sources (source_seq);
CREATE INDEX base_sources_carried ON base_sources (carried_event, carried_field, carried_k);`,
  },
  {
    name: "block_deps",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE block_deps (
  seq BIGINT NOT NULL,
  path ${T} NOT NULL,
  n INTEGER NOT NULL,
  dep_event BIGINT NOT NULL,
  dep_field ${T} NOT NULL,          -- field ID, or 'existence'
  dep_k INTEGER NOT NULL,
  dep_kind ${T} NOT NULL CHECK (dep_kind IN ('deps', 'carried')),
  PRIMARY KEY (seq, path, n)
);
CREATE INDEX block_deps_dep ON block_deps (dep_event, dep_field, dep_k);`,
  },
  {
    name: "row_origins",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE row_origins (
  row_id ${T} PRIMARY KEY,
  table_id ${T} NOT NULL,
  origin_seq BIGINT NOT NULL        -- write.base that first created it (latest given wins)
);`,
  },
  {
    name: "sources",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE sources (
  seq BIGINT PRIMARY KEY,           -- source.recorded seq
  source_id ${T} NOT NULL UNIQUE,   -- external s_… ID
  kind ${T} NOT NULL,
  level ${T},
  slot_id ${T} NOT NULL,
  deletion_state ${T} NOT NULL CHECK (deletion_state IN ('present', 'pending_deletion', 'removed'))
);`,
  },
  {
    name: "partitions",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE partitions (
  derived_table_id ${T} NOT NULL,
  partition_id ${T} NOT NULL,
  group_key ${T},                   -- JCS of the grouping key values; content, cleared on deletion
  PRIMARY KEY (derived_table_id, partition_id)
);`,
  },
  {
    name: "derived_reads",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE derived_reads (
  derived_seq BIGINT NOT NULL,      -- write.derived seq
  base_table_id ${T} NOT NULL,
  partition_id ${T} NOT NULL,
  rule_version INTEGER NOT NULL,
  read_pos BIGINT NOT NULL,
  PRIMARY KEY (derived_seq, base_table_id, partition_id)
);`,
  },
  {
    name: "counts",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE counts (
  table_id ${T} NOT NULL,
  partition_key ${T} NOT NULL,      -- '' for the whole table
  row_count BIGINT NOT NULL,
  PRIMARY KEY (table_id, partition_key)
);`,
  },
  {
    name: "pending_items",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE pending_items (
  id ${T} PRIMARY KEY,              -- pi_…
  type ${T} NOT NULL,
  slot_id ${T},
  target_table ${T},
  target_row ${T},
  state ${T} NOT NULL,
  decision ${T},                    -- how a resolved item was resolved
  version_op BIGINT NOT NULL        -- operation number of the latest content change
);
CREATE INDEX pending_items_target ON pending_items (target_table, target_row);`,
  },
  {
    name: "pending_entries",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE pending_entries (
  item_id ${T} NOT NULL,
  n INTEGER NOT NULL,
  content_seq BIGINT NOT NULL,      -- where the entry block is
  content_path ${T} NOT NULL,
  PRIMARY KEY (item_id, n)
);`,
  },
  {
    name: "flags",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE flags (
  table_id ${T} NOT NULL,
  row_id ${T} NOT NULL,
  flag ${T} NOT NULL,
  item_id ${T} NOT NULL,
  fields ${T},                      -- JCS array of field IDs
  spans ${T},                       -- JCS array of the item's spans (state tables)
  PRIMARY KEY (table_id, row_id, flag, item_id)
);`,
  },
  {
    name: "request_keys",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE request_keys (
  key ${T} PRIMARY KEY,             -- request key or explicit idempotency key; content
  op BIGINT NOT NULL,
  at ${T} NOT NULL,
  fingerprint ${T}                  -- explicit idempotency keys: request content fingerprint
);
CREATE INDEX request_keys_at ON request_keys (at);`,
  },
  {
    name: "deletions",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE deletions (
  id ${T} PRIMARY KEY,
  kind ${T} NOT NULL,
  state ${T} NOT NULL CHECK (state IN ('pending', 'cancelled', 'executed')),
  due_at ${T} NOT NULL,
  confirmed_seq BIGINT NOT NULL
);
CREATE INDEX deletions_due ON deletions (state, due_at);`,
  },
  {
    name: "external_keys",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE external_keys (
  table_id ${T} NOT NULL,
  key_values ${T} NOT NULL,         -- JCS array of the key values; content
  holder_row ${T} NOT NULL,
  yielded_row ${T},                 -- key_from: the revoked row that gave the key up
  state ${T} NOT NULL CHECK (state IN ('present', 'frozen')),
  frozen_by ${T},                   -- JCS array of deletion IDs; unfrozen when empty
  PRIMARY KEY (table_id, key_values)
);
CREATE INDEX external_keys_holder ON external_keys (holder_row);`,
  },
  {
    name: "premise_decls",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE premise_decls (
  op BIGINT NOT NULL,
  op_index INTEGER NOT NULL,
  decl_index INTEGER NOT NULL,
  dep_table ${T} NOT NULL,
  dep_row ${T} NOT NULL,
  target_table ${T} NOT NULL,
  target_row ${T} NOT NULL,
  fields ${T},                      -- JCS array of field IDs; NULL = whole row
  range_kind ${T} NOT NULL CHECK (range_kind IN ('whole', 'from_now', 'row_time', 'given')),
  valid ${T},                       -- JCS of the business time; content, cleared by tombstones
  seen_op BIGINT NOT NULL,
  seen_restore_count INTEGER NOT NULL,
  state ${T} NOT NULL CHECK (state IN ('current', 'changed')),
  reason ${T},
  since BIGINT,
  declarer ${T} NOT NULL,
  PRIMARY KEY (op, op_index, decl_index)
);
CREATE INDEX premise_decls_target ON premise_decls (target_row);`,
  },
  {
    name: "premise_edges",
    class: "materialized",
    reconciled: true,
    ddl: `CREATE TABLE premise_edges (
  item_event BIGINT NOT NULL,       -- event holding the item
  field_id ${T} NOT NULL,           -- field ID, or 'existence'
  k INTEGER NOT NULL,
  target ${T} NOT NULL,             -- premise target row or entity ID; '*' for a clearing entry
  decl_op BIGINT NOT NULL,
  decl_op_index INTEGER NOT NULL,
  decl_index INTEGER,               -- NULL for a clearing entry (points at the clearing op)
  PRIMARY KEY (item_event, field_id, k, target)
);
CREATE INDEX premise_edges_target ON premise_edges (target);`,
  },
  // fts (full-text index) is listed in §8 but not built in v1.

  // ---- (c) local runtime state: not exported, not replayed ----
  {
    name: "meta",
    class: "local",
    ddl: `CREATE TABLE meta (
  key ${T} PRIMARY KEY,
  value ${T} NOT NULL
);`,
  },
  {
    name: "read_log",
    class: "local",
    // One row per read (03-data-model/02-integrity-and-records.md «读取记录»): what it read, the
    // shape of its query, and its business time condition. No values; the condition is the only
    // caller-given value kept (impact queries need it).
    ddl: `CREATE TABLE read_log (
  read_id ${T} PRIMARY KEY,         -- rd_…
  n BIGINT GENERATED ALWAYS AS IDENTITY UNIQUE,  -- order of recording
  actor ${T} NOT NULL,
  task ${T},
  at ${T} NOT NULL,                 -- the entry's "now"
  pos BIGINT NOT NULL,              -- log position when read: the latest operation number
  operation ${T} NOT NULL CHECK (operation IN
    ('query', 'sql', 'history', 'sources', 'catalog', 'pending', 'deletion_preview')),
  selfcheck BOOLEAN NOT NULL DEFAULT FALSE,
  slot_id ${T},
  sv INTEGER,
  table_id ${T},
  shape ${T},                       -- structural fingerprint of the query; no user values
  valid ${T},                       -- business time condition (JCS)
  source_id ${T}                    -- a source read in full
);
CREATE INDEX read_log_at ON read_log (at);
CREATE INDEX read_log_actor ON read_log (actor, n);`,
  },
  {
    name: "read_log_rows",
    class: "local",
    // What a read got: a row, entity or partition with the version read, one per entity on state
    // tables; or a table-level record (target NULL: the table as of the read's position).
    ddl: `CREATE TABLE read_log_rows (
  read_id ${T} NOT NULL,
  k INTEGER NOT NULL,               -- order within the read
  table_id ${T} NOT NULL,
  target ${T},                      -- row / entity / partition ID; NULL for a table-level record
  ver_op BIGINT,
  ver_restore_count INTEGER,
  PRIMARY KEY (read_id, k)
);
CREATE INDEX read_log_rows_target ON read_log_rows (table_id, target);`,
  },
  {
    name: "last_read",
    class: "local",
    // The version each actor (and task) last read, for the fallback (04-contract §2). For `sv` the
    // target is the slot ID and `op` is the schema version.
    ddl: `CREATE TABLE last_read (
  actor ${T} NOT NULL,
  task ${T} NOT NULL DEFAULT '',
  target ${T} NOT NULL,             -- row / entity ID, slot ID (sv) or pending item ID
  kind ${T} NOT NULL CHECK (kind IN ('ver', 'sv', 'item')),
  op BIGINT NOT NULL,
  restore_count INTEGER NOT NULL,
  read_id ${T} NOT NULL,            -- the read it came from
  PRIMARY KEY (actor, task, target, kind)
);`,
  },
  {
    name: "possibly_affected",
    class: "local",
    ddl: `CREATE TABLE possibly_affected (
  read_id BIGINT NOT NULL,
  actor ${T} NOT NULL,
  since_op BIGINT NOT NULL,
  PRIMARY KEY (read_id)
);
CREATE INDEX possibly_affected_actor ON possibly_affected (actor);`,
  },
  {
    name: "field_name_usage",
    class: "local",
    ddl: `CREATE TABLE field_name_usage (
  actor ${T} NOT NULL,
  table_id ${T} NOT NULL,
  field_id ${T} NOT NULL,
  last_at ${T} NOT NULL,
  uses BIGINT NOT NULL,
  PRIMARY KEY (actor, table_id, field_id)
);`,
  },
  {
    name: "task_cursors",
    class: "local",
    ddl: `CREATE TABLE task_cursors (
  task ${T} PRIMARY KEY,
  cursor ${T} NOT NULL
);`,
  },
  {
    name: "residue_progress",
    class: "local",
    ddl: `CREATE TABLE residue_progress (
  id INTEGER PRIMARY KEY CHECK (id = 1),
  tombstone_seq BIGINT NOT NULL     -- residue purged up to this tombstone
);`,
  },
];

/** Keys of the `meta` table. */
export const META_KEYS = {
  storageFormat: "storage_format",
  tenantId: "tenant_id",
  ownershipEpoch: "ownership_epoch",
  sessionSettings: "session_settings",
  tzdbVersion: "tzdb_version",
  restoreCount: "restore_count",
} as const;

/** The whole DDL script for a new tenant storage at format v1. */
export function formatV1Ddl(): string {
  return KERNEL_TABLES.map((t) => t.ddl).join("\n\n");
}
