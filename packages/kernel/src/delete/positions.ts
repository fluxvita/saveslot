// A deletion's positions (docs/zh-CN/spec/09-event-format.md §5.9 `positions`, §3.5 rule 1):
// the content blocks a `deletion.confirmed` lists, to be read no more from the confirmation on and
// cleared when it falls due.
//
// By the rows of the §5.9 table:
//   1. the deleted sources' own blocks (`text`, `file`, `request`, `stated_at`);
//   2. the blocks of the contributions they take away: `fields/<t>/*`, `sources/<t>/*`,
//      `literal/<t>/*`, `span/<t>/*` of each (event, target), `span/existence/*` on existence;
//   3. the raw parameters and request identifiers of the operations that cite them: a write head's
//      `ops/<i>/set/<f>` by that field's value sources in op i, `ops/<i>/valid` by its interval's
//      sources, `ops/<i>/refs` by all of op i's evidence, `ops/<i>/premise_valid/<j>` without
//      `deps` as the block it comes from (§5.7: `given` all the op's evidence, `row_time` the
//      op's own time block); any head event's `task`, `request_key`, `idempotency` by every
//      source of the operation (§5.1). "All of op i's evidence" is its `api_call`, what its base
//      writes cite, and every other source the operation recorded (the request's evidence and the
//      ops' inline evidence, which the log does not tell apart: more, never less);
//   4. blocks whose `deps` name a contribution taken away (by (event, target), not by index) or a
//      restated item (by item, whatever it is restated as); `backfill/…` of a switch only by the
//      first (§3.5 rule 1's exception);
//   5. a `sources/<f>/<k>` carrying a contribution taken away or an item restated as `dropped`,
//      with the `fields/<f>/<k>` of the same item; a deletion event's `results/…` or
//      `restated/<k>` carrying one taken away or restated, as for `deps`;
//   6. what becomes invalid with them (§5.9 «随之失效的»): not worked out here yet, given by the
//      caller (`invalidated`) until the rule is set;
//   7. the event's own `summary`.
// Blocks of the deletion event itself are never listed besides its `summary`: what it gives
// is what holds after it. Blocks removed by a tombstone are not listed; blocks another pending
// deletion lists are (each deletion lists its own in full).
//
// `positionsOf` is pure; `readPositionIndex` reads what it needs. They read `content` and
// `block_deps` directly, not through the log's block reads, on purpose: a block a pending
// deletion lists is still listed here.

