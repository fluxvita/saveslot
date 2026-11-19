// The source data an operation records (03-data-model/04-write-and-read «不变量：每次写入都有源数据»;
// 09-event-format §5.4 `source.recorded`): an evidence segment as a source event.

import type { Seq, SlotId } from "@fluxvita/saveslot-contract-core";
import type { NewEvent } from "../log/index.ts";
import type { EvidenceSegment } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { WriteError } from "./errors.ts";

/** A segment with content of its own: it becomes a new source. */
export type NewSegment = Exclude<EvidenceSegment, { readonly kind: "source_ref" }>;

/** One evidence segment as a `source.recorded` event. */
export function evidenceSource(ev: NewSegment, slot: SlotId, sourceId: string): NewEvent {
  return {
    type: "source.recorded",
    slot,
    blocks: {
      target: {
        source_id: sourceId,
        kind: ev.kind,
        // Declared on the segment, or by its kind (04-write-and-read «来源级别»).
        level: ev.level ?? (ev.kind === "user_message" ? "user_stated" : "agent_inferred"),
      },
      ...(ev.kind === "file_ref"
        ? {
            file: {
              name: ev.name,
              mime: ev.mime,
              size: ev.size,
              sha256: ev.sha256,
              ...(ev.origin !== undefined ? { origin: ev.origin } : {}),
              ...(ev.excerpt !== undefined ? { excerpt: ev.excerpt } : {}),
            },
          }
        : { text: { text: ev.text } }),
      ...(ev.stated_at !== undefined ? { stated_at: { at: ev.stated_at } } : {}),
    } as never,
  };
}

/** A segment where the request gives it: its parameter path, for errors. */
export interface PlacedSegment {
  readonly segment: EvidenceSegment;
  readonly param: string;
}

/**
 * An operation's evidence segments, in the order their sources are appended (09 §4.2: the
 * request's, then each op's own), checked and placed: a new segment is the next of `fresh` (to
 * append as `source.recorded` events in that order); a `source_ref` is the source it names, which
 * gets no event (04-contract §3). `seqsFrom(first)` numbers them once the operation is known, the
 * new segments from `first` on. Refused: a source that is not there or not visible
 * (`not_found`, `source`); one of another visible slot (`invalid_argument`, `cross_slot`); one the
 * system recorded for a call without evidence (`api_call`, `invalid_argument`, `malformed`): it
 * holds a request, not an original to support a value with; one in a pending deletion
 * (`invalid_argument`, `pending_deletion_source`).
 */
export async function placeEvidence(
  tx: ReadTx,
  placed: readonly PlacedSegment[],
  ctx: { readonly slot: SlotId; readonly visibleSlots: ReadonlySet<string> },
): Promise<{
  readonly seqsFrom: (first: number) => readonly Seq[];
  readonly fresh: readonly NewSegment[];
}> {
  // Each segment: the index of a new one, or the sequence number of the source it names.
  const places: ({ readonly fresh: number } | { readonly seq: Seq })[] = [];
  const fresh: NewSegment[] = [];
  // Every source the segments name, in one query.
  const named = [
    ...new Set(
      placed.flatMap(({ segment }) => (segment.kind === "source_ref" ? [segment.id] : [])),
    ),
  ];
  const found = new Map<
    string,
    { seq: unknown; kind: string; slot_id: string; deletion_state: string }
  >();
  if (named.length > 0) {
    const r = await tx.query<{
      source_id: string;
      seq: unknown;
      kind: string;
      slot_id: string;
      deletion_state: string;
    }>(
      "SELECT source_id, seq, kind, slot_id, deletion_state FROM sources WHERE source_id = ANY($1)",
      [named] as never,
    );
    for (const x of r.rows) found.set(x.source_id, x);
  }
  for (const { segment, param } of placed) {
    if (segment.kind !== "source_ref") {
      places.push({ fresh: fresh.length });
      fresh.push(segment);
      continue;
    }
    const row = found.get(segment.id);
    const at = `${param}/id`;
    // Not there, deleted, or out of range: the same answer (04-contract «不存在与不可见报同一个错误»).
    // Out of range is not reached in this version: a write needs every slot.
    if (
      row === undefined ||
      row.deletion_state === "removed" ||
      !ctx.visibleSlots.has(row.slot_id)
    ) {
      throw new WriteError("not_found", "no such source", { reason: "source", param: at });
    }
    if (row.slot_id !== ctx.slot) {
      throw new WriteError("invalid_argument", "the source is in another slot", {
        reason: "cross_slot",
        param: at,
      });
    }
    if (row.kind === "api_call") {
      throw new WriteError(
        "invalid_argument",
        "this source is the system's record of a call, not evidence to refer to",
        { reason: "malformed", param: at },
      );
    }
    // Not reached in this version: deletion comes later.
    if (row.deletion_state === "pending_deletion") {
      throw new WriteError("invalid_argument", "the source is in a pending deletion", {
        reason: "pending_deletion_source",
        param: at,
      });
    }
    places.push({ seq: Number(row.seq) as Seq });
  }
  return {
    seqsFrom: (first) => places.map((x) => ("seq" in x ? x.seq : ((first + x.fresh) as Seq))),
    fresh,
  };
}
