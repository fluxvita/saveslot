// How the log's content blocks are read while deletions are in their grace period (09 §5.9: a
// block a pending deletion lists is read no more from the confirmation on). One definition, used
// by `readEvents`, by every direct reader of `content` and by the export's placeholders, so they
// never differ.

import type { ReadTx } from "./ports.ts";

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
 * The events an SQL array of event numbers lists (`seqs`, e.g. `$1`), each once, as rows `s.seq`.
 */
const eachSeq = (seqs: string): string =>
  `(SELECT DISTINCT u.seq FROM unnest(CAST(${seqs} AS bigint[])) AS u(seq)) s`;

/**
 * `READABLE_CONTENT` limited to the blocks of the events `seqs` lists (an SQL array of event
 * numbers, e.g. `$1`): use it where `${READABLE_CONTENT} c … WHERE seq = ANY($1)` would go, with
 * the same columns. Each event's blocks are looked up by `content`'s primary key `(seq, path)`, one
 * event at a time, so the plan does not turn on the planner's estimate of how many blocks an event
 * has. `content` is analyzed from a small sample (store-pglite `CONTENT_STATISTICS_TARGET`), which
 * underestimates its number of distinct `seq` values by orders of magnitude on a large store: with
 * `seq = ANY` of a few thousand events, the planner expected millions of rows and scanned the whole
 * of `content` (37.8 s for one write's receipt, on 30 million blocks). `OFFSET 0` keeps the lateral
 * subquery from being pulled up into a join, which the planner could then hash on that estimate.
 */
export const readableContentOf = (seqs: string): string =>
  `(SELECT b.* FROM ${eachSeq(seqs)} CROSS JOIN LATERAL
     (SELECT x.* FROM ${READABLE_CONTENT} x WHERE x.seq = s.seq OFFSET 0) b)`;

/**
 * As `readableContentOf`, of `content` itself (with its columns): blocks a pending deletion lists are read like any other. A direct read of
 * `content`, each use counted as one by content-readers.test.ts.
 */
export const rawContentOf = (seqs: string): string =>
  `(SELECT b.* FROM ${eachSeq(seqs)} CROSS JOIN LATERAL
     (SELECT x.* FROM content x WHERE x.seq = s.seq OFFSET 0) b)`;

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
 * `src_event`. The cell is withheld when its giver is listed by a deletion still pending that was
 * confirmed after the cell was recorded. A cell recorded at a deletion or after holds the state
 * after it and is not withheld for it; a cancelled deletion lists nothing any more. A cell no
 * contribution gave (a schema constant, no value, existence) is never withheld. Where a cell is
 * withheld, its value is not read and the read marks `partially_deleted`. One giver a cell: a
 * value another contribution corroborated is withheld all the same (08-open-questions).
 *
 * Carried out: a cleared giver is withheld too, where it can still be found. A cleared
 * restatement cannot: it is found by what its body names, and a cleared block has no body, so the
 * cell falls back to the item's own block. This holds for deletions still pending only; after
 * execution is left to the change that applies it, which clears what the version tables derived
 * from those blocks as well (09 §5.9; 08-open-questions).
 *
 * `withholding`: whether this tenant has any confirmed deletion (`withholdingIn`). Without one no
 * block is pending or cleared, and the test is not made at all: `FALSE`.
 */
export const cellWithheld = (v: string, withholding: boolean): string =>
  !withholding
    ? "FALSE"
    : `(${v}.src_event IS NOT NULL AND ${v}.src_field IS NOT NULL AND EXISTS (
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
     -- The latest deletion listing the giver, by the primary key's prefix, compared outside: a
     -- condition on the cell inside would have the planner hash the whole table again for each
     -- cell. "Later than the cell" (not "at or later") and "any deletion listing it" (not only
     -- the earliest) are as 09 §5.9 says, but untested: no history its rules allow has been found
     -- that tells either from the other reading, so no case here can fail on them.
     WHERE (SELECT max(p.deletion_seq) FROM pending_blocks p
            WHERE p.seq = g.gseq AND p.path = g.gpath) > ${v}.rec_from
        OR EXISTS (SELECT 1 FROM content c
                   WHERE c.seq = g.gseq AND c.path = g.gpath AND c.removed_by IS NOT NULL
                     AND ${v}.rec_from < COALESCE(
                       (SELECT (t.body::jsonb ->> 'confirmed_event')::bigint FROM ${READABLE_CONTENT} t
                        WHERE t.seq = c.removed_by AND t.path = 'target'), c.removed_by))))`;

/**
 * Whether `cellWithheld` has anything to find in this tenant: a deletion was ever confirmed. A
 * block is pending or cleared only after one; every store without a deletion skips the test.
 */
export async function withholdingIn(tx: ReadTx): Promise<boolean> {
  const r = await tx.query<{ any: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM events WHERE type = 'deletion.confirmed') AS any",
  );
  return r.rows[0]?.any === true;
}
