// `log.verify` (docs/zh-CN/spec/04-contract.md §17; 04-contract-types.md §8.4): checks the log's
// header chain, content checksums, index columns, removals and restore gaps, in one read
// transaction. `log.end` (§8.5): the newest event's seq and recorded time. For user sessions only.

import {
  ExportError,
  type ExportSummary,
  exportBatch,
  exportStart,
  type LogVerifyResult,
  verifyLog,
} from "../log/index.ts";
import type { TenantStore } from "../store/ports.ts";
import type { OpsContext } from "./context.ts";
import { OpsError } from "./errors.ts";
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
 * How long a service streaming an export waits for its reader to take a step's lines before it
 * gives the export up and cuts the connection (02-architecture §8 «格式版本、导出、导入与恢复»).
 */
export const EXPORT_STALL_MS = 30_000;

/** An export parameter as a count: a number, or its digits (the query string's form). */
function countParam(v: unknown, param: string): number | undefined {
  if (v === undefined) return undefined;
  const n = typeof v === "string" && /^(0|[1-9]\d*)$/.test(v) ? Number(v) : v;
  if (typeof n !== "number" || !Number.isSafeInteger(n) || n < 0) {
    throw new OpsError("invalid_argument", `${param} is not a count`, {
      reason: "malformed",
      param,
    });
  }
  return n;
}

/** An export parameter as a boolean: a boolean, or `true` / `false` (the query string's form). */
function flagParam(v: unknown, param: string): boolean | undefined {
  if (v === undefined) return undefined;
  if (v === true || v === "true") return true;
  if (v === false || v === "false") return false;
  throw new OpsError("invalid_argument", `${param} is true or false`, {
    reason: "malformed",
    param,
  });
}

/**
 * `export` for a user session (04-contract §17; 04-contract-types §8.4): the whole log, not what
 * a credential may see, written line by line through `sink` inside one read transaction. The
 * parameters are the contract's (`after_seq`, `include_pending_deletion`), given as the query
 * string gives them or as JSON does.
 */
export async function exportLog(
  store: TenantStore,
  ctx: OpsContext,
  params: Readonly<Record<string, unknown>>,
  sink: (line: string) => Promise<void>,
): Promise<ExportSummary> {
  for (const k of Object.keys(params)) {
    if (k !== "after_seq" && k !== "include_pending_deletion") {
      throw new OpsError("invalid_argument", `unknown parameter ${k}`, {
        reason: "malformed",
        param: k,
      });
    }
  }
  const afterSeq = countParam(params["after_seq"], "after_seq");
  const includePendingDeletion = flagParam(
    params["include_pending_deletion"],
    "include_pending_deletion",
  );
  // One short read transaction per step (the manifest, then each batch); the sink is awaited
  // between them, outside any transaction, so a slow reader holds no transaction and the
  // tenant's other reads and writes go on (on PGlite they share one queue with this).
  const refusal = (e: unknown): never => {
    if (!(e instanceof ExportError)) throw e;
    if (e.code === "invalid_after_seq") {
      throw new OpsError("invalid_argument", e.message, {
        reason: "malformed",
        param: "after_seq",
      });
    }
    throw e;
  };
  const start = await store
    .read(async (tx) => {
      await begin(tx, ctx);
      return exportStart(tx, { afterSeq, includePendingDeletion, exportedAt: ctx.now });
    })
    .catch(refusal);
  await sink(start.line);
  for (let from: number | undefined = start.after; from !== undefined; ) {
    const at = from;
    const b: Awaited<ReturnType<typeof exportBatch>> = await store
      .read((tx) => exportBatch(tx, start, at))
      .catch(refusal);
    for (const line of b.lines) await sink(line);
    from = b.next;
  }
  return {
    upto: start.upto,
    events: start.events,
    pendingDeletions: start.included ? "included" : "placeholder",
  };
}
