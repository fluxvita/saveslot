// Shape checks of a write's events (09-event-format §5.6–§5.8): a well-formed sample of every block
// shape the checks cover, then, block by block, the negatives every checker must report (an unknown
// key, each required key missing), and the rules a shape adds beyond its keys.

import { describe, expect, it } from "vitest";
import { type ParseResult, parseEvent } from "./parse.ts";

const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const ITEM = `pi_${"8".repeat(16)}`;
const ITEM_B = `pi_${"9".repeat(16)}`;
const SOURCE = `s_${"3".repeat(16)}`;
const AT = "2026-11-10T04:41:07.123Z";

const member = (type: string, seq: number, op = 25) => ({
  type,
  v: 1,
  seq,
  op,
  at: AT,
  prev_hash: HASH,
  actor: CONN,
  slot: SLOT,
});
const head = (type: string, seq: number) => ({
  type,
  v: 1,
  seq,
  at: AT,
  prev_hash: HASH,
  actor: CONN,
  slot: SLOT,
});
const ctx = { now: AT, today: "2026-11-10", ruleset_version: 1, policy_version: 1 };
const deps = [{ event: 27, field: "f3", k: 0 }];

type Sample = { header: Record<string, unknown>; blocks: Record<string, unknown> };

const SAMPLES: Record<string, Sample> = {
  "write.head": {
    header: head("write.head", 25),
    blocks: {
      ctx: { ...ctx, literal_checker: "literal@1" },
      task: "plan the week",
      request_key: { key: "k1" },
      request: { sv: 1, sv_basis: "explicit", op_count: 2 },
      "ops/0/target": {
        table: "t1",
        row: ROW,
        intent: "correct",
        ver: { op: 21, restore_count: 0, basis: "explicit" },
      },
      "ops/0/set/f3": { value: "32.50", unit: "CNY" },
      "ops/0/noop": ["f1"],
      "ops/0/acknowledge": ["overwrite"],
      "ops/0/named_fields": ["f3"],
      "ops/1/target": { table: "t2", entity: ENTITY, intent: "update", by_entity_key: true },
      "ops/1/valid": { from: { mode: "given", value: "2026-11-01" }, to: { mode: "next_change" } },
      "ops/1/revert": { undo_op: 20, include_later: false },
    },
  },
  "write.head (idempotency, corrected span)": {
    header: head("write.head", 25),
    blocks: {
      ctx: { ...ctx, literal_checker: "literal@1" },
      idempotency: { key: "k1", fingerprint: HASH },
      request: { sv: 1, sv_basis: "fallback", op_count: 1 },
      "ops/0/target": { table: "t1", row: ROW, intent: "insert", created: true },
      "ops/0/set/f3": null,
      "ops/0/valid": { from: { mode: "corrected_span" }, to: { mode: "corrected_span" } },
    },
  },
  "write.base": {
    header: member("write.base", 27),
    blocks: {
      target: { table: "t1", row: ROW, intent: "correct", sv: 1, cause: "request", op_index: 0 },
      "fields/f3/0": { status: "applied", value: { value: "32.5", unit: "CNY" } },
      "fields/f3/1": { status: "applied", value: "30" },
      "fields/f3/2": { status: "applied", no_value: true },
      "fields/f4/0": { status: "applied", uncovered: true },
      "fields/f5/0": { status: "applied", value: { instant: AT, zone: "Asia/Shanghai" } },
      "sources/f5/0": [{ kind: "value", source: 26 }],
      "sources/f3/0": [{ kind: "value", source: 26 }],
      "sources/f3/1": [{ kind: "value", carried: { event: 21, field: "f3", k: 0 } }],
      "literal/f3/0": { segments: [{ source: 26, result: "hit" }] },
      "span/f3/0": { valid: { from: "2026-11-01", to: "2026-11-09" }, deps },
      "span/f4/0": { seen_valid: { from: "2026-11-01" } },
      "existence/0": { status: "applied", scope: "interval", restored: true },
      "span/existence/0": {
        valid: { from: "2026-11-01", to: "2026-11-03" },
        deps: [{ event: 21, existence: 0 }],
      },
      valid_sources: [26],
      op_sources: [26],
      "ack/0": {
        field: "f3",
        valid: { from: "2026-11-01", to: "2026-11-02" },
        value: "x",
        op: 21,
        deps,
      },
      "ack/1": {
        field: "f3",
        valid: { from: "2026-11-02", to: "2026-11-03" },
        no_value: true,
        deps,
      },
      revert: {
        before_op: 20,
        items: [
          { event: 21, field: "f3" },
          { event: 23, existence: true, later: true },
        ],
        skipped: [{ event: 21, field: "f3", by_op: 24 }],
      },
    },
  },
  "write.base (resolve: take_previous)": {
    header: member("write.base", 27),
    blocks: {
      target: {
        table: "t1",
        entity: ENTITY,
        intent: "update",
        sv: 1,
        cause: "resolve",
        item: ITEM,
      },
      "fields/f3/0": { status: "applied", value: "1" },
      "sources/f3/0": [{ kind: "schema_const", sv: 2, field: "f3" }],
      revert: { as_of_op: 29, item: ITEM, items: [{ event: 35, field: "f3" }] },
    },
  },
  "write.base (resolve: take_candidate)": {
    header: member("write.base", 27),
    blocks: {
      target: { table: "t1", row: ROW, intent: "update", sv: 1, cause: "resolve", item: ITEM },
      "fields/f3/0": { status: "applied", value: true },
      "sources/f3/0": [{ kind: "value", carried: { event: 31, field: "f3", k: 0 } }],
      "existence/0": { status: "applied", scope: "whole", restored: true },
      take: { item: ITEM, candidate: 0, merge_base_op: 29, items: [{ event: 35, field: "f3" }] },
    },
  },
  "source.recorded": {
    header: member("source.recorded", 26),
    blocks: {
      target: { source_id: SOURCE, kind: "api_call", level: "agent_inferred", op_index: 0 },
      request: { intent: "correct" },
      stated_at: { at: AT },
    },
  },
  "source.recorded (file)": {
    header: member("source.recorded", 26),
    blocks: {
      target: { source_id: SOURCE, kind: "file_ref", level: "user_stated" },
      file: {
        name: "a.pdf",
        mime: "application/pdf",
        size: 10,
        sha256: HASH,
        origin: "upload",
        excerpt: "page 1",
      },
    },
  },
  "source.recorded (text)": {
    header: member("source.recorded", 26),
    blocks: {
      target: { source_id: SOURCE, kind: "user_message", level: "user_stated" },
      text: { text: "it was 32.5" },
    },
  },
  "item.created": {
    header: member("item.created", 28),
    blocks: {
      target: {
        item: ITEM,
        type: "conflict",
        reason: "stale_write",
        table: "t1",
        row: ROW,
        unit: ["f3"],
        merge_base_op: 29,
        origin_event: 27,
        ruleset_version: 1,
        policy_version: 1,
      },
      scope_valid: { spans: [{ from: "2026-11-01", to: "2026-11-09" }], deps },
      "current/0": { field: "f3", value: "30", op: 21, deps },
      "candidates/0": {
        event: 27,
        intent: "correct",
        seen: { op: 21, restore_count: 0 },
        cause: "stale_write",
        items: [{ field: "f3", k: 0, value: "32", valid: { from: "2026-11-01" } }],
        deps,
      },
      "previous/0": { field: "f3", value: "30", deps },
      "impact/0": { kind: "overwritten_segment", field: "f3", value: "30", op: 21, deps },
    },
  },
  "item.created (awaiting, on existence)": {
    header: member("item.created", 28),
    blocks: {
      target: {
        item: ITEM,
        type: "awaiting_confirmation",
        reason: "undo_includes_later",
        table: "t1",
        entity: ENTITY,
        unit: ["existence"],
        origin_event: 27,
        ruleset_version: 1,
        policy_version: 1,
      },
      "proposed/0": { field: "f3", value: "1", valid: { from: "2026-11-01" }, deps },
      "impact/0": { kind: "reverted_write", op: 23, deps },
      "candidates/0": {
        event: 27,
        intent: "revoke",
        seen: { op: 21, restore_count: 0 },
        cause: "stale_write",
        items: [{ existence: 0 }],
        deps: [],
      },
    },
  },
  "item.created (schema change)": {
    header: member("item.created", 28),
    blocks: {
      target: {
        item: ITEM,
        type: "schema_change",
        reason: "schema_change",
        draft: `d_${"5".repeat(16)}`,
        ruleset_version: 1,
        policy_version: 1,
      },
    },
  },
  "item.created (restored candidate)": {
    header: member("item.created", 28),
    blocks: {
      target: {
        item: ITEM,
        type: "conflict",
        reason: "restored_candidate",
        table: "t1",
        row: ROW,
        unit: ["f3", "f4"],
        merge_base_op: 29,
        origin_event: 27,
        related_item: ITEM_B,
        ruleset_version: 1,
        policy_version: 1,
      },
    },
  },
  "item.merged": {
    header: member("item.merged", 28),
    blocks: {
      target: {
        item: ITEM,
        merge_base_op: 29,
        origin_event: 27,
        ruleset_version: 1,
        policy_version: 1,
      },
      "impact/0": { kind: "referencing_row", table: "t2", row: ROW, field: "f5" },
    },
  },
  "item.refreshed": {
    header: member("item.refreshed", 28),
    blocks: {
      target: { item: ITEM, cause: "target_overwritten", by_event: 27, writer_had_read: false },
    },
  },
  "item.refreshed (references changed)": {
    header: member("item.refreshed", 28),
    blocks: {
      target: { item: ITEM, cause: "references_changed", by_event: 27, writer_had_read: true },
    },
  },
  "item.refreshed (entries deleted)": {
    header: member("item.refreshed", 28),
    blocks: {
      target: { item: ITEM, cause: "entries_deleted", dropped_candidates: [1], merge_base_op: 9 },
    },
  },
  "item.superseded": {
    header: member("item.superseded", 28),
    blocks: {
      target: { item: ITEM, reason: "overwritten", by_event: 27, writer_had_read: true },
    },
  },
  "item.resolved": {
    header: head("item.resolved", 30),
    blocks: {
      ctx: { ...ctx, literal_checker: "literal@1" },
      target: {
        item: ITEM,
        decision: "take_candidate",
        candidate: 0,
        item_op: 37,
        restore_count: 0,
        via: "call",
      },
      op_sources: [31],
      confirmation: { hash: HASH },
    },
  },
  "item.resolved (keep)": {
    header: head("item.resolved", 30),
    blocks: {
      ctx,
      target: {
        item: ITEM,
        decision: "keep_effective",
        item_op: 37,
        restore_count: 0,
        via: "call",
      },
    },
  },
};

