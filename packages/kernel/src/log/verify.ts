// `verify` over the stored log (docs/zh-CN/spec/03-data-model/02-integrity-and-records.md
// «完整性与溯源»; 09-event-format §1.5, §3.3, §5.2; 04-contract-types §8.4 `LogVerifyResult`).
// Pure: the caller feeds the event rows in `seq` order and the content rows in any order.
//
// What it reports:
// - The header chain: each stored header text is canonical JCS, its `seq` is the row's, the first
//   event is the genesis event at `seq` 1 with 64 zeros as `prev_hash`, and every later
//   `prev_hash` is the SHA-256 of the previous header text. `seq` runs without gaps except where a
//   `tenant.restored` event explains one (§5.2: `restored_to` is the previous event, its own `seq`
//   is max(`restored_to`, `high_water`) + 1); those gaps are listed, not counted as breaks. The
//   stored `header_hash` must equal the hash of the stored header text: a header changed in place
//   breaks the chain at that event. Only when the hash column was changed with it does the break
//   show at the next event, whose `prev_hash` no longer matches. Only the first break is reported
//   (`broken_at`).
// - Content blocks: a present block whose checksum does not match its bytes, or a block with
//   neither content nor a removal mark, is a mismatch; a block removed by a tombstone is counted
//   apart (§3.3). Positions only, never content.
// - Index columns (02-architecture §8 `events`: type, actor, recorded time, operation number and
//   slot from the header; table, row or entity and referenced event from the `target` block):
//   events whose stored columns differ, listed apart and not counted as breaks — the derived index
//   is what is wrong, and it can be recomputed from the header and `target` (02-integrity-and-records
//   «完整性与溯源»). Positions only.
// - Required blocks (09 §5: the paths every event of its type has): a missing one is a mismatch at
//   that position. When `target` is missing the event's index columns are not checked. A missing
//   optional block cannot be found: nothing in the header says which blocks an event has.
// - Removal marks: `removed_by` must be a `deletion.executed` event whose `positions` list the
//   block; otherwise the block is a mismatch.
// - Content rows whose `seq` has no event are not reported.
// The event rows must be fed before the content rows (removal marks are checked against the
// tombstones seen among the events).

import {
  type EventType,
  GENESIS_PREV_HASH,
  type Seq,
  VOCABULARY,
  type VocabularyEntry,
} from "@fluxvita/saveslot-contract-core";
import { targetIndex } from "./build.ts";
import { decodeCanonical, sha256Hex } from "./encode.ts";

export interface LogVerifyResult {
  readonly events: number;
  readonly chain: { readonly intact: true } | { readonly intact: false; readonly broken_at: Seq };
  readonly checksum_mismatch: readonly { readonly seq: Seq; readonly path: string }[];
  /** Content blocks removed by a tombstone. */
  readonly removed: number;
  /** `seq` gaps a restore left; not breaks. */
  readonly gaps: readonly { readonly after: Seq; readonly before: Seq; readonly restore: Seq }[];
  /** Events whose index columns differ from their header or `target` block; not breaks. */
  readonly index_mismatch: readonly { readonly seq: Seq }[];
}

/** One row of `events`, with the `target` block's stored text (null when absent or removed). */
export interface StoredEventRow {
  readonly seq: Seq;
  readonly header: string;
  readonly header_hash: string;
  readonly type: string;
  readonly actor: string;
  readonly at: string;
  readonly op: Seq;
  readonly slot: string | null;
  readonly target_table: string | null;
  readonly target_row: string | null;
  readonly target_event: Seq | null;
  readonly target_body: string | null;
  /** Paths of every content row of this event, present or removed. */
  readonly paths: readonly string[];
  /** `deletion.executed` only: the stored text of its `positions` block (null when absent). */
  readonly positions_body: string | null;
}

/** One row of `content`. */
export interface StoredBlockRow {
  readonly seq: Seq;
  readonly path: string;
  readonly body: string | null;
  readonly checksum: string | null;
  readonly removed_by: Seq | null;
}

/**
 * The header chain (09 §1.5, §5.2), fed one header at a time in `seq` order: whether each header
 * links to the one before, and the `seq` gaps restores explain. Shared by `verify` over the stored
 * log and the check of an export file as an import reads it.
 */
export class HeaderChain {
  private prev: { seq: Seq; hash: string } | undefined;
  private readonly gapList: { after: Seq; before: Seq; restore: Seq }[] = [];

  /**
   * Whether the header `h`, whose JCS text hashes to `hash`, links to the previous one, the first
   * being the genesis event at `seq` 1. Records a restore's gap. The header becomes the previous
   * one either way.
   */
  link(seq: Seq, h: Readonly<Record<string, unknown>>, hash: string): boolean {
    const linked = this.linked(seq, h);
    this.prev = { seq, hash };
    return linked;
  }

  /** Makes the header the previous one without looking at its link (it is already a break). */
  pass(seq: Seq, hash: string): void {
    this.prev = { seq, hash };
  }

  /** `seq` gaps a restore left; not breaks. */
  get gaps(): readonly { readonly after: Seq; readonly before: Seq; readonly restore: Seq }[] {
    return this.gapList;
  }

