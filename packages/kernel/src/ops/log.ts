// `log.verify` (docs/zh-CN/spec/04-contract.md §17; 04-contract-types.md §8.4): checks the log's
// header chain, content checksums, index columns, removals and restore gaps, in one read
// transaction. `log.end` (§8.5): the newest event's seq and recorded time. For user sessions only.

import {
  type ExportParams,
  type ExportSummary,
  type LogVerifyResult,
  verifyLog,
  writeExport,
} from "../log/index.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { begin } from "./management.ts";

/** `log.verify` for a user session. */
export async function logVerify(store: TenantStore, ctx: OpsContext): Promise<LogVerifyResult> {
  return store.read(async (tx) => {
    await begin(tx, ctx);
    return verifyLog(tx);
  });
}

/** 04-contract-types §8.5 `LogEndResult`: the newest event, or null for a log with none. */
export type LogEnd = { readonly seq: number; readonly recorded_at: string } | null;

/**
 * `log.end` for a user session: the seq and recorded time (the events' `at`, as every recorded
 * time the contract gives) of the newest event. What `saveslot status` measures the clock against
 * (02-architecture §8).
 */
export async function logEnd(store: TenantStore, ctx: OpsContext): Promise<LogEnd> {
  return store.read(async (tx) => {
    await begin(tx, ctx);
    const r = await tx.query<{ seq: string | number; at: string }>(
      "SELECT seq, at FROM events ORDER BY seq DESC LIMIT 1",
    );
    const last = r.rows[0];
    return last === undefined ? null : { seq: Number(last.seq), recorded_at: last.at };
  });
}

/**
 * `export` for a user session (04-contract §17; 04-contract-types §8.4): the whole log, not what
 * a credential may see, written line by line through `sink` inside one read transaction.
 */
export async function exportLog(
  store: TenantStore,
  ctx: OpsContext,
  params: Omit<ExportParams, "exportedAt">,
  sink: (line: string) => Promise<void>,
): Promise<ExportSummary> {
  return store.read(async (tx) => {
    await begin(tx, ctx);
    return writeExport(tx, { ...params, exportedAt: ctx.now }, sink);
  });
}
