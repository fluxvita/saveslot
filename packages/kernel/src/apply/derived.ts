// apply of `write.derived` (docs/zh-CN/spec/09-event-format.md §5.7; 06-derived.md «行身份»,
// «派生的来源追踪»), and the physical table of a derived table (02-architecture §8).
//
// A derived write is applied by recomputing its partition from the current base data with the rule
// of `rule_version`, never by copying values from the event:
//
// - the partition's key is the event's `key` block when the write registers the partition, else
//   the key the partition was registered with;
// - `emptied` must agree with the recomputation (no row; exactly one row otherwise), and a
//   `checksum` must equal the checksum of the recomputed row;
// - `read_pos` lies within the operation: not before its head, before this event;
// - a partition's first write registers it with a `key` block; a registered partition's writes
//   carry none (registering again after a deletion cleared the key belongs with deletion);
// - the derived row is set to the recomputed values with `ver` = the operation, or removed when
//   emptied; `partitions` and `derived_reads` are kept.
//
// Disagreement stops apply as inconsistent. When the recomputation itself fails on the data (a
// result out of range, a data error from the database), the base data is not what the write was
// computed on: that too is inconsistent, not the caller-facing `rule_eval_failed` a write reports.

import {
  type CompiledDerivedTable,
  type CompiledSchema,
  canonicalize,
  type FieldValue,
  isCanonicalDecimal,
  isDate,
  type JsonValue,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import { type DerivedRow, derivedLayout, rowChecksum } from "../rules/index.ts";
import type { SqlValue } from "../store/ports.ts";
import { ApplyError, type Change } from "./model.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** What the plan of a `write.derived` reads, read by the caller. */
export interface DerivedInput {
  /** The slot's current compiled definition. */
  readonly schema: CompiledSchema;
  /** This partition's registration: its key as JCS, or null when a deletion cleared it. */
  readonly registered: { readonly groupKey: string | null } | undefined;
  /** The partition already registered with the event's `key`, if any. */
  readonly keyTakenBy: string | undefined;
  /** The derived table the event's partition ID is registered for already, if another. */
  readonly idTakenBy?: string;
  /** The partition recomputed: its rows, or the data error the recomputation met. */
  readonly recomputed:
    | { readonly rows: readonly DerivedRow[] }
    | { readonly error: string }
    | undefined;
  /** Whether the derived table has a row for the partition now. */
  readonly exists: boolean;
}

const T = 'TEXT COLLATE "C"';

/** The DDL of a derived table's physical table, from its layout and the column types. */
export function derivedTableDdl(
  t: CompiledDerivedTable,
  columnType: (type: CompiledDerivedTable["fields"][number]["type"]) => string,
): string {
  const l = derivedLayout(t);
  const cols = l.fields.map(({ field, column }) => `"${column}" ${columnType(field.type)}`);
  return `CREATE TABLE "${l.table}" (\n  ${[`${l.partition} ${T} PRIMARY KEY`, ...cols, `${l.ver} BIGINT NOT NULL`].join(",\n  ")}\n);`;
}

/** A field value as the column holds it. */
function cell(v: FieldValue): SqlValue {
  if (v === null || typeof v === "string" || typeof v === "boolean") return v;
  if ("value" in v) return v.value;
  throw new Error("a derived value of no column type");
}

/** The table IDs a rule reads, once each, in ascending string order (09 §5.7 `reads`). */
export function readsOf(t: CompiledDerivedTable): string[] {
  return [...new Set(t.rule.depends_on.map((d) => d.table))].sort();
}

/** The changes of one `write.derived`. Pure; throws {@link ApplyError}. */
export function planDerived(
  seq: Seq,
  op: Seq,
  present: Obj,
  removed: ReadonlySet<string>,
  input: DerivedInput | undefined,
): Change[] {
  const inconsistent = (what: string) => new ApplyError("inconsistent", seq, what);
  const target = present["target"] as Obj;
  const tableId = target["table"] as string;
  const partition = target["partition"] as string;
  const readPos = target["read_pos"] as number;
  const emptied = target["emptied"] as boolean;
  if (input === undefined) throw inconsistent(`no derived table ${tableId} in the slot`);
  const t = input.schema.tables.find((x) => x.id === tableId);
  if (t === undefined || t.kind !== "derived") throw inconsistent(`no derived table ${tableId}`);
  if (target["rule"] !== t.rule.id || target["rule_version"] !== t.rule.version) {
    throw inconsistent(
      `rule ${String(target["rule"])} v${String(target["rule_version"])} is not ${t.rule.id} v${t.rule.version}`,
    );
  }
  const reads = (target["reads"] as readonly Obj[]).map((r) => r["table"] as string);
  if (JSON.stringify(reads) !== JSON.stringify(readsOf(t))) {
    throw inconsistent(`reads ${reads.join(",")} are not the tables rule ${t.rule.id} reads`);
  }
  if (!(readPos >= op && readPos < seq)) {
    throw inconsistent(`read_pos ${readPos} is not within operation ${op} before ${seq}`);
  }
  if (removed.has("key")) {
    throw new ApplyError("not_implemented", seq, "a derived write whose key was deleted");
  }

  // The partition's registration and key.
  const keyBlock = present["key"] as Obj | undefined;
  const changes: Change[] = [];
  if (input.registered === undefined) {
    if (keyBlock === undefined) throw inconsistent(`partition ${partition} is not registered`);
    if (input.keyTakenBy !== undefined) {
      throw inconsistent(`its key is registered for partition ${input.keyTakenBy}`);
    }
    if (input.idTakenBy !== undefined) {
      throw inconsistent(`partition ${partition} is registered for table ${input.idTakenBy}`);
    }
    changes.push({
      kind: "partition_insert",
      table_id: tableId,
      partition,
      group_key: canonicalize(keyBlock["values"] as JsonValue),
    });
  } else {
    // A key cleared by a deletion is registered again by a later write: deletion's to apply.
    if (input.registered.groupKey === null) {
      throw new ApplyError("not_implemented", seq, `partition ${partition}: its key was cleared`);
    }
    if (keyBlock !== undefined) throw inconsistent(`partition ${partition} is registered already`);
  }

  // The partition recomputed.
  const r = input.recomputed;
  if (r === undefined) throw inconsistent(`partition ${partition} was not recomputed`);
  if ("error" in r) throw inconsistent(`recomputing partition ${partition}: ${r.error}`);
  // These checks hold for a replay of the log as it is; after a deletion's tombstone a replay's
  // intermediate states may differ (06-derived «刷新范围与写入准入»: deletion's derived writes):
  // when they may be relaxed is for deletion to settle.
  if (emptied) {
    if (r.rows.length !== 0) throw inconsistent(`partition ${partition} is not empty`);
    if (!input.exists) throw inconsistent(`partition ${partition} has no row to empty`);
  } else if (r.rows.length !== 1) {
    throw inconsistent(`partition ${partition} gives ${r.rows.length} rows, not one`);
  }
  const row = r.rows[0];
  // The row recomputed is the group the key block names, written the same way.
  if (
    keyBlock !== undefined &&
    row !== undefined &&
    canonicalize(row.key as unknown as JsonValue) !== canonicalize(keyBlock["values"] as JsonValue)
  ) {
    throw inconsistent(`partition ${partition}: its key is not the recomputed row's`);
  }
  const checksum = present["checksum"] as Obj | undefined;
  if (
    checksum !== undefined &&
    row !== undefined &&
    checksum["checksum"] !== rowChecksum(row.values)
  ) {
    throw inconsistent(`partition ${partition}: the checksum is not the recomputed row's`);
  }

  const l = derivedLayout(t);
  if (row === undefined) changes.push({ kind: "derived_delete", table: l.table, partition });
  else {
    changes.push({
      kind: "derived_set",
      table: l.table,
      partition,
      columns: l.fields.map((f) => f.column),
      values: l.fields.map((f) => cell(row.values[f.field.id] ?? null)),
      ver: op,
    });
  }
  changes.push({
    kind: "derived_reads",
    rows: reads.map((base) => ({
      derived_seq: seq,
      base_table_id: base,
      partition_id: partition,
      rule_version: t.rule.version,
      read_pos: readPos,
    })),
  });
  return changes;
}

/**
 * Why a key block's values are not the canonical form of the table's key fields (09 §1.2–1.3), or
 * undefined when they are: one value per key field, a date `YYYY-MM-DD`, a canonical decimal within
 * the field's scale, a quantity in the field's unit, a boolean, text, or null.
 */
export function canonicalKeyFault(t: CompiledDerivedTable, values: JsonValue): string | undefined {
  const ids = t.rule.scope.kind === "tenant" ? [] : t.rule.scope.key;
  if (!Array.isArray(values) || values.length !== ids.length)
    return `a key of ${Array.isArray(values) ? values.length : "no"} values for ${ids.length} key fields`;
  for (const [i, id] of ids.entries()) {
    const f = t.fields.find((x) => x.id === id);
    const v = values[i];
    if (f === undefined) return `no key field ${id}`;
    if (v === null) continue;
    const decimal = (x: unknown, scale: number) =>
      typeof x === "string" && isCanonicalDecimal(x) && (x.split(".")[1] ?? "").length <= scale;
    let ok: boolean;
    switch (f.type) {
      case "date":
        ok = typeof v === "string" && /^[0-9]{4}-[0-9]{2}-[0-9]{2}$/.test(v) && isDate(v);
        break;
      case "integer":
        ok = typeof v === "string" && /^-?(0|[1-9][0-9]*)$/.test(v) && v !== "-0";
        break;
      case "decimal":
        ok = decimal(v, f.precision.scale);
        break;
      case "quantity":
        ok =
          typeof v === "object" &&
          !Array.isArray(v) &&
          Object.keys(v).sort().join(",") === "unit,value" &&
          (v as Record<string, unknown>)["unit"] === f.unit.code &&
          decimal((v as Record<string, unknown>)["value"], f.precision.scale);
        break;
      case "boolean":
        ok = typeof v === "boolean";
        break;
      case "text":
      case "enum":
      case "ref":
        ok = typeof v === "string";
        break;
      default:
        ok = false;
    }
    if (!ok) return `key value ${i} is not a canonical ${f.type}`;
  }
  return undefined;
}
