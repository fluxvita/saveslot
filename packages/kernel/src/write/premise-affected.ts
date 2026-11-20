// A receipt's `premise_affected` (04-contract §5.1; 04-contract-types §5.1 `PremiseAffected`;
// 02-integrity «写入的前提»): the dependent rows on which this operation made a mark appear, and
// those on which it took one away.
//
// Rows, not declarations: a declaration this operation marked counts for its dependent row when the
// mark shows there right after the operation (02-integrity «标记出现在哪一行»: it covers a 出处项 of
// a value the row has then); one taken back counts when it showed right before. The receipt is the
// same whether given now or rebuilt from the log later (04-contract §14), so both are read as of
// the operation, not as of now: the row's cells and their 出处项 at that version position (a
// corroboration reverted only by registrations up to it), and which declarations were in force on
// them then, rebuilt from the log (the heads that declared, restated and cleared on the row, and the
// items of their base writes, in (operation, op index) order, as apply keeps `premise_edges`):
// `premise_edges` holds only what is in force now.
//
// A dependent row on a table the caller cannot see counts and is not listed. `rows` lists one entry
// for each declaration marked on a row, at most 20, by row and then declaration.

import type {
  CompiledBaseTable,
  EntityId,
  FieldId,
  OpNumber,
  PremiseReason,
  RowId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { cellsAt, sourceItemsAt } from "../delta/index.ts";
import { type ActorAsOf, actorsAsOf } from "../log/index.ts";
import { decodeColumns } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";

/** 04-contract-types §5.1 `PremiseAffected`. */
export interface PremiseAffected {
  readonly count: number;
  readonly matched: number;
  readonly by_reason: Partial<Record<PremiseReason, number>>;
  readonly rows: readonly {
    readonly target: { readonly table: string; readonly row?: RowId; readonly entity?: EntityId };
    readonly fields: readonly string[];
    readonly declared: { readonly seq: number; readonly actor: ActorAsOf };
  }[];
}

/** The rows `premise_affected.rows` lists (02-integrity «上限»). */
export const PREMISE_AFFECTED_SHOWN = 20;

const key = (op: unknown, i: unknown, j: unknown) => `${op}/${i}/${j}`;
type Order = readonly [number, number];
const later = (a: Order, b: Order) => a[0] > b[0] || (a[0] === b[0] && a[1] > b[1]);

/**
 * The declarations in force on each item of row `row` right after operation `p`, rebuilt from the
 * log: by item, the declaration keys (`<op>/<op index>/<index>`).
 */
async function inForceAt(tx: ReadTx, row: string, p: number): Promise<Map<string, Set<string>>> {
  // The ops (operation, index) whose target is the row, up to p: the heads say so.
  const heads = await tx.query<{ op: unknown; path: string; body: string | null }>(
    `SELECT e.op, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq
     WHERE e.type = 'write.head' AND e.op <= $2 AND c.path LIKE 'ops/%/target'
       AND c.body LIKE $1`,
    [`%"${row}"%`, p],
  );
  const ops: { op: number; i: number }[] = [];
  for (const h of heads.rows) {
    if (h.body === null) continue;
    const t = JSON.parse(h.body) as { row?: string; entity?: string };
    if (t.row !== row && t.entity !== row) continue;
    ops.push({ op: Number(h.op), i: Number(/^ops\/(\d+)\/target$/.exec(h.path)?.[1]) });
  }
  ops.sort((a, b) => a.op - b.op || a.i - b.i);
  const edge = new Map<string, Map<string, { order: Order; decl: string }>>();
  const cleared = new Map<string, Order>();
  for (const { op, i } of ops) {
    const blocks = await tx.query<{ path: string; body: string | null }>(
      `SELECT path, body FROM content WHERE seq = $1
         AND (path LIKE $2 OR path = $3 OR path = $4)`,
      [op, `ops/${i}/premises/%`, `ops/${i}/premise_covers`, `ops/${i}/premises_cleared`],
    );
    const declared: { j: number; target: string }[] = [];
    let covers: { event: number; field?: string; existence?: number; k?: number }[] = [];
    let clearing = false;
    for (const b of blocks.rows) {
      if (b.body === null) continue;
      const m = /^ops\/\d+\/premises\/(\d+)$/.exec(b.path);
      if (m !== null) {
        const d = JSON.parse(b.body) as { row?: string; entity?: string };
        declared.push({ j: Number(m[1]), target: (d.row ?? d.entity) as string });
      } else if (b.path.endsWith("/premise_covers")) covers = JSON.parse(b.body);
      else if (b.path.endsWith("/premises_cleared")) clearing = JSON.parse(b.body) === true;
    }
    const items = covers.map((c) =>
      c.existence !== undefined
        ? `${c.event}/existence/${c.existence}`
        : `${c.event}/${c.field}/${c.k}`,
    );
    // The op's own base write: every item of it, whatever became of it (09 §5.12), as its blocks
    // list them (a candidate's item is not in the sources table, and apply covers it all the same).
    if (declared.length > 0) {
      const own = await tx.query<{ seq: unknown; path: string }>(
        `SELECT c.seq, c.path FROM content c
         JOIN events e ON e.seq = c.seq
         JOIN content t ON t.seq = e.seq AND t.path = 'target'
         WHERE e.op = $1 AND e.type = 'write.base'
           AND (t.body::jsonb ->> 'op_index')::int = $2
           AND c.path ~ '^(fields/f[0-9]+|existence)/[0-9]+$'`,
        [op, i],
      );
      for (const x of own.rows) {
        const f = /^fields\/(f\d+)\/(\d+)$/.exec(x.path);
        const e = /^existence\/(\d+)$/.exec(x.path);
        if (f !== null) items.push(`${x.seq}/${f[1]}/${f[2]}`);
        else if (e !== null) items.push(`${x.seq}/existence/${e[1]}`);
      }
    }
    const order: Order = [op, i];
    for (const item of items) {
      if (clearing) {
        const c = cleared.get(item);
        if (c === undefined || later(order, c)) cleared.set(item, order);
        continue;
      }
      const byTarget = edge.get(item) ?? new Map<string, { order: Order; decl: string }>();
      for (const d of declared) byTarget.set(d.target, { order, decl: key(op, i, d.j) });
      edge.set(item, byTarget);
    }
  }
  const out = new Map<string, Set<string>>();
  for (const [item, byTarget] of edge) {
    const c = cleared.get(item);
    const live = [...byTarget.values()].filter((e) => c === undefined || !later(c, e.order));
    if (live.length > 0) out.set(item, new Set(live.map((e) => e.decl)));
  }
  return out;
}

/**
 * The fields of row `row` whose value at version position `p` rests on each declaration in force
 * then, by declaration key.
 */
async function showing(
  tx: ReadTx,
  t: CompiledBaseTable,
  row: string,
  p: number,
): Promise<Map<string, Set<FieldId>>> {
  const live = await inForceAt(tx, row, p);
  const out = new Map<string, Set<FieldId>>();
  if (live.size === 0) return out;
  const of = await sourceItemsAt(tx, t, row, p, decodeColumns, { revertsUpToVer: true });
  for (const c of await cellsAt(tx, t, row, p)) {
    if (c.field_id === "existence" || c.no_value === true) continue;
    for (const item of of(c.field_id as FieldId, c))
      for (const d of live.get(item) ?? []) {
        const set = out.get(d) ?? new Set<FieldId>();
        set.add(c.field_id as FieldId);
        out.set(d, set);
      }
  }
  return out;
}

/** The receipt's `premise_affected` of operation `op`; none when it marked and took back nothing. */
export async function premiseAffected(
  tx: ReadTx,
  op: OpNumber,
  o: {
    readonly tableOf: (id: TableId) => CompiledBaseTable | undefined;
    readonly slotName: string;
    /** Whether the caller can see the table; none: every table. */
    readonly visible?: (id: TableId) => boolean;
  },
): Promise<PremiseAffected | undefined> {
  const ev = await tx.query<{ path: string; body: string | null }>(
    `SELECT c.path, c.body FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.op = $1 AND e.type = 'premise.changed'`,
    [op],
  );
  const changed = new Map<string, PremiseReason>();
  const matched = new Set<string>();
  for (const b of ev.rows) {
    if (!/^targets\/\d+$/.test(b.path) || b.body === null) continue;
    const t = JSON.parse(b.body) as {
      changed?: { op: number; i: number; j: number; reason: PremiseReason }[];
      matched?: { op: number; i: number; j: number }[];
    };
    for (const d of t.changed ?? []) changed.set(key(d.op, d.i, d.j), d.reason);
    for (const d of t.matched ?? []) matched.add(key(d.op, d.i, d.j));
  }
  if (changed.size === 0 && matched.size === 0) return undefined;
  // The declarations' dependent rows (what never changes of a declaration).
  const keys = [...changed.keys(), ...matched];
  const r = await tx.query<{
    op: unknown;
    i: unknown;
    j: unknown;
    table: string;
    row: string;
    declarer: string;
  }>(
    `SELECT op, op_index AS i, decl_index AS j, dep_table AS table, dep_row AS row, declarer
     FROM premise_decls WHERE op::text || '/' || op_index::text || '/' || decl_index::text = ANY($1)`,
    [keys] as never,
  );
  const decl = new Map(r.rows.map((x) => [key(x.op, x.i, x.j), x]));
  const rowsOf = (ks: Iterable<string>) =>
    [
      ...new Set([...ks].map((k) => decl.get(k)?.row).filter((x): x is string => x !== undefined)),
    ].sort();
  const tableOfRow = new Map(r.rows.map((x) => [x.row, x.table as TableId]));
  const shown = async (row: string, p: number) => {
    const t = o.tableOf(tableOfRow.get(row) as TableId);
    return t === undefined ? new Map<string, Set<FieldId>>() : showing(tx, t, row, p);
  };
  // Marked: shown on the row right after the operation.
  const marked: { row: string; decl: string; fields: Set<FieldId> }[] = [];
  for (const row of rowsOf(changed.keys())) {
    const now = await shown(row, op);
    for (const [k, fields] of now) if (changed.has(k)) marked.push({ row, decl: k, fields });
  }
  // Taken back: shown on the row right before it.
  let takenBack = 0;
  for (const row of rowsOf(matched)) {
    const before = await shown(row, op - 1);
    if ([...before.keys()].some((k) => matched.has(k))) takenBack++;
  }
  const markedRows = [...new Set(marked.map((m) => m.row))];
  if (markedRows.length === 0 && takenBack === 0) return undefined;
  const byReason: Partial<Record<PremiseReason, number>> = {};
  for (const reason of new Set(changed.values())) {
    const n = new Set(marked.filter((m) => changed.get(m.decl) === reason).map((m) => m.row)).size;
    if (n > 0) byReason[reason] = n;
  }
  const listed = marked
    .filter((m) => o.visible?.(tableOfRow.get(m.row) as TableId) ?? true)
    .sort((a, b) => (a.row < b.row ? -1 : a.row > b.row ? 1 : a.decl < b.decl ? -1 : 1))
    .slice(0, PREMISE_AFFECTED_SHOWN);
  const actors = await actorsAsOf(
    tx,
    [...new Set(listed.map((m) => decl.get(m.decl)?.declarer as string))],
    op,
  );
  return {
    count: markedRows.length,
    matched: takenBack,
    by_reason: byReason,
    rows: listed.map((m) => {
      const d = decl.get(m.decl) as (typeof r.rows)[number];
      const t = o.tableOf(d.table as TableId) as CompiledBaseTable;
      return {
        target: {
          table: `${o.slotName}.${t.name}`,
          ...(t.time.type === "state" ? { entity: m.row as EntityId } : { row: m.row as RowId }),
        },
        fields: t.fields.filter((f) => m.fields.has(f.id)).map((f) => f.name),
        declared: {
          seq: Number(d.op),
          actor: actors.get(d.declarer) ?? { kind: "user", id: d.declarer, name: d.declarer },
        },
      };
    }),
  };
}
