// `history` with `mode: "timeline"` (docs/zh-CN/spec/04-contract.md §10 `history`; 04-contract-types.md
// §4.5 `TimelineResult`; 09-event-format.md §5.7 `write.base`): every base write on the row or entity,
// newest first — who, when, with what intent and how it came about, each field's items with their
// result, value before and after, interval and sources — and the reads of its versions. It returns
// the current `ver` and, on its first page, counts as reading the row (04-contract §2).
//
// An item's result and interval are the latest the log gives (the source table keeps them as a
// deletion restates them). The value before is what the field held, on the item's start, just
// before the operation: the version table's cell that the operation closed there. Not in this
// version: `premises` (P2), `affected` (derived changes come with `derive`), literal hits (P2).

import type { FieldValue, ItemId, JsonValue, TableId } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry } from "../audit/index.ts";
import { actorsNow } from "../pending/index.ts";
import { get, has, isObj, type Obj } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { READABLE_CONTENT } from "../store/readable-content.ts";
import { valueOut } from "../time/index.ts";
import { isCorrection } from "./correction.ts";
import {
  type HistoryInput,
  type HistoryOutput,
  readsOfTarget,
  type Target,
  taskOf,
} from "./history.ts";
import { intervalOf } from "./interval.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import { declaringOps } from "./premise-entries.ts";
import { cmpKeys, type KeySpec } from "./rows.ts";
import { decode, INSTANT_TEXT, logPosition, physical, restoreCount, selectOf } from "./select.ts";
import {
  type Actor,
  invalid,
  ReadError,
  type SourceRef,
  type TimelineEntry,
  type TimelineField,
  type TimelineResult,
} from "./types.ts";

/** An item's or entry's business time while it is worked out: `[from, to)`, `to` null when open. */
interface Span {
  /** Null: open at the start (09 §5.7). */
  readonly from: string | null;
  readonly to: string | null;
}

type Blocks = Readonly<Record<string, { body: JsonValue | undefined; removed: boolean }>>;

interface BaseEvent {
  readonly seq: number;
  readonly op: number;
  readonly at: string;
  readonly actor: string;
  readonly blocks: Blocks;
}

/** The base writes on the target, newest first, with their blocks. */
async function baseEvents(tx: ReadTx, table: string, id: string): Promise<BaseEvent[]> {
  const heads = await tx.query<{ seq: unknown; op: unknown; at: string; actor: string }>(
    `SELECT seq, op, at, actor FROM events
     WHERE type = 'write.base' AND target_table = $1 AND target_row = $2 ORDER BY seq DESC`,
    [table, id],
  );
  const seqs = heads.rows.map((h) => Number(h.seq));
  const by = new Map<number, Record<string, { body: JsonValue | undefined; removed: boolean }>>();
  if (seqs.length > 0) {
    const r = await tx.query<{
      seq: unknown;
      path: string;
      body: string | null;
      removed_by: unknown;
      pending_by: unknown;
    }>(
      `SELECT seq, path, body, removed_by, pending_by FROM ${READABLE_CONTENT} c
       WHERE seq = ANY($1)`,
      [seqs] as never,
    );
    for (const b of r.rows) {
      const m = by.get(Number(b.seq)) ?? Object.create(null);
      // A block a deletion in its grace period lists reads as deleted already (03 «删除后的样子是
      // 一个新版本»: unreadable in the grace period, marked deleted there).
      m[b.path] = {
        body: b.body === null ? undefined : (JSON.parse(b.body) as JsonValue),
        removed: b.removed_by !== null || b.pending_by !== null,
      };
      by.set(Number(b.seq), m);
    }
  }
  return heads.rows.map((h) => ({
    seq: Number(h.seq),
    op: Number(h.op),
    at: h.at,
    actor: h.actor,
    blocks: by.get(Number(h.seq)) ?? {},
  }));
}

/** The principals by ID, as `Actor`, as they are now (the reads' side of 04-contract-types §1.6). */
export const actors = actorsNow;

type SourceRow = {
  event_seq: unknown;
  field_id: string;
  k: number;
  n: number;
  source_kind: string;
  source_seq: unknown;
  carried_event: unknown;
  carried_field: string | null;
  carried_k: number | null;
  status: string;
  valid_from: string | null;
  valid_to: string | null;
};

const itemKey = (event: number, field: string, k: number) => `${event}/${field}/${k}`;

