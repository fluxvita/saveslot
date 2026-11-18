// Resolving a pending item (docs/zh-CN/spec/04-contract.md `resolve`, §6; 01-objects «待处理事项»;
// 09-event-format §5.8 `item.resolved`), in the caller's transaction:
//   1. the request checked and normalized;
//   2. the request key looked up in its window: a hit returns the original result;
//   3. the item: none (or not visible) → `not_found`; resolved the same way → the original result
//      (`replayed`), resolved another way or superseded → `item_closed`;
//   4. the decision fits the item's type;
//   5. the item version brought back (or taken by fallback) is the item's current one, else
//      `confirmation_mismatch`;
//   6. `take_candidate` on an item with several candidates names one (`candidate_required`);
//   7. the decision judged on the row's state; the events (`item.resolved`, its sources, the write
//      it triggers) appended, with the other items on the row that write reaches settled as a write
//      settles them (01-objects «不过期»), and applied;
//   8. the result, read back from the log.
//
// This version: a conflict item's `keep_effective`, `take_candidate`, `take_previous`; an awaiting
// item's `confirm`, `reject`. Decisions of later phases are refused when normalizing.

import type {
  CompiledBaseTable,
  EntityId,
  ItemId,
  JsonValue,
  OpNumber,
  PartitionId,
  RowId,
  Seq,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { ApplyError, confirmationHash, entryChecksums } from "../apply/index.ts";
import { lastRead, type ReadId } from "../audit/index.ts";
import type { DerivedWrite } from "../derive/index.ts";
import { JudgeError, type JudgeInput, judgeOp, reaches, type Unit } from "../judge/index.ts";
import { type ActorAsOf as Actor, actorsAsOf, type NewEvent, readTail } from "../log/index.ts";
import { actorsNow, closingOf, itemEntries, revertedOut } from "../pending/index.ts";
import { normalizeResolve, type ResolveDecision } from "../request/index.ts";
import type { ReadTx, Tx } from "../store/ports.ts";
import { appendWithDerived } from "./derive-step.ts";
import { WriteError } from "./errors.ts";
import {
  judgeFailure,
  loadRow,
  RULESET,
  reachScope,
  readFirst,
  requestFailure,
  revertEntriesNow,
  settleItems,
  type WriteInput,
} from "./pipeline.ts";
import { tableShape, todayIn, writable } from "./plan.ts";
import { readSlots, readUnderAnotherTask, restoreCount, type SlotRow } from "./reads.ts";
import type { PendingRef } from "./receipt.ts";
import { itemVer, readReceipt, type WriteReceipt, withDerived } from "./receipt.ts";
import { encodeResolution, type RowContext } from "./record.ts";
import { findRequest, requestKeyOf } from "./request-key.ts";
import { evidenceSource } from "./sources.ts";

/** A decision's result (04-contract-types §5.2 `ResolveResult`). */
export interface ResolveReceipt {
  readonly id: ItemId;
  readonly type: ItemType;
  readonly decision: ResolveDecision;
  /** The item's version after the decision. */
  readonly item_ver: string;
  readonly status: "resolved";
  /** The write the decision triggered: as the write receipt gives it. */
  readonly write?: Pick<
    WriteReceipt,
    "seq" | "sv" | "ops" | "derived" | "derived_total" | "pending" | "superseded" | "omitted"
  >;
  /**
   * `take_previous`: the writes it took back or hid, as the item's details listed them at the
   * version the decision bound (04-contract-types §4.8 `reverted_by_previous`).
   */
  readonly reverted_by_previous?: readonly {
    readonly seq: number;
    readonly actor: Actor;
    readonly fields: readonly string[];
  }[];
  readonly replayed?: true;
  readonly warnings?: readonly ResolveWarning[];
}

/** `item_ver` taken by fallback (04-contract §2 «兜底»). */
export interface ResolveWarning {
  readonly code: "item_ver_fallback";
  readonly item_ver: string;
  readonly read?: ReadId;
}

/** The decisions each item type takes in this version (04-contract §6). */
const DECISIONS_OF: Readonly<Record<string, readonly ResolveDecision[]>> = {
  conflict: ["keep_effective", "take_candidate", "take_previous"],
  awaiting_confirmation: ["confirm", "reject"],
};
/**
 * Decisions of item types of later phases that take one of this version's decisions. Not reached
 * in this version: no such item is opened, and an item without a target table is `not_found` first.
 */
const LATER: Readonly<Record<string, readonly ResolveDecision[]>> = {
  schema_change: ["confirm", "reject"],
};

/** An item's type (09-event-format §5.8). */
type ItemType = PendingRef["type"];

/** A pending item as `pending_items` keeps it. */
interface ItemRow {
  readonly id: ItemId;
  readonly type: ItemType;
  readonly slot: string | null;
  readonly table: string | null;
  readonly row: string | null;
  readonly state: string;
  readonly decision: string | null;
  readonly versionOp: OpNumber;
}

async function itemRow(tx: ReadTx, id: string): Promise<ItemRow | undefined> {
  const r = await tx.query<{
    id: string;
    type: string;
    slot_id: string | null;
    target_table: string | null;
    target_row: string | null;
    state: string;
    decision: string | null;
    version_op: unknown;
  }>(
    `SELECT id, type, slot_id, target_table, target_row, state, decision, version_op
     FROM pending_items WHERE id = $1`,
    [id],
  );
  const x = r.rows[0];
  return x === undefined
    ? undefined
    : {
        id: x.id as ItemId,
        type: x.type as ItemType,
        slot: x.slot_id,
        table: x.target_table,
        row: x.target_row,
        state: x.state,
        decision: x.decision,
        versionOp: Number(x.version_op) as OpNumber,
      };
}

/** How many candidates an item was given (`candidates/<k>` of its item events). */
async function candidateCount(tx: ReadTx, item: string): Promise<number> {
  const r = await tx.query<{ n: unknown }>(
    `SELECT count(DISTINCT c.path) AS n FROM events e
     JOIN content t ON t.seq = e.seq AND t.path = 'target' AND t.body IS NOT NULL
     JOIN content c ON c.seq = e.seq AND c.path LIKE 'candidates/%'
     WHERE e.type IN ('item.created', 'item.merged') AND (t.body::jsonb ->> 'item') = $1`,
    [item],
  );
  return Number(r.rows[0]?.n ?? 0);
}

/**
 * item_closed (04-contract-types §9): how the item closed, in the shape its details give, the
 * principal named as they are now (an error's details are read, not a receipt: §1.6).
 */
async function closed(tx: ReadTx, item: string, message: string): Promise<WriteError> {
  const c = await closingOf(tx, item);
  const who = await actorsNow(tx, c.principals);
  const out = c.out((p) => who.get(p));
  // A closed item always has the event that closed it; without one, its state and the log disagree.
  if (!("resolution" in out) && !("superseded" in out)) {
    return new WriteError("internal", "a closed item without the event that closed it", {
      reason: "inconsistent",
    });
  }
  return new WriteError("item_closed", message, {
    reason: "resolution" in out ? "resolved" : "superseded",
    ...out,
  });
}

/** The `target` block and the operation of the item's latest event of type `type`. */
async function itemEvent(
  tx: ReadTx,
  item: string,
  type: "item.resolved" | "item.superseded",
): Promise<{ op: OpNumber; actor: string; target: Record<string, JsonValue> } | undefined> {
  const r = await tx.query<{ op: unknown; actor: string; body: string }>(
    `SELECT e.op, e.actor, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE e.type = $1 AND c.body IS NOT NULL AND (c.body::jsonb ->> 'item') = $2
     ORDER BY e.seq DESC LIMIT 1`,
    [type, item],
  );
  const x = r.rows[0];
  return x === undefined
    ? undefined
    : {
        op: Number(x.op) as OpNumber,
        actor: x.actor,
        target: JSON.parse(x.body) as Record<string, JsonValue>,
      };
}

/**
 * The item version the caller's own receipt gave whole (04-contract §2 «兜底»): the latest of its
 * operations under the call's task that opened the item. `task_mismatch`: it did so only under
 * another task (or without one).
 */
async function itemVerFromOwn(
  tx: ReadTx,
  item: string,
  actor: string,
  task: string | null,
): Promise<
  | { op: OpNumber; restoreCount: number }
  | { reason: "no_read" | "task_mismatch"; readTask?: string | null }
> {
  const r = await tx.query<{ op: unknown; task: string | null }>(
    `SELECT h.seq AS op,
       (SELECT k.body::jsonb #>> '{}' FROM content k WHERE k.seq = h.seq AND k.path = 'task' AND k.body IS NOT NULL) AS task
     FROM events h
     JOIN events c ON c.op = h.seq AND c.type = 'item.created'
     JOIN content t ON t.seq = c.seq AND t.path = 'target' AND t.body IS NOT NULL
     WHERE h.actor = $1 AND (t.body::jsonb ->> 'item') = $2
     ORDER BY h.seq DESC`,
    [actor, item],
  );
  const same = r.rows.find((x) => (x.task ?? null) === task);
  if (same !== undefined) {
    // The version as that receipt gave it: with the restore count of its time, so a receipt from
    // before a restore does not bind the item now (04-contract §15: `restored`).
    const restored = await tx.query<{ header: string }>(
      "SELECT header FROM events WHERE type = 'tenant.restored' AND seq < $1 ORDER BY seq DESC LIMIT 1",
      [Number(same.op)],
    );
    const h = restored.rows[0]?.header;
    const restoreCount =
      h === undefined ? 0 : ((JSON.parse(h) as { restore_count?: number }).restore_count ?? 0);
    return { op: Number(same.op) as OpNumber, restoreCount };
  }
  const other = r.rows[0];
  return other !== undefined
    ? { reason: "task_mismatch", readTask: other.task ?? null }
    : { reason: "no_read" };
}

/** The result of a decision, read back from the log (the original one, for a repeated request). */
async function readResolution(
  tx: ReadTx,
  op: OpNumber,
  o: {
    readonly slot: SlotRow;
    readonly restoreCount: number;
    readonly replayed: boolean;
    /** A first receipt's derived writes, in memory (a replay has only the log). */
    readonly derived?: readonly DerivedWrite[];
  },
): Promise<ResolveReceipt> {
  const head = await tx.query<{ type: string; body: string | null }>(
    `SELECT e.type, c.body FROM events e LEFT JOIN content c ON c.seq = e.seq AND c.path = 'target'
     WHERE e.seq = $1`,
    [op],
  );
  const h = head.rows[0];
  if (h === undefined || h.type !== "item.resolved" || h.body === null) {
    throw new WriteError("internal", "the operation is not a decision", { reason: "inconsistent" });
  }
  const t = JSON.parse(h.body) as { item: ItemId; decision: ResolveDecision; item_op?: number };
  const item = await itemRow(tx, t.item);
  // take_previous: what the item's details listed it would take back, at the version the decision
  // bound (its contents are in the log: a replay reads the same, nothing judged again).
  let previous: { seq: number; actor: Actor; fields: string[] }[] | undefined;
  if (t.decision === "take_previous" && t.item_op !== undefined && item?.table != null) {
    const e = (await itemEntries(tx, [t.item], t.item_op)).get(t.item);
    if (e !== undefined) {
      const table = o.slot.compiled.tables.find((x) => x.id === item.table);
      const writers = [...e.actorOfOp.values()];
      const names = await actorsAsOf(tx, [...new Set(writers)], op);
      // As the details name them (pending `revertedOut`), with the writers as of this operation.
      previous = revertedOut(
        e,
        {
          field: (id) => table?.fields.find((f) => f.id === id)?.name ?? id,
          interval: () => ({}),
          actor: (p): Actor => names.get(p) ?? { kind: "user", id: p, name: p },
          value: (v) => v,
          isState: true,
        },
        e.impact,
      );
    }
  }
  const read = await readReceipt(tx, op, {
    compiled: o.slot.compiled,
    slotName: o.slot.name,
    restoreCount: o.restoreCount,
    replayed: o.replayed,
  });
  const write =
    read !== undefined && o.derived !== undefined
      ? withDerived(read, o.derived, o.slot.compiled, o.slot.name)
      : read;
  return {
    id: t.item,
    type: item?.type ?? "conflict",
    decision: t.decision,
    item_ver: itemVer(t.item, op, o.restoreCount),
    status: "resolved",
    ...(write !== undefined
      ? {
          write: {
            seq: write.seq,
            sv: write.sv,
            ops: write.ops,
            derived: write.derived,
            derived_total: write.derived_total,
            pending: write.pending,
            superseded: write.superseded,
            ...(write.omitted !== undefined ? { omitted: write.omitted } : {}),
          },
        }
      : {}),
    ...(previous !== undefined ? { reverted_by_previous: previous } : {}),
    ...(o.replayed ? { replayed: true as const } : {}),
  };
}

/** The intent of the `write.base` event `event` on the row (`update` when there is none). */
function intentOf(
  work: { events: readonly { header: { seq: number }; blocks: Record<string, unknown> }[] },
  event: number,
) {
  const e = work.events.find((x) => x.header.seq === event);
  return ((e?.blocks["target"] as { intent?: string } | undefined)?.intent ?? "update") as
    | "insert"
    | "update"
    | "correct"
    | "revoke";
}

/** Resolves the pending item the request names, in `tx`; returns the decision's result. */
export async function resolveInTx(tx: Tx, input: WriteInput): Promise<ResolveReceipt> {
  const { actor, now } = input;
  const normalized = normalizeResolve(input.params);
  if (!normalized.ok) throw requestFailure(normalized.error);
  const req = normalized.request;
  const task = req.task ?? input.task;
  const restore = await restoreCount(tx);
  const slots = await readSlots(tx);

  // The request key in its window.
  const rk = requestKeyOf(actor, task, req.requestKey);
  const hit = await findRequest(tx, rk, now, input.windows);
  const item = await itemRow(tx, req.id);
  const slot = slots.find((s) => s.slot === item?.slot);
  const visible =
    item !== undefined &&
    slot !== undefined &&
    item.table !== null &&
    writable(input.visibility, slot.slot, item.table);
  if (hit !== undefined) {
    if (!visible) throw new WriteError("not_found", "no such item", { param: "id" });
    return readResolution(tx, hit, { slot, restoreCount: restore, replayed: true });
  }
  if (!visible || item.row === null || item.table === null) {
    throw new WriteError("not_found", "no such item", { param: "id" });
  }

  // A closed item: the same decision again is a repeat, any other is refused.
  if (item.state === "resolved") {
    const done = await itemEvent(tx, item.id, "item.resolved");
    if (done === undefined) {
      throw new WriteError("internal", "a resolved item without its decision", {
        reason: "inconsistent",
      });
    }
    const was = done.target as { decision: string; candidate?: number };
    // The candidate the request names, as an open item would take it: left out, the only one;
    // left out among several, none (an open item would refuse it, `candidate_required`).
    const named =
      req.decision !== "take_candidate"
        ? undefined
        : (req.candidate ?? ((await candidateCount(tx, item.id)) === 1 ? 0 : undefined));
    const same =
      was.decision === req.decision &&
      (req.decision !== "take_candidate" || (named !== undefined && named === was.candidate));
    if (same) return readResolution(tx, done.op, { slot, restoreCount: restore, replayed: true });
    throw await closed(tx, item.id, "the item was resolved another way");
  }
  if (item.state !== "open") throw await closed(tx, item.id, "the item was superseded");

  // The decision fits the item's type.
  if (!(DECISIONS_OF[item.type] ?? []).includes(req.decision)) {
    if ((LATER[item.type] ?? []).includes(req.decision)) {
      throw new WriteError("not_in_this_version", "not in this version", { param: "decision" });
    }
    throw new WriteError("invalid_argument", "the item does not take this decision", {
      reason: "malformed",
      param: "decision",
    });
  }

  // The item version the decision binds (04-contract §6): brought back, or the latest the caller
  // read or had whole in its own receipt.
  const current = { op: item.versionOp, restoreCount: restore };
  const warnings: ResolveWarning[] = [];
  let seen = req.itemVer;
  if (seen === undefined) {
    const read = await lastRead(tx, input.reads, { actor, task, kind: "item", target: item.id });
    const own = await itemVerFromOwn(tx, item.id, actor, task);
    if (read !== undefined && (!("op" in own) || read.op >= own.op)) {
      seen = { op: read.op as OpNumber, restoreCount: read.restoreCount };
      warnings.push({
        code: "item_ver_fallback",
        item_ver: itemVer(item.id, read.op, read.restoreCount),
        read: read.read,
      });
    } else if ("op" in own) {
      seen = { op: own.op, restoreCount: own.restoreCount };
      warnings.push({
        code: "item_ver_fallback",
        item_ver: itemVer(item.id, own.op, own.restoreCount),
      });
    } else {
      const other =
        own.reason === "task_mismatch"
          ? { readTask: own.readTask ?? null }
          : await readUnderAnotherTask(tx, actor, task, "item", item.id).then((x) =>
              x === undefined ? undefined : { readTask: x.task },
            );
      throw readFirst(
        other !== undefined
          ? { reason: "task_mismatch", readTask: other.readTask }
          : { reason: "no_read" },
        { target: "item", ref: item.id },
        task,
        "item_ver",
      );
    }
  }
  if (seen.op !== current.op || seen.restoreCount !== current.restoreCount) {
    throw new WriteError("confirmation_mismatch", "the item changed since it was read", {
      reason: seen.restoreCount !== current.restoreCount ? "restored" : "changed",
      current: {
        id: item.id,
        type: item.type,
        item_ver: itemVer(item.id, current.op, current.restoreCount),
      },
    });
  }

  // The row and the item on it.
  const table = slot.compiled.tables.find(
    (t) => t.id === item.table && t.kind === "base",
  ) as CompiledBaseTable;
  const shape = tableShape(table);
  const isState = shape.kind === "state";
  const ctx: RowContext = {
    table: table.id as TableId,
    target: isState ? { entity: item.row as EntityId } : { row: item.row as RowId },
    shape,
    granularity: table.time.type === "state" ? table.time.granularity : "date",
  };
  const work = await loadRow(tx, ctx, "id");
  const tracked = work.items.find((x) => x.item === item.id);
  if (tracked === undefined) {
    throw new WriteError("internal", "an open item not on its row", { reason: "inconsistent" });
  }

  // `take_candidate`: which candidate (04-contract `resolve`).
  let candidate: number | undefined;
  if (req.decision === "take_candidate") {
    const n = tracked.cands.length;
    if (req.candidate === undefined && n > 1) {
      const ops = await tx.query<{ seq: unknown; op: unknown; actor: string }>(
        "SELECT seq, op, actor FROM events WHERE seq = ANY($1)",
        [tracked.cands] as never,
      );
      const by = new Map(ops.rows.map((x) => [Number(x.seq), x]));
      // The writers as they are now, as the item's details give them (04-contract-types §1.6).
      const who = await actorsNow(
        tx,
        ops.rows.map((x) => x.actor),
      );
      throw new WriteError("invalid_argument", "several candidates: name one", {
        reason: "candidate_required",
        param: "candidate",
        candidate_choices: tracked.cands.map((e, index) => ({
          index,
          seq: Number(by.get(e)?.op ?? e),
          actor: who.get(by.get(e)?.actor ?? ""),
        })),
      });
    }
    candidate = req.candidate ?? 0;
    if (candidate >= n) {
      throw new WriteError("invalid_argument", "no such candidate", {
        reason: "index_out_of_range",
        param: "candidate",
      });
    }
  }

  // The confirmation: the item's entries as read (09 §5.8, computed on appending).
  const hash = confirmationHash(await entryChecksums(tx, item.id));
  if (hash === "removed") {
    throw new WriteError(
      "internal",
      "resolving an item whose entries were deleted is not implemented",
      {
        reason: "not_implemented",
      },
    );
  }

  // The decision, judged on the row's state.
  const op = (((await readTail(tx))?.seq ?? 0) + 1) as OpNumber;
  const triggers = ["take_candidate", "take_previous", "confirm"].includes(req.decision);
  // Sources (09 §4.3): each evidence segment, then the request itself as an `api_call` when it
  // has a note, or when it triggers a write and has no evidence. The triggered write's own items
  // take the evidence as their value sources, or else the `api_call`.
  const nEvidence = req.evidence.length;
  const apiCall = req.note !== undefined || (triggers && nEvidence === 0);
  const nSources = nEvidence + (apiCall ? 1 : 0);
  const sourceSeqs = Array.from({ length: nSources }, (_, k) => (op + 1 + k) as Seq);
  const valueSources = nEvidence > 0 ? sourceSeqs.slice(0, nEvidence) : sourceSeqs;
  const event = (op + 1 + nSources) as Seq;
  const base = { op, index: 0, event, ruleset: RULESET };
  const unit = tracked.unit as Unit;
  const judgeInput: JudgeInput =
    req.decision === "confirm" || req.decision === "reject"
      ? { ...base, kind: req.decision, target: tracked.origin }
      : req.decision === "take_candidate"
        ? {
            ...base,
            kind: "take_candidate",
            unit,
            candidates: tracked.cands,
            take: tracked.cands[candidate as number] as Seq,
          }
        : { ...base, kind: req.decision, unit, candidates: tracked.cands };
  let judged: ReturnType<typeof judgeOp>;
  try {
    judged = judgeOp(work.state, judgeInput);
  } catch (e) {
    // A decision has no ops: its triggered write's failures name no op and no `ops/…` parameter.
    if (e instanceof JudgeError) throw judgeFailure(e, { slot: slot.name, table });
    throw e;
  }
  const j = judged.judgement;
  // Confirming a revert proposal that would write nothing is not reached: an item whose undo, judged
  // again, has nothing to write back and nothing to hide is closed by the write that leaves it so,
  // in that write's transaction (../write/pipeline.ts `nothingToRevert`; 04-write-and-read
  // «撤回某次写入（undo）»). Refused rather than recorded as an empty write.
  if (j.record.kind === "confirm" && j.record.revert !== undefined && j.record.items.length === 0) {
    throw new WriteError("internal", "an awaiting undo with nothing to revert is still open", {
      reason: "inconsistent",
    });
  }
  work.state = judged.state;
  // The intent the triggered write carries on (09 §6.1 «意图»): the taken candidate's write, the
  // proposal's, or for `take_previous` the write of the latest entry its revert takes back.
  const r = j.record;
  const intent =
    r.kind === "take_previous"
      ? r.revert.entries.length === 0
        ? "update"
        : intentOf(work, Math.max(...r.revert.entries.map((x) => x.event)))
      : r.kind === "take_candidate"
        ? intentOf(work, r.take)
        : intentOf(work, tracked.origin);
  const enc = encodeResolution(ctx, j, {
    item: item.id,
    ...(candidate !== undefined ? { candidate } : {}),
    intent,
    sv: slot.sv,
    itemOp: item.versionOp,
    restoreCount: restore,
    sources: valueSources,
  });

  // The events: the decision, its sources, the write it triggers, then the other items on the row.
  const evidenceIds = req.evidence.map(() => input.newId("source"));
  const sources: NewEvent[] = [
    ...req.evidence.map((ev, k) => evidenceSource(ev, slot.slot, evidenceIds[k] as string)),
    ...(apiCall
      ? [
          {
            type: "source.recorded" as const,
            slot: slot.slot,
            blocks: {
              target: {
                source_id: input.newId("source"),
                kind: "api_call",
                level: "agent_inferred",
              },
              // The decision as asked, without the evidence's content: each segment is a source of
              // its own, named here by its ID (09 §5.4 `request`).
              request: {
                id: req.id,
                decision: req.decision,
                ...(req.candidate !== undefined ? { candidate: req.candidate } : {}),
                ...(req.note !== undefined ? { note: req.note } : {}),
                ...(evidenceIds.length > 0 ? { evidence: evidenceIds } : {}),
              },
            } as never,
          },
        ]
      : []),
  ];
  const opEvents: NewEvent[] = [];
  // The item the decision closes gets nothing more in this request (one set of contents).
  work.items.splice(work.items.indexOf(tracked), 1);
  if (enc.base !== undefined) {
    opEvents.push({ type: "write.base", slot: slot.slot, blocks: enc.base as never });
    work.lastBase = event;
    const before = { upTo: (op - 1) as OpNumber, request: { op, below: 0 } };
    const after = { upTo: (op - 1) as OpNumber, request: { op, below: 1 } };
    for (const t of work.items) {
      if (reaches(work.state, before, after, t.unit, reachScope(work.state, t)))
        t.reachedBy = event;
    }
  }
  await settleItems(tx, [work], {
    op,
    slot: slot.slot,
    writer: input,
    task,
    restore,
    events: opEvents,
  });
  const head: NewEvent = {
    type: "item.resolved",
    slot: slot.slot,
    blocks: {
      ctx: {
        now,
        today: todayIn(now, slot.timezone),
        ruleset_version: RULESET,
        policy_version: slot.policyVersion,
      },
      ...(task !== null ? { task } : {}),
      ...rk.block,
      target: enc.target,
      ...(sourceSeqs.length > 0 ? { op_sources: sourceSeqs } : {}),
      ...(hash !== undefined ? { confirmation: { hash } } : {}),
    } as never,
  };
  // Appended and applied; the derived tables the triggered write reaches refreshed in the same
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
    if (e instanceof ApplyError) {
      throw new WriteError("internal", "the decision could not be applied", {
        reason: e.reason,
        seq: e.seq,
      });
    }
    throw e;
  }
  if (step.prepared.op !== op) {
    throw new WriteError("internal", "the operation's numbers are not as planned");
  }
  const out = await readResolution(tx, op, {
    slot,
    restoreCount: restore,
    replayed: false,
    derived: step.derived,
  });
  return warnings.length > 0 ? { ...out, warnings } : out;
}

