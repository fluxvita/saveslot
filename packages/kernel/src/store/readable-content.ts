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
