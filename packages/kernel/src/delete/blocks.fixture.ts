// A model of the log's blocks for one row, for tests (09 §3.5, §5.7, §5.9): the blocks as written
// and each deletion's or cancellation's `restated/<k>`, in log order; each deletion's list of
// positions worked out when it is confirmed, from its replay alone (09 §3.5 rule 1), as the
// specification defines it and apart from the delete operation's code; a cancelled deletion's
// blocks no longer counting (§5.7). Used by replay-blocks.prop.test.ts and by the store's
// three-way comparison of a deletion written into the log.

import { itemsByRecords } from "../judge/fates.ts";
import type { ItemRef, OpRecord, Restatement, TableShape } from "../judge/model.ts";
import { cancellationResult, deletionResult } from "../judge/replay-deletion.ts";
import { type GivenBlock, givenByRecords, overlay, restatedDeps } from "../judge/restate.ts";
import { RowState } from "../judge/state.ts";

export const ref = (d: ItemRef) => `${d.event}/${d.target}/${d.k}`;
export const etOf = (d: { event: number; target: string }) => `${d.event}/${d.target}`;

/** A cancellation with no write since the deletion it cancels. */
export const NO_GRACE = {
  cancelledOp: Number.MAX_SAFE_INTEGER,
  coveredSince: Number.MAX_SAFE_INTEGER,
  keptEffective: new Set<string>(),
  effectiveSince: () => 0,
};

/** A block of the log: an item's block as written, or a deletion's or cancellation's restatement. */
export interface Block {
  readonly from: string;
  readonly kind: "written" | "confirm" | "cancel";
  readonly item: string;
  readonly b: GivenBlock;
  readonly r?: Restatement;
}

/** The log of one row: its records, and its deletion and cancellation events in turn. */
export class BlockModel {
  readonly table: TableShape;
  readonly records: readonly OpRecord[];
  readonly deletions = new Map<
    string,
    { deleted: ReadonlySet<string>; cancelled: boolean; positions: Set<Block> }
  >();
  readonly log: { kind: "confirm" | "cancel"; id: string; restated: readonly Restatement[] }[] = [];
  readonly blocks: Block[] = [];
  /** The deletion and cancellation events in turn, by deletion: `confirm D<i>` or `cancel D<i>`. */
  readonly trace: string[] = [];
  live: readonly OpRecord[];

  constructor(table: TableShape, records: readonly OpRecord[]) {
    this.table = table;
    this.records = records;
    this.live = records;
    for (const [et, bs] of givenByRecords(records))
      for (const b of bs)
        this.blocks.push({ from: "written", kind: "written", item: `${et}/${b.k}`, b });
  }

  /** What the deletions still pending take away, but `except`'s. */
  pending(except?: string): Set<string> {
    const out = new Set<string>();
    for (const [id, d] of this.deletions)
      if (!d.cancelled && id !== except) for (const k of d.deleted) out.add(k);
    return out;
  }

  /** The blocks last given, `gone` taken away; a cancelled deletion's and those in `skip` left out. */
  latest(gone: ReadonlySet<string>, skip: readonly string[] = []): Map<string, GivenBlock[]> {
    let m: Map<string, GivenBlock[]> = new Map(
      [...givenByRecords(this.records)].filter(([et]) => !gone.has(et)),
    );
    for (const e of this.log) {
      const off = this.deletions.get(e.id)?.cancelled === true || skip.includes(e.id);
      if (e.kind === "confirm" && off) continue;
      m = overlay(m, e.restated, gone, this.records);
    }
    return m;
  }

  items() {
    return itemsByRecords(new RowState(this.table, this.records));
  }