/**
 * Testing: for an open awaiting revert proposal, the revert entries its undo judged again now and
 * its confirmation judged now list (pipeline.ts `revertEntriesNow`); undefined for another item.
 */
export async function revertEntriesOf(
  tx: Tx,
  id: string,
): Promise<ReturnType<typeof revertEntriesNow> | undefined> {
  const item = await itemRow(tx, id);
  if (item === undefined || item.state !== "open" || item.row === null || item.table === null)
    return undefined;
  const slot = (await readSlots(tx)).find((x) => x.slot === item.slot);
  const table = slot?.compiled.tables.find((t) => t.id === item.table && t.kind === "base") as
    | CompiledBaseTable
    | undefined;
  if (table === undefined) return undefined;
  const shape = tableShape(table);
  const isState = shape.kind === "state";
  const work = await loadRow(
    tx,
    {
      table: table.id as TableId,
      target: isState ? { entity: item.row as EntityId } : { row: item.row as RowId },
      shape,
      granularity: table.time.type === "state" ? table.time.granularity : "date",
    },
    "id",
  );
  const tracked = work.items.find((x) => x.item === item.id);
  if (tracked === undefined) return undefined;
  const upTo = ((await readTail(tx))?.seq ?? 0) as OpNumber;
  return revertEntriesNow(work.state, tracked, upTo);
}
