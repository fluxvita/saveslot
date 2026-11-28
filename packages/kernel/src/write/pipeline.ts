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
// (the refresh comes with `derive`).
// Duplicate keys (./duplicates.ts, ./flagged.ts): a row created and in effect is compared once and
// may open a flagged item; at the request's end, flagged items whose rows it wrote are judged again
// (superseded or refreshed, `matched_changed`), those it opened given its end state.
// Pending items (01-objects «待处理事项», «不过期»; 09 §5.8 «一次请求里的事项内容»): an op's
// conflicts join the open item of their unit whose interval meets theirs, or open one; a write of
// high impact opens an awaiting item. Their contents are the request's end state: the item events
// get their entries after the last op; an open item some op reached is then superseded when the
// writer had read it as the request began, refreshed otherwise; an open item no op reached whose
// entries, recomputed, changed is refreshed. Each item gets one set of contents a request.

import {
  type BizPoint,
  type CompiledBaseTable,
  type CompiledSchema,
  canonicalize,
  type DateStr,
  type EntityId,
  type FieldId,
  type FieldValue,
  type Instant,
  type ItemId,
  type JsonValue,
  type OpNumber,
  type PartitionId,
  type PrincipalId,
  type RawFieldValue,
  type RowId,
  type Seq,
  type SourceId,
  type TableId,
} from "@fluxvita/saveslot-contract-core";
import { ApplyError, internalDetailOf } from "../apply/index.ts";
import { lastRead, type ReadBuffer } from "../audit/index.ts";
import { sameValue } from "../delta/index.ts";
import {
  awaitingImpact,
  conflictImpact,
  EVERYTHING,
  emptyState,
  type GapEntry,
  givesVersion,
  type ItemRef,
  JudgeError,
  type JudgeInput,
  type Judgement,
  judgeOp,
  type Limit,
  proposalImpact,
  type RowState,
  reaches,
  resolveInterval,
  revertScope,
  scopeOf,
  seenOf,
  stateFromRecord,
  syncOutcome,
  type TableShape,
  type Unit,
  unitEntries,
} from "../judge/index.ts";
import { type EffectSlot, type NewEvent, readTail } from "../log/index.ts";
import {
  contentBlocks,
  type ItemContents,
  openItemsOn,
  PENDING_DELETION_TARGET,
  type PendingTargets,
  pendingDeletionTargetDetail,
  readPendingTargets,
  writerHadRead,
} from "../pending/index.ts";
import {
  checkSvCompatibility,
  get,
  isObj,
  type NormalizedField,
  type NormalizedOp,
  type NormalizedWrite,
  normalizeWrite,
  type RequestError,
  resolveWriteSlot,
  type Visibility,
  visibleTables,
  type WriteValidationDetail,
} from "../request/index.ts";
import { changedSinceOf, switchedVersions } from "../schema/index.ts";
import type { ReadTx, Tx } from "../store/ports.ts";
import { READABLE_CONTENT, readableContentOf } from "../store/readable-content.ts";
import { restoreAt, restoreHistory, restorePoint, seenOfVer } from "../store/restore-point.ts";
import { type IntervalSet, meet, unionOf, WHOLE } from "../time/index.ts";
import type { ValueOut } from "../time/zone.ts";
import { appendWithDerived } from "./derive-step.ts";
import { createdInEffect, duplicateBlock, duplicateOf, flaggedItem } from "./duplicates.ts";
import { WriteError } from "./errors.ts";
import { type OpenedFlagged, settleFlagged } from "./flagged.ts";
import {
  createSimilarCache,
  type EntityKeyText,
  entitiesByKey,
  existingKeys,
  type KeyValues,
  keyFields,
  keyOf,
  keyText,
  keyToken,
  type SimilarKey,
  similarKeys,
} from "./keys.ts";
import {
  checkLiteral,
  type EvidenceIndex,
  indexEvidence,
  type LiteralResult,
  literalKey,
} from "./literal.ts";
import { tableShape, todayIn, verOfRow } from "./plan.ts";
import {
  alignedTo,
  coveredItems,
  fanInAfter,
  hull,
  itemKey,
  type PremiseRefusal,
  pointOf,
  premiseVersForKey,
  type RecordedHere,
  type ResolvedPremise,
  resolvePremises,
  sourceItemsOf,
  tookEffect,
} from "./premises.ts";
import {
  type Fallback,
  readUnderAnotherTask,
  rowEvents,
  rowTable,
  rowVersions,
  type SeenSlot,
  svFromWrite,
  verFromWrite,
  visibleSlotRows,
} from "./reads.ts";
import {
  deletedReceipt,
  externalKeyOf,
  type FallbackOrigin,
  intervalOut,
  keySummary,
  type OpReceipt,
  qualifiedTable,
  type ReceiptWarning,
  readReceipt,
  type WriteReceipt,
  withDerived,
} from "./receipt.ts";
import { decodeRecords, encodeOp, type RowContext, type StoredEvent } from "./record.ts";
import { type Referrer, referrersOf } from "./referrers.ts";
import { givenItems, refProblems, type StoredTargets, tableInRange } from "./refs.ts";
import { findWriteRequest, requestKeyOf } from "./request-key.ts";
import { evidenceSource, placeEvidence } from "./sources.ts";

export { WriteError };

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
  readonly visibility: Visibility;
  readonly params: unknown;
  /** New identifiers (01-objects «标识的写法»), from the caller. */
  readonly newId: (kind: "row" | "entity" | "source" | "item" | "partition") => string;
  /** The open store's buffered reads: the fallback looks there before the stored ones. */
  readonly reads: ReadBuffer;
  /** Where a resolution hands its effect back to the operation's entry (log/effect.ts). */
  readonly effect?: EffectSlot;
}

export const RULESET = 1;

export type { FallbackOrigin, ReceiptWarning };

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

export function requestFailure(e: RequestError): WriteError {
  // The code is the error's own; the detail is the rest.
  const { code, ...detail } = e;
  return new WriteError(code, `the request is refused: ${code}`, detail as never);
}

