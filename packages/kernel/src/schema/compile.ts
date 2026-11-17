// Compiling the schema document that creates a slot (docs/zh-CN/spec/03-data-model/07-schema-evolution.md
// «schema 文档格式»; the compiled definition is 09-event-format.md §7, the changes §5.5).
//
// Pure: the slot ID and the next free table and rule numbers come from the caller. The result is
// the definition of version 1 and the changes (`create_slot`, then `add_table` or
// `add_derived_table` per table); every change of a new slot applies directly, so the outcome is
// `applied` (07 «改动分类» slot 新建 row).
//
// Derived tables (07 «文档结构» 派生表 row; 06-derived.md): each rule is compiled by the restricted
// SQL compiler (../rules) against the slot's compiled base tables, after the document's own rules
// pass; the derived fields' types, units and precision are what it infers. A document with a
// derived table needs the parser loaded (`loadRsql()`); one without does not.
//
// Errors, in this order, so the most telling one wins: a key v1 does not support
// (`not_in_this_version`); something in v1 not compiled yet (`not_implemented`: changing a slot,
// aliases); the document's form (`invalid_argument`); the compilation rules (`validation_failed`,
// every finding); then the rules, by the same order over all of them (a rule's
// `not_in_this_version`, then `not_implemented`, then every rule's details).

