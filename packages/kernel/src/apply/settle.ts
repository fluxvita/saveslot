// What a row or entity is, from every item registered on it (docs/zh-CN/spec/09-event-format.md
// §5.7 `write.base` apply; 03-data-model/03-deletion.md «重放规则»; 05-time «无值区间»).
//
// `settle` takes the row's items in effect (applied or corroborated, with their content, current
// interval and "reverted" registrations) and gives the business table rows and the version table
// cells of its current state. It is computed from all the items each time, not by changing the
// previous state step by step: what an `uncovered` write-back exposes, what a registration
// uncovers, several ops of one operation, all follow from the one rule below. Deletion replay
// needs the same "a row from all its items" function.
//
// The rule (the value of a field on a piece of the timeline): the last applied item covering the
// piece among the field's value and no-value items (and on a state table the revokes), not
// registered as reverted on the piece. A state table's entity has a value where every required
// field has one (any field when none is required). An event or timeless table's row is revoked
// when its last existence item in effect is a revoke, and otherwise exists when every required
// field has a value item in effect and some field a non-empty one.
//
// This is the third implementation of "which item is in effect at a point" (judge's row state and
// the reference evaluator are the others); `apply` does not depend on `judge`, so the repetition
// is deliberate, and property tests hold the three together.

import type { FieldId, FieldValue, Seq } from "@fluxvita/saveslot-contract-core";
import {
  canonical,
  cut,
  cutPoints,
  type Interval,
  type IntervalSet,
  meet,
  WHOLE,
  within,
} from "../time/index.ts";

export type SettleContent =
  | { readonly kind: "value"; readonly value: FieldValue }
  | { readonly kind: "no_value" }
  | { readonly kind: "uncovered" }
  | { readonly kind: "revoke" }
  | { readonly kind: "restore" };

/** "Reverted by operation `op` on `valid`" (09 §5.7 `revert`). */
export interface Registration {
  readonly op: Seq;
  readonly valid: IntervalSet;
}

/** An item in effect on the row, as the source table and its block give it. */
export interface SettleItem {
  /** The `write.base` event; items are ordered by it (the log order: operation, then op). */
  readonly event: Seq;
  readonly target: FieldId | "existence";
  readonly k: number;
  readonly status: "applied" | "corroborated";
  /** The current interval; `WHOLE` on event and timeless tables, and for a whole revoke. */
  readonly valid: IntervalSet;
  readonly content: SettleContent;
  readonly reverted: readonly Registration[];
}

export interface ItemKey {
  readonly event: Seq;
  readonly target: FieldId | "existence";
  readonly k: number;
}

/** What `settle` needs of the table's definition. */
export interface SettleTable {
  readonly kind: "state" | "event" | "timeless";
  readonly fields: readonly FieldId[];
  readonly required: readonly FieldId[];
}

/** A row of the business table: a segment of a state table's entity, or the row. */
export interface BusinessRow {
  /** State tables only. */
  readonly valid?: Interval;
  readonly revoked: boolean;
  readonly values: Readonly<Record<FieldId, FieldValue>>;
}

/** A cell of the version table, as of now: a field (or existence) on a business interval. */
export interface Cell {
  readonly field: FieldId | "existence";
  /** State tables only. */
  readonly valid?: Interval;
  readonly value: FieldValue;
  /** Existence cells: the row is revoked. */
  readonly revoked?: true;
  /**
   * State tables' field cells where the entity has no value: the no-value item that left the field
   * so. A field empty where the entity has a value (cleared, or never written) is not one.
   */
  readonly noValue?: true;
  /** The item giving it; none for an empty field the entity has no item on. */
  readonly by: ItemKey | null;
}

export interface Settled {
  readonly rows: readonly BusinessRow[];
  readonly cells: readonly Cell[];
}

const keyOf = (x: SettleItem): ItemKey => ({ event: x.event, target: x.target, k: x.k });
const registeredOn = (x: SettleItem, piece: Interval) =>
  x.reverted.some((r) => within(piece, r.valid));
const valueKey = (v: FieldValue) => JSON.stringify(v);