import type { JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import type { BlockAddress, Restatement, Target } from "../judge/index.ts";
import type { ReadTx } from "../store/ports.ts";
import { type BaseCitations, cites } from "./taken.ts";

/** A row of `block_deps` whose block is present: block `path` of `seq` rests on a contribution. */
export interface DepHit {
  readonly seq: Seq;
  readonly path: string;
  readonly event: Seq;
  /** Field ID, or `existence`. */
  readonly target: string;
  readonly k: number;
  readonly kind: "deps" | "carried";
}

/** A write head of an operation citing the sources, as the positions need it. */
export interface HeadBlocks {
  /** The operation number: the head's seq. */
  readonly op: Seq;
  /** Its present blocks' paths. */
  readonly paths: readonly string[];
  /** `ops/<i>/premises/<j>`'s `range`, by `"<i>/<j>"`, for each `premise_valid` there is. */
  readonly premiseRanges: ReadonlyMap<string, string>;
  /** Whether `ops/<i>/premise_valid/<j>` has `deps`, by `"<i>/<j>"`. */
  readonly premiseDeps: ReadonlySet<string>;
  /**
   * Where op `i`'s own business time is, by `i` (a `row_time` premise's source, §5.7): a state
   * table's `ops/<i>/valid`, or an event table's time field `ops/<i>/set/<field>`; none for a
   * timeless table. Only for a write head.
   */
  readonly timeBlock: ReadonlyMap<number, string>;
}

/** What `positionsOf` works on, read by `readPositionIndex`. */
export interface PositionIndex {
  /** The deleted sources' present data blocks (of `source.recorded` events only: a write head's
   * `request` is metadata of the same name). */
  readonly sourceBlocks: readonly BlockAddress[];
  /** The present block paths of each event with a contribution taken away. */
  readonly eventPaths: ReadonlyMap<Seq, readonly string[]>;
  /** Each `source.recorded` of the operations citing the sources, by operation. */
  readonly operationSources: ReadonlyMap<Seq, readonly Seq[]>;
  /**
   * The evidence of an operation not tied to one op (`source.recorded` other than an `api_call`):
   * the request's evidence and the ops' inline evidence, which the log does not tell apart.
   */
  readonly requestEvidence: ReadonlyMap<Seq, readonly Seq[]>;
  /** The `api_call` sources of a write's op (`target.op_index`), by `"<op>/<i>"`. */
  readonly apiCalls: ReadonlyMap<string, readonly Seq[]>;
  /** The base writes of the operations citing the sources (with every other base write the caller read). */
  readonly bases: readonly BaseCitations[];
  /** The write heads of those operations. */
  readonly heads: readonly HeadBlocks[];
  /** Dependency rows on the events with a contribution taken away or an item restated. */
  readonly deps: readonly DepHit[];
}

export interface PositionsInput {
  readonly sources: readonly Seq[];
  /** The (event, target) contributions taken away (./taken.ts `takenAway`). */
  readonly deleted: ReadonlySet<string>;
  /**
   * The restatements of this deletion's replay alone, of every row it lists: with no other deletion
   * pending, executed ones counted (09 §3.5 rule 1: what a deletion lists does not depend on the
   * others pending, so a cancellation of one leaves the others' lists as they are). With another
   * pending, they are not the event's `restated/<k>`, which are the replay's with them.
   */
  readonly restated: readonly Restatement[];
  readonly index: PositionIndex;
  /** The deletion event's own seq. */
  readonly self: Seq;
  /** §5.9 «随之失效的»: given by the caller until the rule is set. */
  readonly invalidated?: readonly BlockAddress[];
}

const SOURCE_PATHS = new Set(["text", "file", "request", "stated_at"]);
const HEAD_IDS = new Set(["task", "request_key", "idempotency"]);

const key = (event: Seq, target: string) => `${event}/${target}`;
const itemKey = (event: Seq, target: string, k: number) => `${event}/${target}/${k}`;

/** The positions of a deletion, sorted by (seq, path) and without duplicates. Pure. */
export function positionsOf(input: PositionsInput): BlockAddress[] {
  const { index, deleted, self } = input;
  const sources = new Set(input.sources);
  const out = new Map<string, BlockAddress>();
  const add = (seq: Seq, path: string) => {
    if (seq === self && path !== "summary") return; // its own blocks: never but `summary`
    out.set(`${seq} ${path}`, { seq, path });
  };
  const hit = (xs: readonly Seq[] | undefined) => (xs ?? []).some((s) => sources.has(s));

  // 1. The deleted sources' own blocks.
  for (const b of index.sourceBlocks) if (SOURCE_PATHS.has(b.path)) add(b.seq, b.path);

  // 2. The blocks of the contributions taken away.
  const ofTarget = (t: string) =>
    t === "existence"
      ? /^span\/existence\/\d+$/
      : new RegExp(`^(fields|sources|literal|span)/${t}/\\d+$`);
  for (const k of deleted) {
    const [ev, t] = k.split("/") as [string, string];
    const re = ofTarget(t);
    for (const p of index.eventPaths.get(Number(ev)) ?? []) if (re.test(p)) add(Number(ev), p);
  }

  // 3. The raw parameters and identifiers of the operations citing the sources.
  const citing = index.bases.filter((b) => cites(b, sources));
  const ops = new Set<Seq>(citing.map((b) => b.op));
  for (const [op, xs] of index.operationSources) if (hit(xs)) ops.add(op);
  for (const h of index.heads) {
    if (!ops.has(h.op)) continue;
    // The operation cites a deleted source (it is in `ops`): its identifiers go (§5.1).
    for (const p of h.paths) if (HEAD_IDS.has(p)) add(h.op, p);
    const basesOf = (i: number) => index.bases.filter((b) => b.op === h.op && b.opIndex === i);
    const evidence = (i: number) => [
      ...basesOf(i).flatMap(allCited),
      ...(index.apiCalls.get(`${h.op}/${i}`) ?? []),
      ...(index.requestEvidence.get(h.op) ?? []),
    ];
    const listed = new Set<string>();
    const listIf = (p: string, yes: boolean) => {
      if (!yes) return;
      listed.add(p);
      add(h.op, p);
    };
    // set and valid first: a premise's own business time comes from one of them.
    for (const p of h.paths) {
      const set = /^ops\/(\d+)\/set\/(f\d+)$/.exec(p);
      if (set !== null) {
        const i = Number(set[1]);
        const field = set[2] as Target;
        const own = basesOf(i).filter((b) => b.values.has(field));
        // A key field's value is recorded only where the key is given: by all the op's evidence.
        listIf(
          p,
          hit(own.length > 0 ? own.flatMap((b) => b.values.get(field) ?? []) : evidence(i)),
        );
        continue;
      }
      const valid = /^ops\/(\d+)\/valid$/.exec(p);
      if (valid !== null) {
        const i = Number(valid[1]);
        const given = basesOf(i).filter((b) => b.valid !== null);
        listIf(p, hit(given.length > 0 ? given.flatMap((b) => b.valid ?? []) : evidence(i)));
        continue;
      }
      const refs = /^ops\/(\d+)\/refs$/.exec(p);
      if (refs !== null) listIf(p, hit(evidence(Number(refs[1]))));
    }
    for (const p of h.paths) {
      const pv = /^ops\/(\d+)\/premise_valid\/(\d+)$/.exec(p);
      if (pv === null) continue;
      const ij = `${pv[1]}/${pv[2]}`;
      if (h.premiseDeps.has(ij)) continue; // by its deps (4.)
      const i = Number(pv[1]);
      const range = h.premiseRanges.get(ij);
      // `given`: all the op's evidence. `row_time` from the op's own writing: as that block (§5.7).
      const time = h.timeBlock.get(i);
      listIf(p, range === "row_time" ? time !== undefined && listed.has(time) : hit(evidence(i)));
    }
  }

  // 4 and 5. By the dependency index.
  const restated = new Set(
    input.restated.map((r) => itemKey(r.item.event, r.item.target, r.item.k)),
  );
  const dropped = new Set(
    input.restated
      .filter((r) => r.status === "dropped")
      .map((r) => itemKey(r.item.event, r.item.target, r.item.k)),
  );
  for (const d of index.deps) {
    const gone = deleted.has(key(d.event, d.target));
    const re = restated.has(itemKey(d.event, d.target, d.k));
    const carriedSources = /^sources\/(f\d+)\/(\d+)$/.exec(d.path);
    if (d.kind === "carried" && carriedSources !== null) {
      if (gone || dropped.has(itemKey(d.event, d.target, d.k))) {
        add(d.seq, d.path);
        add(d.seq, `fields/${carriedSources[1]}/${carriedSources[2]}`);
      }
      continue;
    }
    if (/^backfill\//.test(d.path)) {
      if (gone) add(d.seq, d.path);
      continue;
    }
    if (gone || re) add(d.seq, d.path);
  }

  // 6 and 7.
  for (const b of input.invalidated ?? []) add(b.seq, b.path);
  add(self, "summary");

  return [...out.values()].sort((a, b) => a.seq - b.seq || cmp(a.path, b.path));
}

/** Code-point order, as the log orders paths (`COLLATE "C"`). */
const cmp = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);