const parse = (s: Sample, removed: string[] = []): ParseResult =>
  parseEvent(s.header, s.blocks, removed);
const issues = (r: ParseResult): readonly string[] =>
  !r.ok && r.kind === "invalid" ? r.issues : [];
const withBlock = (s: Sample, path: string, value: unknown): Sample => ({
  ...s,
  blocks: { ...s.blocks, [path]: value },
});
const typeOf = (name: string) => name.split(" ")[0] as string;

describe("parseEvent: a write's events", () => {
  it.each(Object.entries(SAMPLES))("accepts %s", (name, s) => {
    expect(parse(s)).toEqual({ ok: true, type: typeOf(name) });
  });

  // Every object block of every sample: an unknown key, and each of its keys removed, is refused
  // (a key is optional only where the sample above leaves it out somewhere, so removing it here
  // from where it is present may be fine: those are listed).
  const optional = new Set([
    "deps",
    "to",
    "valid",
    "ver",
    "created",
    "by_entity_key",
    "restored",
    "skipped",
    "op_index",
    "sha256",
    "literal_checker",
    "merge_base_op",
    "dropped_candidates",
    "later",
    "writer_had_read",
    "origin",
    "excerpt",
  ]);
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks).flatMap(([path, v]) =>
      // `source.recorded` `request` is the request JSON itself: any keys.
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(name.startsWith("source.recorded") && path === "request")
        ? [[name, path, v as Record<string, unknown>] as const]
        : [],
    ),
  );
  it.each(cases)("%s %s: refuses an unknown key and a missing required key", (name, path, v) => {
    const s = SAMPLES[name] as Sample;
    expect(issues(parse(withBlock(s, path, { ...v, zz: 1 })))).toContain(`${path}: unknown key zz`);
    for (const k of Object.keys(v)) {
      if (optional.has(k)) continue;
      const { [k]: _, ...rest } = v;
      expect({ k, ok: parse(withBlock(s, path, rest)).ok }).toEqual({ k, ok: false });
    }
  });
});

