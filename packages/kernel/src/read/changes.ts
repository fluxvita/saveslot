// `history` with `mode: "changes"` (docs/zh-CN/spec/04-contract.md §10 `history`; 04-contract-types.md
// §4.5 `ChangesResult`; 03-data-model/05-time.md «记录时间一侧»): what changed in a table, or in one
// row or entity, between two record points: after `since` (exclusive) up to `until` (inclusive).
//
// A change is read from the version table, as `as_of` reads it: for each operation in the window
// that opened or closed a cell of a row, the row as it stood after the operation against as it stood
// before it, field by field. What is reported is the values that differ, never the physical cells:
// a write that splits a state table's segment cuts the cells into pieces, and the pieces that keep
// their values are no change. A state table's field is given by stretch of business time (the
// stretches where before and after differ, those that run together as one); the event and timeless
// tables' by field. The row's existence is `*`, given when a revoke or its taking back changes it.
// An operation's intent is the one its cells carry (`VersionIntent`: deletions and schema switches
// too), as `timeline` has it. One entry is one operation's change to one row or entity.
//
// `since: "my_last_read"` is the position of the latest read this connection counts for the call,
// under the call's task, by the read's scope (04-contract §10): a whole-table call counts the reads
// of the table, a call on a row the table's and the row's. None is `read_first`. The call is itself
// a read of what it was about, at `until`, once it has given the whole window: the next
// `my_last_read` starts after it.

import type {
  CompiledBaseTable,
  FieldValue,
  JsonValue,
  TableId,
  VersionIntent,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadBuffer, ReadEntry } from "../audit/index.ts";