/** Every source a base write cites directly. */
const allCited = (b: BaseCitations): Seq[] => [
  ...[...b.values.values()].flat(),
  ...(b.valid ?? []),
  ...b.opSources,
];

type Obj = Readonly<Record<string, JsonValue>>;

/** Pairs grouped by their key, in order, once. */
function group<K, V>(pairs: Iterable<readonly [K, V]>): Map<K, V[]> {
  const out = new Map<K, V[]>();
  for (const [k, v] of pairs) {
    const list = out.get(k);
    if (list === undefined) out.set(k, [v]);
    else list.push(v);
  }
  return out;
}

/**
 * The time of each table of the slot (its rows' own business time, for `row_time` premises), by
 * schema version: a write is read in the version its request names (`request.sv`), whose table
 * may have another time than the current one.
 */
async function tablesOf(
  tx: ReadTx,
  slot: string,
): Promise<Map<number, Map<string, { type: string; field?: string }>>> {
  const out = new Map<number, Map<string, { type: string; field?: string }>>();
  const r = await tx.query<{ sv: unknown; body: string }>(
    `SELECT v.sv, c.body FROM schema_versions v JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = $1`,
    [slot],
  );
  for (const x of r.rows) {
    const byTable = new Map<string, { type: string; field?: string }>();
    for (const t of (JSON.parse(x.body) as { tables: Obj[] }).tables) {
      const time = t["time"] as Obj;
      byTable.set(t["id"] as string, {
        type: time["type"] as string,
        ...(typeof time["field"] === "string" ? { field: time["field"] } : {}),
      });
    }
    out.set(Number(x.sv), byTable);
  }
  return out;
}