/**
 * The item a field takes its state from on a piece: a value or a no-value item, or on a state
 * table a revoke (on event and timeless tables a revoke changes only existence, 04-write-and-read:
 * the values stay on the row).
 */
function fieldItem(
  items: readonly SettleItem[],
  f: FieldId,
  piece: Interval,
  isState: boolean,
): SettleItem | undefined {
  let best: SettleItem | undefined;
  for (const x of items) {
    if (x.status !== "applied" || !within(piece, x.valid)) continue;
    const counts =
      (x.target === f && (x.content.kind === "value" || x.content.kind === "no_value")) ||
      (isState && x.content.kind === "revoke");
    if (!counts || registeredOn(x, piece)) continue;
    if (best === undefined || x.event > best.event) best = x;
  }
  return best;
}

export function settle(table: SettleTable, items: readonly SettleItem[]): Settled {
  return table.kind === "state" ? settleState(table, items) : settleRow(table, items);
}

/** Adds a state table's cell, running the field's last cell on when it touches and is the same. */
function pushCell(cells: Cell[], c: Cell & { valid: Interval }): void {
  const i = cells.findLastIndex((x) => x.field === c.field);
  const last = i < 0 ? undefined : cells[i];
  if (
    last?.valid !== undefined &&
    last.valid.to === c.valid.from &&
    valueKey(last.value) === valueKey(c.value) &&
    last.revoked === c.revoked &&
    last.noValue === c.noValue &&
    JSON.stringify(last.by) === JSON.stringify(c.by)
  ) {
    cells[i] = { ...last, valid: { from: last.valid.from, to: c.valid.to } };
  } else cells.push(c);
}

/**
 * A state table's entity. Where it has a value, a business row and a cell per field (a field
 * without a value: null, from the no-value item or revoke that empties it, or from nothing).
 * Where it has none, cells say why: a revoke emptying a field that decides it (a required field,
 * or any field when none is required) gives an `existence` cell marked revoked, where some field
 * item lies under it; a no-value item
 * emptying such a field gives that field a null cell. Other fields have no cells there (the
 * entity has no value there).
 */
function settleState(table: SettleTable, items: readonly SettleItem[]): Settled {
  const pieces = cut(
    cutPoints([
      ...items.map((x) => x.valid),
      ...items.flatMap((x) => x.reverted.map((r) => r.valid)),
    ]),
  );
  const rows: BusinessRow[] = [];
  const cells: Cell[] = [];
  for (const piece of pieces) {
    const governing = new Map(table.fields.map((f) => [f, fieldItem(items, f, piece, true)]));
    const valued = (f: FieldId) => governing.get(f)?.content.kind === "value";
    const has =
      table.required.length > 0 ? table.required.every(valued) : table.fields.some(valued);
    if (!has) {
      let revoke: SettleItem | undefined;
      for (const f of table.required.length > 0 ? table.required : table.fields) {
        const x = governing.get(f);
        if (x?.content.kind === "no_value")
          pushCell(cells, { field: f, valid: piece, value: null, noValue: true, by: keyOf(x) });
        if (x?.content.kind === "revoke" && (revoke === undefined || x.event > revoke.event))
          revoke = x;
      }
      // Only over a field item: a revoke reaching beyond everything the entity ever had leaves
      // nothing to say there (and a version cell needs a start).
      const underRevoke = items.some((x) => x.target !== "existence" && within(piece, x.valid));
      if (revoke !== undefined && underRevoke) {
        pushCell(cells, {
          field: "existence",
          valid: piece,
          value: null,
          revoked: true,
          by: keyOf(revoke),
        });
      }
      continue;
    }
    const values: Record<FieldId, FieldValue> = {};
    for (const f of table.fields) {
      const x = governing.get(f);
      const value = x?.content.kind === "value" ? x.content.value : null;
      values[f] = value;
      const by = x !== undefined && x.content.kind !== "revoke" ? keyOf(x) : null;
      pushCell(cells, { field: f, valid: piece, value, by });
    }
    // A business row runs on while every field's value stays the same.
    const last = rows.at(-1);
    if (
      last?.valid !== undefined &&
      last.valid.to === piece.from &&
      table.fields.every((f) => valueKey(last.values[f] ?? null) === valueKey(values[f] ?? null))
    ) {
      rows[rows.length - 1] = { ...last, valid: { from: last.valid.from, to: piece.to } };
    } else rows.push({ valid: piece, revoked: false, values });
  }
  return { rows, cells };
}

