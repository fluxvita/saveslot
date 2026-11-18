// The write receipt (docs/zh-CN/spec/04-contract-types.md §5.1 `WriteResult`), built from the
// operation's events in the log. A fresh write and an idempotent replay build it the same way, so
// the replay gives what the write gave (04-write-and-read «重发时返回什么»).
//
// Given here: the status, `sv`, `seq`, each op's target, intent, `ver` (the row's version as of the
// operation), created entity, per-field result codes with the value written and, for a candidate
// or awaiting part, its pending item with the item's details (a candidate's `effective`,
// `current_ver`, `by`, `previous` and, when taking it would be high impact, `impact`; an awaiting
// part's `impact`), `undo.of` with what was skipped and what later writes were taken back, and the
// pending items the write opened, joined, refreshed or superseded, each once; an entity created
// by key gets `existing_keys` from the pipeline (not in the log: a replay lists it in `omitted`).
// Not given yet: `before`, `overwritten`, `merged` (auto-merged fields), `resolved`; derived
// changes, affected reads and premises. They come with the read path and derived refresh.

import type {
  CompiledBaseTable,
  CompiledSchema,
  DateStr,
  EntityId,
  EVENT_DECISIONS,
  EVENT_ITEM_TYPES,
  FieldValue,
  Intent,
  ItemCreatedReason,
  ItemId,
  OpNumber,
  RowId,
  SupersededReason,
} from "@fluxvita/saveslot-contract-core";
import type { ReadId } from "../audit/index.ts";
import type { DerivedWrite } from "../derive/index.ts";
import { type ActorAsOf, actorsAsOf } from "../log/index.ts";
import {
  type Blocks,
  candidateImpactBlocks,
  type ItemEntries,
  impactOut,
  itemEntries,
  itemVer,
  latestGiver,
  type Naming,
  opOfCell,
  piecesOver,
  type RowCell,
  rowCellsAt,
  rowOf,
} from "../pending/index.ts";
import type { WriteWarning } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { type ValueOut, valueOut } from "../time/index.ts";
import { WriteError } from "./errors.ts";
import { type EntityKeyText, keyFields, keyOf } from "./keys.ts";
import type { StoredEvent } from "./record.ts";

export type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop";

/** A field's result as the receipt assembles it, every key optional; `fieldResult` checks it. */
interface PartDraft {
  readonly result: FieldResultCode;
  readonly after?: ValueOut;
  readonly no_value?: true;
  readonly uncovered?: true;
  /** Candidate or awaiting: the pending item. */
  readonly item?: ItemId;
  /** Candidate: the value in effect, the row's version, who gave it, the merge base's state. */
  readonly effective?: ValueOut;
  readonly current_ver?: string;
  readonly by?: { readonly seq: number; readonly actor: Actor };
  readonly previous?: {
    readonly seq: number;
    readonly exists: boolean;
    readonly values?: Readonly<Record<string, ValueOut>>;
    readonly spans?: readonly (Interval & {
      readonly values: Readonly<Record<string, ValueOut>> | null;
    })[];
  };
  /** Awaiting, or a candidate taking which would be high impact: what carrying it out would change. */
  readonly impact?: Impact;
  /** State tables: the interval of this part. */
  readonly valid?: Interval;
}

type Previous = NonNullable<PartDraft["previous"]>;

/** 04-contract-types §5.1 `FieldResult`: by its result, with what each result must give. */
export type FieldResult =
  | {
      readonly result: "applied";
      readonly after?: ValueOut;
      readonly no_value?: true;
      readonly uncovered?: true;
      readonly valid?: Interval;
    }
  | { readonly result: "corroborated"; readonly valid?: Interval }
  | { readonly result: "noop" }
  | {
      readonly result: "candidate";
      readonly after?: ValueOut;
      readonly item: ItemId;
      readonly effective: ValueOut;
      readonly current_ver: string;
      /** None when no stretch of the candidate's part was given its state by an operation. */
      readonly by?: { readonly seq: number; readonly actor: Actor };
      readonly previous: Previous;
      readonly impact?: Impact;
      readonly valid?: Interval;
    }
  | {
      readonly result: "awaiting";
      readonly after?: ValueOut;
      readonly item: ItemId;
      readonly impact: Impact;
      readonly valid?: Interval;
    };

