// The check of an export file as an import reads it (docs/zh-CN/spec/02-architecture.md §8
// «格式版本、导出、导入与恢复» step ①; 09-event-format §3.3, §8; 04-contract-types §9
// `import_rejected`). The same checks as `log.verify`, on the file instead of the stored log, line
// by line as the file comes in: the first problem stops the import.
//
// The file is NDJSON. Each segment is a manifest followed by its events; segments cut by `after`
// follow one another in the same body, each continuing where the one before ended. What is checked:
// - each line is its own JCS text (§8: every line is JCS): no other spacing, line end or key order,
//   no key twice;
// - the manifest: export format 1 and event format 1 in every segment (another is
//   `unsupported_format`), the keys of their types; the first segment starts at the beginning (no
//   `after`) and holds at least the genesis event; each later one continues at the previous
//   segment's `upto`, of the first's tenant ID and a restore count not below the previous one's;
// - a `target` block's event positions, where numbers, are counts: they go into an index column;
// - each event header is one of the format (§2.1: its fields, their types, its type's rules)
//   before anything is computed from it;
// - the header chain across all segments (`HeaderChain`, shared with verify): the first event is
//   the genesis event, every `prev_hash` is the hash of the previous header's JCS bytes, a `seq`
//   gap is explained by the `tenant.restored` after it;
// - each block in one of the three states (§3.3); a present block's checksum matches the JCS bytes
//   of its content; a removed block is listed by the tombstone it names, a placeholder by the
//   `deletion.confirmed` it names, each coming after it in the file; every block the event's type
//   always has is there;
// - each segment holds as many events as its manifest says, ending at its `upto`.
// Problems are reported by position only (`seq`, and `path` when it is a path of the event type's
// vocabulary), never by content: the messages are fixed texts.

import {
  canonicalize,
  type ExportManifest,
  isEventHeader,
  type JcsValue,
  type JsonValue,
  matchPath,
  type Seq,
} from "@fluxvita/saveslot-contract-core";
import { sha256Hex } from "./encode.ts";
import { HeaderChain, requiredPaths, tombstonePositions } from "./verify.ts";

/** 04-contract-types §9: the reasons of `import_rejected`. */
export type ImportRejection =
  | "unsupported_format"
  | "not_from_start"
  | "segment_order"
  | "chain_broken"
  | "checksum_mismatch"
  | "incomplete"
  | "replay_failed";

export class ImportRejected extends Error {
  readonly reason: ImportRejection;
  readonly seq: Seq | undefined;
  readonly path: string | undefined;
  constructor(
    reason: ImportRejection,
    message: string,
    at: { readonly seq?: Seq; readonly path?: string } = {},
  ) {
    super(message);
    this.name = "ImportRejected";
    this.reason = reason;
    this.seq = at.seq;
    this.path = at.path;
  }
}

/** A block of an event line in one of its three states (09 §3.3). */
export type ExportedBlock =
  | {
      readonly path: string;
      readonly state: "present";
      readonly value: JsonValue;
      readonly sum: string;
    }
  | { readonly path: string; readonly state: "removed"; readonly by: Seq }
  | { readonly path: string; readonly state: "placeholder"; readonly of: Seq };

/** One event of the file, checked, with its header's JCS text and hash. */
export interface ExportedEvent {
  readonly seq: Seq;
  readonly header: Readonly<Record<string, JsonValue>>;
  /** The header's JCS text: the bytes the chain hashes. */
  readonly text: string;
  readonly hash: string;
  readonly blocks: readonly ExportedBlock[];
}

/** What the whole file held, once its end is reached and checked. */
export interface ExportFileSummary {
  /**
   * The first segment's manifest, but its restore count the last segment's: the count when the
   * last segment was exported (§8). The export time and the pending deletions are the first's.
   */
  readonly manifest: ExportManifest;
  /** The last event's `seq`. */
  readonly upto: Seq;
  readonly events: number;
  readonly segments: number;
}

type Obj = Record<string, unknown>;

const isObj = (v: unknown): v is Obj => v !== null && typeof v === "object" && !Array.isArray(v);
const isCount = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 0;
const isSeq = (v: unknown): v is number => Number.isSafeInteger(v) && (v as number) >= 1;

const MANIFEST_KEYS = new Set([
  "saveslot_export",
  "tenant_id",
  "event_format",
  "restore_count",
  "after",
  "upto",
  "events",
  "exported_at",
  "pending_deletions",
]);

/** The manifest of a line, or undefined when the line is not a manifest of format 1. */
function manifestOf(v: Obj): ExportManifest | undefined {
  if (Object.keys(v).some((k) => !MANIFEST_KEYS.has(k))) return undefined;
  const ok =
    v["saveslot_export"] === 1 &&
    v["event_format"] === 1 &&
    typeof v["tenant_id"] === "string" &&
    isCount(v["restore_count"]) &&
    (v["after"] === undefined || isSeq(v["after"])) &&
    isCount(v["upto"]) &&
    isCount(v["events"]) &&
    typeof v["exported_at"] === "string" &&
    (v["pending_deletions"] === "placeholder" || v["pending_deletions"] === "included");
  return ok ? (v as unknown as ExportManifest) : undefined;
}

