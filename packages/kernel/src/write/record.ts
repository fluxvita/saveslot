// A row's or entity's judged records and the events that keep them (docs/zh-CN/spec/09-event-format.md
// §5.7 `write.head`, `write.base`; §5.8 the pending item events), both ways.
//
// `judge` works on records (judge/model.ts): what the log keeps of each judgement. `encode*` turns
// one judged operation into the blocks of its events; `decodeRecords` reads a row's events back into
// the records, so that `write` can rebuild the state `judge` needs from the log. Pure functions:
// IDs, sources and sequence numbers come from the caller.
//
// Two things the log does not keep, by design: the raw value of a field judged a no-op, and a write
// whose fields were all no-ops (it has no `write.base` event, 04-write-and-read «一次写入的事件
// 构成»); neither plays a part in later judgements. `explicit` (the fields evidence_by_field points
// at) is `ops/<i>/explicit`: every key, the same value or not, as judge was given it.
//
// Not produced here, and by whom:
// - `write.head` `ctx`, `request`, `task`, `request_key` / `idempotency`, and `source.recorded`:
//   `write`, from the request.
// - The entry blocks of pending items (`current`, `previous`, `proposed`, `impact`,
//   `scope_valid`), and `item.refreshed` / `item.superseded`: `pending`, from the state and the
//   judgement. Here an item event carries its `target` and its `candidates/<k>` only.
// - What the caller decides and passes in: the IDs, the source seqs, the raw values, the intent of
//   each write (for a revert, 01-objects «各处理方式的执行语义»: the given intent, else that of the
//   undone operation's `write.base` with the greatest `seq` on this row; for take_previous, that of
//   the record's entry with the greatest event; `pending` and `write` compute it), the
//   `restore_count`, an item's candidate index and merge base, and its version (`item_op`).

import type {
  AckBlock,
  ContributionRef,
  EntityId,
  FieldId,
  Intent,
  ItemId,
  OpNumber,
  RawFieldValue,
  RowId,
  Seq,
  TableId,
  VerBasis,
} from "@fluxvita/saveslot-contract-core";
import type {
  AckStretch,
  ConfirmRecord,
  DecidedItem,
  ItemContent,
  ItemRef,
  ItemStatus,
  JudgeInput,
  Judgement,
  OpRecord,
  RecordedItem,
  RevertEntry,
  RevertRecord,
  TableShape,
  TakeCandidateRecord,
  Target,
  Unit,
  ValidParam,
  WriteRecord,
} from "../judge/index.ts";
import { uniqueRefs } from "../judge/index.ts";
import { type Interval, WHOLE } from "../time/index.ts";
import { WriteError } from "./errors.ts";
import type { LiteralResult } from "./literal.ts";

type Blocks = Record<string, unknown>;

/** The row or entity the records are about, and what of its table the mapping needs. */
export interface RowContext {
  readonly table: TableId;
  readonly target: { readonly row: RowId } | { readonly entity: EntityId };
  readonly shape: TableShape;
  /** State tables: the points are dates or instants; a write's "now" is `today` or `now` by it. */
  readonly granularity: "date" | "instant";
}

/** A stored event, parsed: its header fields this mapping reads, and its blocks by path. */
export interface StoredEvent {
  readonly header: { readonly type: string; readonly seq: Seq; readonly op?: OpNumber };
  readonly blocks: Readonly<Blocks>;
}

// --- values ------------------------------------------------------------------------------------

const refOut = (r: ItemRef): ContributionRef =>
  r.target === "existence"
    ? { event: r.event, existence: r.k }
    : { event: r.event, field: r.target, k: r.k };

function refIn(r: unknown): ItemRef {
  const x = r as { event: Seq; field?: FieldId; existence?: number; k?: number };
  return x.field !== undefined
    ? { event: x.event, target: x.field, k: x.k ?? 0 }
    : { event: x.event, target: "existence", k: x.existence ?? 0 };
}

/**
 * An item's interval as its span block writes it (09 §5.7): a missing end is open, so a write-back
 * taking back a revoke of the whole time, cut by another item, can be `{to}`. One interval per item.
 */
function spanOut(v: readonly Interval[]): { from?: string; to?: string } {
  const [x] = v;
  if (v.length !== 1 || x === undefined) {
    throw inconsistent("an item has one interval (09 §5.7 span)");
  }
  return { ...(x.from !== null ? { from: x.from } : {}), ...(x.to !== null ? { to: x.to } : {}) };
}

/** An existence item over the whole row or entity (a revoke without an interval). */
const isWhole = (v: readonly Interval[]) =>
  v.length === 1 && v[0]?.from === null && v[0]?.to === null;

