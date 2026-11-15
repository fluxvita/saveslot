// The write receipt (docs/zh-CN/spec/04-contract-types.md §5.1 `WriteResult`), built from the
// operation's events in the log. A fresh write and an idempotent replay build it the same way, so
// the replay gives what the write gave (04-write-and-read «重发时返回什么»).
//
// Given here: the status, `sv`, `seq`, each op's target, intent, `ver` (the row's version as of the
// operation), created entity, per-field result codes with the value written and, for a candidate
// or awaiting part, its pending item with the item's details (a candidate's `effective`,
// `current_ver`, `by`, `previous` and, when taking it would be high impact, `impact`; an awaiting
// part's `impact`), `undo.of` with what was skipped and what later writes were taken back, and the
// pending items the write opened, joined, refreshed or superseded, each once; an entity created
// by key gets `existing_keys` from the pipeline (not in the log: a replay lists it in `omitted`).
// Not given yet: `before`, `overwritten`, `merged` (auto-merged fields), `resolved`; derived
// changes, affected reads and premises. They come with the read path and derived refresh.

import type {
  CompiledBaseTable,
  CompiledSchema,
  EntityId,
  FieldId,
  FieldValue,
  OpNumber,
} from "@fluxvita/saveslot-contract-core";
import { type Limit, type RowState, stateFromRecord } from "../judge/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { type Interval as Stretch, WHOLE } from "../time/index.ts";
import { type EntityKeyText, keyFields, keyOf } from "./keys.ts";
import { tableShape } from "./plan.ts";
import { rowEvents } from "./reads.ts";
import { decodeRecords, type RowContext, type StoredEvent } from "./record.ts";

export type FieldResultCode = "applied" | "candidate" | "awaiting" | "corroborated" | "noop";

export interface FieldResult {
  readonly result: FieldResultCode;
  readonly after?: FieldValue;
  readonly no_value?: true;
  readonly uncovered?: true;
  /** Candidate or awaiting: the pending item. */
  readonly item?: string;
  /** Candidate: the value in effect, the row's version, who gave it, the merge base's state. */
  readonly effective?: FieldValue;
  readonly current_ver?: string;
  readonly by?: { readonly seq: number; readonly actor: string };
  readonly previous?: {
    readonly seq: number;
    readonly exists: boolean;
    readonly values?: Readonly<Record<string, FieldValue>>;
    readonly spans?: readonly (Interval & {
      readonly values: Readonly<Record<string, FieldValue>> | null;
    })[];
  };
  /** Awaiting, or a candidate taking which would be high impact: what carrying it out would change. */
  readonly impact?: Impact;
  /** State tables: the interval of this part. */
  readonly valid?: Interval;
}

/** A business time interval as the contract gives it (04-contract-types `Interval`). */
export interface Interval {
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  /** Date granularity, with an end: the interval's last day. */
  readonly valid_to_inclusive?: string;
}

/** 04-contract-types `AwaitingImpact`. */
export interface Impact {
  readonly overwritten?: readonly {
    readonly field: string;
    readonly valid?: Interval;
    readonly value: FieldValue;
    readonly seq: number;
    readonly actor: string;
  }[];
  readonly filled_gaps?: readonly { readonly valid?: Interval; readonly revoked_by?: number }[];
  readonly reverted?: readonly {
    readonly seq: number;
    readonly actor: string;
    readonly fields: readonly string[];
  }[];
}

