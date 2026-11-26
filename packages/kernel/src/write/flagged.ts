// Flagged items as later writes change their rows (03-data-model/01-objects «不过期», the `flagged`
// exception; 04-write-and-read «疑似重复»; 09 §5.8 `item.superseded` / `item.refreshed` with
// `matched_changed`). At the end of a request (or of a decision that writes), every open flagged
// item whose flagged row, or one of whose listed rows, the operation wrote is judged again, as the
// operation leaves them:
//
// - the flagged row revoked, or no listed row matching it any more → `item.superseded`;
// - some listed rows no longer matching → `item.refreshed` (`matched_changed`), the rows still
//   matching given whole (`matched/<k>`, renumbered from 0, in the order they were listed);
// - every listed row still matching, but some now matching by values other contributions give →
//   `item.refreshed` (`entries_changed`), the rows given whole with their new `deps`: a later
//   deletion of the new contributions' sources must find the entries;
// - every listed row still matching on the same contributions → nothing: a field outside the key
//   groups changed, or a key field changed to a value still the same.
//
// "Matching" is on any of the table's key groups (04-write-and-read «怎么算命中»: any group
// matching is a match), the group the item was flagged on first; `duplicate.keys` stays the group
// it matched on when flagged. `by_event` is the `write.base` of the last op of the operation that
// changed what the item would say (09 §5.8), op by op: a write of another field of the rows in a
// later op does not count.
//
// Whether a writer read the item does not count (flagged items have no candidates to lose). Rows
// newly alike are not added: the item lists what matched when the row was created. A flagged item
// this very request opens is given its entries as the request ends; one with no row matching by
// then is not opened at all (`unopened`: the caller judges the request again without it).
//
// A deletion's side (P3): when a deletion leaves a flagged row or a listed row without its
// contributions, the same judgement applies to the state after the deletion (`stillMatching` with
// rows as the deletion leaves them); the replay calls it then. Not here.

