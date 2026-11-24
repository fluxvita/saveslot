// Duplicate keys (docs/zh-CN/spec/03-data-model/04-write-and-read.md «疑似重复»; 09-event-format.md
// §5.7 `duplicate`): a row created and in effect is compared, once, with the table's other rows.
//
// - Which tables: event and timeless tables declaring `duplicate_keys` (one or more groups).
// - With what: the rows of the table now, not revoked, as in effect, the request's earlier ops
//   included. Candidates and proposals are not values in effect, so they are not compared.
// - A match: every field of a group the same value (10-types-and-units «同值判据»); a field empty
//   on either side matches nothing. The first group of the schema's order that matches is `keys`.
// - What is recorded: up to 10 matched rows, latest written first (the last operation in effect on
//   each), the row ID breaking ties; with the contributions in effect on the group's fields of
//   each (`deps`). Judged once, never again: replays read it from the log.
//
// Two sources of rows. The stored ones, by one query per group on the table's physical table
// (stored values are normalised: a quantity in the field's unit at its scale, so column equality is
// the same-value criterion; a `zoned_datetime` is its instant and its zone). And the rows the
// request's earlier ops wrote, whose stored state is still the request's start: for them the
// pipeline's own state of the row is read instead, never the stored row.
//
// Rows in a confirmed deletion are compared as it leaves them (04 «和谁比»): the apply of
// `deletion.confirmed` leaves the physical tables as they are after the deletion, so a row it takes
// away is not there to match, and a row it gives other values matches by those.