/** Whether the event positions a `target` value holds, where they are numbers, are counts. */
function positionsAreCounts(v: unknown): boolean {
  if (!isObj(v)) return true;
  return ["origin_event", "by_event"].every((k) => typeof v[k] !== "number" || isCount(v[k]));
}

/** A block's state as the file writes it, or undefined when it is none of the three. */
function blockOf(path: string, s: unknown): ExportedBlock | undefined {
  if (!isObj(s)) return undefined;
  const keys = Object.keys(s).sort().join(",");
  if (keys === "sum,v" && typeof s["sum"] === "string") {
    return { path, state: "present", value: s["v"] as JsonValue, sum: s["sum"] };
  }
  if (keys === "removed_by" && isSeq(s["removed_by"])) {
    return { path, state: "removed", by: s["removed_by"] };
  }
  if (keys === "pending_deletion" && isSeq(s["pending_deletion"])) {
    return { path, state: "placeholder", of: s["pending_deletion"] };
  }
  return undefined;
}

/**
 * Reads an export file line by line. `line` returns the checked event of an event line and
 * undefined for a manifest; `end` checks what only the whole file shows. Both throw
 * {@link ImportRejected} at the first problem.
 */
export class ExportFileReader {
  private readonly chain = new HeaderChain();
  private first: ExportManifest | undefined;
  private segment: ExportManifest | undefined;
  private segments = 0;
  /** Events the current segment still has to give. */
  private remaining = 0;
  private lastSeq: Seq | undefined;
  private count = 0;
  /** Tombstone `seq` → the removed blocks waiting for it, as `seq/path`. */
  private readonly awaitingTombstone = new Map<Seq, Set<string>>();
  /** `deletion.confirmed` `seq` → the placeholders naming it, as `seq/path`. */
  private readonly awaitingConfirmation = new Map<Seq, Set<string>>();

  line(text: string): ExportedEvent | undefined {
    let v: unknown;
    try {
      v = JSON.parse(text);
      // §8: each line is JCS. A line that is not its own JCS text (another spacing, a key twice,
      // a lone surrogate JCS cannot write) is not of the format.
      if (canonicalize(v as JcsValue) !== text) throw new Error("not JCS");
    } catch {
      throw this.reject("unsupported_format", "a line is not JCS JSON");
    }
    if (!isObj(v)) throw this.reject("unsupported_format", "a line is not a JSON object");
    if (Object.hasOwn(v, "saveslot_export")) {
      this.manifest(v);
      return undefined;
    }
    if (this.segment === undefined) {
      throw this.reject("unsupported_format", "the file does not start with a manifest");
    }
    if (this.remaining === 0) {
      throw this.reject("incomplete", "more events than the segment's manifest counts");
    }
    const e = this.event(v);
    this.remaining--;
    this.count++;
    this.lastSeq = e.seq;
    if (this.remaining === 0 && e.seq !== this.segment.upto) {
      throw this.reject("incomplete", "the segment does not end at its manifest's upto", {
        seq: e.seq,
      });
    }
    return e;
  }

  end(): ExportFileSummary {
    if (this.first === undefined) throw this.reject("incomplete", "the file is empty");
    if (this.remaining > 0) {
      throw this.reject("incomplete", "the file ends before its last segment's events");
    }
    for (const [tombstone, blocks] of this.awaitingTombstone) {
      const [first] = blocks;
      throw this.atBlock(first, `a block removed by ${tombstone}, which the file does not hold`);
    }
    for (const [confirmed, blocks] of this.awaitingConfirmation) {
      const [first] = blocks;
      throw this.atBlock(first, `a placeholder of ${confirmed}, which the file does not confirm`);
    }
    return {
      manifest: { ...this.first, restore_count: this.segment?.restore_count ?? 0 },
      upto: this.lastSeq ?? this.first.upto,
      events: this.count,
      segments: this.segments,
    };
  }

  private manifest(v: Obj): void {
    const m = manifestOf(v);
    if (m === undefined) {
      throw this.reject("unsupported_format", "not a manifest of export format 1, event format 1");
    }
    if (this.remaining > 0) {
      throw this.reject("incomplete", "a segment ends before its manifest's events");
    }
    if (this.first === undefined) {
      if (m.after !== undefined) {
        throw this.reject("not_from_start", "the first segment continues another (`after`)");
      }
      // §8: an export is every event from `seq` 1: the genesis event at least.
      if (m.events === 0) throw this.reject("incomplete", "the first segment holds no event");
      this.first = m;
    } else if (
      // Each manifest is of export format 1 and event format 1 (above), so a later segment's
      // formats are the first's; its tenant ID is compared.
      m.after !== this.segment?.upto ||
      m.tenant_id !== this.first.tenant_id ||
      m.restore_count < (this.segment?.restore_count ?? 0)
    ) {
      throw this.reject("segment_order", "a segment does not continue the one before");
    }
    if (m.events === 0 && m.upto !== (m.after ?? 0)) {
      throw this.reject("incomplete", "a segment without events does not end where it starts");
    }
    this.segment = m;
    this.segments++;
    this.remaining = m.events;
  }

