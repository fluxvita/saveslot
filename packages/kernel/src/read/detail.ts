// `detail: "detailed"` (04-contract-types §4.1 `RowDetail`; 04-contract §10 `detail`): for the rows
// of a page, the operation that last changed each and when it was recorded; each field read with
// its literal result and source level (03-deletion «字段的来源级别»: "computed on the spot: among
// the value sources of the field that are still there, the highest declared level among the
// evidence portions that have a literal match is taken"), and a ref field with a summary of the row
// it names; the premises are the rows' own (./rows.ts `premiseEntries`). A fixed number of
// statements, whatever the page.
//
// A field's literal result, over the origin items of its cells on the row (a state table: on the
// row's stretch), followed through carried references to the items that wrote them (09 §5.7: a
// carried item has no `literal` block, "and its check result is that of the item it was carried
// from"), and over each item's evidence segments (`literal/<field>/<k>`): any segment `hit` →
// `hit`; else any `miss` → `miss`; else `na` (every segment `na`, or none: a value from a schema
// constant, no value, an empty one). The level, with a `hit` only: the highest declared level
// (`user_stated` over `agent_inferred`) of the segments that hit. An item a deletion removed is not
// among the origin items; a block a deletion cleared or holds pending is not read.
//
// The summary of a referenced row (`ref.values`): its fields' values as reading it gives them, read
// at the same position as the page (a state entity: at the read's moment, the day in the slot's
// zone on a date table); none for a target whose table the caller cannot see, one revoked or not
// there, or a state entity with no value then. Reading it is a read: the targets go into the read
// record with their versions.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledTable,
  FieldId,
  Instant,
  Seq,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import type { ReadRow } from "../audit/index.ts";
import { cellsOfRows, cellValue, type StateCell, sourceItemsOfRows } from "../delta/sources.ts";
import { decodeColumns as decode } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { readableContentOf } from "../store/readable-content.ts";
import { dateInZone, valueOut } from "../time/index.ts";
import { type ShownRow, spansMeet } from "./rows.ts";
import { rowFacts } from "./select.ts";
import type { RowDetail, Values } from "./types.ts";
import { rowFactsAsOf } from "./versions.ts";

type Literal = "hit" | "miss" | "na";
type Level = "user_stated" | "agent_inferred";
const RANK: Record<Level, number> = { agent_inferred: 1, user_stated: 2 };

/** The literal result and level of a field over its evidence segments (see above). */
export function literalOf(
  segments: readonly { readonly result: Literal; readonly level: Level | null }[],
): { literal: Literal; level?: Level } {
  const hits = segments.filter((s) => s.result === "hit");
  if (hits.length > 0) {
    const levels = hits.map((s) => s.level).filter((l): l is Level => l !== null);
    const level = levels.sort((a, b) => RANK[b] - RANK[a])[0];
    return { literal: "hit", ...(level !== undefined ? { level } : {}) };
  }
  return { literal: segments.some((s) => s.result === "miss") ? "miss" : "na" };
}

/** A cell gives a value (not a revoke, not a stretch with none). */
const valued = (c: StateCell) => c.revoked !== true && c.no_value !== true;

export interface DetailInput {
  readonly table: CompiledBaseTable;
  /** The fields read, in the table's order. */
  readonly fields: readonly CompiledBaseField[];
  /** The tables the caller can see in the slot (a ref target elsewhere gives no summary). */
  readonly visible: readonly CompiledTable[];
  readonly page: readonly Pick<ShownRow, "id" | "ver" | "validFrom" | "validTo" | "values">[];
  /** The record position read (a later page's, an `as_of` point); none: now. */
  readonly asOf: number | undefined;
  /** The read's moment, for a state entity's summary. */
  readonly at: Instant;
  readonly zone: string;
  readonly restoreCount: number;
}

/**
 * The `RowDetail` of each row of the page, in its order, without `premises` (the rows' own); and
 * the referenced rows read for the summaries, for the read record.
 */
