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
// Stopped as not implemented, with nothing written: a write to a table some kept derived rule reads
// (the refresh comes with `derive`), and a target by `entity_key`. Pending items get their
// candidates, merge base and version here; their entries, and the open items a write refreshes or
// supersedes, are added at `pendingEffects` (01-objects «不过期：合并、取代与刷新»).

import { createHash } from "node:crypto";
import {
  type CompiledBaseTable,
  canonicalize,
  type EntityId,
  type FieldId,
  type ItemId,
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
  emptyState,
  JudgeError,
  type JudgeInput,
  type Judgement,
  judgeOp,
  type RowState,
  stateFromRecord,
  type TableShape,
  type Unit,
} from "../judge/index.ts";
import { appendOperation, type NewEvent, readTail } from "../log/index.ts";
import {
  checkSvCompatibility,
  type NormalizedOp,
  normalizeWrite,
  type RequestError,
  resolveWriteSlot,
  type WriteWarning,
} from "../request/index.ts";
import type { Tx } from "../store/ports.ts";
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

/**
 * What `pending` adds to a judged op: the entries of the items it opens or joins, and the open
 * items on the row it refreshes or supersedes (01-objects «不过期：合并、取代与刷新»). Not
 * implemented yet: no entries, nothing refreshed or superseded.
 */
export function pendingEffects(
  _state: RowState,
  _judgement: Judgement,
): { readonly refreshed: readonly ItemId[]; readonly superseded: readonly ItemId[] } {
  return { refreshed: [], superseded: [] };
}

const unitKey = (u: Unit) => (u === "existence" ? "existence" : [...u.fields].sort().join(","));

interface OpenItem {
  readonly item: ItemId;
  candidates: number;
  mergeBase: OpNumber;
}

interface RowWork {
  readonly ctx: RowContext;
  readonly events: readonly StoredEvent[];
  state: RowState;
  /** Created by an earlier op of this request. */
  createdHere: boolean;
  /** Open conflict items on the row, by conflict unit. */
  readonly open: Map<string, OpenItem>;
}

/** The open conflict items of a row from its item events, by unit. */
function openConflictItems(events: readonly StoredEvent[], resolved: Set<string>) {
  const open = new Map<string, OpenItem>();
  const unitOf = new Map<string, string>();
  for (const e of events) {
    const t = e.blocks["target"] as
      | { item: ItemId; type?: string; unit?: string[]; merge_base_op?: number }
      | undefined;
    if (e.header.type === "item.resolved" && t !== undefined) resolved.add(t.item);
    if (e.header.type !== "item.created" && e.header.type !== "item.merged") continue;
    if (t === undefined) continue;
    if (e.header.type === "item.created") {
      if (t.type !== "conflict") continue;
      unitOf.set(t.item, [...(t.unit ?? [])].sort().join(","));
    }
    const key = unitOf.get(t.item);
    if (key === undefined) continue;
    const n = Object.keys(e.blocks).filter((p) => p.startsWith("candidates/")).length;
    const prior = open.get(key);
    open.set(key, {
      item: t.item,
      candidates: (prior?.item === t.item ? prior.candidates : 0) + n,
      mergeBase: (t.merge_base_op ?? prior?.mergeBase ?? 0) as OpNumber,
    });
  }
  for (const [k, v] of open) if (resolved.has(v.item)) open.delete(k);
  return open;
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
function rawOf(o: NormalizedOp): Partial<Record<FieldId, RawFieldValue>> {
  return Object.fromEntries(
    Object.entries(o.fields ?? {}).map(([f, x]) => [f, (x?.raw ?? null) as RawFieldValue]),
  );
}

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

  for (const o of req.ops) {
    const table = tableOf(o.table);
    const shape: TableShape = tableShape(table);
    const isState = shape.kind === "state";
    const granularity = isState && table.time.type === "state" ? table.time.granularity : "date";
    const param = `ops/${o.index}`;
    const verTable = `${table.physical.table}__ver`;

    // The row or entity.
    if (o.target.kind === "entity_key") {
      throw new WriteError("internal", "writing by entity_key is not implemented", {
        reason: "not_implemented",
        param: `${param}/entity_key`,
      });
    }
    if ((o.target.kind === "row" && isState) || (o.target.kind === "entity" && !isState)) {
      throw new WriteError("invalid_argument", "row on a state table, or entity on another", {
        reason: "target_kind",
        param,
      });
    }
    const isNew = o.target.kind === "new";
    const id = isNew
      ? input.newId(isState ? "entity" : "row")
      : o.target.kind === "row"
        ? o.target.row
        : o.target.entity;
    let work = rows.get(id);
    if (work === undefined) {
      const ctx: RowContext = {
        table: table.id,
        target: isState ? { entity: id as EntityId } : { row: id as RowId },
        shape,
        granularity,
      };
      if (isNew) {
        work = { ctx, events: [], state: emptyState(shape), createdHere: false, open: new Map() };
      } else {
        if ((await rowTable(tx, id)) !== table.id) {
          throw new WriteError("not_found", "no such row or entity", { param });
        }
        const events = await rowEvents(tx, table.id, id);
        const state = stateFromRecord(shape, decodeRecords(ctx, events));
        work = {
          ctx,
          events,
          state,
          createdHere: false,
          open: openConflictItems(events, new Set()),
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
              Object.entries(o.fields ?? {}).map(([f, x]) => [f, { value: x?.value ?? null }]),
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
    // The entries of the items, and the open items this write refreshes or supersedes.
    pendingEffects(judged.state, j);

    const conflictItems = j.conflicts.map((c) => {
      const k = unitKey(c.unit);
      const prior = work.open.get(k);
      if (prior !== undefined) {
        const candidate = prior.candidates;
        prior.candidates++;
        prior.mergeBase = Math.min(prior.mergeBase, seen) as OpNumber;
        return { item: prior.item, merged: true as const, candidate, mergeBase: prior.mergeBase };
      }
      const item = input.newId("item") as ItemId;
      work.open.set(k, { item, candidates: 1, mergeBase: seen });
      return { item, candidate: 0, mergeBase: seen };
    });
    const recorded = "items" in j.record ? j.record.items : [];
    const awaitingItem = recorded.some((x) => x.status === "awaiting")
      ? (input.newId("item") as ItemId)
      : undefined;
    const enc = encodeOp(work.ctx, judgeInput, j, {
      intent: intent as "insert" | "update" | "correct" | "revoke",
      ...(j.created ? { created: true as const } : {}),
      raw: rawOf(o),
      restoreCount: restore,
      sv,
      sources: sourcesOf(o),
      conflictItems,
      ...(awaitingItem !== undefined ? { awaitingItem } : {}),
      versions: { ruleset: RULESET, policy: slot.policyVersion },
    });
    Object.assign(headBlocks, enc.head);
    if (enc.base !== undefined) {
      opEvents.push({ type: "write.base", slot: slot.slot, blocks: enc.base as never });
      next++;
      for (const it of enc.items) {
        opEvents.push({ type: it.type, slot: slot.slot, blocks: it.blocks as never });
        next++;
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
          if (set !== undefined && noop.length > 0) {
            request["set"] = Object.fromEntries(
              Object.entries(set).filter(([n]) => !noop.includes(n)),
            );
            request["noop"] = noop;
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
  return warnings.length > 0 ? { ...receipt, warnings } : receipt;
}
