// Slot and table definitions, as a connector declares them, and their schema-document form
// (docs/zh-CN/spec/03-data-model/07-schema-evolution.md «schema 文档格式»).
//
// Only what the service accepts today is here. Aliases and changing an existing slot come later
// (07-scope-v1); the service answers `not_in_this_version` to each, so this version of the SDK
// does not offer them.

/** Field types (10-types-and-units). */
export type FieldType =
  | "text"
  | "integer"
  | "decimal"
  | "boolean"
  | "enum"
  | "date"
  | "zoned_datetime"
  | "quantity"
  | "ref";

export interface FieldDefinition {
  /** Letters, digits and underscores, starting with a letter, at most 63 characters. */
  readonly name: string;
  readonly type: FieldType;
  /** What the field holds. Required. */
  readonly description: string;
  readonly required?: boolean;
  /** `quantity`: the unit, from the unit vocabulary (`km`, `min`, `CNY`, …). */
  readonly unit?: string;
  /** `enum`: the values. */
  readonly values?: readonly string[];
  readonly min?: number | string;
  readonly max?: number | string;
  /** `ref`: the table pointed at, in the same slot. */
  readonly ref?: { readonly table: string; readonly target: "row" | "entity" };
}

/** How a table relates to time. */
export type TableTime =
  /** Each row is one thing that happened at `field` (a required `date` or `zoned_datetime`). */
  | { readonly type: "event"; readonly field: string }
  /** Each entity has values that change over time. */
  | { readonly type: "state"; readonly granularity: "date" | "instant" }
  /** Rows with no time. */
  | { readonly type: "none" };

export interface TableDefinition {
  /** Letters, digits and underscores, starting with a letter, at most 63 characters. */
  readonly name: string;
  /** What one row is. Required. */
  readonly description: string;
  readonly time: TableTime;
  readonly fields: readonly FieldDefinition[];
  /** State tables: the natural key of an entity (required fields). */
  readonly entityKey?: readonly string[];
  /** Event and timeless tables: sets of fields that mark a suspected duplicate. */
  readonly duplicateKeys?: readonly (readonly string[])[];
  /** Fields that conflict as one unit. */
  readonly together?: readonly (readonly string[])[];
  /**
   * Event and timeless tables: the fields that identify a record in the system it comes from
   * (1–4 `text`, `enum` or `integer` fields, none in `together`), e.g. `["origin", "external_id"]`.
   * Records of such a table are written by this key: the first time a key is written it adds a
   * row, after that it updates that row (04-write-and-read «按来源键写入»).
   */
  readonly externalKey?: readonly string[];
}

/** The schema document of a draft that creates a slot with its tables. */
export function newSlotDocument(o: {
  readonly slot: string;
  readonly timezone: string;
  readonly tables: readonly TableDefinition[];
}): Record<string, unknown> {
  return {
    slot: o.slot,
    base_version: null,
    timezone: o.timezone,
    tables: o.tables.map(tableDocument),
  };
}

function tableDocument(t: TableDefinition): Record<string, unknown> {
  return {
    name: t.name,
    kind: "base",
    description: t.description,
    time: t.time,
    fields: t.fields,
    ...(t.entityKey === undefined ? {} : { entity_key: t.entityKey }),
    ...(t.duplicateKeys === undefined ? {} : { duplicate_keys: t.duplicateKeys }),
    ...(t.together === undefined ? {} : { together: t.together }),
    ...(t.externalKey === undefined ? {} : { external_key: t.externalKey }),
  };
}
