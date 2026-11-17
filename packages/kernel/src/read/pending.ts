// `pending` (docs/zh-CN/spec/04-contract.md §10 `pending`; 04-contract-types.md §4.8): the pending
// items within the visible range — a list, or one item's detail.
// - The list: by `slot`, `type`, `status` (open by default), the longest pending first (opened
//   earliest, then by ID), paged; a later page lists the items opened up to the first page's
//   operation, in their state now. Listing items does not count as reading them.
// - The detail (`id`): the item's contents from its latest entries (../pending/detail.ts), its
//   version, the decisions open to it, and how it closed. Reading an open item's detail counts as
//   reading its version (04-contract §2 «什么算读到 item_ver»); a closed one's is given, not counted.
// In this version the detail is of `conflict` and `awaiting_confirmation` items; `flagged` (P2) and
// `schema_change` (P4) items are not opened yet, so their detail is not implemented; `deletion`
// items and migration jobs come later.

import type { CompiledBaseTable, Instant, PrincipalId } from "@fluxvita/saveslot-contract-core";
import { canonicalize } from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadId } from "../audit/index.ts";
import {
  candidateImpactBlocks,
  candidatesOut,
  closingOf,
  type ItemEntries,
  impactOut,
  itemEntries,
  itemVer,
  type Naming,
  proposalOut,
  type Span,
  targetOut,
} from "../pending/index.ts";
import { fold, get, has, isObj, keysOf } from "../request/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { valueOut, valuesOut } from "../time/index.ts";
import { taskOf } from "./history.ts";
import { type Piece, piecesOver, rowCellsAsOf, rowOf } from "./item-state.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import type { KeySpec } from "./rows.ts";
import { logPosition, restoreCount } from "./select.ts";
import { type Visibility, type VisibleSlot, visibleSlots } from "./slots.ts";
import { actors } from "./timeline.ts";
import { type Actor, invalid, notImplemented, ReadError } from "./types.ts";

export interface PendingInput {
  readonly actor: PrincipalId;
  readonly task: string | null;
  readonly now: Instant;
  readonly visibility: Visibility;
  readonly params: unknown;
  readonly read: ReadId;
}

const TYPES = new Set([
  "awaiting_confirmation",
  "flagged",
  "conflict",
  "schema_change",
  "deletion",
  "migration_diff",
]);
const STATUSES = new Set(["open", "resolved", "superseded", "all"]);
const LIST_KEYS = new Set(["slot", "type", "status", "limit", "position", "task"]);
const DETAIL_KEYS = new Set(["id", "task"]);
const ITEM_ID = /^pi_[0-9A-HJKMNP-TV-Z]{16}$/;
const JOB_ID = /^jb_/;

const DECISIONS: Readonly<Record<string, readonly string[]>> = {
  conflict: ["keep_effective", "take_candidate", "take_previous"],
  awaiting_confirmation: ["confirm", "reject"],
};

type ItemRow = {
  id: string;
  type: string;
  slot_id: string | null;
  target_table: string | null;
  target_row: string | null;
  state: string;
  version_op: unknown;
  opened_op: unknown;
  opened_at: string;
  opened_by: string;
  reason: string | null;
};

const ITEMS = `SELECT p.id, p.type, p.slot_id, p.target_table, p.target_row, p.state, p.version_op,
    e.op AS opened_op, h.at AS opened_at, h.actor AS opened_by,
    c.body::jsonb ->> 'reason' AS reason
  FROM pending_items p
  JOIN content c ON c.path = 'target' AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = p.id
  JOIN events e ON e.seq = c.seq AND e.type = 'item.created'
  JOIN events h ON h.seq = e.op`;

/** Where an item is, if it is within the visible range. */
function placeOf(
  x: ItemRow,
  slots: readonly VisibleSlot[],
): { slot: VisibleSlot; table: VisibleSlot["tables"][number] | undefined } | undefined {
  const slot = slots.find((s) => s.slot === x.slot_id);
  if (slot === undefined) return undefined;
  if (x.target_table === null) return { slot, table: undefined };
  const table = slot.tables.find((t) => t.id === x.target_table);
  return table === undefined ? undefined : { slot, table };
}

const dayBefore = (d: string) =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10);

function namingOf(
  table: VisibleSlot["tables"][number] | undefined,
  who: ReadonlyMap<string, Actor>,
): Naming<Actor> {
  const isState = table !== undefined && table.kind === "base" && table.time.type === "state";
  const byDate =
    table !== undefined &&
    table.kind === "base" &&
    table.time.type === "state" &&
    table.time.granularity === "date";
  return {
    isState,
    field: (id) => table?.fields.find((f) => f.id === id)?.name ?? id,
    interval: (s: Span) => ({
      valid_from: s.from,
      valid_to: s.to,
      ...(byDate && s.to !== null ? { valid_to_inclusive: dayBefore(s.to) } : {}),
    }),
    actor: (p) => who.get(p) ?? { kind: p === "system" ? "system" : "user", id: p, name: p },
    value: valueOut,
  };
}

