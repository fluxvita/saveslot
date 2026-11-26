// Appending an operation and refreshing derived tables in its transaction (docs/zh-CN/spec/
// 09-event-format.md §4.2 step 6; 06-derived.md «刷新范围与写入准入»; K5): the step `write`,
// the writes `resolve` triggers and `undo` share.
//
// The operation's events are appended and applied; derive computes the derived writes of its base
// changes on the state they left; when there are any, they are appended to the same operation
// (log continuation: same `op`, same `at`) and only they are applied in turn. No derived write: no
// continuation, nothing applied twice.
//
// A rule evaluation that fails on the data (a result out of range, a database data error such as
// a 64-bit overflow) fails the whole write: `validation_failed` with `rule_eval_failed`, nothing
// kept (the caller's transaction rolls back).

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldId,
  PartitionId,
  PrincipalId,
  Seq,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { applyEvents, eventsOf } from "../apply/index.ts";
import { type BaseChange, type DerivedWrite, derivedWrites, memberKeys } from "../derive/index.ts";
import {
  appendOperation,
  continueOperation,
  type NewEvent,
  type PreparedOperation,
} from "../log/index.ts";
import { RuleEvaluationError } from "../rules/index.ts";
import type { Tx } from "../store/ports.ts";
import { detectPremises } from "./detect-premises.ts";
import { WriteError } from "./errors.ts";

/** The base changes of an operation's events: each `write.base`'s table, row and fields written. */
export function baseChanges(events: readonly NewEvent[]): BaseChange[] {
  const out: BaseChange[] = [];
  for (const e of events) {
    if (e.type !== "write.base") continue;
    const t = e.blocks["target"] as { table: TableId; row?: string; entity?: string };
    const fields = new Set<FieldId>();
    for (const path of Object.keys(e.blocks)) {
      const m = /^fields\/(f[1-9][0-9]*)\//.exec(path);
      if (m !== null) fields.add(m[1] as FieldId);
    }
    // A change of the row's existence alone (a revoke, its undoing) has no field: still a change.
    out.push({ table: t.table, row: (t.row ?? t.entity) as string, fields: [...fields] });
  }
  return out;
}

export interface DeriveStepInput {
  readonly actor: PrincipalId;
  readonly now: string;
  readonly events: readonly NewEvent[];
  /** The compiled definition of the slot the operation writes. */
  readonly schema: CompiledSchema;
  readonly newPartitionId: () => PartitionId;
}

export interface DeriveStepOutput {
  /** The operation as first appended (its head, base and item events). */
  readonly prepared: PreparedOperation;
  /** The derived writes appended after them, in order; none when nothing changed. */
  readonly derived: readonly DerivedWrite[];
}

/**
 * Appends the operation, applies it, puts into it the premises it changed (`premise.changed`, read
 * from the version table once its base events are applied: ./detect-premises.ts), then refreshes the
 * derived tables its base changes reach, all in the caller's transaction. Throws
 * ApplyError when an event does not fit the state (the caller's to report), WriteError
 * `validation_failed` (`rule_eval_failed`) when a rule fails on the data.
 */
/**
 * A rule that fails on the data, wherever derive evaluates it (the members before and after, the
 * recomputation), fails the write the same way: `validation_failed`, `rule_eval_failed`.
 */
async function asWriteError<T>(step: () => Promise<T>): Promise<T> {
  try {
    return await step();
  } catch (e) {
    if (e instanceof RuleEvaluationError) {
      throw new WriteError("validation_failed", "a derived rule failed on the data", {
        reason: "write",
        details: [{ code: "rule_eval_failed", sql_reason: "runtime" }],
      });
    }
    throw e;
  }
}

export async function appendWithDerived(tx: Tx, input: DeriveStepInput): Promise<DeriveStepOutput> {
  const prepared = await appendOperation(tx, {
    actor: input.actor,
    now: input.now as never,
    events: [...input.events],
  });
  const changes = baseChanges(input.events);
  const query = async (sql: string, params: readonly unknown[]) =>
    tx.query<Record<string, unknown>>(sql, params as never);
  // The groups the changed rows are in before the operation (06 «刷新范围与写入准入»): read before
  // its base events are applied; derivedWrites reads the groups after.
  const before =
    changes.length === 0
      ? undefined
      : await asWriteError(() => memberKeys({ query, schema: input.schema, changes }));
  await applyEvents(tx, eventsOf(prepared));
  // After every base and item event, before the derived writes (09 §4.2): at most one.
  const premises = await detectPremises(
    tx,
    prepared.op,
    (id) =>
      input.schema.tables.find((t) => t.id === id && t.kind === "base") as
        | CompiledBaseTable
        | undefined,
  );
  let lastOf = prepared;
  if (premises !== undefined) {
    lastOf = await continueOperation(tx, prepared, [premises]);
    await applyEvents(tx, eventsOf(lastOf));
  }
  if (changes.length === 0) return { prepared, derived: [] };
  const last = lastOf.events.at(-1)?.seq as Seq;
  const derived = await asWriteError(() =>
    derivedWrites({
      query,
      schema: input.schema,
      changes,
      ...(before !== undefined ? { before } : {}),
      newPartitionId: input.newPartitionId,
      readPos: last,
    }),
  );
  if (derived.length === 0) return { prepared, derived };
  const more = await continueOperation(
    tx,
    lastOf,
    derived.map(
      (w): NewEvent => ({
        type: "write.derived",
        slot: input.schema.slot,
        blocks: {
          target: w.target as never,
          ...(w.key !== undefined ? { key: w.key as never } : {}),
          ...(w.checksum !== undefined ? { checksum: w.checksum as never } : {}),
        },
      }),
    ),
  );
  await applyEvents(tx, eventsOf(more));
  return { prepared, derived };
}