function spanIn(v: unknown): Interval[] {
  const x = v as { from?: string; to?: string };
  return [{ from: x.from ?? null, to: x.to ?? null }] as Interval[];
}

/**
 * The log and what is encoded from it or decoded into it disagree: an internal error, as a write
 * error so that the caller gets one (not a bare exception), its message kept.
 */
const inconsistent = (message: string) =>
  new WriteError("internal", message, { reason: "inconsistent" });

const entryOut = (e: { event: Seq; target: Target }) =>
  e.target === "existence"
    ? { event: e.event, existence: true as const }
    : { event: e.event, field: e.target };

function entryIn(e: unknown): RevertEntry {
  const x = e as { event: Seq; field?: FieldId; later?: true };
  return {
    event: x.event,
    target: x.field ?? "existence",
    ...(x.later ? { later: true as const } : {}),
  };
}

const unitOut = (u: Unit): readonly string[] =>
  u === "existence" ? ["existence"] : [...u.fields].sort();
const unitIn = (u: readonly string[]): Unit =>
  u[0] === "existence" ? "existence" : { fields: u as FieldId[] };

// --- encoding ----------------------------------------------------------------------------------

/** What `encodeOp` needs beyond the judgement: where the op stands in its request and its log. */
export interface OpEncoding {
  readonly intent: Intent;
  /** The first creation of the row or entity (`created`, 09 §5.7): judge's `created`. */
  readonly created?: true;
  /** The op located its entity by `entity_key` (`by_entity_key`, 09 §5.7). */
  readonly byEntityKey?: true;
  /** The raw values the caller gave (`ops/<i>/set/<f>`, 09 §1.3), for every field it set. */
  readonly raw?: Readonly<Partial<Record<FieldId, RawFieldValue>>>;
  /** The `restore_count` of the version the op saw (`ver`, a candidate's `seen`). */
  readonly restoreCount: number;
  /** The schema version the request was written against. */
  readonly sv: number;
  /** Value sources of the items this op writes (the request's evidence, or its `api_call`). */
  readonly sources: readonly Seq[];
  readonly validSources?: readonly Seq[];
  readonly opSources?: readonly Seq[];
  /** By field, the sources `evidence_by_field` maps it to; a field not here has `sources`. */
  readonly fieldSources?: Readonly<Partial<Record<FieldId, readonly Seq[]>>>;
  /** The fields `evidence_by_field` points at, in the table's order (`ops/<i>/explicit`). */
  readonly explicit?: readonly FieldId[];
  /**
   * The literal check of a field's raw value against one of its sources (09 §5.7
   * `literal/<field>/<k>`, `literal@1`): written for each value item whose sources are source
   * data, a segment a source, in the order of its sources. Absent: no literal blocks.
   */
  readonly literal?: (field: FieldId, source: Seq) => LiteralResult;
  /**
   * The pending items the op's conflicts go to, by conflict: a new item, or an open one it joins,
   * with the index its candidate takes there (after the item's candidates so far, never reused)
   * and the item's merge base with it (the earliest `ver` of its candidates, 09 §5.8).
   */
  readonly conflictItems?: readonly {
    readonly item: ItemId;
    readonly merged?: true;
    readonly candidate: number;
    readonly mergeBase: OpNumber;
  }[];
  /** The `awaiting_confirmation` item of an op of high impact. */
  readonly awaitingItem?: ItemId;
  readonly versions: { readonly ruleset: number; readonly policy: number };
}

export interface EncodedOp {
  /** The op's `ops/<i>/*` blocks of the request's `write.head`. */
  readonly head: Blocks;
  /** Its `write.base` blocks; absent when the op wrote nothing (every field a no-op). */
  readonly base?: Blocks;
  /** Its pending item events, after the `write.base` event. */
  readonly items: readonly {
    readonly type: "item.created" | "item.merged";
    readonly blocks: Blocks;
  }[];
}

/**
 * The `ver` an op records (09 §5.7 `ops/<i>/target`): none on a creating op that saw the state just
 * before it, or on an undo without one (it may be left out); otherwise `explicit` as given,
 * `same_request` for a row an earlier op of the request created, `fallback` from the read log.
 */
function verOf(
  r: { op: OpNumber; seen: OpNumber; seenExplicit: boolean; seenCurrent?: true },
  omittable: boolean,
  restoreCount: number,
) {
  if (omittable && r.seen === r.op - 1 && !r.seenExplicit && r.seenCurrent !== true) {
    return undefined;
  }
  const basis: VerBasis = r.seenExplicit
    ? "explicit"
    : r.seen === r.op
      ? "same_request"
      : "fallback";
  if (r.seenCurrent === true && basis === "same_request") {
    throw inconsistent("a version from the same request is not marked current");
  }
  return {
    op: r.seen,
    restore_count: restoreCount,
    basis,
    ...(r.seenCurrent === true ? { current: true as const } : {}),
  };
}