function targetRef(
  x: ItemRow,
  place: { slot: VisibleSlot; table: VisibleSlot["tables"][number] | undefined },
  n: Naming<Actor>,
) {
  const table = place.table;
  return {
    table: `${place.slot.name}.${table?.name ?? ""}`,
    ...(n.isState ? { entity: x.target_row } : { row: x.target_row }),
  };
}

/** The principals behind the entries and the opening, as contract actors. */
async function whoOf(tx: ReadTx, rows: readonly ItemRow[], entries: Iterable<ItemEntries>) {
  const ids = new Set<string>(rows.map((x) => x.opened_by));
  for (const e of entries) for (const a of e.actorOfOp.values()) ids.add(a);
  return actors(tx, [...ids]);
}

export async function pendingInTx(
  tx: ReadTx,
  input: PendingInput,
): Promise<{ readonly result: Record<string, unknown>; readonly entry: ReadEntry }> {
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  const detail = has(params, "id");
  const allowed = detail ? DETAIL_KEYS : LIST_KEYS;
  for (const k of keysOf(params)) if (!allowed.has(k)) throw invalid("malformed", k);
  const task = taskOf(params, input.task);
  const slots = await visibleSlots(tx, input.visibility);
  const latest = await logPosition(tx);
  const restore = await restoreCount(tx);
  const base = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    operation: "pending" as const,
  };
  return detail
    ? detailOf(tx, get(params, "id"), slots, restore, latest, base)
    : listOf(tx, params, slots, restore, latest, input.now, base);
}

type Base = Pick<ReadEntry, "read" | "actor" | "task" | "at" | "operation">;

async function listOf(
  tx: ReadTx,
  params: Readonly<Record<string, unknown>>,
  slots: readonly VisibleSlot[],
  restore: number,
  latest: number,
  now: Instant,
  base: Base,
) {
  let only: VisibleSlot | undefined;
  if (has(params, "slot")) {
    const v = get(params, "slot");
    if (typeof v !== "string" || v === "") throw invalid("malformed", "slot");
    only = slots.find((s) => fold(s.name) === fold(v) || s.slot === v);
    if (only === undefined)
      throw new ReadError("not_found", "no such slot", { reason: "slot", param: "slot" });
  }
  let type: string | undefined;
  if (has(params, "type")) {
    const v = get(params, "type");
    if (typeof v !== "string" || !TYPES.has(v)) throw invalid("malformed", "type");
    type = v;
  }
  let status = "open";
  if (has(params, "status")) {
    const v = get(params, "status");
    if (typeof v !== "string" || !STATUSES.has(v)) throw invalid("malformed", "status");
    status = v;
  }
  const limit = limitOf(params);
  const identity = digest({ slot: only?.slot ?? null, type: type ?? null, status });
  const specs: KeySpec[] = [
    { type: "text", dir: "asc" },
    { type: "text", dir: "asc" },
  ];
  const position = positionOf(params, { identity, specs, restoreCount: restore, latest });
  const upTo = position?.seq ?? latest;
  const r = await tx.query<ItemRow>(`${ITEMS} WHERE e.op <= $1 ORDER BY h.at, p.id`, [upTo]);
  const kept = r.rows.flatMap((x) => {
    const place = placeOf(x, slots);
    if (place === undefined) return [];
    if (only !== undefined && place.slot.slot !== only.slot) return [];
    if (type !== undefined && x.type !== type) return [];
    if (status !== "all" && x.state !== status) return [];
    return [{ item: { x, place }, keys: [x.opened_at, x.id] as (string | null)[] }];
  });
  const { page, next } = pageAfter(kept, {
    specs,
    identity,
    position,
    seq: upTo,
    at: position?.at ?? now,
    restoreCount: restore,
    limit,
  });
  const entries = await itemEntries(
    tx,
    page.map((p) => p.x.id),
  );
  const who = await whoOf(
    tx,
    page.map((p) => p.x),
    entries.values(),
  );
  const items = page.map(({ x, place }) => {
    const n = namingOf(place.table, who);
    const e = entries.get(x.id);
    return {
      id: x.id,
      type: x.type,
      status: x.state,
      slot: place.slot.name,
      ...(x.target_table !== null
        ? { target: { ...targetRef(x, place, n), ...(e !== undefined ? targetOut(e, n) : {}) } }
        : {}),
      reason: x.reason,
      opened_at: x.opened_at,
      opened_by: n.actor(x.opened_by),
    };
  });
  const entry: ReadEntry = {
    ...base,
    pos: upTo as never,
    ...(only !== undefined ? { slot: only.slot, sv: only.sv } : {}),
    shape: canonicalize({ list: true, slot: only?.slot ?? null, type: type ?? null, status }),
    rows: [],
    coarse: [],
    // Listing items is not reading them (04-contract §2).
    lastRead: [],
  };
  return {
    result: { total: kept.length, ...(next !== undefined ? { next_position: next } : {}), items },
    entry,
  };
}

