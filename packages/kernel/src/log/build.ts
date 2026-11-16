// Building one operation's events before they are appended (docs/zh-CN/spec/09-event-format.md
// §1.5, §2, §3, §4.1; 02-architecture §7 «记录时刻»). Pure: given the log's tail and the events of
// one operation, it assigns `seq`, `op`, `at` and `prev_hash`, checks the header rules and the path
// vocabulary, and returns the rows to store. Nothing here reads storage.
//
// What the caller gives and what the log fills in:
// - The caller gives the operation's `actor` and the call context's `now`, and per event its type,
//   `slot`, `trigger`, the type-specific header fields (§2.1) and its content blocks by path.
// - The log fills in `seq` (the next one; for `tenant.restored`, max(`restored_to`, `high_water`)
//   + 1), `v` (1 for every type), `op` (the head event's `seq`, on every event but the head), `at`
//   (max(`now`, the previous event's `at`), the same on every event of the operation) and
//   `prev_hash` (the previous event's header hash; 64 zeros for the genesis event).
//
// The block contents are checked only for being JSON with a JCS form and for their paths: their
// shapes are checked by `apply`'s strict parser (§1.6), not here.

import {
  type EventType,
  GENESIS_PREV_HASH,
  type Hash,
  HEADER_RULES,
  type HeaderField,
  type Instant,
  isEventInteger,
  isId,
  isInstant,
  type JcsValue,
  type JsonValue,
  matchPath,
  type NodeId,
  type PrincipalId,
  type RestoreId,
  type Seq,
  type SlotId,
  type Trigger,
  VOCABULARY,
  type VocabularyEntry,
} from "@fluxvita/saveslot-contract-core";
import { encode } from "./encode.ts";

/** The last event of the log: what the next operation chains to. Undefined: the log is empty. */
export interface LogTail {
  readonly seq: Seq;
  readonly hash: Hash;
  readonly at: Instant;
}

/** One event of an operation, as the caller gives it. */
export interface NewEvent {
  readonly type: EventType;
  readonly slot?: SlotId;
  readonly trigger?: Trigger;
  readonly node_id?: NodeId;
  readonly restore_id?: RestoreId;
  readonly restore_count?: number;
  readonly restored_to?: Seq;
  readonly high_water?: Seq;
  readonly imported_upto?: Seq;
  /** Content blocks by path. Absent optional blocks are left out (§1.2). */
  readonly blocks: Readonly<Record<string, JsonValue>>;
}

/** One operation (§4.1): its first event is the head event, the rest carry its operation number. */
export interface NewOperation {
  readonly actor: PrincipalId;
  /** The call context's current time; the recorded time is max(now, the previous event's `at`). */
  readonly now: Instant;
  readonly events: readonly NewEvent[];
}

export interface PreparedBlock {
  readonly path: string;
  /** JCS text of the block. */
  readonly body: string;
  /** SHA-256 of `body`. */
  readonly checksum: Hash;
}

/** An event ready to be stored: the header's JCS text and hash, index columns and blocks. */
export interface PreparedEvent {
  readonly seq: Seq;
  readonly header: string;
  readonly hash: Hash;
  readonly type: EventType;
  readonly actor: PrincipalId;
  readonly at: Instant;
  /** The operation number; equals `seq` on the head event. */
  readonly op: Seq;
  readonly slot: SlotId | null;
  /** Index columns from the metadata block `target`, when the event has one. */
  readonly target: TargetIndex;
  readonly blocks: readonly PreparedBlock[];
}

export interface TargetIndex {
  readonly table: string | null;
  /** Row or entity ID. */
  readonly row: string | null;
  /** The referenced event: `origin_event` or `by_event`. */
  readonly event: Seq | null;
}

export interface PreparedOperation {
  /** The operation number: the head event's `seq`. */
  readonly op: Seq;
  readonly at: Instant;
  readonly events: readonly PreparedEvent[];
}

/** An operation the log refuses to append: a defect in the caller, not a user error. */
export class LogAppendError extends Error {
  override readonly name = "LogAppendError";
}

const BASE_FIELDS: ReadonlySet<HeaderField> = new Set([
  "seq",
  "v",
  "type",
  "actor",
  "at",
  "prev_hash",
  "op",
  "slot",
  "trigger",
]);
const EXTRA_FIELDS = [
  "node_id",
  "restore_id",
  "restore_count",
  "restored_to",
  "high_water",
  "imported_upto",
] as const satisfies readonly HeaderField[];

/** The `target` block's index columns (02-architecture §8 `events`). */
export function targetIndex(target: unknown): TargetIndex {
  if (target === null || typeof target !== "object" || Array.isArray(target)) {
    return { table: null, row: null, event: null };
  }
  const t = target as Record<string, unknown>;
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const num = (v: unknown) => (typeof v === "number" ? v : null);
  return {
    table: str(t["table"]),
    row: str(t["row"]) ?? str(t["entity"]),
    event: num(t["origin_event"]) ?? num(t["by_event"]),
  };
}

