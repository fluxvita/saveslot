// Compiling the schema document that creates a slot (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式»; the compiled definition is 09-event-format.md §7, the changes §5.5).
//
// Pure: the slot ID and the next free table number come from the caller. The result is the
// definition of version 1 and the changes (`create_slot`, one `add_table` per table); every change
// of a new slot applies directly, so the outcome is `applied` (07 «改动分类» slot 新建 row).
//
// Errors, in this order, so the most telling one wins: a key v1 does not support
// (`not_in_this_version`); something in v1 not compiled yet (`not_implemented`: changing a slot,
// derived tables, aliases); the document's form (`invalid_argument`); the compilation rules
// (`validation_failed`, every finding).

import type {
  ChangesBlock,
  CompiledBaseField,
  CompiledBaseTable,
  CompiledSchema,
  CompiledUnit,
  FieldId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { isId } from "@fluxvita/saveslot-contract-core";
import { CURRENT_RSQL_VERSION } from "../rules/index.ts";
import { isObject, notYet, readDocument, unsupportedKey } from "./document.ts";
import type {
  CompileNewSlotInput,
  CompileResult,
  CompileWarning,
  DocField,
  DocSlot,
  DocTable,
} from "./model.ts";
import { defaultScale, unitOf } from "./units.ts";
import { fold, refTable, validate } from "./validate.ts";

/** Short IDs have at most 9 digits (01-objects «标识的写法»). */
const MAX_SHORT_NUMBER = 999_999_999;

/** Field and table IDs by name, for the references inside the definition. */
interface Ids {
  readonly table: ReadonlyMap<DocTable, TableId>;
  readonly field: (t: DocTable, name: string) => FieldId;
}

function compileField(f: DocField, index: number, doc: DocSlot, ids: Ids): CompiledBaseField {
  const out: Record<string, unknown> = {
    id: `f${index + 1}`,
    name: f.name,
    type: f.type,
    description: f.description,
  };
  // `required` is present only when true (09 §7).
  if (f.required) out["required"] = true;
  if (f.min !== undefined) out["min"] = f.min;
  if (f.max !== undefined) out["max"] = f.max;
  if (f.type === "enum") out["values"] = f.values;
  let unit: CompiledUnit | undefined;
  if (f.type === "quantity") {
    unit = unitOf(f.unit as string) as CompiledUnit;
    out["unit"] = { ...unit };
  }
  if (f.type === "decimal" || f.type === "quantity") {
    // Defaults (10 «精度与舍入»): a currency's ISO 4217 minor unit, else 6; half_up.
    out["precision"] = {
      scale: f.scale ?? (unit !== undefined ? defaultScale(unit) : 6),
      rounding: f.rounding ?? "half_up",
    };
  }
  if (f.type === "ref" && f.ref !== undefined) {
    const target = refTable(doc, f.ref.table) as DocTable;
    out["ref"] = { table: ids.table.get(target), target: f.ref.target };
  }
  return out as unknown as CompiledBaseField;
}

function compileTable(t: DocTable, doc: DocSlot, ids: Ids): CompiledBaseTable {
  const id = ids.table.get(t) as TableId;
  const ref = (name: string) => ids.field(t, name);
  const out: Record<string, unknown> = {
    id,
    name: t.name,
    kind: "base",
    description: t.description,
    time: t.time.type === "event" ? { type: "event", field: ref(t.time.field) } : t.time,
    // A new physical table: `since` is this version and left out (09 §7 physical).
    physical: { table: `t_${id}_v1` },
    fields: t.fields.map((f, i) => compileField(f, i, doc, ids)),
  };
  if (t.entity_key !== undefined) out["entity_key"] = t.entity_key.map(ref);
  if (t.together !== undefined) out["together"] = t.together.map((g) => g.map(ref));
  if (t.duplicate_keys !== undefined)
    out["duplicate_keys"] = t.duplicate_keys.map((g) => g.map(ref));
  if (t.external_key !== undefined) out["external_key"] = t.external_key.map(ref);
  return out as unknown as CompiledBaseTable;
}

export function compileNewSlot(input: CompileNewSlotInput): CompileResult {
  const { document, slotId, nextTableNumber, existingSlotNames } = input;
  if (!isId("slot", slotId)) throw new Error(`not a slot ID: ${JSON.stringify(slotId)}`);
  if (!Number.isSafeInteger(nextTableNumber) || nextTableNumber < 1) {
    throw new Error(`not a table number: ${nextTableNumber}`);
  }
  if (!isObject(document)) {
    return { ok: false, error: { code: "invalid_argument", reason: "malformed", param: "" } };
  }
  const stop = unsupportedKey(document) ?? notYet(document);
  if (stop !== undefined) return { ok: false, error: stop };
  const doc = readDocument(document);
  if ("code" in doc) return { ok: false, error: doc };
  const details = validate(doc, existingSlotNames);
  if (details.length > 0) return { ok: false, error: { code: "validation_failed", details } };

  if (nextTableNumber + doc.tables.length - 1 > MAX_SHORT_NUMBER) {
    throw new Error("table IDs exhausted");
  }
  // IDs in document order: tables from the tenant's next free number, fields from 1 in each table.
  const tableIds = new Map<DocTable, TableId>(
    doc.tables.map((t, i): [DocTable, TableId] => [t, `t${nextTableNumber + i}`]),
  );
  const fieldIds = new Map<DocTable, Map<string, FieldId>>(
    doc.tables.map((t) => [
      t,
      new Map(t.fields.map((f, i): [string, FieldId] => [fold(f.name), `f${i + 1}`])),
    ]),
  );
  const ids: Ids = {
    table: tableIds,
    field: (t, name) => fieldIds.get(t)?.get(fold(name)) as FieldId,
  };

  const compiled = {
    compiler: 1,
    rsql: CURRENT_RSQL_VERSION,
    slot: slotId,
    name: doc.slot,
    sv: 1,
    // Kept as written (provisional; see isTimeZone).
    timezone: doc.timezone,
    tables: doc.tables.map((t) => compileTable(t, doc, ids)),
  } as CompiledSchema;

  const created = {
    class: "create",
    compatible_with_old_writes: true,
    destructive: false,
    auto: true,
  };
  const changes = [
    { target: { slot: true }, change: "create_slot", ...created },
    ...doc.tables.map((t) => ({
      target: { table: tableIds.get(t) },
      change: "add_table",
      ...created,
    })),
  ] as unknown as ChangesBlock;

  const warnings: CompileWarning[] = doc.tables
    .filter((t) => t.external_key?.length === 1)
    .map((t) => ({ code: "single_field_external_key", path: `${t.path}/external_key` }));
  return { ok: true, compiled, changes, outcome: "applied", targetVersion: 1, warnings };
}
