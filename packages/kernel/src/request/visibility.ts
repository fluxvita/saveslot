// What a credential can see of the tenant's slots (04-contract §12; 03-data-model/04-write-and-read
// «可见范围»): every slot, or some slots and, in them, some tables. Shared by reads and writes, so
// that both resolve names within the same range (04-contract «名字只在可见范围内解析»).

import type { CompiledTable, SlotId, TableId } from "@fluxvita/saveslot-contract-core";

/** The call context's visibility (02-architecture §4 «`ops` 的调用上下文»). */
export type Visibility =
  | { readonly kind: "all" }
  | {
      readonly kind: "scoped";
      readonly slots: readonly {
        readonly slot: SlotId;
        readonly tables?: readonly {
          readonly table: TableId;
          readonly fields?: readonly string[];
        }[];
      }[];
    };

/** Visibility by field: not done in this version (a credential's range is slots and tables). */
export class FieldVisibilityNotImplemented extends Error {
  override readonly name = "FieldVisibilityNotImplemented";
}

/**
 * The tables of a slot the caller can see: all of them, those its range names, or undefined where
 * the slot is out of range.
 */
export function visibleTables(
  visibility: Visibility,
  slot: SlotId,
  tables: readonly CompiledTable[],
): readonly CompiledTable[] | undefined {
  if (visibility.kind === "all") return tables;
  const scope = visibility.slots.find((s) => s.slot === slot);
  if (scope === undefined) return undefined;
  if (scope.tables === undefined) return tables;
  if (scope.tables.some((t) => t.fields !== undefined)) {
    throw new FieldVisibilityNotImplemented("visibility by field is not implemented");
  }
  const ids = new Set(scope.tables.map((t) => t.table));
  return tables.filter((t) => ids.has(t.id));
}