  private linked(seq: Seq, h: Readonly<Record<string, unknown>>): boolean {
    const prev = this.prev;
    if (prev === undefined) {
      return seq === 1 && h["type"] === "tenant.genesis" && h["prev_hash"] === GENESIS_PREV_HASH;
    }
    if (h["prev_hash"] !== prev.hash) return false;
    if (seq === prev.seq + 1) {
      // 09 §5.2: an import's event follows the last imported event.
      return h["type"] !== "tenant.imported" || h["imported_upto"] === prev.seq;
    }
    if (h["type"] !== "tenant.restored") return false;
    const restoredTo = h["restored_to"];
    const highWater = h["high_water"];
    if (typeof restoredTo !== "number" || typeof highWater !== "number") return false;
    if (restoredTo !== prev.seq || seq !== Math.max(restoredTo, highWater) + 1) return false;
    this.gapList.push({ after: prev.seq, before: seq, restore: seq });
    return true;
  }
}

/** The paths every event of this type has (09 §5); none for a type the vocabulary does not know. */
export function requiredPaths(type: unknown): readonly string[] {
  const entries = (
    typeof type === "string" && Object.hasOwn(VOCABULARY, type) ? VOCABULARY[type as EventType] : []
  ) as readonly VocabularyEntry[];
  return entries.filter((e) => e.always).map((e) => e.path);
}

/** The positions a tombstone's `positions` block lists, as `seq/path`; malformed items are left out. */
export function tombstonePositions(positions: unknown): Set<string> {
  const listed = new Set<string>();
  if (Array.isArray(positions)) {
    for (const a of positions) {
      if (a !== null && typeof a === "object" && !Array.isArray(a)) {
        const { seq, path } = a as Record<string, unknown>;
        if (typeof seq === "number" && typeof path === "string") listed.add(`${seq}/${path}`);
      }
    }
  }
  return listed;
}

export class LogVerifier {
  private count = 0;
  private readonly chain = new HeaderChain();
  private brokenAt: Seq | undefined;
  private readonly mismatches: { seq: Seq; path: string }[] = [];
  private removedCount = 0;
  private readonly indexMismatch: { seq: Seq }[] = [];
  /** Tombstone `seq` → the positions it lists, as `seq/path`. */
  private readonly tombstones = new Map<Seq, Set<string>>();

  /** Feeds the next event row; rows must come in ascending `seq`. */
  addEvent(row: StoredEventRow): void {
    this.count++;
    const hash = sha256Hex(row.header);
    const decoded = decodeCanonical(row.header);
    const h =
      decoded !== undefined &&
      decoded !== null &&
      typeof decoded === "object" &&
      !Array.isArray(decoded)
        ? (decoded as Record<string, unknown>)
        : undefined;
    // A header that is not canonical JCS, or whose stored hash or `seq` is not its own, is a
    // break without its link being looked at; the next header links to its hash all the same.
    if (h === undefined || row.header_hash !== hash || h["seq"] !== row.seq) {
      this.chain.pass(row.seq, hash);
      this.brokenAt ??= row.seq;
    } else if (!this.chain.link(row.seq, h, hash)) {
      this.brokenAt ??= row.seq;
    }
    const type = h?.["type"];
    const present = new Set(row.paths);
    let targetMissing = false;
    for (const path of requiredPaths(type)) {
      if (!present.has(path)) {
        this.mismatches.push({ seq: row.seq, path });
        if (path === "target") targetMissing = true;
      }
    }
    // A header that is not canonical JCS breaks the chain; its index columns cannot be checked,
    // nor can they when the `target` block they come from is missing.
    if (h !== undefined && !targetMissing && !this.indexMatches(row, h)) {
      this.indexMismatch.push({ seq: row.seq });
    }
    if (type === "deletion.executed") {
      this.tombstones.set(
        row.seq,
        tombstonePositions(
          row.positions_body === null ? undefined : decodeCanonical(row.positions_body),
        ),
      );
    }
  }

  private indexMatches(row: StoredEventRow, h: Record<string, unknown>): boolean {
    const op = typeof h["op"] === "number" ? h["op"] : h["seq"];
    const target = targetIndex(
      row.target_body === null ? undefined : decodeCanonical(row.target_body),
    );
    return (
      row.type === h["type"] &&
      row.actor === h["actor"] &&
      row.at === h["at"] &&
      row.op === op &&
      row.slot === (h["slot"] ?? null) &&
      row.target_table === target.table &&
      row.target_row === target.row &&
      row.target_event === target.event
    );
  }

  /** Feeds a content row, in any order. */
  addBlock(row: StoredBlockRow): void {
    if (row.removed_by !== null) {
      const listed = this.tombstones.get(row.removed_by)?.has(`${row.seq}/${row.path}`) ?? false;
      if (row.body === null && row.checksum === null && listed) this.removedCount++;
      else this.mismatches.push({ seq: row.seq, path: row.path });
      return;
    }
    if (row.body === null || row.checksum === null || sha256Hex(row.body) !== row.checksum) {
      this.mismatches.push({ seq: row.seq, path: row.path });
    }
  }

  result(): LogVerifyResult {
    return {
      events: this.count,
      chain:
        this.brokenAt === undefined
          ? { intact: true }
          : { intact: false, broken_at: this.brokenAt },
      checksum_mismatch: [...this.mismatches].sort((a, b) =>
        a.seq !== b.seq ? a.seq - b.seq : a.path < b.path ? -1 : a.path > b.path ? 1 : 0,
      ),
      removed: this.removedCount,
      gaps: [...this.chain.gaps],
      index_mismatch: [...this.indexMismatch],
    };
  }
}