import { stateFromCells, targetDelta } from "../delta/index.ts";
import { actorsNow } from "../pending/index.ts";
import { get, has, isJsonNumber, type Obj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { cellWithheld, withholdingIn } from "../store/readable-content.ts";
import { type ValueOut, valueOut } from "../time/index.ts";
import {
  type HistoryInput,
  type HistoryOutput,
  recordPoint,
  type TableTarget,
  type Target,
  taskOf,
} from "./history.ts";
import { intervalOf } from "./interval.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import type { KeySpec } from "./rows.ts";
import { decode, INSTANT_TEXT, logPosition, physical, restoreCount, selectOf } from "./select.ts";
import {
  type Actor,
  type ChangedField,
  type ChangeEntry,
  type ChangesResult,
  type Interval,
  invalid,
  ReadError,
} from "./types.ts";
import { type RowCell, readableCell } from "./versions.ts";

type Cell = RowCell & {
  row_id: string;
  rec_to: unknown;
  intent: string;
  src_event: unknown;
};

/**
 * A withheld cell's value (./versions.ts `readableCell`), as `delta` compares it: a placeholder of
 * its own, unlike any value and any other withheld cell's, so that a change to or from it is still
 * one. Never given: the side it is on is left out.
 */
const PLACEHOLDER = "\u0000withheld/";
function withheldAsPlaceholder(c: Cell): Cell {
  if (c.withheld !== true) return c;
  const out: Record<string, unknown> = { ...readableCell(c) };
  out[`c_${c.field_id}_0`] = `${PLACEHOLDER}${String(c.rec_from)}/${c.vf ?? ""}`;
  return out as Cell;
}
const isPlaceholder = (v: FieldValue | undefined): boolean =>
  typeof v === "string" && v.startsWith(PLACEHOLDER);
const decodeOrPlaceholder: typeof decode = (f, raw) =>
  typeof raw[0] === "string" && raw[0].startsWith(PLACEHOLDER)
    ? (raw[0] as FieldValue)
    : decode(f, raw);

const effective = (c: Cell, s: number): boolean =>
  Number(c.rec_from) <= s && (c.rec_to === null || Number(c.rec_to) > s);

/** The `shape` of a `history` read of a table (`target: null`) or of one row or entity. */
const historyShape = (mode: string, table: string, target: string | null, partial = false) =>
  canonicalize({ mode, table, target, ...(partial ? { partial: true } : {}) });

/**
 * What `my_last_read` counts (04-contract §10): by the scope of the read. A whole-table call counts
 * the reads that cover the table: a `query`, or a `changes` of the whole table that gave all of
 * its window. A call on one row or entity counts those too, and the `history` reads of that row or
 * entity (`timeline`, `as_of`, a `changes` on it that gave all of its window). A `sql` read counts
 * for none: what it read depends on the query and is recorded as a superset, so it is no sign that
 * the table was seen.
 */
function reads(table: string, row: string | undefined) {
  const whole = historyShape("changes", table, null);
  const ofRow =
    row === undefined
      ? []
      : (["timeline", "as_of", "changes"] as const).map((m) => historyShape(m, table, row));
  const counts = (e: {
    operation: string;
    shape?: string | null | undefined;
    covers: boolean;
  }): boolean =>
    e.operation === "history"
      ? e.shape === whole || (e.shape !== undefined && e.shape !== null && ofRow.includes(e.shape))
      : e.operation !== "sql" && e.covers;
  return counts;
}

/**
 * The greatest position of this connection's reads counted for the call under its task, if there
 * is one; else, when it read only under another task (or without one), the task of that read of the
 * greatest position. The connect self-check read counts for neither.
 */
async function lastReadOf(
  tx: ReadTx,
  buffer: ReadBuffer,
  actor: string,
  task: string | null,
  table: string,
  row: string | undefined,
): Promise<{ pos: number } | { other: string | null } | undefined> {
  const counts = reads(table, row);
  // The read of the greatest position, buffered or written, not the latest recorded: reads may be
  // recorded in an order not theirs (several processes; a buffer written out or not), and the
  // answer must not depend on it (02-architecture §7 «read_log 的持久性»).
  let mine: number | undefined;
  let other: { task: string | null; pos: number } | undefined;
  for (const e of buffer.entries()) {
    if (e.actor !== actor || e.selfcheck === true) continue;
    const covers =
      e.table === table ||
      e.rows.some((x) => x.table === table) ||
      e.coarse.includes(table as TableId);
    if (!covers && e.operation !== "history") continue;
    if (!counts({ operation: e.operation, shape: e.shape, covers })) continue;
    const pos = Number(e.pos);
    if (e.task === task) mine = Math.max(mine ?? pos, pos);
    else if (other === undefined || pos >= other.pos) other = { task: e.task, pos };
  }
  const shapes = [
    historyShape("changes", table, null),
    ...(row === undefined
      ? []
      : (["timeline", "as_of", "changes"] as const).map((m) => historyShape(m, table, row))),
  ];
  const counted = `NOT l.selfcheck AND
       ((l.operation NOT IN ('history', 'sql') AND (l.table_id = $3 OR EXISTS
         (SELECT 1 FROM read_log_rows x WHERE x.read_id = l.read_id AND x.table_id = $3)))
        OR (l.operation = 'history' AND l.shape = ANY($4)))`;
  const written = await tx.query<{ pos: unknown }>(
    `SELECT max(l.pos) AS pos FROM read_log l
     WHERE l.actor = $1 AND l.task IS NOT DISTINCT FROM $2::text AND ${counted}`,
    [actor, task, table, shapes] as never,
  );
  const x = written.rows[0]?.pos;
  if (x !== undefined && x !== null) mine = Math.max(mine ?? Number(x), Number(x));
  if (mine !== undefined) return { pos: mine };
  const o = await tx.query<{ task: string | null; pos: unknown }>(
    `SELECT l.task, l.pos FROM read_log l
     WHERE l.actor = $1 AND l.task IS DISTINCT FROM $2::text AND ${counted}
     ORDER BY l.pos DESC, l.n DESC LIMIT 1`,
    [actor, task, table, shapes] as never,
  );
  const w = o.rows[0];
  // Of the same position, the buffered one is the later recorded.
  if (w !== undefined && (other === undefined || Number(w.pos) > other.pos)) {
    return { other: w.task };
  }
  return other === undefined ? undefined : { other: other.task };
}

/** `since` and `until` as the caller gave them, for the position's identity. */
const givenOf = (v: unknown): JsonValue =>
  typeof v === "number" || typeof v === "string" ? v : isJsonNumber(v) ? Number(v.text) : null;

/** `history` with `mode: "changes"`. */
export async function changesInTx(
  tx: ReadTx,
  input: HistoryInput,
  params: Obj,
  target: Target | TableTarget,
): Promise<HistoryOutput<ChangesResult>> {
  const t: CompiledBaseTable = target.table;
  const task = taskOf(params, input.task);
  if (!has(params, "since")) throw invalid("missing", "since");
  const sinceGiven = get(params, "since");
  const untilGiven = has(params, "until") ? get(params, "until") : undefined;
  const restore = await restoreCount(tx);
  // A later page reads up to the first page's operation (04-contract §15).
  const latest = await logPosition(tx);
  const identity = digest({
    mode: "changes",
    table: t.id,
    target: target.id ?? null,
    since: givenOf(sinceGiven),
    until: untilGiven === undefined ? null : givenOf(untilGiven),
  });
  const specs: KeySpec[] = [
    { type: "count", dir: "desc" },
    { type: "text", dir: "asc" },
  ];
  const position = await positionOf(tx, params, {
    identity,
    specs,
    restoreCount: restore,
    latest,
    since: true,
  });

  // The window, fixed on the first page and carried on.
  let since: number;
  let until: number;
  if (position !== undefined) {
    since = position.since as number;
    until = position.seq;
  } else {
    if (sinceGiven === "my_last_read") {
      const found = await lastReadOf(tx, input.reads, input.actor, task, t.id, target.id);
      if (found === undefined || "other" in found) {
        throw new ReadError("read_first", "read the table first", {
          reason: found === undefined ? "no_read" : "task_mismatch",
          target: "table",
          ref: { table: `${target.named.slot.name}.${t.name}` },
          param: "since",
          ...(found !== undefined && "other" in found ? { read_task: found.other, task } : {}),
        });
      }
      const pos = found.pos;
      since = pos;
    } else {
      since = (await recordPoint(tx, sinceGiven, "since", 0)).seq;
    }
    until = untilGiven === undefined ? latest : (await recordPoint(tx, untilGiven, "until", 0)).seq;
  }

  const { versions } = physical(t);
  const state = t.time.type === "state";
  const byDate = t.time.type === "state" && t.time.granularity === "date";
  const interval = state
    ? byDate
      ? "valid_from::text AS vf, valid_to::text AS vt"
      : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
    : "NULL AS vf, NULL AS vt";
  const columns = t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`));

  // The rows an operation of the window opened or closed a cell of, and their cells in effect at
  // any point of it.
  const byRow = new Map<string, Cell[]>();
  if (until > since) {
    const only = target.id === undefined ? "" : " AND row_id = $3";
    const touched = await tx.query<{ row_id: string }>(
      `SELECT DISTINCT row_id FROM ${versions}
       WHERE ((rec_from > $1 AND rec_from <= $2) OR (rec_to > $1 AND rec_to <= $2))${only}`,
      target.id === undefined ? [since, until] : [since, until, target.id],
    );
    if (touched.rows.length > 0) {
      const r = await tx.query<Cell>(
        `SELECT row_id, field_id, ${interval}, rec_from, rec_to, intent, src_event, revoked, no_value,
           ${cellWithheld("v", await withholdingIn(tx))} AS withheld, ${columns.join(", ")}
         FROM ${versions} v
         WHERE row_id = ANY($3) AND rec_from <= $2 AND (rec_to IS NULL OR rec_to > $1)`,
        [since, until, touched.rows.map((x) => x.row_id)] as never,
      );
      for (const c of r.rows.map(withheldAsPlaceholder))
        byRow.set(c.row_id, [...(byRow.get(c.row_id) ?? []), c]);
    }
  }

  const open = (v: string | null): string | null =>
    v === "-infinity" || v === "infinity" ? null : v;
  const valid = (from: string | null, to: string | null): Interval =>
    intervalOf(open(from), open(to), byDate);

  interface Change {
    readonly op: number;
    readonly row: string;
    readonly intent: string;
    readonly fields: Record<string, ChangedField | (ChangedField & { valid: Interval })[]>;
    readonly partial?: true;
  }
  const found: Change[] = [];
  // A side a withheld cell gave is not given; the entry is marked (03-deletion «版本表»).
  let partial = false;
  const side = (v: FieldValue): ValueOut | undefined => {
    if (isPlaceholder(v)) {
      partial = true;
      return undefined;
    }
    return v === null ? undefined : valueOut(v);
  };
  const changed = (before: FieldValue, after: FieldValue): ChangedField => {
    const [b, a] = [side(before), side(after)];
    return { ...(b !== undefined ? { before: b } : {}), ...(a !== undefined ? { after: a } : {}) };
  };

  for (const [row, cells] of byRow) {
    const ops = new Set<number>();
    for (const c of cells) {
      for (const v of [c.rec_from, c.rec_to]) {
        if (v !== null && Number(v) > since && Number(v) <= until) ops.add(Number(v));
      }
    }
    for (const op of [...ops].sort((a, b) => a - b)) {
      const fields: Change["fields"] = Object.create(null);
      partial = false;
      const asOf = (s: number) => cells.filter((c) => effective(c, s));
      const [before, after] = [asOf(op - 1), asOf(op)];
      const options = { decode: decodeOrPlaceholder } as const;
      // `delta` counts existence (a revoke, or its taking back) and the fields apart.
      const delta = new Map(
        targetDelta(stateFromCells(t, before, options), stateFromCells(t, after, options)).flatMap(
          (d) => (d.comparable ? [[d.field, d] as const] : []),
        ),
      );
      const existence = delta.get("existence");
      if (!state) {
        // A creation (`absent` to `live`) is not a `*` (04-contract §10).
        if (
          existence !== undefined &&
          !(existence.before === undefined && existence.after === true)
        )
          fields["*"] = {
            before: (existence.before ?? true) as boolean,
            after: existence.after as boolean,
          };
        for (const f of t.fields) {
          const d = delta.get(f.id);
          if (d?.change === "value") fields[f.name] = changed(d.before ?? null, d.after ?? null);
        }
      } else {
        // A state table's: by stretch.
        // The stretches revoked or taken back, not those a write gave a value (a creation);
        // neighbours that read the same run together.
        const gone: { before: boolean; after: boolean; from: string; to: string | null }[] = [];
        for (const p of existence?.stretches ?? []) {
          if (p.before === undefined && p.after === true) continue;
          const [before, after] = [(p.before ?? true) as boolean, p.after as boolean];
          const last = gone.at(-1);
          if (
            last !== undefined &&
            last.to === p.from &&
            last.before === before &&
            last.after === after
          )
            last.to = p.to;
          else gone.push({ before, after, from: p.from, to: p.to });
        }
        if (gone.length > 0)
          fields["*"] = gone.map((p) => ({
            before: p.before,
            after: p.after,
            valid: valid(p.from, p.to),
          }));
        for (const f of t.fields) {
          const stretches = delta.get(f.id)?.stretches;
          if (stretches !== undefined && stretches.length > 0)
            fields[f.name] = stretches.map((p) => ({
              ...changed(p.before ?? null, p.after ?? null),
              valid: valid(p.from, p.to),
            }));
        }
      }
      if (Object.keys(fields).length === 0) continue;
      // The operation's intent: the latest contribution's among the cells it opened.
      const opened = cells
        .filter((c) => Number(c.rec_from) === op)
        .sort((x, y) => Number(y.src_event ?? 0) - Number(x.src_event ?? 0));
      found.push({
        op,
        row,
        intent: opened[0]?.intent ?? "update",
        fields,
        ...(partial ? { partial: true } : {}),
      });
    }
  }

  // Who and when: the operation's head event.
  const heads = new Map<number, { at: string; actor: string }>();
  const opNumbers = [...new Set(found.map((c) => c.op))];
  if (opNumbers.length > 0) {
    const r = await tx.query<{ seq: unknown; at: string; actor: string }>(
      "SELECT seq, at, actor FROM events WHERE seq = ANY($1)",
      [opNumbers] as never,
    );
    for (const x of r.rows) heads.set(Number(x.seq), { at: x.at, actor: x.actor });
  }
  const who = await actorsNow(
    tx,
    [...heads.values()].map((h) => h.actor),
  );
  const qualified = `${target.named.slot.name}.${t.name}`;
  const items = found
    .sort((x, y) => y.op - x.op || (x.row < y.row ? -1 : x.row > y.row ? 1 : 0))
    .map((c) => {
      const head = heads.get(c.op);
      const entry: ChangeEntry = {
        seq: c.op as never,
        recorded_at: head?.at ?? "",
        actor: who.get(head?.actor ?? "system") as Actor,
        intent: c.intent as VersionIntent,
        target: {
          table: qualified,
          ...(state ? { entity: c.row as never } : { row: c.row as never }),
        },
        fields: c.fields,
        ...(c.partial === true ? { partially_deleted: true as const } : {}),
      };
      return { item: entry, keys: [c.op, c.row] };
    });
  const { page, next } = pageAfter(items, {
    specs,
    identity,
    position,
    seq: until,
    // `until` can be a record point before the first page: the log position then, which a
    // deletion changed since is compared with (04-contract §15).
    logAt: position?.logAt ?? latest,
    at: position?.at ?? input.now,
    restoreCount: restore,
    limit: limitOf(params),
    since,
  });

  const result: ChangesResult = {
    mode: "changes",
    target: {
      table: qualified,
      ...(target.id === undefined
        ? {}
        : state
          ? { entity: target.id as never }
          : { row: target.id as never }),
    },
    timezone: target.named.slot.timezone,
    since: since as never,
    until: until as never,
    total: items.length,
    ...(next !== undefined ? { next_position: next } : {}),
    changes: page,
  };
  // What was read is what was given back: the position moves to `until` only when the call has
  // given the whole window, a first page that holds it, or the last page of it (04-contract §10). A
  // page that leaves earlier changes on a later one is a read with its own shape, which no
  // `my_last_read` counts.
  const complete = next === undefined;
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    pos: until as never,
    operation: "history",
    slot: target.named.slot.slot,
    sv: target.named.slot.sv,
    table: t.id as TableId,
    shape: historyShape("changes", t.id, target.id ?? null, !complete),
    // No version is given: not a read of a row for the fallback.
    rows: [],
    coarse: [],
    // Any read of a slot is a read of its `sv` (04-contract §2); the first page counts it.
    lastRead:
      position === undefined
        ? [
            {
              kind: "sv",
              target: target.named.slot.slot,
              op: target.named.slot.sv,
              restoreCount: 0,
            },
          ]
        : [],
  };
  return { result, entry };
}
