// The derived refresh of one operation (docs/zh-CN/spec/03-data-model/06-derived.md «刷新范围与写入
// 准入», «行身份»; 09-event-format.md §4.2 step 6, §5.7 `write.derived`): which derived rows changed
// after this operation's base changes, as derived writes to append.
//
// derive does not read storage itself (02-architecture §4: it depends on rules and log only): the
// caller passes its query function, run in the caller's transaction, after the operation's base
// events are applied. This version recomputes each affected rule whole (06 allows the affected
// partitions or the whole view) and compares the result with the derived table:
//
// - a group key the table has no row for: a new row; its partition is the one the key was
//   registered under before (a partition emptied earlier comes back under the same ID, without a
//   `key` block), or a new partition registered with a `key` block;
// - a row whose values differ: a change; a row whose values are the same: nothing;
// - a row whose group key the recomputation no longer gives: emptied (no `key`, no `checksum`); its
//   mapping stays.
//
// A whole aggregate has one partition: with no input row it has no row (emptied), and its key is
// the empty list.
//
// The base changes are taken in the spec's shape (table, row, fields) so that a later version can
// recompute only the affected groups without changing the callers.

import {
  type ChecksumBlock,
  type CompiledDerivedTable,
  type CompiledSchema,
  canonicalize,
  type DerivedKeyBlock,
  type DerivedTarget,
  type FieldId,
  type FieldValue,
  type JcsValue,
  type PartitionId,
  type Seq,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import {
  decodeDerivedRow,
  derivedRowsQuery,
  evaluateRule,
  evaluating,
  rowChecksum,
  type StoredDerivedRow,
} from "../rules/index.ts";

/** The caller's query in its transaction: the only way derive reads the store. */
export type Query = (
  sql: string,
  params: readonly unknown[],
) => Promise<{ readonly rows: readonly Record<string, unknown>[] }>;

/** A base change of this operation: the table and the row or entity a `write.base` touched. */
export interface BaseChange {
  readonly table: TableId;
  readonly row: string;
  readonly fields: readonly FieldId[];
}

/** One `write.derived` to append, with what the receipt needs. */
export interface DerivedWrite {
  readonly target: DerivedTarget;
  /** Only when the partition is registered by this write. */
  readonly key?: DerivedKeyBlock;
  /** Not when the partition is emptied. */
  readonly checksum?: ChecksumBlock;
  /** The group key values, in the rule's key order. */
  readonly groupKey: readonly FieldValue[];
  /**
   * The fields whose value changed (before and after differ by JCS); `before` is null for a new
   * row, `after` null when emptied, so a field null on both sides is never listed.
   */
  readonly changes: readonly {
    readonly field: FieldId;
    readonly before: FieldValue;
    readonly after: FieldValue;
  }[];
}

export interface DerivedWritesInput {
  readonly query: Query;
  /** The compiled definition of the slot the changes are in. */
  readonly schema: CompiledSchema;
  readonly changes: readonly BaseChange[];
  /** IDs come from the caller, as the write's other IDs. */
  readonly newPartitionId: () => PartitionId;
  /** The `seq` of the last event before these derived writes (09 `write.derived` `read_pos`). */
  readonly readPos: Seq;
}

const keyText = (values: readonly FieldValue[]) => canonicalize(values as unknown as JcsValue);
const same = (a: FieldValue, b: FieldValue) =>
  canonicalize(a as unknown as JcsValue) === canonicalize(b as unknown as JcsValue);

/** The group key of a stored row, in the rule's key order. */
function keyOf(t: CompiledDerivedTable, values: Readonly<Record<FieldId, FieldValue>>) {
  return t.rule.scope.kind === "tenant"
    ? []
    : t.rule.scope.key.map((id) => {
        if (!Object.hasOwn(values, id)) throw new Error(`no key field ${id}`);
        return values[id] as FieldValue;
      });
}

/** The derived writes of one derived table. */
async function refreshTable(
  input: DerivedWritesInput,
  t: CompiledDerivedTable,
): Promise<DerivedWrite[]> {
  const { query } = input;
  const e = evaluateRule(input.schema, t.id);

  // The recomputation, by key: the only step whose failure on the data is the rule's
  // (RuleEvaluationError); the partitions and stored rows below fail as they do.
  const computed = new Map<
    string,
    { key: readonly FieldValue[]; values: Record<FieldId, FieldValue> }
  >();
  const evaluated = await evaluating(async () =>
    (await query(e.all.sql, e.all.params)).rows.flatMap((r) => {
      const d = e.decode(r);
      return d === undefined ? [] : [d];
    }),
  );
  for (const d of evaluated) {
    const k = keyText(d.key);
    if (computed.has(k)) throw new Error(`derived rule ${t.rule.id}: two rows with one key`);
    computed.set(k, { key: d.key, values: { ...d.values } });
  }

  // The partitions registered so far, by key; and the rows the table holds, by partition.
  const registered = new Map<string, PartitionId>();
  for (const r of (
    await query("SELECT partition_id, group_key FROM partitions WHERE derived_table_id = $1", [
      t.id,
    ])
  ).rows) {
    const id = r["partition_id"];
    const key = r["group_key"];
    if (typeof id !== "string" || !id.startsWith("p_"))
      throw new Error("a partition without an ID");
    // A key cleared by a deletion: registering again belongs with deletion, not in this version.
    if (typeof key !== "string") throw new Error(`partition ${id}: its key was cleared`);
    if (registered.has(key)) throw new Error(`two partitions of ${t.id} with one key`);
    registered.set(key, id as PartitionId);
  }
  const rows = derivedRowsQuery(t);
  const stored = new Map<PartitionId, StoredDerivedRow>();
  for (const r of (await query(rows.sql, rows.params)).rows) {
    const d = decodeDerivedRow(t, r);
    stored.set(d.partition, d);
  }
  const keyOfPartition = new Map<PartitionId, string>();
  for (const [k, id] of registered) keyOfPartition.set(id, k);
  // The registrations and the rows agree: each row's group key is the one its partition was
  // registered with; a whole aggregate has at most one partition, keyed by [].
  for (const [id, row] of stored) {
    const registeredKey = keyOfPartition.get(id);
    if (registeredKey === undefined)
      throw new Error(`derived row ${id} of ${t.id} has no partition`);
    if (keyText(keyOf(t, row.values)) !== registeredKey)
      throw new Error(`derived row ${id} of ${t.id} is not under the key it was registered with`);
  }
  if (t.rule.scope.kind === "tenant") {
    if (registered.size > 1) throw new Error(`whole aggregate ${t.id} has several partitions`);
    for (const k of registered.keys())
      if (k !== "[]") throw new Error(`whole aggregate ${t.id} is registered with key ${k}`);
  }

  const reads = [...new Set(t.rule.depends_on.map((d) => d.table))]
    .sort()
    .map((table) => ({ table }));
  const target = (partition: PartitionId, emptied: boolean): DerivedTarget => ({
    table: t.id,
    rule: t.rule.id,
    rule_version: t.rule.version,
    partition,
    read_pos: input.readPos,
    reads,
    emptied,
  });

  const writes: DerivedWrite[] = [];
  for (const [k, c] of computed) {
    const known = registered.get(k);
    const partition = known ?? input.newPartitionId();
    const before = known === undefined ? undefined : stored.get(known);
    const changes = t.fields
      .map((f) => ({
        field: f.id,
        before: before === undefined ? null : (before.values[f.id] ?? null),
        after: c.values[f.id] ?? null,
      }))
      // Only the fields whose value differs: a new row's before is null, so a field it leaves null
      // is not listed.
      .filter((x) => !same(x.before, x.after));
    // The same result: no write (06: results that did not change are not passed on).
    if (before !== undefined && changes.length === 0) continue;
    writes.push({
      target: target(partition, false),
      ...(known === undefined ? { key: { values: c.key } } : {}),
      checksum: { checksum: rowChecksum(c.values) as ChecksumBlock["checksum"] },
      groupKey: c.key,
      changes,
    });
  }
  for (const [partition, row] of stored) {
    if (computed.has(keyOfPartition.get(partition) as string)) continue;
    writes.push({
      target: target(partition, true),
      groupKey: keyOf(t, row.values),
      changes: t.fields
        .map((f) => ({ field: f.id, before: row.values[f.id] ?? null, after: null }))
        // Only the fields whose value differs: a field that was null stays null.
        .filter((x) => !same(x.before, x.after)),
    });
  }
  // Within a rule, by partition ID (09 §4.2 step 6).
  return writes.sort((a, b) =>
    a.target.partition < b.target.partition ? -1 : a.target.partition > b.target.partition ? 1 : 0,
  );
}

/**
 * The derived writes after this operation's base changes, in the order they are appended: derived
 * tables in dependency order (this version's rules read base tables only, so in the schema's
 * order), each rule's by partition ID. A rule is recomputed once however many of its tables
 * changed, and only when one of them did.
 */
export async function derivedWrites(input: DerivedWritesInput): Promise<DerivedWrite[]> {
  const changed = new Set(input.changes.map((c) => c.table));
  const out: DerivedWrite[] = [];
  for (const t of input.schema.tables) {
    if (t.kind !== "derived") continue;
    if (!t.rule.depends_on.some((d) => changed.has(d.table))) continue;
    out.push(...(await refreshTable(input, t)));
  }
  return out;
}
