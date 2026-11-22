// The `schema_updated` notices of a call (04-contract §13), with "last read" as the `sv` fallback
// takes it (04-contract §2): the later of the caller's last read of the slot and its own last
// write's `sv`, under the call's task. Composed here, where both the reads and the write receipts
// are in reach.

import type { NoticeCaller, NoticeRefs, SchemaUpdatedNotice, Visibility } from "../read/index.ts";
import { lastReadSv, schemaUpdatedNoticesWith } from "../read/index.ts";
import type { TenantStore } from "../store/ports.ts";
import { svFromWrite } from "../write/reads.ts";

export function schemaUpdatedNotices(
  store: TenantStore,
  visibility: Visibility,
  caller: NoticeCaller,
  refs: NoticeRefs,
): Promise<SchemaUpdatedNotice[]> {
  const read = lastReadSv(store, caller);
  return schemaUpdatedNoticesWith(
    store,
    visibility,
    async (tx, slot) => {
      const r = await read(tx, slot);
      const own = await svFromWrite(tx, slot, caller.actor, caller.task);
      const w = "found" in own ? own.found : undefined;
      return r === undefined ? w : w === undefined ? r : Math.max(r, w);
    },
    refs,
  );
}
