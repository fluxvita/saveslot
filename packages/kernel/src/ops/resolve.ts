// The `resolve` operation (docs/zh-CN/spec/04-contract-types.md §5.2): the call context and the
// request into the resolve pipeline, in one transaction of the tenant store. A `schema_change` item
// goes to ./schema-resolve.ts; every other type to the write path (../write/resolve.ts). Which one
// is told by the item the request names, before anything else is checked: a request that does not
// name one well, or names none, goes to the write path, which refuses it.
//
// `confirmation_mismatch` carries the item as it is now (`current`, 04-contract-types §9): the
// pending detail of the item, made by the pending read itself, in the same transaction (the
// mismatch is found before anything is appended, so the transaction still reads the snapshot it was
// found in). It counts as reading the item (04-contract §2 «什么算读到 item_ver»): the read goes into
// the buffer, which outlives the transaction's rollback.

import { readBufferOf } from "../audit/index.ts";
import { pendingInTx } from "../read/index.ts";
import type { TenantStore } from "../store/ports.ts";
import {
  itemRow,
  normalizeResolve,
  type ResolveReceipt,
  resolveInTx,
  WriteError,
} from "../write/index.ts";
import type { OpsContext } from "./context.ts";
import { createOpsContext } from "./context.ts";
import { flushReads } from "./flush-reads.ts";
import { newReadId, randomCrockford } from "./ids.ts";
import { resolveSchemaChangeInTx } from "./schema-resolve.ts";

const PREFIX = { row: "r_", entity: "e_", source: "s_", item: "pi_", partition: "p_" } as const;
const LENGTH = { row: 26, entity: 26, source: 16, item: 16, partition: 16 } as const;

/** Resolves the pending item `params` names (a `ResolveParams` as the caller sent it). */
export async function resolve(
  store: TenantStore,
  ctx: OpsContext,
  params: unknown,
): Promise<ResolveReceipt> {
  // The reads so far are written first, in a transaction of their own (as for `write`).
  await flushReads(store, createOpsContext({ ...ctx, actor: "system", trigger: "flushReads" }));
  const reads = readBufferOf(store);
  return store.write(async (tx) => {
    try {
      const named = normalizeResolve(params);
      const type = named.ok ? (await itemRow(tx, named.request.id))?.type : undefined;
      const path = type === "schema_change" ? resolveSchemaChangeInTx : resolveInTx;
      return await path(tx, {
        actor: ctx.actor,
        task: ctx.task,
        now: ctx.now,
        windows: {
          requestKey: ctx.idempotency_window,
          idempotencyKey: ctx.idempotency_key_window,
        },
        visibility: ctx.visibility,
        params,
        newId: (kind) => `${PREFIX[kind]}${randomCrockford(LENGTH[kind])}`,
        reads,
      });
    } catch (e) {
      if (!(e instanceof WriteError) || e.code !== "confirmation_mismatch") throw e;
      // The item as it is now, as the pending detail gives it, under the request's task.
      // Not reached failing: a mismatch comes after the decision is checked against the item's
      // type (conflict, awaiting and schema_change items, which the detail reads) and after the item
      // is found visible as the detail finds it (a schema_change item: every table of its slot). Failing anyway is the store at odds with
      // itself: internal, the detail's error its cause, not a stub nor an unrelated error.
      const p = params as { id: string; task?: unknown };
      let read: Awaited<ReturnType<typeof pendingInTx>>;
      try {
        read = await pendingInTx(tx, {
          actor: ctx.actor,
          task: typeof p.task === "string" ? p.task : ctx.task,
          now: ctx.now,
          visibility: ctx.visibility,
          params: { id: p.id },
          read: newReadId(),
        });
      } catch (cause) {
        throw new WriteError(
          "internal",
          "the item's detail could not be read for the mismatch",
          { reason: "inconsistent" },
          { cause },
        );
      }
      const { result, entry } = read;
      reads.record(entry);
      throw new WriteError(e.code, e.message, { ...e.detail, current: result });
    }
  });
}
