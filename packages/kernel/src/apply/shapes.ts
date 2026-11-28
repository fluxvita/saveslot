// A slot's schema versions as a chain of table maps (07-schema-evolution «确定性转换怎么重放»):
// content written in one version reaches a later one through each switch in between, one version
// at a time (a value written in version 1 read in version 3 goes 1 → 2 → 3). A switch that keeps a
// table's physical table changes none of its values; one that rebuilds it maps it by
// `tableMapOf`, with the fields that switch tightens.
//
// Which version an event's content is in: the version current at that event, the last one whose
// switch (`schema_versions.switched_seq`) is not after it. A switch's own constant `backfill` is of
// the version it switches to.

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldId,
  Seq,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import {
  type ConvertFailure,
  convertFieldValue,
  type TableMap,
  tableMapOf,
  tightenedOf,
} from "./convert.ts";
import type { SettleContent } from "./settle.ts";

/** A version of a slot that took effect, with what its draft changed. */
export interface SlotVersion {
  readonly sv: number;
  /** `seq` of its `schema.switched`. */
  readonly switchedSeq: Seq;
  readonly compiled: CompiledSchema;
  /** Its `schema.compiled` `changes` (09 §5.5). */
  readonly changes: readonly {
    readonly change: string;
    readonly target: Readonly<Record<string, unknown>>;
  }[];
}

/** The versions of `slot` that took effect (current and retired), in order. */
export async function slotVersions(tx: ReadTx, slot: string): Promise<SlotVersion[]> {
  const r = await tx.query<{
    sv: unknown;
    switched_seq: unknown;
    compiled: string;
    changes: string | null;
  }>(
    `SELECT v.sv, v.switched_seq, c.body AS compiled, ch.body AS changes
     FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     LEFT JOIN content ch ON ch.seq = v.compiled_seq AND ch.path = 'changes'
     WHERE v.slot_id = $1 AND v.state IN ('current', 'retired') ORDER BY v.sv`,
    [slot],
  );
  return r.rows.map((x) => ({
    sv: Number(x.sv),
    switchedSeq: Number(x.switched_seq) as Seq,
    compiled: JSON.parse(x.compiled) as CompiledSchema,
    changes: x.changes === null ? [] : JSON.parse(x.changes),
  }));
}

/** The version whose shape an event's content is in: the last switched at or before it. */
export function versionAt(versions: readonly SlotVersion[], seq: Seq): number {
  let sv: number | undefined;
  for (const v of versions) if (v.switchedSeq <= seq) sv = v.sv;
  if (sv === undefined) throw new Error(`no version of the slot at ${seq}`);
  return sv;
}

const baseTable = (c: CompiledSchema, table: string) => {
  const t = c.tables.find((x) => x.id === table);
  return t?.kind === "base" ? t : undefined;
};

/**
 * The maps of table `table` from version `from` to version `to`, one per switch in between that
 * rebuilt it (a switch keeping its physical table changes none of its values).
 */
export function mapsBetween(
  versions: readonly SlotVersion[],
  table: string,
  from: number,
  to: number,
): TableMap[] {
  const maps: TableMap[] = [];
  let prev: CompiledBaseTable | undefined;
  for (const v of versions) {
    if (v.sv < from || v.sv > to) continue;
    const t = baseTable(v.compiled, table);
    if (prev !== undefined && t !== undefined && prev.physical.table !== t.physical.table)
      maps.push(tableMapOf(prev, t, tightenedOf(v.changes, table)));
    prev = t;
  }
  return maps;
}

/**
 * An item's content through maps: a value converted at each step; `null`: its field was dropped on
 * the way. Existence, `no_value` and `uncovered` pass as they are.
 */
export function contentThrough(
  maps: readonly TableMap[],
  field: FieldId | "existence",
  content: SettleContent,
): { readonly ok: true; readonly content: SettleContent | null } | ConvertFailure {
  if (field === "existence") return { ok: true, content };
  let c = content;
  for (const m of maps) {
    const f = m.fields.get(field);
    if (f?.op === "drop") return { ok: true, content: null };
    if (c.kind !== "value" || f === undefined) continue;
    const r = convertFieldValue(f, c.value);
    if (!r.ok) return { ok: false, field, why: r.why };
    c = { kind: "value", value: r.value };
  }
  return { ok: true, content: c };
}