import type {
  CompiledBaseTable,
  FieldId,
  FieldValue,
  ItemId,
  OpNumber,
  RowId,
  Seq,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { sameValue } from "../delta/index.ts";
import type { Judgement, Limit, RowState } from "../judge/index.ts";
import type { Tx } from "../store/ports.ts";
import { WHOLE } from "../time/index.ts";

/** At most this many matched rows are recorded (09 §5.7 `duplicate`). */
export const MATCHED_MAX = 10;

/** A contribution a match rests on (09 §3.5 `deps`). */
export interface DuplicateDep {
  readonly event: number;
  readonly field: FieldId;
  readonly k: number;
}

/** What a new row matched: 09 §5.7 `duplicate`. */
export interface DuplicateMatch {
  readonly matched: readonly RowId[];
  readonly keys: readonly FieldId[];
  readonly deps: readonly DuplicateDep[];
  /** Per matched row, in the order of `matched`: its own contributions (`matched/<k>` deps). */
  readonly depsOf: ReadonlyMap<RowId, readonly DuplicateDep[]>;
}

/** A row the request's earlier ops wrote: compared by its state as the request has it. */
export interface RequestRow {
  readonly row: RowId;
  readonly state: RowState;
}

/** One row as compared: its key values, its last operation in effect, its contributions. */
interface Compared {
  readonly row: RowId;
  readonly last: number;
  readonly deps: readonly DuplicateDep[];
}

/** The table's duplicate-key groups, by field ID; none on a state table or without any. */
export const duplicateKeysOf = (t: CompiledBaseTable): readonly (readonly FieldId[])[] =>
  t.time.type === "state" ? [] : (t.duplicate_keys ?? []);

/**
 * The fields of a row as a request's state has them at `at`, with the item giving each: none for a
 * revoked row.
 */
export function valuesOf(
  state: RowState,
  fields: readonly FieldId[],
  at: Limit,
): Map<FieldId, { value: FieldValue; dep: DuplicateDep }> | undefined {
  if (state.revoked(at)) return undefined;
  const out = new Map<FieldId, { value: FieldValue; dep: DuplicateDep }>();
  for (const f of fields) {
    const st = state.fieldState(f, WHOLE, at);
    if (st.kind !== "value") continue;
    out.set(f, { value: st.value, dep: { event: st.by.event, field: f, k: st.by.k } });
  }
  return out;
}

/** Latest written first, then by row ID: the order `matched` lists rows in. */
export const byLatest = (a: Compared, b: Compared): number =>
  b.last - a.last || (a.row < b.row ? -1 : a.row > b.row ? 1 : 0);

/**
 * Whether the values match on every field of the group: each there, non-empty, the same value.
 */
export function matchesGroup(
  group: readonly FieldId[],
  mine: ReadonlyMap<FieldId, FieldValue>,
  theirs: ReadonlyMap<FieldId, FieldValue>,
): boolean {
  return group.every((f) => {
    const a = mine.get(f);
    const b = theirs.get(f);
    return a !== undefined && a !== null && b !== undefined && b !== null && sameValue(a, b);
  });
}

/** The physical columns of a field and its value as they hold it. */
function columnsOf(
  t: CompiledBaseTable,
  f: FieldId,
  v: FieldValue,
): { col: string; value: unknown }[] {
  const def = t.fields.find((x) => x.id === f);
  if (def?.type === "zoned_datetime" && typeof v === "object" && v !== null && "instant" in v)
    return [
      { col: `f_${f}`, value: v.instant },
      { col: `f_${f}__zone`, value: v.zone },
    ];
  if (typeof v === "object" && v !== null && "value" in v)
    return [{ col: `f_${f}`, value: v.value }];
  return [{ col: `f_${f}`, value: v }];
}

const IDENT = /^(t_t[1-9][0-9]{0,8}_v[1-9][0-9]{0,8}(__ver)?|f_f[1-9][0-9]{0,8}(__zone)?)$/;
const quote = (name: string): string => {
  // Names come from the compiled definition, never from a caller: checked all the same.
  if (!IDENT.test(name)) throw new Error(`not a physical name: ${JSON.stringify(name)}`);
  return `"${name}"`;
};

/**
 * The stored rows matching a group, not revoked, with their last operation in effect: the latest
 * operation among the open cells of the row's version table (each cell's `rec_from` is the event
 * that recorded it).
 */
async function storedMatches(
  tx: Tx,
  t: CompiledBaseTable,
  group: readonly FieldId[],
  mine: ReadonlyMap<FieldId, FieldValue>,
  self: RowId,
  limit: number,
): Promise<{ row: RowId; last: number }[]> {
  const table = quote(t.physical.table);
  const ver = quote(`${t.physical.table}__ver`);
  const params: unknown[] = [self];
  const conds = group.flatMap((f) =>
    columnsOf(t, f, mine.get(f) as FieldValue).map(({ col, value }) => {
      params.push(value);
      return `b.${quote(col)} = $${params.length}`;
    }),
  );
  params.push(limit);
  const r = await tx.query<{ row_id: string; last: unknown }>(
    `SELECT b.row_id,
       (SELECT max(e.op) FROM ${ver} v JOIN events e ON e.seq = v.rec_from
         WHERE v.row_id = b.row_id AND v.rec_to IS NULL) AS last
     FROM ${table} b
     WHERE NOT b.revoked AND b.row_id <> $1 AND ${conds.join(" AND ")}
     ORDER BY last DESC, b.row_id
     LIMIT $${params.length}`,
    params as never,
  );
  return r.rows.map((x) => ({ row: x.row_id as RowId, last: Number(x.last) }));
}

/** The last operation in effect on each stored row (the latest among its open version cells). */
async function storedLast(
  tx: Tx,
  t: CompiledBaseTable,
  rows: readonly RowId[],
): Promise<Map<string, number>> {
  if (rows.length === 0) return new Map();
  const ver = quote(`${t.physical.table}__ver`);
  const r = await tx.query<{ row_id: string; last: unknown }>(
    `SELECT v.row_id, max(e.op) AS last FROM ${ver} v JOIN events e ON e.seq = v.rec_from
     WHERE v.row_id = ANY($1) AND v.rec_to IS NULL GROUP BY v.row_id`,
    [rows] as never,
  );
  return new Map(r.rows.map((x) => [x.row_id, Number(x.last)]));
}

/** The contributions in effect on the group's fields of stored rows (their current cells). */
async function storedDeps(
  tx: Tx,
  t: CompiledBaseTable,
  rows: readonly RowId[],
  group: readonly FieldId[],
): Promise<Map<RowId, DuplicateDep[]>> {
  const out = new Map<RowId, DuplicateDep[]>();
  if (rows.length === 0) return out;
  const ver = quote(`${t.physical.table}__ver`);
  const r = await tx.query<{
    row_id: string;
    field_id: string;
    src_event: unknown;
    src_k: unknown;
  }>(
    `SELECT row_id, field_id, src_event, src_k FROM ${ver}
     WHERE row_id = ANY($1) AND field_id = ANY($2) AND rec_to IS NULL AND src_event IS NOT NULL
     ORDER BY row_id, field_id`,
    [rows, group] as never,
  );
  for (const x of r.rows) {
    const list = out.get(x.row_id as RowId) ?? [];
    list.push({ event: Number(x.src_event), field: x.field_id as FieldId, k: Number(x.src_k) });
    out.set(x.row_id as RowId, list);
  }
  return out;
}

/**
 * What row `self`, just created and in effect with `mine` on its fields, matched: the first group
 * with a match, its rows latest written first (at most 10), and their contributions. Undefined when
 * no group matched. `requestRows`: the other rows the request's earlier ops wrote, as `at` has
 * them, at operation `op`.
 */
export async function findDuplicates(
  tx: Tx,
  input: {
    readonly table: CompiledBaseTable;
    readonly self: RowId;
    readonly mine: ReadonlyMap<FieldId, FieldValue>;
    readonly requestRows: readonly RequestRow[];
    readonly at: Limit;
    readonly op: OpNumber;
  },
): Promise<DuplicateMatch | undefined> {
  const { table: t, self, mine } = input;
  const touched = new Set(input.requestRows.map((r) => r.row as string));
  for (const group of duplicateKeysOf(t)) {
    // A field empty or absent on the new row: this group matches nothing.
    if (!group.every((f) => mine.get(f) !== undefined && mine.get(f) !== null)) continue;
    const found: Compared[] = [];
    // Stored rows the request did not write: as stored.
    const stored = (
      await storedMatches(tx, t, group, mine, self, MATCHED_MAX + touched.size)
    ).filter((x) => !touched.has(x.row));
    const deps = await storedDeps(
      tx,
      t,
      stored.map((x) => x.row),
      group,
    );
    for (const x of stored) found.push({ ...x, deps: deps.get(x.row) ?? [] });
    // Rows the request wrote: as the request has them before this op. Their last write in effect
    // is this operation only if one of its earlier ops left an item in effect on the row (a no-op,
    // a candidate, a proposal leave none); else the stored one.
    const hits: { row: RowId; deps: DuplicateDep[]; mine: boolean }[] = [];
    for (const r of input.requestRows) {
      if (r.row === self) continue;
      const theirs = valuesOf(r.state, group, input.at);
      if (theirs === undefined) continue;
      const values = new Map([...theirs].map(([f, x]) => [f, x.value]));
      if (!matchesGroup(group, mine, values)) continue;
      const own = r.state.items.some(
        (x) =>
          x.op === input.op &&
          (x.status === "applied" || x.status === "corroborated") &&
          r.state.sees(x, input.at),
      );
      hits.push({ row: r.row, deps: [...theirs.values()].map((x) => x.dep), mine: own });
    }
    const lastStored = await storedLast(
      tx,
      t,
      hits.filter((h) => !h.mine).map((h) => h.row),
    );
    for (const h of hits)
      found.push({
        row: h.row,
        last: h.mine ? input.op : (lastStored.get(h.row) ?? 0),
        deps: h.deps,
      });
    if (found.length === 0) continue;
    const top = found.sort(byLatest).slice(0, MATCHED_MAX);
    return {
      matched: top.map((x) => x.row),
      keys: group,
      deps: top.flatMap((x) => x.deps),
      depsOf: new Map(top.map((x) => [x.row, x.deps])),
    };
  }
  return undefined;
}

/**
 * Whether the op created its row and the row is in effect: the judgement counts it the row's first
 * creation, and its items all in effect, applied or corroborated (a row created awaiting
 * confirmation is not compared; an
 * event or timeless row's creation has no existence item, its fields' items are the row). Read off
 * the judgement, not the op's intent: a row created by key is an update or a correction.
 */
export function createdInEffect(j: Judgement): boolean {
  if (!j.created) return false;
  const items = "items" in j.record ? j.record.items : [];
  return (
    items.length > 0 && items.every((x) => x.status === "applied" || x.status === "corroborated")
  );
}

/**
 * The pipeline's call: row `self`, created by op `index` of operation `op`, as its state has it
 * just after that op, against the stored rows and the request's other rows as they are just
 * before it. Undefined for a table without duplicate keys or with no match.
 */
export async function duplicateOf(
  tx: Tx,
  input: {
    readonly table: CompiledBaseTable;
    readonly self: RowId;
    readonly state: RowState;
    readonly requestRows: readonly RequestRow[];
    readonly op: OpNumber;
    readonly index: number;
  },
): Promise<DuplicateMatch | undefined> {
  const groups = duplicateKeysOf(input.table);
  if (groups.length === 0) return undefined;
  const fields = [...new Set(groups.flat())];
  const upTo = (input.op - 1) as OpNumber;
  const after: Limit = { upTo, request: { op: input.op, below: input.index + 1 } };
  const mine = valuesOf(input.state, fields, after);
  if (mine === undefined) return undefined;
  return findDuplicates(tx, {
    table: input.table,
    self: input.self,
    mine: new Map([...mine].map(([f, x]) => [f, x.value])),
    requestRows: input.requestRows,
    at: { upTo, request: { op: input.op, below: input.index } },
    op: input.op,
  });
}

/** 09 §5.7 `duplicate`. */
export const duplicateBlock = (m: DuplicateMatch) => ({
  matched: [...m.matched],
  keys: [...m.keys],
  deps: m.deps.map((d) => ({ ...d })),
});

/** 09 §5.8 `item.created` of a flagged item: its target and its `matched/<k>`, in that order. */
export function flaggedItem(
  m: DuplicateMatch,
  o: {
    readonly item: ItemId;
    readonly table: TableId;
    readonly row: RowId;
    readonly origin: Seq;
    readonly ruleset: number;
    readonly policy: number;
  },
): Record<string, unknown> {
  return {
    target: {
      item: o.item,
      type: "flagged",
      reason: "duplicate_keys",
      table: o.table,
      row: o.row,
      origin_event: o.origin,
      ruleset_version: o.ruleset,
      policy_version: o.policy,
    },
    ...Object.fromEntries(
      m.matched.map((row, k) => [`matched/${k}`, { row, deps: [...(m.depsOf.get(row) ?? [])] }]),
    ),
  };
}