function validOut(v: ValidParam) {
  if (v === "corrected_span")
    return { from: { mode: "corrected_span" }, to: { mode: "corrected_span" } };
  return { from: v.from, to: v.to };
}

function validIn(v: unknown): ValidParam {
  const x = v as { from: { mode: string }; to: { mode: string } };
  return x.from.mode === "corrected_span" ? "corrected_span" : (x as ValidParam);
}

function ackOut(a: AckStretch): AckBlock {
  const base = { field: a.field, valid: spanOut(a.valid), deps: a.deps.map(refOut) };
  return (
    a.noValue ? { ...base, no_value: true } : { ...base, value: a.value, op: a.op }
  ) as AckBlock;
}

function ackIn(b: unknown): AckStretch {
  const x = b as AckBlock & { no_value?: true };
  const base = { field: x.field, valid: spanIn(x.valid), deps: x.deps.map(refIn) };
  return "no_value" in x && x.no_value
    ? { ...base, noValue: true }
    : { ...base, value: x.value as never, op: x.op as OpNumber };
}

/** The item blocks of a record (`fields`, `sources`, `span`, `existence`). */
function itemsOut(
  ctx: RowContext,
  items: readonly RecordedItem[],
  sources: readonly Seq[],
  fieldSources?: Readonly<Partial<Record<FieldId, readonly Seq[]>>>,
  literal?: (field: FieldId, source: Seq) => LiteralResult,
): Blocks {
  const out: Blocks = {};
  const isState = ctx.shape.kind === "state";
  for (const x of items) {
    if (x.target === "existence") {
      // A revoke of the whole entity on a state table is `whole` too (09 §5.7): no span. A
      // write-back over the whole time (an undo's restore) has deps, which only a span block
      // carries: it is an interval, the whole time written `{}`.
      const interval = isState && (!isWhole(x.valid) || x.deps.length > 0);
      out[`existence/${x.k}`] = {
        status: x.status,
        scope: interval ? "interval" : "whole",
        ...(x.content.kind === "restore" ? { restored: true } : {}),
      };
      if (interval) {
        out[`span/existence/${x.k}`] = {
          valid: spanOut(x.valid),
          ...(x.deps.length > 0 ? { deps: x.deps.map(refOut) } : {}),
        };
      }
      continue;
    }
    const at = `${x.target}/${x.k}`;
    const c = x.content;
    out[`fields/${at}`] =
      c.kind === "value"
        ? { status: x.status, value: c.value }
        : c.kind === "no_value"
          ? { status: x.status, no_value: true }
          : { status: x.status, uncovered: true };
    if (c.kind === "value") {
      if (x.carried !== undefined && x.carried.length > 0) {
        // A carried item is not checked again: its check is the one of the item it carries.
        out[`sources/${at}`] = x.carried.map((r) => ({ kind: "value", carried: refOut(r) }));
      } else {
        const own = fieldSources?.[x.target as FieldId] ?? sources;
        out[`sources/${at}`] = own.map((s) => ({ kind: "value", source: s }));
        if (literal !== undefined && own.length > 0) {
          out[`literal/${at}`] = {
            segments: own.map((s) => ({ source: s, result: literal(x.target as FieldId, s) })),
          };
        }
      }
    }
    if (isState) {
      out[`span/${at}`] = {
        [x.status === "candidate" ? "seen_valid" : "valid"]: spanOut(x.valid),
        ...(x.deps.length > 0 ? { deps: x.deps.map(refOut) } : {}),
      };
    }
  }
  return out;
}

/**
 * The events of one op of a request (`write`, `revoke`, `undo`) on this row or entity: its
 * `ops/<i>/*` head blocks, its `write.base` blocks, and the pending items it opens or joins.
 */
