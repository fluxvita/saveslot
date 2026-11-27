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
 * SQL: the version-table cell `v` (an alias) holds a value a deletion removed (03-data-model/
 * 03-deletion «删除后的样子是一个新版本», «版本表»). Its value was given by one block, its
 * "giver": the latest `restated/<k>` naming the cell's item (`src_event`, `src_field`, `src_k`) on
 * a `deletion.confirmed` or `deletion.cancelled` up to the cell's operation (`rec_from`) — a
 * restatement keeps the item's `k`, 09 §5.9 — or, when none, the item's own `fields/<f>/<k>` on
 * `src_event`. The cell is withheld when its giver is listed by a deletion confirmed after the
 * cell was recorded: pending (a row of `pending_blocks` with a later `deletion_seq`, of any of the
 * deletions listing it), or carried out (cleared, the tombstone naming a later confirmation). A
 * cell recorded at a deletion or after holds the state after it and is not withheld for it; a
 * cancelled deletion lists nothing any more. A cell no contribution gave (a schema constant, no
 * value, existence) is never withheld. Where a cell is withheld, its value is not read and the
 * read marks `partially_deleted`. One giver a cell: a value another contribution corroborated is
 * withheld all the same (08-open-questions).
 */
export const cellWithheld = (v: string): string =>
  `(${v}.src_event IS NOT NULL AND ${v}.src_field IS NOT NULL AND EXISTS (
     SELECT 1 FROM (
       SELECT COALESCE(r.seq, ${v}.src_event) AS gseq,
         COALESCE(r.path, 'fields/' || ${v}.src_field || '/' || ${v}.src_k) AS gpath
       FROM (SELECT 1) AS one LEFT JOIN LATERAL (
         -- The restatement giving the cell, read off the content table itself, for its identity
         -- (event, field, k), never its value: it may be the very block a later deletion lists,
         -- which READABLE_CONTENT reads as empty and could not then be told apart.
         SELECT rc.seq, rc.path FROM content rc JOIN events re ON re.seq = rc.seq
         WHERE re.type IN ('deletion.confirmed', 'deletion.cancelled') AND rc.seq <= ${v}.rec_from
           AND rc.path LIKE 'restated/%' AND rc.body IS NOT NULL
           AND (rc.body::jsonb ->> 'event')::bigint = ${v}.src_event
           AND rc.body::jsonb ->> 'field' = ${v}.src_field
           AND (rc.body::jsonb ->> 'k')::int = ${v}.src_k
         ORDER BY rc.seq DESC LIMIT 1
       ) AS r ON TRUE
     ) AS g
     WHERE EXISTS (SELECT 1 FROM pending_blocks p
                   WHERE p.seq = g.gseq AND p.path = g.gpath AND p.deletion_seq > ${v}.rec_from)
        OR EXISTS (SELECT 1 FROM content c
                   WHERE c.seq = g.gseq AND c.path = g.gpath AND c.removed_by IS NOT NULL
                     AND ${v}.rec_from < COALESCE(
                       (SELECT (t.body::jsonb ->> 'confirmed_event')::bigint FROM ${READABLE_CONTENT} t
                        WHERE t.seq = c.removed_by AND t.path = 'target'), c.removed_by))))`;