describe("parseEvent: a raw value", () => {
  it("keeps the caller's decimal form in ops/<i>/set", () => {
    const head = SAMPLES["write.head"] as Sample;
    expect(parse(withBlock(head, "ops/0/set/f3", { value: "3.250e1", unit: "CNY" })).ok).toBe(true);
  });
});

// --- value-level negatives -----------------------------------------------------------------------

const S = (name: string) => SAMPLES[name] as Sample;
/** The sample with block `path` patched: keys merged in (`undefined` removes a key). */
function patched(name: string, path: string, patch: Record<string, unknown>): Sample {
  const s = S(name);
  const block = { ...(s.blocks[path] as Record<string, unknown>) };
  for (const [k, v] of Object.entries(patch)) {
    if (v === undefined) delete block[k];
    else block[k] = v;
  }
  return withBlock(s, path, block);
}
const BAD_ID = "x_1";

describe("parseEvent: a write's blocks, value by value", () => {
  // [sample, block, patch, the issue it must report]
  const cases: [string, string, Record<string, unknown>, string][] = [
    // enums
    ["write.head", "ops/0/target", { intent: "upsert" }, "ops/0/target: intent"],
    [
      "write.head",
      "ops/0/target",
      { ver: { op: 1, restore_count: 0, basis: "guess" } },
      "ops/0/target.ver: basis",
    ],
    ["write.head", "request", { sv_basis: "guess" }, "request: sv_basis"],
    ["write.head", "ops/1/valid", { from: { mode: "later" } }, "ops/1/valid.from: mode"],
    ["write.head", "ops/1/valid", { to: { mode: "never" } }, "ops/1/valid.to: mode"],
    ["write.base", "target", { intent: "upsert" }, "target: intent"],
    ["write.base", "target", { cause: "ruling" }, "target: cause"],
    ["write.base", "fields/f3/0", { status: "dropped" }, "fields/f3/0: status"],
    ["write.base", "existence/0", { scope: "row" }, "existence/0: scope"],
    ["write.base", "existence/0", { status: "corroborated" }, "existence/0: status"],
    [
      "write.base",
      "literal/f3/0",
      { segments: [{ source: 26, result: "maybe" }] },
      "literal/f3/0.segments[0]: result",
    ],
    ["write.base", "sources/f3/0", { 0: undefined }, "sources/f3/0: not an array"],
    ["source.recorded", "target", { kind: "email" }, "target: kind"],
    ["source.recorded", "target", { level: "rumour" }, "target: level"],
    ["item.created", "target", { type: "flag" }, "target: type and reason"],
    ["item.created", "target", { type: "constructor" }, "target: type and reason"],
    ["item.created", "target", { reason: "duplicate_keys" }, "target: type and reason"],
    ["item.created", "candidates/0", { cause: "ruling" }, "candidates/0: cause"],
    ["item.created", "candidates/0", { intent: "upsert" }, "candidates/0: intent"],
    ["item.created", "impact/0", { kind: "rumour" }, "impact/0: kind"],
    ["item.refreshed", "target", { cause: "toString" }, "target: cause"],
    ["item.refreshed", "target", { cause: "bored" }, "target: cause"],
    ["item.superseded", "target", { reason: "bored" }, "target: reason"],
    ["item.resolved", "target", { decision: "maybe", candidate: undefined }, "target: decision"],
    ["item.resolved", "target", { via: "elicitation" }, "target: via"],
    // IDs, hashes, instants, fingerprints
    ["write.head", "ops/0/target", { table: "table1" }, "ops/0/target: table"],
    ["write.head", "ops/0/target", { row: BAD_ID }, "ops/0/target: row"],
    ["write.head", "ops/1/target", { entity: BAD_ID }, "ops/1/target: entity"],
    ["write.head", "ops/0/target", { key_from: BAD_ID }, "ops/0/target: key_from"],
    [
      "write.head (idempotency, corrected span)",
      "idempotency",
      { fingerprint: "abc" },
      "idempotency: fingerprint",
    ],
    [
      "write.base",
      "target",
      { item: BAD_ID, cause: "resolve", op_index: undefined },
      "target: item",
    ],
    ["write.base", "ack/0", { field: "x3" }, "ack/0: field"],
    ["write.base", "ack/0", { op: -1 }, "ack/0: op"],
    ["source.recorded", "target", { source_id: BAD_ID }, "target: source_id"],
    ["source.recorded", "stated_at", { at: "2026-11-10" }, "stated_at: at"],
    ["source.recorded (file)", "file", { sha256: "abc" }, "file: sha256"],
    ["item.created", "target", { item: BAD_ID }, "target: item"],
    ["item.created", "target", { origin_event: 0 }, "target: origin_event"],
    [
      "item.created (restored candidate)",
      "target",
      { related_item: BAD_ID },
      "target: related_item",
    ],
    ["item.created (schema change)", "target", { draft: BAD_ID }, "target: draft"],
    ["item.merged", "target", { origin_event: 0 }, "target: origin_event"],
    ["item.resolved", "confirmation", { hash: "abc" }, "confirmation: hash"],
    ["item.resolved", "ctx", { now: "2026-11-10" }, "ctx: now"],
    ["item.resolved", "ctx", { today: AT }, "ctx: today"],
    ["write.head", "ctx", { literal_checker: undefined }, "ctx: missing key literal_checker"],
    // flags that can only be true
    ["write.head", "ops/0/target", { by_entity_key: false }, "ops/0/target: by_entity_key"],
    ["write.head", "ops/0/target", { by_external_key: false }, "ops/0/target: by_external_key"],
    [
      "write.head (idempotency, corrected span)",
      "ops/0/target",
      { created: false },
      "ops/0/target: created",
    ],
    ["write.base", "fields/f3/2", { no_value: false }, "fields/f3/2: no_value"],
    ["write.base", "fields/f4/0", { uncovered: false }, "fields/f4/0: uncovered"],
    ["write.base", "existence/0", { restored: false }, "existence/0: restored"],
    ["write.base", "target", { created: false }, "target: created"],
    [
      "write.base",
      "revert",
      { items: [{ event: 21, existence: false }] },
      "revert.items[0]: existence",
    ],
    ["write.base", "ack/1", { no_value: false }, "ack/1: no_value"],
    // conditional keys, both ways
    ["write.base", "target", { op_index: undefined }, "target: op_index"],
    ["write.base", "target", { item: ITEM }, "target: item only with cause resolve"],
    [
      "write.base (resolve: take_previous)",
      "target",
      { op_index: 0 },
      "target: op_index only with cause request",
    ],
    ["item.created", "target", { merge_base_op: undefined }, "target: merge_base_op"],
    [
      "item.created (awaiting, on existence)",
      "target",
      { merge_base_op: 1 },
      "target: merge_base_op",
    ],
    ["item.created", "target", { related_item: ITEM_B }, "target: related_item"],
    [
      "item.created (restored candidate)",
      "target",
      { related_item: undefined },
      "target: related_item",
    ],
    [
      "item.refreshed",
      "target",
      { writer_had_read: undefined },
      "target: missing key writer_had_read",
    ],
    ["item.refreshed", "target", { writer_had_read: true }, "target: read"],
    [
      "item.refreshed",
      "target",
      { dropped_candidates: [1] },
      "target: unknown key dropped_candidates",
    ],
    [
      "item.refreshed (entries deleted)",
      "target",
      { restored_candidates: [1] },
      "target: unknown key restored_candidates",
    ],
    [
      "item.refreshed (entries deleted)",
      "target",
      { dropped_candidates: [] },
      "target: dropped_candidates",
    ],
    ["item.superseded", "target", { reason: "deleted" }, "target: unknown key writer_had_read"],
    ["item.resolved", "target", { candidate: undefined }, "target: missing key candidate"],
    ["item.resolved (keep)", "target", { candidate: 0 }, "target: unknown key candidate"],
    [
      "write.base (resolve: take_previous)",
      "revert",
      // Without as_of_op it reads as an undo's record, which needs before_op.
      { as_of_op: undefined },
      "revert: missing key before_op",
    ],
    [
      "write.base (resolve: take_previous)",
      "revert",
      { skipped: [] },
      "revert: unknown key skipped",
    ],
    ["write.base", "revert", { before_op: undefined }, "revert: missing key before_op"],
    ["source.recorded (file)", "target", { op_index: 0 }, "target: op_index only on api_call"],
    // more shapes
    ["write.base", "ack/0", { no_value: true }, "ack/0: exactly one of value and no_value"],
    ["write.base", "ack/1", { no_value: undefined }, "ack/1: exactly one of value and no_value"],
    [
      "write.base",
      "fields/f5/0",
      { value: { instant: "2026-11-10", zone: "Asia/Shanghai" } },
      "fields/f5/0.value: instant",
    ],
    ["write.base", "fields/f5/0", { value: { instant: AT, zone: "" } }, "fields/f5/0.value: zone"],
    ["write.head", "ops/0/set/f3", { value: "01" }, "ops/0/set/f3: decimal"],
    [
      "write.base",
      "fields/f3/0",
      { no_value: true },
      "fields/f3/0: exactly one of value, no_value, uncovered",
    ],
    [
      "write.base",
      "span/f3/0",
      { seen_valid: { from: "2026-11-01" } },
      "span/f3/0: exactly one of valid and seen_valid",
    ],
    [
      "write.base",
      "revert",
      { items: [{ event: 21, field: "f3", k: 0 }] },
      "revert.items[0]: unknown key k",
    ],
    [
      "write.base",
      "revert",
      { items: [], skipped: [{ event: 21, field: "f3" }] },
      "revert.skipped[0]: by_op",
    ],
    [
      "write.base (resolve: take_previous)",
      "revert",
      { items: [{ event: 35, field: "f3", later: true }] },
      "revert.items[0]: unknown key later",
    ],
    [
      "write.base (resolve: take_candidate)",
      "take",
      { items: [{ event: 35, field: "f3", later: true }] },
      "take.items[0]: unknown key later",
    ],
    ["item.created", "target", { unit: undefined }, "target: unit"],
    // intervals, values, references
    [
      "write.base",
      "span/f3/0",
      { valid: { from: "2026-11-01", to: "2026-11-01" } },
      "span/f3/0.valid: to after from",
    ],
    [
      "write.base",
      "span/f3/0",
      { valid: { from: "2026-11-01", to: AT } },
      "span/f3/0.valid: from and to of one granularity",
    ],
    [
      "write.head",
      "ops/1/valid",
      { from: { mode: "given", value: "2026-11-09" }, to: { mode: "given", value: "2026-11-01" } },
      "ops/1/valid: to after from",
    ],
    [
      "write.head",
      "ops/1/valid",
      { from: { mode: "given", value: "2026-11-01" }, to: { mode: "given", value: AT } },
      "ops/1/valid: from and to of one granularity",
    ],
    [
      "write.head",
      "ops/1/valid",
      { from: { mode: "corrected_span" } },
      "ops/1/valid: corrected_span on both ends",
    ],
    ["write.base", "fields/f3/0", { value: 32.5 }, "fields/f3/0.value: not a field value"],
    [
      "write.base",
      "fields/f3/0",
      { value: { value: "32.5" } },
      "fields/f3/0.value: missing key unit",
    ],
    [
      "write.base",
      "fields/f3/0",
      { value: { value: "32.50", unit: "CNY" } },
      "fields/f3/0.value: decimal",
    ],
    [
      "write.base",
      "span/f3/0",
      { deps: [{ event: 27, field: "f3" }] },
      "span/f3/0.deps[0]: missing key k",
    ],
    ["write.base", "sources/f3/1", { 0: undefined }, "sources/f3/1: not an array"],
    ["write.base", "literal/f3/0", { segments: [] }, "literal/f3/0.segments: empty"],
    ["write.head", "ops/0/noop", { 0: undefined }, "ops/0/noop: not an array"],
    ["item.created", "target", { unit: ["f3", "f3"] }, "target: unit"],
    ["item.created", "target", { unit: ["f3", "existence"] }, "target: unit"],
    ["item.created", "candidates/0", { items: [] }, "candidates/0.items: empty"],
    [
      "item.created",
      "candidates/0",
      { items: [{ existence: 0 }] },
      "candidates/0: an existence item on a candidate that is not a revoke",
    ],
    [
      "item.created (awaiting, on existence)",
      "candidates/0",
      { items: [{ existence: 0 }, { field: "f3", k: 0, value: "1" }] },
      "candidates/0: a revoke candidate's items",
    ],
    [
      "write.head",
      "ops/0/target",
      { by_external_key: true, by_entity_key: true },
      "ops/0/target: one way to locate",
    ],
    [
      "write.head (idempotency, corrected span)",
      "ops/0/target",
      { ver: { op: 1, restore_count: 0, basis: "explicit" } },
      "ops/0/target: ver on an insert",
    ],
    [
      "write.head",
      "ops/0/target",
      { ver: { op: 21, restore_count: 0, basis: "external_key" } },
      "ops/0/target: external_key basis without by_external_key",
    ],
  ];
  it.each(cases)("%s %s %j: %s", (name, path, patch, issue) => {
    expect(issues(parse(patched(name, path, patch)))).toContain(issue);
  });

  it("refuses an empty no-op or named-fields list", () => {
    expect(issues(parse(withBlock(S("write.head"), "ops/0/noop", [])))).toContain(
      "ops/0/noop: empty",
    );
    expect(issues(parse(withBlock(S("write.head"), "ops/0/named_fields", [])))).toContain(
      "ops/0/named_fields: empty",
    );
  });
});

