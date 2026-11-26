// The events of a judged log on one row or entity (09-event-format §5.7, §5.8), for the tests that
// take judged scenarios through events: the record round trip (record.prop.test.ts) and apply on
// storage (store-pglite). Pending items are opened, joined and resolved as the judgements say;
// IDs, sources and raw values are filled in as a caller of the record mapping would.

import type { FieldId, ItemId, RawFieldValue } from "@fluxvita/saveslot-contract-core";
import type { Op } from "@fluxvita/saveslot-reference";
import { stateFromRecord } from "../judge/judge.ts";
import type { JudgeInput, Judgement, Unit } from "../judge/model.ts";
import type { Judged } from "../judge/scenarios.fixture.ts";
import type { RowState } from "../judge/state.ts";
import type { ReadTx } from "../store/ports.ts";
import { restoreHistory } from "../store/restore-point.ts";
import { canonical, type IntervalSet, meet, WHOLE } from "../time/index.ts";
import { type RowEventsOptions, rowEvents } from "./reads.ts";
import { decodeRecords, encodeOp, encodeResolution, type RowContext } from "./record.ts";

/** The operation of the scenarios' first write: the insert that makes the row or entity. */
export const FIRST_OP = 10;

const itemId = (n: number): ItemId =>
  `pi_${n
    .toString(32)
    .toUpperCase()
    .padStart(16, "0")
    .replace(/[ILOU]/g, "Z")}` as ItemId;

const unitKey = (u: Unit) => (u === "existence" ? "existence" : [...u.fields].sort().join(","));

/** The fields a write points evidence at (`ops/<i>/explicit`), in the table's order. */
function explicitOf(ctx: RowContext, input: JudgeInput): FieldId[] {
  if (input.kind !== "write") return [];
  return ctx.shape.fields.filter((f) => input.fields[f]?.explicit === true);
}

/**
 * The ops as a request writes them: the first one an insert, with no `ver` (09 §5.7). A field
 * marked explicit is one `evidence_by_field` points at (`ops/<i>/explicit`): the same value again
 * is a corroboration.
 */
export function asWritten(o: Op, i: number): Op {
  if (o.kind !== "write" || i !== 0) return o;
  const { seen: _, ...rest } = o;
  return rest;
}

/**
 * A write or revoke with an interval parameter records its interval's sources (`valid_sources`):
 * here, all its evidence (as the pipeline does when `evidence_by_field` maps no `valid`).
 */
function intervalSources(input: JudgeInput, sources: readonly number[]) {
  return (input.kind === "revoke" || input.kind === "write") &&
    input.valid !== undefined &&
    input.valid !== "corrected_span"
    ? { validSources: sources as never }
    : {};
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
  // The open conflict items in the order they were opened (01-objects «目标与合并»: a conflict
  // joins the earliest open item of its unit whose interval meets its candidate items').
  const open: {
    item: ItemId;
    unit: string;
    spans: IntervalSet;
    candidates: number[];
    mergeBase: number;
    version: number;
  }[] = [];
  const isState = ctx.shape.kind === "state";
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
        const mine: IntervalSet = isState
          ? canonical(
              r.items
                .filter((x) => c.items.some((y) => y.target === x.target && y.k === x.k))
                .flatMap((x) => x.valid),
            )
          : [WHOLE];
        const prior = open.find(
          (x) => x.unit === key && (!isState || meet(x.spans, mine).length > 0),
        );
        if (prior !== undefined) {
          prior.candidates.push(r.event);
          prior.mergeBase = Math.min(prior.mergeBase, seenOp);
          prior.version = r.op;
          prior.spans = isState ? canonical([...prior.spans, ...mine]) : [WHOLE];
          return {
            item: prior.item,
            merged: true as const,
            candidate: prior.candidates.length - 1,
            mergeBase: prior.mergeBase,
          };
        }
        const item = itemId(next++);
        open.push({
          item,
          unit: key,
          spans: mine,
          candidates: [r.event],
          mergeBase: seenOp,
          version: r.op,
        });
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
        ...intervalSources(s.input, [r.op]),
        explicit: explicitOf(ctx, s.input),
        // The operation's sources (09 §5.7 `op_sources`): an undo's, the request's evidence or its
        // api_call; a revoke's, its evidence not taken as the interval's source — all of it for a
        // revoke of the whole row or entity, none for one over an interval (here all its evidence
        // is the interval's).
        ...(r.kind === "undo" || (s.input.kind === "revoke" && s.input.valid === undefined)
          ? { opSources: [r.op] }
          : {}),
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
        // The item holding the decision's candidates; several: not one item's decision.
        const theirs: readonly number[] =
          r.kind === "take_previous"
            ? (r.revert.candidates ?? [])
            : r.kind === "keep_effective" || r.kind === "take_candidate"
              ? r.candidates
              : [];
        const holding = open.filter(
          (x) => x.unit === key && x.candidates.some((c) => theirs.includes(c)),
        );
        // The scenarios resolve one item at a time (judge/scenarios.fixture.ts `itemsOfUnit`).
        if (holding.length > 1) throw new Error("a decision over several items");
        const it = holding[0];
        item = it?.item;
        version = it?.version;
        if (r.kind === "take_candidate") candidate = it?.candidates.indexOf(r.take);
        if (it !== undefined) open.splice(open.indexOf(it), 1);
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
      // item.resolved's ctx has no literal_checker (09 §5.1).
      const { literal_checker: _, ...resolveCtx } = ctxBlock;
      evs.push({
        type: "item.resolved",
        seq: r.op,
        blocks: { ctx: resolveCtx, target: enc.target },
      });
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
  /** Each op's sources (evidence `seq`s); by default the op's own number. */
  sources?: readonly number[],
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
      sources: sources ?? [input.op],
      ...intervalSources(input, sources ?? [input.op]),
      explicit: explicitOf(ctx, input),
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
  // A state table by the instant gives "now" as an instant; by the day, or no time, a date.
  const given = "now" in first ? (first.now as string) : "2026-11-05";
  const now = given.includes("T") ? given : `${given}T00:00:00.000Z`;
  return [
    {
      type: "write.head",
      seq: first.op,
      blocks: {
        ctx: {
          now,
          today: now.slice(0, 10),
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

/**
 * The row's state as judge rebuilds it from the stored log: the write pipeline's reading
 * (`rowEvents`, `decodeRecords`), not apply's. Tests hold what apply wrote against it.
 */
export async function judgeStateFromLog(
  tx: ReadTx,
  ctx: RowContext,
  o: RowEventsOptions = {},
): Promise<RowState> {
  const id = "entity" in ctx.target ? ctx.target.entity : ctx.target.row;
  return stateFromRecord(
    ctx.shape,
    decodeRecords(
      { ...ctx, restores: await restoreHistory(tx) },
      await rowEvents(tx, ctx.table, id, o),
    ),
  );
}