export function encodeOp(
  ctx: RowContext,
  input: JudgeInput,
  j: Judgement,
  e: OpEncoding,
): EncodedOp {
  const r = j.record;
  if (r.kind !== "write" && r.kind !== "revoke" && r.kind !== "undo") {
    throw inconsistent("encodeOp encodes the ops of a request");
  }
  const i = r.index;
  const head: Blocks = {};
  const seen = {
    op: r.op,
    seen: r.seen ?? r.op - 1,
    seenExplicit: r.seenExplicit ?? false,
    ...(r.seenCurrent === true ? { seenCurrent: true as const } : {}),
  };
  // An insert has no `ver` (09 §5.7): it saw the state just before it, not explicitly.
  if (e.intent === "insert" && (seen.seen !== r.op - 1 || seen.seenExplicit)) {
    throw inconsistent("an insert has no ver: it sees the state just before it");
  }
  // Creating by key is a creation too: no `ver` (09 §5.7: 新增时没有 ver).
  const creates = e.byEntityKey === true && e.created === true;
  const ver =
    e.intent === "insert" ? undefined : verOf(seen, r.kind === "undo" || creates, e.restoreCount);
  head[`ops/${i}/target`] = {
    table: ctx.table,
    ...ctx.target,
    intent: e.intent,
    ...(e.byEntityKey ? { by_entity_key: true } : {}),
    ...(e.created ? { created: true } : {}),
    ...(ver !== undefined ? { ver } : {}),
  };
  if (input.kind === "write") {
    const noop = r.kind === "write" ? r.noop : [];
    for (const f of Object.keys(input.fields).sort() as FieldId[]) {
      if (noop.includes(f)) continue;
      // The value as the caller gave it (09 §1.3), never the canonical one in its place.
      if (e.raw === undefined || !Object.hasOwn(e.raw, f)) {
        throw inconsistent(`the raw value of ${f} is needed (ops/<i>/set)`);
      }
      head[`ops/${i}/set/${f}`] = e.raw[f] ?? null;
    }
    if (noop.length > 0) head[`ops/${i}/noop`] = [...noop];
    if (e.explicit !== undefined && e.explicit.length > 0)
      head[`ops/${i}/explicit`] = [...e.explicit];
    // A corroboration is a field pointed at: one not in the list would read back as a no-op.
    for (const x of r.kind === "write" ? r.items : []) {
      if (x.status === "corroborated" && !(e.explicit ?? []).includes(x.target as FieldId)) {
        throw inconsistent(`a corroboration of ${x.target} not in ops/${i}/explicit`);
      }
    }
  }
  if ((input.kind === "write" || input.kind === "revoke") && input.valid !== undefined) {
    head[`ops/${i}/valid`] = validOut(input.valid);
  } else if (input.kind === "write" && ctx.shape.kind === "state") {
    // A caller's write on a state table always has it (09 §5.7): apply reads its explicit ends.
    throw inconsistent(`a write to a state table has ops/${i}/valid`);
  }
  if (input.kind === "undo") {
    head[`ops/${i}/revert`] = { undo_op: input.target, include_later: input.includeLater === true };
  }
  if ("acknowledge" in input && input.acknowledge) head[`ops/${i}/acknowledge`] = ["overwrite"];

  const items: { type: "item.created" | "item.merged"; blocks: Blocks }[] = [];
  const written = r.items.length > 0 || r.kind === "undo";
  if (!written) return { head, items };

  const base: Blocks = {
    target: {
      table: ctx.table,
      ...ctx.target,
      intent: e.intent,
      sv: e.sv,
      ...(e.created ? { created: true } : {}),
      cause: "request",
      op_index: i,
    },
    ...itemsOut(ctx, r.items, e.sources, e.fieldSources, e.literal),
  };
  if (e.validSources !== undefined && e.validSources.length > 0)
    base["valid_sources"] = [...e.validSources];
  if (e.opSources !== undefined && e.opSources.length > 0) base["op_sources"] = [...e.opSources];
  r.ack.forEach((a, k) => {
    base[`ack/${k}`] = ackOut(a);
  });
  if (r.kind === "undo") {
    base["revert"] = {
      before_op: r.revert.before,
      items: r.revert.entries.map((x) => ({ ...entryOut(x), ...(x.later ? { later: true } : {}) })),
      ...(r.revert.skipped.length > 0
        ? { skipped: r.revert.skipped.map((x) => ({ ...entryOut(x), by_op: x.byOp })) }
        : {}),
    };
  }

  // Pending items: a conflict item per conflict (new, or joined), an awaiting item for high impact.
  const versions = { ruleset_version: e.versions.ruleset, policy_version: e.versions.policy };
  j.conflicts.forEach((c, n) => {
    const to = e.conflictItems?.[n];
    if (to === undefined) throw inconsistent("a conflict needs its pending item");
    const mine = c.items.map((ref) =>
      r.items.find((y) => y.target === ref.target && y.k === ref.k),
    );
    const cand = {
      event: r.event,
      intent: e.intent,
      seen: { op: r.seen ?? r.op - 1, restore_count: e.restoreCount },
      cause: "stale_write",
      items: c.items.map((ref, n) => {
        const x = mine[n];
        const valid =
          ctx.shape.kind === "state" && x !== undefined && !isWhole(x.valid)
            ? { valid: spanOut(x.valid) }
            : {};
        return ref.target === "existence"
          ? { existence: ref.k, ...valid }
          : {
              field: ref.target,
              k: ref.k,
              value: x?.content.kind === "value" ? x.content.value : null,
              ...valid,
            };
      }),
      // Each item, and what cut its interval (09 §5.8 `candidates/<k>`: its span's deps).
      deps: uniqueRefs([...c.items, ...mine.flatMap((x) => x?.deps ?? [])]).map(refOut),
    };
    items.push(
      to.merged
        ? {
            type: "item.merged",
            blocks: {
              target: {
                item: to.item,
                merge_base_op: to.mergeBase,
                origin_event: r.event,
                ...versions,
              },
              [`candidates/${to.candidate}`]: cand,
            },
          }
        : {
            type: "item.created",
            blocks: {
              target: {
                item: to.item,
                type: "conflict",
                reason: "stale_write",
                table: ctx.table,
                ...ctx.target,
                unit: unitOut(c.unit),
                merge_base_op: to.mergeBase,
                origin_event: r.event,
                ...versions,
              },
              [`candidates/${to.candidate}`]: cand,
            },
          },
    );
  });
  const awaiting = r.items.filter((x) => x.status === "awaiting");
  if (awaiting.length > 0) {
    if (e.awaitingItem === undefined)
      throw inconsistent("a write of high impact needs its pending item");
    const onExistence = awaiting.some((x) => x.target === "existence");
    const fields = [...new Set(awaiting.map((x) => x.target))].sort();
    items.push({
      type: "item.created",
      blocks: {
        target: {
          item: e.awaitingItem,
          type: "awaiting_confirmation",
          // ④ by taking later writes back, or by hiding them (09 §6); both: the first.
          reason:
            r.kind === "undo" && j.takesBack.length > 0
              ? "undo_includes_later"
              : r.kind === "undo" && j.hides.length > 0
                ? "undo_hides_later"
                : "overwrites_change_point",
          table: ctx.table,
          ...ctx.target,
          unit: onExistence ? ["existence"] : fields,
          origin_event: r.event,
          ...versions,
        },
      },
    });
  }
  return { head, base, items };
}