async function detailOf(
  tx: ReadTx,
  id: unknown,
  slots: readonly VisibleSlot[],
  restore: number,
  latest: number,
  base: Base,
) {
  if (typeof id === "string" && JOB_ID.test(id))
    throw new ReadError("not_in_this_version", "jobs are not in this version", {
      reason: "parameter",
      param: "id",
    });
  if (typeof id !== "string" || !ITEM_ID.test(id)) throw invalid("malformed", "id");
  const r = await tx.query<ItemRow>(`${ITEMS} WHERE p.id = $1`, [id]);
  const x = r.rows[0];
  const place = x === undefined ? undefined : placeOf(x, slots);
  // Out of the visible range is as not there.
  if (x === undefined || place === undefined)
    throw new ReadError("not_found", "no such item", { reason: "item", param: "id" });
  if (x.type !== "conflict" && x.type !== "awaiting_confirmation")
    throw notImplemented("id", `the detail of a ${x.type} item`);
  const e = (await itemEntries(tx, [x.id])).get(x.id) as ItemEntries;
  const closed = await closingOf(tx, x.id);
  const who = await whoOf(tx, [x], [e]);
  for (const [, a] of await actors(tx, closed.principals)) who.set(a.id, a);
  const n = namingOf(place.table, who);
  const versionOp = Number(x.version_op);
  const open = x.state === "open";
  const common = {
    id: x.id,
    type: x.type,
    item_ver: itemVer(x.id, versionOp, restore),
    status: x.state,
    slot: place.slot.name,
    reason: x.reason,
    opened_at: x.opened_at,
    opened_by: n.actor(x.opened_by),
    decisions: open ? [...(DECISIONS[x.type] ?? [])] : [],
    ...closed.out(n.actor),
    target: { ...targetRef(x, place, n), ...targetOut(e, n) },
  };
  const result =
    x.type === "conflict"
      ? { ...common, ...(await conflictOf(tx, e, n, place.table, versionOp)) }
      : { ...common, ...(await awaitingOf(tx, e, n, place.table, versionOp)) };
  const entry: ReadEntry = {
    ...base,
    pos: latest as never,
    slot: place.slot.slot,
    sv: place.slot.sv,
    ...(place.table !== undefined ? { table: place.table.id as never } : {}),
    shape: canonicalize({ item: x.id }),
    rows: [],
    coarse: [],
    // An open item's version is read; a closed one's cannot be used, so it is not kept.
    lastRead: open ? [{ kind: "item", target: x.id, op: versionOp, restoreCount: restore }] : [],
  };
  return { result, entry };
}

type Table = VisibleSlot["tables"][number] | undefined;

/** The principals of operations, as contract actors. */
async function actorsOfOps(tx: ReadTx, ops: readonly number[]): Promise<Map<number, Actor>> {
  if (ops.length === 0) return new Map();
  const r = await tx.query<{ seq: unknown; actor: string }>(
    "SELECT seq, actor FROM events WHERE seq = ANY($1)",
    [[...new Set(ops)]] as never,
  );
  const who = await actors(
    tx,
    r.rows.map((x) => x.actor),
  );
  return new Map(r.rows.map((x) => [Number(x.seq), who.get(x.actor) as Actor]));
}

/**
 * The row behind the item as of operation `op`, limited to its spans and unit (./item-state.ts):
 * state tables by piece, each with the write that gave it; event and timeless tables whole.
 */
async function sideOf(tx: ReadTx, e: ItemEntries, n: Naming<Actor>, table: Table, op: number) {
  const t = table as CompiledBaseTable;
  const cells = await rowCellsAsOf(tx, t, e.row as string, op);
  if (n.isState) {
    const pieces = piecesOver(t, cells, e.scope, e.unit);
    const who = await actorsOfOps(
      tx,
      pieces.flatMap((p) => (p.op !== undefined ? [p.op] : [])),
    );
    return { kind: "state" as const, pieces, who };
  }
  const row = rowOf(t, cells, e.unit);
  const who = await actorsOfOps(tx, row.op !== undefined ? [row.op] : []);
  return { kind: "row" as const, row, who };
}