/** `read_first` (04-contract-types §9): what to read first, and why the fallback found nothing. */
export function readFirst(
  f:
    | { readonly reason: "no_read" }
    | { readonly reason: "task_mismatch"; readonly readTask: string | null },
  what: { readonly target: "row" | "slot" | "item"; readonly ref: unknown },
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

const refKeyOf = (r: ItemRef) => `${r.event}/${r.target}/${r.k}`;

/** A conflict item's candidates still in it (not dropped by a refresh), by their write events. */
export const liveCandidates = (t: TrackedItem): Seq[] =>
  t.cands.filter((_, k) => t.dropped?.has(k) !== true);

/** A pending item on the row the pipeline keeps track of while it writes. */
export interface TrackedItem {
  readonly item: ItemId;
  readonly type: "conflict" | "awaiting_confirmation";
  readonly unit: Unit;
  /** Conflict items: the candidates so far, and the merge base. */
  candidates: number;
  /** Conflict items: each candidate's write event, by its index (`candidates/<k>`). */
  readonly cands: Seq[];
  /**
   * Conflict items: the indices of candidates that left the item (an `item.refreshed`'s
   * `dropped_candidates`, 09 §5.8): no longer its candidates, though their indices stay used.
   */
  dropped?: ReadonlySet<number>;
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
  /** The last `write.base` of this request that reached it (01-objects «不过期 · 改到»). */
  reachedBy?: Seq;
  /**
   * State tables, an item open when the request began: its interval then. A write reaches the item
   * where it changes this interval or the one after it (`reachScope`), so a request that leaves a
   * revert proposal nothing to do still reaches it.
   */
  scopeAtStart?: IntervalSet;
  /** Its entry groups as the log holds them before this request, by path. */
  readonly stored: Readonly<Record<string, unknown>>;
  /** The event that gave each of `stored`, by path (read from the log only). */
  readonly storedAt?: Readonly<Record<string, Seq>>;
  /** Awaiting items: the writes its proposal would take back, as last given. */
  reverted: { readonly op: OpNumber; readonly deps: readonly ItemRef[] }[];
  /**
   * An awaiting revoke of high impact ② (`referenced_row`): the rows still referring to its target,
   * as last given, or as this request finds them at its end. Absent for any other item.
   */
  referrers?: Referrer[];
  /**
   * The `write.base` of this request that changed one of its referrers (a ref value, a revoke),
   * when the item's own row was not written: what a refresh of its referrers names.
   */
  touchedBy?: Seq;
  /** This request's `item.created` / `item.merged` events of the item, filled at its end. */
  readonly fills: { readonly index: number; readonly merged: boolean }[];
}

export interface RowWork {
  readonly ctx: RowContext;
  readonly events: readonly StoredEvent[];
  state: RowState;
  /** Created by an earlier op of this request. */
  createdHere: boolean;
  /** The open items on the row. */
  readonly items: TrackedItem[];
  /** The last `write.base` of this request on the row. */
  lastBase?: Seq;
  /** Each `write.base` of this request on the row, by its op's index (./flagged.ts `by_event`). */
  bases?: { index: number; seq: Seq }[];
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
export function trackedItems(
  events: readonly StoredEvent[],
  open: ReadonlyMap<string, OpNumber>,
): TrackedItem[] {
  const by = new Map<
    string,
    TrackedItem & { stored: Record<string, unknown>; storedAt: Record<string, Seq> }
  >();
  /** The items of each candidate, by `${item}/${k}`. */
  const candRefs = new Map<string, readonly string[]>();
  for (const e of events) {
    const t = e.blocks["target"] as
      | {
          item: ItemId;
          type?: string;
          reason?: string;
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
    // Each candidate's items, by its index: what a refresh's `dropped_candidates` takes away.
    const refsAt = new Map(
      Object.entries(e.blocks).flatMap(([p, c]) => {
        const m = /^candidates\/(\d+)$/.exec(p);
        if (m === null) return [];
        const cand = c as {
          event: Seq;
          items: { field?: FieldId; k?: number; existence?: number }[];
        };
        return [
          [
            Number(m[1]),
            cand.items.map((y) => refKeyOf(refIn({ event: cand.event, ...y }))),
          ] as const,
        ];
      }),
    );
    const cands = Object.entries(e.blocks).flatMap(([p, c]) => {
      const m = /^candidates\/(\d+)$/.exec(p);
      return m === null ? [] : [[Number(m[1]), (c as { event: Seq }).event] as const];
    });
    if (e.header.type === "item.created") {
      if (t.type !== "conflict" && t.type !== "awaiting_confirmation") continue;
      by.set(t.item, {
        item: t.item,
        type: t.type,
        unit: unitIn(t.unit ?? []),
        candidates: n,
        cands: [],
        mergeBase: (t.merge_base_op ?? 0) as OpNumber,
        refs,
        origin: (t.origin_event ?? 0) as Seq,
        versionOp: open.get(t.item) as OpNumber,
        here: false,
        mergedHere: false,
        stored: {},
        storedAt: {},
        reverted: [],
        ...(t.reason === "referenced_row" ? { referrers: [] } : {}),
        fills: [],
      });
    }
    const x = by.get(t.item);
    if (x === undefined) continue;
    if (e.header.type === "item.merged") {
      x.candidates += n;
      x.refs = [...x.refs, ...refs];
    }
    if (e.header.type === "item.created" || e.header.type === "item.merged") {
      for (const [k, ev] of cands) x.cands[k] = ev;
      for (const [k, keys] of refsAt) candRefs.set(`${t.item}/${k}`, keys);
    }
    // 09 §5.8 item.refreshed: the candidates that left the item.
    const left = (t as { dropped_candidates?: number[] }).dropped_candidates;
    if (e.header.type === "item.refreshed" && left !== undefined && left.length > 0) {
      x.dropped = new Set([...(x.dropped ?? []), ...left]);
      const gone = new Set(left.flatMap((k) => candRefs.get(`${t.item}/${k}`) ?? []));
      x.refs = x.refs.filter((r) => !gone.has(refKeyOf(r)));
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
      for (const p of Object.keys(x.stored)) {
        if (!gives.includes(groupOf(p))) continue;
        delete x.stored[p];
        delete x.storedAt[p];
      }
      const given = pick(e.blocks, gives);
      Object.assign(x.stored, given);
      for (const p of Object.keys(given)) x.storedAt[p] = e.header.seq;
    }
  }
  for (const x of by.values()) {
    if (x.referrers !== undefined) {
      x.referrers = Object.entries(x.stored)
        .filter(
          ([p, b]) => p.startsWith("impact/") && (b as { kind: string }).kind === "referencing_row",
        )
        .map(([, b]) => {
          const r = b as { table: TableId; row?: RowId; entity?: EntityId; field: FieldId };
          return {
            table: r.table,
            ...(r.entity !== undefined ? { entity: r.entity } : { row: r.row as RowId }),
            field: r.field,
          };
        });
    }
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
 * read, under the same task, is the item's then, with the restore count now). The item's current
 * version: a proposer whose proposal was refreshed since by another's write, and who has not read
 * the refreshed version, has not read it (a write of theirs that empties it closes it as
 * nothing_to_revert, not overwritten).
 */
export async function hadRead(
  tx: Tx,
  input: { readonly actor: PrincipalId; readonly reads: ReadBuffer },
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
export function withProposals(state: RowState, items: TrackedItem[]): TrackedItem[] {
  for (const t of items) {
    if (t.type !== "awaiting_confirmation") continue;
    t.refs = state.items
      .filter((x) => x.event === t.origin && x.status === "awaiting")
      .map((x) => ({ event: x.event, target: x.target, k: x.k }));
  }
  return items;
}

/**
 * The number of an operation judged on the state now but not written (a confirmation or an undo
 * judged again for an item's contents): after every operation and every event of the row, with
 * its event right after it. An operation's events follow its number (head, sources, base), so one
 * past the last operation can be an existing event: registrations, kept by event, would then take
 * the judged write-backs for that event's items.
 */
function hypotheticalOp(state: RowState, upTo: number): OpNumber {
  return (Math.max(
    upTo,
    ...state.records.map((r) => Math.max(r.op, r.event)),
    ...state.items.map((x) => x.event),
  ) + 1) as OpNumber;
}

/**
 * The judgement confirming an awaiting revert proposal (an `undo`) would make on the state now: the
 * same the confirmation makes (the revert listed again as of then, 04-write-and-read «撤回某次写入
 * （undo）»), so that the item shows what confirming it does (05-time «高影响写入»). Undefined for any
 * other item, or where the confirmation would be refused now.
 */
function confirmNow(state: RowState, t: TrackedItem, upTo?: OpNumber): Judgement | undefined {
  if (t.type !== "awaiting_confirmation") return undefined;
  const opened = state.records.find((r) => r.event === t.origin);
  if (opened?.kind !== "undo") return undefined;
  const op = hypotheticalOp(state, upTo ?? 0);
  try {
    return judgeOp(state, {
      kind: "confirm",
      op,
      index: 0,
      event: (op + 1) as Seq,
      ruleset: RULESET,
      target: t.origin,
    }).judgement;
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    return undefined;
  }
}

/**
 * The interval of a tracked item (state tables): its candidates' or proposal's items; for a revert
 * proposal, what confirming it would write now (the interval follows the state, as the impact does).
 * The interval is the confirmation's judgement, so that confirming writes exactly it; the impact is
 * the undo judged again (`awaitingImpactNow`), not that same judgement, because a confirmation does
 * not judge high impact (it does not say what would be overwritten, ①). The two list the same revert
 * entries (awaiting-revert.prop checks it).
 */
/** A state entity has a value at some point (05-time «无值区间»: every required field has one). */
const valuedSomewhere = (state: RowState): boolean =>
  state.pieces().some((p) => state.hasValue(p, EVERYTHING));

export function scopeFor(state: RowState, t: TrackedItem): IntervalSet {
  if (!state.isState) return [WHOLE];
  const now = confirmNow(state, t);
  return now !== undefined ? revertScope(state, now, t.refs).valid : scopeOf(state, t.refs);
}

/**
 * Where a write of the request reaches an item (01-objects «不过期 · 改到»): its interval as the
 * request began together with its interval now. A revert proposal's interval follows the state, so
 * each half guards one way it moves:
 * - the interval as the request began: a write that leaves the proposal nothing to do empties it;
 *   judged on the interval after the write alone, the write (or a later op of the same request)
 *   would not reach it, and a writer that had read the item would not supersede it;
 * - the interval now: a write outside the interval that widens it (say the undo of a revoke under
 *   it) changes what confirming it does; judged on the interval as the request began alone, the
 *   write would not reach it either.
 */
export function reachScope(state: RowState, t: TrackedItem): IntervalSet {
  const now = scopeFor(state, t);
  return t.scopeAtStart === undefined ? now : unionOf(t.scopeAtStart, now);
}

/**
 * The entries of an item as of `at` (09 §5.8), every group: a conflict item's interval, current
 * values, values at the merge base and impact; an awaiting item's interval, current values,
 * proposal and impact (what the proposal would overwrite now, and the writes it would take back
 * while they are in effect).
 */
export function itemContents(state: RowState, t: TrackedItem, at: Limit): ItemContents {
  // A revert proposal: its interval from the judgement of its confirmation now, so that confirming
  // writes the interval shown; its impact, as before, from the same undo judged again now (that
  // judgement also says what it would overwrite, high impact ①, which a confirmation does not
  // judge).
  const now = confirmNow(state, t, at.upTo);
  if (now !== undefined) {
    const revert = revertScope(state, now, t.refs);
    return {
      ...(state.isState ? { scope: revert } : {}),
      current: unitEntries(state, t.unit, state.isState ? revert.valid : [WHOLE], at, t.refs),
      proposed: proposedOf(state, t),
      impact: awaitingImpactNow(state, t, at),
    };
  }
  const scope = scopeFor(state, t);
  const scopeBlock = state.isState ? { scope: { valid: scope, deps: t.refs } } : {};
  const current = unitEntries(state, t.unit, scope, at, t.refs);
  if (t.type === "conflict") {
    return {
      ...scopeBlock,
      current,
      previous: unitEntries(state, t.unit, scope, { upTo: t.mergeBase }, t.refs),
      impact: conflictImpact(state, t.mergeBase, t.refs, at, previousNow(state, t, at)),
    };
  }
  return {
    ...scopeBlock,
    current,
    proposed: proposedOf(state, t),
    impact: [...awaitingImpactNow(state, t, at), ...referencingRows(t)],
  };
}

/** High impact ②: each referrer of the item's target, an impact entry (09 §5.8 `referencing_row`). */
function referencingRows(t: TrackedItem) {
  return (t.referrers ?? []).map((r) => ({
    kind: "referencing_row" as const,
    table: r.table as string,
    ...(r.entity !== undefined ? { entity: r.entity as string } : { row: r.row as string }),
    field: r.field as string,
  }));
}

/** An awaiting item's proposal entries: each value its items give, a span of their interval each. */
function proposedOf(state: RowState, t: TrackedItem) {
  return t.refs.flatMap((r) => {
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
}

/**
 * An awaiting item's impact as of `at`. A proposal that is an `undo` is judged again on the state
 * now, the same undo of the same operation: what it would take back or hide is the judge's, the
 * writes after it included (high impact ④). Any other proposal: what it would overwrite now.
 *
 * An `undo` the judge refuses now (say the row was revoked since) has an empty impact, never the
 * impact listed when it was proposed: that one may name writes it no longer touches, and an item
 * with nothing to write back and nothing listed is closed (`nothingToRevert`). This rests on the
 * confirmation then writing nothing back too. awaiting-revert.prop counts the items where the undo
 * is refused while the confirmation writes something: such items are known (a confirmation that
 * changes nothing that can be read, over a row revoked before and after), and which of the two
 * judgements is right there is open.
 *
 * Where the undo judged again is accepted, its write-backs are the ones confirming now writes, so
 * the impact compares what a reader sees before and after the confirmation (04-write-and-read «撤回
 * 某次写入（undo）»): both are numbered after every event of the row (`hypotheticalOp`), both list
 * the revert as of now from the same operation (`undoEntries` of the record's `before`, which the
 * undo resolved when written), and the write-backs depend on the entries and that numbering alone.
 */
function awaitingImpactNow(state: RowState, t: TrackedItem, at: Limit) {
  if (!isUndoProposal(state, t)) return proposalImpact(state, t.refs, t.reverted, at);
  const again = undoNow(state, t, at);
  return again === undefined ? [] : awaitingImpact(state, again);
}

/**
 * The source IDs a contribution item rests on (09 §5.7 `sources/<field>/<k>`): its sources, or
 * those of the item it carries, followed until given. Read from the log, so the operation that
 * wrote the item must be appended already.
 */
async function sourceIdsOf(tx: Tx, ref: ItemRef): Promise<SourceId[]> {
  const seqs = new Set<number>();
  const seen = new Set<string>();
  let todo: ItemRef[] = [ref];
  while (todo.length > 0) {
    const next: ItemRef[] = [];
    for (const r of todo) {
      const key = `${r.event}/${r.target}/${r.k}`;
      if (seen.has(key) || r.target === "existence") continue;
      seen.add(key);
      // A block a pending deletion lists reads as none: the item it carried is deleted.
      const b = await tx.query<{ body: string | null }>(
        `SELECT body FROM ${READABLE_CONTENT} c WHERE seq = $1 AND path = $2`,
        [r.event, `sources/${r.target}/${r.k}`],
      );
      const body = b.rows[0]?.body;
      if (body == null) continue;
      for (const x of JSON.parse(body) as {
        source?: number;
        carried?: { event: number; field: string; k: number };
      }[]) {
        if (x.source !== undefined) seqs.add(x.source);
        else if (x.carried !== undefined) next.push(refIn(x.carried));
      }
    }
    todo = next;
  }
  if (seqs.size === 0) return [];
  const r = await tx.query<{ source_id: SourceId }>(
    "SELECT source_id FROM sources WHERE seq = ANY($1) ORDER BY seq",
    [[...seqs]] as never,
  );
  return r.rows.map((x) => x.source_id);
}

/** Whether a tracked item is an awaiting `undo` (a revert proposal). */
function isUndoProposal(state: RowState, t: TrackedItem): boolean {
  if (t.type !== "awaiting_confirmation") return false;
  const opened = state.records.find((r) => r.event === t.origin);
  return opened?.kind === "undo" && opened.revert.before !== undefined;
}

/**
 * An awaiting undo judged again on the state now, as an undo of the same operation (its impact:
 * what it would take back, hide, and overwrite, high impact ①–④). Undefined for any other item, or
 * where the undo would be refused now.
 */
function undoNow(state: RowState, t: TrackedItem, at: Limit): Judgement | undefined {
  const opened = state.records.find((r) => r.event === t.origin);
  if (opened?.kind !== "undo" || opened.revert.before === undefined) return undefined;
  const op = hypotheticalOp(state, at.upTo);
  try {
    return judgeOp(state, {
      kind: "undo",
      op,
      index: 0,
      event: (op + 1) as Seq,
      ruleset: RULESET,
      seen: at.upTo,
      seenExplicit: true,
      target: opened.revert.before,
      ...(opened.includeLater ? { includeLater: true } : {}),
    }).judgement;
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    return undefined;
  }
}

/**
 * Testing: an awaiting revert proposal's undo judged again now and its confirmation judged now,
 * the revert entries each lists (null where it would be refused). The item shows its impact from
 * the first and its interval from the second; the two must list the same entries.
 */
export function revertEntriesNow(
  state: RowState,
  t: TrackedItem,
  upTo: OpNumber,
): { readonly undo: readonly unknown[] | null; readonly confirm: readonly unknown[] | null } {
  const entriesOf = (j: Judgement | undefined) => {
    const r = j?.record;
    return r === undefined
      ? null
      : r.kind === "undo" || r.kind === "confirm"
        ? (r.revert?.entries ?? [])
        : null;
  };
  return {
    undo: entriesOf(undoNow(state, t, { upTo })),
    confirm: entriesOf(confirmNow(state, t, upTo)),
  };
}

/**
 * The row a conflict item's `take_previous`, judged now without being written, would leave, and
 * where to read it and the row now: for the writes whose result it would change (its impact). Not
 * given where it cannot be judged now.
 */
function previousNow(
  state: RowState,
  t: TrackedItem,
  at: Limit,
): { readonly state: RowState; readonly at: Limit; readonly afterAt: Limit } | undefined {
  const op = hypotheticalOp(state, at.upTo);
  try {
    const out = judgeOp(state, {
      kind: "take_previous",
      op,
      index: 0,
      event: (op + 1) as Seq,
      ruleset: RULESET,
      unit: t.unit,
      candidates: liveCandidates(t),
    });
    return { state: out.state, at: { upTo: (op - 1) as OpNumber }, afterAt: { upTo: op } };
  } catch (e) {
    if (!(e instanceof JudgeError)) throw e;
    return undefined;
  }
}

/** The intent of the undone operation's last `write.base` on the row (01-objects). */
function undoneIntent(events: readonly StoredEvent[], undone: OpNumber): NormalizedOp["intent"] {
  const bases = events.filter((e) => e.header.type === "write.base" && e.header.op === undone);
  const last = bases.at(-1)?.blocks["target"] as { intent?: string } | undefined;
  return (last?.intent ?? "update") as NormalizedOp["intent"];
}

/**
 * Where a judgement failed, for its error: the op of the write (none in a resolve, whose request has
 * no ops) and the table, whose field names and granularity the error is written in.
 */
export interface FailedAt {
  readonly index?: number;
  readonly slot: string;
  readonly table: CompiledBaseTable;
  /** The row or entity judged (`revoked` names it). */
  readonly id: string;
}

/** A judgement's failure as the contract's error (04-contract-types §9). */
export function judgeFailure(e: JudgeError, at: FailedAt): WriteError {
  const param = at.index !== undefined ? `ops/${at.index}` : undefined;
  switch (e.reason) {
    case "invalid_argument": {
      // `param` in the detail: the op's parameter it names; `field`: the field of `set` it names
      // (`no_value_now`), by its name. A decision's write has no ops: the field is given by name
      // instead. Never by its ID: a field not found is left out.
      const { param: given, field, ...rest } = e.detail as { param?: unknown; field?: unknown };
      const name =
        typeof field === "string" ? at.table.fields.find((x) => x.id === field)?.name : undefined;
      const sub =
        typeof given === "string" ? given : name !== undefined ? `set/${name}` : undefined;
      const where = param === undefined ? undefined : sub !== undefined ? `${param}/${sub}` : param;
      return new WriteError("invalid_argument", e.message, {
        ...(where !== undefined ? { param: where } : {}),
        ...(param === undefined && name !== undefined ? { field: name } : {}),
        ...rest,
      });
    }
    case "validation_failed":
      return new WriteError("validation_failed", e.message, {
        reason: "write",
        details: gapDetails((e.detail as { gaps?: readonly GapEntry[] }).gaps ?? [], at),
      });
    case "revoked": {
      // The revoke keeping the row revoked now: the latest of those in effect, as a field's state
      // takes the latest item (RowState.fieldState; `filled_gaps.revoked_by` likewise). Every
      // sequence of writes tried leaves one in effect: revoking a revoked row is refused, and an
      // undo of a revoke registers it (revoked, undone, revoked again: only the second is in
      // effect, write-pipeline.test.ts). Taking the earliest instead passes every test for that
      // reason; the latest is what a revoke still in effect after another would need.
      const ops = (e.detail as { ops?: readonly number[] }).ops ?? [];
      const isState = at.table.time.type === "state";
      return new WriteError("revoked", e.message, {
        ...(param !== undefined ? { param } : {}),
        target: { table: qualifiedTable(at.slot, at.table), [isState ? "entity" : "row"]: at.id },
        ...(ops.length > 0 ? { revoked_by: Math.max(...ops) } : {}),
      });
    }
    default:
      return new WriteError("internal", e.message, param !== undefined ? { param } : {});
  }
}

/** A premise refused at step 5, as the write's error (04-contract §5 «写入的前提» «校验»). */
function premiseFailure(r: PremiseRefusal): WriteError {
  if (r.code === "not_this_target") {
    return new WriteError("invalid_argument", "the ver is not a version of the premise's target", {
      reason: "not_this_target",
      param: r.param,
    });
  }
  return new WriteError(r.code, `the premise is refused: ${r.reason ?? r.code}`, {
    ...(r.reason !== undefined ? { reason: r.reason } : {}),
    param: r.param,
    ...(r.detail ?? {}),
  } as never);
}

/** One `required_in_gap` detail per field and stretch: the field's name, the stretch's interval. */
function gapDetails(gaps: readonly GapEntry[], at: FailedAt): WriteValidationDetail[] {
  const t = at.table;
  const byDate = t.time.type === "state" && t.time.granularity === "date";
  const name = (f: string) => t.fields.find((x) => x.id === f)?.name ?? f;
  return gaps.flatMap((g) =>
    g.valid.map((v) => ({
      ...(at.index !== undefined ? { op: at.index } : {}),
      table: qualifiedTable(at.slot, t),
      field: name(g.field),
      code: "required_in_gap" as const,
      valid: intervalOut(v, byDate),
    })),
  );
}

/** The raw values a write gave, as the head event records them (09 §1.3). */
/**
 * A field's raw value checked against a source's text (`literal@1`), once a segment and value as the
 * checker compares it (`literalKey`) in a request: `done` is the request's.
 */
function literalOf(
  table: CompiledBaseTable,
  raw: Partial<Record<FieldId, RawFieldValue>>,
  indexOf: (seq: Seq) => EvidenceIndex | undefined,
  done: Map<string, LiteralResult>,
): (field: FieldId, source: Seq) => LiteralResult {
  return (field, source) => {
    const def = table.fields.find((x) => x.id === field);
    if (def === undefined) return "na";
    const value = raw[field] ?? null;
    const key = `${source}|${literalKey(def, value)}`;
    let r = done.get(key);
    if (r === undefined) {
      r = checkLiteral(def, value, indexOf(source));
      done.set(key, r);
    }
    return r;
  };
}

/**
 * The text of sources a request names (`source_ref`): a text segment's text, a file reference's
 * excerpt; none where it has none, or its block was removed by a deletion. A source a pending
 * deletion lists is refused before this (`pending_deletion_source`, ./sources.ts), so a pending
 * block here is an inconsistency, not something to read past.
 */
async function storedTexts(
  tx: ReadTx,
  seqs: readonly Seq[],
): Promise<Map<Seq, string | undefined>> {
  const out = new Map<Seq, string | undefined>(seqs.map((s) => [s, undefined]));
  if (seqs.length === 0) return out;
  const r = await tx.query<{
    seq: unknown;
    path: string;
    body: string | null;
    pending_by: unknown;
  }>(
    `SELECT seq, path, body, pending_by FROM ${readableContentOf("$1")} c
     WHERE path IN ('text', 'file')`,
    [[...new Set(seqs)]] as never,
  );
  for (const x of r.rows) {
    if (x.pending_by !== null) {
      throw new WriteError("internal", `source ${x.seq} is in a pending deletion yet was cited`);
    }
    if (x.body === null) continue;
    const b = JSON.parse(x.body) as { text?: string; excerpt?: string };
    out.set(Number(x.seq) as Seq, x.path === "text" ? b.text : b.excerpt);
  }
  return out;
}

/** The rows and entities a request has worked on, as `referrersOf` reads them. */
function knownRows(rows: ReadonlyMap<string, RowWork>) {
  return new Map([...rows].map(([id, w]) => [id, { table: w.ctx.table, state: w.state }]));
}

/**
 * The rows and entities a request's ref values named, before it or after it, each with the table
 * the field names and the `write.base` of the row that named it: of every row the request wrote
 * (a revoke or a revoke undone included: its values then). Every value an item of a ref field of
 * such a row gives, in effect or not: a superset, what is found again is compared.
 */
/**
 * High impact ② at the end of a request or a resolution (05-time «高影响写入» ②, its end: the
 * referrers change, "and the item's effect is refreshed accordingly"): the targets its ref values
 * named before or after it, and those of the rows it revoked or brought back. An open
 * `referenced_row` item on one has its referrers found again (as of the end, the request's own rows
 * laid over), the target's row loaded into `rows` when it was not touched. The item names the
 * `write.base` of a row that joined or left its referrers (`touchedBy`), when its own row was not
 * written; settling compares its entries and refreshes it if they changed.
 */
export async function refreshReferenced(
  tx: Tx,
  rows: Map<string, RowWork>,
  o: {
    readonly tables: readonly { readonly id: TableId; readonly kind: string }[];
    /** The log's restores, when the caller read them (`RowContext.restores`). */
    readonly restores?: RowContext["restores"];
    readonly op: OpNumber;
  },
): Promise<void> {
  for (const [target, { table: targetTable, by }] of referredTargets(rows, o.tables)) {
    // An item the request opened is not stored yet: the row is among the request's own then.
    let work = rows.get(target);
    if (work === undefined) {
      const open = await tx.query<{ id: string }>(
        `SELECT id FROM pending_items WHERE target_table = $1 AND target_row = $2
           AND state = 'open' AND type = 'awaiting_confirmation'`,
        [targetTable, target],
      );
      if (open.rows.length === 0) continue;
      const t = o.tables.find((x) => x.id === targetTable) as CompiledBaseTable;
      const isState = t.time.type === "state";
      work = await loadRow(
        tx,
        {
          table: t.id,
          target: isState ? { entity: target as EntityId } : { row: target as RowId },
          shape: tableShape(t),
          granularity: isState && t.time.type === "state" ? t.time.granularity : "date",
          ...(o.restores !== undefined ? { restores: o.restores } : {}),
        },
        "ops",
      );
      rows.set(target, work);
    }
    for (const t of work.items) {
      if (t.referrers === undefined) continue;
      const was = new Set<string>(t.referrers.map((r) => (r.row ?? r.entity) as string));
      const now = await referrersOf(tx, {
        tables: o.tables as never,
        targetTable,
        target,
        known: knownRows(rows),
        at: { upTo: o.op },
      });
      const is = new Set<string>(now.map((r) => (r.row ?? r.entity) as string));
      t.referrers = now;
      // The write that changed who refers: of a row that joined or left (09 §5.8 `by_event`).
      const moved = [...by.keys()].find((id) => was.has(id) !== is.has(id));
      const at = moved !== undefined ? by.get(moved) : undefined;
      if (at !== undefined) t.touchedBy ??= at;
    }
  }
}

/**
 * The rows and entities a request's ref values named, before it or after it, each with the table
 * the field names and, by the row naming it, that row's `write.base`: of every row the request
 * wrote (a revoke or a revoke undone included: its values then). Every value an item of a ref field
 * of such a row gives, in effect or not: a superset, what is found again is compared.
 */
function referredTargets(
  rows: ReadonlyMap<string, RowWork>,
  tables: readonly { readonly id: TableId; readonly kind: string }[],
): Map<string, { readonly table: TableId; readonly by: Map<string, Seq> }> {
  const out = new Map<string, { table: TableId; by: Map<string, Seq> }>();
  for (const [id, w] of rows) {
    if (w.lastBase === undefined) continue;
    const t = tables.find((x) => x.id === w.ctx.table);
    if (t?.kind !== "base") continue;
    for (const f of (t as CompiledBaseTable).fields) {
      if (f.type !== "ref") continue;
      const to = (f as { ref: { table: TableId } }).ref.table;
      for (const x of w.state.items) {
        if (x.target !== f.id || x.content.kind !== "value") continue;
        const v = x.content.value;
        if (typeof v !== "string" || v === id) continue;
        const entry = out.get(v) ?? { table: to, by: new Map<string, Seq>() };
        entry.by.set(id, w.lastBase);
        out.set(v, entry);
      }
    }
  }
  return out;
}

/**
 * The temporary names the ref values of `o`'s `set` give ("@name"), each with its field. Only a
 * ref field's value is a name: any other field's text starting with "@" is that text.
 */
function namesUsed(
  o: NormalizedOp,
  table: CompiledBaseTable,
): { readonly field: FieldId; readonly name: string }[] {
  const out: { field: FieldId; name: string }[] = [];
  for (const [f, x] of Object.entries(o.fields ?? {})) {
    const v = x?.value;
    if (table.fields.find((y) => y.id === f)?.type !== "ref") continue;
    if (typeof v === "string" && v.startsWith("@"))
      out.push({ field: f as FieldId, name: v.slice(1) });
  }
  return out;
}

/** `o` with each name of `named` the ID it is bound to (value and raw alike), in its field. */
function withNamesBound(
  o: NormalizedOp,
  named: readonly { readonly field: FieldId; readonly name: string }[],
  bound: ReadonlyMap<string, { readonly id?: string }>,
): NormalizedOp {
  const fields: Record<FieldId, NormalizedField> = { ...(o.fields ?? {}) };
  for (const n of named) {
    const id = bound.get(n.name)?.id;
    if (id !== undefined) fields[n.field] = { value: id as FieldValue, raw: id };
  }
  return { ...o, fields };
}

/** The row the key index names for a key, if any. */
async function keyHolder(
  tx: ReadTx,
  table: CompiledBaseTable,
  key: Readonly<Record<FieldId, NormalizedField>>,
): Promise<string | undefined> {
  const ids = (table as { external_key?: readonly FieldId[] }).external_key ?? [];
  const values = canonicalize(ids.map((f) => (key[f]?.value ?? null) as JsonValue));
  const r = await tx.query<{ holder_row: string }>(
    "SELECT holder_row FROM external_keys WHERE table_id = $1 AND key_values = $2",
    [table.id, values],
  );
  return r.rows[0]?.holder_row;
}

/** An external key as the request gives it, by field name: its values as written. */
function keyAsGiven(
  table: CompiledBaseTable,
  key: Readonly<Record<FieldId, NormalizedField>>,
): Record<string, ValueOut> {
  // As written: a key field's value is text, a number or an enum's (never a zoned date-time).
  return Object.fromEntries(
    Object.entries(key).map(([f, x]) => [
      table.fields.find((y) => y.id === f)?.name ?? f,
      x.raw as ValueOut,
    ]),
  );
}

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

/** How many keys a receipt lists for an entity created by key (04-contract §5.1). */
const EXISTING_KEYS = 10;

/**
 * A row or entity as a request finds it: its state rebuilt from its events, and its open items
 * with what they hold (conflicts and proposals; a flagged item on it is judged again at the
 * request's end, ./flagged.ts).
 */
export async function loadRow(tx: Tx, given: RowContext, param: string): Promise<RowWork> {
  // A ver of an earlier restore count in the log reads at the restore point of its write
  // (`decodeRecords`): every caller's row read with the log's restores.
  const ctx =
    given.restores !== undefined ? given : { ...given, restores: await restoreHistory(tx) };
  const id = ("row" in ctx.target ? ctx.target.row : ctx.target.entity) as string;
  if ((await rowTable(tx, id)) !== ctx.table) {
    throw new WriteError("not_found", "no such row or entity", {
      reason: "row" in ctx.target ? "row" : "entity",
      param,
    });
  }
  const events = await rowEvents(tx, ctx.table, id);
  const state = stateFromRecord(ctx.shape, decodeRecords(ctx, events));
  const open = await openItemsOn(tx, ctx.table, id);
  const items = withProposals(
    state,
    trackedItems(events, new Map(open.map((x) => [x.id, x.versionOp as OpNumber]))),
  );
  if (state.isState) for (const t of items) t.scopeAtStart = scopeFor(state, t);
  return { ctx, events, state, createdHere: false, items };
}

/**
 * A revert proposal that, judged again on the state now, has nothing to write back and no write to
 * hide (04-write-and-read «撤回某次写入（undo）»): in place of refreshing it, it is closed,
 * superseded by the write that left it so. It then can no longer be confirmed or rejected, and does
 * not come back when a later write gives it something to do again. A writer that had read the item
 * supersedes it as overwritten instead: that closes it without a refresh, so there is no refresh to
 * take the place of.
 */
function nothingToRevert(state: RowState, t: TrackedItem, upTo: OpNumber): boolean {
  const now = confirmNow(state, t, upTo);
  return (
    now !== undefined &&
    now.record.kind === "confirm" &&
    now.record.items.length === 0 &&
    awaitingImpactNow(state, t, { upTo }).length === 0
  );
}

/** The `item.superseded` closing a revert proposal with nothing left to do. */
const closedEmpty = (slot: NonNullable<NewEvent["slot"]>, item: ItemId, by: Seq): NewEvent => ({
  type: "item.superseded",
  slot,
  blocks: { target: { item, reason: "nothing_to_revert", by_event: by } } as never,
});

/**
 * The pending items as of the request's end (01-objects «不过期»; 09 §5.8 «一次请求里的事项内容»):
 * the request's item events get their entries; an open item some op reached is superseded when the
 * writer had read it as the request began (not one this request joined), refreshed otherwise; an
 * open item on a row the request wrote that no op reached is refreshed when its entries,
 * recomputed, changed (their impact does not go stale, 01-objects «影响»). Each item gets one of
 * these at most. Appends to `events`; returns how many it appended.
 */
export async function settleItems(
  tx: Tx,
  rows: Iterable<RowWork>,
  o: {
    readonly op: OpNumber;
    readonly slot: NonNullable<NewEvent["slot"]>;
    readonly writer: { readonly actor: PrincipalId; readonly reads: ReadBuffer };
    readonly task: string | null;
    readonly restore: number;
    readonly events: NewEvent[];
  },
): Promise<number> {
  let added = 0;
  const atEnd: Limit = { upTo: o.op };
  for (const work of rows) {
    for (const t of [...work.items]) {
      const blocks = contentBlocks(itemContents(work.state, t, atEnd));
      for (const f of t.fills) {
        const ev = o.events[f.index] as NewEvent;
        const groups = f.merged ? (GIVES["item.merged"] as readonly string[]) : GROUPS;
        o.events[f.index] = { ...ev, blocks: { ...ev.blocks, ...pick(blocks, groups) } as never };
      }
      // Its own row written by the request, or only one of its referrers (high impact ②).
      const by = work.lastBase ?? t.touchedBy;
      if (t.here || by === undefined) continue;
      const mergeBase = t.type === "conflict" ? { merge_base_op: t.mergeBase } : {};
      if (t.reachedBy !== undefined) {
        if (!t.mergedHere && (await hadRead(tx, o.writer, o.task, t, o.restore))) {
          o.events.push({
            type: "item.superseded",
            slot: o.slot,
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
        } else if (nothingToRevert(work.state, t, atEnd.upTo)) {
          o.events.push(closedEmpty(o.slot, t.item, t.reachedBy));
          work.items.splice(work.items.indexOf(t), 1);
        } else {
          o.events.push({
            type: "item.refreshed",
            slot: o.slot,
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
        added++;
        continue;
      }
      // A join of this request gave the item's contents with it (item.merged): nothing more.
      if (t.mergedHere) continue;
      if (canonicalize(t.stored as never) === canonicalize(blocks as never)) continue;
      if (nothingToRevert(work.state, t, atEnd.upTo)) {
        o.events.push(closedEmpty(o.slot, t.item, by));
        work.items.splice(work.items.indexOf(t), 1);
        added++;
        continue;
      }
      o.events.push({
        type: "item.refreshed",
        slot: o.slot,
        blocks: {
          target: { item: t.item, by_event: by, cause: "entries_changed", ...mergeBase },
          ...blocks,
        } as never,
      });
      added++;
    }
  }
  return added;
}

/**
 * The slot as version `then` names it (07 «旧名字还认多久»: a write resolves names by the request's
 * `sv`, then goes by IDs): each table and field of that version under its name then, with the
 * current version's definition. A table that version has and the current one does not (dropped
 * since) keeps its earlier definition, for the request to be refused as written to a dropped table.
 * The changes a version switches to without rebuilding a table (renames, descriptions, a dropped
 * table) leave a field's type as it was; one that rebuilds a table comes with its migration.
 */
export function namedAt(current: CompiledSchema, then: CompiledSchema): CompiledSchema {
  return {
    ...current,
    tables: then.tables.map((t) => {
      const now = current.tables.find((x) => x.id === t.id);
      if (now === undefined) return t;
      if (now.kind !== "base" || t.kind !== "base") return { ...now, name: t.name };
      return {
        ...now,
        name: t.name,
        fields: now.fields.flatMap((f) => {
          const was = t.fields.find((g) => g.id === f.id);
          return was === undefined ? [] : [{ ...f, name: was.name }];
        }),
      };
    }),
  };
}

/**
 * The slot by IDs for everything after the names are resolved (judging, the rows, the log, the
 * receipt): every table and field of the current version, those `then` has under their names then,
 * those added since under their names now; a table dropped since kept as `then` has it. Names
 * only: the definitions are the current ones. Not decided yet: a name used again after a rename
 * gives a receipt two of it. A table renamed a→b and a new table named a after it can be switched
 * to now: two tables `a` here (judging goes by IDs, so only the receipt's names are affected). A
 * field renamed a→b and a new field named a: when adding a field can be switched to.
 */
export function namedAsWritten(current: CompiledSchema, then: CompiledSchema): CompiledSchema {
  const tables = current.tables.map((now) => {
    const t = then.tables.find((x) => x.id === now.id);
    if (t === undefined) return now;
    if (now.kind !== "base" || t.kind !== "base") return { ...now, name: t.name };
    return {
      ...now,
      name: t.name,
      fields: now.fields.map((f) => {
        const was = t.fields.find((g) => g.id === f.id);
        return was === undefined ? f : { ...f, name: was.name };
      }),
    };
  });
  const dropped = then.tables.filter((t) => !current.tables.some((x) => x.id === t.id));
  return { ...current, tables: [...tables, ...dropped] };
}

/** Each slot's definition at version `sv`, by slot ID; none for a version the slot never had. */
async function definitionsAt(
  tx: ReadTx,
  wanted: readonly { readonly slot: string; readonly sv: number }[],
): Promise<Map<string, CompiledSchema>> {
  const out = new Map<string, CompiledSchema>();
  for (const w of wanted) {
    const r = await tx.query<{ body: string | null }>(
      `SELECT c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
       WHERE v.slot_id = $1 AND v.sv = $2 AND v.state IN ('current', 'retired')`,
      [w.slot, w.sv],
    );
    const body = r.rows[0]?.body;
    if (body != null) out.set(w.slot, JSON.parse(body) as CompiledSchema);
  }
  return out;
}

/** Writes the request in `tx`; returns its receipt, or the original one for a repeated request. */
export async function writeInTx(tx: Tx, input: WriteInput): Promise<WriteReceipt> {
  return writeIn(tx, input, undefined);
}

/** What a write by external key came to, for its receipt (04-contract-types §5.1 `OpResult`). */
interface KeyedOutcome {
  readonly outcome: "created" | "updated" | "unchanged" | "pending" | "skipped";
  /** Absent only when skipped for a temporary name (`refOp`) before locating found no row. */
  readonly row?: RowId;
  /** `skipped`: the revoke in effect on the row, by operation (this request's own, if it revoked it). */
  readonly revokedBy?: OpNumber;
  /** `skipped` (`ref_skipped`): the op whose temporary name a ref value named, itself skipped. */
  readonly refOp?: number;
}

/**
 * The write path. A write by external key that leaves nothing (`unchanged`, `skipped`) enters no
 * event and has no `api_call` (09 §4.2), and every source comes before every `write.base`: which
 * ops leave nothing is known only once they are judged. So the request is judged with every op
 * entering events; when some left nothing, it is judged again from the start with those left out
 * (`nothing`), numbered without them. Nothing is written before the events are appended, and an
 * op that left nothing changed no state the first time either, so the second time judges the same.
 */
async function writeIn(
  tx: Tx,
  input: WriteInput,
  nothing: ReadonlySet<number> | undefined,
  /** Ops whose flagged item is not opened: none of its rows matches by the request's end. */
  unflagged?: ReadonlySet<number>,
): Promise<WriteReceipt> {
  const { actor, now } = input;
  // Names resolve within what the caller can see (04-contract «名字只在可见范围内解析»): a slot,
  // table or field out of range is answered as one that does not exist, with the nearest names
  // and the candidates taken from what is visible only.
  const visible = await visibleSlotRows(tx, input.visibility);
  // The request's version on each slot: its `sv` as given, else the caller's by fallback on that
  // slot (04-contract §2); names resolve by it (07 «旧名字还认多久»: the caller's names come from the
  // version it read). Taken before the request is normalized, from its parameters as sent; a
  // malformed `sv` or `task` is refused in normalizing. A slot only ever at one version needs none.
  const raw = isObj(input.params) ? input.params : {};
  const givenSv = get(raw, "sv");
  const explicitSv =
    typeof givenSv === "number" && Number.isSafeInteger(givenSv) ? givenSv : undefined;
  const rawTask = get(raw, "task");
  const fallbackTask = typeof rawTask === "string" ? rawTask : input.task;
  const svFallbacks = new Map<string, Awaited<ReturnType<typeof fallback>>>();
  const svFallback = async (s: SeenSlot) => {
    const known = svFallbacks.get(s.slot);
    if (known !== undefined) return known;
    const f = await fallback(tx, input, fallbackTask, { kind: "sv", target: s.slot }, () =>
      svFromWrite(tx, s.slot, actor, fallbackTask),
    );
    svFallbacks.set(s.slot, f);
    return f;
  };
  const withRetired = new Set(
    (
      await tx.query<{ slot_id: string }>(
        "SELECT DISTINCT slot_id FROM schema_versions WHERE state = 'retired'",
      )
    ).rows.map((x) => x.slot_id),
  );
  const earlier: { slot: string; sv: number }[] = [];
  for (const s of visible) {
    if (!withRetired.has(s.slot)) continue;
    const f = explicitSv !== undefined ? { found: explicitSv } : await svFallback(s);
    if ("found" in f && f.found < s.sv) earlier.push({ slot: s.slot, sv: f.found });
  }
  // Each slot as the request's version names it, where that is not the current one.
  const versionNames = new Map<string, CompiledSchema>();
  const versionNamesWhole = new Map<string, CompiledSchema>();
  for (const [id, then] of await definitionsAt(tx, earlier)) {
    const s = visible.find((x) => x.slot === id) as SeenSlot;
    const n = namedAt(s.compiled, { ...then, name: s.name });
    versionNamesWhole.set(id, namedAsWritten(s.compiled, { ...then, name: s.name }));
    versionNames.set(id, {
      ...n,
      tables: visibleTables(input.visibility, s.slot, n.tables) ?? [],
    });
  }
  // A table name is looked up in each slot by its current names and by the request's version's:
  // one slot having it either way is the request's; two are `ambiguous_table`, whichever way each
  // has it (`sv` is per slot: either could be meant).
  const which = resolveWriteSlot(
    input.params,
    visible.map((s) => {
      const names = s.tables.map((t) => t.name);
      for (const t of versionNames.get(s.slot)?.tables ?? [])
        if (!names.includes(t.name)) names.push(t.name);
      return {
        name: s.name,
        tables: names,
        // Not names: only for the order of `nearest` (04-contract §11).
        aliases: new Map(s.tables.map((t) => [t.name, t.aliases ?? []] as const)),
      };
    }),
  );
  if (!which.ok) throw requestFailure(which.error);
  // The slot and its tables are in range (`visible`): a credential writes whatever it can see
  // (04-write-and-read «可见范围 · 写入»).
  const slot = visible.find((s) => s.name === which.slot) as SeenSlot;
  // The slot as the request names it: its version's names, else the current ones.
  const naming: CompiledSchema = versionNames.get(slot.slot) ?? {
    ...slot.compiled,
    tables: slot.tables,
  };
  // The slot by IDs, named by the same version: the receipt and what a refusal names say it as the
  // request does, so its names and its `sv` agree. The definitions are the current ones.
  const receiptNames: CompiledSchema = versionNamesWhole.get(slot.slot) ?? slot.compiled;
  const today = todayIn(now, slot.timezone);
  // What changed incompatibly since the request's version, field by field or as a whole table, as
  // the versions switched to since recorded it (07 «原则» 4). A slot only ever at one version, or a
  // request at the current one, has nothing since: not read.
  const switched =
    withRetired.has(slot.slot) && (explicitSv === undefined || explicitSv < slot.sv)
      ? await switchedVersions(tx, slot.slot)
      : [];
  const changedSince = (sv: number) => changedSinceOf(switched, sv);
  // The versions ever in effect: numbers skip (04-contract §2), and a draft's number is no version.
  // With them, in the same statement, the versions each table is in: the catalog has a row for each
  // table of each version switched to, so the first and the last of them.
  const versionRows = await tx.query<{ table_id: string | null; lo: unknown; hi: unknown }>(
    `SELECT NULL AS table_id, sv AS lo, sv AS hi FROM schema_versions
     WHERE slot_id = $1 AND state IN ('current', 'retired')
     UNION ALL
     SELECT table_id, min(sv), max(sv) FROM catalog WHERE slot_id = $1 GROUP BY table_id`,
    [slot.slot],
  );
  const knownSv = new Set<number>();
  const tableVersions = new Map<string, { from: number; to: number }>();
  for (const x of versionRows.rows) {
    if (x.table_id === null) knownSv.add(Number(x.lo));
    else tableVersions.set(x.table_id, { from: Number(x.lo), to: Number(x.hi) });
  }
  const normalized = normalizeWrite({
    params: input.params,
    compiled: naming,
    inRange: visible.map((s) => ({ name: s.name, tables: s.tables.map((t) => t.name) })),
    currentSv: slot.sv,
    knownSv,
    tableVersions,
    changedSince,
    // By fallback, looked up above: a table changed as a whole since is refused in normalizing.
    ...(() => {
      const f = explicitSv === undefined ? svFallbacks.get(slot.slot) : undefined;
      return f !== undefined && "found" in f ? { fallbackSv: f.found } : {};
    })(),
  });
  if (!normalized.ok) throw requestFailure(normalized.error);
  const req = normalized.request;
  const task = req.task ?? input.task;
  const tableOf = (id: TableId) =>
    receiptNames.tables.find((t) => t.id === id && t.kind === "base") as CompiledBaseTable;
  // The restore count and point now, and the log's restores: a ver given under an earlier count
  // reads at the point (04-contract §15, `seenOfVer`).
  const current = await restorePoint(tx);
  const restore = current.restoreCount;
  const restores = await restoreHistory(tx);
  const warnings: ReceiptWarning[] = [...req.warnings];
  // Corroborations a value in effect covered (judge's `warnings`), turned into
  // `overwrote_corroborated` once the operation is in the log: the corroboration may be this
  // request's own.
  const covered: {
    readonly op: number;
    readonly table: TableId;
    readonly field: FieldId;
    readonly valid: IntervalSet;
    readonly corroboration: ItemRef;
  }[] = [];

  // Step 2: the request key in its window. With premises, the version each rests on is part of
  // it, a fallback's as resolved now (04-contract §14 «例外一»): a restatement sent again after its
  // premise changed is not the first one again.
  const premiseVers = await premiseVersForKey(
    tx,
    req.ops,
    (id) =>
      receiptNames.tables.find((t) => t.id === id && t.kind === "base") as
        | CompiledBaseTable
        | undefined,
    async (target, verTable) => {
      const f = await fallback(tx, input, task ?? null, { kind: "ver", target }, () =>
        verFromWrite(tx, verTable, target, actor, task ?? null),
      );
      // The ver as it was given: a read's own count, or the count at the caller's write.
      return "found" in f
        ? { ...f, restoreCount: f.restoreCount ?? restoreAt(restores, f.found).restoreCount }
        : undefined;
    },
    restore,
  );
  const rk = requestKeyOf(
    actor,
    task ?? null,
    premiseVers.length === 0 || req.requestKey.idempotencyKey !== undefined
      ? req.requestKey
      : { ...req.requestKey, content: canonicalize([req.requestKey.content, premiseVers]) },
  );
  // A request of writes by external key only has no request key of its own (04-write-and-read
  // «幂等»: the key makes it idempotent, the same contents again are `unchanged`); an explicit
  // idempotency key is used as ever.
  const byKeyOnly = req.ops.every((o) => o.target.kind === "external_key");
  const keyed = !byKeyOnly || req.requestKey.idempotencyKey !== undefined;
  const found = keyed ? await findWriteRequest(tx, rk, now, input.windows) : undefined;
  // The original write a pending deletion lists: not written again, nothing of it given back
  // (03-deletion «宽限期内重发»).
  if (found?.deletion !== undefined) return deletedReceipt(tx, found.op, found.deletion);
  const hit = found?.op;
  if (hit !== undefined) {
    const replay = await readReceipt(tx, hit, {
      compiled: receiptNames,
      slotName: slot.name,
      // As of the operation, not now (04-contract §14: a replay is the receipt as it was).
      restoreCount: restoreAt(restores, hit).restoreCount,
      replayed: true,
      visible: (id) => slot.tables.some((t) => t.id === id),
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

  // Step 2½, the sources the evidence names (04-contract §5.4): a request naming a source it may
  // not is refused before anything of its ops is judged. A replay returned above as it was.
  // The segments are numbered once the operation is: the request's, then each op's own, right
  // after it (09 §4.2); a `source_ref` is the source it names.
  // An op that leaves nothing (this time) stores no source of its own, its inline evidence
  // included (04-contract §5.4: "no source data is stored for it"); the request's evidence is
  // stored as ever (09 §5.6).
  const entering = (o: NormalizedOp) => nothing?.has(o.index) !== true;
  const evidence = await placeEvidence(
    tx,
    [
      ...req.evidence.map((segment, k) => ({ segment, param: `evidence/${k}` })),
      ...req.ops.filter(entering).flatMap((o) =>
        (o.evidence ?? []).map((segment, k) => ({
          segment,
          param: `ops/${o.index}/evidence/${k}`,
        })),
      ),
    ],
    { slot: slot.slot, visibleSlots: new Set(visible.map((s) => s.slot)) },
  );
  // `sv`: given, or from the caller's own latest write on the slot.
  let sv = req.sv;
  let svBasis: "explicit" | "fallback" = "explicit";
  if (sv === undefined) {
    // Looked up before normalizing, for the names; refused here, after what comes first.
    const f = await svFallback(slot);
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
      tableVersions,
      tables: slot.tables,
    });
    if (incompatible !== undefined) throw requestFailure(incompatible);
  }

  const op = (((await readTail(tx))?.seq ?? 0) + 1) as OpNumber;
  const evidenceSeqs = evidence.seqsFrom(op + 1);
  // Then an `api_call` for each op with no evidence at all (none of its own, none in the request).
  const requestSeqs = evidenceSeqs.slice(0, req.evidence.length);
  const ownSeqs = new Map<number, readonly Seq[]>();
  let placedAt = req.evidence.length;
  for (const o of req.ops) {
    const n = entering(o) ? (o.evidence?.length ?? 0) : 0;
    ownSeqs.set(o.index, evidenceSeqs.slice(placedAt, placedAt + n));
    placedAt += n;
  }
  const apiCallOps =
    req.evidence.length > 0
      ? []
      : req.ops.filter((o) => o.evidence === undefined && nothing?.has(o.index) !== true);
  // Keys this request added to rows, by row: the index learns them only once applied.
  const keysAddedHere = new Map<string, string>();
  // Writes by key: what each came to; those that left nothing (this time).
  const outcomes = new Map<number, KeyedOutcome>();
  const leftNothing = new Set<number>();
  // Temporary names (`as`, 04-contract «临时名 as»), as the ops declaring them bind them, in order:
  // the row or entity; none when that op was skipped. A later op's "@name" resolves here.
  const bound = new Map<
    string,
    {
      readonly index: number;
      readonly id?: string;
      readonly table?: TableId;
      readonly created?: boolean;
    }
  >();
  // The rows and entities this request creates, each with the op creating it and its temporary
  // name: a premise on one must find it in effect when the request ends (premise_target_pending).
  const createdIn = new Map<string, { readonly index: number; readonly as?: string }>();
  const apiCallSeq = new Map(
    apiCallOps.map((o, k) => [o.index, (op + 1 + evidence.fresh.length + k) as Seq]),
  );
  const nSources = evidence.fresh.length + apiCallOps.length;
  // The text each segment's values are checked against (`literal@1`, 04-write-and-read «来源级别»):
  // a new segment's text, a file reference's excerpt; for a `source_ref`, the source it names. An
  // api_call has none. Each segment is indexed once, when a field first needs it.
  const textOf = new Map<Seq, string | undefined>();
  const named: Seq[] = [];
  [...req.evidence, ...req.ops.filter(entering).flatMap((o) => o.evidence ?? [])].forEach(
    (g, k) => {
      const seq = evidenceSeqs[k] as Seq;
      if (g.kind === "source_ref") named.push(seq);
      else textOf.set(seq, g.kind === "file_ref" ? g.excerpt : g.text);
    },
  );
  for (const [seq, text] of await storedTexts(tx, named)) textOf.set(seq, text);
  const indexes = new Map<Seq, EvidenceIndex | undefined>();
  const literalDone = new Map<string, LiteralResult>();
  const indexOf = (seq: Seq): EvidenceIndex | undefined => {
    if (!indexes.has(seq)) {
      const text = textOf.get(seq);
      indexes.set(seq, text === undefined ? undefined : indexEvidence(text));
    }
    return indexes.get(seq);
  };
  let next = op + 1 + nSources;
  // An op's value sources: its own segments, and the request's it cites (all of them when it names
  // none and has none of its own); or its `api_call` source.
  // The segments an op sees, in the order `evidence_by_field` counts them: its own, then the
  // request's it cites.
  const seenBy = (o: NormalizedOp): readonly Seq[] => [
    ...(ownSeqs.get(o.index) ?? []),
    ...(o.evidenceRefs !== undefined
      ? o.evidenceRefs.map((k) => requestSeqs[k] as Seq)
      : o.evidence !== undefined
        ? []
        : requestSeqs),
  ];
  const sourcesOf = (o: NormalizedOp): Seq[] => {
    const api = apiCallSeq.get(o.index);
    if (api !== undefined) return [api];
    return [...new Set(seenBy(o))];
  };
  // The sources `evidence_by_field` maps a field (or the interval) to (04-contract §3).
  const mappedTo = (o: NormalizedOp, indices: readonly number[]): Seq[] => {
    const seen = seenBy(o);
    return [...new Set(indices.map((k) => seen[k] as Seq))];
  };

  const rows = new Map<string, RowWork>();
  // The rows pending deletions affect, read when an `undo` first asks.
  let pendingTargets: PendingTargets | undefined;
  /** The flagged items this request opens, their entries settled at its end (./flagged.ts). */
  const openedFlagged: OpenedFlagged[] = [];
  // The ref targets this request reads from the store (step 5), read once.
  const storedTargets: StoredTargets = new Map();
  const headBlocks: Record<string, JsonValue> = {};
  const opEvents: NewEvent[] = [];
  const noopNames = new Map<number, string[]>();
  // Entities this request created by key: by table and key, and each one's key.
  const createdByKey = new Map<string, EntityId>();
  const keyOfCreated = new Map<string, { table: TableId; key: KeyValues }>();
  const keysShown = new Map<number, EntityKeyText[]>();
  // The keys written like an entity's created by key, by op (`similar_keys`): first in its keys shown.
  const keysAlike = new Map<number, SimilarKey[]>();
  // The entities this request's ops wrote so far, the latest last, for `similar_keys`, and whether
  // each is revoked as its last op here left it: a value at no point (a revoke of the whole, revokes
  // over every stretch, an undo, or a write left a candidate on an entity with none). Read off its
  // state once an op changes it, not again at each comparison.
  const writtenHere = new Map<EntityId, { table: TableId; revoked: boolean }>();
  // What `similar_keys` reads of the store, once a request.
  const similarCache = createSimilarCache();

  /** The edges and clearing entries this request's ops recorded so far (the fan-in counts them). */
  const recordedHere: RecordedHere = { edges: [], clears: [] };

  /**
   * The depending row's own business time for a premise without one (02-integrity «状态类表上的目标
   * 不给业务时间时»), aligned to the target, with the contributions that gave it as `deps` when it
   * is not the op's own. A state row: the interval this op wrote, whatever became of it, the hull of
   * the interval each field it writes resolved to (a no-op's too: it writes that interval), or the
   * interval a restatement gives; `deps` the givers of the hull's ends where an end was resolved
   * from another contribution, and only of those ends. An event row: its time field as written,
   * else its value in effect after the op (`deps`: the origin items giving it). None (from now on):
   * a timeless row, an empty time field, a state row's restatement or clearing without an interval.
   */
  const depTime =
    (
      table: CompiledBaseTable,
      state: RowState,
      after: Limit,
      w: {
        readonly time?: unknown;
        /** Per field written (`any`: a restatement), its interval, the givers of its ends, where. */
        readonly spans?: readonly {
          readonly f: FieldId | "any";
          readonly valid: IntervalSet;
          readonly deps: readonly ItemRef[];
          readonly at: Limit;
        }[];
      },
    ) =>
    (t: CompiledBaseTable): ResolvedPremise["valid"] | undefined => {
      const ref = (d: ItemRef) =>
        d.target === "existence"
          ? { event: d.event, existence: d.k }
          : { event: d.event, field: d.target, k: d.k };
      const unique = (ds: readonly ItemRef[]) => [
        ...new Map(ds.map((d) => [`${d.event}/${d.target}/${d.k}`, d])).values(),
      ];
      let own: { at: BizPoint } | { during: { from: BizPoint; to: BizPoint | null } } | undefined;
      let deps: ItemRef[] = [];
      if (table.time.type === "state") {
        const spans = w.spans ?? [];
        const h = hull(spans.flatMap((x) => [...x.valid]));
        if (h !== undefined) {
          own = { during: h };
          // An end of the hull is a span's own end: its givers there, among the span's deps.
          for (const x of spans) {
            const mine = hull([...x.valid]);
            for (const p of [h.from, h.to]) {
              if (p === null || mine === undefined || (p !== mine.from && p !== mine.to)) continue;
              const givers = new Set(state.givers(p, x.f, x.at).map((g) => itemKey(g)));
              deps.push(...x.deps.filter((d) => givers.has(itemKey(d))));
            }
          }
          deps = unique(deps);
        }
      } else if (table.time.type === "event") {
        const written = pointOf(w.time);
        if (written !== undefined) own = { at: written };
        else {
          const tf = table.time.field as FieldId;
          const st = state.pieces().map((s) => state.fieldState(tf, s, after))[0];
          const at = st?.kind === "value" ? pointOf(st.value) : undefined;
          if (st?.kind === "value" && at !== undefined) {
            own = { at };
            deps = sourceItemsOf(state, st.by);
          }
        }
      }
      if (own === undefined) return undefined;
      const a = alignedTo(t, own, slot.timezone);
      return deps.length > 0 ? ({ ...a, deps: deps.map(ref) } as never) : a;
    };

  /**
   * An op's premises (step 5): checked, resolved and written into the head with the items they
   * cover beyond the op's own (09 §5.7). A clearing records only what it covers.
   */
  const declarePremises = async (
    o: NormalizedOp,
    state: RowState,
    c: {
      readonly seenAt: Limit;
      readonly after: Limit;
      readonly covers: boolean;
      /** The op's own items (of its `write.base`): its declarations cover them. */
      readonly own: readonly ItemRef[];
      readonly depValid:
        | ((t: CompiledBaseTable) => ResolvedPremise["valid"] | undefined)
        | undefined;
    },
  ) => {
    const premises = o.premises ?? [];
    const param = `ops/${o.index}`;
    const self =
      (headBlocks[`${param}/target`] as { row?: string; entity?: string } | undefined) ?? undefined;
    const selfId = self?.row ?? self?.entity ?? "";
    const clearing = premises.length === 0;
    const covered = c.covers || clearing ? coveredItems(state, c.seenAt, c.after) : [];
    const mine = [...c.own, ...covered].map(itemKey);
    const r = await resolvePremises(
      tx,
      premises,
      {
        op,
        index: o.index,
        tableOf: (id) =>
          receiptNames.tables.find((t) => t.id === id && t.kind === "base") as
            | CompiledBaseTable
            | undefined,
        self: selfId,
        slotName: slot.name,
        fanIn: (target) => fanInAfter(tx, op, target, recordedHere, { i: o.index, items: mine }),
        createdHere: (table, key) =>
          createdByKey.get(`${table} ${keyToken(tableOf(table), key as KeyValues)}`),
        named: (name) => {
          const n = bound.get(name);
          return n === undefined
            ? undefined
            : {
                ...(n.id !== undefined ? { id: n.id } : {}),
                table: n.table as TableId,
                created: n.created === true,
              };
        },
        restore,
        current,
        restores,
        zone: slot.timezone,
        now: now as Instant,
        today: today as DateStr,
        fallback: async (target, verTable, j) => {
          const f = await fallback(tx, input, task, { kind: "ver", target }, () =>
            verFromWrite(tx, verTable, target, actor, task),
          );
          if ("found" in f) return f;
          const t = tableOf((await rowTable(tx, target)) as TableId);
          const ref = {
            table: `${slot.name}.${t.name}`,
            ...(t.time.type === "state" ? { entity: target } : { row: target }),
          };
          return {
            refused: readFirst(f, { target: "row", ref }, task, `${param}/premises/${j}/ver`),
          };
        },
      },
      c.depValid ?? (() => undefined),
    );
    if ("code" in r) throw premiseFailure(r);
    // What apply will keep of them, for the fan-in of the ops after this one.
    r.resolved.forEach((p, j) => {
      const target = "row" in p.target ? p.target.row : p.target.entity;
      for (const item of mine) recordedHere.edges.push({ item, target, i: o.index, j });
    });
    if (clearing) for (const item of mine) recordedHere.clears.push({ item, i: o.index });
    for (const f of r.fallbacks) {
      warnings.push({
        code: "premise_ver_fallback",
        op: o.index,
        premise: f.premise,
        ver: `v${f.found}.${f.restoreCount ?? restore}`,
        ...(f.origin as FallbackOrigin),
      });
    }
    r.resolved.forEach((p, j) => {
      const { valid, target, ...rest } = p;
      // 09 §5.7: the target's row or entity beside its table.
      const decl = { ...target, ...rest };
      headBlocks[`${param}/premises/${j}`] = decl as unknown as JsonValue;
      if (valid !== undefined)
        headBlocks[`${param}/premise_valid/${j}`] = valid as unknown as JsonValue;
      if (p.state === "changed") {
        warnings.push({
          code: "premise_already_changed",
          op: o.index,
          premise: j,
          since: p.since as number,
        });
      }
    });
    if (clearing) headBlocks[`${param}/premises_cleared`] = true;
    if (covered.length > 0) {
      headBlocks[`${param}/premise_covers`] = covered.map((x) =>
        x.target === "existence"
          ? { event: x.event, existence: x.k }
          : { event: x.event, field: x.target, k: x.k },
      ) as unknown as JsonValue;
    }
  };

  for (const given of req.ops) {
    // Temporary names in its ref values: each the row an earlier op bound it to. One whose op was
    // skipped binds nothing: an op by key using it is skipped too (`ref_skipped`), any other names
    // no row (`ref_not_found`).
    const named = namesUsed(given, tableOf(given.table));
    // Normalizing took only names an earlier op declares: each has its entry by now.
    if (named.some((n) => !bound.has(n.name))) {
      throw new WriteError("internal", "a temporary name no earlier op declared", {
        reason: "inconsistent",
        param: `ops/${given.index}`,
      });
    }
    const unbound = named.find((n) => bound.get(n.name)?.id === undefined);
    if (unbound !== undefined) {
      const refOp = bound.get(unbound.name)?.index as number;
      if (given.target.kind === "external_key") {
        if (given.as !== undefined) bound.set(given.as, { index: given.index });
        outcomes.set(given.index, { outcome: "skipped", refOp });
        leftNothing.add(given.index);
        continue;
      }
      const t = tableOf(given.table);
      throw new WriteError("validation_failed", "a ref field's target is not there", {
        reason: "write",
        details: [
          {
            op: given.index,
            table: qualifiedTable(slot.name, t),
            field: t.fields.find((f) => f.id === unbound.field)?.name ?? unbound.field,
            code: "ref_not_found",
          },
        ],
      });
    }
    const o = named.length > 0 ? withNamesBound(given, named, bound) : given;
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
            reason: "entity",
            param: `${param}/entity_key`,
          });
        }
        // The keys before it: this request's earlier ones first, the latest first, then the stored;
        // those written alike first of all (04-contract-types `existing_keys`).
        const mine = [...keyOfCreated]
          .filter(([, x]) => x.table === table.id)
          .reverse()
          .map(([entity, x]) => ({ entity: entity as EntityId, key: x.key }));
        const alike = await similarKeys(
          tx,
          table,
          key,
          [...writtenHere]
            .filter(([, x]) => x.table === table.id)
            .reverse()
            .map(([entity, x]) => ({
              entity,
              ...(keyOfCreated.has(entity)
                ? { key: (keyOfCreated.get(entity) as { key: KeyValues }).key }
                : {}),
              revoked: x.revoked,
            })),
          similarCache,
        );
        if (alike.length > 0) keysAlike.set(o.index, alike);
        const first = alike.map((x) => x.key);
        const seen = new Set(first.map((k) => JSON.stringify(k)));
        const rest = [
          ...mine.map((x) => keyText(table, x.key)),
          ...(await existingKeys(tx, table, EXISTING_KEYS)),
        ].filter((k) => !seen.has(JSON.stringify(k)));
        keysShown.set(o.index, [...first, ...rest].slice(0, EXISTING_KEYS));
        byKey = input.newId("entity") as EntityId;
        createsByKey = true;
        createdByKey.set(token, byKey);
        keyOfCreated.set(byKey, { table: table.id, key });
      }
    }
    // By external key (04-write-and-read «写法与定位»): the table's key as defined now (a request
    // at an earlier version where the table had one is not located by it), the row its
    // key index entry names, or a new row. The same key twice in a request was refused.
    const external = o.target.kind === "external_key" ? o.target.key : undefined;
    let keyIds: readonly FieldId[] = [];
    let byExternalKey: RowId | undefined;
    let createsByExternalKey = false;
    if (external !== undefined) {
      const now_ = slot.tables.find((t) => t.id === table.id);
      const declared = now_?.kind === "base" ? (now_ as CompiledBaseTable).external_key : undefined;
      // Not reached from a request: normalizing reads the current definitions under the request's
      // names (`namedAt`) and refuses first; kept so that locating never reads an old key.
      if (declared === undefined) {
        throw new WriteError("invalid_argument", "the table has no external key", {
          reason: "no_external_key",
          param: `${param}/external_key`,
        });
      }
      keyIds = declared;
      const values = canonicalize(keyIds.map((f) => (external[f]?.value ?? null) as JsonValue));
      const held = await tx.query<{ holder_row: string; state: string }>(
        "SELECT holder_row, state FROM external_keys WHERE table_id = $1 AND key_values = $2",
        [table.id, values],
      );
      // A frozen entry (a deletion in its grace period) has no path to it in this version: the
      // deletion phase skips such an op (`pending_deletion`).
      if (held.rows[0] !== undefined && held.rows[0].state !== "present") {
        throw new WriteError("internal", "writing by a key a deletion freezes is not implemented", {
          reason: "not_implemented",
          param: `${param}/external_key`,
        });
      }
      const holder = held.rows[0]?.holder_row;
      if (holder !== undefined) byExternalKey = holder as RowId;
      else {
        byExternalKey = input.newId("row") as RowId;
        createsByExternalKey = true;
      }
    }
    const isNew = o.target.kind === "new" || createsByKey || createsByExternalKey;
    const id =
      byKey ??
      byExternalKey ??
      (o.target.kind === "new"
        ? input.newId(isState ? "entity" : "row")
        : o.target.kind === "row"
          ? o.target.row
          : (o.target as { entity: EntityId }).entity);
    // An `undo` of a row or entity a pending deletion affects (04-contract «宽限期内不能撤回受影响的行
    // 上的写入»): refused, the whole request with it; after the deletion runs or is cancelled, as usual.
    if (o.kind === "undo" && !isNew) {
      pendingTargets ??= await readPendingTargets(tx);
      const blocked = pendingTargets.on(table.id, id);
      if (blocked !== undefined) {
        throw new WriteError(
          "invalid_argument",
          PENDING_DELETION_TARGET,
          pendingDeletionTargetDetail(param, {
            table: `${slot.name}.${table.name}`,
            isState,
            row: id,
            blocked,
          }),
        );
      }
    }
    let work = rows.get(id);
    if (work === undefined) {
      const ctx: RowContext = {
        table: table.id,
        target: isState ? { entity: id as EntityId } : { row: id as RowId },
        shape,
        granularity,
        restores,
      };
      work = isNew
        ? { ctx, events: [], state: emptyState(shape), createdHere: false, items: [] }
        : await loadRow(tx, ctx, param);
      rows.set(id, work);
    }
    // A key added to a row (04-write-and-read «给没有来源键的行补键»): the row holds it already
    // (the same: nothing to add; another: `key_field_changed`), or the key's state decides — held by
    // no row: added; by a row not revoked: `external_key_in_use`; by a revoked row: a transfer, not
    // in this version. A revoke earlier in this request counts; so does a key this request added.
    // The key fields join the op's fields: to add the key, or (the row holding it already) to be
    // judged a no-op, the same value.
    let addsKey = false;
    if (o.externalKey !== undefined) {
      // The row first (04-write-and-read «给没有来源键的行补键»: "the row is unrevoked"): a revoked
      // row is `revoked`, whatever the key's state, as any update naming it.
      const at: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
      const revokedBy = work.state.revokedBy(at);
      if (revokedBy.length > 0) {
        throw new WriteError("revoked", "the row is revoked", {
          param,
          target: { table: qualifiedTable(slot.name, table), row: id },
          revoked_by: Math.max(...revokedBy),
        });
      }
      const added = o.externalKey;
      const declared = (table as { external_key?: readonly FieldId[] }).external_key ?? [];
      const values = canonicalize(declared.map((f) => (added[f]?.value ?? null) as JsonValue));
      const own =
        keysAddedHere.get(id) ??
        (
          await tx.query<{ key_values: string }>(
            "SELECT key_values FROM external_keys WHERE table_id = $1 AND holder_row = $2",
            [table.id, id],
          )
        ).rows[0]?.key_values;
      if (own !== undefined && own !== values) {
        throw new WriteError("invalid_argument", "a key field cannot change", {
          reason: "key_field_changed",
          param: `${param}/external_key`,
        });
      }
      if (own === undefined) {
        const entry = (
          await tx.query<{ holder_row: string; state: string }>(
            "SELECT holder_row, state FROM external_keys WHERE table_id = $1 AND key_values = $2",
            [table.id, values],
          )
        ).rows[0];
        // A frozen entry (a deletion in its grace period): `external_key_in_use` with the
        // deletions, the deletion phase's; no path to one yet.
        if (entry !== undefined && entry.state !== "present") {
          throw new WriteError("internal", "adding a key a deletion freezes is not implemented", {
            reason: "not_implemented",
            param: `${param}/external_key`,
          });
        }
        const holder = entry?.holder_row;
        if (holder !== undefined) {
          const before: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
          const here = rows.get(holder);
          const revoked =
            here !== undefined
              ? here.state.revoked(before)
              : (
                  await tx.query<{ revoked: boolean | null }>(
                    `SELECT revoked FROM "${table.physical.table}" WHERE row_id = $1`,
                    [holder],
                  )
                ).rows[0]?.revoked === true;
          if (revoked) {
            throw new WriteError("not_in_this_version", "transferring an external key", {
              reason: "parameter",
              param: `${param}/external_key`,
            });
          }
          throw new WriteError("invalid_argument", "the external key is held by another row", {
            reason: "external_key_in_use",
            param: `${param}/external_key`,
            holder,
          });
        }
        keysAddedHere.set(id, values);
      }
      addsKey = true;
    }
    // Hitting a revoked row (an earlier op of this request's revoke too): skipped, nothing judged,
    // recorded or kept (04-write-and-read «被撤销的行不复活»).
    if (external !== undefined && !createsByExternalKey) {
      const before: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
      // One revoke in effect on a row at a time (revoking a revoked row is refused); the latest,
      // were there more.
      const by = work.state.revokedBy(before);
      if (by.length > 0) {
        outcomes.set(o.index, {
          outcome: "skipped",
          row: id as RowId,
          revokedBy: Math.max(...by) as OpNumber,
        });
        leftNothing.add(o.index);
        if (o.as !== undefined) bound.set(o.as, { index: o.index });
        continue;
      }
    }
    // Its temporary name binds the row it creates or hits, from here on in the request.
    if (o.as !== undefined)
      bound.set(o.as, { index: o.index, id, table: table.id, created: isNew });
    if (isNew && !createdIn.has(id))
      createdIn.set(id, { index: o.index, ...(o.as !== undefined ? { as: o.as } : {}) });

    // The version the op saw.
    let seen: OpNumber;
    let seenExplicit = false;
    // `ver` was the row's current version (09 §5.2 `ver.current`): its op the row's latest before
    // this request and its restore count the current one. Judged here, once, and recorded.
    let seenCurrent = false;
    // A ver given under an earlier restore count, recorded as given (04-contract §15).
    let verToken: { op: number; restoreCount: number } | undefined;
    const latest = (versions: ReadonlySet<number>) => Math.max(-1, ...versions);
    if (isNew) seen = (op - 1) as OpNumber;
    else if (work.createdHere) seen = op;
    // A write by key hitting a row: no ver, no fallback; judge takes each field's baseline position
    // and the record its earliest (this is only a placeholder).
    else if (external !== undefined) seen = (op - 1) as OpNumber;
    else if (o.ver !== undefined) {
      const versions = await rowVersions(tx, verTable, id);
      const read = seenOfVer(o.ver, current);
      if (read === undefined || !verOfRow(o.ver, versions, read)) {
        throw new WriteError("invalid_argument", "the ver is not a version of this row or entity", {
          reason: "not_this_target",
          param: `${param}/ver`,
        });
      }
      seen = read.seen as OpNumber;
      seenExplicit = true;
      seenCurrent = o.ver.restoreCount === restore && o.ver.op === latest(versions);
      if (o.ver.restoreCount !== restore) verToken = o.ver;
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
      // The version as it was given then: a read's own count, or the count at the caller's write.
      const given = {
        op: f.found,
        restoreCount: f.restoreCount ?? restoreAt(restores, f.found).restoreCount,
      };
      const read = seenOfVer(given, current);
      // A read or a write of this log is never of a later restore than the log's own.
      if (read === undefined) {
        throw new WriteError("internal", "a fallback ver of a later restore", {
          reason: "inconsistent",
          param: `${param}/ver`,
        });
      }
      seen = read.seen as OpNumber;
      seenCurrent =
        given.restoreCount === restore && f.found === latest(await rowVersions(tx, verTable, id));
      if (given.restoreCount !== restore) verToken = given;
      warnings.push({
        code: "ver_fallback",
        op: o.index,
        ver: `v${given.op}.${given.restoreCount}`,
        ...f.origin,
      });
    }
    // What the op saw, as judging takes it (`seenOf`): with `ver` current, everything before it,
    // a corroboration that left the version as it was included. Its premises' covers are of this.
    const seenAt: Limit = {
      upTo: seenOf({ op, seen, ...(seenCurrent ? { seenCurrent: true as const } : {}) }),
      request: { op, below: o.index },
    };
    // Key fields: in a write by key the key joins `set`; given in `set`, a key field must be the
    // entity's key (05-time «按 entity_key 写入 · 键字段不可改»), by the same value tokens.
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
        const held = own[f.id];
        if (held === undefined || !sameValue(given.value, held)) {
          const at = o.named.find((n) => n.field === f.id && n.param.startsWith(`${param}/set/`));
          throw new WriteError("invalid_argument", "a key field cannot change", {
            reason: "key_field_changed",
            param: at?.param ?? `${param}/set`,
          });
        }
      }
      fields = merged;
    }
    // An external key (04-write-and-read «按来源键写入 · 键字段只能经 external_key 给出»): a key
    // field in the `set` of a write by row is the key the row holds, by the same value, or
    // `key_field_changed` (a row without a key included). The row's key: one an earlier op of this
    // request added (`keysAddedHere`; the index learns it only once applied), else its entry in
    // the key index.
    const externalKey = !isState && "external_key" in table ? table.external_key : undefined;
    if (o.kind === "write" && !isNew && externalKey !== undefined && o.fields !== undefined) {
      const named = externalKey.filter((f) => o.fields?.[f] !== undefined);
      if (named.length > 0) {
        const here = keysAddedHere.get(id);
        const stored =
          here ??
          (
            await tx.query<{ key_values: string }>(
              "SELECT key_values FROM external_keys WHERE table_id = $1 AND holder_row = $2",
              [table.id, id],
            )
          ).rows[0]?.key_values;
        const held = stored === undefined ? undefined : (JSON.parse(stored) as FieldValue[]);
        for (const f of named) {
          const v = held?.[externalKey.indexOf(f)];
          if (v === undefined || !sameValue((o.fields[f] as NormalizedField).value, v)) {
            const at = o.named.find((n) => n.field === f && n.param.startsWith(`${param}/set/`));
            throw new WriteError("invalid_argument", "a key field cannot change", {
              reason: "key_field_changed",
              param: at?.param ?? `${param}/set`,
            });
          }
        }
      }
    }

    // A key added (or held already): its fields join `set`, judged as any write — applied where the
    // row had no value, a no-op where it holds the same key.
    if (addsKey && o.externalKey !== undefined) fields = { ...(fields ?? {}), ...o.externalKey };
    // By external key: creating the row, the key's values are its key fields' (given by this
    // write); hitting one, the key fields are not judged (a key field given in `set` again was
    // checked equal above, against the key the row holds).
    if (external !== undefined) {
      fields = isNew
        ? { ...(fields ?? {}), ...Object.fromEntries(keyIds.map((f) => [f, external[f]])) }
        : Object.fromEntries(
            Object.entries(fields ?? {}).filter(([f]) => !keyIds.includes(f as FieldId)),
          );
    }

    // A restatement or a clearing (an update without `set`, 02-integrity «覆盖、取代与清除»): no
    // judgement, no write.base, the row's ver unchanged. Its row must be there (`revoked` as any
    // update's).
    if (o.kind === "write" && o.fields === undefined && o.premises !== undefined) {
      // By a key no entity holds: nothing to restate.
      if (isNew) {
        throw new WriteError("not_found", "no entity holds this key", {
          reason: "entity",
          param: `${param}/entity_key`,
        });
      }
      const at: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
      const gone = isState
        ? !work.state.pieces().some((s) => work.state.hasValue(s, at))
        : work.state.revoked(at);
      if (gone) {
        throw new WriteError("revoked", "the row is revoked", {
          param,
          target: { table: qualifiedTable(slot.name, table), [isState ? "entity" : "row"]: id },
        });
      }
      // The ver as given (an earlier restore count's recorded as such, 04-contract §15).
      const verBlock = {
        op: verToken?.op ?? seen,
        restore_count: verToken?.restoreCount ?? restore,
        basis: seenExplicit ? ("explicit" as const) : ("fallback" as const),
      };
      headBlocks[`${param}/target`] = {
        table: table.id,
        ...(isState ? { entity: id } : { row: id }),
        ...(o.target.kind === "entity_key" ? { by_entity_key: true } : {}),
        intent: "update",
        ver: verBlock,
      };
      // A restatement on a state table with an interval: that interval, its ends resolved as a
      // write's (a start left out is now; an end left out or `next_change`, the next change of
      // any field); without one (no `valid`), from now on.
      let spans: { f: "any"; valid: IntervalSet; deps: readonly ItemRef[]; at: Limit }[] = [];
      if (isState && o.valid !== undefined) {
        const nowPoint = (granularity === "date" ? today : now) as never;
        let res: ReturnType<typeof resolveInterval>;
        try {
          res = resolveInterval(work.state, o.valid, "any", seenAt, nowPoint);
        } catch (e) {
          if (e instanceof JudgeError)
            throw judgeFailure(e, { index: o.index, slot: slot.name, table, id });
          throw e;
        }
        if (res !== null) spans = [{ f: "any", valid: res.valid, deps: res.deps, at: seenAt }];
      }
      await declarePremises(o, work.state, {
        seenAt,
        after: at,
        covers: true,
        own: [],
        depValid: depTime(table, work.state, at, { spans }),
      });
      continue;
    }

    const intent =
      o.intent ?? (o.undo !== undefined ? undoneIntent(work.events, o.undo.target) : "update");
    const ack = o.acknowledge.includes("overwrite");
    const base = {
      op,
      index: o.index,
      event: next as Seq,
      ruleset: RULESET,
      policy: slot.policyVersion,
      seen,
      seenExplicit,
      ...(seenCurrent ? { seenCurrent: true as const } : {}),
    };
    const nowPoint = (granularity === "date" ? today : now) as never;
    // High impact ② (05-time «高影响写入»): a revoke of a row, or of a whole entity, still referred
    // to by other rows, as the store holds them with the ops before this one laid over.
    const referrers =
      o.kind === "revoke" && (!isState || o.valid === undefined)
        ? await referrersOf(tx, {
            tables: slot.tables,
            targetTable: table.id,
            target: id,
            known: knownRows(rows),
            at: { upTo: (op - 1) as OpNumber, request: { op, below: o.index } },
          })
        : [];
    const judgeInput: JudgeInput =
      o.kind === "write"
        ? {
            ...base,
            kind: "write",
            ...(o.valid !== undefined ? { valid: o.valid } : {}),
            now: nowPoint,
            // A field `evidence_by_field` points at is explicit: the same value again is a
            // corroboration, not a no-op (04-contract §3).
            fields: Object.fromEntries(
              Object.entries(fields ?? {}).map(([f, x]) => [
                f,
                {
                  value: x?.value ?? null,
                  ...(o.evidenceByField?.fields.has(f as FieldId) ? { explicit: true } : {}),
                },
              ]),
            ),
            ...(ack ? { acknowledge: true } : {}),
            ...(external !== undefined
              ? { sync: { keyFields: keyIds, ...(isNew ? { creates: true as const } : {}) } }
              : {}),
          }
        : o.kind === "revoke"
          ? {
              ...base,
              kind: "revoke",
              ...(o.valid !== undefined && o.valid !== "corrected_span" ? { valid: o.valid } : {}),
              now: nowPoint,
              ...(referrers.length > 0 ? { referenced: true } : {}),
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
      if (e instanceof JudgeError) {
        throw judgeFailure(e, { index: o.index, slot: slot.name, table: tableOf(o.table), id });
      }
      throw e;
    }
    const j = judged.judgement;
    // A write by key: what it came to (04-contract §5.4). Every field a no-op: `unchanged`, judged
    // and left: no state kept, no event, no source.
    if (external !== undefined && j.record.kind === "write") {
      const r = j.record;
      const outcome = isNew
        ? ("created" as const)
        : syncOutcome([
            ...r.items.map((x) => x.status),
            ...r.noop.filter((f) => !keyIds.includes(f)).map(() => "noop" as const),
          ]);
      outcomes.set(o.index, { outcome, row: id as RowId });
      if (outcome === "unchanged") {
        leftNothing.add(o.index);
        continue;
      }
    }
    // Step 5, the ref fields this op writes: their targets as of the ops before it.
    const refs = await refProblems(tx, {
      index: o.index,
      slot: slot.name,
      table,
      tableOf: (id) =>
        receiptNames.tables.find((t) => t.id === id && t.kind === "base") as
          | CompiledBaseTable
          | undefined,
      items: givenItems(j.record),
      known: (id) => {
        const w = rows.get(id);
        return w === undefined ? undefined : { table: w.ctx.table, state: w.state };
      },
      visible: tableInRange(visible),
      stored: storedTargets,
      at: { upTo: (op - 1) as OpNumber, request: { op, below: o.index } },
    });
    if (refs.length > 0) {
      throw new WriteError("validation_failed", "a ref field's target is not there", {
        reason: "write",
        details: refs,
      });
    }
    // An op that gives the entity no new version (every field a no-op or a corroboration, or every
    // change a candidate or awaiting: 04-contract §2 `ver`) does not make it the latest written: the
    // stored entities rank by their latest version, and this one keeps its place among them.
    const changed = isState && givesVersion(work.state, judged);
    work.state = judged.state;
    if (changed) {
      writtenHere.delete(id as EntityId);
      writtenHere.set(id as EntityId, {
        table: table.id,
        revoked: !valuedSomewhere(judged.state),
      });
    }
    for (const w of j.warnings) covered.push({ op: o.index, table: o.table, ...w });
    // Several segments and fields with no mapping: each of them rests on all the segments
    // (04-contract §3), a deletion of any one takes them.
    if (o.kind === "write" && seenBy(o).length > 1) {
      const given = new Set(("items" in j.record ? j.record.items : []).map((x) => x.target));
      const unmapped = table.fields.filter(
        (f) => given.has(f.id as FieldId) && !o.evidenceByField?.fields.has(f.id as FieldId),
      );
      if (unmapped.length > 0) {
        warnings.push({
          code: "multi_segment_unmapped",
          op: o.index,
          fields: unmapped.map((f) => f.name),
        });
      }
    }
    // Conflicts join the open item of the same unit whose interval meets theirs, the earliest of
    // several (01-objects «目标与合并»); one meeting none opens an item.
    // The version a candidate carried: its write's seen; a write by key's, the earliest baseline
    // position over the unit's fields (09 §5.8 `merge_base_op`, from `ops/<i>/baseline`).
    const carried = (unit: (typeof j.conflicts)[number]["unit"]): OpNumber => {
      const b = j.record.kind === "write" ? j.record.baseline : undefined;
      if (b === undefined || unit === "existence") return seen;
      const at = unit.fields.flatMap((f) => (b[f] === undefined ? [] : [b[f] as number]));
      return (at.length > 0 ? Math.min(...at) : (j.record as { seen: number }).seen) as OpNumber;
    };
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
        prior.cands[candidate] = next as Seq;
        prior.mergeBase = Math.min(prior.mergeBase, carried(c.unit)) as OpNumber;
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
        cands: [next as Seq],
        mergeBase: carried(c.unit),
        refs: [...c.items],
        origin: next as Seq,
        versionOp: op,
        here: true,
        mergedHere: false,
        stored: {},
        reverted: [],
        fills: [],
      });
      return { item, candidate: 0, mergeBase: carried(c.unit) };
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
        cands: [],
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
        // A revoke awaiting for ② (the only way a revoke awaits): who refers to its target.
        ...(j.record.kind === "revoke" ? { referrers } : {}),
        fills: [],
      });
    }
    const raw = rawOf(fields);
    const enc = encodeOp(work.ctx, judgeInput, j, {
      intent: intent as "insert" | "update" | "correct" | "revoke",
      ...(o.target.kind === "entity_key" ? { byEntityKey: true as const } : {}),
      ...(j.created ? { created: true as const } : {}),
      raw,
      literal: literalOf(table, raw, indexOf, literalDone),
      restoreCount: restore,
      ...(verToken !== undefined ? { verToken } : {}),
      sv,
      sources: sourcesOf(o),
      ...(o.evidenceByField !== undefined
        ? {
            fieldSources: Object.fromEntries(
              [...o.evidenceByField.fields].map(([f, ks]) => [f, mappedTo(o, ks)]),
            ),
            // The fields pointed at, in the table's order (09 §5.2 `ops/<i>/explicit`).
            explicit: table.fields
              .map((f) => f.id as FieldId)
              .filter((f) => o.evidenceByField?.fields.has(f)),
          }
        : {}),
      // The interval's sources (`valid_sources`, 09 §5.7), on every write or revoke given an
      // interval (a state table's; `corrected_span` is not given by the caller): the evidence
      // `evidence_by_field` maps its `valid` key to, otherwise all the op's evidence (or its
      // api_call), so that the interval can be traced to the words it came from when they are
      // deleted (`base_sources` has a row for each, 02-architecture §8).
      ...(() => {
        const validSources =
          o.evidenceByField?.valid !== undefined
            ? mappedTo(o, o.evidenceByField.valid)
            : (o.kind === "revoke" || o.kind === "write") &&
                o.valid !== undefined &&
                o.valid !== "corrected_span"
              ? sourcesOf(o)
              : undefined;
        // The operation's sources (09 §5.7 `op_sources`): an undo writes back no value of its
        // own, so the request's evidence (or its api_call) is all of it; a revoke has no value
        // either, and its evidence not taken as the interval's source is (all of it for a revoke
        // of the whole row or entity), so that every segment of it is pointed at and «why it was
        // revoked» reads back (03-deletion «来源»: control, not data).
        const interval = new Set(validSources ?? []);
        const opSources =
          o.kind === "undo"
            ? sourcesOf(o)
            : o.kind === "revoke"
              ? sourcesOf(o).filter((x) => !interval.has(x))
              : [];
        return {
          ...(validSources !== undefined ? { validSources } : {}),
          ...(opSources.length > 0 ? { opSources } : {}),
        };
      })(),
      conflictItems,
      ...(awaitingItem !== undefined ? { awaitingItem } : {}),
      versions: { ruleset: RULESET, policy: slot.policyVersion },
    });
    Object.assign(headBlocks, enc.head);
    // The temporary name it declares (09 §5.2 `ops/<i>/refs`): the caller's text, data, deleted
    // with the op's evidence (03-deletion); the IDs it resolved to are in the ref values.
    if (o.as !== undefined) headBlocks[`ops/${o.index}/refs`] = { as: o.as };
    const ownBase = enc.base !== undefined ? (next as Seq) : undefined;
    // Duplicate keys (04-write-and-read «疑似重复»; ./duplicates.ts): a row this op created and
    // that is in effect is compared once. Created, not inserted: what the judgement says
    // (`j.created`), so a row created by key (an update or a correction) is compared too.
    const duplicate =
      enc.base !== undefined && createdInEffect(j)
        ? await duplicateOf(tx, {
            table,
            self: id as RowId,
            state: work.state,
            requestRows: [...rows.values()].flatMap((w) =>
              w !== work && w.ctx.table === table.id && "row" in w.ctx.target
                ? [{ row: w.ctx.target.row, state: w.state }]
                : [],
            ),
            op,
            index: o.index,
          })
        : undefined;
    if (enc.base !== undefined) {
      const baseSeq = next as Seq;
      const base =
        duplicate === undefined ? enc.base : { ...enc.base, duplicate: duplicateBlock(duplicate) };
      opEvents.push({ type: "write.base", slot: slot.slot, blocks: base as never });
      next++;
      work.lastBase = baseSeq;
      if (work.bases === undefined) work.bases = [];
      work.bases.push({ index: o.index, seq: baseSeq });
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
      // The row's flagged item (09 §5.8): not one of `work.items`, which are settled at the
      // request's end as conflicts and proposals are.
      if (duplicate !== undefined && unflagged?.has(o.index) !== true) {
        const item = input.newId("item") as ItemId;
        const blocks = flaggedItem(duplicate, {
          item,
          table: table.id,
          row: id as RowId,
          origin: baseSeq,
          ruleset: RULESET,
          policy: slot.policyVersion,
        });
        opEvents.push({ type: "item.created", slot: slot.slot, blocks: blocks as never });
        next++;
        // Its entries are the request's end state (09 §5.8): judged again at the end.
        openedFlagged.push({
          index: o.index,
          item,
          table: table.id,
          row: id as RowId,
          keys: duplicate.keys,
          listed: duplicate.matched,
          blocks,
        });
      }
      // The open items it reaches, settled at the end of the request.
      for (const t of work.items) {
        // Op by op: what this op changed, from just before it to just after it.
        const before: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index } };
        const after: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index + 1 } };
        if (!t.here && reaches(work.state, before, after, t.unit, reachScope(work.state, t))) {
          t.reachedBy = baseSeq;
        }
      }
    }
    if (isNew && (enc.base !== undefined || j.created)) work.createdHere = true;
    if (o.premises !== undefined && o.kind === "write") {
      const items = "items" in j.record ? j.record.items : [];
      const after: Limit = { upTo: (op - 1) as OpNumber, request: { op, below: o.index + 1 } };
      // Each field written: its items' intervals; a no-op's (no item) as judging resolved it, at
      // the version seen.
      const spans = isState
        ? [
            ...items.map((x) => ({
              f: x.target === "existence" ? ("any" as const) : x.target,
              valid: x.valid,
              deps: x.deps,
              at: after,
            })),
            ...("noop" in j.record ? j.record.noop : []).flatMap((f) => {
              const res = resolveInterval(judged.state, o.valid, f, seenAt, nowPoint);
              return res === null ? [] : [{ f, valid: res.valid, deps: res.deps, at: seenAt }];
            }),
          ]
        : [];
      await declarePremises(o, judged.state, {
        seenAt,
        after,
        covers: tookEffect(j),
        own:
          ownBase === undefined
            ? []
            : items.map((x) => ({ event: ownBase, target: x.target, k: x.k })),
        depValid: depTime(table, judged.state, after, {
          time: fields?.[(table.time as { field?: FieldId }).field as FieldId]?.value,
          spans,
        }),
      });
    }
    if (j.record.kind === "write") {
      noopNames.set(
        o.index,
        j.record.noop.map((f) => table.fields.find((x) => x.id === f)?.name ?? f),
      );
    }
  }

  // Writes by key that left nothing (09 §4.2): their receipt entries, as judged now (not in the
  // log). Every op left nothing: no event at all, the receipt from them. Some did, the first time:
  // judged again without them, numbered so; the second time must find the same ones.
  // Read once the request's events are in: an `unchanged` op's row may have been changed by an
  // ordinary op of this request before it, and its receipt gives the version at the request's end.
  const unrecordedOps = async () => {
    const out = new Map<number, OpReceipt>();
    for (const i of [...leftNothing].sort((a, b) => a - b)) {
      const o = req.ops[i] as NormalizedOp;
      const x = outcomes.get(i) as KeyedOutcome;
      out.set(i, await unrecordedOp(tx, tableOf(o.table), slot.name, o, x, restore));
    }
    return out;
  };
  if (leftNothing.size === req.ops.length) {
    // No op changed anything: the versions now are the request's end.
    return nothingReceipt(req, sv, [...(await unrecordedOps()).values()], warnings);
  }
  if (nothing === undefined && leftNothing.size > 0)
    return writeIn(tx, input, leftNothing, unflagged);
  if (
    nothing !== undefined &&
    (nothing.size !== leftNothing.size || [...nothing].some((i) => !leftNothing.has(i)))
  ) {
    throw new WriteError("internal", "writes by key judged otherwise the second time", {
      reason: "inconsistent",
    });
  }

  // A premise on a row this request creates (`same_request`): that creation must be in effect when
  // the request ends; one awaiting confirmation or a candidate refuses the declaring op (08 «as 与
  // 临时名»): send the creation alone first, then declare or restate.
  // Not reached in this version: an insert and a creation by key always take effect (nothing to
  // overwrite, no version to be stale against); kept for the high impact a slot's policy will add.
  for (const [path, b] of Object.entries(headBlocks)) {
    const m = /^ops\/(\d+)\/premises\/(\d+)$/.exec(path);
    if (m === null) continue;
    const d = b as { row?: string; entity?: string; ver?: { basis?: string } };
    if (d.ver?.basis !== "same_request") continue;
    const target = (d.row ?? d.entity) as string;
    const state = rows.get(target)?.state;
    if (state?.items.some((x) => x.status === "applied") === true) continue;
    const made = createdIn.get(target);
    throw new WriteError("invalid_argument", "the premise's row is not in effect", {
      reason: "premise_target_pending",
      param: path,
      ...(made !== undefined
        ? { op: made.index, ...(made.as !== undefined ? { as: made.as } : {}) }
        : {}),
    });
  }
  await refreshReferenced(tx, rows, { tables: slot.tables, restores, op });

  next += await settleItems(tx, rows.values(), {
    op,
    slot: slot.slot,
    writer: input,
    task,
    restore,
    events: opEvents,
  });
  // Flagged items whose rows the request wrote: judged again as it leaves them (./flagged.ts).
  const flagged = await settleFlagged(tx, {
    slot: slot.slot,
    tableOf: (id) => tableOf(id as TableId),
    written: [...rows.values()].flatMap((w) =>
      w.lastBase !== undefined && "row" in w.ctx.target
        ? [
            {
              table: w.ctx.table,
              row: w.ctx.target.row,
              state: w.state,
              lastBase: w.lastBase,
              bases: w.bases ?? [],
            },
          ]
        : [],
    ),
    op,
    opCount: req.ops.length,
    boundary: (i) => ({ upTo: (op - 1) as OpNumber, request: { op, below: i } }),
    opened: openedFlagged,
  });
  // A flagged item opened with no row matching by the request's end is not opened (09 §5.8: its
  // entries are the request's end state, and it lists at least one row): the request judged again
  // without it, numbered so. The second time must open the rest as they are.
  if (flagged.unopened.length > 0) {
    if (unflagged !== undefined) {
      throw new WriteError("internal", "flagged items judged otherwise the second time", {
        reason: "inconsistent",
      });
    }
    return writeIn(tx, input, nothing, new Set(flagged.unopened));
  }
  const flaggedEvents = flagged.events;
  opEvents.push(...flaggedEvents);
  next += flaggedEvents.length;

  // Sources: the request's evidence, or each op's request as an `api_call` (04-write-and-read
  // «不变量：每次写入都有源数据»), without the values of its no-op fields.
  const rawOps = (input.params as { ops: JsonValue[] }).ops;
  const sources: NewEvent[] = [
    ...evidence.fresh.map((ev) => evidenceSource(ev, slot.slot, input.newId("source"))),
    ...apiCallOps.map((o): NewEvent => {
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
    }),
  ];

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
      ...(keyed ? rk.block : {}),
      ...headBlocks,
    },
  };
  // Appended and applied; the derived tables its base changes reach refreshed in the same
  // transaction (K5).
  let step: Awaited<ReturnType<typeof appendWithDerived>>;
  try {
    step = await appendWithDerived(tx, {
      actor,
      now,
      events: [head, ...sources, ...opEvents],
      schema: slot.compiled,
      newPartitionId: () => input.newId("partition") as PartitionId,
    });
  } catch (e) {
    // The events do not fit the state they are applied to: an internal error, without their content.
    if (e instanceof ApplyError) {
      throw new WriteError("internal", "the write could not be applied", internalDetailOf(e));
    }
    throw e;
  }
  const prepared = step.prepared;
  if (prepared.op !== op || prepared.events.at(-1)?.seq !== next - 1) {
    throw new WriteError("internal", "the operation's numbers are not as planned");
  }
  const receipt = withDerived(
    (await readReceipt(tx, op, {
      compiled: receiptNames,
      slotName: slot.name,
      restoreCount: restore,
      replayed: false,
      visible: (id) => slot.tables.some((t) => t.id === id),
      unrecorded: await unrecordedOps(),
    })) as WriteReceipt,
    step.derived,
    receiptNames,
    slot.name,
  );
  const ops = receipt.ops.map((r, i) => {
    const keys = keysShown.get(i);
    const alike = keysAlike.get(i);
    return keys !== undefined && r.created_entity
      ? { ...r, existing_keys: keys, ...(alike !== undefined ? { similar_keys: alike } : {}) }
      : r;
  });
  const out = keysShown.size > 0 ? { ...receipt, ops } : receipt;
  for (const c of covered) {
    const t = tableOf(c.table);
    const byDate = t.time.type === "state" && t.time.granularity === "date";
    const name = t.fields.find((x) => x.id === c.field)?.name;
    if (name === undefined) continue;
    const sources = await sourceIdsOf(tx, c.corroboration);
    for (const v of c.valid) {
      warnings.push({
        code: "overwrote_corroborated",
        op: c.op,
        field: name,
        valid: intervalOut(v, byDate),
        sources,
      });
    }
  }
  // Request-level evidence no op cites (an op naming none cites every segment): stored as sources
  // all the same, the source of no value (04-contract §3 «证据»).
  // Cited by an op that entered an event: one cited only by ops that left nothing is unreferenced.
  const cited = new Set(
    req.ops
      .filter(entering)
      .flatMap(
        (o) => o.evidenceRefs ?? (o.evidence !== undefined ? [] : req.evidence.map((_, k) => k)),
      ),
  );
  const uncited = req.evidence.map((_, k) => k).filter((k) => !cited.has(k));
  if (uncited.length > 0) warnings.push({ code: "evidence_unreferenced", evidence: uncited });
  // The inline evidence of the ops that left nothing: not stored, and said so (04-contract: no source data for an op that left nothing).
  const notStored = inlineNotStored(req, leftNothing);
  if (notStored.length > 0) {
    warnings.push({ code: "evidence_not_stored", evidence: [], op_evidence: notStored });
  }
  const skipped = [...outcomes].filter(([, x]) => x.outcome === "skipped").map(([i]) => i);
  if (skipped.length > 0)
    warnings.push({ code: "external_key_skipped", ops: skipped.sort((a, b) => a - b) });
  // The recorded time was held at the log's end (02-architecture §7 «记录时刻»): the entry's clock
  // is behind it. Whole seconds, rounded up, so that a clock behind at all never reads 0.
  if (prepared.at !== now) {
    warnings.push({
      code: "clock_behind_log",
      behind_seconds: Math.ceil((Date.parse(prepared.at) - Date.parse(now)) / 1000),
    });
  }
  return warnings.length > 0 ? { ...out, warnings } : out;
}

