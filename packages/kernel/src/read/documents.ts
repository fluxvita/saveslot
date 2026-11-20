// A slot's schema document, from its current version's compiled definition (../schema/document-of.ts),
// and the rule texts of its derived tables as drafts wrote them (docs/zh-CN/spec/03-data-model/
// 07-schema-evolution.md «schema 文档格式»). The drafts of a slot are not its document: a draft
// changing a slot lists only the tables it changes.

import type { CompiledSchema, JsonValue, SlotId } from "@fluxvita/saveslot-contract-core";
import { fold, get, isObj } from "../request/index.ts";
import { documentOf } from "../schema/index.ts";
import type { ReadTx } from "../store/ports.ts";

/** The rule text a document gives each derived table, by table ID (matched by name, as filled in). */
export function ruleTexts(document: JsonValue, compiled: CompiledSchema): Map<string, string> {
  const out = new Map<string, string>();
  const tables = isObj(document) && Array.isArray(document["tables"]) ? document["tables"] : [];
  for (const t of tables) {
    if (!isObj(t) || typeof t["name"] !== "string" || !isObj(t["rule"])) continue;
    const sql = get(t["rule"], "sql");
    const c = compiled.tables.find((x) => fold(x.name) === fold(t["name"] as string));
    if (c !== undefined && c.kind === "derived" && typeof sql === "string") out.set(c.id, sql);
  }
  return out;
}

/**
 * Each derived table's rule text, by table ID, as the latest draft in effect that wrote the table
 * gave it: the versions in effect, latest first, each with the draft that became it.
 */
export async function ruleTextsOf(tx: ReadTx, slot: SlotId): Promise<Map<string, string>> {
  const r = await tx.query<{ draft: string | null; compiled: string | null }>(
    `SELECT d.body AS draft, c.body AS compiled
     FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     JOIN events ce ON ce.seq = v.compiled_seq
     JOIN events de ON de.op = ce.op AND de.type = 'schema.draft_submitted'
     JOIN content d ON d.seq = de.seq AND d.path = 'draft'
     WHERE v.slot_id = $1 AND v.state IN ('current', 'retired')
     ORDER BY v.sv DESC`,
    [slot],
  );
  const out = new Map<string, string>();
  for (const x of r.rows) {
    if (x.draft === null || x.compiled === null) continue;
    const texts = ruleTexts(
      JSON.parse(x.draft) as JsonValue,
      JSON.parse(x.compiled) as CompiledSchema,
    );
    for (const [id, sql] of texts) if (!out.has(id)) out.set(id, sql);
  }
  return out;
}

/** The slot's whole document: its current version's, on the current version. */
export async function slotDocument(
  tx: ReadTx,
  slot: { readonly slot: SlotId; readonly sv: number; readonly compiled: CompiledSchema },
): Promise<Record<string, unknown>> {
  const texts = await ruleTextsOf(tx, slot.slot);
  return documentOf(slot.compiled, slot.sv, (id) => texts.get(id));
}