describe("parseEvent: rules between the blocks of one write event", () => {
  const without = (s: Sample, path: string): Sample => {
    const { [path]: _, ...rest } = s.blocks;
    return { ...s, blocks: rest };
  };

  it("source.recorded: exactly one of text, file, request, each with its kinds", () => {
    const req = S("source.recorded");
    expect(issues(parse(without(req, "request")))).toContain(
      "event: exactly one of text, file, request",
    );
    expect(issues(parse(withBlock(req, "text", { text: "x" })))).toContain(
      "event: exactly one of text, file, request",
    );
    const text = S("source.recorded (text)");
    const asApi = withBlock(text, "target", {
      source_id: SOURCE,
      kind: "api_call",
      level: "user_stated",
    });
    expect(issues(parse(asApi))).toContain("text: kind");
    const file = S("source.recorded (file)");
    const fileAsText = withBlock(file, "target", {
      source_id: SOURCE,
      kind: "user_message",
      level: "user_stated",
    });
    expect(issues(parse(fileAsText))).toContain("file: kind");
    const reqAsFile = withBlock(req, "target", {
      source_id: SOURCE,
      kind: "file_ref",
      level: "user_stated",
    });
    expect(issues(parse(reqAsFile))).toContain("request: kind");
  });

  it("write.head: at most one of request_key and idempotency; op indices below op_count", () => {
    const head = S("write.head");
    expect(
      issues(parse(withBlock(head, "idempotency", { key: "k", fingerprint: HASH }))),
    ).toContain("event: request_key and idempotency");
    expect(
      issues(parse(withBlock(head, "request", { sv: 1, sv_basis: "explicit", op_count: 1 }))),
    ).toContain("ops/1/target: op index not below op_count");
  });

  it("item.resolved: at most one of request_key and idempotency", () => {
    const r = withBlock(withBlock(S("item.resolved"), "request_key", { key: "k" }), "idempotency", {
      key: "k",
      fingerprint: HASH,
    });
    expect(issues(parse(r))).toContain("event: request_key and idempotency");
  });

  it("write.base: a value item has sources, others none; spans and literal belong to an item", () => {
    const base = S("write.base");
    expect(issues(parse(without(base, "sources/f3/0")))).toContain("fields/f3/0: sources required");
    expect(
      issues(parse(withBlock(base, "sources/f3/2", [{ kind: "value", source: 26 }]))),
    ).toContain("fields/f3/2: sources only on a value");
    expect(
      issues(parse(withBlock(base, "span/f9/0", { valid: { from: "2026-11-01" } }))),
    ).toContain("span/f9/0: no such item");
    expect(
      issues(parse(withBlock(base, "literal/f9/0", { segments: [{ source: 26, result: "hit" }] }))),
    ).toContain("literal/f9/0: no such item");
    // A removed sources block counts as present (§1.1).
    expect(parse(without(base, "sources/f3/0"), ["sources/f3/0"]).ok).toBe(true);
  });

  it("write.base: an existence item has a span exactly with scope interval", () => {
    const base = S("write.base");
    expect(issues(parse(without(base, "span/existence/0")))).toContain(
      "existence/0: span required",
    );
    const whole = withBlock(base, "existence/0", { status: "applied", scope: "whole" });
    expect(issues(parse(whole))).toContain("existence/0: no span with scope whole");
    expect(
      issues(parse(withBlock(base, "span/existence/1", { valid: { from: "2026-11-01" } }))),
    ).toContain("span/existence/1: no such item");
  });

  it("write.base: a revert or a take, not both", () => {
    const take = S("write.base (resolve: take_candidate)");
    const both = withBlock(take, "revert", { as_of_op: 29, item: ITEM, items: [] });
    expect(issues(parse(both))).toContain("event: revert and take");
  });

  it("item.created: a schema change has no candidates", () => {
    const sc = withBlock(
      S("item.created (schema change)"),
      "candidates/0",
      S("item.created").blocks["candidates/0"],
    );
    expect(issues(parse(sc))).toContain("event: candidates on a schema change");
  });
});

