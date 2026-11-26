// `pending` (docs/zh-CN/spec/04-contract.md §10 `pending`; 04-contract-types.md §4.8): the pending
// items within the visible range — a list, or one item's detail.
// - The list: by `slot`, `type`, `status` (open by default), the longest pending first (opened
//   earliest, then by ID), paged; a later page lists the items opened up to the first page's
//   operation, in their state now. Listing items does not count as reading them.
// - The detail (`id`): the item's contents from its latest entries (../pending/detail.ts), its
//   version, the decisions open to it, and how it closed. Reading an open item's detail counts as
//   reading its version (04-contract §2 «什么算读到 item_ver»); a closed one's is given, not counted.
// In this version the detail is of `conflict`, `awaiting_confirmation`, `flagged` and
// `schema_change` items; `deletion` items and
// migration jobs come later. The decisions are those of the item's type: which of them the
// caller's credential may take is the service layer's to say (it filters them by scope).

import type {
  CompiledBaseTable,
  CompiledSchema,
  DateStr,
  DraftId,
  EntityId,
  EventDecision,
  EventItemType,
  Instant,
  Intent,
  ItemCreatedReason,
  ItemId,
  PrincipalId,
  RowId,
  SchemaChangeRecord,
} from "@fluxvita/saveslot-contract-core";
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
  readPendingTargets,
  revertedOut,
  type Span,
  targetOut,
} from "../pending/index.ts";
import { fold, get, has, isObj, keysOf } from "../request/index.ts";
import { changesByName } from "../schema/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { type ValueOut, valueOut, valuesOut } from "../time/index.ts";
import { taskOf } from "./history.ts";
import { type Piece, piecesOver, rowCellsAsOf, rowOf } from "./item-state.ts";
import { digest, limitOf, pageAfter, positionOf } from "./page.ts";
import type { KeySpec } from "./rows.ts";
import { logPosition, restoreCount } from "./select.ts";
import { type Visibility, type VisibleSlot, visibleSlots, wholeSlot } from "./slots.ts";
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

const DECISIONS: Readonly<Record<string, readonly EventDecision[]>> = {
  conflict: ["keep_effective", "take_candidate", "take_previous"],
  awaiting_confirmation: ["confirm", "reject"],
  schema_change: ["confirm", "reject"],
  flagged: ["keep", "revoke"],
};

export type ItemRow = {
  id: ItemId;
  type: EventItemType;
  slot_id: string | null;
  target_table: string | null;
  target_row: string | null;
  state: "open" | "resolved" | "superseded";
  version_op: unknown;
  opened_op: unknown;
  opened_at: string;
  opened_by: string;
  reason: ItemCreatedReason | null;
};

export const ITEMS = `SELECT p.id, p.type, p.slot_id, p.target_table, p.target_row, p.state, p.version_op,
    e.op AS opened_op, h.at AS opened_at, h.actor AS opened_by,
    c.body::jsonb ->> 'reason' AS reason
  FROM pending_items p
  JOIN content c ON c.path = 'target' AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = p.id
  JOIN events e ON e.seq = c.seq AND e.type = 'item.created'
  JOIN events h ON h.seq = e.op`;

/**
 * Where an item is, if it is within the visible range. A `schema_change` item is about the slot's
 * schema as a whole: within the range only with every table of the slot in it.
 */
export function placeOf(
  x: ItemRow,
  slots: readonly VisibleSlot[],
): { slot: VisibleSlot; table: VisibleSlot["tables"][number] | undefined } | undefined {
  const slot = slots.find((s) => s.slot === x.slot_id);
  if (slot === undefined) return undefined;
  if (x.type === "schema_change" && !wholeSlot(slot)) return undefined;
  if (x.target_table === null) return { slot, table: undefined };
  const table = slot.tables.find((t) => t.id === x.target_table);
  return table === undefined ? undefined : { slot, table };
}

/**
 * The type of the item `id` if the caller sees it (as the detail would find it), else undefined:
 * nothing else of it. For the service layer, which checks a decision's scope by the item's type
 * (02-architecture §5: the kernel knows only the visible range). Not a read: nothing is recorded.
 */
export async function pendingItemTypeInTx(
  tx: ReadTx,
  visibility: Visibility,
  id: string,
): Promise<EventItemType | undefined> {
  if (!ITEM_ID.test(id)) return undefined;
  const r = await tx.query<ItemRow>(`${ITEMS} WHERE p.id = $1`, [id]);
  const x = r.rows[0];
  if (x === undefined) return undefined;
  return placeOf(x, await visibleSlots(tx, visibility)) === undefined ? undefined : x.type;
}

