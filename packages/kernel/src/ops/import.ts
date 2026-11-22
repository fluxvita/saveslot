// Import into an empty tenant, the steps into the staging storage (docs/zh-CN/spec/02-architecture.md
// §8 «格式版本、导出、导入与恢复»; 04-contract.md §17 `import`; 09-event-format §8):
//
//   ① the file is checked as it is read (`ExportFileReader`: the checks of `log.verify`);
//   ② each event is appended as it is to a staging storage the host opened for this import, and
//      given to `apply`, its blocks in the three states.
//
// Not here yet: ③ `tenant.imported` and the tombstones of placeholders, ④–⑥ the marker, the swap
// and the anchor. Until apply knows the deletion events, a file holding any stops at the first one
// as `replay_failed` (the event is not in this version's apply); the staging storage is then left
// for the host to discard and the tenant stays empty.
//
// The staging storage is written in batches of events, each its own transaction: a file is not
// held in memory, and a rejected import leaves a staging storage the host discards as a whole. The
// staging storage is only ever discarded or swapped in whole, so a partly written one is never
// read.

import type { ExportManifest, JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import { ApplyError, type ApplyEvent, applyEvents } from "../apply/index.ts";
import {
  appendExported,
  type BlockState,
  type ExportedEvent,
  ExportFileReader,
  ImportRejected,
  readTail,
} from "../log/index.ts";
import type { ImportId } from "../store/anchor.ts";
import type { TenantStore } from "../store/ports.ts";
import { OpsError } from "./errors.ts";
import { randomCrockford } from "./ids.ts";

/** A new import ID (`im_…`): names the staging storage and pairs with the anchor's marker. */
export const newImportId = (): ImportId => `im_${randomCrockford(16)}`;

export interface StagedImport {
  /** The first segment's manifest, with the last segment's end and restore count (09 §8). */
  readonly manifest: ExportManifest;
  /** The last imported event's `seq`: `imported_upto` of the import's event. */
  readonly importedUpto: Seq;
  readonly events: number;
  readonly segments: number;
}

const BATCH = 200;

/**
 * The longest line an export file may have, in bytes (09 §8): far above any one event's, so that
 * only a file that is not an export meets it, and a body is never held whole in memory.
 */
export const MAX_IMPORT_LINE_BYTES = 16 * 1024 * 1024;

/** A line of the file longer than {@link MAX_IMPORT_LINE_BYTES}: `too_large` (`import_line`). */
export class ImportLineTooLarge extends Error {
  readonly code = "too_large";
  readonly reason = "import_line";
  readonly limitBytes = MAX_IMPORT_LINE_BYTES;
  constructor() {
    super("a line of the export file is longer than the limit");
    this.name = "ImportLineTooLarge";
  }
}

/**
 * Steps ① and ②: reads the export file from `body` (NDJSON, the segments one after the other),
 * checks it and replays it into `staging`, an empty storage the host opened for this import.
 * Throws {@link ImportRejected} at the first problem, `replay_failed` when apply stops at an
 * event, {@link ImportLineTooLarge} for a line over the limit; any other failure of writing the
 * staging storage is an internal error that carries nothing of the file. The staging storage is
 * then the host's to discard.
 */
export async function importIntoStaging(o: {
  readonly staging: TenantStore;
  /** The file's bytes, as a request body gives them. */
  readonly body: AsyncIterable<Uint8Array>;
  /** Events per write transaction. */
  readonly batch?: number;
}): Promise<StagedImport> {
  if ((await o.staging.read((tx) => readTail(tx))) !== undefined) {
    throw new OpsError("internal", "importIntoStaging: the staging storage is not empty");
  }
  const reader = new ExportFileReader();
  const size = o.batch ?? BATCH;
  let pending: ExportedEvent[] = [];
  const flush = async () => {
    const events = pending;
    pending = [];
    if (events.length > 0) await replay(o.staging, events);
  };
  for await (const line of lines(o.body)) {
    const e = reader.line(line);
    if (e === undefined) continue;
    pending.push(e);
    if (pending.length >= size) await flush();
  }
  await flush();
  const s = reader.end();
  return { manifest: s.manifest, importedUpto: s.upto, events: s.events, segments: s.segments };
}

/** Appends a batch of checked events as they are and applies them, in one transaction. */
async function replay(store: TenantStore, events: readonly ExportedEvent[]): Promise<void> {
  try {
    await store.write(async (tx) => {
      for (const e of events) {
        await appendExported(tx, e);
        await applyEvents(tx, [applyEventOf(e)]);
      }
    });
  } catch (err) {
    // Neither apply's message nor the storage's goes out: they may quote the file's content.
    if (err instanceof ApplyError) {
      throw new ImportRejected("replay_failed", "apply stopped at this event", { seq: err.seq });
    }
    if (err instanceof ImportRejected) throw err;
    throw new OpsError("internal", "the staging storage could not take an event");
  }
}

/**
 * An event as apply reads it. A placeholder's content is not in the file: apply reads it as a
 * block it cannot read, the state the tombstone the import adds for it gives the block in the
 * end (09 §5.2).
 */
function applyEventOf(e: ExportedEvent): ApplyEvent {
  return {
    seq: e.seq,
    header: e.header,
    blocks: new Map(
      e.blocks.map((b): [string, BlockState] => [
        b.path,
        b.state === "present"
          ? { state: "present", value: b.value as JsonValue }
          : { state: "removed", by: b.state === "removed" ? b.by : b.of },
      ]),
    ),
  };
}

/**
 * The lines of an NDJSON body (09 §8: UTF-8, each line ending in 0x0A), each decoded whole. Only the
 * bytes that came in are searched for a newline, so the work is linear in the body; a line longer
 * than {@link MAX_IMPORT_LINE_BYTES} stops the import as soon as it is. A last line without its
 * newline is taken as it is: a cut file fails the manifest's counts. An empty line goes to the
 * reader, which refuses it as not JSON.
 */
async function* lines(body: AsyncIterable<Uint8Array>): AsyncGenerator<string> {
  // A BOM is kept, not stripped: a line starting with one is not its own JCS text (§8).
  const decoder = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true });
  const decode = (parts: readonly Uint8Array[], length: number): string => {
    const bytes = new Uint8Array(length);
    let at = 0;
    for (const p of parts) {
      bytes.set(p, at);
      at += p.length;
    }
    try {
      return decoder.decode(bytes);
    } catch {
      throw new ImportRejected("unsupported_format", "the file is not UTF-8");
    }
  };
  let parts: Uint8Array[] = [];
  let length = 0;
  for await (const chunk of body) {
    if (!(chunk instanceof Uint8Array)) {
      throw new OpsError("internal", "importIntoStaging: a body chunk is not bytes");
    }
    let start = 0;
    for (let i = chunk.indexOf(0x0a); i >= 0; i = chunk.indexOf(0x0a, start)) {
      if (length + (i - start) > MAX_IMPORT_LINE_BYTES) throw new ImportLineTooLarge();
      parts.push(chunk.subarray(start, i));
      yield decode(parts, length + (i - start));
      parts = [];
      length = 0;
      start = i + 1;
    }
    if (start < chunk.length) {
      length += chunk.length - start;
      if (length > MAX_IMPORT_LINE_BYTES) throw new ImportLineTooLarge();
      parts.push(chunk.slice(start));
    }
  }
  if (length > 0) yield decode(parts, length);
}