describe("parseEvent: lists of a write's blocks", () => {
  it("refuses repeated fields, an acknowledge other than overwrite, empty or odd sources", () => {
    const head = SAMPLES["write.head"] as Sample;
    const base = SAMPLES["write.base"] as Sample;
    expect(issues(parse(withBlock(head, "ops/0/noop", ["f1", "f1"])))).toContain(
      "ops/0/noop: duplicate field",
    );
    expect(issues(parse(withBlock(head, "ops/0/acknowledge", ["merge"])))).toContain(
      "ops/0/acknowledge: acknowledge",
    );
    expect(issues(parse(withBlock(base, "sources/f3/0", [])))).toContain("sources/f3/0: empty");
    expect(
      issues(
        parse(
          withBlock(base, "sources/f3/0", [{ kind: "value", carried: { event: 2, existence: 0 } }]),
        ),
      ),
    ).toContain("sources/f3/0[0]: carried from a field item");
    expect(issues(parse(withBlock(base, "valid_sources", [26, 26])))).toContain(
      "valid_sources: duplicate seq",
    );
    const req = SAMPLES["source.recorded"] as Sample;
    expect(issues(parse(withBlock(req, "request", ["intent"])))).toContain(
      "request: not an object",
    );
  });
});

describe("parseEvent: every value of a write's blocks is checked", () => {
  // Each leaf of each sample block (inside objects and arrays) replaced by a value of another JSON
  // type must be refused: a checker that skips a value lets it through. `source.recorded`
  // `request` is the request JSON itself and takes any value.
  const poison = (v: unknown): unknown =>
    typeof v === "string" ? 123 : typeof v === "number" ? "7" : typeof v === "boolean" ? 1 : 0;
  function leaves(v: unknown, at: (string | number)[] = []): (string | number)[][] {
    if (Array.isArray(v)) return v.flatMap((x, i) => leaves(x, [...at, i]));
    if (v !== null && typeof v === "object") {
      return Object.entries(v).flatMap(([k, x]) => leaves(x, [...at, k]));
    }
    return [at];
  }
  function replaced(v: unknown, at: readonly (string | number)[], by: unknown): unknown {
    const [head, ...rest] = at;
    if (head === undefined) return by;
    if (Array.isArray(v)) return v.map((x, i) => (i === head ? replaced(x, rest, by) : x));
    const o = v as Record<string, unknown>;
    return { ...o, [head]: replaced(o[head as string], rest, by) };
  }
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks)
      .filter(([path]) => !(name.startsWith("source.recorded") && path === "request"))
      .flatMap(([path, v]) => leaves(v).map((at) => [name, path, at.join("."), at, v] as const)),
  );
  it.each(cases)("%s %s .%s", (name, path, _, at, v) => {
    const s = SAMPLES[name] as Sample;
    const bad = replaced(v, at, poison(at.reduce<unknown>((x, k) => (x as never)[k], v)));
    expect(parse(withBlock(s, path, bad)).ok).toBe(false);
  });
});