/**
 * Reads the index `positionsOf` works on, in the deletion's transaction. `bases`: the base writes
 * the caller read for `takenAway` (./taken.ts `readCitations`); `deleted` and `restated` as for
 * `positionsOf`.
 */
export async function readPositionIndex(
  tx: ReadTx,
  input: {
    /** The slot the deletion is in (09 §5.9: one slot a deletion). */
    readonly slot: string;
    readonly sources: readonly Seq[];
    readonly bases: readonly BaseCitations[];
    readonly deleted: ReadonlySet<string>;
    readonly restated: readonly Restatement[];
  },
): Promise<PositionIndex> {
  const sources = [...new Set(input.sources)];
  const srcSet = new Set(sources);
  const sourceBlocks = (
    await tx.query<{ seq: unknown; path: string }>(
      `SELECT c.seq, c.path FROM events e JOIN content c ON c.seq = e.seq
       WHERE e.type = 'source.recorded' AND e.seq = ANY($1)
         AND c.path IN ('text', 'file', 'request', 'stated_at') AND c.body IS NOT NULL`,
      [sources as never],
    )
  ).rows.map((r) => ({ seq: Number(r.seq), path: r.path }));

  const deletedEvents = [...new Set([...input.deleted].map((k) => Number(k.split("/")[0])))];
  const eventPaths = group(
    (
      await tx.query<{ seq: unknown; path: string }>(
        `SELECT seq, path FROM content WHERE seq = ANY($1) AND body IS NOT NULL
         ORDER BY seq, path COLLATE "C"`,
        [deletedEvents as never],
      )
    ).rows.map((r) => [Number(r.seq), r.path] as const),
  );

  // The operations: of the deleted sources, and of the base writes citing them.
  const ofSources = (
    await tx.query<{ op: unknown }>("SELECT DISTINCT op FROM events WHERE seq = ANY($1)", [
      sources as never,
    ])
  ).rows.map((r) => Number(r.op));
  const ops = [
    ...new Set([...ofSources, ...input.bases.filter((b) => cites(b, srcSet)).map((b) => b.op)]),
  ];
  const recorded = (
    await tx.query<{ seq: unknown; op: unknown; body: string | null }>(
      `SELECT e.seq, e.op, c.body FROM events e
       LEFT JOIN content c ON c.seq = e.seq AND c.path = 'target'
       WHERE e.type = 'source.recorded' AND e.op = ANY($1) ORDER BY e.seq`,
      [ops as never],
    )
  ).rows.map((r) => {
    const t = r.body === null ? undefined : (JSON.parse(r.body) as Obj);
    const api = t?.["kind"] === "api_call";
    return { op: Number(r.op), seq: Number(r.seq), api, index: t?.["op_index"] };
  });
  const operationSources = group(recorded.map((r) => [r.op, r.seq] as const));
  const requestEvidence = group(recorded.filter((r) => !r.api).map((r) => [r.op, r.seq] as const));
  const apiCalls = group(
    recorded
      .filter((r) => r.api && typeof r.index === "number")
      .map((r) => [`${r.op}/${r.index as number}`, r.seq] as const),
  );

  // The head events of those operations, of any type: a write head's ops, and any head's
  // request identifiers (§5.1). Where each op's own business time is, from the table it writes.
  const headRows = (
    await tx.query<{ seq: unknown; path: string; body: string | null }>(
      `SELECT c.seq, c.path,
         CASE WHEN c.path LIKE 'ops/%/premises/%' OR c.path LIKE 'ops/%/premise_valid/%'
           OR c.path LIKE 'ops/%/target' OR c.path = 'request' THEN c.body ELSE NULL END AS body
       FROM events e JOIN content c ON c.seq = e.seq
       WHERE e.seq = ANY($1) AND e.seq = e.op AND c.body IS NOT NULL
       ORDER BY c.seq, c.path COLLATE "C"`,
      [ops as never],
    )
  ).rows;
  const tables = await tablesOf(tx, input.slot);
  const heads: HeadBlocks[] = [];
  for (const [op, rows] of group(headRows.map((r) => [Number(r.seq), r] as const))) {
    const premiseRanges = new Map<string, string>();
    const premiseDeps = new Set<string>();
    const timeBlock = new Map<number, string>();
    // The version the request was read in: a write head's `request.sv`.
    const request = rows.find((r) => r.path === "request");
    const sv = request?.body == null ? undefined : (JSON.parse(request.body) as Obj)["sv"];
    const ofVersion = typeof sv === "number" ? tables.get(sv) : undefined;
    for (const r of rows) {
      if (r.body === null) continue;
      const b = JSON.parse(r.body) as Obj;
      const target = /^ops\/(\d+)\/target$/.exec(r.path);
      if (target !== null) {
        const i = Number(target[1]);
        const time = ofVersion?.get(b["table"] as string);
        if (time?.type === "state") timeBlock.set(i, `ops/${i}/valid`);
        else if (time?.type === "event") timeBlock.set(i, `ops/${i}/set/${time.field}`);
        continue;
      }
      const m = /^ops\/(\d+)\/(premises|premise_valid)\/(\d+)$/.exec(r.path);
      if (m === null) continue;
      const ij = `${m[1]}/${m[3]}`;
      if (m[2] === "premises") premiseRanges.set(ij, b["range"] as string);
      else if (Array.isArray(b["deps"]) && b["deps"].length > 0) premiseDeps.add(ij);
    }
    heads.push({ op, paths: rows.map((r) => r.path), premiseRanges, premiseDeps, timeBlock });
  }

  // Dependency rows on the events touched: by (event, target) for the deleted, by item for the
  // restated; `positionsOf` tells them apart.
  const depEvents = [...new Set([...deletedEvents, ...input.restated.map((r) => r.item.event)])];
  const deps = (
    await tx.query<{
      seq: unknown;
      path: string;
      dep_event: unknown;
      dep_field: string;
      dep_k: number;
      dep_kind: "deps" | "carried";
    }>(
      `SELECT d.seq, d.path, d.dep_event, d.dep_field, d.dep_k, d.dep_kind
       FROM block_deps d JOIN content c ON c.seq = d.seq AND c.path = d.path
       WHERE d.dep_event = ANY($1) AND c.body IS NOT NULL`,
      [depEvents as never],
    )
  ).rows.map((r) => ({
    seq: Number(r.seq),
    path: r.path,
    event: Number(r.dep_event),
    target: r.dep_field,
    k: Number(r.dep_k),
    kind: r.dep_kind,
  }));

  return {
    sourceBlocks,
    eventPaths,
    operationSources,
    requestEvidence,
    apiCalls,
    bases: input.bases,
    heads,
    deps,
  };
}

/**
 * The positions a `deletion.confirmed` lists, as its block gives them (§5.9), by the deletion's
 * event seq; none when the event is not there or its `positions` block was removed. For the
 * deletion replay's «列在位置列表里» as much as for the grace period's reads.
 */
export async function readDeletionPositions(
  tx: ReadTx,
  seqs: readonly Seq[],
): Promise<Map<Seq, BlockAddress[]>> {
  const out = new Map<Seq, BlockAddress[]>();
  if (seqs.length === 0) return out;
  const r = await tx.query<{ seq: unknown; body: string | null }>(
    `SELECT c.seq, c.body FROM events e JOIN content c ON c.seq = e.seq AND c.path = 'positions'
     WHERE e.type = 'deletion.confirmed' AND e.seq = ANY($1) AND c.body IS NOT NULL`,
    [[...seqs] as never],
  );
  for (const x of r.rows) {
    const list = JSON.parse(x.body as string) as { seq: Seq; path: string }[];
    out.set(
      Number(x.seq),
      list.map((p) => ({ seq: p.seq, path: p.path })),
    );
  }
  return out;
}