/** A part of a state table's field: its interval, but for a noop part, which has none. */
export type StatePart =
  | Extract<FieldResult, { result: "noop" }>
  | (Exclude<FieldResult, { result: "noop" }> & { readonly valid: Interval });

/** What each result must give (04-contract-types §5.1). */
const MUST: ReadonlyMap<string, readonly (keyof PartDraft)[]> = new Map([
  ["candidate", ["item", "effective", "current_ver", "previous"]],
  ["awaiting", ["item", "impact"]],
]);

/**
 * A part as the contract has it. A candidate or awaiting part without what it must give, or a
 * state table's part (other than noop) without its interval, is the log and the receipt
 * disagreeing: an internal error, not a receipt with a hole in it.
 */
function fieldResult(d: PartDraft, isState: boolean): FieldResult {
  const missing = (MUST.get(d.result) ?? []).filter((k) => d[k] === undefined);
  if (isState && d.result !== "noop" && d.valid === undefined) missing.push("valid");
  if (missing.length > 0) {
    throw new WriteError(
      "internal",
      `a ${d.result} part without ${missing.join(", ")} in a write's receipt`,
      {
        reason: "inconsistent",
      },
    );
  }
  return d as FieldResult;
}

/** A business time interval as the contract gives it (04-contract-types `Interval`). */
export interface Interval {
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  /** Date granularity, with an end: the interval's last day. */
  readonly valid_to_inclusive?: DateStr;
}

/**
 * 04-contract-types §1.6 `Actor`, as of the receipt's own operation: a later rename or revocation
 * does not change a receipt, first or replayed.
 */
export type Actor = ActorAsOf;

/** 04-contract-types `AwaitingImpact`. */
export interface Impact {
  readonly overwritten?: readonly {
    readonly field: string;
    readonly valid?: Interval;
    readonly value: ValueOut;
    readonly seq: number;
    readonly actor: Actor;
  }[];
  readonly filled_gaps?: readonly { readonly valid?: Interval; readonly revoked_by?: number }[];
  readonly reverted?: readonly {
    readonly seq: number;
    readonly actor: Actor;
    readonly fields: readonly string[];
  }[];
}

export interface OpReceipt {
  readonly target: {
    readonly table: string;
    readonly row?: RowId;
    readonly entity?: EntityId;
    /** An op by `entity_key`: the entity's key, by field name (04-contract-types `TargetRef`). */
    readonly entity_key?: Readonly<Record<string, ValueOut>>;
  };
  readonly intent: Intent;
  readonly ver?: string;
  readonly created_entity?: true;
  /**
   * An entity created by `entity_key`: the table's keys before it, at most 10 (04-contract §5.1),
   * caller data. Worked out at the write from the state then, not in the log: the pipeline adds them
   * and a replay leaves them out.
   */
  readonly existing_keys?: readonly EntityKeyText[];
  readonly fields: Readonly<Record<string, FieldResult | readonly StatePart[]>>;
  readonly undo?: {
    readonly of: OpNumber;
    readonly skipped_superseded: readonly {
      readonly field: string;
      readonly by: OpNumber;
      readonly actor: Actor;
    }[];
    readonly reverted_later?: readonly {
      readonly seq: OpNumber;
      readonly actor: Actor;
      readonly fields: readonly string[];
    }[];
  };
}

export interface PendingRef {
  readonly id: ItemId;
  readonly type: (typeof EVENT_ITEM_TYPES)[number];
  readonly reason: ItemCreatedReason;
  /** Opened by this write, its contents given whole: its version (counts as read). */
  readonly item_ver?: string;
  readonly merged?: true;
  /** An open item whose contents this write changed: refreshed, still open. */
  readonly refreshed?: true;
  /** Replays only: the item's state now, and its decision when resolved. */
  readonly state?: "open" | "resolved" | "superseded";
  readonly decision?: (typeof EVENT_DECISIONS)[number];
}

/** 04-contract-types `DerivedChange`: one field of one derived row this write changed. */
export interface DerivedChange {
  /** Qualified: `slot.table`. */
  readonly table: string;
  readonly key: Readonly<Record<string, ValueOut>>;
  readonly field: string;
  readonly before: ValueOut;
  readonly after: ValueOut;
}

