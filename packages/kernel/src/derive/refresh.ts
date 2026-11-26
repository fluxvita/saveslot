// The derived refresh of one operation (docs/zh-CN/spec/03-data-model/06-derived.md «刷新范围与写入
// 准入», 01-objects «行身份»; 09-event-format.md §4.2 step 6, §5.7 `write.derived`): which derived rows changed
// after this operation's base changes, as derived writes to append.
//
// derive does not read storage itself (02-architecture §4: it depends on rules and log only): the
// caller passes its query function, run in the caller's transaction, after the operation's base
// events are applied.
//
// Which partitions are recomputed (06 «刷新范围与写入准入»: the affected groups). A rule that can be
// narrowed (RuleEvaluation `narrowable`: one event or timeless table, no window function, no
// subquery) is recomputed for the groups the changed rows are in before or after the operation,
// and for no other: the caller gives the keys before (memberKeys, run before the base events are
// applied), and the keys after are read here the same way. Any other rule, and any rule when the
// keys before are not given, is recomputed whole («分析不出»). Either way the result is compared
// with the derived table:
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
// A new partition's ID is taken in the order of the keys' canonical text, so that the same new keys
// get the same IDs whichever way they were found (IDs are random in the service; the order matters
// to a test comparing the two ways).

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
import { sameValue } from "../delta/index.ts";
import {
  computedAtRead,
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
  /**
   * The group keys the changed rows were in before the operation (memberKeys before its base
   * events were applied), by derived table. A table without an entry is recomputed whole.
   */
  readonly before?: MemberKeys;
  /** IDs come from the caller, as the write's other IDs. */
  readonly newPartitionId: () => PartitionId;
  /** The `seq` of the last event before these derived writes (09 `write.derived` `read_pos`). */
  readonly readPos: Seq;
}

const keyText = (values: readonly FieldValue[]) => canonicalize(values as unknown as JcsValue);

/**
 * The most affected keys a rule is narrowed to; past them it is recomputed whole. Each key is one
 * `partition(key)`, and until the base rows of a group can be found by index (a range on the time
 * field, with storage format 6's index) each of those reads the whole base table, much as the whole
 * recomputation does. Measured at a million rows (shape C of experiment 9): a rule by day 188–194 ms
 * whole, 64–66 ms for one partition; by month 277–286 ms whole, 165–167 ms for one. A single-row
 * write affects one or two keys a rule; a batch, many.
 */
export const NARROWED_KEYS_MAX = 2;

/** Group keys by derived table: the canonical text of each key, and the key. */
export type MemberKeys = ReadonlyMap<TableId, ReadonlyMap<string, readonly FieldValue[]>>;

/** The derived tables a write refreshes: stored, reading a table the changes touch. */
function refreshed(schema: CompiledSchema, changes: readonly BaseChange[]): CompiledDerivedTable[] {
  const changed = new Set(changes.map((c) => c.table));
  const out: CompiledDerivedTable[] = [];
  for (const t of schema.tables) {
    if (t.kind !== "derived") continue;
    // Computed when read: no derived writes, whatever changed (06-derived «时间依赖»).
    if (computedAtRead(t)) continue;
    // A rule reads base tables only in this version (rules/rsql/analyze.ts refuses a derived one).
    for (const d of t.rule.depends_on) {
      if (schema.tables.some((x) => x.id === d.table && x.kind === "derived"))
        throw new Error(`derived rule ${t.rule.id} reads derived table ${d.table}`);
    }
    if (!t.rule.depends_on.some((d) => changed.has(d.table))) continue;
    out.push(t);
  }
  return out;
}

/**
 * The group keys the changed rows are in now, for each derived table a write refreshes whose rule
 * can be narrowed: the rule's members among those rows (rows WHERE keeps, not revoked). Run before
 * the operation's base events are applied, it gives the keys before; derivedWrites reads the keys
 * after itself.
 */
