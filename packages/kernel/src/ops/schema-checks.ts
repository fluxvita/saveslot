// A draft that tightens a constraint without a `backfill` (03-data-model/07-schema-evolution.md
// «收紧约束»; 04-contract «schema_draft» `backfill_required`): the positions in effect that break the
// new definition, counted on the current version's business table, in the caller's transaction.
// Only positions that exist count: a row not revoked; on a state table an entity's stretch, all of
// which the business table holds. A row or entity counts once however many stretches break it.
// Samples are positions only, never values (a value is the user's content).

import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledSchema,
  CompiledUnit,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { compareDecimal, fold, type TightenedCheck } from "../schema/index.ts";
import { column, physical } from "../store/layout.ts";
import type { ReadTx } from "../store/ports.ts";
import { convertValue, type NumberShape } from "../values/index.ts";
import { SchemaDraftError } from "./schema-common.ts";

/** A position: a row, or an entity (04-contract-types §1.5 `TargetRef`). */
export type TargetRef =
  | { readonly table: string; readonly row: string }
  | { readonly table: string; readonly entity: string };

/** How many samples a `backfill_required` gives. */
export const BACKFILL_SAMPLES = 5;

/** A tightened field's positions in effect that break it: how many rows or entities, and some. */
export interface Violations {
  readonly path: string;
  readonly rows: number;
  readonly samples: readonly TargetRef[];
}

type NumberField = {
  unit?: CompiledUnit;
  precision?: { scale: number; rounding: "half_up" | "half_even" };
};

/** A decimal or quantity field's values' shape: its unit and precision; none for other types. */
function shapeOf(f: CompiledBaseField): NumberShape | undefined {
  const n = f as unknown as NumberField;
  if (n.precision === undefined) return undefined;
  return { ...(n.unit !== undefined ? { unit: n.unit } : {}), ...n.precision };
}

/** Whether values of `was` need converting or rounding anew to be judged as `now`. */
function converts(was: CompiledBaseField, now: CompiledBaseField): boolean {
  const a = shapeOf(was);
  const b = shapeOf(now);
  return a !== undefined && b !== undefined && (a.unit?.code !== b.unit?.code || b.scale < a.scale);
}

/** An old bound as `now`'s unit and precision have it; none when no value could be past it. */
function asNew(bound: string, was: CompiledBaseField, now: CompiledBaseField): string | undefined {
  const a = shapeOf(was);
  const b = shapeOf(now);
  if (a === undefined || b === undefined) return bound;
  const r = convertValue(bound, a, b);
  return r.ok ? r.value : undefined;
}

/** The condition a value in the column breaks the new definition of `f` by, with its parameters. */
function breaks(f: CompiledBaseField, c: string): { sql: string; params: unknown[] } {
  const g = f as CompiledBaseField & { min?: string; max?: string; values?: readonly string[] };
  const params: unknown[] = [];
  const parts: string[] = [];
  if (g.min !== undefined) {
    params.push(g.min);
    parts.push(`${c} < $${params.length + 1}::numeric`);
  }
  if (g.max !== undefined) {
    params.push(g.max);
    parts.push(`${c} > $${params.length + 1}::numeric`);
  }
  if (f.type === "enum" && g.values !== undefined) {
    params.push([...g.values]);
    parts.push(`NOT (${c} = ANY($${params.length + 1}))`);
  }
  return { sql: parts.length === 0 ? "FALSE" : `(${parts.join(" OR ")})`, params };
}

/**
 * The positions of `table` (as the current version defines it, named `qualified`) breaking each
 * check's field as the draft would make it; the checks with none are left out.
 */
