// `history` (docs/zh-CN/spec/04-contract.md §4 `as_of`, §10 `history`; 04-contract-types.md §4.5;
// 03-data-model/05-time.md «记录时间一侧»): the parameters by mode, the target, and `as_of` — a row
// or entity as the version table held it after every operation numbered up to S. `timeline` is in
// ./timeline.ts.
//
// `as_of` reads the version table's cells in effect at S (`rec_from ≤ S < rec_to`). A state table's
// entity has a value on a piece of business time where every required field has a value there (any
// field, when none is required) and no revoke is in effect; pieces with the same values run
// together, as the business table's rows do. An event or timeless table's row exists at S when it
// has cells then; a revoke in effect marks it revoked. Its version is the latest operation up to S
// that changed it (not a schema switch), written `h<op>.<restore count>`: it cannot be used to
// write and takes no part in the fallback.

import type {
  BizPoint,
  CompiledBaseField,
  CompiledBaseTable,
  CompiledSchema,
  FieldValue,
  Instant,
  JsonValue,
  PrincipalId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import {
  READ_ID,
  type ReadBuffer,
  type ReadEntry,
  type ReadId,
  type ReadRow,
} from "../audit/index.ts";
import {
  fold,
  get,
  has,
  instantText,
  isDenseArray,
  isJsonNumber,
  isObj,
  keysOf,
  normalizeValue,
  type Obj,
  parseDateTime,
} from "../request/index.ts";
import { computedAtRead } from "../rules/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { cellEnds, cellWithheld, withholdingIn } from "../store/readable-content.ts";
import { valueOut } from "../time/index.ts";
import { changersOf } from "./changed-by.ts";
import { danglingOf, revokedTargets } from "./dangling.ts";
import { rowDetails } from "./detail.ts";
import { type CellEnds, stretchEnds } from "./ends.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import { bizPoint, kindOf, type TableKind } from "./params.ts";
import { cmpText, correctedWithin, type KeySpec } from "./rows.ts";
import {
  correctSpansOf,
  decode,
  INSTANT_TEXT,
  logPosition,
  physical,
  restoreCount,
  selectOf,
} from "./select.ts";
import { type NamedTable, resolveTable, type Visibility, visibleSlots } from "./slots.ts";
import {
  type AsOfResult,
  invalid,
  type Marks,
  notImplemented,
  ReadError,
  type ReadWarning,
  type Row,
  type RowDetail,
  type Values,
} from "./types.ts";
import { readableCell, segmentsOf } from "./versions.ts";

export interface HistoryInput {
  readonly actor: PrincipalId;
  readonly task: string | null;
  readonly now: Instant;
  readonly visibility: Visibility;
  readonly params: unknown;
  readonly read: ReadId;
  /** The store's buffered reads: `{read}` and `{task}` find reads not yet written. */
  readonly reads: ReadBuffer;
}

const COMMON = ["table", "row", "entity", "entity_key", "mode", "limit", "position", "task"];
const KEYS: Readonly<Record<string, readonly string[]>> = {
  timeline: [...COMMON, "expand_sources"],
  as_of: [...COMMON, "as_of", "valid_at", "detail"],
  changes: [...COMMON, "since", "until"],
};
const ALL_MODE_KEYS = new Set(["expand_sources", "as_of", "valid_at", "detail", "since", "until"]);
const MAX_TASK_CHARS = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

export type HistoryMode = "timeline" | "as_of" | "changes";

/** The mode, and the parameters checked against it (`mode_mismatch` with the mode's example). */
export function historyMode(params: Obj, table: string): HistoryMode {
  const mode = has(params, "mode") ? get(params, "mode") : "timeline";
  if (mode === "composition")
    // The value is one of the contract's modes, never the caller's own text (04-contract-types §9).
    throw new ReadError("not_in_this_version", "history mode composition", {
      reason: "value",
      param: "mode",
      value: "composition",
    });
  if (mode !== "timeline" && mode !== "as_of" && mode !== "changes")
    throw invalid("malformed", "mode");
  const allowed = new Set(KEYS[mode]);
  for (const k of keysOf(params)) {
    if (allowed.has(k)) continue;
    if (ALL_MODE_KEYS.has(k)) {
      throw invalid("mode_mismatch", k, {
        example:
          mode === "as_of"
            ? { table, row: "r_…", mode: "as_of", as_of: 25 }
            : mode === "changes"
              ? { table, mode: "changes", since: 25 }
              : { table, row: "r_…" },
      });
    }
    throw invalid("malformed", k);
  }
  return mode;
}

/** The task of the call: the parameters' own, else the context's (as for `query`). */
export function taskOf(params: Obj, context: string | null): string | null {
  if (!has(params, "task")) return context;
  const v = get(params, "task");
  if (
    typeof v !== "string" ||
    v === "" ||
    !v.isWellFormed() ||
    [...v].length > MAX_TASK_CHARS ||
    CONTROL.test(v)
  )
    throw invalid("malformed", "task");
  return v;
}

export interface Target {
  readonly named: NamedTable;
  readonly table: CompiledBaseTable;
  readonly kind: TableKind;
  /** Row or entity ID. */
  readonly id: string;
}

/** `changes` without a target: the whole table. */
export type TableTarget = Omit<Target, "id"> & { readonly id?: undefined };

/** The target (04-contract-types §1.5): exactly one of `row`, `entity`, `entity_key`. */
export async function historyTarget(
  tx: ReadTx,
  params: Obj,
  visibility: Visibility,
): Promise<Target>;
/**
 * `changes` (04-contract.md §10 `history`): the target, or none: the whole table, which must be
 * in the visible range like any table. A derived table is `derived_table`. In `timeline` and
 * `as_of`, a derived table computed when read is `not_in_this_version`.
 */
export async function historyTarget(
  tx: ReadTx,
  params: Obj,
  visibility: Visibility,
  mode: "changes",
): Promise<Target | TableTarget>;
export async function historyTarget(
  tx: ReadTx,
  params: Obj,
  visibility: Visibility,
  mode?: "changes",
): Promise<Target | TableTarget> {
  const slots = await visibleSlots(tx, visibility);
  const named = resolveTable(get(params, "table"), "table", slots);
  if (named.table.kind === "derived") {
    if (mode === "changes") throw invalid("derived_table", "table");
    // Computed when read: no operation made its rows, and it has no state as of a record time.
    if (computedAtRead(named.table))
      throw new ReadError("not_in_this_version", "history of a derived table computed when read", {
        reason: "value",
        param: "table",
      });
    throw notImplemented("table", "history of a derived table");
  }
  const t = named.table;
  const kind = kindOf(t);
  const given = (["row", "entity", "entity_key"] as const).filter((k) => has(params, k));
  const [first, second] = given;
  if (second !== undefined) throw invalid("mutually_exclusive", second);
  if (first === undefined) {
    if (mode === "changes") return { named, table: t, kind };
    throw invalid("missing", kind === "state" ? "entity" : "row");
  }
  const v = get(params, first);
  const { versions } = physical(t);
  const known = async (id: string) =>
    (await tx.query(`SELECT 1 FROM ${versions} WHERE row_id = $1 LIMIT 1`, [id])).rows.length > 0;
  // Located by key, the target is still an entity (04-contract-types §9 `not_found`).
  const notFound = () =>
    new ReadError("not_found", `no such ${first}`, {
      reason: first === "entity_key" ? "entity" : first,
      param: first,
    });
  if (first === "row") {
    if (kind === "state") throw invalid("malformed", "row");
    if (typeof v !== "string" || !/^r_[0-9A-HJKMNP-TV-Z]{26}$/.test(v))
      throw invalid("malformed", "row");
    if (!(await known(v))) throw notFound();
    return { named, table: t, kind, id: v };
  }
  if (kind !== "state") throw invalid("not_state_table", first);
  if (first === "entity") {
    if (typeof v !== "string" || !/^e_[0-9A-HJKMNP-TV-Z]{26}$/.test(v))
      throw invalid("malformed", "entity");
    if (!(await known(v))) throw notFound();
    return { named, table: t, kind, id: v };
  }
  // entity_key: every key field, by name; the entity whose key cells hold these values.
  if (t.time.type !== "state" || t.entity_key === undefined)
    throw invalid("malformed", "entity_key");
  if (!isObj(v)) throw invalid("malformed", "entity_key");
  const keyIds = new Set<string>(t.entity_key);
  const named_: Map<string, CompiledBaseField> = new Map();
  for (const k of keysOf(v)) {
    const f = t.fields.find((x) => fold(x.name) === fold(k));
    if (f === undefined || !keyIds.has(f.id) || named_.has(f.id))
      throw invalid("malformed", `entity_key/${k}`);
    named_.set(f.id, f);
  }
  for (const id of keyIds) {
    if (!named_.has(id)) {
      const f = t.fields.find((x) => x.id === id);
      throw invalid("missing", `entity_key/${f?.name ?? id}`);
    }
  }
  let ids: Set<string> | undefined;
  for (const [, f] of named_) {
    const k = keysOf(v).find((x) => fold(x) === fold(f.name)) as string;
    const r = normalizeValue(f, get(v, k), { op: 0, name: f.name, zone: named.slot.timezone });
    if (!r.ok) throw invalid("malformed", `entity_key/${k}`);
    // Compare each stored key value, decoded from all its columns (a zoned date-time has two: the
    // instant and the zone), with the one given. Not a cell whose value a deletion still pending
    // removed (03-data-model/03-deletion «版本表»): a key that only deleted content held answers
    // as one never held, else a guess could tell it was.
    const columns = selectOf(f);
    const cells = await tx.query<Record<string, string | null>>(
      `SELECT DISTINCT v.row_id, ${columns.map((c, i) => `${c} AS v${i}`).join(", ")}
         FROM ${versions} v WHERE v.field_id = $1
           AND NOT ${cellWithheld("v", await withholdingIn(tx))}`,
      [f.id],
    );
    const want = canonicalize(r.value as JsonValue);
    const hit = new Set(
      cells.rows
        .filter((c) => {
          const vs = columns.map((_, i) => c[`v${i}`]);
          return vs[0] !== null && canonicalize(decode(f, vs) as JsonValue) === want;
        })
        .map((c) => c["row_id"] as string),
    );
    ids = ids === undefined ? hit : new Set([...ids].filter((x) => hit.has(x)));
  }
  const [id, other] = [...(ids ?? [])].sort(cmpText);
  if (id === undefined) throw notFound();
  if (other !== undefined) throw new ReadError("internal", "two entities with one key");
  return { named, table: t, kind, id };
}

// --- reads --------------------------------------------------------------------------------------

/** A read as `as_of: {read}` / `{task}` use it: where it stood in the log, and what it asked. */
export interface FoundRead {
  readonly read: ReadId;
  readonly actor: string;
  readonly task: string | null;
  readonly at: string;
  readonly pos: number;
  readonly slot: string | null;
  readonly table: string | null;
  readonly valid: JsonValue | undefined;
}

const fromEntry = (e: ReadEntry): FoundRead => ({
  read: e.read,
  actor: e.actor,
  task: e.task,
  at: e.at,
  pos: e.pos,
  slot: e.slot ?? null,
  table: e.table ?? null,
  valid: e.valid,
});

type ReadRowSql = {
  read_id: string;
  actor: string;
  task: string | null;
  at: string;
  pos: unknown;
  slot_id: string | null;
  table_id: string | null;
  valid: string | null;
};
const fromRow = (r: ReadRowSql): FoundRead => ({
  read: r.read_id as ReadId,
  actor: r.actor,
  task: r.task,
  at: r.at,
  pos: Number(r.pos),
  slot: r.slot_id,
  table: r.table_id,
  valid: r.valid === null ? undefined : (JSON.parse(r.valid) as JsonValue),
});

/** A read by its ID: buffered or written. */
export async function findRead(
  tx: ReadTx,
  buffer: ReadBuffer,
  id: ReadId,
): Promise<FoundRead | undefined> {
  const b = buffer.find(id);
  if (b !== undefined) return fromEntry(b);
  const r = await tx.query<ReadRowSql>(
    "SELECT read_id, actor, task, at, pos, slot_id, table_id, valid FROM read_log WHERE read_id = $1",
    [id],
  );
  const [row] = r.rows;
  return row === undefined ? undefined : fromRow(row);
}

/**
 * The actor's reads under a task that read the target, latest first (buffered ones are later). Reads
 * as of a record time do not count: what they read was not in effect (04-contract §2).
 */
export async function readsOfTask(
  tx: ReadTx,
  buffer: ReadBuffer,
  actor: string,
  task: string,
  table: string,
  target: string,
): Promise<FoundRead[]> {
  const r = await tx.query<ReadRowSql>(
    `SELECT l.read_id, l.actor, l.task, l.at, l.pos, l.slot_id, l.table_id, l.valid FROM read_log l
     WHERE l.actor = $1 AND l.task = $2 AND NOT l.historical AND EXISTS (SELECT 1 FROM read_log_rows x
       WHERE x.read_id = l.read_id AND x.table_id = $3 AND x.target = $4)
     ORDER BY l.n DESC`,
    [actor, task, table, target],
  );
  const buffered = buffer
    .entries()
    .filter(
      (e) =>
        e.actor === actor &&
        e.task === task &&
        e.historical !== true &&
        e.rows.some((x) => x.table === table && x.target === target),
    )
    .reverse()
    .map(fromEntry);
  return [...buffered, ...r.rows.map(fromRow)];
}

/** Every read of the target's versions, by anyone, latest first (buffered ones are later), with
 * the version each read of it. */
export async function readsOfTarget(
  tx: ReadTx,
  buffer: ReadBuffer,
  table: string,
  target: string,
): Promise<(FoundRead & { readonly ver: number | null })[]> {
  const r = await tx.query<ReadRowSql & { ver_op: unknown }>(
    `SELECT l.read_id, l.actor, l.task, l.at, l.pos, l.slot_id, l.table_id, l.valid, x.ver_op
     FROM read_log l JOIN read_log_rows x ON x.read_id = l.read_id
     WHERE x.table_id = $1 AND x.target = $2
     ORDER BY l.n DESC`,
    [table, target],
  );
  const buffered = buffer
    .entries()
    .flatMap((e) => {
      const row = e.rows.find((x) => x.table === table && x.target === target);
      return row === undefined ? [] : [{ ...fromEntry(e), ver: row.ver?.op ?? null }];
    })
    .reverse();
  return [
    ...buffered,
    ...r.rows.map((x) => ({ ...fromRow(x), ver: x.ver_op === null ? null : Number(x.ver_op) })),
  ];
}

// --- as_of --------------------------------------------------------------------------------------

/** The record point (04-contract §4 `as_of`): the latest operation numbered up to it. */
export async function recordPoint(
  tx: ReadTx,
  v: unknown,
  param: string,
  /** The least operation number taken: 1, or 0 where "from the start" is a point (`changes`). */
  least = 1,
): Promise<{ seq: number; at: string }> {
  const n =
    typeof v === "number"
      ? v
      : isJsonNumber(v)
        ? Number(v.text)
        : typeof v === "string"
          ? undefined
          : NaN;
  let op: number;
  if (n !== undefined) {
    if (!Number.isSafeInteger(n) || n < least) throw invalid("malformed", param);
    const r = await tx.query<{ op: unknown }>("SELECT max(op) AS op FROM events WHERE op <= $1", [
      n,
    ]);
    op = Number(r.rows[0]?.op ?? 0);
  } else {
    const p = parseDateTime(v as string, "UTC", false);
    if (!p.ok || p.assumed) throw invalid("malformed", param);
    const r = await tx.query<{ op: unknown }>(
      "SELECT max(op) AS op FROM events WHERE seq = op AND at <= $1",
      [instantText(p.epochMs)],
    );
    op = Number(r.rows[0]?.op ?? 0);
  }
  const at = await tx.query<{ at: string }>("SELECT at FROM events WHERE seq = $1", [op]);
  return { seq: op, at: at.rows[0]?.at ?? "" };
}

type Cell = {
  field_id: string;
  vf: string | null;
  vt: string | null;
  rec_from: unknown;
  intent: string;
  revoked: boolean | null;
  /** A field cell saying the entity has no value there: what `segmentsOf` reads for has-value. */
  no_value: boolean | null;
  /** The operation of the contribution that gave the cell. */
  src_op: unknown;
  /** Its value came from a contribution no longer readable: not given (./versions.ts). */
  withheld: boolean | null;
  /** Where its ends came from (`cellEnds`): null when nothing is withheld in this tenant. */
  ends: CellEnds | null;
} & Record<string, unknown>;

/** The cells of the target in effect after operation `s`. */
async function cellsAsOf(tx: ReadTx, t: CompiledBaseTable, id: string, s: number): Promise<Cell[]> {
  const { versions } = physical(t);
  const state = t.time.type === "state";
  const g = state && t.time.granularity === "date";
  const interval = state
    ? g
      ? "valid_from::text AS vf, valid_to::text AS vt"
      : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
    : "NULL AS vf, NULL AS vt";
  const cols = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));
  const withholding = await withholdingIn(tx);
  const r = await tx.query<Cell>(
    `SELECT field_id, ${interval}, rec_from, intent, revoked, no_value,
       (SELECT e.op FROM events e WHERE e.seq = v.src_event) AS src_op,
       ${cellWithheld("v", withholding)} AS withheld,
       ${state ? cellEnds("v", withholding) : "NULL"} AS ends, ${cols.join(", ")}
     FROM ${versions} v
     WHERE row_id = $1 AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $2)`,
    [id, s],
  );
  return r.rows.map(readableCell);
}

