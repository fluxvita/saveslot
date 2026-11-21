// A slot's schema document, from its current version's compiled definition (../schema/document-of.ts),
// and the rule texts of its derived tables as drafts wrote them (docs/zh-CN/spec/03-data-model/
// 07-schema-evolution.md «schema 文档格式»). The drafts of a slot are not its document: a draft
// changing a slot lists only the tables it changes.

import type { CompiledSchema, JsonValue, SlotId } from "@fluxvita/saveslot-contract-core";
import { fold, get, isObj } from "../request/index.ts";
import { documentOf } from "../schema/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { ReadError } from "./types.ts";

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

type SlotAt = { readonly slot: SlotId; readonly sv: number; readonly compiled: CompiledSchema };

/** The slot's whole document: its current version's, on the current version. */
export async function slotDocument(tx: ReadTx, slot: SlotAt): Promise<Record<string, unknown>> {
  const texts = await ruleTextsOf(tx, slot.slot);
  return documentOf(slot.compiled, slot.sv, (id) => texts.get(id));
}

/**
 * A draft's whole document (04-contract §10 `catalog` `draft`), whatever state the draft is in:
 * the slot as it would be once switched to the draft, from the draft's compiled definition. A
 * derived table's rule text is the draft's own where the draft lists the table, else the one in
 * effect (`ruleTextsOf`). Its `base_version` is the version the document holds on, so that given
 * back it is judged against what came since:
 * - a draft pending: the slot's current version (the slot does not switch while it is open);
 *   changed and submitted, it replaces the draft;
 * - a draft that took effect: its own version; given back, `no_change` while it is current,
 *   `draft_outdated` once the slot switched again;
 * - a draft given up and never in effect (superseded, rejected): the version it was written on;
 *   given back, `draft_outdated` once the slot switched since.
 * The version the draft compiles to with it; undefined when the slot has no such draft.
 */
export async function draftDocument(
  tx: ReadTx,
  slot: SlotAt,
  draft: string,
): Promise<{ readonly sv: number; readonly document: Record<string, unknown> } | undefined> {
  const r = await tx.query<{
    sv: unknown;
    state: string;
    draft: string | null;
    submitted: string | null;
    compiled: string | null;
  }>(
    `SELECT v.sv, v.state, d.body AS draft, t.body AS submitted, c.body AS compiled
     FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     JOIN events ce ON ce.seq = v.compiled_seq
     JOIN events de ON de.op = ce.op AND de.type = 'schema.draft_submitted'
     JOIN content d ON d.seq = de.seq AND d.path = 'draft'
     JOIN content t ON t.seq = de.seq AND t.path = 'target'
     WHERE v.draft_id = $1 AND v.slot_id = $2`,
    [draft, slot.slot],
  );
  const [x] = r.rows;
  if (x === undefined) return undefined;
  if (x.draft === null || x.compiled === null || x.submitted === null)
    throw new ReadError("internal", `the draft ${draft} is not in the log as written`);
  const sv = Number(x.sv);
  const writtenOn = (JSON.parse(x.submitted) as { base_version: number | null }).base_version;
  const holdsOn =
    x.state === "pending"
      ? slot.sv
      : x.state === "current" || x.state === "retired"
        ? sv
        : // Given up, never in effect: the version it was written on. Not reached for a slot's
          // first draft (it is never given up: a slot is created at once).
          (writtenOn ?? sv);
  const compiled = JSON.parse(x.compiled) as CompiledSchema;
  const own = ruleTexts(JSON.parse(x.draft) as JsonValue, compiled);
  const inEffect = await ruleTextsOf(tx, slot.slot);
  return {
    sv,
    document: documentOf(compiled, holdsOn, (id) => own.get(id) ?? inEffect.get(id)),
  };
}
