// The events of a judged log on one row or entity (09-event-format §5.7, §5.8), for the tests that
// take judged scenarios through events: the record round trip (record.prop.test.ts) and apply on
// storage (store-pglite). Pending items are opened, joined and resolved as the judgements say;
// IDs, sources and raw values are filled in as a caller of the record mapping would.

import type { FieldId, ItemId, RawFieldValue } from "@fluxvita/saveslot-contract-core";
import type { Op } from "@fluxvita/saveslot-reference";
import type { JudgeInput, Judgement, Unit } from "../judge/model.ts";
import type { Judged } from "../judge/scenarios.fixture.ts";
import { encodeOp, encodeResolution, type RowContext } from "./record.ts";

/** The operation of the scenarios' first write: the insert that makes the row or entity. */
export const FIRST_OP = 10;

const itemId = (n: number): ItemId =>
  `pi_${n
    .toString(32)
    .toUpperCase()
    .padStart(16, "0")
    .replace(/[ILOU]/g, "Z")}` as ItemId;

const unitKey = (u: Unit) => (u === "existence" ? "existence" : [...u.fields].sort().join(","));

/**
 * The ops as this phase writes them. No `evidence_by_field`: a same-valued write is a no-op, never a
 * corroboration, and the format has no place yet for "this field's evidence was pointed at" (a
 * later phase).
 */
export function asInThisPhase(o: Op, i: number): Op {
  if (o.kind !== "write") return o;
  const fields = Object.fromEntries(
    Object.entries(o.fields).map(([f, x]) => {
      if (x === undefined) return [f, x];
      const { explicit: _, ...rest } = x;
      return [f, rest];
    }),
  );
  // The first write makes the row or entity: an insert sees the state just before it and has no
  // `ver` (09 §5.7).
  if (i === 0) {
    const { seen: _, ...rest } = o;
    return { ...rest, fields };
  }
  return { ...o, fields };
}

/** The raw values of a write: in these scenarios, as the caller would give them, the same text. */
function rawOf(input: JudgeInput): Partial<Record<FieldId, RawFieldValue>> {
  if (input.kind !== "write") return {};
  return Object.fromEntries(
    Object.entries(input.fields).map(([f, x]) => [f, (x?.value ?? null) as RawFieldValue]),
  );
}

/** One event of an operation: its type, `seq`, operation number (member events) and blocks. */
export interface LoggedEvent {
  readonly type: string;
  readonly seq: number;
  readonly op?: number;
  readonly blocks: Record<string, unknown>;
}

/**
 * The events of each judged step, its head event first: `write.head` or `item.resolved`, then its
 * `write.base`, then its pending item events, numbered by `itemSeq(event or operation, n)`.
 */
