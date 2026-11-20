// The schema document of a version, from its compiled definition (docs/zh-CN/spec/03-data-model/
// 07-schema-evolution.md «schema 文档格式»; 04-contract §10 `catalog`): the whole slot, IDs and
// inferences filled in, on `base_version` the slot's current version, so that it can be changed and
// submitted as it is. Submitted as it is, it changes nothing (`no_change`).
//
// The compiled definition is the authority: a draft lists only the tables it changes, so the
// drafts of a slot are not its document. The one thing the definition does not hold in the
// document's form is a derived rule's text: the definition binds it to IDs (09 §7 `rule.sql`), so
// the text comes from the caller (`ruleText`), as a draft wrote it.
//
// Pure.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledDerivedTable,
  CompiledSchema,
  CompiledTable,
} from "@fluxvita/saveslot-contract-core";

type Obj = Record<string, unknown>;

const withAliases = (o: Obj, a: readonly string[] | undefined): Obj =>
  a !== undefined && a.length > 0 ? { ...o, aliases: [...a] } : o;

function baseField(f: CompiledBaseField, tableName: (id: string) => string): Obj {
  const g = f as CompiledBaseField & {
    min?: string;
    max?: string;
    values?: readonly string[];
    unit?: { code: string };
    precision?: { scale: number; rounding: string };
    ref?: { table: string; target: string };
  };
  const out: Obj = withAliases(
    { id: f.id, name: f.name, type: f.type, description: f.description },
    f.aliases,
  );
  if (f.required === true) out["required"] = true;
  if (g.min !== undefined) out["min"] = g.min;
  if (g.max !== undefined) out["max"] = g.max;
  if (g.values !== undefined) out["values"] = [...g.values];
  if (g.unit !== undefined) out["unit"] = g.unit.code;
  if (g.precision !== undefined) {
    out["scale"] = g.precision.scale;
    out["rounding"] = g.precision.rounding;
  }
  if (g.ref !== undefined) out["ref"] = { table: tableName(g.ref.table), target: g.ref.target };
  return out;
}

function baseTable(t: CompiledBaseTable, tableName: (id: string) => string): Obj {
  const field = (id: string) => t.fields.find((f) => f.id === id)?.name ?? id;
  const names = (ids: readonly string[]) => ids.map(field);
  const out: Obj = withAliases(
    { id: t.id, name: t.name, kind: "base", description: t.description },
    t.aliases,
  );
  out["time"] =
    t.time.type === "event"
      ? { type: "event", field: field(t.time.field) }
      : t.time.type === "state"
        ? { type: "state", granularity: t.time.granularity }
        : { type: "none" };
  out["fields"] = t.fields.map((f) => baseField(f, tableName));
  if (t.entity_key !== undefined) out["entity_key"] = names(t.entity_key);
  if (t.external_key !== undefined) out["external_key"] = names(t.external_key);
  if (t.together !== undefined) out["together"] = t.together.map(names);
  if (t.duplicate_keys !== undefined) out["duplicate_keys"] = t.duplicate_keys.map(names);
  return out;
}

export function derivedTableDocument(
  t: CompiledDerivedTable,
  all: readonly CompiledTable[],
  sql: string | undefined,
): Obj {
  if (sql === undefined) throw new Error(`no rule text for derived table ${t.id}`);
  const tableName = (id: string) => all.find((x) => x.id === id)?.name ?? id;
  const fieldName = (table: string, field: string) =>
    all.find((x) => x.id === table)?.fields.find((f) => f.id === field)?.name ?? field;
  const r = t.rule;
  const out: Obj = withAliases(
    { id: t.id, name: t.name, kind: "derived", description: t.description },
    t.aliases,
  );
  out["rule"] = {
    sql,
    time_dependency: r.time_dependency,
    // Inferred, as the catalog fills them in (./fill.ts).
    id: r.id,
    version: r.version,
    depends_on: r.depends_on.map((d) => `${tableName(d.table)}.${fieldName(d.table, d.field)}`),
    scope:
      r.scope.kind === "group"
        ? { kind: "group", key: r.scope.key.map((k) => fieldName(t.id, k)) }
        : { kind: "tenant" },
  };
  out["fields"] = t.fields.map((f) => {
    const g = f as typeof f & {
      unit?: { code: string };
      precision?: { scale: number; rounding: string };
    };
    return withAliases(
      {
        id: f.id,
        name: f.name,
        description: f.description,
        type: f.type,
        ...(g.unit !== undefined ? { unit: g.unit.code } : {}),
        ...(g.precision !== undefined
          ? { scale: g.precision.scale, rounding: g.precision.rounding }
          : {}),
      },
      f.aliases,
    );
  });
  return out;
}

/**
 * The whole document of the version `compiled` is, on `baseVersion` (the slot's current version);
 * `ruleText` gives a derived table's rule as a draft wrote it.
 */
export function documentOf(
  compiled: CompiledSchema,
  baseVersion: number,
  ruleText: (tableId: string) => string | undefined,
): Obj {
  const tableName = (id: string) => compiled.tables.find((x) => x.id === id)?.name ?? id;
  return {
    slot: compiled.name,
    base_version: baseVersion,
    timezone: compiled.timezone,
    tables: compiled.tables.map((t) =>
      t.kind === "base"
        ? baseTable(t, tableName)
        : derivedTableDocument(t, compiled.tables, ruleText(t.id)),
    ),
  };
}
