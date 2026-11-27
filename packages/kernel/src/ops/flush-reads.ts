// The internal operation `flushReads` (docs/zh-CN/spec/02-architecture.md §4 «契约操作与内部操作»,
// §7 «read_log 的持久性»): writes the open store's buffered reads in a write transaction of its
// own. The scheduler outside the kernel calls it at each flush interval, and before the storage is
// closed (`closeTenant` flushes first). A write operation flushes at its own start the same way:
// in its own transaction, so the reads are written even when the operation is refused. A store
// with `recordReads` buffers nothing (`keepRead` writes each read at once): there is nothing to flush.

import { flushBuffer, type ReadEntry, readBufferOf, writeReads } from "../audit/index.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";

export interface FlushReadsResult {
  /** Reads written. */
  readonly flushed: number;
}

/** Writes the buffered reads of `store`. Nothing to write: no transaction is opened. */
export async function flushReads(store: TenantStore, ctx: OpsContext): Promise<FlushReadsResult> {
  if (ctx.trigger !== "flushReads" && ctx.trigger !== "closeTenant") {
    throw new OpsError("internal", "flushReads runs as the flushReads or closeTenant task");
  }
  const buffer = readBufferOf(store);
  if (buffer.size === 0) return { flushed: 0 };
  let taken: readonly unknown[] = [];
  try {
    await store.write(async (tx) => {
      taken = await flushBuffer(tx, buffer);
    });
  } catch (e) {
    // Written but not committed: back into the buffer, ahead of reads recorded since.
    if (taken.length > 0) buffer.restore(taken as never);
    throw e;
  }
  return { flushed: taken.length };
}

/**
 * A read that succeeded but whose record could not be written (the store's `recordReads` failed):
 * the read is not given to its caller, who tries again (02-architecture §7 «read_log 的持久性»).
 * The database's own message stays in `cause`, not in the message.
 */
export class ReadNotRecorded extends Error {
  override readonly name = "ReadNotRecorded";
  constructor(cause: unknown) {
    super("the read could not be recorded", { cause });
  }
}

/**
 * Records a read that succeeded, before it is given to its caller. A store with `recordReads`
 * writes it now, in a transaction of its own; one without keeps it in its read buffer, written
 * later (02-architecture §7 «read_log 的持久性»).
 */
export async function keepRead(store: TenantStore, entry: ReadEntry): Promise<void> {
  if (store.recordReads === undefined) {
    readBufferOf(store).record(entry);
    return;
  }
  try {
    await store.recordReads((tx) => writeReads(tx, [entry]));
  } catch (e) {
    throw new ReadNotRecorded(e);
  }
}