export interface OpReceipt {
  readonly target: {
    readonly table: string;
    readonly row?: string;
    readonly entity?: string;
    /** An op by `entity_key`: the entity's key, by field name (04-contract-types `TargetRef`). */
    readonly entity_key?: Readonly<Record<string, FieldValue>>;
  };
  readonly intent: string;
  readonly ver?: string;
  readonly created_entity?: true;
  /**
   * An entity created by `entity_key`: the table's keys before it, at most 10 (04-contract §5.1),
   * caller data. Worked out at the write from the state then, not in the log: the pipeline adds them
   * and a replay leaves them out.
   */
  readonly existing_keys?: readonly EntityKeyText[];
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
  /** Opened by this write, its contents given whole: its version (counts as read). */
  readonly item_ver?: string;
  readonly merged?: true;
  /** An open item whose contents this write changed: refreshed, still open. */
  readonly refreshed?: true;
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
  readonly superseded: readonly {
    readonly item: string;
    readonly type: string;
    readonly reason: string;
  }[];
  readonly replayed?: true;
  /** A replay's parts the log cannot give back (04-contract §14 «重放返回什么»). */
  readonly omitted?: readonly "existing_keys"[];
  readonly warnings?: readonly {
    readonly code: string;
    readonly op?: number;
    readonly field?: string;
  }[];
}

type Blocks = Readonly<Record<string, unknown>>;
type Span = { readonly from: string | null; readonly to: string | null };
const spanIn = (v: { from?: string; to?: string } | undefined): Span => ({
  from: v?.from ?? null,
  to: v?.to ?? null,
});
const overlaps = (a: Span, b: Span) =>
  (a.to === null || b.from === null || b.from < a.to) &&
  (b.to === null || a.from === null || a.from < b.to);

/** The day before a date (`YYYY-MM-DD`). */
const dayBefore = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

/** A span as the contract's interval: `valid_to_inclusive` on date tables with an end. */
function intervalOut(v: Span, byDate: boolean): Interval {
  return {
    valid_from: v.from,
    valid_to: v.to,
    ...(byDate && v.to !== null ? { valid_to_inclusive: dayBefore(v.to) } : {}),
  };
}

/** The groups each item event gives whole (09 §5.8): zero blocks of a group given, an empty group. */
const GIVES: Readonly<Record<string, readonly string[]>> = {
  "item.created": ["current", "previous", "impact"],
  "item.merged": ["previous", "impact"],
  "item.refreshed": ["current", "previous", "impact"],
};

/** The item version as callers see it (04-contract `item_ver`): item ID, its version, restore count. */
export const itemVer = (item: string, op: number, restoreCount: number) =>
  `iv_${item.slice(3)}.${op}.${restoreCount}`;

/** Each item's latest entries as of operation `op`: the last item event giving each group. */
async function latestEntries(tx: ReadTx, items: readonly string[], op: number) {
  const out = new Map<
    string,
    { current: Blocks[]; previous: Blocks[]; impact: Blocks[]; mergeBase?: number }
  >();
  if (items.length === 0) return out;
  const r = await tx.query<{
    seq: unknown;
    type: string;
    path: string;
    body: string;
    item: string;
  }>(
    `SELECT e.seq, e.type, c.path, c.body, t.body::jsonb ->> 'item' AS item
     FROM events e JOIN content t ON t.seq = e.seq AND t.path = 'target' AND t.body IS NOT NULL
     JOIN content c ON c.seq = e.seq AND c.body IS NOT NULL
     WHERE e.type IN ('item.created', 'item.merged', 'item.refreshed') AND e.op <= $2
       AND (t.body::jsonb ->> 'item') = ANY($1)
     ORDER BY e.seq, c.path`,
    [items, op] as never,
  );
  // A group given by an event replaces the item's earlier one (09 §5.8: whole groups).
  const bySeq = new Map<number, { item: string; blocks: Record<string, unknown> }>();
  for (const x of r.rows) {
    const e = bySeq.get(Number(x.seq)) ?? { item: x.item, blocks: {} };
    e.blocks[x.path] = JSON.parse(x.body);
    bySeq.set(Number(x.seq), e);
  }
  const types = new Map(r.rows.map((x) => [Number(x.seq), x.type]));
  for (const [seq, e] of [...bySeq].sort(([a], [b]) => a - b)) {
    const cur = out.get(e.item) ?? { current: [], previous: [], impact: [] };
    const group = (g: string) =>
      Object.entries(e.blocks)
        .filter(([p]) => p.startsWith(`${g}/`))
        .sort(([a], [b]) => Number(a.split("/")[1]) - Number(b.split("/")[1]))
        .map(([, v]) => v as Blocks);
    const type = types.get(seq) ?? "";
    const gives = GIVES[type] ?? [];
    // An item.merged giving `current` gives it whole; one without keeps the earlier.
    const merged = type === "item.merged" && group("current").length > 0;
    if (gives.includes("current") || merged) cur.current = group("current");
    if (gives.includes("previous")) cur.previous = group("previous");
    if (gives.includes("impact")) cur.impact = group("impact");
    const t = e.blocks["target"] as { merge_base_op?: number } | undefined;
    if (t?.merge_base_op !== undefined) cur.mergeBase = t.merge_base_op;
    out.set(e.item, cur);
  }
  return out;
}

