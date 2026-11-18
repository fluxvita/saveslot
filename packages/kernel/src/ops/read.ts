// The read operations `query`, `history`, `catalog`, `pending` and `reads.list` (docs/zh-CN/spec/04-contract-types.md §4.2, §4.3, §4.5, §4.8, §8.3): the call context and the
// parameters into `read`, in one read transaction of the tenant store; the read is recorded in the
// store's read buffer once it succeeded (02-architecture §7 «read_log 的持久性»). A caller may keep
// less of a read than was asked for (`Fit`): what is recorded is then what it keeps.

import { readBufferOf } from "../audit/index.ts";
import {
  type AsOfResult,
  type CatalogResult,
  catalogInTx,
  historyInTx,
  type PendingReadResult,
  pendingInTx,
  type QueryReadResult,
  queryInTx,
  type ReadsListResult,
  readsListInTx,
  type TimelineResult,
} from "../read/index.ts";
import type { ReadTx, TenantStore } from "../store/ports.ts";
import { createOpsContext, type OpsContext } from "./context.ts";
import { flushReads } from "./flush-reads.ts";
import { newReadId } from "./ids.ts";

/**
 * How much of a read the caller keeps: given the result as first computed, at most how many of
 * its entries (rows, a timeline's entries, items, the catalog's tables); undefined keeps all.
 * Synchronous: the read waits on nothing of the caller's. The read is then computed once more
 * with `limit` that many, in the same read transaction, and only that one is recorded, so that
 * the rows recorded as read are exactly the rows the caller is given and the next page starts at
 * the first entry not kept. 0 keeps nothing: nothing is recorded and `NothingKept` is thrown. A
 * result that is no page (an item's detail, the catalog's tables or schema) can be kept whole or
 * not at all: only undefined and 0. Any other answer is the caller's fault; what `fit` throws
 * goes up as it is, with nothing recorded.
 */
export type Fit = (result: unknown) => number | undefined;

/** A read of which the caller's `Fit` kept nothing: nothing was recorded. */
export class NothingKept extends Error {
  override readonly name = "NothingKept";
  constructor() {
    super("the caller kept none of the read");
  }
}

/** How many entries a result is a page of; undefined for a result that is no page. */
type Count<R> = (result: R) => number | undefined;

const length = (x: unknown) => (Array.isArray(x) ? x.length : 0);

/**
 * Computes a read in one read transaction, kept to what `fit` says: computed once more with the
 * limit it gives, or not at all when it keeps nothing. The entry is the one to record.
 */
async function measured<R, E>(
  store: TenantStore,
  params: unknown,
  compute: (tx: ReadTx, params: unknown) => Promise<{ result: R; entry: E }>,
  count: Count<R>,
  fit: Fit | undefined,
): Promise<{ result: R; entry: E }> {
  return store.read(async (tx) => {
    const first = await compute(tx, params);
    if (fit === undefined) return first;
    const keep = fit(first.result);
    if (keep === undefined) return first;
    if (keep === 0) throw new NothingKept();
    const n = count(first.result);
    if (n === undefined || !Number.isSafeInteger(keep) || keep < 1 || keep >= n) {
      throw new Error("a read's fit kept an amount the read does not have");
    }
    const asked = typeof params === "object" && params !== null ? params : {};
    return compute(tx, { ...asked, limit: keep });
  });
}

/** Reads `params` (a `QueryParams` as the caller sent it) as `ctx.actor`. */
export async function query(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
  fit?: Fit,
): Promise<QueryReadResult> {
  const { result, entry } = await measured(
    store,
    params,
    (tx, p) =>
      queryInTx(tx, {
        actor: ctx.actor,
        task: ctx.task,
        now: ctx.now,
        visibility: ctx.visibility,
        params: p,
        read: newReadId(),
      }),
    (r) => r.rows.length,
    fit,
  );
  readBufferOf(store).record(entry);
  return result;
}

/** Reads `params` (a `HistoryParams`) as `ctx.actor`: `timeline` or `as_of`. */
export async function history(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
  fit?: Fit,
): Promise<TimelineResult | AsOfResult> {
  const reads = readBufferOf(store);
  const { result, entry } = await measured(
    store,
    params,
    (tx, p) =>
      historyInTx(tx, {
        actor: ctx.actor,
        task: ctx.task,
        now: ctx.now,
        visibility: ctx.visibility,
        params: p,
        read: newReadId(),
        reads,
      }),
    (r) => ("entries" in r ? length(r.entries) : length((r as { rows?: unknown }).rows)),
    fit,
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
  fit?: Fit,
): Promise<CatalogResult> {
  const { result, entry } = await measured(
    store,
    params,
    (tx, p) =>
      catalogInTx(tx, {
        actor: ctx.actor,
        task: ctx.task,
        now: ctx.now,
        visibility: ctx.visibility,
        params: p,
        read: newReadId(),
      }),
    // The list is a page of tables; the tables and the schema are no page.
    (r) =>
      r.level === "list"
        ? r.slots.reduce((n, slot) => n + length((slot as { tables?: unknown }).tables), 0)
        : undefined,
    fit,
  );
  readBufferOf(store).record(entry);
  return result;
}

/** Reads `params` (a `PendingParams`) as `ctx.actor`: the pending items, or one item's detail. */
export async function pending(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
  fit?: Fit,
): Promise<PendingReadResult> {
  const { result, entry } = await measured(
    store,
    params,
    (tx, p) =>
      pendingInTx(tx, {
        actor: ctx.actor,
        task: ctx.task,
        now: ctx.now,
        visibility: ctx.visibility,
        params: p,
        read: newReadId(),
      }),
    // The list is a page of items; an item's detail is no page.
    (r) => ("items" in r ? length(r["items"]) : undefined),
    fit,
  );
  readBufferOf(store).record(entry);
  return result;
}