  private event(v: Obj): ExportedEvent {
    const h = v["h"];
    const c = v["c"];
    if (
      Object.keys(v).some((k) => k !== "h" && k !== "c") ||
      !isObj(h) ||
      (c !== undefined && !isObj(c)) ||
      !isSeq(h["seq"])
    ) {
      throw this.reject("unsupported_format", "an event line is not `{h, c}` with a `seq`");
    }
    const seq = h["seq"];
    // The header's shape first: nothing is computed from, or stored of, a header not of the format.
    if (!isEventHeader(h)) {
      throw this.reject("unsupported_format", "an event header not of the event format", { seq });
    }
    const text = canonicalize(h as JcsValue);
    const hash = sha256Hex(text);
    if (!this.chain.link(seq, h, hash)) {
      throw this.reject("chain_broken", "the header does not link to the one before", { seq });
    }
    if (this.segment !== undefined && seq > this.segment.upto) {
      throw this.reject("incomplete", "an event beyond the segment's manifest's upto", { seq });
    }
    const blocks: ExportedBlock[] = [];
    for (const [path, state] of Object.entries(c ?? {})) {
      const b = blockOf(path, state);
      if (b === undefined || matchPath(h["type"] as string, path) === undefined) {
        throw this.reject(
          "unsupported_format",
          b === undefined
            ? "a block in none of the three states"
            : "a block the type does not have",
          this.at(seq, h["type"], path),
        );
      }
      this.block(seq, b);
      blocks.push(b);
    }
    const paths = new Set(blocks.map((b) => b.path));
    for (const path of requiredPaths(h["type"])) {
      if (!paths.has(path)) {
        throw this.reject("checksum_mismatch", "a block the event always has is missing", {
          seq,
          path,
        });
      }
    }
    // The target's event position goes into an index column before apply reads the block: a
    // number there must be a position (a count), or the file is not of the format.
    const target = blocks.find((b) => b.path === "target");
    if (target?.state === "present" && !positionsAreCounts(target.value)) {
      throw this.reject(
        "unsupported_format",
        "a target block's event position is not a seq",
        this.at(seq, h["type"], "target"),
      );
    }
    this.resolves(seq, h["type"], blocks);
    return { seq, header: h as Record<string, JsonValue>, text, hash, blocks };
  }

  private block(seq: Seq, b: ExportedBlock): void {
    const at = `${seq}/${b.path}`;
    switch (b.state) {
      case "present":
        if (sha256Hex(canonicalize(b.value as JcsValue)) !== b.sum) {
          throw this.reject("checksum_mismatch", "a block's checksum does not match", {
            seq,
            path: b.path,
          });
        }
        return;
      case "removed":
        if (b.by <= seq) throw this.atBlock(at, "a block removed by a tombstone before it");
        add(this.awaitingTombstone, b.by, at);
        return;
      case "placeholder":
        if (b.of <= seq) throw this.atBlock(at, "a placeholder of a deletion before it");
        add(this.awaitingConfirmation, b.of, at);
        return;
    }
  }

  /** What this event settles of the blocks waiting for it: a tombstone, a confirmed deletion. */
  private resolves(seq: Seq, type: unknown, blocks: readonly ExportedBlock[]): void {
    const positions = blocks.find((b) => b.path === "positions");
    const listed = positions?.state === "present" ? tombstonePositions(positions.value) : undefined;
    for (const [waiting, by] of [
      [this.awaitingTombstone, "deletion.executed"],
      [this.awaitingConfirmation, "deletion.confirmed"],
    ] as const) {
      const blocksHere = waiting.get(seq);
      if (blocksHere === undefined) continue;
      for (const at of blocksHere) {
        if (type !== by || listed === undefined || !listed.has(at)) {
          throw this.atBlock(at, `the block is not among the positions of a ${by} at ${seq}`);
        }
      }
      waiting.delete(seq);
    }
  }

  private atBlock(at: string | undefined, message: string): ImportRejected {
    const i = at?.indexOf("/") ?? -1;
    return at === undefined || i < 0
      ? this.reject("checksum_mismatch", message)
      : this.reject("checksum_mismatch", message, {
          seq: Number(at.slice(0, i)),
          path: at.slice(i + 1),
        });
  }

  /** A position to report: the path only when the type's vocabulary has it (no file content). */
  private at(seq: Seq, type: unknown, path: string): { readonly seq: Seq; readonly path?: string } {
    return typeof type === "string" && matchPath(type, path) !== undefined
      ? { seq, path }
      : { seq };
  }

  private reject(
    reason: ImportRejection,
    message: string,
    at: { readonly seq?: Seq; readonly path?: string } = {},
  ): ImportRejected {
    return new ImportRejected(reason, message, at);
  }
}

function add(m: Map<Seq, Set<string>>, k: Seq, at: string): void {
  const s = m.get(k) ?? new Set<string>();
  s.add(at);
  m.set(k, s);
}