/** At most this many derived changes in a receipt (04-contract §5.4). */
export const DERIVED_SHOWN = 20;

/**
 * The first receipt's derived changes, from the derived writes in memory: the derived table by
 * its qualified name, the group key and the field by name. Changes of values only: a derived row
 * appearing or emptied whose fields besides the key are null on both sides gives no entry and is
 * not counted in `derived_total`, though it is a derived write (a replay counts those instead).
 */
export function withDerived(
  receipt: WriteReceipt,
  writes: readonly DerivedWrite[],
  compiled: CompiledSchema,
  slotName: string,
): WriteReceipt {
  const all: DerivedChange[] = [];
  for (const w of writes) {
    const t = compiled.tables.find((x) => x.id === w.target.table);
    if (t === undefined || t.kind !== "derived") continue;
    const nameOf = (id: string) => t.fields.find((f) => f.id === id)?.name ?? id;
    const keyIds = t.rule.scope.kind === "tenant" ? [] : t.rule.scope.key;
    const key: Record<string, ValueOut> = Object.create(null);
    keyIds.forEach((id, i) => {
      key[nameOf(id)] = valueOut(w.groupKey[i] ?? null);
    });
    for (const c of w.changes) {
      // The group key's fields are the row's key, given in `key`: not a change of their own.
      if (keyIds.includes(c.field)) continue;
      all.push({
        table: qualifiedTable(slotName, t),
        key,
        field: nameOf(c.field),
        before: valueOut(c.before),
        after: valueOut(c.after),
      });
    }
  }
  return { ...receipt, derived: all.slice(0, DERIVED_SHOWN), derived_total: all.length };
}

/** Where a fallback `ver` / `sv` came from (04-contract-types §7 `FallbackOrigin`). */
export type FallbackOrigin = { readonly read: ReadId } | { readonly from_write: number };

/** A warning of the receipt: normalization's, or a `ver` / `sv` taken by fallback (04-contract §2). */
export type ReceiptWarning =
  | WriteWarning
  | ({ readonly code: "ver_fallback"; readonly op: number; readonly ver: string } & FallbackOrigin)
  | ({ readonly code: "sv_fallback"; readonly sv: number } & FallbackOrigin);

export interface WriteReceipt {
  readonly status: "saved" | "pending";
  readonly sv: number;
  readonly seq: OpNumber;
  readonly ops: readonly OpReceipt[];
  /** The derived values this write changed, at most 20 (first receipt only; a replay gives none). */
  readonly derived: readonly DerivedChange[];
  /**
   * First receipt: the number of derived field changes. Replay: the number of the operation's
   * derived writes (the log keeps no values before or after).
   */
  readonly derived_total: number;
  readonly pending: readonly PendingRef[];
  readonly superseded: readonly {
    readonly item: ItemId;
    readonly type: (typeof EVENT_ITEM_TYPES)[number];
    readonly reason: SupersededReason;
  }[];
  readonly replayed?: true;
  /** A replay's parts the log cannot give back (04-contract §14 «重放返回什么»). */
  readonly omitted?: readonly ("existing_keys" | "derived_values")[];
  readonly warnings?: readonly ReceiptWarning[];
}

type Span = { readonly from: string | null; readonly to: string | null };
const spanIn = (v: { from?: string; to?: string } | undefined): Span => ({
  from: v?.from ?? null,
  to: v?.to ?? null,
});
const overlaps = (a: Span, b: Span) =>
  (a.to === null || b.from === null || b.from < a.to) &&
  (b.to === null || a.from === null || a.from < b.to);

/** The day before a date (`YYYY-MM-DD`). */
const dayBefore = (d: string): DateStr =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) as DateStr;

/** A table as receipts and errors name it: `slot.table`, never the bare name another slot may share. */
export const qualifiedTable = (slot: string, table: { readonly name: string }): string =>
  `${slot}.${table.name}`;

/** A span as the contract's interval: `valid_to_inclusive` on date tables with an end. */
export function intervalOut(v: Span, byDate: boolean): Interval {
  return {
    valid_from: v.from,
    valid_to: v.to,
    ...(byDate && v.to !== null ? { valid_to_inclusive: dayBefore(v.to) } : {}),
  };
}

