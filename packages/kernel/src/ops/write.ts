// The `write` operation (docs/zh-CN/spec/04-contract-types.md §5.1): the call context and the
// request into the write pipeline, in one transaction of the tenant store.
//
// Not reachable from any surface yet: the pending item contents (entries, items a write refreshes
// or supersedes) are not produced, so the receipt and the log lack them until they are.

import { readBufferOf } from "../audit/index.ts";
import { noteEffect, restoresAt, restoresOf } from "../log/index.ts";
import type { TenantStore } from "../store/ports.ts";
import { type WriteReceipt, writeInTx } from "../write/index.ts";
import { createOpsContext, type OpsContext } from "./context.ts";
import { flushReads } from "./flush-reads.ts";
import { randomCrockford } from "./ids.ts";

const PREFIX = { row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" } as const;
const LENGTH = { row: 26, entity: 26, source: 16, item: 16, partition: 16 } as const;

/** Writes `params` (a `WriteParams` as the caller sent it) as `ctx.actor`. */
export async function write(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<WriteReceipt> {
  // The reads so far are written first, in a transaction of their own: they stay written even if
  // this write is refused and rolled back (02-architecture §7 «read_log 的持久性»).
  await flushReads(store, createOpsContext({ ...ctx, actor: "system", trigger: "flushReads" }));
  return store.write(async (tx) => {
    const r = await writeInTx(tx, {
      actor: ctx.actor,
      task: ctx.task,
      now: ctx.now,
      windows: { requestKey: ctx.idempotency_window, idempotencyKey: ctx.idempotency_key_window },
      visibility: ctx.visibility,
      params,
      newId: (kind) => `${PREFIX[kind]}${randomCrockford(LENGTH[kind])}`,
      reads: readBufferOf(store),
    });
    // No operation number: every op keyed by its source and unchanged or skipped, nothing appended.
    return noteEffect(
      r,
      r.seq === undefined
        ? { effect: "none" }
        : {
            effect: r.replayed === true ? "replayed" : "appended",
            seq: r.seq,
            // A replay's: its operation's time's, so that (restores, seq) names that operation.
            restores:
              r.replayed === true ? await restoresAt(tx, r.seq) : await restoresOf(store, tx),
            status: r.status,
          },
    );
  });
}
