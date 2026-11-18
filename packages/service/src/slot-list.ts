// The slots a credential can see, by name and table count only: for the MCP server's
// `instructions` (docs/zh-CN/spec/05-surfaces.md §9 «slot 清单») and for checking the `slot`
// argument of the `pending` prompt (§10.1 rule 2). Neither is a read of the contract: 05 §9 item 7
// says generating `instructions` "不是契约里的读取操作，不记读取记录", and §10.1 rule 1 says
// `prompts/get` records no read either. So this reads the store directly, outside any operation,
// and gives back nothing but names and counts: no table names, descriptions, fields, rows or
// versions.

import { type Visibility, visibleSlots } from "@fluxvita/saveslot-kernel";
import type { LocalTenant } from "./local-tenant.ts";

/** A slot the credential can see: its name, and how many of its tables it can see. */
export interface ListedSlot {
  readonly name: string;
  /** Base and derived tables both, those visible to the credential only (05 §9 «slot 清单» 1). */
  readonly tables: number;
}

/** The slots `visibility` can see, by name (ascending), with their visible table counts. */
export async function slotList(tenant: LocalTenant, visibility: Visibility): Promise<ListedSlot[]> {
  const slots = await tenant.store.read((tx) => visibleSlots(tx, visibility));
  return slots
    .map((s) => ({ name: s.name, tables: s.tables.length }))
    .sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0));
}
