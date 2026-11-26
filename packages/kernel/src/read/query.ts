// `query` (docs/zh-CN/spec/04-contract.md §10 `query`; 04-contract-types.md §4.3), in the caller's
// read transaction: the table named within the visible range, the parameters normalized, the rows
// selected, marked, merged and ordered, one page given back; and the read as `audit` records it
// (02-integrity-and-records «读取记录»; 04-write-and-read «读取记录里记什么形状»): the rows and
// versions of the page (one per entity on state tables), the fingerprint of the query without any
// value, the business time read, and the `ver` / `sv` it counts as having read for the fallback.

import type {
  CompiledBaseField,
  Instant,
  JsonValue,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadRow, ReadValid } from "../audit/index.ts";
import { get, has, isObj, type Obj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { changersOf } from "./changed-by.ts";
import { revokedTargets } from "./dangling.ts";
import { queryDerived } from "./derived.ts";
import { rowDetails } from "./detail.ts";
import { type KeyValue, queryKeys, type SqlKey } from "./order-sql.ts";
import { type QueryPlan, queryPlan } from "./params.ts";
import type { QueryInput, QueryOutput } from "./query-io.ts";
import {
  cmpKeys,
  decodePosition,
  encodePosition,
  type KeySpec,
  keySpecs,
  overInterval,
  type Position,
  queryIdentity,
  rowKeys,
  type ShownRow,
  shownRows,
} from "./rows.ts";
import {
  countRows,
  logPosition,
  premiseFacts,
  restoreCount,
  rowFacts,
  type SelectedRow,
  selectFirst,
  selectRows,
} from "./select.ts";
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

/** A page of the rows shown, how many rows there are in all, and whether more follow the page. */
interface PageRows {
  readonly page: readonly ShownRow[];
  readonly total: number;
  readonly more: boolean;
}

/** What the rows shown need beside their values, for the rows selected given. */
async function factsOf(
  tx: ReadTx,
  plan: QueryPlan,
  selected: readonly SelectedRow[],
  asOf: number | undefined,
) {
  const ids = selected.map((r) => r.id);
  return {
    ...(asOf === undefined
      ? await rowFacts(tx, plan.table, ids)
      : await rowFactsAsOf(tx, plan.table, ids, asOf)),
    premises: await premiseFacts(tx, plan.table, ids, asOf, plan.detailed),
    // Targets in tables the caller can see only: a target out of range says nothing of itself.
    revokedTargets: await revokedTargets(tx, plan.table, plan.named.slot.tables, selected, asOf),
  };
}

/** The rows shown from the rows selected, with their keys, in order. */
async function shownInOrder(
  tx: ReadTx,
  plan: QueryPlan,
  specs: readonly KeySpec[],
  restore: number,
  selected: readonly SelectedRow[],
  asOf: number | undefined,
): Promise<ShownRow[]> {
  const facts = await factsOf(tx, plan, selected, asOf);
  const rows: ShownRow[] = shownRows(plan, selected, facts, restore).map((s) => ({
    ...s,
    keys: rowKeys(plan, s),
  }));
  rows.sort((a, b) => cmpKeys(specs, a.keys, b.keys));
  return rows;
}

/**
 * The whole read: every row selected (of the latest state, or as of `asOf`), its facts, merged
 * and ordered, and the page after `after`. Where a page cannot be pushed down, and the standard a
 * pushed-down page is compared with.
 */
async function queryRowsFull(
  tx: ReadTx,
  plan: QueryPlan,
  specs: readonly KeySpec[],
  restore: number,
  after: Position["keys"] | undefined,
  asOf: number | undefined,
): Promise<PageRows> {
  const selected =
    asOf === undefined ? await selectRows(tx, plan) : await selectRowsAsOf(tx, plan, asOf);
  const rows = await shownInOrder(tx, plan, specs, restore, selected, asOf);
  const rest = after === undefined ? rows : rows.filter((r) => cmpKeys(specs, r.keys, after) > 0);
  const page = rest.slice(0, plan.limit);
  return { page, total: rows.length, more: rest.length > page.length };
}

/**
 * A first page of the latest state pushed down to SQL: the page's rows and one more (whether more
 * follow) in the order of the keys, the facts of the page's rows only, and the total counted
 * apart. Where each row selected is a row shown: event tables, and state tables at a point.
 * Undefined elsewhere: timeless tables (their order's first key, `ver`, is not a column of the
 * business table) and state tables over an interval (segments are merged before the page).
 */
async function queryRowsPushed(
  tx: ReadTx,
  plan: QueryPlan,
  specs: readonly KeySpec[],
  restore: number,
  batches: QueryInput["batches"],
): Promise<PageRows | undefined> {
  if (plan.kind === "timeless") return undefined;
  if (plan.kind === "state" && plan.time.kind === "during")
    return plan.order.length > 0 ? undefined : intervalPage(tx, plan, specs, restore, batches);
  const selected = await selectFirst(tx, plan, queryKeys(plan, specs), plan.limit + 1);
  const shown = selected.slice(0, plan.limit);
  return {
    page: await shownInOrder(tx, plan, specs, restore, shown, undefined),
    total: await countRows(tx, plan),
    more: selected.length > plan.limit,
  };
}

/** Segments read per statement over an interval: for a page (n + 1 rows), and to count. */
const pageBatch = (limit: number) => 4 * (limit + 1);
const COUNT_BATCH = 10_000;

/**
 * A state table's segments over an interval, in the order of entity and `valid_from`, an entity
 * at a time: each entity's segments whole (merging needs them all), with the rows shown they
 * give (./rows.ts `overInterval`, without marks). Read in batches after the last segment read,
 * by its primary key, which the database reads as a range of the key's index; with the values of
 * `fields` only when given. `take` says, after each entity, whether to go on.
 */
async function eachEntity(
  tx: ReadTx,
  plan: QueryPlan,
  keys: readonly SqlKey[],
  batch: number,
  take: (segments: SelectedRow[], shown: number) => boolean,
  fields?: readonly CompiledBaseField[],
): Promise<void> {
  const none = () => undefined;
  let pending: SelectedRow[] = [];
  const flush = (): boolean => {
    if (pending.length === 0) return true;
    const shown = overInterval(
      plan,
      pending.map((r) => ({ r, marks: undefined })),
      none,
      none,
    );
    const go = take(pending, shown.length);
    pending = [];
    return go;
  };
  let after: KeyValue[] | undefined;
  for (;;) {
    const rows = await selectFirst(tx, plan, keys, batch, {
      ...(after !== undefined ? { after } : {}),
      ...(fields !== undefined ? { fields } : {}),
    });
    for (const r of rows) {
      if (pending.length > 0 && (pending[0] as SelectedRow).id !== r.id && !flush()) return;
      pending.push(r);
    }
    const last = rows.at(-1);
    if (last === undefined || rows.length < batch) {
      flush();
      return;
    }
    after = [last.id, last.validFrom as string];
  }
}

/**
 * A first page of a state table read over an interval, in the default order (entity, then the
 * shown row's `valid_from`): segments streamed an entity at a time until the entities complete so
 * far give the page's rows and one more; the facts of those entities only; the rows shown from
 * them, ordered, the page taken. The total streams every segment the same way, counting only.
 */
async function intervalPage(
  tx: ReadTx,
  plan: QueryPlan,
  specs: readonly KeySpec[],
  restore: number,
  batches: QueryInput["batches"],
): Promise<PageRows> {
  const keys = queryKeys(plan, specs);
  const segments: SelectedRow[] = [];
  let shown = 0;
  await eachEntity(tx, plan, keys, batches?.page ?? pageBatch(plan.limit), (s, n) => {
    if (n > 0) segments.push(...s);
    shown += n;
    return shown <= plan.limit;
  });
  const rows = await shownInOrder(tx, plan, specs, restore, segments, undefined);
  // Counted with the values the merge compares only (the fields read): the field conditions are
  // in SQL, those on valid_from / valid_to and the clip read the interval.
  let total = 0;
  await eachEntity(
    tx,
    plan,
    keys,
    batches?.count ?? COUNT_BATCH,
    (_, n) => {
      total += n;
      return true;
    },
    plan.fields,
  );
  return { page: rows.slice(0, plan.limit), total, more: rows.length > plan.limit };
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
  // A first page of the latest state is pushed down to SQL where it can be; the rest, and what
  // cannot yet, is the whole read.
  const pushed =
    input.full === true || position !== undefined || asOf !== undefined
      ? undefined
      : await queryRowsPushed(tx, plan, specs, restore, input.batches);
  const { page, total, more } =
    pushed ?? (await queryRowsFull(tx, plan, specs, restore, position?.keys, asOf));
  const last = page.at(-1);
  // Who last changed each row, when not the caller: one statement for the page.
  const changers = await changersOf(
    tx,
    page.map((r) => r.ver),
    input.actor,
  );
  // `detail: "detailed"`: each row's detail, and the rows its ref summaries read.
  const detailed = plan.detailed
    ? await rowDetails(tx, {
        table: plan.table,
        fields: plan.fields,
        visible: named.slot.tables,
        page,
        asOf,
        at: (position?.at as Instant | undefined) ?? plan.at,
        zone: named.slot.timezone,
        restoreCount: restore,
      })
    : undefined;
  const result: QueryReadResult = {
    table: `${named.slot.name}.${named.table.name}`,
    slot: named.slot.name,
    sv: named.slot.sv,
    total,
    ...(more && last !== undefined
      ? {
          next_position: encodePosition(identity, {
            seq: asOf ?? latest,
            at: position?.at ?? plan.at,
            restoreCount: restore,
            keys: last.keys,
          }),
        }
      : {}),
    rows: page.map((r, i) => {
      const by = changers.get(r.ver);
      const d = detailed?.details[i];
      return {
        ...r.row,
        ...(by !== undefined ? { changed_by: by } : {}),
        ...(d !== undefined
          ? { detail: { ...d, ...((r.premises ?? []).length > 0 ? { premises: r.premises } : {}) } }
          : {}),
      };
    }),
    ...(plan.warnings.length > 0 ? { warnings: plan.warnings } : {}),
  };

  // The read: one version per row, per entity on state tables.
  const read = new Map<string, number>();
  for (const r of page) read.set(r.id, r.ver);
  const tableId = named.table.id as TableId;
  const readRows: ReadRow[] = [
    ...[...read].map(([target, op]) => ({
      table: tableId,
      target,
      ver: { op: op as never, restoreCount: restore },
    })),
    // The rows a ref summary read (`detail: "detailed"`): read as much as the page's.
    ...(detailed?.read ?? []),
  ];
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
    // The page's own rows only: a ref summary is not the row it names, whose other fields and
    // version the reader has not seen (04-contract §10 `detail`), so it is no fallback for a write.
    lastRead: [
      ...[...read].map(([target, op]) => ({
        kind: "ver" as const,
        target,
        op,
        restoreCount: restore,
      })),
      { kind: "sv" as const, target: named.slot.slot, op: named.slot.sv, restoreCount: 0 },
    ],
  };
  return { result, entry };
}