/** What `encodeResolution` needs beyond the judgement. */
export interface ResolutionEncoding {
  readonly item: ItemId;
  /** take_candidate: the index of the candidate taken in the item (`candidates/<k>`). */
  readonly candidate?: number;
  /** The intent of the write the resolution triggers. */
  readonly intent: Intent;
  readonly sv: number;
  /** The item's version the decision confirmed (`item_op`, `restore_count`, 09 §5.8). */
  readonly itemOp: OpNumber;
  readonly restoreCount: number;
  /** The value sources of the items the triggered write gives itself (not carried): `op_sources`. */
  readonly sources?: readonly Seq[];
}

export interface EncodedResolution {
  /** The `item.resolved` `target` block. */
  readonly target: Blocks;
  /** The `write.base` blocks of the write it triggers: confirm, take_candidate, take_previous. */
  readonly base?: Blocks;
}

/** The events of a person's decision on a pending item (§5.8 `item.resolved`). */
export function encodeResolution(
  ctx: RowContext,
  j: Judgement,
  e: ResolutionEncoding,
): EncodedResolution {
  const r = j.record;
  const decision =
    r.kind === "confirm" || r.kind === "reject" || r.kind === "keep_effective"
      ? r.kind
      : r.kind === "take_candidate" || r.kind === "take_previous"
        ? r.kind
        : undefined;
  if (decision === undefined) throw inconsistent("encodeResolution encodes decisions");
  const target: Blocks = {
    item: e.item,
    decision,
    ...(decision === "take_candidate" ? { candidate: e.candidate ?? 0 } : {}),
    item_op: e.itemOp,
    restore_count: e.restoreCount,
    via: "call",
  };
  if (r.kind === "reject" || r.kind === "keep_effective") return { target };
  const base: Blocks = {
    target: {
      table: ctx.table,
      ...ctx.target,
      intent: e.intent,
      sv: e.sv,
      cause: "resolve",
      item: e.item,
    },
    ...itemsOut(ctx, r.items, e.sources ?? []),
  };
  if (r.kind === "confirm" && r.revert !== undefined) {
    base["revert"] = {
      before_op: r.revert.before,
      items: r.revert.entries.map((x) => ({ ...entryOut(x), ...(x.later ? { later: true } : {}) })),
      ...(r.revert.skipped.length > 0
        ? { skipped: r.revert.skipped.map((x) => ({ ...entryOut(x), by_op: x.byOp })) }
        : {}),
    };
  }
  if (r.kind === "take_previous") {
    base["revert"] = {
      as_of_op: r.revert.mergeBase,
      item: e.item,
      items: r.revert.entries.map(entryOut),
    };
  }
  if (r.kind === "take_candidate") {
    base["take"] = {
      item: e.item,
      candidate: e.candidate ?? 0,
      merge_base_op: r.mergeBase,
      items: r.cover.map(entryOut),
    };
  }
  return { target, base };
}