const cellValue = (f: CompiledBaseField, c: Cell): FieldValue =>
  decode(
    f,
    selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
  );

/** The latest operation up to `s` that changed the target (not a schema switch); `corrected` then. */
async function versionAsOf(
  tx: ReadTx,
  t: CompiledBaseTable,
  id: string,
  s: number,
): Promise<{ op: number; corrected: boolean } | undefined> {
  const { versions } = physical(t);
  const r = await tx.query<{ v: unknown; c: boolean | null }>(
    `SELECT max(rec_from) AS v, bool_or(intent = 'correct') AS c FROM ${versions}
     WHERE row_id = $1 AND rec_from <= $2 AND intent <> 'schema_switch'`,
    [id, s],
  );
  const x = r.rows[0];
  return x === undefined || x.v === null ? undefined : { op: Number(x.v), corrected: x.c === true };
}

/** The schema version of the slot after operation `s`. */
async function svAsOf(tx: ReadTx, slot: string, s: number, current: number): Promise<number> {
  // The version in effect after operation `s`: the last one switched to in an operation up to it
  // (08 «状态机»: a version takes effect at its switch, not at its compilation; a confirmed draft
  // is compiled in one operation and switched in a later one).
  // Before the slot's first version took effect: its first version (04-contract `history` as_of: the
  // answer says the sv of the time; there was none, and the rows are none either).
  const r = await tx.query<{ sv: unknown }>(
    `SELECT COALESCE(
       (SELECT max(v.sv) FROM schema_versions v JOIN events e ON e.seq = v.switched_seq
        WHERE v.slot_id = $1 AND e.op <= $2 AND v.state IN ('current', 'retired')),
       (SELECT min(v.sv) FROM schema_versions v
        WHERE v.slot_id = $1 AND v.switched_seq IS NOT NULL AND v.state IN ('current', 'retired'))
     ) AS sv`,
    [slot, s],
  );
  const sv = r.rows[0]?.sv;
  return sv === null || sv === undefined ? current : Number(sv);
}

