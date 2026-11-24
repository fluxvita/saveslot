// What deleted source data take away (docs/zh-CN/spec/03-data-model/03-deletion.md «来源：值来源与
// 操作来源», «区间参数»; 09-event-format §5.7 `sources/<f>/<k>`, `valid_sources`): the (event,
// target) contributions a privacy deletion of some `source.recorded` events removes.
//
// - A field's contribution goes when any of its value sources is deleted: one write's sources of
//   one field are needed together («同一次写入里一个字段引用多段证据是"且"»). Only direct sources
//   count; a value carried from another contribution goes, or not, in the replay, by what it
//   carries.
// - Every target of a write or revoke goes when any source of its interval (`valid_sources`) is
//   deleted («区间的来源被删，这次写入在该实体上整体没有贡献»): a revoke over an interval has its
//   interval as its only content.
// - Operation sources (`op_sources`) take nothing away: they only satisfy K4 and the audit.
//
// Counted by (event, target), not by item: one event's items on one target have the same sources
// and always go together (09 §3.5 rule 1). Blocks already removed by a tombstone are not read: what
// they gave is gone already. Blocks a pending deletion lists are read: each deletion lists its
// positions in full (09 §5.9), and its replay counts every pending deletion's contributions.

import type { JsonValue, Seq } from "@fluxvita/saveslot-contract-core";
import type { Target } from "../judge/index.ts";
import { contributionKey } from "../judge/model.ts";
import type { ReadTx } from "../store/ports.ts";

/** What a `write.base` event cites, as its blocks say. */
export interface BaseCitations {
  readonly event: Seq;
  /** The operation it belongs to. */
  readonly op: Seq;
  /** `target.op_index`: the op of the write head it belongs to; none when a `resolve` made it. */
  readonly opIndex: number | null;
  readonly table: string;
  /** The row or entity. */
  readonly row: string;
  /** The targets it has items on: fields with `fields/<f>/<k>`, and `existence/<k>`. */
  readonly targets: readonly Target[];
  /** Each field's direct value sources (`sources/<f>/<k>` entries with `source`). */
  readonly values: ReadonlyMap<Target, readonly Seq[]>;
  /** `valid_sources`; none: the write gave no interval. */
  readonly valid: readonly Seq[] | null;
  /** `op_sources`. */
  readonly opSources: readonly Seq[];
}

/** The (event, target) contributions the deleted sources take away. Pure. */
export function takenAway(bases: readonly BaseCitations[], sources: ReadonlySet<Seq>): Set<string> {
  const out = new Set<string>();
  for (const b of bases) {
    const intervalGone = (b.valid ?? []).some((s) => sources.has(s));
    for (const t of b.targets) {
      if (intervalGone || (b.values.get(t) ?? []).some((s) => sources.has(s))) {
        out.add(contributionKey(b.event, t));
      }
    }
  }
  return out;
}

/** Whether a base write cites any of the sources at all: as a value, interval or operation source. */
export const cites = (b: BaseCitations, sources: ReadonlySet<Seq>): boolean =>
  (b.valid ?? []).some((s) => sources.has(s)) ||
  b.opSources.some((s) => sources.has(s)) ||
  [...b.values.values()].some((v) => v.some((s) => sources.has(s)));

type Obj = Readonly<Record<string, JsonValue>>;

/**
 * The `write.base` events of a slot after the earliest of the sources, with what they cite
 * (a source is always recorded before any write citing it). Reads `content` directly, not through
 * the log's block reads, on purpose: a block a pending deletion lists is still a citation here.
 * A full scan of the slot's later base writes: a deletion is rare, and no index maps a source to
 * the candidates and awaiting items citing it (`base_sources` holds items in effect only).
 */
export async function readCitations(
  tx: ReadTx,
  slot: string,
  sources: readonly Seq[],
): Promise<BaseCitations[]> {
  if (sources.length === 0) return [];
  const from = Math.min(...sources);
  const r = await tx.query<{ seq: unknown; op: unknown; path: string; body: string | null }>(
    `SELECT e.seq, e.op, c.path,
       CASE WHEN c.path LIKE 'fields/%' OR c.path LIKE 'existence/%' THEN NULL ELSE c.body END AS body
     FROM events e JOIN content c ON c.seq = e.seq
     WHERE e.type = 'write.base' AND e.slot = $1 AND e.seq > $2 AND c.body IS NOT NULL
       AND (c.path IN ('target', 'valid_sources', 'op_sources') OR c.path LIKE 'sources/%'
         OR c.path LIKE 'fields/%' OR c.path LIKE 'existence/%')
     ORDER BY e.seq, c.path COLLATE "C"`,
    [slot, from],
  );
  const by = new Map<
    number,
    {
      op: Seq;
      target?: Obj;
      targets: Set<Target>;
      values: Map<Target, Set<Seq>>;
      valid: Seq[] | null;
      opSources: Seq[];
    }
  >();
  for (const x of r.rows) {
    const seq = Number(x.seq);
    let e = by.get(seq);
    if (e === undefined) {
      e = { op: Number(x.op), targets: new Set(), values: new Map(), valid: null, opSources: [] };
      by.set(seq, e);
    }
    const body = x.body === null ? undefined : (JSON.parse(x.body) as JsonValue);
    if (x.path === "target") e.target = body as Obj;
    else if (x.path === "valid_sources") e.valid = body as Seq[];
    else if (x.path === "op_sources") e.opSources = body as Seq[];
    else if (/^existence\/\d+$/.test(x.path)) e.targets.add("existence");
    else {
      const f = /^fields\/(f\d+)\/\d+$/.exec(x.path);
      if (f !== null) {
        e.targets.add(f[1] as Target);
        continue;
      }
      const s = /^sources\/(f\d+)\/\d+$/.exec(x.path);
      if (s === null) continue;
      const set = e.values.get(s[1] as Target) ?? new Set<Seq>();
      for (const entry of body as Obj[]) {
        if (typeof entry["source"] === "number") set.add(entry["source"] as Seq);
      }
      e.values.set(s[1] as Target, set);
    }
  }
  return [...by.entries()].map(([event, e]) => {
    const t = e.target ?? {};
    return {
      event,
      op: e.op,
      opIndex: typeof t["op_index"] === "number" ? (t["op_index"] as number) : null,
      table: t["table"] as string,
      row: (t["row"] ?? t["entity"]) as string,
      targets: [...e.targets].sort(),
      values: new Map([...e.values].map(([k, v]) => [k, [...v].sort((a, b) => a - b)])),
      valid: e.valid,
      opSources: e.opSources,
    };
  });
}