it("parseEvent: an awaiting item may be for an undo hiding later writes", () => {
  const s = patched("item.created (awaiting, on existence)", "target", {
    reason: "undo_hides_later",
  });
  expect(parse(s)).toEqual({ ok: true, type: "item.created" });
});

describe("scope_valid: the item's interval as its spans (§5.8)", () => {
  const scope = (spans: unknown) =>
    issues(parse(withBlock(S("item.created"), "scope_valid", { spans, deps })));
  const span = (from: string, to?: string) => ({ from, ...(to !== undefined ? { to } : {}) });

  it("accepts spans by start, apart, one granularity, the last one open", () => {
    expect(scope([span("2026-11-01", "2026-11-03"), span("2026-11-05")])).toEqual([]);
    expect(scope([span("2026-11-01T00:00:00.000Z", "2026-11-01T06:00:00.000Z")])).toEqual([]);
  });

  it.each([
    ["none", [], "scope_valid.spans: at least one span"],
    [
      "touching",
      [span("2026-11-01", "2026-11-03"), span("2026-11-03", "2026-11-05")],
      "scope_valid: spans by start, apart",
    ],
    [
      "overlapping",
      [span("2026-11-01", "2026-11-04"), span("2026-11-03", "2026-11-05")],
      "scope_valid: spans by start, apart",
    ],
    [
      "out of order",
      [span("2026-11-05", "2026-11-07"), span("2026-11-01", "2026-11-03")],
      "scope_valid: spans by start, apart",
    ],
    [
      "open before the last",
      [span("2026-11-01"), span("2026-11-05", "2026-11-07")],
      "scope_valid: only the last span open",
    ],
    [
      "dates and instants mixed",
      [span("2026-11-01", "2026-11-03"), span("2026-11-05T00:00:00.000Z")],
      "scope_valid: spans of one granularity",
    ],
  ])("refuses spans %s", (_, spans, issue) => {
    expect(scope(spans)).toContain(issue);
  });
});