const pieceOut = (n: Naming<Actor>, p: Piece) => ({
  ...n.interval({ from: p.from, to: p.to }),
  values: p.values === null ? null : valuesOut(p.values),
});

async function conflictOf(
  tx: ReadTx,
  e: ItemEntries,
  n: Naming<Actor>,
  table: Table,
  versionOp: number,
) {
  const candidates = candidatesOut(e, n);
  const impacts = candidates.flatMap((c) => {
    const event = e.candidates.get(c.index)?.["event"] as number;
    const blocks = candidateImpactBlocks(e, event);
    return blocks.length > 0 ? [[String(c.index), impactOut(e, n, blocks)] as const] : [];
  });
  // The side in effect as of the item's version; the merge base's as of its operation.
  const now = await sideOf(tx, e, n, table, versionOp);
  let effective: Record<string, unknown>;
  if (now.kind === "state") {
    const top = Math.max(0, ...now.pieces.map((p) => p.op ?? 0));
    effective = {
      ...(top > 0 ? { seq: top, actor: now.who.get(top) } : {}),
      spans: now.pieces.map((p) => ({
        ...pieceOut(n, p),
        ...(p.op !== undefined ? { seq: p.op, actor: now.who.get(p.op) } : {}),
      })),
      exists: now.pieces.some((p) => p.values !== null),
    };
  } else {
    const r = now.row;
    effective = {
      ...(r.op !== undefined ? { seq: r.op, actor: now.who.get(r.op) } : {}),
      ...(r.values !== undefined ? { values: valuesOut(r.values) } : {}),
      exists: r.exists,
    };
  }
  // A conflict item always has a merge base (09-event-format: `merge_base_op` on every conflict
  // item event), so `previous` is always given. The merge base is a `ver` a candidate brought, a
  // version of the row; `exists` is false where the row was revoked there.
  if (e.mergeBase === undefined) {
    throw new ReadError("internal", "a conflict item without a merge base");
  }
  const base = await sideOf(tx, e, n, table, e.mergeBase);
  const previous =
    base.kind === "state"
      ? {
          seq: e.mergeBase,
          exists: base.pieces.some((p) => p.values !== null),
          spans: base.pieces.map((p) => pieceOut(n, p)),
        }
      : {
          seq: e.mergeBase,
          exists: base.row.exists,
          ...(base.row.values !== undefined ? { values: valuesOut(base.row.values) } : {}),
        };
  return {
    effective,
    candidates,
    ...(e.relatedItem !== undefined ? { related_item: e.relatedItem } : {}),
    previous,
    reverted_by_previous: e.impact
      .filter((b) => b["kind"] === "reverted_write")
      .map((b) => ({
        seq: b["op"] as number,
        actor: n.actor(e.actorOfOp.get(b["op"] as number) ?? ""),
      })),
    ...(impacts.length > 0 ? { candidate_impact: Object.fromEntries(impacts) } : {}),
  };
}

async function awaitingOf(
  tx: ReadTx,
  e: ItemEntries,
  n: Naming<Actor>,
  table: Table,
  versionOp: number,
) {
  // The write that proposed it: its operation, actor, intent, and a revert's target.
  const origin = e.originEvent as number;
  const op = e.opOfEvent.get(origin) ?? origin;
  const t = await tx.query<{ body: string }>(
    "SELECT body FROM content WHERE seq = $1 AND path = 'target' AND body IS NOT NULL",
    [origin],
  );
  const target = JSON.parse(t.rows[0]?.body ?? "{}") as { intent?: string; op_index?: number };
  const rv = await tx.query<{ body: string }>(
    "SELECT body FROM content WHERE seq = $1 AND path = $2 AND body IS NOT NULL",
    [op, `ops/${target.op_index ?? 0}/revert`],
  );
  const revert =
    rv.rows[0] === undefined
      ? undefined
      : (JSON.parse(rv.rows[0].body) as { undo_op: number; include_later: boolean });
  return {
    proposal: {
      seq: op,
      actor: n.actor(e.actorOfOp.get(op) ?? ""),
      intent: target.intent ?? "",
      ...(revert !== undefined
        ? {
            revert: {
              undo: revert.undo_op,
              ...(revert.include_later ? { include_later: true } : {}),
            },
          }
        : proposalOut(e, n)),
    },
    current: currentOf(n, await sideOf(tx, e, n, table, versionOp)),
    impact: impactOut(e, n, e.impact),
  };
}

/** The awaiting item's current side (`AwaitingDetail.current`): the row as of the item's version. */
function currentOf(n: Naming<Actor>, side: Awaited<ReturnType<typeof sideOf>>) {
  if (side.kind === "state") return { spans: side.pieces.map((p) => pieceOut(n, p)) };
  return side.row.values !== undefined ? { values: valuesOut(side.row.values) } : {};
}
