// The check of an export file as an import reads it (02-architecture §8 «格式版本、导出、导入与
// 恢复» step ①; 09-event-format §3.3, §8; 04-contract-types §9 `import_rejected`). Each reason of
// `import_rejected` but `replay_failed` (apply's, store-pglite/src/import.test.ts) from a file that
// is right but for one thing. Fictional IDs and data.

import { canonicalize, type JsonValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import {
  buildOperation,
  type LogTail,
  type NewEvent,
  type NewOperation,
  type PreparedEvent,
} from "./build.ts";
import { sha256Hex } from "./encode.ts";
import { ExportFileReader, ImportRejected, type ImportRejection } from "./import-file.ts";

const USER = `u_${"1".repeat(26)}` as const;
const SLOT = `sl_${"3".repeat(16)}` as const;
const TENANT = `tn_${"8".repeat(26)}`;
const ROW = `r_${"6".repeat(26)}`;
const NOW = "2026-11-10T04:00:00.000Z" as NewOperation["now"];
const CTX = {
  now: NOW,
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
  literal_checker: "literal@1",
};

const genesis: NewEvent = {
  type: "tenant.genesis",
  node_id: `n_${"4".repeat(26)}`,
  blocks: {
    tenant: { tenant_id: TENANT, storage_format: 1, event_format: 1 },
    user: { principal: USER, kind: "user" },
    system: { principal: "system", kind: "system" },
  },
};
const write = (value: string): NewEvent => ({
  type: "write.head",
  slot: SLOT,
  blocks: {
    ctx: CTX,
    request: { sv: 1, sv_basis: "explicit", op_count: 1 },
    "ops/0/target": { table: "t1", row: ROW, intent: "update" },
    "ops/0/set/f2": value,
  },
});
const POSITIONS = (seq: number) => [{ seq, path: "ops/0/set/f2" }];
const confirmed = (seq: number): NewEvent => ({
  type: "deletion.confirmed",
  slot: SLOT,
  blocks: {
    ctx: CTX,
    target: { deletion: `pi_${"5".repeat(26)}`, sources: [], due_at: NOW },
    positions: POSITIONS(seq),
  },
});
const executed = (seq: number): NewEvent => ({
  type: "deletion.executed",
  slot: SLOT,
  trigger: "deletion_expiry",
  blocks: {
    target: { deletion: `pi_${"5".repeat(26)}`, reason: "expiry" },
    positions: POSITIONS(seq),
  },
});

/** The events of a log, one operation each, chained as the log chains them. */
function logOf(events: readonly NewEvent[]): PreparedEvent[] {
  const out: PreparedEvent[] = [];
  let tail: LogTail | undefined;
  for (const e of events) {
    const actor = e.type === "deletion.executed" ? "system" : USER;
    const op = buildOperation(tail, { actor, now: NOW, events: [e] });
    out.push(...op.events);
    const last = op.events.at(-1) as PreparedEvent;
    tail = { seq: last.seq, hash: last.hash, at: last.at };
  }
  return out;
}

type Line = { h: Record<string, JsonValue>; c?: Record<string, JsonValue> };

/** An event as an export line, every block present (09 §8). */
const lineOf = (e: PreparedEvent): Line => ({
  h: JSON.parse(e.header) as Record<string, JsonValue>,
  ...(e.blocks.length > 0
    ? {
        c: Object.fromEntries(
          e.blocks.map((b) => [b.path, { v: JSON.parse(b.body) as JsonValue, sum: b.checksum }]),
        ),
      }
    : {}),
});

/** The hash of a line's header (§2.1); for no line, none (a segment without events names one). */
const hashOf = (l: Line | undefined): string =>
  l === undefined ? "" : sha256Hex(canonicalize(l.h as never));

const manifest = (lines: readonly Line[], extra: Record<string, JsonValue> = {}) => ({
  saveslot_export: 1,
  tenant_id: TENANT,
  event_format: 1,
  restore_count: 0,
  upto: (lines.at(-1)?.h["seq"] as number | undefined) ?? 0,
  upto_hash: hashOf(lines.at(-1)),
  events: lines.length,
  exported_at: "2026-11-10T08:00:00.000Z",
  pending_deletions: "placeholder",
  ...extra,
});

/** A file of one segment: the manifest, then the lines, each as JCS text. */
const fileOf = (lines: readonly Line[], extra: Record<string, JsonValue> = {}): string[] => [
  canonicalize(manifest(lines, extra) as never),
  ...lines.map((l) => canonicalize(l as never)),
];

/** Reads a file through; the summary, or the rejection as `{reason, seq, path}`. */
function read(file: readonly string[]) {
  const r = new ExportFileReader();
  try {
    const events = file.map((l) => r.line(l)).filter((e) => e !== undefined);
    return { ok: true as const, events, summary: r.end() };
  } catch (e) {
    if (!(e instanceof ImportRejected)) throw e;
    return { ok: false as const, reason: e.reason, seq: e.seq, path: e.path };
  }
}

const rejected = (reason: ImportRejection, seq?: number, path?: string) => ({
  ok: false,
  reason,
  seq,
  path,
});

/** A header as a line holds it: its keys in JCS order (the line is JCS, §8). */
const canonicalHeader = (h: Record<string, JsonValue>) =>
  JSON.parse(canonicalize(h as never)) as Record<string, JsonValue>;

const LOG = logOf([genesis, write("a"), write("b"), write("c")]);
const LINES = LOG.map(lineOf);

describe("a file that is right", () => {
  it("gives each event with its header's bytes and hash, and what the file held", () => {
    const r = read(fileOf(LINES));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    expect(r.events.map((e) => [e.seq, e.text, e.hash])).toEqual(
      LOG.map((e) => [e.seq, e.header, e.hash]),
    );
    expect(r.events[1]?.blocks).toContainEqual({
      path: "ops/0/set/f2",
      state: "present",
      value: "a",
      sum: LOG[1]?.blocks.find((b) => b.path === "ops/0/set/f2")?.checksum,
    });
    expect(r.summary).toEqual({
      manifest: manifest(LINES),
      upto: 4,
      events: 4,
      segments: 1,
    });
  });

  it("in segments cut by `after`, each continuing where the one before ended", () => {
    const first = LINES.slice(0, 2);
    const second = LINES.slice(2);
    const r = read([...fileOf(first), ...fileOf(second, { after: 2 })]);
    // The manifest is the first segment's but for its end: the last segment's.
    expect(r.ok && r.summary).toEqual({
      manifest: { ...manifest(first), upto: 4, upto_hash: hashOf(LINES[3]) },
      upto: 4,
      events: 4,
      segments: 2,
    });
  });

  it("with a segment of no events where nothing came after", () => {
    const r = read([
      ...fileOf(LINES),
      ...fileOf([], { after: 4, upto: 4, upto_hash: hashOf(LINES[3]) }),
    ]);
    expect(r.ok && r.summary).toMatchObject({ upto: 4, events: 4, segments: 2 });
  });

  it("with a block removed by the tombstone after it, and a placeholder of the deletion after it", () => {
    const log = logOf([genesis, write("a"), write("b"), confirmed(3), executed(2)]);
    const lines = log.map(lineOf);
    const c = (k: number) => lines[k]?.c as Record<string, JsonValue>;
    c(1)["ops/0/set/f2"] = { removed_by: 5 };
    c(2)["ops/0/set/f2"] = { pending_deletion: 4 };
    const r = read(fileOf(lines));
    expect(r.ok).toBe(true);
    if (!r.ok) return;
    const block = (seq: number) =>
      r.events.find((e) => e.seq === seq)?.blocks.find((b) => b.path === "ops/0/set/f2");
    expect(block(2)).toEqual({ path: "ops/0/set/f2", state: "removed", by: 5 });
    expect(block(3)).toEqual({ path: "ops/0/set/f2", state: "placeholder", of: 4 });
  });
});

describe("refused", () => {
  it("unsupported_format: a line not JSON, not an object, or a manifest of another format", () => {
    expect(read(["{"])).toEqual(rejected("unsupported_format"));
    expect(read(["[]"])).toEqual(rejected("unsupported_format"));
    expect(read(fileOf(LINES, { saveslot_export: 2 }))).toEqual(rejected("unsupported_format"));
    expect(read(fileOf(LINES, { event_format: 2 }))).toEqual(rejected("unsupported_format"));
    expect(read(fileOf(LINES, { pending_deletions: "maybe" }))).toEqual(
      rejected("unsupported_format"),
    );
    expect(read(fileOf(LINES, { extra: 1 }))).toEqual(rejected("unsupported_format"));
  });

  it("unsupported_format: events before any manifest", () => {
    expect(read(fileOf(LINES).slice(1))).toEqual(rejected("unsupported_format"));
  });

  it("unsupported_format: an event line not `{h, c}`, or a block in none of the three states", () => {
    const file = fileOf(LINES);
    const extraKey = [...file];
    extraKey[2] = canonicalize({ ...LINES[1], x: 1 } as never);
    expect(read(extraKey)).toEqual(rejected("unsupported_format"));
    for (const state of [{ v: "a" }, { removed_by: 0 }, { pending_deletion: "x" }, "a"]) {
      const bad = [...file];
      bad[2] = canonicalize({
        ...LINES[1],
        c: { ...LINES[1]?.c, "ops/0/set/f2": state },
      } as never);
      expect(read(bad)).toEqual(rejected("unsupported_format", 2, "ops/0/set/f2"));
    }
  });

  it("not_from_start: the first segment continues another", () => {
    expect(read(fileOf(LINES.slice(2), { after: 2 }))).toEqual(rejected("not_from_start"));
  });

  it("segment_order: a segment that does not continue where the one before ended", () => {
    const first = fileOf(LINES.slice(0, 2));
    expect(read([...first, ...fileOf(LINES.slice(3), { after: 3 })])).toEqual(
      rejected("segment_order"),
    );
    expect(read([...first, ...fileOf(LINES.slice(2))])).toEqual(rejected("segment_order"));
  });

  it("chain_broken: a header changed, an event left out, or not starting at genesis", () => {
    const changed = LINES.map((l) => ({ ...l }));
    changed[1] = { ...changed[1], h: { ...changed[1]?.h, at: "2026-11-10T04:00:00.001Z" } } as Line;
    // The changed header hashes otherwise: the next one no longer links to it.
    expect(read(fileOf(changed))).toEqual(rejected("chain_broken", 3));
    const left = [LINES[0], LINES[2], LINES[3]] as Line[];
    expect(read(fileOf(left))).toEqual(rejected("chain_broken", 3));
    expect(read(fileOf(LINES.slice(1)))).toEqual(rejected("chain_broken", 2));
  });

  it("checksum_mismatch: a block changed, or one the event always has left out", () => {
    const file = fileOf(LINES);
    const changed = [...file];
    changed[2] = canonicalize({
      ...LINES[1],
      c: { ...LINES[1]?.c, "ops/0/set/f2": { v: "x", sum: LOG[1]?.blocks[3]?.checksum } },
    } as never);
    expect(read(changed)).toEqual(rejected("checksum_mismatch", 2, "ops/0/set/f2"));
    const { ctx: _, ...rest } = (LINES[1]?.c ?? {}) as Record<string, JsonValue>;
    const missing = [...file];
    missing[2] = canonicalize({ ...LINES[1], c: rest } as never);
    expect(read(missing)).toEqual(rejected("checksum_mismatch", 2, "ctx"));
  });

  it("checksum_mismatch: a block removed or held back that no deletion of the file lists", () => {
    const log = logOf([genesis, write("a"), write("b"), confirmed(2), executed(2)]);
    const at = (k: number, state: JsonValue) => {
      const lines = log.map(lineOf);
      (lines[k]?.c as Record<string, JsonValue>)["ops/0/set/f2"] = state;
      return read(fileOf(lines));
    };
    // Listed by its own deletion events: accepted.
    expect(at(1, { removed_by: 5 }).ok).toBe(true);
    expect(at(1, { pending_deletion: 4 }).ok).toBe(true);
    // Seq 3's block is in neither deletion's positions.
    expect(at(2, { removed_by: 5 })).toEqual(rejected("checksum_mismatch", 3, "ops/0/set/f2"));
    expect(at(2, { pending_deletion: 4 })).toEqual(
      rejected("checksum_mismatch", 3, "ops/0/set/f2"),
    );
    // Named events of another type, earlier events, events the file does not hold.
    expect(at(1, { removed_by: 4 })).toEqual(rejected("checksum_mismatch", 2, "ops/0/set/f2"));
    expect(at(1, { pending_deletion: 5 })).toEqual(
      rejected("checksum_mismatch", 2, "ops/0/set/f2"),
    );
    expect(at(2, { removed_by: 2 })).toEqual(rejected("checksum_mismatch", 3, "ops/0/set/f2"));
    expect(at(1, { removed_by: 9 })).toEqual(rejected("checksum_mismatch", 2, "ops/0/set/f2"));
    expect(at(1, { pending_deletion: 9 })).toEqual(
      rejected("checksum_mismatch", 2, "ops/0/set/f2"),
    );
  });

  it("incomplete: fewer events than the manifest counts, more, or not ending at its upto", () => {
    expect(read(fileOf(LINES).slice(0, 4))).toEqual(rejected("incomplete"));
    expect(
      read([canonicalize(manifest(LINES.slice(0, 3)) as never), ...fileOf(LINES).slice(1)]),
    ).toEqual(rejected("incomplete"));
    expect(read(fileOf(LINES, { upto: 5 }))).toEqual(rejected("incomplete", 4));
    expect(read(fileOf(LINES, { upto: 3 }))).toEqual(rejected("incomplete", 4));
    // A segment cut short by the next manifest.
    const first = fileOf(LINES.slice(0, 2), { events: 3, upto: 3 });
    expect(read([...first, ...fileOf(LINES.slice(2), { after: 3 })])).toEqual(
      rejected("incomplete"),
    );
    expect(read([])).toEqual(rejected("incomplete"));
  });

  it("a segment's manifest of another export, or with a restore count going back: segment_order", () => {
    const first = fileOf(LINES.slice(0, 2), { restore_count: 1 });
    const rest = LINES.slice(2);
    // Each changes one thing: another tenant at the same restore count, or the count going back.
    for (const other of [
      { tenant_id: `tn_${"7".repeat(26)}`, restore_count: 1 },
      { restore_count: 0 },
    ]) {
      expect(read([...first, ...fileOf(rest, { after: 2, ...other })])).toEqual(
        rejected("segment_order"),
      );
    }
  });

  it("incomplete: a first segment with no event (an export holds the genesis at least)", () => {
    // A well-formed manifest otherwise: its upto_hash names the genesis header.
    expect(read(fileOf([], { upto_hash: hashOf(LINES[0]) }))).toEqual(rejected("incomplete"));
  });
});

describe("the manifest's upto_hash (§8): the last header, which no next prev_hash checks", () => {
  it("chain_broken at upto: the last header changed, the manifest naming the one exported", () => {
    const changed = [...LINES];
    changed[3] = { ...LINES[3], h: { ...LINES[3]?.h, actor: `u_${"2".repeat(26)}` } } as Line;
    expect(read(fileOf(changed, { upto_hash: hashOf(LINES[3]) }))).toEqual(
      rejected("chain_broken", 4),
    );
  });

  it("chain_broken: a manifest naming another header, at the end of any segment", () => {
    expect(read(fileOf(LINES, { upto_hash: hashOf(LINES[2]) }))).toEqual(
      rejected("chain_broken", 4),
    );
    // A first segment's own end: the next segment's prev_hash would not see a wrong upto_hash.
    const first = fileOf(LINES.slice(0, 2), { upto_hash: hashOf(LINES[0]) });
    expect(read([...first, ...fileOf(LINES.slice(2), { after: 2 })])).toEqual(
      rejected("chain_broken", 2),
    );
    // A segment without events names the header the one before ended at.
    const empty = fileOf([], { after: 4, upto: 4, upto_hash: hashOf(LINES[2]) });
    expect(read([...fileOf(LINES), ...empty])).toEqual(rejected("chain_broken", 4));
  });

  it("unsupported_format: a manifest without it, or not 64 lowercase hex digits", () => {
    const { upto_hash: _, ...without } = manifest(LINES);
    const lines = LINES.map((l) => canonicalize(l as never));
    expect(read([canonicalize(without as never), ...lines])).toEqual(
      rejected("unsupported_format"),
    );
    for (const upto_hash of [hashOf(LINES[3]).toUpperCase(), hashOf(LINES[3]).slice(1)]) {
      expect(read(fileOf(LINES, { upto_hash }))).toEqual(rejected("unsupported_format"));
    }
  });
});

describe("a target block's event position (an index column before apply reads the block)", () => {
  it("unsupported_format at its seq unless a count: a fraction, past BIGINT, negative", () => {
    const lines = logOf([genesis, write("a"), confirmed(2)]).map(lineOf);
    const withTarget = (extra: Record<string, JsonValue>): Line[] => {
      const l = lines[2] as Line;
      const c = l.c as Record<string, { v: Record<string, JsonValue>; sum: string }>;
      const v = { ...c["target"]?.v, ...extra };
      return [
        ...lines.slice(0, 2),
        { ...l, c: { ...c, target: { v, sum: sha256Hex(canonicalize(v as never)) } } } as Line,
      ];
    };
    for (const extra of [
      { origin_event: 1.5 },
      { origin_event: 1e20 },
      { origin_event: -1 },
      { by_event: 2.5 },
    ]) {
      expect(read(fileOf(withTarget(extra))), JSON.stringify(extra)).toEqual(
        rejected("unsupported_format", 3, "target"),
      );
    }
    // A count is a position; a value of another type is apply's to judge.
    expect(read(fileOf(withTarget({ origin_event: 2 }))).ok).toBe(true);
    expect(read(fileOf(withTarget({ origin_event: "2" }))).ok).toBe(true);
  });
});

describe("a later segment of an export format or event format the reader does not know", () => {
  it("is unsupported_format, as a first segment's would be, not segment_order", () => {
    const first = fileOf(LINES.slice(0, 2));
    for (const other of [{ saveslot_export: 2 }, { event_format: 2 }]) {
      expect(read([...first, ...fileOf(LINES.slice(2), { after: 2, ...other })])).toEqual(
        rejected("unsupported_format"),
      );
    }
  });
});

describe("a later segment's restore count", () => {
  it("is the file's: the count when the last segment was exported", () => {
    const r = read([
      ...fileOf(LINES.slice(0, 2), { restore_count: 1 }),
      ...fileOf(LINES.slice(2), { after: 2, restore_count: 3 }),
    ]);
    expect(r.ok && r.summary.manifest.restore_count).toBe(3);
  });
});

describe("refused without echoing the file (04-contract-types §9: positions only)", () => {
  /** The rejection, and whether its message holds `secret`. */
  const refusal = (file: readonly string[], secret: string) => {
    const r = new ExportFileReader();
    try {
      for (const l of file) r.line(l);
      r.end();
      return "accepted";
    } catch (e) {
      if (!(e instanceof ImportRejected)) throw e;
      return {
        reason: e.reason,
        seq: e.seq,
        path: e.path,
        echoes: `${e.message} ${e.seq} ${e.path}`.includes(secret),
      };
    }
  };
  const withHeader = (h: Record<string, JsonValue>) => {
    const file = fileOf(LINES);
    file[2] = canonicalize({ c: LINES[1]?.c, h } as never);
    return file;
  };
  const header = LINES[1]?.h as Record<string, JsonValue>;

  it("a header key with a lone surrogate (JCS cannot write it)", () => {
    const file = fileOf(LINES);
    file[2] = (file[2] as string).replace('"actor":', '"PATIENT-NAME\\ud800":1,"actor":');
    expect(refusal(file, "PATIENT")).toEqual({
      reason: "unsupported_format",
      seq: undefined,
      path: undefined,
      echoes: false,
    });
  });

  it("a header without its actor, and one whose op is a string: the header is checked first", () => {
    const { actor: _, ...noActor } = header;
    expect(refusal(withHeader(canonicalHeader(noActor)), "SECRET")).toEqual({
      reason: "unsupported_format",
      seq: 2,
      path: undefined,
      echoes: false,
    });
    expect(refusal(withHeader(canonicalHeader({ ...header, op: "SECRET-OP" })), "SECRET")).toEqual({
      reason: "unsupported_format",
      seq: 2,
      path: undefined,
      echoes: false,
    });
    expect(refusal(withHeader(canonicalHeader({ ...header, note: "SECRET" })), "SECRET")).toEqual({
      reason: "unsupported_format",
      seq: 2,
      path: undefined,
      echoes: false,
    });
  });

  it("a block path the type does not have: not given back as the path", () => {
    const file = fileOf(LINES);
    file[2] = canonicalize({
      ...LINES[1],
      c: { ...LINES[1]?.c, "SECRET-diagnosis": { v: "x", sum: "y" } },
    } as never);
    expect(refusal(file, "SECRET")).toEqual({
      reason: "unsupported_format",
      seq: 2,
      path: undefined,
      echoes: false,
    });
  });

  it("a line not its own JCS text: another line end, spacing, a key twice", () => {
    const line = fileOf(LINES)[2] as string;
    for (const bad of [`${line}\r`, ` ${line}`, line.replace('{"c":', '{"c":{},"c":')]) {
      const file = fileOf(LINES);
      file[2] = bad;
      expect(refusal(file, "\r")).toMatchObject({ reason: "unsupported_format" });
    }
  });
});