/**
 * The slot's name and the table as a version defines them, for naming what was read
 * (08 «状态机 · 已退役»: by that version's compiled definition): `then`, that version's definition;
 * `now`, the slot's name and the table as the current version has them. Where that version answers
 * from the same physical table as the current one (a rename, a description). A table answered then
 * by another physical table that is empty (`thenEmpty`: restructured while never written,
 * 08 «物理做法») had no row then: named as that version has it. Another table rebuilt since is
 * `not_in_this_version` (reading retired physical tables comes with the migrations that make them);
 * a table not in that version had no row then and is named as now; a definition missing is
 * `internal`.
 */
export function namedAsOf(
  then: CompiledSchema | undefined,
  now: { readonly slot: string; readonly table: CompiledBaseTable },
  thenEmpty = false,
): { slot: string; table: CompiledBaseTable } {
  // A version switched to is in the log with its definition: none read is the log at odds with
  // itself, not a reason to name it as now.
  if (then === undefined)
    throw new ReadError("internal", "a version switched to without its compiled definition", {
      reason: "inconsistent",
    });
  const was = then.tables.find((x) => x.id === now.table.id);
  // A table that version has not: no row of it then, nothing to name otherwise.
  if (was === undefined || was.kind !== "base") return { slot: now.slot, table: now.table };
  // Another physical table answers for that version: reading it comes with the migrations that
  // build it; naming the current one's rows by it would be wrong.
  if (was.physical.table !== now.table.physical.table && !thenEmpty)
    throw new ReadError(
      "not_in_this_version",
      "as_of on a version answered by another physical table",
      {
        reason: "not_implemented",
        param: "as_of",
      },
    );
  return { slot: then.name, table: was };
}