import type {
  ChangesBlock,
  CompiledBaseField,
  CompiledBaseTable,
  CompiledDerivedTable,
  CompiledSchema,
  CompiledUnit,
  FieldId,
  RuleId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { isId } from "@fluxvita/saveslot-contract-core";
import {
  CURRENT_RSQL_VERSION,
  compileDerivedRule,
  type DeclaredField,
  type DerivedRuleResult,
} from "../rules/index.ts";
import { isObject, notYet, readDocument, unsupportedKey } from "./document.ts";
import type {
  CompileError,
  CompileNewSlotInput,
  CompileResult,
  CompileWarning,
  DocDerivedTable,
  DocField,
  DocSlot,
  DocTable,
  SchemaDetail,
} from "./model.ts";
import { defaultScale, unitOf } from "./units.ts";
import { fold, refTable, validate } from "./validate.ts";

/** Short IDs have at most 9 digits (01-objects «标识的写法»). */
const MAX_SHORT_NUMBER = 999_999_999;

/** Field and table IDs by name, for the references inside the definition. */
interface Ids {
  readonly table: ReadonlyMap<DocTable | DocDerivedTable, TableId>;
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

/** A derived table's rule compiled, or why not. */
function compileRule(
  t: DocDerivedTable,
  doc: DocSlot,
  bases: readonly CompiledBaseTable[],
): DerivedRuleResult {
  const fields = t.fields.map((f): DeclaredField => {
    const unit = f.unit !== undefined ? unitOf(f.unit) : undefined;
    return {
      name: f.name,
      ...(f.type === "decimal" ? { type: "decimal" as const } : {}),
      ...(unit !== undefined ? { unit: unit as CompiledUnit } : {}),
      ...(f.scale !== undefined ? { scale: f.scale } : {}),
      ...(f.rounding !== undefined ? { rounding: f.rounding } : {}),
    };
  });
  return compileDerivedRule({
    sql: t.rule.sql,
    declaredTimeDependency: t.rule.time_dependency,
    fields,
    slot: { name: doc.slot },
    tables: bases,
    derivedTables: doc.tables.filter((x) => x.kind === "derived").map((x) => x.name),
    path: `${t.path}/rule/sql`,
  });
}

/** The first error over all rules by kind: not_in_this_version, not_implemented, then every detail. */
function ruleError(results: readonly DerivedRuleResult[]): CompileError | undefined {
  const errors = results.flatMap((r) => (r.ok ? [] : [r.error]));
  const notInVersion = errors.find((e) => e.code === "not_in_this_version");
  if (notInVersion !== undefined) return { code: "not_in_this_version", param: notInVersion.param };
  const notYet = errors.find((e) => e.code === "not_implemented");
  if (notYet !== undefined)
    return { code: "not_implemented", what: notYet.what, param: notYet.param };
  const details = errors.flatMap((e) =>
    e.code === "validation_failed"
      ? e.details.map(
          (d): SchemaDetail => ({
            path: d.path,
            code: d.code,
            ...(d.line !== undefined ? { line: d.line } : {}),
            ...(d.sql_reason !== undefined ? { sql_reason: d.sql_reason } : {}),
            ...(d.suggestion !== undefined ? { suggestion: d.suggestion } : {}),
          }),
        )
      : [],
  );
  return details.length > 0 ? { code: "validation_failed", details } : undefined;
}

export function compileNewSlot(input: CompileNewSlotInput): CompileResult {
  const { document, slotId, nextTableNumber, nextRuleNumber, existingSlotNames } = input;
  if (!isId("slot", slotId)) throw new Error(`not a slot ID: ${JSON.stringify(slotId)}`);
  for (const [what, n] of [
    ["table", nextTableNumber],
    ["rule", nextRuleNumber],
  ] as const) {
    if (!Number.isSafeInteger(n) || n < 1) throw new Error(`not a ${what} number: ${n}`);
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

  const bases = doc.tables.filter((t): t is DocTable => t.kind === "base");
  const derived = doc.tables.filter((t): t is DocDerivedTable => t.kind === "derived");
  if (nextTableNumber + doc.tables.length - 1 > MAX_SHORT_NUMBER) {
    throw new Error("table IDs exhausted");
  }
  if (nextRuleNumber + derived.length - 1 > MAX_SHORT_NUMBER) {
    throw new Error("rule IDs exhausted");
  }
  // IDs in document order: tables from the tenant's next free number, fields from 1 in each table,
  // rules from the tenant's next free rule number.
  const tableIds = new Map<DocTable | DocDerivedTable, TableId>(
    doc.tables.map((t, i): [DocTable | DocDerivedTable, TableId] => [t, `t${nextTableNumber + i}`]),
  );
  const fieldIds = new Map<DocTable, Map<string, FieldId>>(
    bases.map((t) => [
      t,
      new Map(t.fields.map((f, i): [string, FieldId] => [fold(f.name), `f${i + 1}`])),
    ]),
  );
  const ids: Ids = {
    table: tableIds,
    field: (t, name) => fieldIds.get(t)?.get(fold(name)) as FieldId,
  };

  const compiledBases = new Map(bases.map((t) => [t, compileTable(t, doc, ids)]));
  const rules = derived.map((t) => compileRule(t, doc, [...compiledBases.values()]));
  const ruleStop = ruleError(rules);
  if (ruleStop !== undefined) return { ok: false, error: ruleStop };

  const compiledDerived = new Map(
    derived.map((t, k): [DocDerivedTable, CompiledDerivedTable] => {
      const r = rules[k] as DerivedRuleResult & { ok: true };
      const id = tableIds.get(t) as TableId;
      const ruleId: RuleId = `r${nextRuleNumber + k}`;
      return [
        t,
        {
          id,
          name: t.name,
          kind: "derived",
          description: t.description as string,
          // A new physical table: `since` is this version and left out (09 §7 physical).
          physical: { table: `d_${id}_v1` },
          rule: { id: ruleId, version: 1, ...r.rule },
          fields: r.fields.map((f, i) => ({
            ...f,
            id: `f${i + 1}`,
            description: t.fields[i]?.description as string,
          })) as unknown as CompiledDerivedTable["fields"],
        },
      ];
    }),
  );

  const compiled = {
    compiler: 1,
    rsql: CURRENT_RSQL_VERSION,
    slot: slotId,
    name: doc.slot,
    sv: 1,
    // Kept as written (provisional; see isTimeZone).
    timezone: doc.timezone,
    tables: doc.tables.map((t) =>
      t.kind === "base" ? compiledBases.get(t) : compiledDerived.get(t),
    ),
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
      change: t.kind === "base" ? "add_table" : "add_derived_table",
      ...created,
    })),
  ] as unknown as ChangesBlock;

  const warnings: CompileWarning[] = doc.tables.flatMap((t): CompileWarning[] => {
    if (t.kind === "base") {
      return t.external_key?.length === 1
        ? [{ code: "single_field_external_key", table: t.name, path: `${t.path}/external_key` }]
        : [];
    }
    const scope = compiledDerived.get(t)?.rule.scope;
    // 06 «派生行身份»: a group key from free text goes with the group when deleted.
    return scope?.kind === "group" && scope.key_from_free_text
      ? [{ code: "group_key_free_text", table: t.name, path: `${t.path}/rule` }]
      : [];
  });
  return { ok: true, compiled, changes, outcome: "applied", targetVersion: 1, warnings };
}
