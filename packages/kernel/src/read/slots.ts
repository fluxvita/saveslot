// The slots and tables a read can see, and the table a read names (04-contract §1; 03-data-model/
// 04-write-and-read.md «可见范围»): names only within the visible range, without ASCII case,
// qualified `slot.table` or bare when one visible slot has it; unknown names with the nearest
// visible ones (aliases first, 04-contract-types §9).

import type { CompiledSchema, CompiledTable, SlotId } from "@fluxvita/saveslot-contract-core";
import {
  FieldVisibilityNotImplemented,
  fold,
  nearest,
  splitTableName,
  type Visibility,
  visibleTables,
} from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { invalid, ReadError } from "./types.ts";

export type { Visibility };

export interface VisibleSlot {
  readonly slot: SlotId;
  readonly name: string;
  readonly timezone: string;
  readonly sv: number;
  readonly compiled: CompiledSchema;
  /** The tables visible in it. */
  readonly tables: readonly CompiledTable[];
}

/**
 * Whether every table of the slot is in the visible range. A slot's schema as a whole (its
 * `schema_change` items, its drafts) is seen only so; otherwise it is as not there.
 */
export const wholeSlot = (s: VisibleSlot): boolean => s.tables.length === s.compiled.tables.length;

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
  const out: VisibleSlot[] = [];
  for (const x of r.rows) {
    if (x.body === null) continue;
    const compiled = JSON.parse(x.body) as CompiledSchema;
    let tables: readonly CompiledTable[] | undefined;
    try {
      tables = visibleTables(visibility, x.id as SlotId, compiled.tables);
    } catch (e) {
      if (e instanceof FieldVisibilityNotImplemented) throw new ReadError("internal", e.message);
      throw e;
    }
    if (tables === undefined) continue;
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

/**
 * Who created each slot, by the kind of principal behind its first event (the draft that created
 * it): `user`, `connection` or `system`; a slot not found is left out. The first event of a slot
 * is its creation and never changes, whatever is done to the slot later.
 */
export async function slotCreators(
  tx: ReadTx,
  slots: readonly SlotId[],
): Promise<Map<SlotId, string>> {
  const out = new Map<SlotId, string>();
  if (slots.length === 0) return out;
  const r = await tx.query<{ slot: string; kind: string }>(
    `SELECT e.slot, p.kind FROM events e JOIN principals p ON p.id = e.actor
     WHERE e.seq IN (SELECT MIN(seq) FROM events WHERE slot = ANY($1) GROUP BY slot)`,
    [[...slots]] as never,
  );
  for (const x of r.rows) out.set(x.slot as SlotId, x.kind);
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
        ? (() => {
            // One candidate per name; tables of one name in several slots join their aliases, as
            // the write path does (../request/normalize.ts).
            const byName = new Map<string, string[]>();
            for (const x of slots)
              for (const y of x.tables)
                byName.set(y.name, [...(byName.get(y.name) ?? []), ...(y.aliases ?? [])]);
            return [...byName].map(([n, aliases]) => ({ name: n, aliases }));
          })()
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
