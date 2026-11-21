// A draft's changes as the contract gives them (docs/zh-CN/spec/04-contract-types.md §5.3
// `SchemaChange`): the logged records (09-event-format §5.5 `schema.compiled` `changes`) with their
// targets by names, not IDs. The `schema_draft` receipt and a `schema_change` item's detail give
// the same.
//
// Pure.

import type { CompiledSchema, SchemaChangeRecord } from "@fluxvita/saveslot-contract-core";

/** 04-contract-types §5.3 `SchemaChange`: the logged change record, its target by names. */
export interface SchemaChange extends Omit<SchemaChangeRecord, "target"> {
  readonly target:
    | { readonly slot: true; readonly name: string }
    | { readonly table: string; readonly field?: string; readonly rule?: true };
}

/**
 * The changes by names: a table or field by its name in the version the draft compiles to
 * (`next`), or in the version it was written on (`before`) when the draft drops it.
 */
export function changesByName(
  changes: readonly SchemaChangeRecord[],
  next: CompiledSchema,
  before: CompiledSchema,
): SchemaChange[] {
  const table = (id: string) =>
    next.tables.find((t) => t.id === id) ?? before.tables.find((t) => t.id === id);
  return changes.map((c) => {
    // The slot by its name after the change, as a renamed table or field is (04-contract-types §5.3).
    if (!("table" in c.target)) return { ...c, target: { slot: true, name: next.name } };
    const t = table(c.target.table);
    const name = t?.name ?? c.target.table;
    if ("field" in c.target) {
      const field = c.target.field;
      const id = c.target.table;
      const f =
        next.tables.find((x) => x.id === id)?.fields.find((x) => x.id === field) ??
        before.tables.find((x) => x.id === id)?.fields.find((x) => x.id === field);
      return { ...c, target: { table: name, field: f?.name ?? field } };
    }
    return { ...c, target: "rule" in c.target ? { table: name, rule: true } : { table: name } };
  });
}