/** The item version as callers see it (04-contract `item_ver`); the pending details write the same. */
export { itemVer };

/** The actors of operations. */
async function actorsOf(tx: ReadTx, ops: readonly number[]): Promise<Map<number, string>> {
  if (ops.length === 0) return new Map();
  const r = await tx.query<{ seq: unknown; actor: string }>(
    "SELECT seq, actor FROM events WHERE seq = ANY($1)",
    [ops] as never,
  );
  return new Map(r.rows.map((x) => [Number(x.seq), x.actor]));
}

/** The events of operation `op`, with their blocks. */
async function operationEvents(tx: ReadTx, op: OpNumber): Promise<StoredEvent[]> {
  const evs = await tx.query<{ seq: unknown; type: string; op: unknown }>(
    "SELECT seq, type, op FROM events WHERE op = $1 ORDER BY seq",
    [op],
  );
  const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    "SELECT c.seq, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq WHERE e.op = $1 AND c.body IS NOT NULL",
    [op],
  );
  const by = new Map<number, Record<string, unknown>>();
  for (const b of blocks.rows) {
    const m = by.get(Number(b.seq)) ?? Object.create(null);
    m[b.path] = JSON.parse(b.body as string);
    by.set(Number(b.seq), m);
  }
  return evs.rows.map((e) => ({
    header: { type: e.type, seq: Number(e.seq), op: Number(e.op) },
    blocks: by.get(Number(e.seq)) ?? {},
  }));
}

/**
 * Who gave what a candidate met (04-contract-types `FieldResult.by`), as the item's details say it
 * (../pending/cells.ts), from the cells as this request left them: stretch by stretch over
 * the candidate's part, the latest giver; with the value it gave the target field (none: the
 * stretch is a revoke's hole or without a value, or the target is the row's existence). Undefined
 * when no stretch of the part had a giver (never written there).
 */
async function givenBy(
  tx: ReadTx,
  table: CompiledBaseTable,
  cells: readonly RowCell[],
  unit: readonly string[],
  part: Span | undefined,
  target: string,
): Promise<{ readonly op: OpNumber; readonly value: FieldValue } | undefined> {
  const pieces = part !== undefined ? piecesOver(table, cells, [part], unit) : [rowOf(cells, unit)];
  const giver = latestGiver(pieces);
  if (giver === undefined) return undefined;
  const op = opOfCell(giver) as OpNumber;
  const piece = pieces.find((p) => p.giver === giver);
  const cell =
    piece === undefined || piece.revoked || piece.noValue || target === "existence"
      ? undefined
      : piece.cells.find((c) => c.field_id === target);
  if (cell === undefined || cell.src_event === null || cell.src_field === null) {
    return { op, value: null };
  }
  // The value the cell's contribution gave, as the log has it.
  const r = await tx.query<{ body: string | null }>(
    "SELECT body FROM content WHERE seq = $1 AND path = $2",
    [Number(cell.src_event), `fields/${cell.src_field}/${cell.src_k ?? 0}`],
  );
  const body = r.rows[0]?.body;
  const value = body == null ? null : ((JSON.parse(body) as { value?: FieldValue }).value ?? null);
  return { op, value };
}

/** The row's version (01-objects «版本标记») as of operation `op`. */
async function verAsOf(
  tx: ReadTx,
  table: CompiledBaseTable,
  row: string,
  op: OpNumber,
  restoreCount: number,
): Promise<string | undefined> {
  const r = await tx.query<{ v: unknown }>(
    `SELECT max(rec_from) AS v FROM "${table.physical.table}__ver"
     WHERE row_id = $1 AND rec_from <= $2 AND intent <> 'schema_switch'`,
    [row, op],
  );
  const v = r.rows[0]?.v;
  return v === null || v === undefined ? undefined : `v${Number(v)}.${restoreCount}`;
}

/** The operation numbers of events, and the actors of operations. */
async function opsOf(tx: ReadTx, seqs: readonly number[]): Promise<Map<number, number>> {
  if (seqs.length === 0) return new Map();
  const r = await tx.query<{ seq: unknown; op: unknown }>(
    "SELECT seq, op FROM events WHERE seq = ANY($1)",
    [seqs] as never,
  );
  return new Map(r.rows.map((x) => [Number(x.seq), Number(x.op)]));
}

