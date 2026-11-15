// The `write` operation (docs/zh-CN/spec/04-contract-types.md §5.1): the call context and the
// request into the write pipeline, in one transaction of the tenant store.
//
// Not reachable from any surface yet: the pending item contents (entries, items a write refreshes
// or supersedes) are not produced, so the receipt and the log lack them until they are.

import type { TenantStore } from "../store/ports.ts";
import { type WriteReceipt, writeInTx } from "../write/index.ts";
import type { OpsContext } from "./context.ts";
import { randomCrockford } from "./ids.ts";

const PREFIX = { row: "r_", entity: "e_", source: "s_", item: "pi_" } as const;
const LENGTH = { row: 26, entity: 26, source: 16, item: 16 } as const;

/** Writes `params` (a `WriteParams` as the caller sent it) as `ctx.actor`. */
export function write(store: TenantStore, ctx: OpsContext, params: unknown): Promise<WriteReceipt> {
  return store.write((tx) =>
    writeInTx(tx, {
      actor: ctx.actor,
      task: ctx.task,
      now: ctx.now,
      windows: { requestKey: ctx.idempotency_window, idempotencyKey: ctx.idempotency_key_window },
      visibility: ctx.visibility,
      params,
      newId: (kind) => `${PREFIX[kind]}${randomCrockford(LENGTH[kind])}`,
    }),
  );
}