// --- decoding ----------------------------------------------------------------------------------

/**
 * The event types the records come from; `source.recorded`, `item.refreshed` and `item.superseded`
 * carry none and are passed over (a refresh re-gives candidates only in the deletion phase).
 */
const DECODED_TYPES = new Set([
  "write.head",
  "write.base",
  "item.created",
  "item.merged",
  "item.refreshed",
  "item.superseded",
  "item.resolved",
  "source.recorded",
]);
const DECISIONS = new Set([
  "confirm",
  "reject",
  "keep_effective",
  "take_candidate",
  "take_previous",
]);

interface PendingItem {
  readonly type: string;
  readonly unit: Unit;
  readonly origin: Seq;
  /** Candidates by their index in the item (`candidates/<k>`), in order: (event, its items). */
  readonly candidates: { event: Seq; items: { field?: FieldId; k: number }[] }[];
}

/**
 * The records of a row's or entity's operations, from its events in log order: every `write.head`
 * and `item.resolved` of an operation on it, its `write.base` events and its pending item events.
 */
export function decodeRecords(ctx: RowContext, events: readonly StoredEvent[]): OpRecord[] {
  const isState = ctx.shape.kind === "state";
  const sorted = [...events].sort((a, b) => a.header.seq - b.header.seq);
  const heads = new Map<OpNumber, Readonly<Blocks>>();
  const resolutions = new Map<OpNumber, StoredEvent>();
  const items = new Map<ItemId, PendingItem>();
  const opOf = (x: StoredEvent): OpNumber => x.header.op ?? x.header.seq;

  for (const x of sorted) {
    const b = x.blocks;
    // A refresh re-giving candidates is the deletion phase's, not decoded here.
    const regives =
      x.header.type === "item.refreshed" && Object.keys(b).some((p) => p.startsWith("candidates/"));
    if (!DECODED_TYPES.has(x.header.type) || regives) {
      throw inconsistent(`decodeRecords does not handle ${x.header.type} (seq ${x.header.seq})`);
    }
    if (x.header.type === "write.head") heads.set(x.header.seq, b);
    if (x.header.type === "item.resolved") resolutions.set(opOf(x), x);
    if (x.header.type === "item.created" || x.header.type === "item.merged") {
      const t = b["target"] as { item: ItemId; type?: string; unit?: string[]; origin_event: Seq };
      const prior = items.get(t.item);
      const cands = Object.keys(b)
        .filter((p) => p.startsWith("candidates/"))
        .sort((p, q) => Number(p.split("/")[1]) - Number(q.split("/")[1]))
        .map((p) => {
          const c = b[p] as {
            event: Seq;
            items: { field?: FieldId; k?: number; existence?: number }[];
          };
          return {
            event: c.event,
            items: c.items.map((y) => ({
              ...(y.field ? { field: y.field } : {}),
              k: y.k ?? y.existence ?? 0,
            })),
          };
        });
      items.set(t.item, {
        type: prior?.type ?? t.type ?? "conflict",
        unit: prior?.unit ?? unitIn(t.unit ?? []),
        origin: prior?.origin ?? t.origin_event,
        candidates: [...(prior?.candidates ?? []), ...cands],
      });
    }
  }
  // A field candidate of an item on existence (the write met a revoke): `onExistence`, by
  // (event, field): a write's candidates on a unit are all in one item (09 §5.8 `candidates/<k>`),
  // so it holds for every item of that field, also for an index a deletion's replay gives later.
  const onExistence = new Set<string>();
  for (const it of items.values()) {
    if (it.unit !== "existence") continue;
    for (const c of it.candidates)
      for (const y of c.items) if (y.field !== undefined) onExistence.add(`${c.event}/${y.field}`);
  }

  // A conflict resolution's K, from the item's candidate blocks (`candidates/<k>`): the (event,
  // target) of each candidate item listed, in order. As judge records it (`DecidedItem`).
  const decidedIn = (it: PendingItem): DecidedItem[] => {
    const seen = new Map<string, DecidedItem>();
    for (const c of it.candidates) {
      for (const y of c.items) {
        const target = (y.field ?? "existence") as Target;
        seen.set(`${c.event}/${target}`, { event: c.event, target });
      }
    }
    return [...seen.values()].sort((a, b) => a.event - b.event || a.target.localeCompare(b.target));
  };

  const ctxOf = (op: OpNumber) => {
    const h = heads.get(op) ?? resolutions.get(op)?.blocks;
    const c = (h?.["ctx"] ?? {}) as {
      now: string;
      today: string;
      ruleset_version: number;
      policy_version?: number;
    };
    return {
      ruleset: c.ruleset_version,
      ...(c.policy_version !== undefined ? { policy: c.policy_version } : {}),
      now: (ctx.granularity === "date" ? c.today : c.now) as never,
    };
  };

  const itemsIn = (event: Seq, b: Readonly<Blocks>): RecordedItem[] => {
    const out: RecordedItem[] = [];
    for (const [p, v] of Object.entries(b)) {
      const m = /^fields\/(f\d+)\/(\d+)$/.exec(p);
      const ex = /^existence\/(\d+)$/.exec(p);
      if (m !== null) {
        const f = m[1] as FieldId;
        const k = Number(m[2]);
        const block = v as {
          status: ItemStatus;
          value?: unknown;
          no_value?: true;
          uncovered?: true;
        };
        const span = b[`span/${f}/${k}`] as
          | { valid?: unknown; seen_valid?: unknown; deps?: unknown[] }
          | undefined;
        const sources = (b[`sources/${f}/${k}`] ?? []) as { carried?: unknown }[];
        const carried = sources.filter((s) => s.carried !== undefined).map((s) => refIn(s.carried));
        const content: ItemContent =
          "value" in block
            ? { kind: "value", value: block.value as never }
            : block.no_value
              ? { kind: "no_value" }
              : { kind: "uncovered" };
        out.push({
          target: f,
          k,
          status: block.status,
          valid: isState ? spanIn(span?.valid ?? span?.seen_valid) : [WHOLE],
          content,
          ...(carried.length > 0 ? { carried } : {}),
          deps: (span?.deps ?? []).map(refIn),
          ...(onExistence.has(`${event}/${f}`) && block.status === "candidate"
            ? { onExistence: true as const }
            : {}),
        });
      } else if (ex !== null) {
        const k = Number(ex[1]);
        const block = v as { status: ItemStatus; restored?: true };
        const span = b[`span/existence/${k}`] as { valid: unknown; deps?: unknown[] } | undefined;
        out.push({
          target: "existence",
          k,
          status: block.status,
          // `whole` (no span): the whole row or entity, on a state table too.
          valid: span !== undefined ? spanIn(span.valid) : [WHOLE],
          content: block.restored ? { kind: "restore" } : { kind: "revoke" },
          deps: (span?.deps ?? []).map(refIn),
        });
      }
    }
    // As judge numbers them: by target, then index.
    return out.sort((a, c) => a.target.localeCompare(c.target) || a.k - c.k);
  };

  const acksIn = (b: Readonly<Blocks>): AckStretch[] =>
    Object.keys(b)
      .filter((p) => p.startsWith("ack/"))
      .sort((p, q) => Number(p.split("/")[1]) - Number(q.split("/")[1]))
      .map((p) => ackIn(b[p]));

  const revertIn = (rv: {
    before_op?: number;
    as_of_op?: number;
    items: unknown[];
    skipped?: unknown[];
  }) => ({
    entries: rv.items.map(entryIn),
    skipped: (rv.skipped ?? []).map((s) => {
      const x = s as { by_op: OpNumber };
      return { ...entryIn(s), byOp: x.by_op };
    }),
  });

  const records: OpRecord[] = [];
  for (const x of sorted) {
    const b = x.blocks;
    const op = opOf(x);
    const { ruleset, policy, now } = ctxOf(op);
    const versions = { ruleset, ...(policy !== undefined ? { policy } : {}) };
    if (x.header.type === "item.resolved") {
      const t = b["target"] as { item: ItemId; decision: string };
      const it = items.get(t.item);
      if (it === undefined) throw inconsistent(`no pending item ${t.item}`);
      if (!DECISIONS.has(t.decision))
        throw inconsistent(`decision ${t.decision} is not decoded here`);
      const base = { op, index: 0, event: x.header.seq, ...versions };
      if (t.decision === "reject") records.push({ ...base, kind: "reject", target: it.origin });
      if (t.decision === "keep_effective") {
        records.push({
          ...base,
          kind: "keep_effective",
          unit: it.unit,
          candidates: it.candidates.map((c) => c.event),
          decided: decidedIn(it),
        });
      }
      continue;
    }
    if (x.header.type !== "write.base") continue;
    const target = b["target"] as {
      intent: Intent;
      cause: string;
      op_index?: number;
      item?: ItemId;
    };
    const recItems = itemsIn(x.header.seq, b);
    const base = { op, index: target.op_index ?? 0, event: x.header.seq, ...versions };

    if (target.cause === "resolve") {
      const res = resolutions.get(op);
      const t = res?.blocks["target"] as { item: ItemId; decision: string } | undefined;
      const it = t === undefined ? undefined : items.get(t.item);
      if (t === undefined || it === undefined)
        throw inconsistent("a resolve write without its item");
      const candidates = it.candidates.map((c) => c.event);
      if (t.decision === "confirm") {
        const rv = b["revert"] as
          | { before_op: number; items: unknown[]; skipped?: unknown[] }
          | undefined;
        const rec: ConfirmRecord = {
          ...base,
          kind: "confirm",
          target: it.origin,
          items: recItems,
          ...(rv !== undefined ? { revert: { ...revertIn(rv), before: rv.before_op } } : {}),
        };
        records.push(rec);
      } else if (t.decision === "take_previous") {
        const rv = b["revert"] as { as_of_op: number; items: unknown[] };
        const rec: RevertRecord = {
          ...base,
          kind: "take_previous",
          status: "applied",
          decided: decidedIn(it),
          revert: {
            entries: rv.items.map(entryIn),
            mergeBase: rv.as_of_op,
            candidates,
            unit: it.unit,
            skipped: [],
          },
          items: recItems,
          ack: [],
        };
        records.push(rec);
      } else if (t.decision === "take_candidate") {
        const tk = b["take"] as { candidate: number; merge_base_op: number; items: unknown[] };
        const rec: TakeCandidateRecord = {
          ...base,
          kind: "take_candidate",
          unit: it.unit,
          candidates,
          take: it.candidates[tk.candidate]?.event as Seq,
          mergeBase: tk.merge_base_op,
          cover: tk.items.map((e) => {
            const { later: _, ...rest } = entryIn(e);
            return rest;
          }),
          items: recItems,
          decided: decidedIn(it),
        };
        records.push(rec);
      } else throw inconsistent(`a ${t.decision} writes nothing (seq ${x.header.seq})`);
      continue;
    }

    const head = heads.get(op);
    const i = base.index;
    const opTarget = head?.[`ops/${i}/target`] as
      | { ver?: { op: OpNumber; basis: VerBasis; current?: true } }
      | undefined;
    const ver = opTarget?.ver;
    const seen = ver === undefined ? op - 1 : ver.basis === "same_request" ? op : ver.op;
    const seenExplicit = ver?.basis === "explicit";
    // Judged once, at the write (09 §5.2): a replay takes it as recorded.
    const current = ver?.current === true ? { seenCurrent: true as const } : {};
    const revert = head?.[`ops/${i}/revert`] as { include_later: boolean } | undefined;
    const acknowledge = head?.[`ops/${i}/acknowledge`] !== undefined;
    const valid = head?.[`ops/${i}/valid`];
    if (revert !== undefined) {
      const rv = b["revert"] as { before_op: number; items: unknown[]; skipped?: unknown[] };
      const rec: RevertRecord = {
        ...base,
        kind: "undo",
        status: recItems.some((y) => y.status === "awaiting") ? "awaiting" : "applied",
        revert: { ...revertIn(rv), before: rv.before_op },
        items: recItems,
        seen,
        seenExplicit,
        ...current,
        ...(acknowledge ? { acknowledge: true as const } : {}),
        ...(revert.include_later ? { includeLater: true as const } : {}),
        ack: acksIn(b),
      };
      records.push(rec);
      continue;
    }
    const rec: WriteRecord = {
      ...base,
      kind: target.intent === "revoke" ? "revoke" : "write",
      seen,
      seenExplicit,
      ...current,
      ...(valid !== undefined ? { valid: validIn(valid) } : {}),
      now,
      ...(acknowledge && target.intent !== "revoke" ? { acknowledge: true as const } : {}),
      // The fields whose evidence the caller pointed at (`ops/<i>/explicit`), in judge's order
      // (judge sorts the field IDs as strings; the head lists them in the table's order).
      explicit: (target.intent === "revoke"
        ? []
        : ((head?.[`ops/${i}/explicit`] ?? []) as FieldId[])
      ).toSorted(),
      items: recItems,
      noop: target.intent === "revoke" ? [] : ((head?.[`ops/${i}/noop`] ?? []) as FieldId[]),
      ack: acksIn(b),
    };
    records.push(rec);
  }
  return records;
}