/**
 * The receipt of operation `op` (a write's head event), from the log. Undefined when the head
 * event's content is no longer there (deleted with the write's evidence).
 */
export async function readReceipt(
  tx: ReadTx,
  op: OpNumber,
  o: {
    readonly compiled: CompiledSchema;
    readonly slotName: string;
    readonly restoreCount: number;
    readonly replayed: boolean;
  },
): Promise<WriteReceipt | undefined> {
  const events = await operationEvents(tx, op);
  const bases = events.filter((e) => e.header.type === "write.base");
  const derivedWritten = events.filter((e) => e.header.type === "write.derived").length;
  // A write request, or a decision on a pending item and the write it triggers (09 §5.8
  // `item.resolved`): the op's target is then its `write.base`'s, in the head's place.
  const resolved = events[0]?.header.type === "item.resolved";
  const head = (resolved ? {} : events.find((e) => e.header.type === "write.head")?.blocks) as
    | Blocks
    | undefined;
  const firstBase = bases[0]?.blocks["target"] as { sv: number } | undefined;
  const request = (
    resolved
      ? firstBase !== undefined
        ? { sv: firstBase.sv, op_count: bases.length }
        : undefined
      : head?.["request"]
  ) as { sv: number; op_count: number } | undefined;
  if (head === undefined || request === undefined) return undefined;
  const tableOf = (id: string) =>
    o.compiled.tables.find((t) => t.id === id && t.kind === "base") as CompiledBaseTable;
  const itemEvents = events.filter(
    (e) => e.header.type === "item.created" || e.header.type === "item.merged",
  );
  const settled = events.filter(
    (e) => e.header.type === "item.refreshed" || e.header.type === "item.superseded",
  );
  const itemIds = [
    ...new Set(itemEvents.map((e) => (e.blocks["target"] as { item: string }).item)),
  ];
  // The items' entries as of this operation, read as the pending details read them.
  const entries = await itemEntries(tx, itemIds, op);
  // Every principal the receipt names, as of this operation (04-contract-types §1.6): the same
  // whether the write answers now or a replay rebuilds its receipt later.
  const who = new Map<string, Actor>();
  const named = async (principals: Iterable<string>) => {
    const missing = [...new Set(principals)].filter((p) => !who.has(p));
    for (const [p, a] of await actorsAsOf(tx, missing, op)) who.set(p, a);
  };
  const actorOut = (p: string): Actor => who.get(p) ?? { kind: "user", id: p, name: p };
  await named([...entries.values()].flatMap((x) => [...x.actorOfOp.values()]));
  // The writers of what may be a candidate's `by` (read below, from the row as judged).
  const actors = new Map<number, string>();
  // Which pending item each candidate or awaiting part went to.
  const itemOf = new Map<string, ItemId>();
  for (const e of itemEvents) {
    const t = e.blocks["target"] as { item: ItemId; type?: string; origin_event: number };
    for (const [p, c] of Object.entries(e.blocks)) {
      if (!p.startsWith("candidates/")) continue;
      const cand = c as {
        event: number;
        items: { field?: string; k?: number; existence?: number }[];
      };
      for (const y of cand.items) {
        itemOf.set(`${cand.event}/${y.field ?? "existence"}/${y.k ?? y.existence ?? 0}`, t.item);
      }
    }
    if (t.type === "awaiting_confirmation") itemOf.set(`${t.origin_event}/awaiting`, t.item);
  }

  const later = bases.flatMap((b) => {
    const rv = b.blocks["revert"] as { items: { event: number; later?: true }[] } | undefined;
    return (rv?.items ?? []).filter((x) => x.later).map((x) => x.event);
  });
  const opOfEvent = await opsOf(tx, later);

  let pendingStatus = false;
  let keysLeftOut = false;
  const ops: OpReceipt[] = [];
  for (let i = 0; i < request.op_count; i++) {
    const t = (resolved ? bases[i]?.blocks["target"] : head[`ops/${i}/target`]) as {
      table: string;
      row?: string;
      entity?: string;
      intent: Intent;
      ver?: { op: number };
      by_entity_key?: true;
      created?: true;
    };
    if (t.by_entity_key && t.created) keysLeftOut = true;
    const table = tableOf(t.table);
    const isState = table.time.type === "state";
    const byDate = table.time.type === "state" && table.time.granularity === "date";
    const iv = (v: Span) => intervalOut(v, byDate);
    const name = (f: string) => table.fields.find((x) => x.id === f)?.name ?? f;
    const rowId = (t.row ?? t.entity) as string;
    const base = resolved
      ? bases[i]
      : bases.find((b) => (b.blocks["target"] as { op_index: number }).op_index === i);
    // By field name, built as entries: a name like `__proto__` stays a key of its own.
    const fields = new Map<string, FieldResult | StatePart[]>();
    const rowVer = await verAsOf(tx, table, rowId, op, o.restoreCount);
    // The row's cells as this request left them, for who gave what a candidate met (as the item's
    // details read them, ../pending/cells.ts; the same moment as `effective`, `current_ver` and the
    // item's contents, 01-objects «不过期»): read once, and only when the op has a candidate.
    const before =
      base !== undefined &&
      Object.values(base.blocks).some((b) => (b as { status?: string })?.status === "candidate")
        ? await rowCellsAt(tx, table, rowId, op)
        : undefined;

    /** How the receipt writes field names, intervals and actors (as the pending details do). */
    const naming: Naming<Actor> = {
      field: name,
      interval: (v) => iv(v) as unknown as Record<string, unknown>,
      actor: actorOut,
      value: valueOut,
      isState,
    };
    /** What carrying out an item would change, from (some of) its impact entries. */
    const impactOf = (x: ItemEntries, blocks: readonly Blocks[]): Impact =>
      impactOut(x, naming, blocks) as unknown as Impact;

    /** A candidate's or awaiting part's details, from its item's latest entries (09 §5.8). */
    const itemDetails = async (
      item: string,
      status: string,
      target: string,
      event: number,
      part: Span,
    ): Promise<Partial<PartDraft>> => {
      const x = entries.get(item);
      if (x === undefined) return {};
      const on = (b: Blocks) =>
        !isState || b["valid"] === undefined || overlaps(spanIn(b["valid"] as never), part);
      if (status !== "candidate") return { impact: impactOf(x, x.impact) };
      // On the unit "existence" the entries say where the row has a value; on fields, the values.
      const onExistence =
        x.current.some((b) => b["field"] === "existence") ||
        x.previous.some((b) => b["field"] === "existence");
      const prev = x.previous.filter((b) => on(b));
      // Who gave what the candidate met, and its value (not the entries' deps, which also hold what
      // cut a stretch's ends, the candidate itself among them).
      const given =
        before === undefined
          ? undefined
          : await givenBy(tx, table, before, x.unit, isState ? part : undefined, target);
      const top = given?.op;
      if (top !== undefined && !actors.has(top)) {
        for (const [n, a] of await actorsOf(tx, [top])) actors.set(n, a);
        await named(actors.values());
      }
      const exists = (bs: readonly Blocks[]) =>
        onExistence
          ? bs.some((b) => b["field"] === "existence" && b["revoked"] !== true)
          : isState
            ? bs.some((b) => b["value"] !== null && b["value"] !== undefined)
            : true;
      const impact = impactOf(x, candidateImpactBlocks(x, event));
      return {
        // The target field's value on the `by` stretch (none when it has no value, `by` is a
        // revoke, or the target is existence); the whole picture is the item's ConflictDetail.
        effective: valueOut(given?.value ?? null),
        ...(rowVer !== undefined ? { current_ver: rowVer } : {}),
        ...(top !== undefined ? { by: { seq: top, actor: actorOut(actors.get(top) ?? "") } } : {}),
        ...(x.mergeBase !== undefined
          ? {
              previous:
                isState && !onExistence
                  ? {
                      seq: x.mergeBase,
                      exists: exists(prev),
                      spans: prev
                        .filter((b) => b["field"] === target)
                        .map((b) => ({
                          ...iv(spanIn(b["valid"] as never)),
                          values:
                            b["value"] === null
                              ? null
                              : Object.fromEntries([
                                  [name(target), valueOut(b["value"] as FieldValue)],
                                ]),
                        })),
                    }
                  : onExistence
                    ? { seq: x.mergeBase, exists: exists(prev) }
                    : {
                        seq: x.mergeBase,
                        exists: true,
                        values: Object.fromEntries(
                          prev.map((b) => [
                            name(b["field"] as string),
                            valueOut(b["value"] as FieldValue),
                          ]),
                        ),
                      },
            }
          : {}),
        ...(Object.keys(impact).length > 0 ? { impact } : {}),
      };
    };
    const add = (key: string, d: PartDraft) => {
      const r = fieldResult(d, isState);
      if (r.result === "candidate" || r.result === "awaiting") pendingStatus = true;
      if (!isState) {
        fields.set(key, r);
        return;
      }
      const prev = fields.get(key);
      fields.set(key, [...(Array.isArray(prev) ? (prev as StatePart[]) : []), r as StatePart]);
    };
    if (base !== undefined) {
      const b = base.blocks;
      const event = base.header.seq;
      const paths = Object.keys(b).sort();
      for (const p of paths) {
        const m = /^fields\/(f\d+)\/(\d+)$/.exec(p);
        const ex = /^existence\/(\d+)$/.exec(p);
        if (m === null && ex === null) continue;
        const block = b[p] as {
          status: FieldResultCode;
          value?: FieldValue;
          no_value?: true;
          uncovered?: true;
          /** An existence item: `whole` has no span (09 §5.7). */
          scope?: "whole" | "interval";
        };
        const target = m !== null ? (m[1] as string) : "existence";
        const k = Number(m !== null ? m[2] : (ex as RegExpExecArray)[1]);
        const span = b[`span/${target}/${k}`] as
          | { valid?: { from: string; to?: string }; seen_valid?: { from: string; to?: string } }
          | undefined;
        const at = span?.valid ?? span?.seen_valid;
        const item =
          block.status === "candidate"
            ? itemOf.get(`${event}/${target}/${k}`)
            : block.status === "awaiting"
              ? itemOf.get(`${event}/awaiting`)
              : undefined;
        const part: Span = isState ? spanIn(at) : { from: null, to: null };
        const details =
          item === undefined ? {} : await itemDetails(item, block.status, target, event, part);
        add(m !== null ? name(target) : "*", {
          result: block.status,
          ...("value" in block ? { after: valueOut(block.value as FieldValue) } : {}),
          ...(block.no_value ? { no_value: true as const } : {}),
          ...(block.uncovered ? { uncovered: true as const } : {}),
          ...(item !== undefined ? { item } : {}),
          ...details,
          // State tables: each part's interval. A revoke of the whole entity has no span: its part
          // is the whole time (04-contract-types §1.3 `Interval`, both ends null); any other part
          // without one is left without, and refused as such above.
          ...(isState && (at !== undefined || block.scope === "whole")
            ? { valid: iv(spanIn(at)) }
            : {}),
        });
      }
    }
    // A state table gives each field as an array of parts (04-contract-types §5.1 `fields`).
    for (const f of (head[`ops/${i}/noop`] ?? []) as string[]) {
      fields.set(name(f), isState ? [{ result: "noop" }] : { result: "noop" });
    }
    const revert = head[`ops/${i}/revert`] as { undo_op: number } | undefined;
    let undo: OpReceipt["undo"];
    if (revert !== undefined) {
      const rv = (base?.blocks["revert"] ?? { items: [] }) as {
        items: { event: number; field?: string; later?: true }[];
        skipped?: { field?: string; by_op: number }[];
      };
      const byOp = new Map<number, Set<string>>();
      for (const x of rv.items.filter((y) => y.later)) {
        const n = opOfEvent.get(x.event) ?? x.event;
        const s = byOp.get(n) ?? new Set<string>();
        s.add(x.field !== undefined ? name(x.field) : "*");
        byOp.set(n, s);
      }
      const skipped = rv.skipped ?? [];
      const undoActors = await actorsOf(tx, [...skipped.map((s) => s.by_op), ...byOp.keys()]);
      await named(undoActors.values());
      const actorOfOp = (n: number) => actorOut(undoActors.get(n) ?? "");
      undo = {
        of: revert.undo_op,
        skipped_superseded: skipped.map((s) => ({
          field: s.field !== undefined ? name(s.field) : "*",
          by: s.by_op,
          actor: actorOfOp(s.by_op),
        })),
        ...(byOp.size > 0
          ? {
              reverted_later: [...byOp].map(([seq, fs]) => ({
                seq,
                actor: actorOfOp(seq),
                fields: [...fs].sort(),
              })),
            }
          : {}),
      };
    }
    const created = (base?.blocks["target"] as { created?: true } | undefined)?.created === true;
    const ver = rowVer;
    // The key of an entity located or created by key, from the event that created it.
    const key = t.by_entity_key ? await keyOf(tx, table, rowId as EntityId) : undefined;
    ops.push({
      target: {
        table: qualifiedTable(o.slotName, table),
        ...(isState ? { entity: rowId as EntityId } : { row: rowId as RowId }),
        ...(key !== undefined
          ? {
              entity_key: Object.fromEntries(
                keyFields(table).map((f) => [f.name, valueOut(key[f.id] ?? null)]),
              ),
            }
          : {}),
      },
      intent: t.intent,
      ...(ver !== undefined ? { ver } : {}),
      ...(created && isState ? { created_entity: true as const } : {}),
      fields: Object.fromEntries(fields),
      ...(undo !== undefined ? { undo } : {}),
    });
  }

  // The pending items: each once, opened (with its version), joined, refreshed, or superseded.
  const touched = [
    ...new Set(
      [...itemEvents, ...settled].map((e) => (e.blocks["target"] as { item: string }).item),
    ),
  ];
  const info = new Map<
    string,
    {
      state: NonNullable<PendingRef["state"]>;
      decision: NonNullable<PendingRef["decision"]> | null;
      type: PendingRef["type"];
      reason: PendingRef["reason"] | null;
    }
  >();
  if (touched.length > 0) {
    const r = await tx.query<{
      id: ItemId;
      state: NonNullable<PendingRef["state"]>;
      decision: NonNullable<PendingRef["decision"]> | null;
      type: PendingRef["type"];
      reason: PendingRef["reason"] | null;
    }>(
      `SELECT p.id, p.state, p.decision, p.type,
         (SELECT c.body::jsonb ->> 'reason' FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
          WHERE e.type = 'item.created' AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = p.id LIMIT 1) AS reason
       FROM pending_items p WHERE p.id = ANY($1)`,
      [touched] as never,
    );
    for (const x of r.rows) info.set(x.id, x);
  }
  const pending: PendingRef[] = [];
  const superseded: WriteReceipt["superseded"][number][] = [];
  for (const id of touched as ItemId[]) {
    const x = info.get(id);
    const mine = [...itemEvents, ...settled].filter(
      (e) => (e.blocks["target"] as { item: string }).item === id,
    );
    const kinds = new Set(mine.map((e) => e.header.type));
    const gone = mine.find((e) => e.header.type === "item.superseded");
    if (gone !== undefined) {
      superseded.push({
        item: id,
        type: x?.type ?? "conflict",
        reason: (gone.blocks["target"] as { reason?: SupersededReason }).reason ?? "overwritten",
      });
      continue;
    }
    pending.push({
      id,
      type: x?.type ?? "conflict",
      reason: x?.reason ?? "stale_write",
      ...(kinds.has("item.created") && !o.replayed
        ? { item_ver: itemVer(id, op, o.restoreCount) }
        : {}),
      // Opened by this write, its contents are given whole as of the request's end: not a join.
      ...(kinds.has("item.merged") && !kinds.has("item.created") ? { merged: true as const } : {}),
      ...(kinds.has("item.refreshed") ? { refreshed: true as const } : {}),
      ...(o.replayed && x !== undefined
        ? { state: x.state, ...(x.decision !== null ? { decision: x.decision } : {}) }
        : {}),
    });
  }

  return {
    status: pendingStatus ? "pending" : "saved",
    sv: request.sv,
    seq: op,
    ops,
    derived: [],
    // A replay counts the derived writes; a first receipt's are filled in by the caller.
    derived_total: derivedWritten,
    pending,
    superseded,
    ...(o.replayed ? { replayed: true as const } : {}),
    ...(o.replayed && (keysLeftOut || derivedWritten > 0)
      ? {
          omitted: [
            ...(keysLeftOut ? ["existing_keys" as const] : []),
            ...(derivedWritten > 0 ? ["derived_values" as const] : []),
          ],
        }
      : {}),
  };
}