export async function memberKeys(input: {
  readonly query: Query;
  readonly schema: CompiledSchema;
  readonly changes: readonly BaseChange[];
}): Promise<MemberKeys> {
  const out = new Map<TableId, Map<string, readonly FieldValue[]>>();
  for (const t of refreshed(input.schema, input.changes)) {
    const e = evaluateRule(input.schema, t.id);
    if (!e.narrowable) continue;
    const rows = [...new Set(input.changes.filter((c) => c.table === e.base).map((c) => c.row))];
    const keys = new Map<string, readonly FieldValue[]>();
    if (rows.length > 0) {
      const q = e.membersAmong(rows);
      // The members are the rule's WHERE and group key on these rows: an expression that fails on
      // the data (an overflow) is the rule's failure, as in the recomputation (RuleEvaluationError).
      const members = await evaluating(async () =>
        (await input.query(q.sql, q.params)).rows.map((r) => e.decodeMember(r)),
      );
      for (const m of members) keys.set(keyText(m.key), m.key);
    }
    out.set(t.id, keys);
  }
  return out;
}

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
  /** The groups to recompute, by key text; undefined: all of them. */
  affected: ReadonlyMap<string, readonly FieldValue[]> | undefined,
): Promise<DerivedWrite[]> {
  const { query } = input;
  const e = evaluateRule(input.schema, t.id);
  if (affected !== undefined && affected.size === 0) return [];

  // The recomputation, by key: the only step whose failure on the data is the rule's
  // (RuleEvaluationError); the partitions and stored rows below fail as they do.
  const computed = new Map<
    string,
    { key: readonly FieldValue[]; values: Record<FieldId, FieldValue> }
  >();
  const queries =
    affected === undefined ? [e.all] : [...affected.values()].map((k) => e.partition(k));
  const evaluated = await evaluating(async () => {
    const rows = [];
    for (const q of queries) {
      for (const r of (await query(q.sql, q.params)).rows) {
        const d = e.decode(r);
        if (d !== undefined) rows.push(d);
      }
    }
    return rows;
  });
  for (const d of evaluated) {
    const k = keyText(d.key);
    if (computed.has(k)) throw new Error(`derived rule ${t.rule.id}: two rows with one key`);
    if (affected !== undefined && !affected.has(k))
      throw new Error(`derived rule ${t.rule.id}: a partition recomputed under another key`);
    computed.set(k, { key: d.key, values: { ...d.values } });
  }

  // The partitions registered so far, by key (only the affected ones when narrowed); and the rows
  // the table holds under them, by partition.
  const registered = new Map<string, PartitionId>();
  const reg =
    affected === undefined
      ? await query("SELECT partition_id, group_key FROM partitions WHERE derived_table_id = $1", [
          t.id,
        ])
      : await query(
          "SELECT partition_id, group_key FROM partitions WHERE derived_table_id = $1 AND group_key = ANY($2)",
          [t.id, [...affected.keys()]],
        );
  for (const r of reg.rows) {
    const id = r["partition_id"];
    const key = r["group_key"];
    if (typeof id !== "string" || !id.startsWith("p_"))
      throw new Error("a partition without an ID");
    // A key cleared by a deletion: registering again belongs with deletion, not in this version.
    if (typeof key !== "string") throw new Error(`partition ${id}: its key was cleared`);
    if (registered.has(key)) throw new Error(`two partitions of ${t.id} with one key`);
    registered.set(key, id as PartitionId);
  }
  const rows = derivedRowsQuery(t, affected === undefined ? undefined : [...registered.values()]);
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
  // New partitions get their IDs in the order of their keys' text (see the head of this file).
  for (const [k, c] of [...computed].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) {
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
      .filter((x) => !sameValue(x.before, x.after));
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
        .filter((x) => !sameValue(x.before, x.after)),
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
 * order), each rule's by partition ID. A table computed when read has none. A rule is recomputed once however many of its tables
 * changed, and only when one of them did.
 */
export async function derivedWrites(input: DerivedWritesInput): Promise<DerivedWrite[]> {
  const after = input.before === undefined ? undefined : await memberKeys(input);
  const out: DerivedWrite[] = [];
  for (const t of refreshed(input.schema, input.changes)) {
    const before = input.before?.get(t.id);
    const now = after?.get(t.id);
    // Narrowed: the groups the changed rows were in or are in, when there are few enough of them
    // (NARROWED_KEYS_MAX). Otherwise, every group.
    const union =
      before === undefined || now === undefined ? undefined : new Map([...before, ...now]);
    const affected = union !== undefined && union.size <= NARROWED_KEYS_MAX ? union : undefined;
    out.push(...(await refreshTable(input, t, affected)));
  }
  return out;
}