export async function rowDetails(
  tx: ReadTx,
  o: DetailInput,
): Promise<{
  details: Omit<RowDetail, "premises">[];
  read: ReadRow[];
  /** Read by record time: the page's rows a ref summary of which left a removed value out. */
  partialRows: ReadonlySet<number>;
}> {
  const t = o.table;
  const ids = [...new Set(o.page.map((r) => r.id))];
  const at = o.asOf ?? Number.MAX_SAFE_INTEGER;

  // When each version was recorded: the head event of its operation.
  const vers = [...new Set(o.page.map((r) => r.ver))];
  const recorded = new Map<number, string>();
  if (vers.length > 0) {
    const r = await tx.query<{ seq: unknown; at: string }>(
      "SELECT seq, at FROM events WHERE seq = ANY($1)",
      [vers] as never,
    );
    for (const x of r.rows) recorded.set(Number(x.seq), x.at);
  }

  // The origin items of each field cell of the page's rows.
  const cells = await cellsOfRows(tx, t, ids, at);
  // Read at a record position (an `as_of` point, a later page): a corroboration taken back only
  // by what was registered by then (04-contract §10 `as_of`, §15: the answer of that position).
  const itemsOf = await sourceItemsOfRows(
    tx,
    t,
    ids,
    at,
    decode,
    o.asOf !== undefined ? { revertsUpToVer: true } : {},
  );
  const itemsByRowField = o.page.map((r) => {
    const byField = new Map<string, Set<string>>();
    for (const c of cells.get(r.id) ?? []) {
      if (c.field_id === "existence" || !valued(c)) continue;
      if (
        r.validFrom !== undefined &&
        !spansMeet([{ from: c.vf, to: c.vt }], r.validFrom, r.validTo ?? null)
      )
        continue;
      const set = byField.get(c.field_id) ?? new Set<string>();
      for (const item of itemsOf(r.id, c.field_id as FieldId, c)) set.add(item);
      byField.set(c.field_id, set);
    }
    return byField;
  });

  // Their literal blocks, still there (not cleared, not held by a pending deletion).
  const blockOf = (item: string) => {
    const [event, field, k] = item.split("/");
    return { seq: Number(event), path: `literal/${field}/${k}` };
  };
  const wanted = [
    ...new Set(itemsByRowField.flatMap((m) => [...m.values()].flatMap((s) => [...s]))),
  ];
  const segmentsOf = new Map<string, { source: number; result: Literal }[]>();
  if (wanted.length > 0) {
    const blocks = wanted.map(blockOf);
    const r = await tx.query<{ seq: unknown; path: string; body: string }>(
      `SELECT c.seq, c.path, c.body FROM ${readableContentOf("$1")} c
       WHERE c.path = ANY($2) AND c.removed_by IS NULL AND c.body IS NOT NULL`,
      [[...new Set(blocks.map((b) => b.seq))], [...new Set(blocks.map((b) => b.path))]] as never,
    );
    for (const x of r.rows) {
      const body = JSON.parse(x.body) as { segments?: { source: number; result: Literal }[] };
      segmentsOf.set(`${Number(x.seq)} ${x.path}`, body.segments ?? []);
    }
  }
  const sources = [...new Set([...segmentsOf.values()].flatMap((xs) => xs.map((x) => x.source)))];
  const levelOf = new Map<number, Level | null>();
  if (sources.length > 0) {
    const r = await tx.query<{ seq: unknown; level: string | null }>(
      "SELECT seq, level FROM sources WHERE seq = ANY($1)",
      [sources] as never,
    );
    for (const x of r.rows) levelOf.set(Number(x.seq), (x.level as Level | null) ?? null);
  }

  // The rows the ref fields read name, by target table; their summaries and versions.
  const summaries = await refSummaries(tx, o);

  // The rows whose ref summary left a value out: marked `partially_deleted` by the caller.
  const partialRows = new Set<number>();
  const details = o.page.map((r, i) => {
    const byField = itemsByRowField[i] as Map<string, Set<string>>;
    const fields: Record<string, RowDetail["fields"][string]> = Object.create(null);
    for (const f of o.fields) {
      const segments = [...(byField.get(f.id) ?? [])].flatMap((item) => {
        const b = blockOf(item);
        return (segmentsOf.get(`${b.seq} ${b.path}`) ?? []).map((s) => ({
          result: s.result,
          level: levelOf.get(s.source) ?? null,
        }));
      });
      const v = r.values[f.id];
      const ref = f.type === "ref" && typeof v === "string" ? summaries.values.get(v) : undefined;
      if (ref !== undefined && summaries.partial.has(v as string)) partialRows.add(i);
      fields[f.name] = {
        field_id: f.id,
        ...literalOf(segments),
        ...(ref !== undefined ? { ref: { values: ref } } : {}),
      };
    }
    return {
      seq: r.ver as Seq,
      recorded_at: (recorded.get(r.ver) ?? "") as Instant,
      fields,
    };
  });
  return { details, read: summaries.read, partialRows };
}

