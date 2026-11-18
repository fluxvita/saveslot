// The slots a credential can see, by name and table count only: for the MCP server's
// `instructions` (docs/zh-CN/spec/05-surfaces.md §9 «slot 清单») and for checking the `slot`
// argument of the `pending` prompt (§10.1 rule 2). Neither is a read of the contract: 05 §9 item 7
// says generating `instructions` "不是契约里的读取操作，不记读取记录", and §10.1 rule 1 says
// `prompts/get` records no read either. So this reads the store directly, outside any operation,
// and gives back nothing but names, counts, and whether the user created the slot: no table
// names, descriptions, fields, rows or versions.

import { slotCreators, type Visibility, visibleSlots } from "@fluxvita/saveslot-kernel";
import type { LocalTenant } from "./local-tenant.ts";

/** A slot the credential can see: its name, and how many of its tables it can see. */
export interface ListedSlot {
  readonly name: string;
  /** Base and derived tables both, those visible to the credential only (05 §9 «slot 清单» 1). */
  readonly tables: number;
  /**
   * Created by the user's session. A slot a connection instance created has a name an agent chose,
   * which may have been put to it (05 §9 «slot 清单» 2): `instructions` gives it inside the
   * boundary.
   */
  readonly byUser: boolean;
}

/** The slots `visibility` can see, by name (ascending), with their visible table counts. */
export async function slotList(tenant: LocalTenant, visibility: Visibility): Promise<ListedSlot[]> {
  const [slots, creators] = await tenant.store.read(async (tx) => {
    const visible = await visibleSlots(tx, visibility);
    return [
      visible,
      await slotCreators(
        tx,
        visible.map((s) => s.slot),
      ),
    ] as const;
  });
  return slots
    .map((s) => ({
      name: s.name,
      tables: s.tables.length,
      byUser: creators.get(s.slot) === "user",
    }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