/**
 * An event or timeless table's row. Existence is the last existence item in effect not registered
 * as reverted (a revoke, or a restore taking one back): it gives an `existence` cell, marked
 * revoked for a revoke. A revoke changes only existence (04-write-and-read «已撤销的行仍占着它的
 * 键»; §5.7: the revoked mark of the business table): the field values and their cells stay as
 * they would be without it.
 */
function settleRow(table: SettleTable, items: readonly SettleItem[]): Settled {
  let existence: SettleItem | undefined;
  for (const x of items) {
    if (x.status !== "applied" || x.target !== "existence" || registeredOn(x, WHOLE)) continue;
    if (existence === undefined || x.event > existence.event) existence = x;
  }
  const revoked = existence?.content.kind === "revoke";
  const contributes = (f: FieldId, nonEmpty: boolean) =>
    items.some(
      (x) =>
        x.target === f && x.content.kind === "value" && (!nonEmpty || x.content.value !== null),
    );
  const exists =
    table.required.every((f) => contributes(f, false)) &&
    table.fields.some((f) => contributes(f, true));
  if (!exists && !revoked) return { rows: [], cells: [] };
  const values: Record<FieldId, FieldValue> = {};
  const cells: Cell[] = [];
  for (const f of table.fields) {
    const x = fieldItem(items, f, WHOLE, false);
    values[f] = x?.content.kind === "value" ? x.content.value : null;
    cells.push({ field: f, value: values[f] ?? null, by: x === undefined ? null : keyOf(x) });
  }
  if (existence !== undefined) {
    cells.push({
      field: "existence",
      value: null,
      ...(revoked ? { revoked: true as const } : {}),
      by: keyOf(existence),
    });
  }
  return { rows: [{ revoked, values }], cells };
}

// --- "reverted" registrations (09 §5.7 `revert`; 03-deletion «回掉的权威定义» steps 2, 3, 5) --------

/** Step 3, "x supersedes r": by the kinds of content only. */
export function supersedes(x: SettleItem, r: SettleItem): boolean {
  const xFillsValue = x.target !== "existence" && x.content.kind === "value";
  if (r.content.kind === "revoke") return x.content.kind === "restore" || xFillsValue;
  if (r.content.kind === "restore") return x.content.kind === "revoke";
  return (x.target === r.target && x.content.kind !== "uncovered") || x.content.kind === "revoke";
}

const etKey = (event: Seq, target: string) => `${event}/${target}`;

/**
 * The registrations a revert in effect makes, read from its blocks only: each item in effect of an
 * entry, on its interval ∩ the union of this event's write-backs on its target; an item of an
 * entry marked `later` only within D(x), the intervals of the undone operation's items in effect
 * (entries not marked `later`) it supersedes. Empty registrations are left out.
 */
export function registrations(
  items: readonly SettleItem[],
  entries: readonly { event: Seq; target: string; later?: true }[],
  writeBacks: readonly SettleItem[],
): { item: ItemKey; valid: IntervalSet }[] {
  const byKey = new Map(entries.map((e) => [etKey(e.event, e.target), e]));
  const inEffect = items.filter((x) => byKey.has(etKey(x.event, x.target)));
  const isLater = (x: SettleItem) => byKey.get(etKey(x.event, x.target))?.later === true;
  const out: { item: ItemKey; valid: IntervalSet }[] = [];
  for (const x of inEffect) {
    const t = canonical(writeBacks.filter((w) => w.target === x.target).flatMap((w) => w.valid));
    const domain = isLater(x)
      ? canonical(inEffect.filter((y) => !isLater(y) && supersedes(x, y)).flatMap((y) => y.valid))
      : [WHOLE];
    const valid = meet(meet(x.valid, t), domain);
    if (valid.length > 0) out.push({ item: keyOf(x), valid });
  }
  return out;
}