/** The summaries of the rows the page's ref fields read name, and those rows as read. */
async function refSummaries(
  tx: ReadTx,
  o: DetailInput,
): Promise<{ values: Map<string, Values>; read: ReadRow[]; partial: Set<string> }> {
  const values = new Map<string, Values>();
  const read: ReadRow[] = [];
  // Read by record time: the referenced rows a value of which a removed contribution gave then.
  const partial = new Set<string>();
  const named = new Map<TableId, Set<string>>();
  for (const f of o.fields) {
    if (f.type !== "ref") continue;
    const to = (f as { ref: { table: TableId } }).ref.table;
    for (const r of o.page) {
      const v = r.values[f.id];
      if (typeof v !== "string") continue;
      const set = named.get(to) ?? new Set<string>();
      set.add(v);
      named.set(to, set);
    }
  }
  const at = o.asOf ?? Number.MAX_SAFE_INTEGER;
  for (const [id, set] of named) {
    const target = o.visible.find((x) => x.id === id);
    if (target?.kind !== "base") continue;
    const tb = target as CompiledBaseTable;
    const ids = [...set];
    const cells = await cellsOfRows(tx, tb, ids, at, { withheld: o.asOf !== undefined });
    const state = tb.time.type === "state";
    // A state entity: its value at the read's moment (the day in the slot's zone on a date table).
    const point =
      state && tb.time.type === "state" && tb.time.granularity === "date"
        ? dateInZone(Date.parse(o.at), o.zone)
        : o.at;
    const shown: string[] = [];
    for (const rid of ids) {
      const list = cells.get(rid) ?? [];
      if (list.length === 0) continue;
      const live = state
        ? list.filter(
            (c) => valued(c) && (c.vf === null || c.vf <= point) && (c.vt === null || point < c.vt),
          )
        : list;
      // An event or timeless row revoked; a state entity with no value then: no summary.
      if (!state && list.some((c) => c.field_id === "existence" && c.revoked === true)) continue;
      if (state && live.length === 0) continue;
      const out: Record<string, Values[string]> = Object.create(null);
      for (const f of tb.fields) {
        const c = live.find((x) => x.field_id === f.id && valued(x));
        // A value a removed contribution gave then: not given (03-deletion «版本表»).
        if (c?.withheld === true) {
          partial.add(rid);
          continue;
        }
        out[f.name] = valueOut(c === undefined ? null : cellValue(f, c, decode));
      }
      values.set(rid, out);
      shown.push(rid);
    }
    if (shown.length === 0) continue;
    const facts =
      o.asOf === undefined
        ? await rowFacts(tx, tb, shown)
        : await rowFactsAsOf(tx, tb, shown, o.asOf);
    for (const rid of shown) {
      const v = facts.ver.get(rid);
      read.push({
        table: tb.id as TableId,
        target: rid,
        ...(v !== undefined ? { ver: { op: v as never, restoreCount: o.restoreCount } } : {}),
      });
    }
  }
  return { values, read, partial };
}
