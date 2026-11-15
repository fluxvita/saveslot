// The write receipt (docs/zh-CN/spec/04-contract-types.md §5.1 `WriteResult`), built from the
// operation's events in the log. A fresh write and an idempotent replay build it the same way, so
// the replay gives what the write gave (04-write-and-read «重发时返回什么»).
//
// Given here: the status, `sv`, `seq`, each op's target, intent, `ver` (the row's version as of the
// operation), created entity, per-field result codes with the value written and the pending item
// of a candidate or awaiting field, `undo.of` with what was skipped and what later writes were taken
// back, and the pending items opened or joined. Not given yet: `before`, `overwritten`,
// `merged` (auto-merged fields), a candidate's `effective` / `current_ver` / `by` / `previous`, an
// awaiting field's `impact`, `resolved`, `existing_keys`; derived changes, affected reads and
// premises; item versions; items refreshed or superseded by the write. They come with the pending
// item contents, the read path and derived refresh.

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldValue,
  OpNumber,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import type { StoredEvent } from "./record.ts";

export type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop";

export interface FieldResult {
  readonly result: FieldResultCode;
  readonly after?: FieldValue;
  readonly no_value?: true;
  readonly uncovered?: true;
  /** Candidate or awaiting: the pending item. */
  readonly item?: string;
  /** State tables: the interval of this part. */
  readonly valid?: { readonly from: string; readonly to: string | null };
}

export interface OpReceipt {
  readonly target: {
    readonly table: string;
    readonly row?: string;
    readonly entity?: string;
  };
  readonly intent: string;
  readonly ver?: string;
  readonly created_entity?: true;
  readonly fields: Readonly<Record<string, FieldResult | readonly FieldResult[]>>;
  readonly undo?: {
    readonly of: OpNumber;
    readonly skipped_superseded: readonly { readonly field: string; readonly by: OpNumber }[];
    readonly reverted_later?: readonly {
      readonly seq: OpNumber;
      readonly fields: readonly string[];
    }[];
  };
}

export interface PendingRef {
  readonly id: string;
  readonly type: string;
  readonly reason: string;
  readonly merged?: true;
  /** Replays only: the item's state now, and its decision when resolved. */
  readonly state?: string;
  readonly decision?: string;
}

export interface WriteReceipt {
  readonly status: "saved" | "pending";
  readonly sv: number;
  readonly seq: OpNumber;
  readonly ops: readonly OpReceipt[];
  readonly derived: readonly never[];
  readonly derived_total: 0;
  readonly pending: readonly PendingRef[];
  readonly superseded: readonly never[];
  readonly replayed?: true;
  readonly warnings?: readonly {
    readonly code: string;
    readonly op?: number;
    readonly field?: string;
  }[];
}

type Blocks = Readonly<Record<string, unknown>>;

/** The events of operation `op`, with their blocks. */
async function operationEvents(tx: ReadTx, op: OpNumber): Promise<StoredEvent[]> {
  const evs = await tx.query<{ seq: unknown; type: string; op: unknown }>(
    "SELECT seq, type, op FROM events WHERE op = $1 ORDER BY seq",
    [op],
  );
  const blocks = await tx.query<{ seq: unknown; path: string; body: string | null }>(
    "SELECT c.seq, c.path, c.body FROM content c JOIN events e ON e.seq = c.seq WHERE e.op = $1 AND c.body IS NOT NULL",
    [op],
  );
  const by = new Map<number, Record<string, unknown>>();
  for (const b of blocks.rows) {
    const m = by.get(Number(b.seq)) ?? Object.create(null);
    m[b.path] = JSON.parse(b.body as string);
    by.set(Number(b.seq), m);
  }
  return evs.rows.map((e) => ({
    header: { type: e.type, seq: Number(e.seq), op: Number(e.op) },
    blocks: by.get(Number(e.seq)) ?? {},
  }));
}

/** The row's version (01-objects «版本标记») as of operation `op`. */
async function verAsOf(
  tx: ReadTx,
  table: CompiledBaseTable,
  row: string,
  op: OpNumber,
  restoreCount: number,
): Promise<string | undefined> {
  const r = await tx.query<{ v: unknown }>(
    `SELECT max(rec_from) AS v FROM "${table.physical.table}__ver"
     WHERE row_id = $1 AND rec_from <= $2 AND intent <> 'schema_switch'`,
    [row, op],
  );
  const v = r.rows[0]?.v;
  return v === null || v === undefined ? undefined : `v${Number(v)}.${restoreCount}`;
}

