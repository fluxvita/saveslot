// The physical table of a derived table (docs/zh-CN/spec/02-architecture.md §8; 06-derived.md
// 01-objects «行身份»): one row per non-empty partition, `d_<table>_v<n>` with `partition_id`, one column
// `f_<field>` per derived field (the group key fields among them) and `ver`, the operation number
// of the derived write that last set the row. The layout is shared by apply, which builds the table
// from it (with its own column types) and writes it, and derive, which reads it to compare with a
// recomputation.

import type {
  CompiledDerivedField,
  CompiledDerivedTable,
  FieldId,
  FieldValue,
  PartitionId,
} from "@fluxvita/saveslot-contract-core";
import { decodeValue } from "./evaluate.ts";

/** The physical layout: the table's name and the column of each field. */
export interface DerivedLayout {
  readonly table: string;
  readonly partition: "partition_id";
  readonly ver: "ver";
  readonly fields: readonly { readonly field: CompiledDerivedField; readonly column: string }[];
}

/** The layout of a derived table; names are checked, since they go into SQL quoted, never escaped. */
export function derivedLayout(t: CompiledDerivedTable): DerivedLayout {
  const name = t.physical.table;
  if (!/^t[1-9][0-9]{0,8}$/.test(t.id) || !new RegExp(`^d_${t.id}_v[1-9][0-9]{0,8}$`).test(name))
    throw new Error(`not a physical table name: ${JSON.stringify(name)}`);
  return {
    table: name,
    partition: "partition_id",
    ver: "ver",
    fields: t.fields.map((f) => {
      if (!/^f[1-9][0-9]{0,8}$/.test(f.id))
        throw new Error(`not a field ID: ${JSON.stringify(f.id)}`);
      return { field: f, column: `f_${f.id}` };
    }),
  };
}

/** Every row of the derived table, values as text (decodeDerivedRow). */
export function derivedRowsQuery(
  t: CompiledDerivedTable,
  partitions?: readonly PartitionId[],
): { readonly sql: string; readonly params: readonly (string | readonly string[])[] } {
  const l = derivedLayout(t);
  const cols = l.fields.map(({ field: f, column }) =>
    f.type === "boolean" ? `"${column}" AS "${f.id}"` : `CAST("${column}" AS text) AS "${f.id}"`,
  );
  const all = `SELECT ${l.partition}, ${cols.join(", ")}, CAST(${l.ver} AS text) AS ver FROM "${l.table}"`;
  // Only these partitions (by the key of the table), when given.
  return partitions === undefined
    ? { sql: all, params: [] }
    : { sql: `${all} WHERE ${l.partition} = ANY($1)`, params: [[...partitions]] };
}

export interface StoredDerivedRow {
  readonly partition: PartitionId;
  readonly values: Readonly<Record<FieldId, FieldValue>>;
  readonly ver: number;
}

/** A row of derivedRowsQuery. */
export function decodeDerivedRow(
  t: CompiledDerivedTable,
  row: Readonly<Record<string, unknown>>,
): StoredDerivedRow {
  const partition = row["partition_id"];
  if (typeof partition !== "string" || !partition.startsWith("p_"))
    throw new Error("a derived row without a partition ID");
  const values: Record<FieldId, FieldValue> = {};
  for (const f of t.fields) {
    if (!Object.hasOwn(row, f.id)) throw new Error(`no column ${f.id}`);
    values[f.id] = decodeValue(f, row[f.id]);
  }
  const ver = Number(row["ver"]);
  if (!Number.isSafeInteger(ver)) throw new Error("a derived row without its version");
  return { partition: partition as PartitionId, values, ver };
}
