// What changed incompatibly for old writes since a version (03-data-model/07-schema-evolution.md
// «原则» 4; 04-contract §2 "什么算读到 sv"; 04-contract-types `schema_incompatible`): read off the
// `changes` each switched version's `schema.compiled` recorded, never compiled again (09 §5.5: a
// replay reads the recorded judgement). A change with `compatible_with_old_writes: false` on a field
// refuses old writes to that field; one on a table (`drop_table`) refuses them to the whole table,
// `"*"`, and so does a change made on a table never written (07 «从未被写入的表上改结构»: the table
// was restructured as a whole, a write's fields are not read by the earlier definition one by one).
// Versions given up or still pending count for nothing.

import type { FieldId, SchemaChangeCode, TableId } from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";

/** By `<table>/<field>`, or `<table>/*` for the whole table: the change that makes it so. */
export type ChangedFields = ReadonlyMap<`${TableId}/${FieldId}` | `${TableId}/*`, SchemaChangeCode>;

/** One recorded change, as `schema.compiled` `changes` has it (09 §5.5), as far as needed here. */
export interface RecordedChange {
  readonly change: SchemaChangeCode;
  readonly as_never_written?: true;
  readonly target: { readonly table?: string; readonly field?: string; readonly rule?: true };
  readonly compatible_with_old_writes: boolean;
}

/** A version switched to (current or retired) and the changes it was compiled with. */
export interface SwitchedVersion {
  readonly sv: number;
  readonly changes: readonly RecordedChange[];
}

/**
 * The fields and tables changed incompatibly in the versions after `sv`. When one changed so in
 * several versions, the latest version's change is the one given: it decides what the target is
 * now. Within one version, the first change recorded for it: `changes` lists a table's own changes
 * before its fields' (09 §5.5), so a table restructured is named by its table-level change
 * (`change_time_type`), not by a field dropped with it.
 */
export function changedSinceOf(versions: readonly SwitchedVersion[], sv: number): ChangedFields {
  const out = new Map<`${TableId}/${FieldId}` | `${TableId}/*`, SchemaChangeCode>();
  for (const v of [...versions].sort((a, b) => a.sv - b.sv)) {
    if (v.sv <= sv) continue;
    const inVersion = new Set<string>();
    for (const c of v.changes) {
      const t = c.target;
      // Compiled as on a table never written (09 §5.5 `as_never_written`): the whole table, compatible
      // or not.
      const whole = c.as_never_written === true;
      if (!whole && (c.compatible_with_old_writes || t.table === undefined || t.rule === true))
        continue;
      if (t.table === undefined) continue;
      const key =
        t.field === undefined || whole
          ? (`${t.table}/*` as `${TableId}/*`)
          : (`${t.table}/${t.field}` as `${TableId}/${FieldId}`);
      if (inVersion.has(key)) continue;
      inVersion.add(key);
      out.set(key, c.change);
    }
  }
  return out;
}

/** The slot's versions switched to, with their recorded changes, in the caller's transaction. */
export async function switchedVersions(tx: ReadTx, slot: string): Promise<SwitchedVersion[]> {
  const r = await tx.query<{ sv: unknown; changes: string | null }>(
    `SELECT v.sv, ch.body AS changes FROM schema_versions v
     JOIN content ch ON ch.seq = v.compiled_seq AND ch.path = 'changes'
     WHERE v.slot_id = $1 AND v.state IN ('current', 'retired') ORDER BY v.sv`,
    [slot],
  );
  return r.rows.map((x) => ({
    sv: Number(x.sv),
    changes: x.changes === null ? [] : (JSON.parse(x.changes) as RecordedChange[]),
  }));
}
