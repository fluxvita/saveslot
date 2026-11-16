// The source data an operation records (03-data-model/04-write-and-read «不变量：每次写入都有源数据»;
// 09-event-format §5.4 `source.recorded`): an evidence segment as a source event.

import type { SlotId } from "@fluxvita/saveslot-contract-core";
import type { NewEvent } from "../log/index.ts";
import type { EvidenceSegment } from "../request/index.ts";

/** One evidence segment as a `source.recorded` event. */
export function evidenceSource(ev: EvidenceSegment, slot: SlotId, sourceId: string): NewEvent {
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