export async function tightenViolations(
  tx: ReadTx,
  table: CompiledBaseTable,
  qualified: string,
  checks: readonly TightenedCheck[],
): Promise<Violations[]> {
  const out: Violations[] = [];
  const { business } = physical(table);
  const state = table.time.type === "state";
  for (const k of checks) {
    const was = table.fields.find((f) => f.id === k.field.id);
    if (was === undefined) continue;
    // Values are counted as stored: with the unit or the precision changed they would have to be
    // converted first, which comes with building a version. Compiling refuses such a draft; a
    // check reaching here with one is refused the same way.
    if (converts(was, k.field))
      throw new SchemaDraftError(
        "not_in_this_version",
        "counting converted values is not implemented",
        {
          reason: "not_implemented",
          param: k.path,
        },
      );
    const c = column(was);
    const id = state ? "entity_id" : "row_id";
    const { sql, params } = breaks(k.field, c);
    const r = await tx.query<{ id: string; n: unknown }>(
      `SELECT id, count(*) OVER () AS n FROM (
         SELECT DISTINCT ${id} AS id FROM ${business}
         WHERE ${c} IS NOT NULL AND ${sql} ${state ? "" : "AND NOT revoked"}
       ) x ORDER BY id LIMIT $1`,
      [BACKFILL_SAMPLES, ...params] as never,
    );
    if (r.rows.length === 0) continue;
    out.push({
      path: k.path,
      rows: Number(r.rows[0]?.n),
      samples: r.rows.map(
        (x): TargetRef =>
          state ? { table: qualified, entity: x.id } : { table: qualified, row: x.id },
      ),
    });
  }
  return out;
}

/**
 * Where a check's field is in the draft document as submitted (`tables/<i>/fields/<j>`), as the
 * finding names it at submission: the document lists only the tables it changes, so the position in
 * the compiled definition is no position in it. Matched as the compiler matches (07 «字段匹配规则»):
 * by ID where the document gives one, else by the name it gives, which is the name after the change.
 * The compiled position when the document has no such field (a draft that compiled has it).
 */
export function draftPath(document: unknown, next: CompiledSchema, check: TightenedCheck): string {
  const table = next.tables.find((t) => t.id === check.table);
  const tables = (document as { tables?: unknown } | null)?.tables;
  if (table === undefined || !Array.isArray(tables)) return check.path;
  const matches = (x: unknown, id: string, name: string): boolean => {
    const o = x as { id?: unknown; name?: unknown } | null;
    if (typeof o?.id === "string") return o.id === id;
    return typeof o?.name === "string" && fold(o.name) === fold(name);
  };
  const i = tables.findIndex((t) => matches(t, table.id, table.name));
  const fields = (tables[i] as { fields?: unknown } | undefined)?.fields;
  if (i < 0 || !Array.isArray(fields)) return check.path;
  const j = fields.findIndex((f) => matches(f, check.field.id, check.field.name));
  return j < 0 ? check.path : `tables/${i}/fields/${j}`;
}

/**
 * The fields version `next` tightens against `current` without a `backfill`, read off the two
 * definitions (a draft's checks are not in the log): a bound raised or lowered into the old range, or
 * an enum value taken away. Optional made required always has a constant `backfill`, so is not one.
 * `path` is the field's position in `next` (`tables/<i>/fields/<j>`).
 */
export function tightenedWithout(current: CompiledSchema, next: CompiledSchema): TightenedCheck[] {
  const out: TightenedCheck[] = [];
  next.tables.forEach((t, i) => {
    const was = current.tables.find((x) => x.id === t.id);
    if (t.kind !== "base" || was?.kind !== "base") return;
    t.fields.forEach((f, j) => {
      const g = was.fields.find((x) => x.id === f.id);
      if (g === undefined || f.backfill !== undefined) return;
      const a = g as { min?: string; max?: string; values?: readonly string[] };
      const b = f as { min?: string; max?: string; values?: readonly string[] };
      // The old bounds as the new unit and precision have them (07 «收紧约束»), as compiling does.
      const amin = a.min === undefined ? undefined : asNew(a.min, g, f);
      const amax = a.max === undefined ? undefined : asNew(a.max, g, f);
      const tighter =
        (b.min !== undefined && (amin === undefined || compareDecimal(b.min, amin) > 0)) ||
        (b.max !== undefined && (amax === undefined || compareDecimal(b.max, amax) < 0)) ||
        a.values?.some((v) => !(b.values ?? []).includes(v)) === true;
      if (tighter) out.push({ table: t.id as TableId, field: f, path: `tables/${i}/fields/${j}` });
    });
  });
  return out;
}