const dayBefore = (d: string): DateStr =>
  new Date(Date.parse(`${d}T00:00:00Z`) - 86_400_000).toISOString().slice(0, 10) as DateStr;

/** An item's interval (04-contract-types `Interval`): the whole time has both ends null. */
export interface ItemInterval {
  readonly valid_from: string | null;
  readonly valid_to: string | null;
  readonly valid_to_inclusive?: DateStr;
}

/** How the details write names, intervals, actors and values. */
type N = Naming<Actor, ValueOut, ItemInterval>;

function namingOf(
  table: VisibleSlot["tables"][number] | undefined,
  who: ReadonlyMap<string, Actor>,
  slot?: VisibleSlot,
): N {
  const isState = table !== undefined && table.kind === "base" && table.time.type === "state";
  const byDate =
    table !== undefined &&
    table.kind === "base" &&
    table.time.type === "state" &&
    table.time.granularity === "date";
  return {
    isState,
    ...(slot !== undefined
      ? {
          table: (id: string) => {
            const t = slot.tables.find((x) => x.id === id);
            return t === undefined ? undefined : `${slot.name}.${t.name}`;
          },
          fieldOf: (tid: string, fid: string) => {
            const t = slot.tables.find((x) => x.id === tid);
            return (
              (t?.kind === "base" ? t.fields.find((f) => f.id === fid)?.name : undefined) ?? fid
            );
          },
        }
      : {}),
    field: (id) => table?.fields.find((f) => f.id === id)?.name ?? id,
    interval: (s: Span): ItemInterval => ({
      valid_from: s.from,
      valid_to: s.to,
      ...(byDate && s.to !== null ? { valid_to_inclusive: dayBefore(s.to) } : {}),
    }),
    actor: (p) => who.get(p) ?? { kind: p === "system" ? "system" : "user", id: p, name: p },
    value: valueOut,
  };
}

/** An item's reason: every item event gives one (09-event-format §5.8 `item.created`). */
function reasonOf(x: ItemRow): ItemCreatedReason {
  if (x.reason === null) throw new ReadError("internal", `item ${x.id} without its reason`);
  return x.reason;
}