/**
 * A write by key that entered no event, as its receipt gives it (04-contract-types §5.1
 * `OpResult`): its row and key, its outcome; `unchanged`: the row's version (nothing changed it);
 * `skipped`: why (`revoked`) and by what. No `fields`: nothing of it was judged into the log.
 */
async function unrecordedOp(
  tx: Tx,
  table: CompiledBaseTable,
  slotName: string,
  o: NormalizedOp,
  x: KeyedOutcome,
  restore: number,
): Promise<OpReceipt> {
  // Skipped for a temporary name before it was located: the key as the request gives it, and the
  // row holding it, if any.
  const row =
    x.row ??
    (o.target.kind === "external_key"
      ? ((await keyHolder(tx, table, o.target.key)) as RowId | undefined)
      : undefined);
  const key =
    row !== undefined
      ? await externalKeyOf(tx, table, row)
      : o.target.kind === "external_key"
        ? keyAsGiven(table, o.target.key)
        : undefined;
  let ver: string | undefined;
  if (x.outcome === "unchanged" && row !== undefined) {
    const versions = await rowVersions(tx, `${table.physical.table}__ver`, row);
    ver = `v${Math.max(...versions)}.${restore}`;
  }
  return {
    target: {
      table: qualifiedTable(slotName, table),
      ...(row !== undefined ? { row } : {}),
      ...(key !== undefined ? { external_key: key } : {}),
    },
    ...(o.as !== undefined ? { as: o.as } : {}),
    intent: o.intent ?? "update",
    ...(ver !== undefined ? { ver } : {}),
    outcome: x.outcome,
    ...(x.outcome === "skipped"
      ? x.refOp !== undefined
        ? { skip_reason: "ref_skipped" as const, ref_op: x.refOp }
        : { skip_reason: "revoked" as const, revoked_by: x.revokedBy as OpNumber }
      : {}),
    // No `fields`: nothing of it was judged into the log. The kernel's OpReceipt has them always
    // (the type compromise until receipts become a strict union); the contract check in
    // write-by-external-key.test.ts holds the JSON to the contract.
  } as OpReceipt;
}

