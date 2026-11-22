// A store's log copied into another store, for the replay checks of the property tests (K12: the
// log replayed into an empty storage gives the same tables). `events` and `content` are read in
// one read transaction and written in `seq` order (`content` by `seq`, then `path`), many rows to
// an INSERT rather than one statement a row. Each statement binds at most `MAX_PARAMS` parameters,
// far below PostgreSQL's limit of 65535.
//
// The rows are copied as they are, nothing checked; the caller applies them (`applyEvents`).

import type { SqlValue, TenantStore, Tx } from "@fluxvita/saveslot-kernel";

/** The most parameters one INSERT of the copy binds. */
export const MAX_PARAMS = 10_000;

/**
 * Copies the log of `from` into the write transaction `into` (on a store whose `events` and
 * `content` are empty) and gives the number of events copied.
 */
export async function copyLog(
  from: TenantStore,
  into: Tx,
  maxParams = MAX_PARAMS,
): Promise<number> {
  const { events, content } = await from.read(async (tx) => ({
    events: (await tx.query("SELECT * FROM events ORDER BY seq")).rows,
    content: (await tx.query("SELECT * FROM content ORDER BY seq, path")).rows,
  }));
  await insertRows(into, "events", events, maxParams);
  await insertRows(into, "content", content, maxParams);
  return events.length;
}

/** Inserts `rows` (all with the same columns) into `table`, in their order, many to a statement. */
export async function insertRows(
  tx: Tx,
  table: string,
  rows: readonly Record<string, unknown>[],
  maxParams = MAX_PARAMS,
): Promise<void> {
  const first = rows[0];
  if (first === undefined) return;
  const cols = Object.keys(first);
  const perStatement = Math.floor(maxParams / cols.length);
  if (perStatement < 1)
    throw new Error(`a row of ${table} binds more than ${maxParams} parameters`);
  for (let at = 0; at < rows.length; at += perStatement) {
    const chunk = rows.slice(at, at + perStatement);
    const params: SqlValue[] = [];
    const tuples = chunk.map((r) => {
      const marks = cols.map((c) => {
        params.push(r[c] as SqlValue);
        return `$${params.length}`;
      });
      return `(${marks.join(", ")})`;
    });
    await tx.query(`INSERT INTO ${table} (${cols.join(", ")}) VALUES ${tuples.join(", ")}`, params);
  }
}
