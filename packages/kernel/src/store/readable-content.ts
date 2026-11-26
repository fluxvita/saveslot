// How the log's content blocks are read while deletions are in their grace period (09 §5.9: a
// block a pending deletion lists is read no more from the confirmation on). One definition, used
// by `readEvents`, by every direct reader of `content` and by the export's placeholders, so they
// never differ.

/**
 * SQL for the earliest `deletion.confirmed` (its `seq`) listing block (`<a>.seq`, `<a>.path`) and
 * not yet executed or cancelled; NULL when none does. `a` is the alias of a row of `content`.
 */
export const pendingBy = (a: string): string =>
  `(SELECT min(p.deletion_seq) FROM pending_blocks p WHERE p.seq = ${a}.seq AND p.path = ${a}.path)`;

/**
 * The `content` table as everything but its few allowed readers reads it. Use it in SQL where
 * `content` would go (`FROM ${READABLE_CONTENT} c`); it has the columns `seq`, `path`, `body`,
 * `removed_by`, `pending_by` and `held`:
 * - `body` is NULL for a pending block, as for a removed one or a placeholder;
 * - `pending_by` is `pendingBy` of the block;
 * - `held` is whether the store still holds a body (pending or present).
 * Reading `content` itself is allowed only where the gate test (`content-readers.test.ts`) lists
 * the file.
 */
export const READABLE_CONTENT = `(SELECT rc.seq, rc.path, rc.removed_by, pb.deletion AS pending_by,
     CASE WHEN pb.deletion IS NULL THEN rc.body END AS body, (rc.body IS NOT NULL) AS held
   FROM content rc LEFT JOIN LATERAL (SELECT ${pendingBy("rc")} AS deletion) pb ON TRUE)`;

/**
 * SQL for the task of the operation whose head event is `seq` (an SQL expression): its `task`
 * block as readable, NULL when it has none or when that block is not readable. `task` is a data
 * block (09 §5.1), listed by a deletion with the operation's blocks (§5.9).
 */
export const taskOfOperation = (seq: string): string =>
  `(SELECT k.body::jsonb #>> '{}' FROM ${READABLE_CONTENT} k WHERE k.seq = ${seq} AND k.path = 'task' AND k.body IS NOT NULL)`;

/**
 * SQL: the task of the operation whose head event is `seq` is known — it has no `task` block, or
 * that block is readable. One that a pending deletion lists (or a deletion cleared) is of no known
 * task: neither the caller's nor another, and never quoted.
 */
export const taskKnown = (seq: string): string =>
  `NOT EXISTS (SELECT 1 FROM ${READABLE_CONTENT} k WHERE k.seq = ${seq} AND k.path = 'task' AND k.body IS NULL)`;

/**
 * SQL: the version-table cell `v` (an alias) holds a value a contribution no longer readable gave
 * (03-data-model/03-deletion «删除后的样子是一个新版本»): the contribution's value block,
 * `fields/<field>/<k>` of its event (09 §5.9), is pending or cleared. Such a cell's value is not
 * read; where it was, the read marks `partially_deleted`. A cell no contribution gave (a schema
 * constant, no value, existence) is never so.
 */
export const cellWithheld = (v: string): string =>
  `(${v}.src_event IS NOT NULL AND ${v}.src_field IS NOT NULL AND EXISTS (SELECT 1 FROM ${READABLE_CONTENT} k
     WHERE k.seq = ${v}.src_event AND k.path = 'fields/' || ${v}.src_field || '/' || ${v}.src_k AND k.body IS NULL))`;