/** A base table's physical name, as `baseTableDdl` makes it: checked before it goes into SQL. */
const PHYSICAL_NAME = /^t_t[1-9][0-9]{0,8}_v[1-9][0-9]{0,8}$/;

/** `namedAsOf` with version `sv`'s definition read from the log's content. */
async function shownAs(
  tx: ReadTx,
  slot: { slot: string; name: string; sv: number },
  t: CompiledBaseTable,
  sv: number,
): Promise<{ slot: string; table: CompiledBaseTable }> {
  const now = { slot: slot.name, table: t };
  if (sv === slot.sv) return now;
  const r = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1 AND v.sv = $2`,
    [slot.slot, sv],
  );
  const body = r.rows[0]?.body;
  const then = body == null ? undefined : (JSON.parse(body) as CompiledSchema);
  // Another physical table then: an empty one (the table restructured while never written) had
  // no row then, whatever the current one holds now.
  const was = then?.tables.find((x) => x.id === t.id);
  let thenEmpty = false;
  if (was !== undefined && was.kind === "base" && was.physical.table !== t.physical.table) {
    if (!PHYSICAL_NAME.test(was.physical.table))
      throw new ReadError("internal", "not a physical table name", { reason: "inconsistent" });
    const rows = await tx.query<{ any: boolean }>(
      `SELECT EXISTS (SELECT 1 FROM "${was.physical.table}") AS any`,
    );
    thenEmpty = rows.rows[0]?.any === false;
  }
  return namedAsOf(then, now, thenEmpty);
}

/** A row's values by the names of `t`'s fields: only the fields `t` has. */
export const byName = (
  t: CompiledBaseTable,
  values: Readonly<Record<string, FieldValue>>,
): Values => {
  const out: Record<string, Values[string]> = Object.create(null);
  // A field not there is withheld (a value a removed contribution gave): not given.
  for (const f of t.fields) if (f.id in values) out[f.name] = valueOut(values[f.id] ?? null);
  return out;
};

const dayBefore = (d: string): string => {
  const [y, m, day] = d.split("-").map(Number) as [number, number, number];
  const x = new Date(0);
  x.setUTCFullYear(y, m - 1, day - 1);
  return x.toISOString().slice(0, 10);
};

export interface HistoryOutput<R> {
  readonly result: R;
  readonly entry: ReadEntry;
}

/** `history` with `mode: "as_of"`. */
export async function asOfInTx(
  tx: ReadTx,
  input: HistoryInput,
  params: Obj,
  target: Target,
): Promise<HistoryOutput<AsOfResult>> {
  const t = target.table;
  const task = taskOf(params, input.task);
  // `detail: "detailed"`: each row with its `RowDetail`, without premises (04-contract §10
  // `as_of`: the state of a premise is not kept by record time).
  let detailed = false;
  if (has(params, "detail")) {
    const d = get(params, "detail");
    if (d === "detailed") detailed = true;
    else if (d !== "concise") throw invalid("malformed", "detail");
  }
  const warnings: ReadWarning[] = [];
  if (!has(params, "as_of")) throw invalid("missing", "as_of");
  const asOf = get(params, "as_of");
  const latest = await logPosition(tx);
  const restore = await restoreCount(tx);
  // The position's digest holds the caller's parameters only: the record point they resolve to is
  // fixed on the first page and carried by the position (04-contract §15).
  const given =
    typeof asOf === "number" || typeof asOf === "string"
      ? asOf
      : isJsonNumber(asOf)
        ? Number(asOf.text)
        : isObj(asOf)
          ? { read: get(asOf, "read") ?? null, task: get(asOf, "task") ?? null }
          : null;
  const identity = digest({
    mode: "as_of",
    table: t.id,
    target: target.id,
    as_of: given as JsonValue,
    valid_at: has(params, "valid_at") ? (get(params, "valid_at") as JsonValue) : null,
  });
  // A state entity's stretches by their start, then an ordinal for those whose start is withheld
  // (after the others, in their real order; the decision on interval ends, §4): position format 2.
  const specs: KeySpec[] =
    target.kind === "state"
      ? [
          { type: "plain", dir: "asc" },
          { type: "count", dir: "asc" },
        ]
      : [{ type: "text", dir: "asc" }];
  const version = target.kind === "state" ? 2 : 1;
  const position = await positionOf(tx, params, {
    identity,
    specs,
    restoreCount: restore,
    latest,
    condition: true,
    version,
  });
  let point: { seq: number; at: string | undefined };
  let condition: { at?: string; during?: readonly [string, string | null] } | undefined;
  let otherReads: AsOfResult["other_reads"];
  const recordedAt = async (seq: number) =>
    (await tx.query<{ at: string }>("SELECT at FROM events WHERE seq = $1", [seq])).rows[0]?.at;
  if (position !== undefined) {
    point = { seq: position.seq, at: await recordedAt(position.seq) };
    condition = position.condition;
  } else if (isObj(asOf)) {
    const keys = keysOf(asOf);
    if (keys.length !== 1 || (keys[0] !== "read" && keys[0] !== "task"))
      throw invalid("malformed", "as_of");
    let found: FoundRead | undefined;
    if (keys[0] === "read") {
      const id = get(asOf, "read");
      if (typeof id !== "string" || !READ_ID.test(id)) throw invalid("malformed", "as_of/read");
      found = await findRead(tx, input.reads, id as ReadId);
      // A read out of the visible range is one that does not exist (04-contract §10;
      // 04-write-and-read «可见范围»): a read of a table not visible, or of a slot not visible.
      // A read of any visible table, in any slot, or of no table, gives its position.
      const slots = found === undefined ? [] : await visibleSlots(tx, input.visibility);
      const slot = found?.slot == null ? undefined : slots.find((x) => x.slot === found?.slot);
      const visible =
        found !== undefined &&
        (found.slot === null ||
          (slot !== undefined &&
            (found.table === null || slot.tables.some((x) => x.id === found?.table))));
      if (!visible)
        throw new ReadError("not_found", "no such read", { reason: "read", param: "as_of/read" });
    } else {
      const want = get(asOf, "task");
      if (typeof want !== "string" || want === "") throw invalid("malformed", "as_of/task");
      const reads = await readsOfTask(tx, input.reads, input.actor, want, t.id, target.id);
      found = reads[0];
      if (found === undefined)
        throw new ReadError("not_found", "no read under this task", {
          reason: "read",
          param: "as_of/task",
        });
      otherReads = reads.slice(1).map((r) => ({ read: r.read, seq: r.pos as never, at: r.at }));
    }
    const read = found as FoundRead;
    point = { seq: read.pos, at: await recordedAt(read.pos) };
    // The read's business time condition, only when it read this table.
    if (read.slot === target.named.slot.slot && read.table === t.id && isObj(read.valid)) {
      const v = read.valid as Obj;
      const at = get(v, "at");
      const d = get(v, "during");
      if (typeof at === "string") condition = { at };
      else if (isDenseArray(d) && typeof d[0] === "string")
        condition = { during: [d[0], typeof d[1] === "string" ? d[1] : null] };
    }
  } else {
    const r = await recordPoint(tx, asOf, "as_of");
    point = { seq: r.seq, at: r.at === "" ? undefined : r.at };
  }
  let valid: JsonValue | undefined =
    condition === undefined
      ? undefined
      : condition.at !== undefined
        ? { at: condition.at }
        : { during: [...(condition.during as [string, string | null])] };

  // Business time: given, else the read's own.
  let at: string | undefined;
  let during: [string, string | null] | undefined;
  if (has(params, "valid_at")) {
    if (target.kind === "event")
      throw invalid("event_table_valid_at", "valid_at", { example: { mode: "as_of" } });
    if (target.kind === "timeless") throw invalid("no_time_table", "valid_at");
    const g = t.time.type === "state" ? t.time.granularity : "date";
    at = bizPoint(get(params, "valid_at"), "valid_at", g, target.named.slot.timezone, warnings);
    valid = { at };
  } else if (target.kind === "state" && condition !== undefined) {
    if (condition.at !== undefined) at = condition.at;
    if (condition.during !== undefined) during = [condition.during[0], condition.during[1]];
  }

  const recorded = await versionAsOf(tx, t, target.id, point.seq);
  // Named as the version in effect then defines them: the answer's `sv`, its names and its fields
  // are of one version.
  const sv = await svAsOf(tx, target.named.slot.slot, point.seq, target.named.slot.sv);
  const shown = await shownAs(tx, target.named.slot, t, sv);
  const qualified = `${shown.slot}.${shown.table.name}`;
  const rows: Row[] = [];
  // Each row's paging keys; and whether anything a deletion removed was left out of the result.
  const keys: (string | number | null)[][] = [];
  let partial = false;
  // What each row's detail is worked out from: its values by field ID and its stretch.
  const sources: {
    values: Readonly<Record<string, FieldValue>>;
    from?: string;
    to?: string | null;
  }[] = [];
  if (recorded !== undefined) {
    const cells = await cellsAsOf(tx, t, target.id, point.seq);
    const ver = `h${recorded.op}.${restore}`;
    // Ref values naming a target revoked then (`dangling_ref`), in tables the caller can see.
    const gone = (values: Readonly<Record<string, unknown>>[]) =>
      revokedTargets(
        tx,
        t,
        target.named.slot.tables,
        values.map((v) => ({ values: v })),
        point.seq,
      );
    if (target.kind === "state") {
      const date = t.time.type === "state" && t.time.granularity === "date";
      const correct = (await correctSpansOf(tx, t, [target.id], point.seq)).get(target.id);
      const readAll = new Set<string>(t.fields.map((f) => f.id));
      const segments = segmentsOf(t, cells);
      // Which ends came from content a deletion still pending removed: judged on the stretches
      // as merged (the decision on interval ends, §1, §2).
      const ends = stretchEnds(t, cells, segments);
      const revoked = await gone(segments.map((s) => s.values));
      // Each stretch kept, with its ends; in order: by start, those whose start is withheld after
      // the others, in their real order (§4).
      const kept: {
        s: (typeof segments)[number];
        fromWithheld: boolean;
        toWithheld: boolean;
      }[] = [];
      for (const [i, s] of segments.entries()) {
        const { fromWithheld, toWithheld } = ends[i] as (typeof ends)[number];
        // Nothing left: no value given and no start, only an end that would draw the removed
        // write's range again (§2).
        if (fromWithheld && Object.values(s.values).every((x) => x === null)) {
          partial = true;
          continue;
        }
        // The business time condition, by the ends given only: one an end withheld would decide
        // does not hit, and the result says something was left out (§4).
        const known = (ok: boolean | undefined) => {
          if (ok === undefined) partial = true;
          return ok === true;
        };
        const startsBy = (p: string): boolean | undefined =>
          fromWithheld ? undefined : s.from <= p;
        const endsAfter = (p: string): boolean | undefined =>
          toWithheld ? undefined : s.to === null || p < s.to;
        const both = (a: boolean | undefined, b: boolean | undefined) =>
          a === false || b === false
            ? false
            : a === undefined || b === undefined
              ? undefined
              : true;
        if (at !== undefined && !known(both(startsBy(at), endsAfter(at)))) continue;
        // A stretch is never empty: a given start at or after the window's start already puts its
        // end after it, and a given end at or before the window's end already puts its start
        // before it.
        const endsAfterStart = (p: string): boolean | undefined =>
          !fromWithheld && p <= s.from ? true : endsAfter(p);
        const startsBeforeEnd = (p: string | null): boolean | undefined =>
          p === null || (!toWithheld && s.to !== null && s.to <= p)
            ? true
            : fromWithheld
              ? undefined
              : s.from < p;
        if (
          during !== undefined &&
          !known(both(endsAfterStart(during[0]), startsBeforeEnd(during[1])))
        )
          continue;
        kept.push({ s, fromWithheld, toWithheld });
      }
      const ordered = [
        ...kept.filter((x) => !x.fromWithheld),
        ...kept.filter((x) => x.fromWithheld),
      ];
      let ordinal = 0;
      for (const { s, fromWithheld, toWithheld } of ordered) {
        sources.push({ values: s.values, from: s.from, to: s.to });
        keys.push([fromWithheld ? null : s.from, fromWithheld ? ordinal++ : null]);
        rows.push({
          table: qualified,
          entity: target.id as never,
          ver,
          historical: true,
          values: byName(shown.table, s.values),
          // An end that came from content a deletion still pending removed is left out (§2).
          ...(fromWithheld ? {} : { valid_from: s.from as BizPoint }),
          ...(toWithheld ? {} : { valid_to: s.to as BizPoint | null }),
          ...(date && s.to !== null && !toWithheld
            ? { valid_to_inclusive: dayBefore(s.to) as never }
            : {}),
          // By segment, as query gives it: every field is read.
          ...((): { marks?: Marks } => {
            const dangling = danglingOf(t, s.values, revoked);
            const m: Marks = {
              ...(correctedWithin(correct, readAll, s.from, s.to)
                ? { corrected: true as const }
                : {}),
              ...(dangling.length > 0 ? { dangling_ref: dangling } : {}),
              // A value or an end a removed contribution gave then: not given (03-deletion «版本表»).
              ...(s.withheld.length > 0 || fromWithheld || toWithheld
                ? { partially_deleted: true as const }
                : {}),
            };
            return Object.keys(m).length > 0 ? { marks: m } : {};
          })(),
        });
      }
    } else if (cells.length > 0) {
      const values: Record<string, FieldValue> = Object.create(null);
      let withheld = false;
      for (const f of t.fields) {
        const c = cells.find((x) => x.field_id === f.id);
        // A value a removed contribution gave then: not given (03-deletion «版本表»).
        if (c?.withheld === true) withheld = true;
        else values[f.id] = c === undefined ? null : cellValue(f, c);
      }
      const revoke = cells.find((c) => c.field_id === "existence" && c.revoked === true);
      const dangling = danglingOf(t, values, await gone([values]));
      const marks: Marks = {
        ...(recorded.corrected ? { corrected: true as const } : {}),
        ...(dangling.length > 0 ? { dangling_ref: dangling } : {}),
        ...(withheld ? { partially_deleted: true as const } : {}),
        // The revoke's own operation, not when its cell was last cut.
        ...(revoke !== undefined ? { revoked: { seq: Number(revoke.src_op) as never } } : {}),
      };
      sources.push({ values });
      keys.push([target.id]);
      rows.push({
        table: qualified,
        row: target.id as never,
        ver,
        historical: true,
        values: byName(shown.table, values),
        ...(Object.keys(marks).length > 0 ? { marks } : {}),
      });
    }
  }
  // The detail of each row, as of the point; the rows a ref summary read, for the read record.
  let detailRead: ReadRow[] = [];
  if (detailed && recorded !== undefined && rows.length > 0) {
    const d = await rowDetails(tx, {
      table: t,
      fields: shown.table.fields as readonly CompiledBaseField[],
      visible: target.named.slot.tables,
      page: sources.map((x) => ({
        id: target.id,
        ver: Number(recorded.op),
        values: x.values,
        ...(x.from !== undefined ? { validFrom: x.from, validTo: x.to ?? null } : {}),
      })),
      asOf: point.seq,
      at: (point.at ?? input.now) as Instant,
      zone: target.named.slot.timezone,
      restoreCount: restore,
    });
    for (const [i, r] of rows.entries()) {
      // A ref summary that left out a value a removed contribution gave (03-deletion «版本表»).
      const marks = d.partialRows.has(i)
        ? { marks: { ...r.marks, partially_deleted: true as const } }
        : {};
      rows[i] = { ...r, ...marks, detail: d.details[i] as RowDetail };
    }
    detailRead = d.read;
  }
  // Who made this version, when not the caller: every row here is of the one version.
  if (recorded !== undefined && rows.length > 0) {
    const by = (await changersOf(tx, [recorded.op], input.actor)).get(Number(recorded.op));
    if (by !== undefined) for (const [i, r] of rows.entries()) rows[i] = { ...r, changed_by: by };
  }
  const page = pageAfter(
    rows.map((item, i) => ({ item, keys: keys[i] as (string | number | null)[] })),
    {
      specs,
      identity,
      position,
      // The record point resolved on the first page, and the read's condition, carried on; and the
      // log position then, which a deletion changed since is compared with (04-contract §15).
      seq: point.seq,
      logAt: position?.logAt ?? latest,
      at: position?.at ?? input.now,
      restoreCount: restore,
      limit: limitOf(params),
      ...(condition !== undefined ? { condition } : {}),
      version,
    },
  );
  // A row marked, or a stretch left out for what a deletion removed: the result says so, even
  // when it has no row left to carry the mark (§4).
  if (rows.some((r) => r.marks?.partially_deleted === true)) partial = true;
  const result: AsOfResult = {
    mode: "as_of",
    // Before any operation: seq 0 and no recorded time.
    as_of: {
      seq: point.seq as never,
      ...(point.at !== undefined && point.seq > 0 ? { recorded_at: point.at } : {}),
    },
    sv,
    timezone: target.named.slot.timezone,
    total: rows.length,
    ...(page.next !== undefined ? { next_position: page.next } : {}),
    rows: page.page,
    ...(partial ? { partially_deleted: true as const } : {}),
    // The other reads: on the first page only.
    ...(otherReads !== undefined && otherReads.length > 0 ? { other_reads: otherReads } : {}),
  };
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    // The state read is the record point's; not a read of versions in effect (04-contract §2).
    pos: point.seq as never,
    historical: true,
    operation: "history",
    slot: target.named.slot.slot,
    sv: target.named.slot.sv,
    table: t.id as TableId,
    shape: canonicalize({ mode: "as_of", table: t.id, target: target.id }),
    ...(valid !== undefined ? { valid } : {}),
    // A historical version: recorded, but not read for the fallback (04-contract §2).
    rows: [
      ...(recorded === undefined
        ? []
        : [
            {
              table: t.id as TableId,
              target: target.id,
              ver: { op: recorded.op as never, restoreCount: restore },
            },
          ]),
      // The rows a ref summary read (`detail: "detailed"`), as of the same point.
      ...detailRead,
    ],
    coarse: [],
    lastRead: [],
  };
  if (warnings.length > 0) Object.assign(result, { warnings });
  return { result, entry };
}
