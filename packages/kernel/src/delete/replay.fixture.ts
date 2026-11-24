// A deletion's replay of one row for tests in other packages: judge's `deletionResult` on the
// records as written, with the items as the records give them (no item events read). The kernel's
// `delete` operation will pass what the log's item events say instead.

import { itemsByRecords } from "../judge/fates.ts";
import type { OpRecord, TableShape } from "../judge/model.ts";
import { deletionResult, type ExternalFor } from "../judge/replay-deletion.ts";
import { RowState } from "../judge/state.ts";

/**
 * The replay of the row with `deleted` taken away, nothing pending before; `external`: the
 * deletion and cancellation events already in the log as L of the conflict criterion, for a
 * replay's deleted set (none by default).
 */
export const deletionReplayForTests = (
  table: TableShape,
  records: readonly OpRecord[],
  deleted: ReadonlySet<string>,
  external: ExternalFor = () => [],
) =>
  deletionResult(
    table,
    records,
    deleted,
    new Set(),
    itemsByRecords(new RowState(table, records)),
    external,
  );