/** The actors of operations. */
async function actorsOf(tx: ReadTx, ops: readonly number[]): Promise<Map<number, string>> {
  if (ops.length === 0) return new Map();
  const r = await tx.query<{ seq: unknown; actor: string }>(
    "SELECT seq, actor FROM events WHERE seq = ANY($1)",
    [ops] as never,
  );
  return new Map(r.rows.map((x) => [Number(x.seq), x.actor]));
}

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

/**
 * Who gave a candidate's target its state on the candidate's part, as of operation `op`
 * (04-contract-types `FieldResult.by`): stretch by stretch, the write whose value is in effect, or
 * on a stretch without a value the revoke that left it; stretches no write ever gave a state are
 * left out. The latest of them, with the value it gave the field (none: a revoke, or the row's
 * existence as the target).
 */
function givenBy(
  state: RowState,
  target: string,
  part: Stretch,
  op: OpNumber,
): { readonly op: OpNumber; readonly value: FieldValue } | undefined {
  const at: Limit = { upTo: op };
  const defining = state.table.valued.length > 0 ? state.table.valued : state.table.fields;
  let top: { op: OpNumber; value: FieldValue } | undefined;
  const offer = (by: OpNumber, value: FieldValue) => {
    if (top === undefined || by > top.op) top = { op: by, value };
  };
  for (const seg of state.isState ? state.piecesIn([part]) : [WHOLE]) {
    // Without a value there: the revoke that left the hole, if one did.
    const hole = defining.map((f) => state.fieldState(f, seg, at)).find((x) => x.kind === "hole");
    if (hole !== undefined && hole.kind === "hole") {
      offer(hole.by.op, null);
      continue;
    }
    if (state.isState && !state.hasValue(seg, at)) continue;
    const fields = target === "existence" ? defining : [target as FieldId];
    for (const f of fields) {
      const x = state.fieldState(f, seg, at);
      if (x.kind === "value") offer(x.by.op, target === "existence" ? null : x.value);
    }
  }
  return top;
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
  const settled = events.filter(
    (e) => e.header.type === "item.refreshed" || e.header.type === "item.superseded",
  );
  const itemIds = [
    ...new Set(itemEvents.map((e) => (e.blocks["target"] as { item: string }).item)),
  ];
  const entries = await latestEntries(tx, itemIds, op);
  // The operations behind the entries: an entry's own, or (a stretch of the unit "existence" with a
  // value) the latest of the contributions giving it.
  const depEvents = new Set<number>();
  for (const x of entries.values()) {
    for (const b of x.current) {
      if (typeof b["op"] !== "number")
        for (const d of (b["deps"] ?? []) as { event: number }[]) depEvents.add(d.event);
    }
  }
  const opOfDep = await opsOf(tx, [...depEvents]);
  const opOf = (b: Blocks): number | undefined =>
    typeof b["op"] === "number"
      ? (b["op"] as number)
      : Math.max(
          0,
          ...((b["deps"] ?? []) as { event: number }[]).map((d) => opOfDep.get(d.event) ?? 0),
        ) || undefined;
  const actorOps = new Set<number>();
  for (const x of entries.values()) {
    for (const b of [...x.current, ...x.impact]) {
      const n = opOf(b);
      if (n !== undefined) actorOps.add(n);
    }
  }
  const actors = await actorsOf(tx, [...actorOps]);
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
  let keysLeftOut = false;
  const ops: OpReceipt[] = [];
  for (let i = 0; i < request.op_count; i++) {
    const t = head[`ops/${i}/target`] as {
      table: string;
      row?: string;
      entity?: string;
      intent: string;
      ver?: { op: number };
      by_entity_key?: true;
      created?: true;
    };
    if (t.by_entity_key && t.created) keysLeftOut = true;
    const table = tableOf(t.table);
    const isState = table.time.type === "state";
    const byDate = table.time.type === "state" && table.time.granularity === "date";
    const iv = (v: Span) => intervalOut(v, byDate);
    const name = (f: string) => table.fields.find((x) => x.id === f)?.name ?? f;
    const rowId = (t.row ?? t.entity) as string;
    const base = bases.find((b) => (b.blocks["target"] as { op_index: number }).op_index === i);
    // By field name, built as entries: a name like `__proto__` stays a key of its own.
    const fields = new Map<string, FieldResult | FieldResult[]>();
    const rowVer = await verAsOf(tx, table, rowId, op, o.restoreCount);
    // The row as the operation judged it, for who gave what a candidate met: read once, and only
    // when the op has a candidate.
    let judged: RowState | undefined;
    if (
      base !== undefined &&
      Object.values(base.blocks).some((b) => (b as { status?: string })?.status === "candidate")
    ) {
      const ctx: RowContext = {
        table: table.id,
        target: isState ? { entity: rowId as never } : { row: rowId as never },
        shape: tableShape(table),
        granularity: table.time.type === "state" ? table.time.granularity : "date",
      };
      judged = stateFromRecord(ctx.shape, decodeRecords(ctx, await rowEvents(tx, table.id, rowId)));
      // The writers of whatever may be `by`.
      const missing = [...new Set(judged.items.map((y) => y.op))].filter((n) => !actors.has(n));
      for (const [n, a] of await actorsOf(tx, missing)) actors.set(n, a);
    }

    /** What carrying out an item would change, from its impact entries (`only`: some of them). */
    const impactOf = (blocks: readonly Blocks[]): Impact => {
      const segs = blocks.filter((b) => b["kind"] === "overwritten_segment");
      // A stretch without a value is a gap filled (04-contract-types `filled_gaps`).
      const overwritten = segs
        .filter((b) => b["value"] !== null && b["value"] !== undefined)
        .map((b) => ({
          field: name(b["field"] as string),
          ...(b["valid"] !== undefined ? { valid: iv(spanIn(b["valid"] as never)) } : {}),
          value: b["value"] as FieldValue,
          seq: b["op"] as number,
          actor: actors.get(b["op"] as number) ?? "",
        }));
      const filled = segs
        .filter((b) => b["value"] === null || b["value"] === undefined)
        .map((b) => ({
          ...(b["valid"] !== undefined ? { valid: iv(spanIn(b["valid"] as never)) } : {}),
          ...(typeof b["op"] === "number" ? { revoked_by: b["op"] as number } : {}),
        }));
      const reverted = blocks
        .filter((b) => b["kind"] === "reverted_write")
        .map((b) => ({
          seq: b["op"] as number,
          actor: actors.get(b["op"] as number) ?? "",
          fields: [
            ...new Set(
              (b["deps"] as { field?: string }[]).map((d) =>
                d.field !== undefined ? name(d.field) : "*",
              ),
            ),
          ].sort(),
        }));
      return {
        ...(overwritten.length > 0 ? { overwritten } : {}),
        ...(filled.length > 0 ? { filled_gaps: filled } : {}),
        ...(reverted.length > 0 ? { reverted } : {}),
      };
    };

    /** A candidate's or awaiting part's details, from its item's latest entries (09 §5.8). */
    const itemDetails = (
      item: string,
      status: string,
      target: string,
      event: number,
      part: Span,
    ): Partial<FieldResult> => {
      const x = entries.get(item);
      if (x === undefined) return {};
      const on = (b: Blocks) =>
        !isState || b["valid"] === undefined || overlaps(spanIn(b["valid"] as never), part);
      if (status !== "candidate") return { impact: impactOf(x.impact) };
      // On the unit "existence" the entries say where the row has a value; on fields, the values.
      const onExistence =
        x.current.some((b) => b["field"] === "existence") ||
        x.previous.some((b) => b["field"] === "existence");
      const prev = x.previous.filter((b) => on(b));
      // Who gave what the candidate met, and its value, from the row as judged (not the entries'
      // deps, which also hold what cut a stretch's ends, the candidate itself among them).
      const given =
        judged === undefined
          ? undefined
          : givenBy(judged, target, isState ? (part as unknown as Stretch) : WHOLE, op);
      const top = given?.op;
      const exists = (bs: readonly Blocks[]) =>
        onExistence
          ? bs.some((b) => b["field"] === "existence" && b["revoked"] !== true)
          : isState
            ? bs.some((b) => b["value"] !== null && b["value"] !== undefined)
            : true;
      const mine = x.impact.filter(
        (b) =>
          b["kind"] === "overwritten_segment" &&
          ((b["deps"] ?? []) as { event: number }[]).some((d) => d.event === event),
      );
      const impact = impactOf(mine);
      return {
        // The value the `by` write gave (the whole picture is the item's ConflictDetail).
        // The value the `by` write gave (none when it is a revoke); the whole picture is the item's
        // ConflictDetail.
        effective: given?.value ?? null,
        ...(rowVer !== undefined ? { current_ver: rowVer } : {}),
        ...(top !== undefined ? { by: { seq: top, actor: actors.get(top) ?? "" } } : {}),
        ...(x.mergeBase !== undefined
          ? {
              previous:
                isState && !onExistence
                  ? {
                      seq: x.mergeBase,
                      exists: exists(prev),
                      spans: prev
                        .filter((b) => b["field"] === target)
                        .map((b) => ({
                          ...iv(spanIn(b["valid"] as never)),
                          values:
                            b["value"] === null
                              ? null
                              : Object.fromEntries([[name(target), b["value"] as FieldValue]]),
                        })),
                    }
                  : onExistence
                    ? { seq: x.mergeBase, exists: exists(prev) }
                    : {
                        seq: x.mergeBase,
                        exists: true,
                        values: Object.fromEntries(
                          prev.map((b) => [name(b["field"] as string), b["value"] as FieldValue]),
                        ),
                      },
            }
          : {}),
        ...(Object.keys(impact).length > 0 ? { impact } : {}),
      };
    };
    const add = (key: string, r: FieldResult) => {
      if (r.result === "candidate" || r.result === "awaiting") pendingStatus = true;
      if (!isState) {
        fields.set(key, r);
        return;
      }
      const prev = fields.get(key);
      fields.set(key, [...(Array.isArray(prev) ? prev : []), r]);
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
        const at = span?.valid ?? span?.seen_valid;
        const item =
          block.status === "candidate"
            ? itemOf.get(`${event}/${target}/${k}`)
            : block.status === "awaiting"
              ? itemOf.get(`${event}/awaiting`)
              : undefined;
        const part: Span = isState ? spanIn(at) : { from: null, to: null };
        const details =
          item === undefined ? {} : itemDetails(item, block.status, target, event, part);
        add(m !== null ? name(target) : "*", {
          result: block.status,
          ...("value" in block ? { after: block.value as FieldValue } : {}),
          ...(block.no_value ? { no_value: true as const } : {}),
          ...(block.uncovered ? { uncovered: true as const } : {}),
          ...(item !== undefined ? { item } : {}),
          ...details,
          ...(isState && at !== undefined ? { valid: iv(spanIn(at)) } : {}),
        });
      }
    }
    // A state table gives each field as an array of parts (04-contract-types §5.1 `fields`).
    for (const f of (head[`ops/${i}/noop`] ?? []) as string[]) {
      fields.set(name(f), isState ? [{ result: "noop" }] : { result: "noop" });
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
    const ver = rowVer;
    // The key of an entity located or created by key, from the event that created it.
    const key = t.by_entity_key ? await keyOf(tx, table, rowId as EntityId) : undefined;
    ops.push({
      target: {
        table: `${o.slotName}.${table.name}`,
        ...(isState ? { entity: rowId } : { row: rowId }),
        ...(key !== undefined
          ? {
              entity_key: Object.fromEntries(
                keyFields(table).map((f) => [f.name, key[f.id] ?? null]),
              ),
            }
          : {}),
      },
      intent: t.intent,
      ...(ver !== undefined ? { ver } : {}),
      ...(created && isState ? { created_entity: true as const } : {}),
      fields: Object.fromEntries(fields),
      ...(undo !== undefined ? { undo } : {}),
    });
  }

  // The pending items: each once, opened (with its version), joined, refreshed, or superseded.
  const touched = [
    ...new Set(
      [...itemEvents, ...settled].map((e) => (e.blocks["target"] as { item: string }).item),
    ),
  ];
  const info = new Map<
    string,
    { state: string; decision: string | null; type: string; reason: string | null }
  >();
  if (touched.length > 0) {
    const r = await tx.query<{
      id: string;
      state: string;
      decision: string | null;
      type: string;
      reason: string | null;
    }>(
      `SELECT p.id, p.state, p.decision, p.type,
         (SELECT c.body::jsonb ->> 'reason' FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
          WHERE e.type = 'item.created' AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = p.id LIMIT 1) AS reason
       FROM pending_items p WHERE p.id = ANY($1)`,
      [touched] as never,
    );
    for (const x of r.rows) info.set(x.id, x);
  }
  const pending: PendingRef[] = [];
  const superseded: { item: string; type: string; reason: string }[] = [];
  for (const id of touched) {
    const x = info.get(id);
    const mine = [...itemEvents, ...settled].filter(
      (e) => (e.blocks["target"] as { item: string }).item === id,
    );
    const kinds = new Set(mine.map((e) => e.header.type));
    const gone = mine.find((e) => e.header.type === "item.superseded");
    if (gone !== undefined) {
      superseded.push({
        item: id,
        type: x?.type ?? "conflict",
        reason: (gone.blocks["target"] as { reason?: string }).reason ?? "overwritten",
      });
      continue;
    }
    pending.push({
      id,
      type: x?.type ?? "conflict",
      reason: x?.reason ?? "stale_write",
      ...(kinds.has("item.created") && !o.replayed
        ? { item_ver: itemVer(id, op, o.restoreCount) }
        : {}),
      // Opened by this write, its contents are given whole as of the request's end: not a join.
      ...(kinds.has("item.merged") && !kinds.has("item.created") ? { merged: true as const } : {}),
      ...(kinds.has("item.refreshed") ? { refreshed: true as const } : {}),
      ...(o.replayed && x !== undefined
        ? { state: x.state, ...(x.decision !== null ? { decision: x.decision } : {}) }
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
    superseded,
    ...(o.replayed ? { replayed: true as const } : {}),
    ...(o.replayed && keysLeftOut ? { omitted: ["existing_keys" as const] } : {}),
  };
}
