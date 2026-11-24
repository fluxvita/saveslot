// Who still refers to a row or entity (03-data-model/04-write-and-read.md «引用字段»: «高影响 ② 怎么数
// "仍被引用"»; 05-time «高影响写入» ②): the rows whose ref fields' values in effect point at it, as
// the store holds them, with what this request did to them laid over.
//
// A referrer is a row of the slot, other than the target, not revoked, with a ref field naming the
// target's table whose value in effect is the target's ID; on a state table, over any stretch of
// business time (past ones included), where the entity has a value. Values a candidate or an
// awaiting write gives are not in effect and do not count. A referrer this request touched is
// judged on its state in the request (`known`), as of `at`: one it revoked, or changed to point
// elsewhere, no longer refers; one it created pointing at the target does.

import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledTable,
  EntityId,
  FieldId,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { type Limit, type RowState, valueToken } from "../judge/index.ts";
import type { ReadTx } from "../store/ports.ts";

/** A row or entity referring to a target, by one of its ref fields. */
export interface Referrer {
  readonly table: TableId;
  /** A row, or an entity (a state table). */
  readonly row?: RowId;
  readonly entity?: EntityId;
  readonly field: FieldId;
}

/** A row or entity this request has worked on: its table and its state in the request. */
export interface KnownRow {
  readonly table: TableId;
  readonly state: RowState;
}

/** Referrers in a fixed order: by table, row or entity, field. */
const order = (a: Referrer, b: Referrer) =>
  a.table.localeCompare(b.table) ||
  (a.row ?? a.entity ?? "").localeCompare(b.row ?? b.entity ?? "") ||
  a.field.localeCompare(b.field);

/** The referrers of `target`, a row or entity of table `targetTable`. */
export async function referrersOf(
  tx: ReadTx,
  c: {
    /** The slot's tables, as defined now. */
    readonly tables: readonly CompiledTable[];
    readonly targetTable: TableId;
    readonly target: string;
    /** The rows and entities this request has worked on, by ID. */
    readonly known: ReadonlyMap<string, KnownRow>;
    /** Where the request's own rows are read: before the op judged, or at the request's end. */
    readonly at: Limit;
  },
): Promise<Referrer[]> {
  const out: Referrer[] = [];
  const token = valueToken(c.target as never);
  for (const t of c.tables) {
    if (t.kind !== "base") continue;
    const fields = (t as CompiledBaseTable).fields.filter(
      (f): f is CompiledBaseField & { type: "ref" } =>
        f.type === "ref" && (f as { ref?: { table: TableId } }).ref?.table === c.targetTable,
    );
    if (fields.length === 0) continue;
    const isState = t.time.type === "state";
    const id = (x: string): Pick<Referrer, "row" | "entity"> =>
      isState ? { entity: x as EntityId } : { row: x as RowId };
    for (const f of fields) {
      // As stored: the current table holds what is in effect, every stretch of a state table's
      // business time a row of its own (a stretch without a value has none).
      const r = await tx.query<{ id: string }>(
        isState
          ? `SELECT DISTINCT entity_id AS id FROM "${t.physical.table}" WHERE "f_${f.id}" = $1`
          : `SELECT row_id AS id FROM "${t.physical.table}" WHERE "f_${f.id}" = $1 AND NOT revoked`,
        [c.target],
      );
      for (const x of r.rows) {
        // The target itself is always one of the request's rows (the op revoking it, or loaded
        // to refresh its item): judged below with them.
        if (c.known.has(x.id)) continue;
        out.push({ table: t.id, ...id(x.id), field: f.id });
      }
      // As this request left them, stretch by stretch.
      for (const [rowId, k] of c.known) {
        if (k.table !== t.id || rowId === c.target) continue;
        const s = k.state;
        const refers = isState
          ? s
              .pieces()
              .some((p) => s.hasValue(p, c.at) && s.token(f.id as FieldId, p, c.at) === token)
          : !s.revoked(c.at) && s.pieces().some((p) => s.token(f.id as FieldId, p, c.at) === token);
        if (refers) out.push({ table: t.id, ...id(rowId), field: f.id });
      }
    }
  }
  return out.sort(order);
}