/** The operation numbers of events, and the actors of operations. */
async function opsOf(tx: ReadTx, seqs: readonly number[]): Promise<Map<number, number>> {
  if (seqs.length === 0) return new Map();
  const r = await tx.query<{ seq: unknown; op: unknown }>(
    "SELECT seq, op FROM events WHERE seq = ANY($1)",
    [seqs] as never,
  );
  return new Map(r.rows.map((x) => [Number(x.seq), Number(x.op)]));
}

/**
 * The receipt of operation `op` (a write's head event), from the log. Undefined when the head
 * event's content is no longer there (deleted with the write's evidence).
 */
export async function readReceipt(
  tx: ReadTx,
  op: OpNumber,
  o: {
    readonly compiled: CompiledSchema;
    readonly slotName: string;
    readonly restoreCount: number;
    readonly replayed: boolean;
  },
): Promise<WriteReceipt | undefined> {
  const events = await operationEvents(tx, op);
  const head = events.find((e) => e.header.type === "write.head")?.blocks as Blocks | undefined;
  const request = head?.["request"] as { sv: number; op_count: number } | undefined;
  if (head === undefined || request === undefined) return undefined;
  const tableOf = (id: string) =>
    o.compiled.tables.find((t) => t.id === id && t.kind === "base") as CompiledBaseTable;
  const bases = events.filter((e) => e.header.type === "write.base");
  const itemEvents = events.filter(
    (e) => e.header.type === "item.created" || e.header.type === "item.merged",
  );
  // Which pending item each candidate or awaiting part went to.
  const itemOf = new Map<string, string>();
  for (const e of itemEvents) {
    const t = e.blocks["target"] as { item: string; type?: string; origin_event: number };
    for (const [p, c] of Object.entries(e.blocks)) {
      if (!p.startsWith("candidates/")) continue;
      const cand = c as {
        event: number;
        items: { field?: string; k?: number; existence?: number }[];
      };
      for (const y of cand.items) {
        itemOf.set(`${cand.event}/${y.field ?? "existence"}/${y.k ?? y.existence ?? 0}`, t.item);
      }
    }
    if (t.type === "awaiting_confirmation") itemOf.set(`${t.origin_event}/awaiting`, t.item);
  }

  const later = bases.flatMap((b) => {
    const rv = b.blocks["revert"] as { items: { event: number; later?: true }[] } | undefined;
    return (rv?.items ?? []).filter((x) => x.later).map((x) => x.event);
  });
  const opOfEvent = await opsOf(tx, later);

  let pendingStatus = false;
  const ops: OpReceipt[] = [];
  for (let i = 0; i < request.op_count; i++) {
    const t = head[`ops/${i}/target`] as {
      table: string;
      row?: string;
      entity?: string;
      intent: string;
      ver?: { op: number };
    };
    const table = tableOf(t.table);
    const isState = table.time.type === "state";
    const name = (f: string) => table.fields.find((x) => x.id === f)?.name ?? f;
    const rowId = (t.row ?? t.entity) as string;
    const base = bases.find((b) => (b.blocks["target"] as { op_index: number }).op_index === i);
    const fields: Record<string, FieldResult | FieldResult[]> = {};
    const add = (key: string, r: FieldResult) => {
      if (r.result === "candidate" || r.result === "awaiting") pendingStatus = true;
      if (!isState) {
        fields[key] = r;
        return;
      }
      const prev = fields[key];
      fields[key] = [...(Array.isArray(prev) ? prev : []), r];
    };
    if (base !== undefined) {
      const b = base.blocks;
      const event = base.header.seq;
      const paths = Object.keys(b).sort();
      for (const p of paths) {
        const m = /^fields\/(f\d+)\/(\d+)$/.exec(p);
        const ex = /^existence\/(\d+)$/.exec(p);
        if (m === null && ex === null) continue;
        const block = b[p] as {
          status: FieldResultCode;
          value?: FieldValue;
          no_value?: true;
          uncovered?: true;
        };
        const target = m !== null ? (m[1] as string) : "existence";
        const k = Number(m !== null ? m[2] : (ex as RegExpExecArray)[1]);
        const span = b[`span/${target}/${k}`] as
          | { valid?: { from: string; to?: string }; seen_valid?: { from: string; to?: string } }
          | undefined;
        const iv = span?.valid ?? span?.seen_valid;
        const item =
          block.status === "candidate"
            ? itemOf.get(`${event}/${target}/${k}`)
            : block.status === "awaiting"
              ? itemOf.get(`${event}/awaiting`)
              : undefined;
        add(m !== null ? name(target) : "*", {
          result: block.status,
          ...("value" in block ? { after: block.value as FieldValue } : {}),
          ...(block.no_value ? { no_value: true as const } : {}),
          ...(block.uncovered ? { uncovered: true as const } : {}),
          ...(item !== undefined ? { item } : {}),
          ...(isState && iv !== undefined ? { valid: { from: iv.from, to: iv.to ?? null } } : {}),
        });
      }
    }
    // A state table gives each field as an array of parts (04-contract-types §5.1 `fields`).
    for (const f of (head[`ops/${i}/noop`] ?? []) as string[]) {
      fields[name(f)] = isState ? [{ result: "noop" }] : { result: "noop" };
    }
    const revert = head[`ops/${i}/revert`] as { undo_op: number } | undefined;
    let undo: OpReceipt["undo"];
    if (revert !== undefined) {
      const rv = (base?.blocks["revert"] ?? { items: [] }) as {
        items: { event: number; field?: string; later?: true }[];
        skipped?: { field?: string; by_op: number }[];
      };
      const byOp = new Map<number, Set<string>>();
      for (const x of rv.items.filter((y) => y.later)) {
        const n = opOfEvent.get(x.event) ?? x.event;
        const s = byOp.get(n) ?? new Set<string>();
        s.add(x.field !== undefined ? name(x.field) : "*");
        byOp.set(n, s);
      }
      undo = {
        of: revert.undo_op,
        skipped_superseded: (rv.skipped ?? []).map((s) => ({
          field: s.field !== undefined ? name(s.field) : "*",
          by: s.by_op,
        })),
        ...(byOp.size > 0
          ? {
              reverted_later: [...byOp].map(([seq, fs]) => ({ seq, fields: [...fs].sort() })),
            }
          : {}),
      };
    }
    const created = (base?.blocks["target"] as { created?: true } | undefined)?.created === true;
    const ver = await verAsOf(tx, table, rowId, op, o.restoreCount);
    ops.push({
      target: {
        table: `${o.slotName}.${table.name}`,
        ...(isState ? { entity: rowId } : { row: rowId }),
      },
      intent: t.intent,
      ...(ver !== undefined ? { ver } : {}),
      ...(created && isState ? { created_entity: true as const } : {}),
      fields,
      ...(undo !== undefined ? { undo } : {}),
    });
  }

  const pending: PendingRef[] = [];
  const states = new Map<string, { state: string; decision: string | null; type: string }>();
  if (itemEvents.length > 0) {
    const ids = itemEvents.map((e) => (e.blocks["target"] as { item: string }).item);
    const r = await tx.query<{ id: string; state: string; decision: string | null; type: string }>(
      "SELECT id, state, decision, type FROM pending_items WHERE id = ANY($1)",
      [ids] as never,
    );
    for (const x of r.rows) states.set(x.id, x);
  }
  for (const e of itemEvents) {
    const t = e.blocks["target"] as { item: string; type?: string; reason?: string };
    const s = states.get(t.item);
    const type = t.type ?? s?.type ?? "conflict";
    pending.push({
      id: t.item,
      type,
      reason: t.reason ?? "stale_write",
      ...(e.header.type === "item.merged" ? { merged: true as const } : {}),
      ...(o.replayed && s !== undefined
        ? { state: s.state, ...(s.decision !== null ? { decision: s.decision } : {}) }
        : {}),
    });
  }

  return {
    status: pendingStatus ? "pending" : "saved",
    sv: request.sv,
    seq: op,
    ops,
    derived: [],
    derived_total: 0,
    pending,
    superseded: [],
    ...(o.replayed ? { replayed: true as const } : {}),
  };
}