function targetRef(
  x: ItemRow,
  place: { slot: VisibleSlot; table: VisibleSlot["tables"][number] | undefined },
  n: N,
) {
  const table = place.table;
  // An item with a target table always names its row (09-event-format §5.8 `target`).
  if (x.target_row === null) throw new ReadError("internal", `item ${x.id} without its row`);
  return {
    table: `${place.slot.name}.${table?.name ?? ""}`,
    ...(n.isState ? { entity: x.target_row as EntityId } : { row: x.target_row as RowId }),
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
): Promise<{ readonly result: PendingReadResult; readonly entry: ReadEntry }> {
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
  // The page's open items whose targets pending deletions affect: read once for the page.
  const pendingTargets = page.some((p) => p.x.state === "open" && p.x.target_row !== null)
    ? await readPendingTargets(tx)
    : undefined;
  const items = page.map(({ x, place }) => {
    const n = namingOf(place.table, who, place.slot);
    const e = entries.get(x.id);
    const blocked =
      x.state === "open" &&
      x.type !== "schema_change" &&
      x.target_table !== null &&
      x.target_row !== null &&
      pendingTargets?.on(x.target_table, x.target_row) !== undefined;
    return {
      id: x.id,
      type: x.type,
      status: x.state,
      slot: place.slot.name,
      ...(x.target_table !== null
        ? { target: { ...targetRef(x, place, n), ...(e !== undefined ? targetOut(e, n) : {}) } }
        : {}),
      reason: reasonOf(x),
      opened_at: x.opened_at,
      opened_by: n.actor(x.opened_by),
      ...(blocked ? { blocked: true as const } : {}),
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
  if (
    x.type !== "conflict" &&
    x.type !== "awaiting_confirmation" &&
    x.type !== "schema_change" &&
    x.type !== "flagged"
  )
    throw notImplemented("id", `the detail of a ${x.type} item`);
  const e = (await itemEntries(tx, [x.id])).get(x.id) as ItemEntries;
  const closed = await closingOf(tx, x.id);
  const who = await whoOf(tx, [x], [e]);
  for (const [, a] of await actors(tx, closed.principals)) who.set(a.id, a);
  const n = namingOf(place.table, who, place.slot);
  const versionOp = Number(x.version_op);
  const open = x.state === "open";
  // An open item whose target a pending deletion affects takes no decision now (04-contract
  // «目标受一项仍待执行的删除影响的事项»).
  const blocked =
    open && x.type !== "schema_change" && x.target_table !== null && x.target_row !== null
      ? (await readPendingTargets(tx)).on(x.target_table, x.target_row)
      : undefined;
  const common = {
    id: x.id,
    item_ver: itemVer(x.id, versionOp, restore),
    status: x.state,
    slot: place.slot.name,
    reason: reasonOf(x),
    opened_at: x.opened_at,
    opened_by: n.actor(x.opened_by),
    decisions: open && blocked === undefined ? [...(DECISIONS[x.type] ?? [])] : [],
    ...(blocked !== undefined
      ? {
          blocked: {
            reason: "pending_deletion" as const,
            deletions: [...blocked.deletions],
            expires_at: blocked.expiresAt,
          },
        }
      : {}),
    ...closed.out(n.actor),
  };
  const result =
    x.type === "schema_change"
      ? { ...common, type: "schema_change" as const, ...(await schemaChangeOf(tx, x.id)) }
      : x.type === "flagged"
        ? {
            ...common,
            target: { ...targetRef(x, place, n), ...targetOut(e, n) },
            type: "flagged" as const,
            ...(await flaggedOf(tx, e, n, place, versionOp)),
          }
        : x.type === "conflict"
          ? {
              ...common,
              target: { ...targetRef(x, place, n), ...targetOut(e, n) },
              type: "conflict" as const,
              ...(await conflictOf(tx, e, n, place.table, versionOp)),
            }
          : {
              ...common,
              target: { ...targetRef(x, place, n), ...targetOut(e, n) },
              type: "awaiting_confirmation" as const,
              ...(await awaitingOf(tx, e, n, place.table, versionOp)),
            };
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
async function sideOf(tx: ReadTx, e: ItemEntries, n: N, table: Table, op: number) {
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

const pieceOut = (n: N, p: Piece) => ({
  ...n.interval({ from: p.from, to: p.to }),
  values: p.values === null ? null : valuesOut(p.values),
});

/**
 * A flagged item's detail (04-contract-types §4.8 `FlaggedDetail`): the rows it matched, latest
 * written first, as its entries give them; the `duplicate_keys` group that matched, from its
 * write's `duplicate` block (none left once a deletion cleared it); the flagged row's values on
 * those fields as of the item's version.
 */
async function flaggedOf(
  tx: ReadTx,
  e: ItemEntries,
  n: N,
  place: { slot: VisibleSlot; table: Table },
  versionOp: number,
) {
  const t = place.table as CompiledBaseTable;
  const r =
    e.originEvent === undefined
      ? undefined
      : (
          await tx.query<{ body: string | null }>(
            "SELECT body FROM content WHERE seq = $1 AND path = 'duplicate'",
            [e.originEvent],
          )
        ).rows[0]?.body;
  const keys: string[] = typeof r === "string" ? (JSON.parse(r) as { keys: string[] }).keys : [];
  const row =
    keys.length > 0
      ? rowOf(t, await rowCellsAsOf(tx, t, e.row as string, versionOp), keys)
      : undefined;
  return {
    related: e.matched.map((b) => ({
      table: `${place.slot.name}.${t.name}`,
      row: b["row"] as RowId,
    })),
    keys: keys.map((f) => n.field(f)),
    ...(row?.values !== undefined ? { matched_values: valuesOut(row.values) } : {}),
  };
}

async function conflictOf(tx: ReadTx, e: ItemEntries, n: N, table: Table, versionOp: number) {
  const candidates = candidatesOut(e, n);
  const impacts = candidates.flatMap((c) => {
    const event = e.candidates.get(c.index)?.["event"] as number;
    const blocks = candidateImpactBlocks(e, event);
    return blocks.length > 0 ? [[String(c.index), impactOut(e, n, blocks)] as const] : [];
  });
  // The side in effect as of the item's version; the merge base's as of its operation.
  const now = await sideOf(tx, e, n, table, versionOp);
  let effective: {
    readonly seq?: number;
    readonly actor?: Actor;
    readonly values?: Record<string, ValueOut>;
    readonly spans?: readonly (ItemInterval & {
      readonly values: Record<string, ValueOut> | null;
      readonly seq?: number;
      readonly actor?: Actor;
    })[];
    readonly exists: boolean;
  };
  if (now.kind === "state") {
    const top = Math.max(0, ...now.pieces.map((p) => p.op ?? 0));
    effective = {
      ...(top > 0 ? { seq: top, actor: now.who.get(top) as Actor } : {}),
      spans: now.pieces.map((p) => ({
        ...pieceOut(n, p),
        ...(p.op !== undefined ? { seq: p.op, actor: now.who.get(p.op) as Actor } : {}),
      })),
      exists: now.pieces.some((p) => p.values !== null),
    };
  } else {
    const r = now.row;
    effective = {
      ...(r.op !== undefined ? { seq: r.op, actor: now.who.get(r.op) as Actor } : {}),
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
    reverted_by_previous: revertedOut(e, n, e.impact),
    ...(impacts.length > 0 ? { candidate_impact: Object.fromEntries(impacts) } : {}),
  };
}

async function awaitingOf(tx: ReadTx, e: ItemEntries, n: N, table: Table, versionOp: number) {
  // The write that proposed it: its operation, actor, intent, and a revert's target.
  const origin = e.originEvent as number;
  const op = e.opOfEvent.get(origin) ?? origin;
  const t = await tx.query<{ body: string }>(
    "SELECT body FROM content WHERE seq = $1 AND path = 'target' AND body IS NOT NULL",
    [origin],
  );
  const target = JSON.parse(t.rows[0]?.body ?? "{}") as { intent?: Intent; op_index?: number };
  // The proposing write's target always names its intent (09-event-format §5.5 `write.base`).
  if (target.intent === undefined) {
    throw new ReadError("internal", `the write proposing item ${e.id} without its intent`);
  }
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
      intent: target.intent,
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

/**
 * A `schema_change` item's contents (04-contract-types §4.8 `SchemaChangeDetail`): its draft, the
 * version the draft compiles to, the changes by names, and the impact as estimated when the draft
 * was submitted. Usage is not computed in this version: no `consumers` (as the receipt). No
 * `migration`: nothing is migrated in this version.
 */
async function schemaChangeOf(tx: ReadTx, item: string) {
  // The item's draft, as its item.created names it; the draft's compiled definition and changes,
  // and the version it was written on, from the operation that submitted it (09 §4.5).
  const r = await tx.query<{ type: string; path: string; body: string | null }>(
    `SELECT e.type, c.path, c.body FROM events i
     JOIN content t ON t.seq = i.seq AND t.path = 'target'
     JOIN events e ON e.op = i.op AND e.type IN ('schema.draft_submitted', 'schema.compiled')
     JOIN content c ON c.seq = e.seq AND c.path IN ('target', 'compiled', 'changes')
     WHERE i.type = 'item.created' AND (t.body::jsonb ->> 'item') = $1`,
    [item],
  );
  const block = (type: string, path: string) => {
    const x = r.rows.find((y) => y.type === type && y.path === path);
    return x?.body == null ? undefined : JSON.parse(x.body);
  };
  const submitted = block("schema.draft_submitted", "target") as
    | { draft_id: DraftId; base_version: number }
    | undefined;
  const compiled = block("schema.compiled", "compiled") as CompiledSchema | undefined;
  const changes = block("schema.compiled", "changes") as SchemaChangeRecord[] | undefined;
  if (submitted === undefined || compiled === undefined || changes === undefined)
    throw new ReadError("internal", `the draft of item ${item} is not in the log as written`);
  const before = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1 AND v.sv = $2`,
    [compiled.slot, submitted.base_version],
  );
  const base = before.rows[0]?.body;
  if (base == null)
    throw new ReadError("internal", `no version ${submitted.base_version} of ${compiled.slot}`);
  return {
    draft: submitted.draft_id,
    target_sv: compiled.sv,
    changes: changesByName(changes, compiled, JSON.parse(base) as CompiledSchema),
    impact: { rows_affected: 0, derived_changed: [] as never[] },
  };
}

/** The awaiting item's current side (`AwaitingDetail.current`): the row as of the item's version. */
function currentOf(n: N, side: Awaited<ReturnType<typeof sideOf>>) {
  if (side.kind === "state") return { spans: side.pieces.map((p) => pieceOut(n, p)) };
  return side.row.values !== undefined ? { values: valuesOut(side.row.values) } : {};
}

/** `pending`'s result (04-contract-types §4.8): a page of items, or one item's details. */
export type PendingReadResult =
  | Awaited<ReturnType<typeof listOf>>["result"]
  | Awaited<ReturnType<typeof detailOf>>["result"];