function actorAllowed(rule: string, actor: string): boolean {
  const user = isId("user", actor);
  const caller = user || isId("connection", actor);
  switch (rule) {
    case "user":
      return user;
    case "caller":
      return caller;
    case "system":
      return actor === "system";
    case "caller_or_system":
      return caller || actor === "system";
    default:
      return false;
  }
}

/** Checks one event's header fields against §2.1 and HEADER_RULES. */
function checkHeader(e: NewEvent, i: number, actor: PrincipalId): void {
  const rules = HEADER_RULES[e.type];
  if (rules === undefined) throw new LogAppendError(`event ${i}: unknown type "${String(e.type)}"`);
  const head = i === 0;
  const where = `event ${i} (${e.type})`;
  if (head) {
    if (rules.head === "member") throw new LogAppendError(`${where}: not a head event type`);
    if (rules.head === "either" && actor !== "system") {
      throw new LogAppendError(`${where}: a head event only when produced by system`);
    }
    const actorRule = rules.head === "either" ? "system" : rules.actor;
    if (!actorAllowed(actorRule, actor)) throw new LogAppendError(`${where}: actor not allowed`);
    if (actor === "system") {
      if (e.trigger === undefined || !(rules.triggers as readonly string[]).includes(e.trigger)) {
        throw new LogAppendError(`${where}: missing or unexpected trigger`);
      }
    } else if (e.trigger !== undefined) {
      throw new LogAppendError(`${where}: trigger only on head events by system`);
    }
  } else {
    if (rules.head === "head") throw new LogAppendError(`${where}: must be a head event`);
    if (e.trigger !== undefined) throw new LogAppendError(`${where}: trigger on a member event`);
  }
  if (rules.slot !== (e.slot !== undefined)) {
    throw new LogAppendError(`${where}: slot ${rules.slot ? "required" : "not allowed"}`);
  }
  if (e.slot !== undefined && !isId("slot", e.slot)) {
    throw new LogAppendError(`${where}: malformed slot ID`);
  }
  const extra = rules.extra as readonly HeaderField[];
  for (const f of EXTRA_FIELDS) {
    const present = e[f] !== undefined;
    if (present !== extra.includes(f)) {
      throw new LogAppendError(
        `${where}: header field ${f} ${present ? "not allowed" : "required"}`,
      );
    }
  }
  if (e.node_id !== undefined && !isId("node", e.node_id)) {
    throw new LogAppendError(`${where}: malformed node_id`);
  }
  if (e.restore_id !== undefined && !isId("restore", e.restore_id)) {
    throw new LogAppendError(`${where}: malformed restore_id`);
  }
  for (const f of ["restore_count", "restored_to", "high_water", "imported_upto"] as const) {
    if (e[f] !== undefined && !isEventInteger(e[f])) {
      throw new LogAppendError(`${where}: ${f} is not an event integer`);
    }
  }
}

/** Checks one event's blocks against the path vocabulary (§3.1, §5) and encodes them. */
function prepareBlocks(e: NewEvent, i: number): PreparedBlock[] {
  const where = `event ${i} (${e.type})`;
  const out: PreparedBlock[] = [];
  for (const [path, value] of Object.entries(e.blocks)) {
    if (value === undefined) continue;
    if (matchPath(e.type, path) === undefined) {
      throw new LogAppendError(`${where}: path "${path}" is not in the vocabulary`);
    }
    let encoded: { text: string; hash: string };
    try {
      encoded = encode(value as JcsValue);
    } catch (e) {
      throw new LogAppendError(`${where}: block "${path}" is not JSON: ${(e as Error).message}`);
    }
    out.push({ path, body: encoded.text, checksum: encoded.hash });
  }
  const entries = VOCABULARY[e.type] as readonly VocabularyEntry[];
  for (const entry of entries) {
    if (entry.always && e.blocks[entry.path] === undefined) {
      throw new LogAppendError(`${where}: block "${entry.path}" is required`);
    }
  }
  out.sort((a, b) => (a.path < b.path ? -1 : a.path > b.path ? 1 : 0));
  return out;
}

/** The recorded time: max(now, the previous event's `at`) (02-architecture §7 «记录时刻»). */
export function recordedAt(now: Instant, tail: LogTail | undefined): Instant {
  // The fixed-width UTC form sorts as text.
  return tail !== undefined && tail.at > now ? tail.at : now;
}

/**
 * Builds more events of an operation already appended, on top of `tail` (09-event-format §4.1: an
 * operation is all the events one transaction appends). `appended` is what the last append or
 * continuation of that operation returned; `tail` must still be its last event, so no other
 * operation came after it. The events are member events: `op` the operation number, the same
 * `actor`, `at` and slot. Returns only the new events, under the same `op` and `at`. Throws
 * LogAppendError on a defect.
 */
