// The slots and tables a read can see, and the table a read names (04-contract §1; 03-data-model/
// 04-write-and-read.md «可见范围»): names only within the visible range, without ASCII case,
// qualified `slot.table` or bare when one visible slot has it; unknown names with the nearest
// visible ones (aliases first, 04-contract-types §9).

import type {
  CompiledSchema,
  CompiledTable,
  SlotId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { fold, nearest, splitTableName } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { invalid, ReadError } from "./types.ts";

/** The call context's visibility (02-architecture §4 «`ops` 的调用上下文»). */
export type Visibility =
  | { readonly kind: "all" }
  | {
      readonly kind: "scoped";
      readonly slots: readonly {
        readonly slot: SlotId;
        readonly tables?: readonly {
          readonly table: TableId;
          readonly fields?: readonly string[];
        }[];
      }[];
    };

export interface VisibleSlot {
  readonly slot: SlotId;
  readonly name: string;
  readonly timezone: string;
  readonly sv: number;
  readonly compiled: CompiledSchema;
  /** The tables visible in it. */
  readonly tables: readonly CompiledTable[];
}

/** The slots with a current definition that the caller can see, with their visible tables. */
export async function visibleSlots(tx: ReadTx, visibility: Visibility): Promise<VisibleSlot[]> {
  const r = await tx.query<{
    id: string;
    name: string;
    timezone: string;
    current_sv: unknown;
    body: string | null;
  }>(
    `SELECT s.id, s.name, s.timezone, s.current_sv, c.body
     FROM slots s JOIN schema_versions v ON v.slot_id = s.id AND v.state = 'current'
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     ORDER BY s.id`,
  );
  const scoped =
    visibility.kind === "scoped" ? new Map(visibility.slots.map((s) => [s.slot, s])) : undefined;
  const out: VisibleSlot[] = [];
  for (const x of r.rows) {
    if (x.body === null) continue;
    const scope = scoped?.get(x.id as SlotId);
    if (scoped !== undefined && scope === undefined) continue;
    const compiled = JSON.parse(x.body) as CompiledSchema;
    let tables: readonly CompiledTable[] = compiled.tables;
    if (scope?.tables !== undefined) {
      if (scope.tables.some((t) => t.fields !== undefined)) {
        throw new ReadError("internal", "visibility by field is not implemented");
      }
      const ids = new Set(scope.tables.map((t) => t.table));
      tables = tables.filter((t) => ids.has(t.id));
    }
    out.push({
      slot: x.id as SlotId,
      name: x.name,
      timezone: x.timezone,
      sv: Number(x.current_sv),
      compiled,
      tables,
    });
  }
  return out;
}

export interface NamedTable {
  readonly slot: VisibleSlot;
  readonly table: CompiledTable;
}

/** The table a read names at `param`: `unknown_table`, `ambiguous_table` as for writes. */
export function resolveTable(
  name: unknown,
  param: string,
  slots: readonly VisibleSlot[],
): NamedTable {
  if (name === undefined) throw invalid("missing", param);
  if (typeof name !== "string" || name === "") throw invalid("malformed", param);
  const [s, t] = splitTableName(name);
  const holders = (s === undefined ? slots : slots.filter((x) => fold(x.name) === fold(s))).flatMap(
    (slot) => {
      const table = slot.tables.find((x) => fold(x.name) === fold(t));
      return table === undefined ? [] : [{ slot, table }];
    },
  );
  const [first, second] = holders;
  if (first === undefined) {
    const candidates =
      s === undefined
        ? [
            ...new Map(
              slots.flatMap((x) =>
                x.tables.map((y) => [y.name, { name: y.name, aliases: y.aliases ?? [] }] as const),
              ),
            ).values(),
          ]
        : slots.flatMap((x) =>
            x.tables.map((y) => ({
              name: `${x.name}.${y.name}`,
              aliases: (y.aliases ?? []).map((a) => `${x.name}.${a}`),
            })),
          );
    throw new ReadError("unknown_table", `unknown table ${JSON.stringify(name)}`, {
      param,
      name,
      nearest: nearest(s === undefined ? t : name, candidates),
    });
  }
  if (second !== undefined) {
    throw invalid("ambiguous_table", param, {
      candidates: holders.map((h) => `${h.slot.name}.${h.table.name}`),
    });
  }
  return first;
}
