// The export file (docs/zh-CN/spec/09-event-format.md §8; 04-contract-types §8.4 `export`): the
// manifest line, then one line per event with its blocks in the three states of §3.3.
//
// The export is made in steps: `exportStart` (the manifest, which fixes `upto`) and `exportBatch`
// (event lines), each in a read transaction the caller opens, so a long log never sits in memory
// and a caller that streams to a slow reader need not hold one transaction throughout. Every step
// after the manifest reads only up to `upto`: events appended meanwhile are not in the file, and
// the file says what it holds.
//
// Not done yet: placeholders for content pending deletion (the default of an export that has
// pending deletions). An export that meets a pending deletion without being told to include its
// content stops, saying so (`ExportError` `pending_deletion_unsupported`); it never writes the
// content out unasked.

import {
  canonicalize,
  type ExportManifest,
  type Instant,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";

export type ExportErrorCode =
  | "invalid_after_seq"
  | "pending_deletion_unsupported"
  | "changed_during_export"
  | "corrupt_log";

export class ExportError extends Error {
  readonly code: ExportErrorCode;
  constructor(code: ExportErrorCode, message: string) {
    super(message);
    this.name = "ExportError";
    this.code = code;
  }
}

export interface ExportParams {
  /** Continue after this event: the file holds events with a greater `seq`. */
  readonly afterSeq?: Seq | undefined;
  /** Include the content of deletions still in their grace period (default: no). */
  readonly includePendingDeletion?: boolean | undefined;
  /** The export time, written in the manifest. */
  readonly exportedAt: Instant;
}

export interface ExportSummary {
  readonly upto: Seq;
  readonly events: number;
  readonly pendingDeletions: "placeholder" | "included";
}

const n = (v: unknown): number => Number(v);
const BATCH = 500;

/** The deletions confirmed and neither executed nor cancelled, by deletion ID. */
async function pendingDeletions(tx: ReadTx, upto: Seq): Promise<string[]> {
  const r = await tx.query<{ type: string; body: string | null }>(
    `SELECT e.type, c.body FROM events e
     JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE e.seq <= $1 AND e.type IN ('deletion.confirmed', 'deletion.cancelled', 'deletion.executed')
     ORDER BY e.seq`,
    [upto],
  );
  const pending = new Set<string>();
  for (const row of r.rows) {
    if (row.body === null) throw new ExportError("corrupt_log", "a deletion event lost its target");
    const id = (JSON.parse(row.body) as { deletion?: unknown }).deletion;
    if (typeof id !== "string") throw new ExportError("corrupt_log", "a deletion target has no ID");
    if (row.type === "deletion.confirmed") pending.add(id);
    else pending.delete(id);
  }
  return [...pending];
}

/** What the first step of an export settles: its manifest line and the bounds of the rest. */
export interface ExportStart {
  /** The manifest, as its line (with `\n`). */
  readonly line: string;
  readonly after: Seq;
  readonly upto: Seq;
  readonly events: number;
  readonly included: boolean;
  /** The deletions pending when the export started, by ID. */
  readonly pending: readonly string[];
}

/**
 * The first step of an export, in a read transaction the caller holds: checks the parameters,
 * fixes `upto` (the log's end now) and writes nothing. Every later step reads only up to it.
 */
export async function exportStart(tx: ReadTx, params: ExportParams): Promise<ExportStart> {
  const after = params.afterSeq ?? 0;
  if (!Number.isSafeInteger(after) || after < 0) {
    throw new ExportError("invalid_after_seq", "after_seq is not a count");
  }
  const end = await tx.query<{ seq: unknown }>("SELECT max(seq) AS seq FROM events");
  const upto = n(end.rows[0]?.seq ?? 0);
  if (upto === 0) throw new ExportError("corrupt_log", "the log is empty");
  if (after > upto) throw new ExportError("invalid_after_seq", "after_seq is beyond the log's end");

  const included = params.includePendingDeletion === true;
  const pending = await pendingDeletions(tx, upto);
  if (!included && pending.length > 0) throw pendingRefusal();

  const count = await tx.query<{ c: unknown }>(
    "SELECT count(*) AS c FROM events WHERE seq > $1 AND seq <= $2",
    [after, upto],
  );
  const events = n(count.rows[0]?.c);

  // The current tenant ID and restore count: from the latest genesis / imported event, and the
  // latest restored / imported event.
  const tenantRow = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM content c
     WHERE c.path = 'tenant' AND c.seq = (
       SELECT max(seq) FROM events WHERE type IN ('tenant.genesis', 'tenant.imported') AND seq <= $1)`,
    [upto],
  );
  const tenantBody = tenantRow.rows[0]?.body;
  if (tenantBody === null || tenantBody === undefined) {
    throw new ExportError("corrupt_log", "the log has no tenant block");
  }
  const tenantId = (JSON.parse(tenantBody) as { tenant_id: string }).tenant_id;
  const rc = await tx.query<{ header: string }>(
    `SELECT header FROM events WHERE type IN ('tenant.restored', 'tenant.imported') AND seq <= $1
     ORDER BY seq DESC LIMIT 1`,
    [upto],
  );
  const restoreCount =
    rc.rows[0] === undefined
      ? 0
      : n((JSON.parse(rc.rows[0].header) as { restore_count: unknown }).restore_count);

  const manifest = {
    saveslot_export: 1,
    tenant_id: tenantId,
    event_format: 1,
    restore_count: restoreCount,
    ...(after > 0 ? { after } : {}),
    upto,
    events,
    exported_at: params.exportedAt,
    pending_deletions: included ? "included" : "placeholder",
  } as ExportManifest;
  return {
    line: `${canonicalize(manifest as never)}\n`,
    after,
    upto,
    events,
    included,
    pending,
  };
}

const pendingRefusal = () =>
  new ExportError(
    "pending_deletion_unsupported",
    "a deletion is in its grace period and placeholders for its content are not implemented; export with include_pending_deletion or after it has run",
  );

/**
 * One batch of event lines after `from`, up to `start.upto`, in a read transaction the caller
 * holds; `next` is where the next batch starts, undefined when this was the last. Without
 * `include_pending_deletion`, a deletion confirmed since the export started stops it
 * (`changed_during_export`): its content may be in the lines still to come.
 */
export async function exportBatch(
  tx: ReadTx,
  start: ExportStart,
  from: Seq,
  batch = BATCH,
): Promise<{ readonly lines: readonly string[]; readonly next: Seq | undefined }> {
  if (!start.included) {
    // The whole log, not up to `upto`: a deletion confirmed after the start is an event past it,
    // and the content it names may be in the lines still to come.
    const now = await pendingDeletions(tx, Number.MAX_SAFE_INTEGER);
    if (now.some((id) => !start.pending.includes(id))) {
      throw new ExportError(
        "changed_during_export",
        "a deletion was confirmed while the export ran; export again",
      );
    }
  }
  const evs = await tx.query<{ seq: unknown; header: string }>(
    "SELECT seq, header FROM events WHERE seq > $1 AND seq <= $2 ORDER BY seq LIMIT $3",
    [from, start.upto, batch],
  );
  const last = evs.rows[evs.rows.length - 1];
  if (last === undefined) return { lines: [], next: undefined };
  const blocks = await tx.query<{
    seq: unknown;
    path: string;
    body: string | null;
    checksum: string | null;
    removed_by: unknown;
    placeholder_of: unknown;
  }>(
    `SELECT seq, path, body, checksum, removed_by, placeholder_of FROM content
     WHERE seq > $1 AND seq <= $2 ORDER BY seq, path COLLATE "C"`,
    [from, n(last.seq)],
  );
  const bySeq = new Map<number, Record<string, JsonValue>>();
  for (const b of blocks.rows) {
    // No prototype: a block path is never taken for an inherited key.
    const c = bySeq.get(n(b.seq)) ?? (Object.create(null) as Record<string, JsonValue>);
    bySeq.set(n(b.seq), c);
    if (b.removed_by !== null && n(b.removed_by) > start.upto) {
      // Cleared by a deletion executed after the start: the file would say the block is present
      // in the lines already written and removed here, by an event it does not hold. In both
      // modes: a deletion confirmed and executed between two steps leaves no pending trace.
      throw new ExportError(
        "changed_during_export",
        "a deletion was executed while the export ran; export again",
      );
    }
    if (b.removed_by !== null) c[b.path] = { removed_by: n(b.removed_by) };
    else if (b.body !== null) c[b.path] = { v: JSON.parse(b.body) as JsonValue, sum: b.checksum };
    else if (b.placeholder_of !== null) c[b.path] = { pending_deletion: n(b.placeholder_of) };
    else throw new ExportError("corrupt_log", "a content block has no state");
  }
  const lines = evs.rows.map((e) => {
    const c = bySeq.get(n(e.seq));
    // The header text is the stored JCS text; the line is `{"c": …, "h": …}` in JCS key order.
    return c === undefined
      ? `{"h":${e.header}}\n`
      : `{"c":${canonicalize(c as never)},"h":${e.header}}\n`;
  });
  const lastSeq = n(last.seq);
  return { lines, next: evs.rows.length < batch || lastSeq >= start.upto ? undefined : lastSeq };
}

/**
 * The whole export in one read transaction the caller holds, through `sink`, one line (with its
 * `\n`) per call: `exportStart` and every `exportBatch` in turn. For callers that hold the
 * transaction anyway (tests, a copy); a service streaming to a reader opens one transaction per
 * step instead, so that a slow reader does not hold the tenant (`ops.exportLog`).
 */
export async function writeExport(
  tx: ReadTx,
  params: ExportParams,
  sink: (line: string) => Promise<void>,
): Promise<ExportSummary> {
  const start = await exportStart(tx, params);
  await sink(start.line);
  for (let from: Seq | undefined = start.after; from !== undefined; ) {
    const b = await exportBatch(tx, start, from);
    for (const l of b.lines) await sink(l);
    from = b.next;
  }
  return {
    upto: start.upto,
    events: start.events,
    pendingDeletions: start.included ? "included" : "placeholder",
  };
}
