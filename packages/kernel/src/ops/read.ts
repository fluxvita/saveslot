// The `query` operation (docs/zh-CN/spec/04-contract-types.md §4.3): the call context and the
// parameters into `read`, in one read transaction of the tenant store; the read is recorded in the
// store's read buffer once it succeeded (02-architecture §7 «read_log 的持久性»).

import { readBufferOf } from "../audit/index.ts";
import { type QueryReadResult, queryInTx } from "../read/index.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { newReadId } from "./ids.ts";

/** Reads `params` (a `QueryParams` as the caller sent it) as `ctx.actor`. */
export async function query(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<QueryReadResult> {
  const { result, entry } = await store.read((tx) =>
    queryInTx(tx, {
      actor: ctx.actor,
      task: ctx.task,
      now: ctx.now,
      visibility: ctx.visibility,
      params,
      read: newReadId(),
    }),
  );
  readBufferOf(store).record(entry);
  return result;
}
