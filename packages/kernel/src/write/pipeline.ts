// The write pipeline (docs/zh-CN/spec/02-architecture.md §4 L5 `write`;
// 03-data-model/04-write-and-read.md «写入请求», «判定顺序», «一次写入的事件构成»), in the caller's
// transaction:
//   1. the slot of the request, then the request validated and normalized (step 1 of «判定顺序»);
//   2. the request key looked up in its window: a hit returns the original receipt (step 2);
//   3. `sv` and each op's `ver`, given or taken from the caller's own earlier writes;
//   4. each op on its row or entity: the state rebuilt from the row's events, judged by `judge`
//      (steps 3–6), seeing the request's earlier ops;
//   5. the events (head, sources, each op's `write.base` and pending item events) appended and
//      applied;
//   6. the receipt, read back from the log.
//
// An op by `entity_key` (05-time «按 entity_key 写入») writes the entity holding the key, or creates
// it: the key goes into the op's `set`, so a stretch without a value gets its key fields too, and a
// key field given otherwise is refused (`key_field_changed`).
//
// Stopped as not implemented, with nothing written: a write to a table some kept derived rule reads
// (the refresh comes with `derive`), and a row with a flagged item.
// Pending items (01-objects «待处理事项», «不过期»; 09 §5.8 «一次请求里的事项内容»): an op's
// conflicts join the open item of their unit whose interval meets theirs, or open one; a write of
// high impact opens an awaiting item. Their contents are the request's end state: the item events
// get their entries after the last op; an open item some op reached is then superseded when the
// writer had read it as the request began, refreshed otherwise; an open item no op reached whose
// entries, recomputed, changed is refreshed. Each item gets one set of contents a request.