import type {
  CompiledBaseTable,
  FieldId,
  FieldValue,
  ItemId,
  OpNumber,
  RowId,
  Seq,
  SlotId,
} from "@fluxvita/saveslot-contract-core";
import { type Limit, type RowState, stateFromRecord } from "../judge/index.ts";
import type { NewEvent } from "../log/index.ts";
import { itemEntries } from "../pending/index.ts";
import type { Tx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
import { restoreHistory } from "../store/restore-point.ts";
import { type DuplicateDep, duplicateKeysOf, matchesGroup, valuesOf } from "./duplicates.ts";
import { tableShape } from "./plan.ts";
import { rowEvents } from "./reads.ts";
import { decodeRecords } from "./record.ts";

/** A row the operation wrote, as the operation leaves it. */
export interface WrittenRow {
  readonly table: string;
  readonly row: RowId;
  readonly state: RowState;
  /** The operation's last `write.base` on the row. */
  readonly lastBase: Seq;
  /** Each `write.base` of the operation on the row, by the index of its op. */
  readonly bases: readonly { readonly index: number; readonly seq: Seq }[];
}

/**
 * A flagged item the operation itself opens: its `item.created` blocks, still to be appended, are
 * given the rows matching as the operation ends (09 §5.8: an item's entries are the request's end
 * state), in place; none left, or its row revoked, it is not opened (`unopened`).
 */
export interface OpenedFlagged {
  /** The op that opens it. */
  readonly index: number;
  readonly item: ItemId;
  readonly table: string;
  readonly row: RowId;
  readonly keys: readonly FieldId[];
  readonly listed: readonly RowId[];
  /** The `item.created` blocks, changed in place. */
  readonly blocks: Record<string, unknown>;
}

/** One flagged item judged again: the rows of its list still matching, or none. */
export interface Rejudged {
  readonly item: ItemId;
  /** The flagged row revoked: superseded whatever its list. */
  readonly revoked: boolean;
  readonly listed: readonly RowId[];
  readonly still: readonly { readonly row: RowId; readonly deps: readonly DuplicateDep[] }[];
}

type Values = ReadonlyMap<FieldId, { value: FieldValue; dep: DuplicateDep }>;

/**
 * Which listed rows still match the flagged row: on any of the key groups (`groups`, the group the
 * item was flagged on first), each row's `deps` those of the first group it matches on. Pure,
 * given each row's values on the groups' fields (undefined for a row revoked).
 */
export function stillMatching(
  groups: readonly (readonly FieldId[])[],
  flagged: Values | undefined,
  listed: readonly { readonly row: RowId; readonly values: Values | undefined }[],
): { revoked: boolean; still: { row: RowId; deps: DuplicateDep[] }[] } {
  if (flagged === undefined) return { revoked: true, still: [] };
  const mine = new Map([...flagged].map(([f, x]) => [f, x.value]));
  const still = listed.flatMap((r) => {
    if (r.values === undefined) return [];
    const theirs = new Map([...r.values].map(([f, x]) => [f, x.value]));
    const group = groups.find((g) => matchesGroup(g, mine, theirs));
    return group === undefined
      ? []
      : [{ row: r.row, deps: group.flatMap((f) => r.values?.get(f)?.dep ?? []) }];
  });
  return { revoked: false, still };
}

/** The key groups to judge an item on: the one it was flagged on, then the table's others. */
const groupsFor = (table: CompiledBaseTable, flaggedOn: readonly FieldId[]) => [
  flaggedOn,
  ...duplicateKeysOf(table).filter((g) => g.join(",") !== flaggedOn.join(",")),
];

/**
 * The item events the operation's writes bring to open flagged items (see the file's head), in
 * the order of the items' IDs, and the ops whose flagged item is not to be opened. `written`: the
 * rows the operation wrote; `boundary(i)`: the state just before op `i` (`boundary(opCount)` the
 * operation's end); `except`: an item the operation itself closes (a decision on it).
 */
export async function settleFlagged(
  tx: Tx,
  input: {
    readonly slot: SlotId;
    readonly tableOf: (id: string) => CompiledBaseTable | undefined;
    readonly written: readonly WrittenRow[];
    readonly op: OpNumber;
    readonly opCount: number;
    readonly boundary: (i: number) => Limit;
    readonly except?: ItemId;
    readonly opened?: readonly OpenedFlagged[];
  },
): Promise<{ events: NewEvent[]; unopened: number[] }> {
  const written = input.written.filter((w) => {
    const t = input.tableOf(w.table);
    return t !== undefined && duplicateKeysOf(t).length > 0;
  });
  const opened = input.opened ?? [];
  const none = { events: [], unopened: [] };
  if (written.length === 0 && opened.length === 0) return none;
  const byRow = new Map(written.map((w) => [w.row as string, w]));
  const ids = [...byRow.keys()];
  const r = await tx.query<{ id: string }>(
    `SELECT p.id FROM pending_items p
     WHERE p.state = 'open' AND p.type = 'flagged'
       AND (p.target_row = ANY($1) OR EXISTS (
         SELECT 1 FROM pending_entries e
         JOIN ${READABLE_CONTENT} c ON c.seq = e.content_seq AND c.path = e.content_path
         WHERE e.item_id = p.id AND e.content_path LIKE 'matched/%' AND c.body IS NOT NULL
           AND (c.body::jsonb ->> 'row') = ANY($1)))
     ORDER BY p.id`,
    [ids] as never,
  );
  const items = r.rows.map((x) => x.id).filter((id) => id !== input.except);
  if (items.length === 0 && opened.length === 0) return none;
  const entries = await itemEntries(tx, items);
  const restores = await restoreHistory(tx);
  const before: Limit = { upTo: (input.op - 1) as OpNumber };
  /** The log's state of a row the operation did not write, read once. */
  const logStates = new Map<string, RowState>();
  const logState = async (table: CompiledBaseTable, row: RowId) => {
    const known = logStates.get(row);
    if (known !== undefined) return known;
    const shape = tableShape(table);
    const ctx = { table: table.id, target: { row }, shape, granularity: "date", restores } as const;
    const state = stateFromRecord(
      shape,
      decodeRecords(ctx as never, await rowEvents(tx, table.id, row)),
    );
    logStates.set(row, state);
    return state;
  };
  /**
   * What an item would say just before op `i` (`opCount`: at the end): a row the operation wrote
   * as it then stood, any other as the log has it.
   */
  const judgeAt = async (
    table: CompiledBaseTable,
    groups: readonly (readonly FieldId[])[],
    row: RowId,
    listed: readonly RowId[],
    i: number,
  ) => {
    const fields = [...new Set(groups.flat())];
    const valuesAt = async (x: RowId) => {
      const w = byRow.get(x);
      return w !== undefined
        ? valuesOf(w.state, fields, input.boundary(i))
        : valuesOf(await logState(table, x), fields, before);
    };
    const own = await valuesAt(row);
    const values = await Promise.all(
      listed.map(async (x) => ({ row: x, values: await valuesAt(x) })),
    );
    return stillMatching(groups, own, values);
  };
  const said = (j: { revoked: boolean; still: readonly { row: RowId; deps: unknown }[] }) =>
    JSON.stringify(j);
  /**
   * The `write.base` of the last op that changed what the item says (09 §5.8 `by_event`): op by
   * op over the ops that wrote one of its rows.
   */
  const lastChange = async (
    table: CompiledBaseTable,
    groups: readonly (readonly FieldId[])[],
    row: RowId,
    listed: readonly RowId[],
  ): Promise<Seq> => {
    const rows = [row, ...listed];
    const ops = new Map<number, Seq>();
    for (const x of rows) {
      for (const b of byRow.get(x)?.bases ?? []) {
        ops.set(b.index, Math.max(ops.get(b.index) ?? 0, b.seq) as Seq);
      }
    }
    const order = [...ops.keys()].sort((a, b) => a - b);
    let last: Seq | undefined;
    let was = said(await judgeAt(table, groups, row, listed, order[0] ?? 0));
    for (const i of order) {
      const now = said(await judgeAt(table, groups, row, listed, i + 1));
      if (now !== was) last = ops.get(i);
      was = now;
    }
    if (last === undefined) throw new Error("a flagged item judged changed with no op changing it");
    return last;
  };

  const out: NewEvent[] = [];
  const unopened: number[] = [];
  // Items opened by this operation: their matched rows as it ends, in place; none left, not opened.
  for (const o of opened) {
    const table = input.tableOf(o.table);
    if (table === undefined) continue;
    const judged = await judgeAt(table, groupsFor(table, o.keys), o.row, o.listed, input.opCount);
    if (judged.revoked || judged.still.length === 0) {
      unopened.push(o.index);
      continue;
    }
    for (const p of Object.keys(o.blocks)) if (p.startsWith("matched/")) delete o.blocks[p];
    judged.still.forEach((x, k) => {
      o.blocks[`matched/${k}`] = { row: x.row, deps: [...x.deps] };
    });
  }
  for (const id of items) {
    const e = entries.get(id);
    if (e === undefined || e.table === null || e.row === null) continue;
    const table = input.tableOf(e.table);
    if (table === undefined) continue;
    const keys = await keysOf(tx, e.originEvent);
    // The key group cleared by a deletion: nothing to judge it on here (P3).
    if (keys === undefined) continue;
    const groups = groupsFor(table, keys);
    const listed = e.matched.map((b) => b["row"] as RowId);
    const judged = await judgeAt(table, groups, e.row as RowId, listed, input.opCount);
    const given = (x: { row: RowId; deps: readonly DuplicateDep[] }) => ({
      row: x.row,
      deps: [...x.deps],
    });
    const same =
      !judged.revoked &&
      judged.still.length === listed.length &&
      said({ revoked: false, still: judged.still.map(given) }) ===
        said({
          revoked: false,
          still: e.matched.map((b) => ({
            row: b["row"] as RowId,
            deps: (b["deps"] ?? []) as DuplicateDep[],
          })),
        });
    if (same) continue;
    const by = await lastChange(table, groups, e.row as RowId, listed);
    if (judged.revoked || judged.still.length === 0) {
      out.push({
        type: "item.superseded",
        slot: input.slot,
        blocks: { target: { item: id, reason: "matched_changed", by_event: by } } as never,
      });
      continue;
    }
    const cause = judged.still.length < listed.length ? "matched_changed" : "entries_changed";
    out.push({
      type: "item.refreshed",
      slot: input.slot,
      blocks: {
        target: { item: id, cause, by_event: by },
        ...Object.fromEntries(judged.still.map((x, k) => [`matched/${k}`, given(x)])),
      } as never,
    });
  }
  return { events: out, unopened };
}

/** The key group of a flagged item: its write's `duplicate.keys`; undefined once cleared. */
async function keysOf(tx: Tx, origin: number | undefined): Promise<FieldId[] | undefined> {
  if (origin === undefined) return undefined;
  const r = await tx.query<{ body: string | null }>(
    `SELECT body FROM ${READABLE_CONTENT} c WHERE seq = $1 AND path = 'duplicate'`,
    [origin],
  );
  const body = r.rows[0]?.body;
  return typeof body === "string" ? (JSON.parse(body) as { keys: FieldId[] }).keys : undefined;
}
