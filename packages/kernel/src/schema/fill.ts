// The schema document as the catalog gives it back (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式»; 04-contract §10 `catalog`): the document as submitted, with what saveslot
// assigns or infers filled in from the compiled definition — `base_version` (the version it
// became), the IDs of tables, fields and rules, a rule's version, dependencies and scope, a derived
// field's inferred type, unit and precision. Nothing else changes: a key the caller wrote is kept as
// written, even where the compiled definition says the same thing another way. The document is the
// caller's data; the surfaces show its text as untrusted.
//
// Tables and fields are matched by name without ASCII case, as the compiler matched them.

import type {
  CompiledDerivedTable,
  CompiledSchema,
  CompiledTable,
  JsonValue,
} from "@fluxvita/saveslot-contract-core";
import { fold } from "./validate.ts";

type Obj = Record<string, unknown>;
const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);

/** Sets `key` when the caller did not write it. */
function fill(o: Obj, key: string, value: unknown): void {
  if (!Object.hasOwn(o, key)) o[key] = value;
}

/** The document as submitted, with what the compiler assigned and inferred filled in. */
export function filledDocument(
  submitted: JsonValue,
  compiled: CompiledSchema,
  baseVersion: number = compiled.sv,
): Obj {
  const doc = structuredClone(submitted) as Obj;
  if (!isObj(doc)) throw new Error("the submitted document is not an object");
  // The version a draft based on it is written on: the slot's current version. For a version in
  // effect that is the version itself; for a draft awaiting confirmation, the one it was written
  // on (`baseVersion`), so the receipt's document can be changed and submitted as it is.
  doc["base_version"] = baseVersion;
  const byName = new Map<string, CompiledTable>(compiled.tables.map((t) => [fold(t.name), t]));
  const byId = new Map<string, CompiledTable>(compiled.tables.map((t) => [t.id, t]));
  const fieldName = (tableId: string, fieldId: string) => {
    const t = byId.get(tableId);
    return t?.fields.find((f) => f.id === fieldId)?.name ?? fieldId;
  };
  for (const t of Array.isArray(doc["tables"]) ? doc["tables"] : []) {
    if (!isObj(t) || typeof t["name"] !== "string") continue;
    const c = byName.get(fold(t["name"]));
    if (c === undefined) continue;
    fill(t, "id", c.id);
    const fields = Array.isArray(t["fields"]) ? t["fields"] : [];
    for (const f of fields) {
      if (!isObj(f) || typeof f["name"] !== "string") continue;
      const cf = c.fields.find((x) => fold(x.name) === fold(f["name"] as string));
      if (cf === undefined) continue;
      fill(f, "id", cf.id);
      if (c.kind === "derived") {
        // Inferred by the compiler (07 «文档结构» 派生表 row).
        fill(f, "type", cf.type);
        if (cf.type === "quantity") fill(f, "unit", cf.unit.code);
        if (cf.type === "quantity" || cf.type === "decimal") {
          fill(f, "scale", cf.precision.scale);
          fill(f, "rounding", cf.precision.rounding);
        }
      }
    }
    if (c.kind === "derived" && isObj(t["rule"]))
      fillRule(t["rule"], c, (id) => byId.get(id)?.name ?? id, fieldName);
  }
  return doc;
}

function fillRule(
  rule: Obj,
  c: CompiledDerivedTable,
  tableName: (table: string) => string,
  fieldName: (table: string, field: string) => string,
): void {
  const r = c.rule;
  fill(rule, "id", r.id);
  fill(rule, "version", r.version);
  // "table.field" by name: rules do not cross slots, so the table needs no slot (04-contract-types §4.2).
  fill(
    rule,
    "depends_on",
    r.depends_on.map((d) => `${tableName(d.table)}.${fieldName(d.table, d.field)}`),
  );
  fill(
    rule,
    "scope",
    r.scope.kind === "group"
      ? { kind: "group", key: r.scope.key.map((k) => fieldName(c.id, k)) }
      : { kind: "tenant" },
  );
}