import { createHash } from "node:crypto";
import {
  type CompiledBaseTable,
  canonicalize,
  type EntityId,
  type FieldId,
  type FieldValue,
  type ItemId,
  type JcsValue,
  type JsonValue,
  type OpNumber,
  type PrincipalId,
  type RawFieldValue,
  type RowId,
  type Seq,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import { ApplyError, applyEvents, eventsOf } from "../apply/index.ts";
import { lastRead, type ReadBuffer, type ReadId } from "../audit/index.ts";
import {
  awaitingImpact,
  conflictImpact,
  emptyState,
  type ItemRef,
  JudgeError,
  type JudgeInput,
  type Judgement,
  judgeOp,
  type Limit,
  proposalImpact,
  type RowState,
  reaches,
  scopeOf,
  stateFromRecord,
  type TableShape,
  type Unit,
  unitEntries,
} from "../judge/index.ts";
import { appendOperation, type NewEvent, readTail } from "../log/index.ts";
import { contentBlocks, type ItemContents, openItemsOn, writerHadRead } from "../pending/index.ts";
import {
  checkSvCompatibility,
  type NormalizedField,
  type NormalizedOp,
  normalizeWrite,
  type RequestError,
  resolveWriteSlot,
  type WriteWarning,
} from "../request/index.ts";
import type { Tx } from "../store/ports.ts";
import { type IntervalSet, meet, WHOLE } from "../time/index.ts";
import {
  type EntityKeyText,
  entitiesByKey,
  existingKeys,
  type KeyValues,
  keyFields,
  keyOf,
  keyText,
  keyToken,
} from "./keys.ts";
import { refreshesDerived, tableShape, todayIn, verOfRow, writable } from "./plan.ts";
import {
  type Fallback,
  readSlots,
  readUnderAnotherTask,
  requestKeyHit,
  restoreCount,
  rowEvents,
  rowTable,
  rowVersions,
  type SlotRow,
  svFromWrite,
  verFromWrite,
} from "./reads.ts";
import { readReceipt, type WriteReceipt } from "./receipt.ts";
import { decodeRecords, encodeOp, type RowContext, type StoredEvent } from "./record.ts";

/** An error the write pipeline returns, by contract error code (04-contract-types §9). */
export class WriteError extends Error {
  override readonly name = "WriteError";
  readonly code: string;
  readonly detail: Readonly<Record<string, unknown>>;
  constructor(code: string, message: string, detail: Record<string, unknown> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

export interface WriteInput {
  readonly actor: PrincipalId;
  /** The context's task; the request's own `task` takes its place when given. */
  readonly task: string | null;
  readonly now: string;
  /**
   * The idempotency windows, in milliseconds (a service-layer policy, passed in the call context):
   * of server-computed request keys, and of explicit idempotency keys.
   */
  readonly windows: { readonly requestKey: number; readonly idempotencyKey: number };
  readonly visibility: { readonly kind: string };
  readonly params: unknown;
  /** New identifiers (01-objects «标识的写法»), from the caller. */
  readonly newId: (kind: "row" | "entity" | "source" | "item") => string;
  /** The open store's buffered reads: the fallback looks there before the stored ones. */
  readonly reads: ReadBuffer;
}

const RULESET = 1;

/** Where a `ver` or `sv` taken by fallback came from: a read, or the caller's own write. */
export type FallbackOrigin = { readonly read: ReadId } | { readonly from_write: number };

/** A warning of the receipt: normalization's, or a `ver` / `sv` taken by fallback (04-contract §2). */
export type ReceiptWarning =
  | WriteWarning
  | ({ readonly code: "ver_fallback"; readonly op: number; readonly ver: string } & FallbackOrigin)
  | ({ readonly code: "sv_fallback"; readonly sv: number } & FallbackOrigin);

/**
 * The version a request left out (04-contract §2 «兜底»): the latest this connection read, under
 * the call's task, counting a version its own write receipt gave as read too. So the newer of the
 * last read and the own write's (the read on a tie: read after the write, it is no older). Neither:
 * `task_mismatch` when it read or wrote the target under another task (or without one), `no_read`
 * otherwise.
 */
async function fallback(
  tx: Tx,
  input: WriteInput,
  task: string | null,
  q: { readonly kind: "ver" | "sv"; readonly target: string },
  fromWrite: () => Promise<Fallback<number>>,
): Promise<
  | { readonly found: number; readonly restoreCount?: number; readonly origin: FallbackOrigin }
  | { readonly reason: "no_read" }
  | { readonly reason: "task_mismatch"; readonly readTask: string | null }
> {
  const read = await lastRead(tx, input.reads, { actor: input.actor, task, ...q });
  const own = await fromWrite();
  if (read !== undefined && (!("found" in own) || read.op >= own.found)) {
    return { found: read.op, restoreCount: read.restoreCount, origin: { read: read.read } };
  }
  if ("found" in own) return { found: own.found, origin: { from_write: own.op } };
  if (own.reason === "task_mismatch") return own;
  const other = await readUnderAnotherTask(tx, input.actor, task, q.kind, q.target);
  return other !== undefined ? { reason: "task_mismatch", readTask: other.task } : own;
}

const sha256 = (s: string) => createHash("sha256").update(s).digest("hex");

function requestFailure(e: RequestError): WriteError {
  return new WriteError(e.code, `the request is refused: ${e.code}`, { ...e });
}

/** `read_first` (04-contract-types §9): what to read first, and why the fallback found nothing. */
function readFirst(
  f:
    | { readonly reason: "no_read" }
    | { readonly reason: "task_mismatch"; readonly readTask: string | null },
  what: { readonly target: "row" | "slot"; readonly ref: unknown },
  task: string | null,
  param: string,
): WriteError {
  return new WriteError("read_first", `read the ${what.target} first`, {
    reason: f.reason,
    target: what.target,
    ref: what.ref,
    param,
    ...(f.reason === "task_mismatch" ? { read_task: f.readTask, task } : {}),
  });
}

const unitKey = (u: Unit) => (u === "existence" ? "existence" : [...u.fields].sort().join(","));
const unitIn = (u: readonly string[]): Unit =>
  u[0] === "existence" ? "existence" : { fields: u as FieldId[] };

/** A pending item on the row the pipeline keeps track of while it writes. */
interface TrackedItem {
  readonly item: ItemId;
  readonly type: "conflict" | "awaiting_confirmation";
  readonly unit: Unit;
  /** Conflict items: the candidates so far, and the merge base. */
  candidates: number;
  mergeBase: OpNumber;
  /** The items of its candidates (conflict) or of the proposal (awaiting). */
  refs: ItemRef[];
  /** The event of the write that opened it (awaiting: the proposal). */
  readonly origin: Seq;
  /** Its version when the request began (an item opened by the request: this operation). */
  readonly versionOp: OpNumber;
  /** Opened by this request. */
  readonly here: boolean;
  /** Joined by a candidate of this request. */
  mergedHere: boolean;
  /** The last `write.base` of this request that reached it (01-objects «不过期»: 改到). */
  reachedBy?: Seq;
  /** Its entry groups as the log holds them before this request, by path. */
  readonly stored: Readonly<Record<string, unknown>>;
  /** Awaiting items: the writes its proposal would take back, as last given. */
  reverted: { readonly op: OpNumber; readonly deps: readonly ItemRef[] }[];
  /** This request's `item.created` / `item.merged` events of the item, filled at its end. */
  readonly fills: { readonly index: number; readonly merged: boolean }[];
}

interface RowWork {
  readonly ctx: RowContext;
  readonly events: readonly StoredEvent[];
  state: RowState;
  /** Created by an earlier op of this request. */
  createdHere: boolean;
  /** The open items on the row. */
  readonly items: TrackedItem[];
  /** The last `write.base` of this request on the row. */
  lastBase?: Seq;
}

/** The entry groups of an item (09 §5.8), and those each kind of item event gives whole. */
const GROUPS = ["scope_valid", "current", "previous", "impact", "proposed"] as const;
const GIVES: Readonly<Record<string, readonly string[]>> = {
  "item.created": GROUPS,
  // `current` with it as the pipeline writes it (one set of contents a request); an older one
  // without keeps the earlier.
  "item.merged": ["scope_valid", "current", "previous", "impact"],
  "item.refreshed": GROUPS,
};
const groupOf = (path: string) => path.split("/")[0] as string;

/** The blocks of the groups `groups` among `blocks`. */
const pick = (blocks: Readonly<Record<string, unknown>>, groups: readonly string[]) =>
  Object.fromEntries(Object.entries(blocks).filter(([p]) => groups.includes(groupOf(p))));

const refIn = (d: { event: number; field?: string; existence?: number; k?: number }): ItemRef => ({
  event: d.event as Seq,
  target: (d.field ?? "existence") as ItemRef["target"],
  k: d.k ?? d.existence ?? 0,
});

/** The open items of a row, from its item events and the items' state now. */
function trackedItems(
  events: readonly StoredEvent[],
  open: ReadonlyMap<string, OpNumber>,
): TrackedItem[] {
  const by = new Map<string, TrackedItem & { stored: Record<string, unknown> }>();
  for (const e of events) {
    const t = e.blocks["target"] as
      | {
          item: ItemId;
          type?: string;
          unit?: string[];
          merge_base_op?: number;
          origin_event?: number;
        }
      | undefined;
    if (t === undefined || !open.has(t.item)) continue;
    const refs = Object.entries(e.blocks)
      .filter(([p]) => p.startsWith("candidates/"))
      .flatMap(([, c]) => {
        const cand = c as {
          event: Seq;
          items: { field?: FieldId; k?: number; existence?: number }[];
        };
        return cand.items.map((y) => refIn({ event: cand.event, ...y }));
      });
    const n = Object.keys(e.blocks).filter((p) => p.startsWith("candidates/")).length;
    if (e.header.type === "item.created") {
      if (t.type !== "conflict" && t.type !== "awaiting_confirmation") continue;
      by.set(t.item, {
        item: t.item,
        type: t.type,
        unit: unitIn(t.unit ?? []),
        candidates: n,
        mergeBase: (t.merge_base_op ?? 0) as OpNumber,
        refs,
        origin: (t.origin_event ?? 0) as Seq,
        versionOp: open.get(t.item) as OpNumber,
        here: false,
        mergedHere: false,
        stored: {},
        reverted: [],
        fills: [],
      });
    }
    const x = by.get(t.item);
    if (x === undefined) continue;
    if (e.header.type === "item.merged") {
      x.candidates += n;
      x.refs = [...x.refs, ...refs];
    }
    // Candidates re-given by a refresh keep their indices: only the merge base may change.
    if (e.header.type !== "item.created" && t.merge_base_op !== undefined)
      x.mergeBase = t.merge_base_op as OpNumber;
    // A group an event gives replaces the earlier one whole (09 §5.8: zero blocks, an empty group).
    const all = GIVES[e.header.type];
    const gives =
      e.header.type === "item.merged" &&
      !Object.keys(e.blocks).some((p) => p.startsWith("current/"))
        ? all?.filter((g) => g !== "current")
        : all;
    if (gives !== undefined) {
      for (const p of Object.keys(x.stored)) if (gives.includes(groupOf(p))) delete x.stored[p];
      Object.assign(x.stored, pick(e.blocks, gives));
    }
  }
  for (const x of by.values()) {
    x.reverted = Object.entries(x.stored)
      .filter(
        ([p, b]) => p.startsWith("impact/") && (b as { kind: string }).kind === "reverted_write",
      )
      .map(([, b]) => {
        const r = b as {
          op: number;
          deps: { event: number; field?: string; existence?: number; k?: number }[];
        };
        return { op: r.op as OpNumber, deps: r.deps.map(refIn) };
      });
  }
  return [...by.values()];
}

/**
 * Whether the writer had read the item's version as the request began (01-objects «不过期»): its
 * own receipt gave it whole when its write opened the item, or it read it (the version it last
 * read, under the same task, is the item's then, with the restore count now).
 */
async function hadRead(
  tx: Tx,
  input: WriteInput,
  task: string | null,
  t: TrackedItem,
  restore: number,
): Promise<boolean> {
  if (
    await writerHadRead(tx, { id: t.item, type: t.type, versionOp: t.versionOp }, input.actor, task)
  ) {
    return true;
  }
  const read = await lastRead(tx, input.reads, {
    actor: input.actor,
    task,
    kind: "item",
    target: t.item,
  });
  return read !== undefined && read.op === t.versionOp && read.restoreCount === restore;
}

/** An awaiting item's proposal: the awaiting items of the write that opened it. */
function withProposals(state: RowState, items: TrackedItem[]): TrackedItem[] {
  for (const t of items) {
    if (t.type !== "awaiting_confirmation") continue;
    t.refs = state.items
      .filter((x) => x.event === t.origin && x.status === "awaiting")
      .map((x) => ({ event: x.event, target: x.target, k: x.k }));
  }
  return items;
}

/** The interval of a tracked item: its candidates' or proposal's items (state tables). */
function scopeFor(state: RowState, t: TrackedItem): IntervalSet {
  return state.isState ? scopeOf(state, t.refs) : [WHOLE];
}

/**
 * The entries of an item as of `at` (09 §5.8), every group: a conflict item's interval, current
 * values, values at the merge base and impact; an awaiting item's interval, current values,
 * proposal and impact (what the proposal would overwrite now, and the writes it would take back
 * while they are in effect).
 */
function itemContents(state: RowState, t: TrackedItem, at: Limit): ItemContents {
  const scope = scopeFor(state, t);
  const scopeBlock = state.isState ? { scope: { valid: scope, deps: t.refs } } : {};
  const current = unitEntries(state, t.unit, scope, at, t.refs);
  if (t.type === "conflict") {
    return {
      ...scopeBlock,
      current,
      previous: unitEntries(state, t.unit, scope, { upTo: t.mergeBase }, t.refs),
      impact: conflictImpact(state, t.unit, scope, t.mergeBase, t.refs, at),
    };
  }
  const proposed = t.refs.flatMap((r) => {
    const x = state.items.find((y) => y.event === r.event && y.target === r.target && y.k === r.k);
    if (x === undefined || x.target === "existence" || x.content.kind !== "value") return [];
    const value = x.content.value;
    const field = x.target;
    // One entry a span of the proposal's interval.
    return (state.isState ? x.valid : [WHOLE]).map((v) => ({
      field,
      value,
      ...(state.isState ? { valid: v } : {}),
      deps: [r],
    }));
  });
  return {
    ...scopeBlock,
    current,
    proposed,
    impact: awaitingImpactNow(state, t, at),
  };
}

/**
 * An awaiting item's impact as of `at`. A proposal that is an `undo` is judged again on the state
 * now, the same undo of the same operation: what it would take back or hide is the judge's, the
 * writes after it included (high impact ④). Any other proposal: what it would overwrite now.
 */
function awaitingImpactNow(state: RowState, t: TrackedItem, at: Limit) {
  const opened = state.records.find((r) => r.event === t.origin);
  if (opened?.kind === "undo" && opened.revert.before !== undefined) {
    const op = (at.upTo + 1) as OpNumber;
    try {
      const again = judgeOp(state, {
        kind: "undo",
        op,
        index: 0,
        event: (op + 1) as Seq,
        ruleset: RULESET,
        seen: at.upTo,
        seenExplicit: true,
        target: opened.revert.before,
        ...(opened.includeLater ? { includeLater: true } : {}),
      });
      return awaitingImpact(state, again.judgement);
    } catch (e) {
      if (!(e instanceof JudgeError)) throw e;
    }
  }
  return proposalImpact(state, t.refs, t.reverted, at);
}

/** The intent of the undone operation's last `write.base` on the row (01-objects). */
function undoneIntent(events: readonly StoredEvent[], undone: OpNumber): NormalizedOp["intent"] {
  const bases = events.filter((e) => e.header.type === "write.base" && e.header.op === undone);
  const last = bases.at(-1)?.blocks["target"] as { intent?: string } | undefined;
  return (last?.intent ?? "update") as NormalizedOp["intent"];
}

function judgeFailure(e: JudgeError, index: number): WriteError {
  const param = `ops/${index}`;
  switch (e.reason) {
    case "invalid_argument":
      return new WriteError("invalid_argument", e.message, { param, ...e.detail });
    case "validation_failed":
      return new WriteError("validation_failed", e.message, { param, ...e.detail });
    case "revoked":
      return new WriteError("revoked", e.message, { param, ...e.detail });
    default:
      return new WriteError("internal", e.message, { param });
  }
}

/** The raw values a write gave, as the head event records them (09 §1.3). */
function rawOf(
  fields: Readonly<Record<FieldId, NormalizedField>> | undefined,
): Partial<Record<FieldId, RawFieldValue>> {
  return Object.fromEntries(
    Object.entries(fields ?? {}).map(([f, x]) => [f, (x?.raw ?? null) as RawFieldValue]),
  );
}

const valuesOf = (key: Readonly<Record<FieldId, NormalizedField>>) =>
  Object.fromEntries(Object.entries(key).map(([f, x]) => [f, x.value])) as Record<
    FieldId,
    FieldValue
  >;
const sameValue = (a: FieldValue, b: FieldValue | undefined) =>
  b !== undefined && canonicalize(a as JcsValue) === canonicalize(b as JcsValue);

/** How many keys a receipt lists for an entity created by key (04-contract §5.1). */
const EXISTING_KEYS = 10;

/** Writes the request in `tx`; returns its receipt, or the original one for a repeated request. */
export async function writeInTx(tx: Tx, input: WriteInput): Promise<WriteReceipt> {
  const { actor, now } = input;
  const slots = await readSlots(tx);
  const which = resolveWriteSlot(
    input.params,
    slots.map((s) => ({ name: s.name, tables: s.compiled.tables.map((t) => t.name) })),
  );
  if (!which.ok) throw requestFailure(which.error);
  const slot = slots.find((s) => s.name === which.slot) as SlotRow;
  const today = todayIn(now, slot.timezone);
  // One schema version in this phase: nothing changed incompatibly since any version.
  const changedSince = () => new Map();
  const normalized = normalizeWrite({
    params: input.params,
    compiled: slot.compiled,
    currentSv: slot.sv,
    changedSince,
  });
  if (!normalized.ok) throw requestFailure(normalized.error);
  const req = normalized.request;
  const task = req.task ?? input.task;
  const tableOf = (id: TableId) =>
    slot.compiled.tables.find((t) => t.id === id && t.kind === "base") as CompiledBaseTable;
  for (const o of req.ops) {
    if (!writable(input.visibility, slot.slot, o.table)) {
      throw new WriteError("unknown_table", "no such table", { param: `ops/${o.index}/table` });
    }
  }
  const restore = await restoreCount(tx);
  const warnings: ReceiptWarning[] = [...req.warnings];

  // Step 2: the request key in its window.
  const explicit = req.requestKey.idempotencyKey;
  const key =
    explicit !== undefined
      ? sha256(canonicalize(["idempotency", actor, explicit]))
      : sha256(canonicalize([actor, task ?? null, req.requestKey.content]));
  const fingerprint = req.requestKey.fingerprint;
  const since = new Date(
    Date.parse(now) -
      (explicit !== undefined ? input.windows.idempotencyKey : input.windows.requestKey),
  ).toISOString();
  const hit = await requestKeyHit(tx, key, since);
  if (hit !== undefined) {
    if (explicit !== undefined && hit.fingerprint !== fingerprint) {
      throw new WriteError("invalid_argument", "the idempotency key was used for another request", {
        reason: "idempotency_key_reuse",
        param: "idempotency_key",
      });
    }
    const replay = await readReceipt(tx, hit.op, {
      compiled: slot.compiled,
      slotName: slot.name,
      restoreCount: restore,
      replayed: true,
    });
    if (replay === undefined) {
      // The original write's content was deleted (`original_deleted`, the deletion phase).
      throw new WriteError(
        "internal",
        "replaying a write whose content was deleted is not implemented",
        {
          reason: "not_implemented",
        },
      );
    }
    return replay;
  }

  // Derived tables reading a written table are refreshed in the same transaction (K5): not yet.
  for (const o of req.ops) {
    if (refreshesDerived(slot.compiled, o.table)) {
      throw new WriteError("internal", "writing a table a derived rule reads is not implemented", {
        reason: "not_implemented",
        param: `ops/${o.index}/table`,
      });
    }
  }

  // `sv`: given, or from the caller's own latest write on the slot.
  let sv = req.sv;
  let svBasis: "explicit" | "fallback" = "explicit";
  if (sv === undefined) {
    const f = await fallback(tx, input, task, { kind: "sv", target: slot.slot }, () =>
      svFromWrite(tx, slot.slot, actor, task),
    );
    if (!("found" in f)) throw readFirst(f, { target: "slot", ref: slot.name }, task, "sv");
    sv = f.found;
    svBasis = "fallback";
    warnings.push({ code: "sv_fallback", sv, ...f.origin });
    // A request given its sv was checked in normalizing; one taking it by fallback is checked now.
    const incompatible = checkSvCompatibility({
      request: req,
      sv,
      currentSv: slot.sv,
      changedSince,
    });
    if (incompatible !== undefined) throw requestFailure(incompatible);
  }

  const op = (((await readTail(tx))?.seq ?? 0) + 1) as OpNumber;
  const nSources = req.evidence.length > 0 ? req.evidence.length : req.ops.length;
  let next = op + 1 + nSources;
  // An op's value sources: the evidence segments it cites (all of them when it names none), or
  // its own `api_call` source.
  const sourcesOf = (o: NormalizedOp): Seq[] =>
    req.evidence.length > 0
      ? (o.evidenceRefs ?? req.evidence.map((_, k) => k)).map((k) => (op + 1 + k) as Seq)
      : [(op + 1 + o.index) as Seq];

  const rows = new Map<string, RowWork>();
  const headBlocks: Record<string, JsonValue> = {};
  const opEvents: NewEvent[] = [];
  const noopNames = new Map<number, string[]>();
  // Entities this request created by key: by table and key, and each one's key.
  const createdByKey = new Map<string, EntityId>();
  const keyOfCreated = new Map<string, { table: TableId; key: KeyValues }>();
  const keysShown = new Map<number, EntityKeyText[]>();

  for (const o of req.ops) {
    const table = tableOf(o.table);
    const shape: TableShape = tableShape(table);
    const isState = shape.kind === "state";
    const granularity = isState && table.time.type === "state" ? table.time.granularity : "date";
    const param = `ops/${o.index}`;
    const verTable = `${table.physical.table}__ver`;

    // The row or entity. By key: the entity this request created with it, else the one stored.
    let byKey: EntityId | undefined;
    let createsByKey = false;
    if (o.target.kind === "entity_key") {
      const key = valuesOf(o.target.key);
      const token = `${table.id} ${keyToken(table, key)}`;
      byKey = createdByKey.get(token);
      if (byKey === undefined) {
        const held = await entitiesByKey(tx, table, key);
        // Keys are unique over all time (05-time): two holders is a store out of order.
        if (held.length > 1) {
          throw new WriteError("internal", "two entities hold one key", {
            reason: "inconsistent",
            param: `${param}/entity_key`,
          });
        }
        byKey = held[0];
      }
      if (byKey === undefined) {
        // Revoking or undoing by a key no entity holds has nothing to act on.
        if (o.kind !== "write") {
          throw new WriteError("not_found", "no entity holds this key", {
            param: `${param}/entity_key`,
          });
        }
        // The keys before it: this request's earlier ones first, the latest first, then the stored.
        const earlier = [...keyOfCreated.values()]
          .filter((x) => x.table === table.id)
          .reverse()
          .map((x) => keyText(table, x.key));
        keysShown.set(
          o.index,
          [...earlier, ...(await existingKeys(tx, table, EXISTING_KEYS))].slice(0, EXISTING_KEYS),
        );
        byKey = input.newId("entity") as EntityId;
        createsByKey = true;
        createdByKey.set(token, byKey);
        keyOfCreated.set(byKey, { table: table.id, key });
      }
    }
    if ((o.target.kind === "row" && isState) || (o.target.kind === "entity" && !isState)) {
      throw new WriteError("invalid_argument", "row on a state table, or entity on another", {
        reason: "target_kind",
        param,
      });
    }
    const isNew = o.target.kind === "new" || createsByKey;
    const id =
      byKey ??
      (o.target.kind === "new"
        ? input.newId(isState ? "entity" : "row")
        : o.target.kind === "row"
          ? o.target.row
          : (o.target as { entity: EntityId }).entity);
    let work = rows.get(id);
    if (work === undefined) {
      const ctx: RowContext = {
        table: table.id,
        target: isState ? { entity: id as EntityId } : { row: id as RowId },
        shape,
        granularity,
      };
      if (isNew) {
        work = { ctx, events: [], state: emptyState(shape), createdHere: false, items: [] };
      } else {
        if ((await rowTable(tx, id)) !== table.id) {
          throw new WriteError("not_found", "no such row or entity", { param });
        }
        const events = await rowEvents(tx, table.id, id);
        const state = stateFromRecord(shape, decodeRecords(ctx, events));
        const open = await openItemsOn(tx, table.id, id);
        // A flagged item reached by a write is refreshed or superseded by its own rule
        // (`matched_changed`), which comes with duplicate detection.
        if (open.some((x) => x.type === "flagged")) {
          throw new WriteError("internal", "writing a row with a flagged item is not implemented", {
            reason: "not_implemented",
            param,
          });
        }
        work = {
          ctx,
          events,
          state,
          createdHere: false,
          items: withProposals(
            state,
            trackedItems(events, new Map(open.map((x) => [x.id, x.versionOp as OpNumber]))),
          ),
        };
      }
      rows.set(id, work);
    }

    // The version the op saw.
    let seen: OpNumber;
    let seenExplicit = false;
    if (isNew) seen = (op - 1) as OpNumber;
    else if (work.createdHere) seen = op;
    else if (o.ver !== undefined) {
      if (!verOfRow(o.ver, await rowVersions(tx, verTable, id), restore)) {
        throw new WriteError("invalid_argument", "the ver is not a version of this row or entity", {
          reason: "not_this_target",
          param: `${param}/ver`,
        });
      }
      seen = o.ver.op;
      seenExplicit = true;
    } else if (o.kind === "undo") seen = (op - 1) as OpNumber;
    else {
      const f = await fallback(tx, input, task, { kind: "ver", target: id }, () =>
        verFromWrite(tx, verTable, id, actor, task),
      );
      const ref = {
        table: `${slot.name}.${table.name}`,
        ...(isState ? { entity: id } : { row: id }),
      };
      if (!("found" in f)) throw readFirst(f, { target: "row", ref }, task, `${param}/ver`);
      seen = f.found;
      warnings.push({
        code: "ver_fallback",
        op: o.index,
        ver: `v${f.found}.${f.restoreCount ?? restore}`,
        ...f.origin,
      });
    }
    // Key fields: in a write by key the key joins `set`; given in `set`, a key field must be the
    // entity's key (05-time «按 entity_key 写入»: 键字段不可改), by the same value tokens.
    let fields = o.fields;
    const keyed = isState ? keyFields(table) : [];
    if (o.kind === "write" && keyed.length > 0) {
      const key = o.target.kind === "entity_key" ? o.target.key : undefined;
      const merged: Record<FieldId, NormalizedField> = { ...(o.fields ?? {}) };
      for (const f of keyed) {
        const given = o.fields?.[f.id];
        if (given === undefined) {
          if (key?.[f.id] !== undefined) merged[f.id] = key[f.id] as NormalizedField;
          continue;
        }
        // The entity's key: the one located by, the one this request created it with, or the one
        // its creating event gave.
        const own: KeyValues | undefined =
          key !== undefined
            ? valuesOf(key)
            : (keyOfCreated.get(id)?.key ?? (await keyOf(tx, table, id as EntityId)));
        if (own === undefined) {
          throw new WriteError("internal", "an entity of a keyed table without a key", {
            reason: "inconsistent",
            param,
          });
        }
        if (!sameValue(given.value, own[f.id])) {
          const at = o.named.find((n) => n.field === f.id && n.param.startsWith(`${param}/set/`));
          throw new WriteError("invalid_argument", "a key field cannot change", {
            reason: "key_field_changed",
            param: at?.param ?? `${param}/set`,
          });
        }
      }
      fields = merged;
    }

    const intent =
      o.intent ?? (o.undo !== undefined ? undoneIntent(work.events, o.undo.target) : "update");
    const ack = o.acknowledge.includes("overwrite");
    const base = { op, index: o.index, event: next as Seq, ruleset: RULESET, seen, seenExplicit };
    const nowPoint = (granularity === "date" ? today : now) as never;
    const judgeInput: JudgeInput =
      o.kind === "write"
        ? {
            ...base,
            kind: "write",
            ...(o.valid !== undefined ? { valid: o.valid } : {}),
            now: nowPoint,
            fields: Object.fromEntries(
              Object.entries(fields ?? {}).map(([f, x]) => [f, { value: x?.value ?? null }]),
            ),
            ...(ack ? { acknowledge: true } : {}),
          }
        : o.kind === "revoke"
          ? {
              ...base,
              kind: "revoke",
              ...(o.valid !== undefined && o.valid !== "corrected_span" ? { valid: o.valid } : {}),
              now: nowPoint,
            }
          : {
              ...base,
              kind: "undo",
              target: (o.undo as { target: OpNumber }).target,
              ...(o.undo?.includeLater ? { includeLater: true } : {}),
              ...(ack ? { acknowledge: true } : {}),
            };
    let judged: { judgement: Judgement; state: RowState };
    try {
      judged = judgeOp(work.state, judgeInput);
    } catch (e) {
      if (e instanceof JudgeError) throw judgeFailure(e, o.index);
      throw e;
    }
    const j = judged.judgement;
    work.state = judged.state;
    // Conflicts join the open item of the same unit whose interval meets theirs, the earliest of
    // several (01-objects «目标与合并»); one meeting none opens an item.
    const conflictItems = j.conflicts.map((c) => {
      const theirs = scopeFor(work.state, { refs: [...c.items] } as TrackedItem);
      const prior = work.items.find(
        (x) =>
          x.type === "conflict" &&
          unitKey(x.unit) === unitKey(c.unit) &&
          (!isState || meet(scopeFor(work.state, x), theirs).length > 0),
      );
      if (prior !== undefined) {
        const candidate = prior.candidates;
        prior.candidates++;
        prior.mergeBase = Math.min(prior.mergeBase, seen) as OpNumber;
        prior.refs = [...prior.refs, ...c.items];
        if (!prior.here) prior.mergedHere = true;
        return { item: prior.item, merged: true as const, candidate, mergeBase: prior.mergeBase };
      }
      const item = input.newId("item") as ItemId;
      work.items.push({
        item,
        type: "conflict",
        unit: c.unit,
        candidates: 1,
        mergeBase: seen,
        refs: [...c.items],
        origin: next as Seq,
        versionOp: op,
        here: true,
        mergedHere: false,
        stored: {},
        reverted: [],
        fills: [],
      });
      return { item, candidate: 0, mergeBase: seen };
    });
    const recorded = "items" in j.record ? j.record.items : [];
    const awaitingItem = recorded.some((x) => x.status === "awaiting")
      ? (input.newId("item") as ItemId)
      : undefined;
    if (awaitingItem !== undefined) {
      const proposal = recorded.filter((x) => x.status === "awaiting");
      work.items.push({
        item: awaitingItem,
        type: "awaiting_confirmation",
        unit: proposal.some((x) => x.target === "existence")
          ? "existence"
          : { fields: [...new Set(proposal.map((x) => x.target as FieldId))].sort() },
        candidates: 0,
        mergeBase: seen,
        refs: proposal.map((x) => ({ event: next as Seq, target: x.target, k: x.k })),
        origin: next as Seq,
        versionOp: op,
        here: true,
        mergedHere: false,
        stored: {},
        // The later writes an `undo` would take back or hide (high impact ④), as judged now.
        reverted: awaitingImpact(work.state, j).flatMap((x) =>
          x.kind === "reverted_write" ? [{ op: x.op, deps: x.deps }] : [],
        ),
        fills: [],
      });
    }
    const enc = encodeOp(work.ctx, judgeInput, j, {
      intent: intent as "insert" | "update" | "correct" | "revoke",
      ...(o.target.kind === "entity_key" ? { byEntityKey: true as const } : {}),
      ...(j.created ? { created: true as const } : {}),
      raw: rawOf(fields),
      restoreCount: restore,
      sv,
      sources: sourcesOf(o),
      conflictItems,
      ...(awaitingItem !== undefined ? { awaitingItem } : {}),
      versions: { ruleset: RULESET, policy: slot.policyVersion },
    });
    Object.assign(headBlocks, enc.head);
    if (enc.base !== undefined) {
      const baseSeq = next as Seq;
      opEvents.push({ type: "write.base", slot: slot.slot, blocks: enc.base as never });
      next++;
      work.lastBase = baseSeq;
      // The items it opens or joins; their entries come at the end of the request (rule: an item's
      // contents are the request's end state, 01-objects «不过期»).
      enc.items.forEach((it, n) => {
        const conflict = conflictItems[n];
        const id = conflict !== undefined ? conflict.item : awaitingItem;
        work.items
          .find((x) => x.item === id)
          ?.fills.push({ index: opEvents.length, merged: it.type === "item.merged" });
        opEvents.push({ type: it.type, slot: slot.slot, blocks: it.blocks as never });
        next++;
      });
      // The open items it reaches, settled at the end of the request.
      for (const t of work.items) {
        // Op by op: what this op changed, from just before it to just after it.
        const before: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
        const after: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index + 1 } };
        if (!t.here && reaches(work.state, before, after, t.unit, scopeFor(work.state, t))) {
          t.reachedBy = baseSeq;
        }
      }
    }
    if (isNew && (enc.base !== undefined || j.created)) work.createdHere = true;
    if (j.record.kind === "write") {
      noopNames.set(
        o.index,
        j.record.noop.map((f) => table.fields.find((x) => x.id === f)?.name ?? f),
      );
    }
  }

  // The pending items, as of the request's end (01-objects «不过期»): the request's item events
  // get their entries; an open item some op reached is superseded when the writer had read it as
  // the request began (not one this request joined), refreshed otherwise; an open item on a row the
  // request wrote that no op reached is refreshed when its entries, recomputed, changed (their
  // impact does not go stale, 01-objects «影响»). Each item gets one of these at most.
  const atEnd: Limit = { upTo: op };
  for (const work of rows.values()) {
    for (const t of [...work.items]) {
      const blocks = contentBlocks(itemContents(work.state, t, atEnd));
      for (const f of t.fills) {
        const ev = opEvents[f.index] as NewEvent;
        const groups = f.merged ? (GIVES["item.merged"] as readonly string[]) : GROUPS;
        opEvents[f.index] = { ...ev, blocks: { ...ev.blocks, ...pick(blocks, groups) } as never };
      }
      if (t.here || work.lastBase === undefined) continue;
      const mergeBase = t.type === "conflict" ? { merge_base_op: t.mergeBase } : {};
      if (t.reachedBy !== undefined) {
        if (!t.mergedHere && (await hadRead(tx, input, task, t, restore))) {
          opEvents.push({
            type: "item.superseded",
            slot: slot.slot,
            blocks: {
              target: {
                item: t.item,
                reason: "overwritten",
                by_event: t.reachedBy,
                writer_had_read: true,
              },
            } as never,
          });
          work.items.splice(work.items.indexOf(t), 1);
        } else {
          opEvents.push({
            type: "item.refreshed",
            slot: slot.slot,
            blocks: {
              target: {
                item: t.item,
                by_event: t.reachedBy,
                writer_had_read: false,
                cause: "target_overwritten",
                ...mergeBase,
              },
              ...blocks,
            } as never,
          });
        }
        next++;
        continue;
      }
      // A join of this request gave the item's contents with it (item.merged): nothing more.
      if (t.mergedHere) continue;
      const held = t.stored;
      if (canonicalize(held as never) === canonicalize(blocks as never)) continue;
      opEvents.push({
        type: "item.refreshed",
        slot: slot.slot,
        blocks: {
          target: { item: t.item, by_event: work.lastBase, cause: "entries_changed", ...mergeBase },
          ...blocks,
        } as never,
      });
      next++;
    }
  }

  // Sources: the request's evidence, or each op's request as an `api_call` (04-write-and-read
  // «不变量：每次写入都有源数据»), without the values of its no-op fields.
  const rawOps = (input.params as { ops: JsonValue[] }).ops;
  const sources: NewEvent[] =
    req.evidence.length > 0
      ? req.evidence.map((ev) => ({
          type: "source.recorded",
          slot: slot.slot,
          blocks: {
            target: {
              source_id: input.newId("source"),
              kind: ev.kind,
              // Declared on the segment, or by its kind (04-write-and-read «来源级别»).
              level: ev.level ?? (ev.kind === "user_message" ? "user_stated" : "agent_inferred"),
            },
            ...(ev.kind === "file_ref"
              ? {
                  file: {
                    name: ev.name,
                    mime: ev.mime,
                    size: ev.size,
                    sha256: ev.sha256,
                    ...(ev.origin !== undefined ? { origin: ev.origin } : {}),
                    ...(ev.excerpt !== undefined ? { excerpt: ev.excerpt } : {}),
                  },
                }
              : { text: { text: ev.text } }),
            ...(ev.stated_at !== undefined ? { stated_at: { at: ev.stated_at } } : {}),
          },
        }))
      : req.ops.map((o) => {
          const raw = rawOps[o.index] as Record<string, JsonValue>;
          const noop = noopNames.get(o.index) ?? [];
          const set = raw["set"] as Record<string, JsonValue> | undefined;
          const request: Record<string, JsonValue> = { ...raw };
          // A key field a write by key took from `entity_key` is not in `set`: nothing to strip.
          const stripped = set === undefined ? [] : noop.filter((n) => Object.hasOwn(set, n));
          if (set !== undefined && stripped.length > 0) {
            request["set"] = Object.fromEntries(
              Object.entries(set).filter(([n]) => !stripped.includes(n)),
            );
            request["noop"] = stripped;
          }
          return {
            type: "source.recorded",
            slot: slot.slot,
            blocks: {
              target: {
                source_id: input.newId("source"),
                kind: "api_call",
                level: "agent_inferred",
                op_index: o.index,
              },
              request,
            },
          };
        });

  const head: NewEvent = {
    type: "write.head",
    slot: slot.slot,
    blocks: {
      ctx: {
        now,
        today,
        ruleset_version: RULESET,
        policy_version: slot.policyVersion,
        literal_checker: "literal@1",
      },
      request: { sv, sv_basis: svBasis, op_count: req.ops.length },
      ...(task !== null ? { task } : {}),
      ...(explicit !== undefined
        ? { idempotency: { key, fingerprint: fingerprint as string } }
        : { request_key: { key } }),
      ...headBlocks,
    },
  };
  const prepared = await appendOperation(tx, {
    actor,
    now: now as never,
    events: [head, ...sources, ...opEvents],
  });
  if (prepared.op !== op || prepared.events.at(-1)?.seq !== next - 1) {
    throw new WriteError("internal", "the operation's numbers are not as planned");
  }
  try {
    await applyEvents(tx, eventsOf(prepared));
  } catch (e) {
    // The events do not fit the state they are applied to: an internal error, without their content.
    if (e instanceof ApplyError) {
      throw new WriteError("internal", "the write could not be applied", {
        reason: e.reason,
        seq: e.seq,
      });
    }
    throw e;
  }
  const receipt = (await readReceipt(tx, op, {
    compiled: slot.compiled,
    slotName: slot.name,
    restoreCount: restore,
    replayed: false,
  })) as WriteReceipt;
  const ops = receipt.ops.map((r, i) => {
    const keys = keysShown.get(i);
    return keys !== undefined && r.created_entity ? { ...r, existing_keys: keys } : r;
  });
  const out = keysShown.size > 0 ? { ...receipt, ops } : receipt;
  return warnings.length > 0 ? { ...out, warnings } : out;
}