/** An item's sources block (09 §5.7 `sources/<field>/<k>`) as the source table's rows. */
function fromBlock(body: JsonValue | undefined): SourceRow[] {
  if (!Array.isArray(body)) return [];
  return body.flatMap((x, n): SourceRow[] => {
    if (!isObj(x)) return [];
    const c = get(x, "carried");
    const carried = isObj(c) ? c : undefined;
    return [
      {
        event_seq: null,
        field_id: "",
        k: 0,
        n,
        source_kind: String(get(x, "kind") ?? ""),
        source_seq: typeof get(x, "source") === "number" ? get(x, "source") : null,
        carried_event: carried !== undefined ? get(carried, "event") : null,
        carried_field: carried !== undefined ? (get(carried, "field") as string) : null,
        carried_k: carried !== undefined ? (get(carried, "k") as number) : null,
        status: "",
        valid_from: null,
        valid_to: null,
      },
    ];
  });
}

/** `history` with `mode: "timeline"`. */
export async function timelineInTx(
  tx: ReadTx,
  input: HistoryInput,
  params: Obj,
  target: Target,
): Promise<HistoryOutput<TimelineResult>> {
  const t = target.table;
  const task = taskOf(params, input.task);
  let expand = false;
  if (has(params, "expand_sources")) {
    const v = get(params, "expand_sources");
    if (typeof v !== "boolean") throw invalid("malformed", "expand_sources");
    expand = v;
  }
  const restore = await restoreCount(tx);
  // A later page reads the timeline up to the first page's operation (04-contract §15).
  const latest = await logPosition(tx);
  const identity = digest({
    mode: "timeline",
    table: t.id,
    target: target.id,
    expand_sources: expand,
  });
  // Newest first, as one order over the writes' entries and the restatements' and clearings' (which
  // have no base write): the operation, then the op's index in it, then the base event (a
  // restatement or clearing: 0). Several on one row in one request each keep a place of their own.
  const specs: KeySpec[] = [
    { type: "count", dir: "desc" },
    { type: "count", dir: "desc" },
    { type: "count", dir: "desc" },
  ];
  const position = positionOf(params, { identity, specs, restoreCount: restore, latest });
  const upTo = position?.seq ?? latest;
  const events = (await baseEvents(tx, t.id, target.id)).filter((e) => e.op <= upTo);
  // The premises declared on the row, by op; a restatement or clearing has no base write.
  const declaring = await declaringOps(tx, target.id, upTo, target.named.slot);
  const opIndexOf = (e: BaseEvent) =>
    (e.blocks["target"]?.body as { op_index?: number } | undefined)?.op_index;
  const withBase = new Set(events.map((e) => `${e.op}/${opIndexOf(e)}`));
  const restated = [...declaring.values()].filter((d) => !withBase.has(`${d.op}/${d.index}`));
  const { versions } = physical(t);

  // The items' latest result and interval, and their value sources, from the source table.
  const items = new Map<string, SourceRow[]>();
  const loadItems = async (seqs: readonly number[]) => {
    const want = seqs.filter((s) => ![...items.keys()].some((k) => k.startsWith(`${s}/`)));
    if (want.length === 0) return;
    const r = await tx.query<SourceRow>(
      `SELECT event_seq, field_id, k, n, source_kind, source_seq, carried_event, carried_field, carried_k,
         status, valid_from, valid_to
       FROM base_sources WHERE event_seq = ANY($1) AND row_id = $2 ORDER BY event_seq, field_id, k, n`,
      [want, target.id] as never,
    );
    for (const x of r.rows) {
      const key = itemKey(Number(x.event_seq), x.field_id, x.k);
      items.set(key, [...(items.get(key) ?? []), x]);
    }
  };
  await loadItems(events.map((e) => e.seq));

  // Values before: the cells each operation closed.
  const closed = await tx.query<Record<string, unknown>>(
    `SELECT field_id, rec_to, ${
      t.time.type === "state"
        ? t.time.granularity === "date"
          ? "valid_from::text AS vf, valid_to::text AS vt"
          : `to_char(valid_from, ${INSTANT_TEXT}) AS vf, to_char(valid_to, ${INSTANT_TEXT}) AS vt`
        : "NULL AS vf, NULL AS vt"
    }, ${t.fields.flatMap((f) => selectOf(f).map((x, i) => `${x} AS c_${f.id}_${i}`)).join(", ")}
     FROM ${versions} WHERE row_id = $1 AND rec_to IS NOT NULL`,
    [target.id],
  );
  const before = (fieldId: string, e: BaseEvent, from: string | null): FieldValue | undefined => {
    const f = t.fields.find((x) => x.id === fieldId);
    if (f === undefined) return undefined;
    const op = e.op;
    // An earlier base write of the same request on the field, over this point: its value is the
    // one before (the version table keeps only the state after the whole operation).
    for (const p of events) {
      if (p.op !== op || p.seq >= e.seq) continue;
      for (const [path, block] of Object.entries(p.blocks)) {
        const m = /^fields\/(f[0-9]+)\/([0-9]+)$/.exec(path);
        if (m === null || m[1] !== fieldId || block.removed) continue;
        const body = (block.body ?? {}) as Record<string, unknown>;
        if (body["status"] !== "applied") continue;
        if (from !== null) {
          const span = p.blocks[`span/${fieldId}/${m[2]}`]?.body as
            | { valid?: { from?: string; to?: string } }
            | undefined;
          const v = span?.valid;
          // A span without `from` is taken as not covering: only fields are read here, and a
          // field's span always has a start (09 §1.2). An open start would cover every point.
          if (v?.from === undefined || v.from > from || (v.to !== undefined && from >= v.to))
            continue;
        }
        if (body["no_value"] === true || body["uncovered"] === true) return undefined;
        const value = body["value"] as FieldValue | undefined;
        return value === null ? undefined : value;
      }
    }
    const c = closed.rows.find(
      (x) =>
        x["field_id"] === fieldId &&
        Number(x["rec_to"]) === op &&
        (from === null ||
          ((x["vf"] as string) <= from && (x["vt"] === null || from < (x["vt"] as string)))),
    );
    if (c === undefined) return undefined;
    const v = decode(
      f,
      selectOf(f).map((_, i) => c[`c_${f.id}_${i}`]),
    );
    return v === null ? undefined : v;
  };

  // Sources: the source table's rows by seq (IDs, kinds, levels), texts when asked.
  const sourceSeqs = new Set<number>();
  const carried = async (rows: readonly SourceRow[], depth = 0): Promise<number[]> => {
    const out: number[] = [];
    for (const x of rows) {
      if (x.source_kind !== "value") continue;
      if (x.source_seq !== null) out.push(Number(x.source_seq));
      else if (x.carried_event !== null && depth < 8) {
        const ev = Number(x.carried_event);
        await loadItems([ev]);
        const key = itemKey(ev, x.carried_field as string, x.carried_k as number);
        out.push(...(await carried(items.get(key) ?? [], depth + 1)));
      }
    }
    return out;
  };
  const resolved = new Map<string, number[]>();
  for (const e of events) {
    for (const path of Object.keys(e.blocks)) {
      const m = /^fields\/(f[0-9]+)\/([0-9]+)$/.exec(path);
      if (m === null) continue;
      const key = itemKey(e.seq, m[1] as string, Number(m[2]));
      // The source table keeps the items in effect (and corroborations); a candidate's or an
      // awaiting item's sources are in the event's own block.
      const kept = items.get(key);
      const seqs = await carried(
        kept !== undefined && kept.length > 0
          ? kept
          : fromBlock(e.blocks[`sources/${m[1]}/${m[2]}`]?.body),
      );
      resolved.set(key, seqs);
      for (const s of seqs) sourceSeqs.add(s);
    }
    const ops = e.blocks["op_sources"]?.body;
    if (Array.isArray(ops)) for (const s of ops) sourceSeqs.add(Number(s));
    // A revoke over an interval: where its interval came from (09 §5.7 `valid_sources`).
    const vs = e.blocks["valid_sources"]?.body;
    if (Array.isArray(vs)) for (const s of vs) sourceSeqs.add(Number(s));
  }
  // A write a resolve triggered has no evidence of its own: the resolution's (the `item.resolved`
  // head of the same operation, 09 §5.8 `op_sources`) is its operation's source.
  const resolveSources = new Map<number, number[]>();
  const resolveOps = events
    .filter((e) => {
      const head = e.blocks["target"]?.body as unknown;
      return isObj(head) && get(head, "cause") === "resolve";
    })
    .map((e) => e.op);
  if (resolveOps.length > 0) {
    const r = await tx.query<{ op: unknown; body: string | null }>(
      `SELECT e.op, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'op_sources'
       WHERE e.type = 'item.resolved' AND e.op = ANY($1)`,
      [resolveOps] as never,
    );
    for (const x of r.rows) {
      const seqs = x.body === null ? [] : (JSON.parse(x.body) as unknown[]).map(Number);
      resolveSources.set(Number(x.op), seqs);
      for (const s of seqs) sourceSeqs.add(s);
    }
  }
  const sourceRows = new Map<
    number,
    { id: string; kind: string; level: string | null; state: string }
  >();
  if (sourceSeqs.size > 0) {
    const r = await tx.query<{
      seq: unknown;
      source_id: string;
      kind: string;
      level: string | null;
      deletion_state: string;
    }>("SELECT seq, source_id, kind, level, deletion_state FROM sources WHERE seq = ANY($1)", [
      [...sourceSeqs],
    ] as never);
    for (const x of r.rows)
      sourceRows.set(Number(x.seq), {
        id: x.source_id,
        kind: x.kind,
        level: x.level,
        state: x.deletion_state,
      });
  }
  const texts = new Map<number, string>();
  if (expand && sourceSeqs.size > 0) {
    const r = await tx.query<{ seq: unknown; path: string; body: string | null }>(
      `SELECT seq, path, body FROM ${READABLE_CONTENT} c
       WHERE seq = ANY($1) AND path IN ('text', 'file') AND body IS NOT NULL`,
      [[...sourceSeqs]] as never,
    );
    for (const x of r.rows) {
      const b = JSON.parse(x.body as string) as Record<string, unknown>;
      const text = x.path === "text" ? b["text"] : b["excerpt"];
      if (typeof text === "string") texts.set(Number(x.seq), text);
    }
  }
  const ref = (seq: number, correction: boolean): SourceRef | undefined => {
    const s = sourceRows.get(seq);
    if (s === undefined) return undefined;
    const removed = s.state === "removed";
    const text = texts.get(seq);
    return {
      id: s.id as SourceRef["id"],
      kind: s.kind as SourceRef["kind"],
      ...(correction ? { correction: true as const } : {}),
      ...(s.level !== null ? { level: s.level as NonNullable<SourceRef["level"]> } : {}),
      ...(text !== undefined && !removed ? { text } : {}),
      ...(removed ? { removed: true as const } : {}),
    };
  };

  // Resolutions: the decision of each item a write resolved.
  const resolveItems: string[] = [];
  for (const e of events) {
    const head = e.blocks["target"]?.body as unknown;
    if (isObj(head) && get(head, "cause") === "resolve")
      resolveItems.push(get(head, "item") as string);
  }
  const decisions = new Map<string, string>();
  if (resolveItems.length > 0) {
    const r = await tx.query<{ id: string; decision: string | null }>(
      "SELECT id, decision FROM pending_items WHERE id = ANY($1)",
      [resolveItems] as never,
    );
    for (const x of r.rows) if (x.decision !== null) decisions.set(x.id, x.decision);
  }

  const who = await actors(tx, [...events.map((e) => e.actor), ...restated.map((d) => d.actor)]);
  const fieldName = new Map(t.fields.map((f) => [f.id as string, f.name]));
  const state = t.time.type === "state";
  const date = t.time.type === "state" && t.time.granularity === "date";
  const entries: TimelineEntry[] = events.map((e) => {
    const head = (e.blocks["target"]?.body ?? {}) as Record<string, unknown>;
    const intent = String(head["intent"] ?? "") as TimelineEntry["intent"];
    const correction = isCorrection(head);
    const revert = e.blocks["revert"]?.body as Record<string, unknown> | undefined;
    const via: TimelineEntry["via"] =
      head["cause"] === "resolve"
        ? {
            resolve: head["item"] as ItemId,
            decision: (decisions.get(head["item"] as string) ?? "") as Extract<
              NonNullable<TimelineEntry["via"]>,
              { decision: unknown }
            >["decision"],
          }
        : revert !== undefined && typeof revert["before_op"] === "number"
          ? { undo: revert["before_op"] as never }
          : undefined;
    const opBody = e.blocks["op_sources"]?.body;
    const opSeqs = Array.isArray(opBody)
      ? (opBody as number[])
      : head["cause"] === "resolve"
        ? (resolveSources.get(e.op) ?? [])
        : [];
    const opSources = opSeqs
      .map((s) => ref(Number(s), false))
      .filter((x): x is SourceRef => x !== undefined);
    const vsBody = e.blocks["valid_sources"]?.body;
    const intervalSources = (Array.isArray(vsBody) ? (vsBody as number[]) : [])
      .map((s) => ref(Number(s), false))
      .filter((x): x is SourceRef => x !== undefined);
    const fields: Record<string, TimelineField[]> = Object.create(null);
    let from: string | null | undefined;
    let to: string | null | undefined;
    const widen = (v: Span | undefined) => {
      if (v === undefined) return;
      // `v.from === null` after a start: not reached now (a part open at the start is always
      // existence's k = 0, the first path taken), kept so the widest stays right in any order.
      if (from === undefined || (from !== null && (v.from === null || v.from < from)))
        from = v.from;
      const end = v.to;
      if (to === undefined || (to !== null && (end === null || end > to))) to = end;
    };
    const paths = Object.keys(e.blocks).sort((a, b) => {
      const k = (p: string) => Number(p.split("/").at(-1));
      return a.split("/").slice(0, -1).join("/") === b.split("/").slice(0, -1).join("/")
        ? k(a) - k(b)
        : a < b
          ? -1
          : 1;
    });
    for (const path of paths) {
      const fm = /^fields\/(f[0-9]+)\/([0-9]+)$/.exec(path);
      const em = /^existence\/([0-9]+)$/.exec(path);
      if (fm === null && em === null) continue;
      const fieldId = fm !== null ? (fm[1] as string) : "existence";
      const k = Number(fm !== null ? fm[2] : (em as RegExpExecArray)[1]);
      const block = e.blocks[path] as { body: JsonValue | undefined; removed: boolean };
      const body = (block.body ?? {}) as Record<string, unknown>;
      const rows = items.get(itemKey(e.seq, fieldId, k)) ?? [];
      const latest = rows[0];
      const status = (latest?.status ?? String(body["status"] ?? "")) as TimelineField["result"];
      // The item's interval: the latest given (source table), else the span block.
      let valid: Span | undefined;
      if (state) {
        const span = e.blocks[`span/${fieldId}/${k}`]?.body as Record<string, unknown> | undefined;
        const sv = (span?.["valid"] ?? span?.["seen_valid"]) as
          | { from?: string; to?: string }
          | undefined;
        const vf = latest !== undefined ? latest.valid_from : (sv?.from ?? null);
        const vt = latest !== undefined ? latest.valid_to : (sv?.to ?? null);
        // A missing start is open (09 §5.7); a part with no span at all has none to give, but for
        // the caller's revoke of the whole entity (scope whole, applied or not): the whole time,
        // as its receipt gives it.
        if (latest !== undefined || sv !== undefined) valid = { from: vf ?? null, to: vt ?? null };
        else if (fieldId === "existence" && body["scope"] === "whole")
          valid = { from: null, to: null };
      }
      widen(valid);
      const noValue = body["no_value"] === true;
      const uncovered = body["uncovered"] === true;
      const hasValue = !noValue && !uncovered && "value" in body && !block.removed;
      const prior =
        fieldId === "existence" || status !== "applied"
          ? undefined
          : before(fieldId, e, valid?.from ?? null);
      const valueSources = (resolved.get(itemKey(e.seq, fieldId, k)) ?? [])
        .map((s) => ref(s, correction))
        .filter((x): x is SourceRef => x !== undefined);
      const item: TimelineField = {
        result: status,
        ...(noValue ? { no_value: true as const } : {}),
        ...(uncovered ? { uncovered: true as const } : {}),
        ...(prior !== undefined ? { before: valueOut(prior) } : {}),
        ...(hasValue ? { after: valueOut(body["value"] as FieldValue) } : {}),
        ...(valid !== undefined ? { valid: intervalOf(valid.from, valid.to, date) } : {}),
        ...(block.removed ? { removed: true as const } : {}),
        // Existence has no value: a revoke over an interval has the interval's sources as its
        // value sources (09 §5.7 `valid_sources`, data), and every revoke and write-back its
        // operation's sources (`op_sources`, control: a revoke's evidence not taken as the
        // interval's); an event from before them has neither, and gives empty lists.
        sources: {
          value: fieldId === "existence" ? intervalSources : valueSources,
          operation: opSources,
        },
      };
      const name = fieldId === "existence" ? "*" : (fieldName.get(fieldId) ?? fieldId);
      fields[name] = [...(fields[name] ?? []), item];
    }
    const shown: Record<string, TimelineField | readonly TimelineField[]> = Object.create(null);
    for (const [name, list] of Object.entries(fields))
      shown[name] = list.length === 1 ? (list[0] as TimelineField) : list;
    return {
      seq: e.op as never,
      recorded_at: e.at,
      actor: who.get(e.actor) as Actor,
      intent,
      ...(via !== undefined ? { via } : {}),
      // The write's widest interval (04-contract-types §4.3): open at the start when a part is.
      ...(state && from !== undefined ? { valid: intervalOf(from, to, date) } : {}),
      fields: shown,
      ...(() => {
        const d = declaring.get(`${e.op}/${opIndexOf(e)}`);
        return d !== undefined ? { premises: d.premises } : {};
      })(),
    };
  });
  // A restatement or a clearing: an entry of its own, no field written.
  const keyed = [
    ...entries.map((item, n) => {
      const e = events[n] as BaseEvent;
      return { item, keys: [e.op, opIndexOf(e) ?? 0, e.seq] };
    }),
    ...restated.map((d) => ({
      item: {
        seq: d.op as never,
        recorded_at: d.at,
        actor: who.get(d.actor) as Actor,
        intent: "update" as const,
        fields: {},
        premises: d.premises,
      } satisfies TimelineEntry,
      keys: [d.op, d.index, 0],
    })),
  ].sort((a, b) => cmpKeys(specs, a.keys, b.keys));

  // Page: newest first, by the entries' events.
  const { page, next } = pageAfter(
    keyed.map(({ item, keys }) => ({ item, keys })),
    {
      specs,
      identity,
      position,
      seq: upTo,
      at: position?.at ?? input.now,
      restoreCount: restore,
      limit: limitOf(params),
    },
  );

  // The version, as of the first page's operation (the current one on a first page).
  const vr = await tx.query<{ v: unknown }>(
    `SELECT max(rec_from) AS v FROM ${versions}
     WHERE row_id = $1 AND rec_from <= $2 AND intent <> 'schema_switch'`,
    [target.id, upTo],
  );
  const verOp = vr.rows[0]?.v;
  if (verOp === null || verOp === undefined) {
    // A position from before the target existed: not one this call gave.
    if (position !== undefined) throw invalid("malformed", "position");
    throw new ReadError("internal", "no version");
  }
  const ver = Number(verOp);

  // The reads of the target's versions: on the first page only (later ones would mix in reads
  // made since).
  const reads = position === undefined ? await readsOfTarget(tx, input.reads, t.id, target.id) : [];
  const readers = await actors(
    tx,
    reads.map((r) => r.actor),
  );
  const qualified = `${target.named.slot.name}.${t.name}`;
  const result: TimelineResult = {
    mode: "timeline",
    target: {
      table: qualified,
      ...(target.kind === "state" ? { entity: target.id as never } : { row: target.id as never }),
    },
    sv: target.named.slot.sv,
    timezone: target.named.slot.timezone,
    ver: `v${ver}.${restore}`,
    total: keyed.length,
    ...(next !== undefined ? { next_position: next } : {}),
    entries: page,
    ...(reads.length > 0
      ? {
          reads: reads.map((r) => ({
            read: r.read,
            // The version read (the operation number in its ver).
            seq: (r.ver ?? r.pos) as never,
            at: r.at,
            actor: readers.get(r.actor) as Actor,
            ...(r.task !== null ? { task: r.task } : {}),
          })),
        }
      : {}),
  };
  const tableId = t.id as TableId;
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    pos: upTo as never,
    operation: "history",
    slot: target.named.slot.slot,
    sv: target.named.slot.sv,
    table: tableId,
    shape: canonicalize({ mode: "timeline", table: t.id, target: target.id }),
    rows: [{ table: tableId, target: target.id, ver: { op: ver as never, restoreCount: restore } }],
    coarse: [],
    // The first page returns the current version: a row read (04-contract §2). A later page's is
    // the first page's, not counted again.
    lastRead:
      position === undefined
        ? [
            { kind: "ver", target: target.id, op: ver, restoreCount: restore },
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
