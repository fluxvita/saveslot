// `query` (docs/zh-CN/spec/04-contract.md §10 `query`; 04-contract-types.md §4.3), in the caller's
// read transaction: the table named within the visible range, the parameters normalized, the rows
// selected, marked, merged and ordered, one page given back; and the read as `audit` records it
// (02-integrity-and-records «读取记录»; 04-write-and-read «读取记录里记什么形状»): the rows and
// versions of the page (one per entity on state tables), the fingerprint of the query without any
// value, the business time read, and the `ver` / `sv` it counts as having read for the fallback.

import type { Instant, JsonValue, TableId } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadRow, ReadValid } from "../audit/index.ts";
import { get, has, isObj, type Obj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { changersOf } from "./changed-by.ts";
import { queryDerived } from "./derived.ts";
import { type QueryPlan, queryPlan } from "./params.ts";
import type { QueryInput, QueryOutput } from "./query-io.ts";
import {
  cmpKeys,
  decodePosition,
  encodePosition,
  keySpecs,
  queryIdentity,
  rowKeys,
  type ShownRow,
  shownRows,
} from "./rows.ts";
import { logPosition, premiseFacts, restoreCount, rowFacts, selectRows } from "./select.ts";
import { resolveTable, visibleSlots } from "./slots.ts";
import { invalid, type QueryReadResult } from "./types.ts";
import { rowFactsAsOf, selectRowsAsOf } from "./versions.ts";

export type { QueryInput, QueryOutput };

/** The structural fingerprint of a query: IDs and operators, every value as `"?"`. */
export function fingerprint(plan: QueryPlan, params: Obj): string {
  return canonicalize({
    table: plan.table.id,
    fields: plan.fields.map((f) => f.id as string).sort(),
    where: plan.where.map((c) => ({
      field: typeof c.column === "string" ? c.column : c.column.id,
      op: c.op,
      value: "?",
    })),
    order: plan.order.map((o) => ({ field: o.field.id, dir: o.dir })),
    page: has(params, "limit") || has(params, "position"),
    time: plan.time.kind === "during" ? "during" : plan.time.kind === "at" ? "at" : "none",
  } as JsonValue);
}

/** The business time a read is recorded with (state tables always: "now" is a point too). */
function validRead(plan: QueryPlan): ReadValid | undefined {
  if (plan.time.kind === "during") return { during: [plan.time.from, plan.time.to] };
  if (plan.kind === "state") return { at: plan.time.point };
  return undefined;
}

export async function queryInTx(tx: ReadTx, input: QueryInput): Promise<QueryOutput> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const slots = await visibleSlots(tx, input.visibility);
  const named = resolveTable(get(params, "table"), "table", slots);
  if (named.table.kind === "derived") return queryDerived(tx, input, params, named);
  const first = queryPlan(params, named, { now: input.now, task: input.task });
  const restore = await restoreCount(tx);
  const latest = await logPosition(tx);
  const identity = queryIdentity(first, { at: has(params, "at") });
  const specs = keySpecs(first);
  // A later page: the state after the first page's operation, at its evaluation time.
  const position =
    first.position === undefined
      ? undefined
      : decodePosition(first.position, "position", {
          identity,
          specs,
          restoreCount: restore,
          latest,
        });
  const plan =
    position === undefined || has(params, "at")
      ? first
      : queryPlan(params, named, { now: position.at as Instant, task: input.task });
  const asOf = position?.seq ?? input.asOf;
  const selected =
    asOf === undefined ? await selectRows(tx, plan) : await selectRowsAsOf(tx, plan, asOf);
  const ids = selected.map((r) => r.id);
  const facts = {
    ...(asOf === undefined
      ? await rowFacts(tx, plan.table, ids)
      : await rowFactsAsOf(tx, plan.table, ids, asOf)),
    premises: await premiseFacts(tx, plan.table, ids, asOf),
  };
  const rows: ShownRow[] = shownRows(plan, selected, facts, restore).map((s) => ({
    ...s,
    keys: rowKeys(plan, s),
  }));
  rows.sort((a, b) => cmpKeys(specs, a.keys, b.keys));

  const after = position?.keys;
  const rest = after === undefined ? rows : rows.filter((r) => cmpKeys(specs, r.keys, after) > 0);
  const page = rest.slice(0, plan.limit);
  const last = page.at(-1);
  // Who last changed each row, when not the caller: one statement for the page.
  const changers = await changersOf(
    tx,
    page.map((r) => r.ver),
    input.actor,
  );
  const result: QueryReadResult = {
    table: `${named.slot.name}.${named.table.name}`,
    slot: named.slot.name,
    sv: named.slot.sv,
    total: rows.length,
    ...(rest.length > page.length && last !== undefined
      ? {
          next_position: encodePosition(identity, {
            seq: asOf ?? latest,
            at: position?.at ?? plan.at,
            restoreCount: restore,
            keys: last.keys,
          }),
        }
      : {}),
    rows: page.map((r) => {
      const by = changers.get(r.ver);
      return by !== undefined ? { ...r.row, changed_by: by } : r.row;
    }),
    ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
  };

  // The read: one version per row, per entity on state tables.
  const read = new Map<string, number>();
  for (const r of page) read.set(r.id, r.ver);
  const tableId = named.table.id as TableId;
  const readRows: ReadRow[] = [...read].map(([target, op]) => ({
    table: tableId,
    target,
    ver: { op: op as never, restoreCount: restore },
  }));
  const valid = validRead(plan);
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task: plan.task,
    at: input.now,
    // The state read: a later page's is the first page's (04-contract §15).
    pos: (asOf ?? latest) as never,
    operation: "query",
    slot: named.slot.slot,
    sv: named.slot.sv,
    table: tableId,
    shape: fingerprint(plan, params),
    ...(valid !== undefined ? { valid } : {}),
    rows: readRows,
    coarse: [],
    lastRead: [
      ...readRows.map((r) => ({
        kind: "ver" as const,
        target: r.target,
        op: r.ver?.op as number,
        restoreCount: restore,
      })),
      { kind: "sv" as const, target: named.slot.slot, op: named.slot.sv, restoreCount: 0 },
    ],
  };
  return { result, entry };
}