  /**
   * Deletion `id` confirmed: its event worked out with the deletions still pending, rule 2 told
   * what its own list clears; its list of positions from its replay alone (09 §3.5 rule 1): a block
   * as written of a contribution it deletes, a restatement of an item it deletes or restates, and
   * any block one of whose deps it deletes or restates, or a carried item of which it deletes or
   * restates as dropped.
   */
  confirm(id: string, deleted: ReadonlySet<string>): void {
    const before = this.pending();
    const pendingIds = [...this.deletions].filter(([, d]) => !d.cancelled).map(([x]) => x);
    const alone = deletionResult(
      this.table,
      this.records,
      deleted,
      new Set(),
      this.items(),
      () => [],
      this.latest(new Set(), pendingIds),
    ).replay.restated;
    const own = new Map(alone.map((r) => [ref(r.item), r]));
    const here = (d: ItemRef) => deleted.has(etOf(d));
    const dep = (d: ItemRef) => here(d) || own.has(ref(d));
    const carried = (d: ItemRef) => here(d) || own.get(ref(d))?.status === "dropped";
    const res = deletionResult(
      this.table,
      this.records,
      new Set([...before, ...deleted]),
      before,
      this.items(),
      () => [],
      this.latest(before),
      new Set(),
      // As the delete operation passes it: only with another deletion on the row.
      pendingIds.length > 0 ? { dep, carried } : undefined,
    );
    const positions = new Set<Block>();
    for (const blk of this.blocks) {
      const restates = blk.r !== undefined && dep(blk.r.item);
      if (
        (blk.kind === "written" && deleted.has(blk.item.slice(0, blk.item.lastIndexOf("/")))) ||
        restates ||
        blk.b.deps.some(dep) ||
        (blk.b.carried ?? []).some(carried)
      )
        positions.add(blk);
    }
    this.deletions.set(id, { deleted, cancelled: false, positions });
    this.trace.push(`confirm ${id}`);
    this.push("confirm", id, res.replay.restated);
    this.live = res.replay.records;
  }

  /** Deletion `id` cancelled, with no write since: its blocks no longer count (§5.7). */
  cancel(id: string): void {
    const d = this.deletions.get(id);
    if (d === undefined || d.cancelled) throw new Error(`no pending deletion ${id}`);
    const others = this.pending(id);
    // The items whose last interval block came from the cancelled deletion (09 §5.9 rule 3).
    const at = this.log.findIndex((e) => e.kind === "confirm" && e.id === id);
    const later = new Set(
      this.log
        .slice(at + 1)
        .filter((e) => !(e.kind === "confirm" && this.deletions.get(e.id)?.cancelled))
        .flatMap((e) => e.restated.map((r) => ref(r.item))),
    );
    const from = new Set(
      (this.log[at]?.restated ?? [])
        .filter((r) => r.status !== "dropped")
        .map((r) => ref(r.item))
        .filter((k) => !later.has(k)),
    );
    const back = cancellationResult(
      this.table,
      this.records,
      others,
      d.deleted,
      this.items(),
      this.latest(others, [id]),
      from,
      () => [],
      NO_GRACE,
    );
    this.deletions.set(id, { ...d, cancelled: true });
    this.trace.push(`cancel ${id}`);
    this.push("cancel", id, back.replay.restated);
    this.live = back.replay.records;
  }

  push(kind: "confirm" | "cancel", id: string, restated: readonly Restatement[]): void {
    this.log.push({ kind, id, restated });
    for (const r of restated) {
      const laid = overlay(new Map(), [r], new Set(), this.records).get(etOf(r.item))?.[0];
      const b: GivenBlock = laid ?? {
        k: r.item.k,
        status: r.status,
        valid: r.valid ?? [],
        deps: restatedDeps(r),
      };
      this.blocks.push({ from: id, kind, item: ref(r.item), b, r });
    }
  }

  /** Every deletion still pending carried out, replayed from an empty store: each item's last block. */
  fromEmpty(): string[] {
    const listed = new Set<Block>();
    for (const d of this.deletions.values())
      if (!d.cancelled) for (const p of d.positions) listed.add(p);
    const last = new Map<string, Block>();
    for (const blk of this.blocks) {
      if (blk.kind === "confirm" && this.deletions.get(blk.from)?.cancelled) continue;
      if (listed.has(blk)) continue;
      last.set(blk.item, blk);
    }
    const out: string[] = [];
    for (const [item, blk] of last) {
      if (blk.b.status === "dropped") continue;
      const valid = this.table.kind === "state" ? JSON.stringify(blk.b.valid) : "";
      out.push(`${item} ${blk.b.status} ${valid} ${blk.b.content?.kind ?? "?"}`);
    }
    return out.sort();
  }

  /** The live replay's items. */
  liveItems(): string[] {
    const out: string[] = [];
    for (const r of this.live) {
      if (!("items" in r)) continue;
      for (const x of r.items) {
        const valid = this.table.kind === "state" ? JSON.stringify(x.valid) : "";
        out.push(`${r.event}/${x.target}/${x.k} ${x.status} ${valid} ${x.content.kind}`);
      }
    }
    return out.sort();
  }
}