/**
 * The receipt of a request none of whose ops entered an event (09 §4.2: every one a write by key,
 * `unchanged` or `skipped`): nothing appended, no operation number, so no `seq`; the evidence the
 * caller gave not stored either (`evidence_not_stored`).
 */
function nothingReceipt(
  req: NormalizedWrite,
  sv: number,
  ops: readonly OpReceipt[],
  warnings: readonly ReceiptWarning[],
): WriteReceipt {
  const skipped = ops.flatMap((x, i) => (x.outcome === "skipped" ? [i] : []));
  const all: ReceiptWarning[] = [
    ...warnings,
    ...(skipped.length > 0 ? [{ code: "external_key_skipped" as const, ops: skipped }] : []),
    ...(() => {
      // Nothing stored at all (04-contract §5.4): the request's segments and every op's own.
      const inline = inlineNotStored(req, new Set(req.ops.map((o) => o.index)));
      return req.evidence.length > 0 || inline.length > 0
        ? [
            {
              code: "evidence_not_stored" as const,
              evidence: req.evidence.map((_, k) => k),
              ...(inline.length > 0 ? { op_evidence: inline } : {}),
            },
          ]
        : [];
    })(),
  ];
  return {
    status: "saved",
    sv,
    ops,
    derived: [],
    derived_total: 0,
    pending: [],
    superseded: [],
    external_key_summary: keySummary(ops, false),
    ...(all.length > 0 ? { warnings: all } : {}),
  } as unknown as WriteReceipt;
}

/** The inline evidence segments of the ops in `ops`, by op: indices into each op's `evidence`. */
function inlineNotStored(
  req: NormalizedWrite,
  ops: ReadonlySet<number>,
): { op: number; evidence: number[] }[] {
  return req.ops
    .filter((o) => ops.has(o.index) && (o.evidence?.length ?? 0) > 0)
    .map((o) => ({ op: o.index, evidence: (o.evidence ?? []).map((_, k) => k) }));
}