export function eventsOfSteps(
  ctx: RowContext,
  steps: readonly Judged[],
  itemSeq: (after: number, n: number) => number,
): LoggedEvent[][] {
  const open = new Map<
    string,
    { item: ItemId; candidates: number[]; mergeBase: number; version: number }
  >();
  const awaiting = new Map<number, { item: ItemId; version: number }>();
  let next = 1;
  const out: LoggedEvent[][] = [];
  for (const s of steps) {
    const j: Judgement = s.judgement;
    const r = j.record;
    const evs: LoggedEvent[] = [];
    const now = "now" in s.input ? (s.input.now as string) : "2026-11-05";
    const ctxBlock = {
      now: now.includes("T") ? now : `${now}T00:00:00.000Z`,
      today: now.slice(0, 10),
      ruleset_version: s.input.ruleset,
      policy_version: 1,
      literal_checker: "literal@1",
    };
    if (r.kind === "write" || r.kind === "revoke" || r.kind === "undo") {
      const seenOp = r.seen ?? r.op - 1;
      const conflictItems = j.conflicts.map((c) => {
        const key = unitKey(c.unit);
        const prior = open.get(key);
        if (prior !== undefined) {
          prior.candidates.push(r.event);
          prior.mergeBase = Math.min(prior.mergeBase, seenOp);
          prior.version = r.op;
          return {
            item: prior.item,
            merged: true as const,
            candidate: prior.candidates.length - 1,
            mergeBase: prior.mergeBase,
          };
        }
        const item = itemId(next++);
        open.set(key, { item, candidates: [r.event], mergeBase: seenOp, version: r.op });
        return { item, candidate: 0, mergeBase: seenOp };
      });
      const awaitingItem = r.items.some((x) => x.status === "awaiting")
        ? itemId(next++)
        : undefined;
      if (awaitingItem !== undefined) awaiting.set(r.event, { item: awaitingItem, version: r.op });
      const enc = encodeOp(ctx, s.input, j, {
        intent: r.kind === "revoke" ? "revoke" : r.op === FIRST_OP ? "insert" : "update",
        ...(j.created ? { created: true as const } : {}),
        sv: 1,
        sources: [r.op],
        raw: rawOf(s.input),
        restoreCount: 0,
        conflictItems,
        ...(awaitingItem !== undefined ? { awaitingItem } : {}),
        versions: { ruleset: 1, policy: 1 },
      });
      evs.push({
        type: "write.head",
        seq: r.op,
        blocks: {
          ctx: ctxBlock,
          request: { sv: 1, sv_basis: "explicit", op_count: 1 },
          ...enc.head,
        },
      });
      if (enc.base !== undefined) {
        evs.push({ type: "write.base", seq: r.event, op: r.op, blocks: enc.base });
      }
      const after = enc.base !== undefined ? r.event : r.op;
      enc.items.forEach((it, n) => {
        evs.push({ type: it.type, seq: itemSeq(after, n), op: r.op, blocks: it.blocks });
      });
    } else {
      // A decision: on the item of its unit, or on the awaiting item of its target.
      const isAwaiting = r.kind === "confirm" || r.kind === "reject";
      let item: ItemId | undefined;
      let candidate: number | undefined;
      let version: number | undefined;
      if (isAwaiting) {
        item = awaiting.get(r.target)?.item;
        version = awaiting.get(r.target)?.version;
        awaiting.delete(r.target);
      } else {
        const unit =
          r.kind === "take_previous"
            ? r.revert.unit
            : r.kind === "keep_effective" || r.kind === "take_candidate"
              ? r.unit
              : undefined;
        const key = unit === undefined ? "" : unitKey(unit);
        const it = open.get(key);
        item = it?.item;
        version = it?.version;
        if (r.kind === "take_candidate") candidate = it?.candidates.indexOf(r.take);
        open.delete(key);
      }
      if (item === undefined || version === undefined)
        throw new Error("a decision without its item");
      const enc = encodeResolution(ctx, j, {
        item,
        ...(candidate !== undefined ? { candidate } : {}),
        intent: "update",
        sv: 1,
        // The item's version: the operation that last opened or joined it (09 §5.8 `item_op`).
        itemOp: version,
        restoreCount: 0,
      });
      evs.push({ type: "item.resolved", seq: r.op, blocks: { ctx: ctxBlock, target: enc.target } });
      if (enc.base !== undefined) {
        evs.push({ type: "write.base", seq: r.event, op: r.op, blocks: enc.base });
      }
    }
    out.push(evs);
  }
  return out;
}

/**
 * The events of one request with several ops (09 §4.2): one `write.head` with every op's blocks,
 * then each op's `write.base`. For ops that open no pending item.
 */
export function eventsOfRequest(
  ctx: RowContext,
  inputs: readonly JudgeInput[],
  judgements: readonly Judgement[],
  intent: "insert" | "update",
): LoggedEvent[] {
  const head: Record<string, unknown> = {};
  const bases: LoggedEvent[] = [];
  inputs.forEach((input, n) => {
    const j = judgements[n] as Judgement;
    if (
      j.conflicts.length > 0 ||
      j.record.kind !== "write" ||
      j.record.items.some((x) => x.status === "awaiting")
    ) {
      throw new Error("eventsOfRequest: an op opening a pending item");
    }
    const enc = encodeOp(ctx, input, j, {
      intent,
      ...(j.created ? { created: true as const } : {}),
      sv: 1,
      sources: [input.op],
      raw: rawOf(input),
      restoreCount: 0,
      versions: { ruleset: 1, policy: 1 },
    });
    Object.assign(head, enc.head);
    if (enc.base !== undefined) {
      bases.push({ type: "write.base", seq: input.event, op: input.op, blocks: enc.base });
    }
  });
  const first = inputs[0] as JudgeInput;
  const now = "now" in first ? (first.now as string) : "2026-11-05";
  return [
    {
      type: "write.head",
      seq: first.op,
      blocks: {
        ctx: {
          now: `${now}T00:00:00.000Z`,
          today: now,
          ruleset_version: 1,
          policy_version: 1,
          literal_checker: "literal@1",
        },
        request: { sv: 1, sv_basis: "explicit", op_count: inputs.length },
        ...head,
      },
    },
    ...bases,
  ];
}