export function buildContinuation(
  tail: LogTail | undefined,
  appended: PreparedOperation,
  events: readonly NewEvent[],
): PreparedOperation {
  const last = appended.events[appended.events.length - 1];
  const first = appended.events[0];
  if (last === undefined || first === undefined) {
    throw new LogAppendError("an operation has at least one event");
  }
  if (events.length === 0) throw new LogAppendError("a continuation has at least one event");
  if (tail === undefined || tail.seq !== last.seq || tail.hash !== last.hash) {
    throw new LogAppendError(
      `the operation ${appended.op} is no longer the end of the log: another came after it`,
    );
  }
  events.forEach((e, k) => {
    const i = last.seq - appended.op + 1 + k;
    if (["tenant.genesis", "tenant.restored", "tenant.imported"].includes(e.type)) {
      throw new LogAppendError(`${e.type} is an operation of its own`);
    }
    checkHeader(e, i, first.actor);
    if ((e.slot ?? null) !== first.slot) {
      throw new LogAppendError(`event ${i} (${e.type}): slot differs from the head event's`);
    }
  });
  let seq = last.seq + 1;
  let prev: Hash = last.hash;
  const out = events.map((e, k) => {
    const prepared = prepareEvent(e, last.seq - appended.op + 1 + k, {
      seq,
      actor: first.actor,
      at: appended.at,
      prev,
      op: appended.op,
    });
    prev = prepared.hash;
    seq += 1;
    return prepared;
  });
  return { op: appended.op, at: appended.at, events: out };
}

/** One event's header, its JCS text and hash, index columns and blocks. */
function prepareEvent(
  e: NewEvent,
  i: number,
  at: { seq: Seq; actor: PrincipalId; at: Instant; prev: Hash; op: Seq },
): PreparedEvent {
  const blocks = prepareBlocks(e, i);
  const header: Record<string, JcsValue | undefined> = {
    seq: at.seq,
    v: 1,
    type: e.type,
    actor: at.actor,
    at: at.at,
    prev_hash: at.prev,
    op: i === 0 ? undefined : at.op,
    slot: e.slot,
    trigger: e.trigger,
  };
  for (const f of EXTRA_FIELDS) header[f] = e[f];
  for (const k of Object.keys(header)) {
    if (!BASE_FIELDS.has(k as HeaderField) && !(EXTRA_FIELDS as readonly string[]).includes(k)) {
      throw new LogAppendError(`unknown header field ${k}`);
    }
  }
  const { text, hash } = encode(header);
  return {
    seq: at.seq,
    header: text,
    hash,
    type: e.type,
    actor: at.actor,
    at: at.at,
    op: at.op,
    slot: e.slot ?? null,
    target: targetIndex(e.blocks["target"]),
    blocks,
  };
}

/** Builds the events of one operation on top of `tail`. Throws LogAppendError on a defect. */
export function buildOperation(tail: LogTail | undefined, input: NewOperation): PreparedOperation {
  const [first] = input.events;
  if (first === undefined) throw new LogAppendError("an operation has at least one event");
  if (!isInstant(input.now)) throw new LogAppendError("now is not an instant");
  if (!actorAllowed("caller_or_system", input.actor)) {
    throw new LogAppendError("actor is not a principal ID");
  }
  if ((first.type === "tenant.genesis") !== (tail === undefined)) {
    throw new LogAppendError(
      tail === undefined
        ? "the first event of a log is tenant.genesis"
        : "the log already has a genesis event",
    );
  }
  input.events.forEach((e, i) => {
    checkHeader(e, i, input.actor);
    // 09 §4.1, §5.10: the events of one operation share the head event's slot.
    if (i > 0 && e.slot !== first.slot) {
      throw new LogAppendError(`event ${i} (${e.type}): slot differs from the head event's`);
    }
  });
  for (const e of input.events.slice(1)) {
    if (["tenant.genesis", "tenant.restored", "tenant.imported"].includes(e.type)) {
      throw new LogAppendError(`${e.type} is an operation of its own`);
    }
  }

  let seq = (tail?.seq ?? 0) + 1;
  if (first.type === "tenant.restored") {
    // §5.2: the restored log's last event and the anchor's high water.
    if (first.restored_to !== tail?.seq) {
      throw new LogAppendError("restored_to must be the seq of the log's last event");
    }
    seq = Math.max(first.restored_to ?? 0, first.high_water ?? 0) + 1;
  }
  if (first.type === "tenant.imported" && first.imported_upto !== tail?.seq) {
    throw new LogAppendError("imported_upto must be the seq of the log's last event");
  }

  const at = recordedAt(input.now, tail);
  const op = seq;
  let prev: Hash = tail?.hash ?? GENESIS_PREV_HASH;
  const events: PreparedEvent[] = input.events.map((e, i) => {
    const prepared = prepareEvent(e, i, { seq, actor: input.actor, at, prev, op });
    prev = prepared.hash;
    seq += 1;
    return prepared;
  });
  return { op, at, events };
}
