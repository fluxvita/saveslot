// The items in effect on a row or entity, as the source table (`base_sources`) and their blocks
// give them (09-event-format §5.7 `write.base` apply): the input of `settle`, for a write, a
// deletion and a switch rebuilding the table alike.
//
// An item's content is in its own block (`fields/<f>/<k>`, `existence/<k>`), or, once a deletion
// restated it with a new content (a carried item's value, `no_value`, `uncovered`), in that
// deletion's `restated/<k>` (`given_seq`, `given_path`). An item whose block a deletion removed is
// not in effect. A constant `backfill` of a switch (09 §5.5) has no block: its value is the
// constant the version switched to gives its field.
//
// Each item says where its content was written (`shapeSeq`): the content is in the shape of the
// schema version current at that event (07-schema-evolution «确定性转换怎么重放»), which a caller
// converts to the version it settles for.

import type { CompiledSchema, FieldValue, JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import type { SettleItem } from "./settle.ts";
import { storedValid } from "./write-base.ts";

type Obj = Readonly<Record<string, JsonValue>>;

/** Whether a restated block gives the item a content (not only its status or interval). */
export const givesContent = (r: Obj) => "value" in r || "no_value" in r || "uncovered" in r;

/** The constant `backfill` of field `field` of table `table` in version `sv`, if it has one. */
export type ConstOf = (sv: number, table: string, field: string) => Promise<FieldValue | undefined>;

/** An item in effect, with where its content was written. */
export interface RowItem extends SettleItem {
  /** The event whose block gives the content: the item's own, or the restating deletion. */
  readonly shapeSeq: Seq;
  /** A switch's constant `backfill`: the version that switch went to. */
  readonly constSv?: number;
}

/**
 * The items in effect on row `rowId` of table `table`, in log order. `constOf`: the constant
 * `backfill` of a field of the table in a version of its slot, for a switch's constant.
 */
export async function rowItems(
  tx: ReadTx,
  table: string,
  rowId: string,
  constOf: ConstOf,
): Promise<RowItem[]> {
  const stored = await tx.query<{
    event_seq: unknown;
    field_id: string;
    k: number;
    status: "applied" | "corroborated";
    valid_from: string | null;
    valid_to: string | null;
    reverted: string;
    body: string | null;
    given: string | null;
    given_seq: unknown;
    source_kind: string;
    schema_const_sv: number | null;
    type: string;
  }>(
    // The restating block is read by a scalar subquery, not a second join of `content`: it is at
    // most one row (the key of `content`), null when `given_seq` is, and as a join it made the
    // planner, without statistics, read the whole key of `base_sources` for one row's sources.
    `SELECT b.event_seq, b.field_id, b.k, b.status, b.valid_from, b.valid_to, b.reverted, c.body,
       CASE WHEN b.given_seq IS NULL THEN NULL ELSE
         (SELECT g.body FROM content g WHERE g.seq = b.given_seq AND g.path = b.given_path) END
         AS given,
       b.given_seq, b.source_kind, b.schema_const_sv, e.type
     FROM base_sources b JOIN events e ON e.seq = b.event_seq
     LEFT JOIN content c ON c.seq = b.event_seq AND c.path =
       CASE WHEN b.field_id = 'existence' THEN 'existence/' || b.k ELSE 'fields/' || b.field_id || '/' || b.k END
     WHERE b.row_id = $1 AND b.n = 0 ORDER BY b.event_seq, b.field_id COLLATE "C", b.k`,
    [rowId],
  );
  const items: RowItem[] = [];
  for (const r of stored.rows) {
    const event = Number(r.event_seq);
    const common = {
      event,
      target: r.field_id as SettleItem["target"],
      k: r.k,
      status: r.status,
      valid: storedValid(r.valid_from, r.valid_to),
      reverted: (
        JSON.parse(r.reverted) as { op: Seq; valid: { from: string | null; to: string | null }[] }[]
      ).map((x) => ({ op: x.op, valid: x.valid as never })),
    };
    // A switch's constant: the value its version gives the field.
    if (r.type === "schema.switched") {
      const sv = r.schema_const_sv;
      const value = sv === null ? undefined : await constOf(sv, table, r.field_id);
      if (sv === null || value === undefined)
        throw new Error(
          `no constant backfill of ${r.field_id} for item ${event}/${r.k} of ${rowId}`,
        );
      items.push({
        ...common,
        content: { kind: "value", value },
        shapeSeq: event as Seq,
        constSv: sv,
        constant: true,
      });
      continue;
    }
    const given = r.given === null ? undefined : (JSON.parse(r.given) as Obj);
    const own = r.body === null ? undefined : (JSON.parse(r.body) as Obj);
    const restated = given !== undefined && givesContent(given);
    const b = restated ? given : own;
    if (b === undefined) continue; // the block was removed (a deletion's tombstone)
    const existence = r.field_id === "existence";
    items.push({
      ...common,
      content: existence
        ? b["restored"] === true || own?.["restored"] === true
          ? { kind: "restore" }
          : { kind: "revoke" }
        : "value" in b
          ? { kind: "value", value: b["value"] as never }
          : "no_value" in b
            ? { kind: "no_value" }
            : { kind: "uncovered" },
      shapeSeq: (restated ? Number(r.given_seq) : event) as Seq,
    });
  }
  return items;
}

/**
 * The constant `backfill` of a field in a version of a slot, read from its compiled definition:
 * `constOf` for {@link rowItems}, caching each version read.
 */
export function constsOf(tx: ReadTx, slot: string): ConstOf {
  const cache = new Map<number, Promise<CompiledSchema | undefined>>();
  return async (sv, table, field) => {
    let c = cache.get(sv);
    if (c === undefined) {
      c = tx
        .query<{ body: string }>(
          `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
           WHERE v.slot_id = $1 AND v.sv = $2`,
          [slot, sv],
        )
        .then((r) =>
          r.rows[0] === undefined ? undefined : (JSON.parse(r.rows[0].body) as CompiledSchema),
        );
      cache.set(sv, c);
    }
    const compiled = await c;
    const t = compiled?.tables.find((x) => x.id === table);
    const f = t?.kind === "base" ? t.fields.find((x) => x.id === field) : undefined;
    return f?.backfill !== undefined && "const" in f.backfill
      ? (f.backfill.const as FieldValue)
      : undefined;
  };
}
