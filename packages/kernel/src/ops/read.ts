// The read operations `query`, `history`, `catalog`, `pending` and `reads.list` (docs/zh-CN/spec/04-contract-types.md §4.2, §4.3, §4.5, §4.8, §8.3): the call context and the
// parameters into `read`, in one read transaction of the tenant store; the read is recorded in the
// store's read buffer once it succeeded (02-architecture §7 «read_log 的持久性»).

import { readBufferOf } from "../audit/index.ts";
import {
  type AsOfResult,
  type CatalogResult,
  catalogInTx,
  historyInTx,
  pendingInTx,
  type QueryReadResult,
  queryInTx,
  type ReadsListResult,
  readsListInTx,
  type TimelineResult,
} from "../read/index.ts";
import type { TenantStore } from "../store/ports.ts";
import { createOpsContext, type OpsContext } from "./context.ts";
import { flushReads } from "./flush-reads.ts";
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

/** Reads `params` (a `HistoryParams`) as `ctx.actor`: `timeline` or `as_of`. */
export async function history(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<TimelineResult | AsOfResult> {
  const reads = readBufferOf(store);
  const { result, entry } = await store.read((tx) =>
    historyInTx(tx, {
      actor: ctx.actor,
      task: ctx.task,
      now: ctx.now,
      visibility: ctx.visibility,
      params,
      read: newReadId(),
      reads,
    }),
  );
  reads.record(entry);
  return result;
}

/** The read audit (`reads.list`), for a user session. */
export async function readsList(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<ReadsListResult> {
  // The reads so far are written first, in a transaction of their own, as before a write: the
  // list is then of the table alone, numbered as written (02-architecture §7 «read_log 的持久性»).
  await flushReads(store, createOpsContext({ ...ctx, actor: "system", trigger: "flushReads" }));
  return store.read((tx) => readsListInTx(tx, { actor: ctx.actor, now: ctx.now, params }));
}

/** Reads `params` (a `CatalogParams`) as `ctx.actor`: `list`, `table` or `schema`. */
export async function catalog(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<CatalogResult> {
  const { result, entry } = await store.read((tx) =>
    catalogInTx(tx, {
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

/** Reads `params` (a `PendingParams`) as `ctx.actor`: the pending items, or one item's detail. */
export async function pending(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<Record<string, unknown>> {
  const { result, entry } = await store.read((tx) =>
    pendingInTx(tx, {
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
