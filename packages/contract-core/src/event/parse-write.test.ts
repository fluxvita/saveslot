// Shape checks of a write's events (09-event-format §5.6–§5.8, `write.derived` in §5.7, §5.10): a well-formed sample of every block
// shape the checks cover, then, block by block, the negatives every checker must report (an unknown
// key, each required key missing), and the rules a shape adds beyond its keys.

import { describe, expect, it } from "vitest";
import { type ParseResult, parseEvent } from "./parse.ts";

const HASH = "a".repeat(64);
const CONN = `ci_${"2".repeat(26)}`;
const SLOT = `sl_${"4".repeat(16)}`;
const ROW = `r_${"6".repeat(26)}`;
const ROW_B = `r_${"1".repeat(26)}`;
const ENTITY = `e_${"7".repeat(26)}`;
const ITEM = `pi_${"8".repeat(16)}`;
const ITEM_B = `pi_${"9".repeat(16)}`;
const SOURCE = `s_${"3".repeat(16)}`;
const AT = "2026-11-10T04:41:07.123Z";
const PARTITION = `p_${"5".repeat(16)}`;

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
  // An op by external key hitting a row (its sync baseline, one position per field it sets, the
  // earliest as its ver) and one creating its row (no ver, no baseline).
  "write.head (by external key)": {
    header: head("write.head", 25),
    blocks: {
      ctx: { ...ctx, literal_checker: "literal@1" },
      request: { sv: 1, sv_basis: "explicit", op_count: 3 },
      "ops/0/target": {
        table: "t1",
        row: ROW,
        intent: "update",
        by_external_key: true,
        ver: { op: 12, restore_count: 0, basis: "external_key" },
      },
      "ops/0/set/f3": { value: "32.50", unit: "CNY" },
      "ops/0/set/f4": "lunch",
      "ops/0/noop": ["f1", "f2"],
      "ops/0/baseline": { f3: 12, f4: 24 },
      "ops/2/target": {
        table: "t1",
        row: ROW_B,
        intent: "correct",
        by_external_key: true,
        created: true,
      },
      "ops/2/set/f1": "band_app",
      "ops/2/set/f3": { value: "10", unit: "CNY" },
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
      ctx,
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
  "write.derived": {
    header: member("write.derived", 41),
    blocks: {
      target: {
        table: "t2",
        rule: "r1",
        rule_version: 1,
        partition: PARTITION,
        read_pos: 40,
        reads: [{ table: "t1" }],
        emptied: false,
      },
      key: { values: ["2026-11-01", null, { value: "5", unit: "km" }] },
      checksum: { checksum: HASH },
    },
  },
  "write.head (premises)": {
    header: head("write.head", 25),
    blocks: {
      ctx: { ...ctx, literal_checker: "literal@1" },
      request: { sv: 1, sv_basis: "explicit", op_count: 3 },
      // An insert with two premises: a row's field, and an entity over a stretch it was given.
      "ops/0/target": { table: "t1", row: ROW, intent: "insert", created: true },
      "ops/0/set/f3": "plan",
      "ops/0/premises/0": {
        table: "t3",
        row: ROW,
        fields: ["f2"],
        ver: { op: 21, restore_count: 0, basis: "explicit" },
        range: "whole",
        state: "current",
      },
      "ops/0/premises/1": {
        table: "t2",
        entity: ENTITY,
        ver: { op: 22, restore_count: 0, basis: "fallback" },
        range: "row_time",
        state: "changed",
        reason: "retroactive",
        since: 24,
      },
      "ops/0/premise_valid/1": { during: { from: "2026-11-01", to: "2026-12-01" }, deps },
      // A restatement: no set, a premise, the row's other items covered.
      "ops/1/target": {
        table: "t1",
        row: ROW,
        intent: "update",
        ver: { op: 21, restore_count: 0, basis: "explicit" },
      },
      "ops/1/premises/0": {
        table: "t2",
        entity: ENTITY,
        ver: { op: 22, restore_count: 0, basis: "explicit" },
        range: "given",
        state: "current",
      },
      "ops/1/premise_valid/0": { at: "2026-11-10" },
      "ops/1/premise_covers": [
        { event: 20, field: "f3", k: 0 },
        { event: 20, existence: 0 },
      ],
      // A clearing.
      "ops/2/target": {
        table: "t1",
        row: ROW,
        intent: "update",
        ver: { op: 21, restore_count: 0, basis: "explicit" },
      },
      "ops/2/premises_cleared": true,
      "ops/2/premise_covers": [{ event: 20, field: "f3", k: 0 }],
    },
  },
  "premise.changed": {
    header: member("premise.changed", 44),
    blocks: {
      "targets/0": {
        table: "t3",
        row: ROW,
        by_event: 27,
        changed: [{ op: 20, i: 0, j: 0, reason: "update" }],
        matched: [{ op: 23, i: 1, j: 0 }],
        repointed: [{ op: 19, i: 0, j: 2 }],
      },
      "targets/1": { table: "t2", entity: ENTITY, by_event: 28, matched: [{ op: 23, i: 0, j: 1 }] },
    },
  },
  "write.derived emptied": {
    header: member("write.derived", 42),
    blocks: {
      target: {
        table: "t2",
        rule: "r1",
        rule_version: 3,
        partition: PARTITION,
        read_pos: 1,
        reads: [{ table: "t10" }, { table: "t2" }],
        emptied: true,
      },
    },
  },
  "write.derived whole": {
    header: member("write.derived", 43),
    blocks: {
      target: {
        table: "t2",
        rule: "r1",
        rule_version: 1,
        partition: PARTITION,
        read_pos: 40,
        reads: [{ table: "t1" }],
        emptied: false,
      },
      key: { values: [] },
      checksum: { checksum: HASH },
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
    "by_external_key",
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
    // A premise on the whole row has no fields; a premise target's block keeps one list at least.
    "fields",
    "changed",
    "matched",
    "repointed",
  ]);
  const cases = Object.entries(SAMPLES).flatMap(([name, s]) =>
    Object.entries(s.blocks).flatMap(([path, v]) =>
      // `source.recorded` `request` is the request JSON itself: any keys. A baseline is keyed by
      // field ID: no fixed keys (its own cases below).
      v !== null &&
      typeof v === "object" &&
      !Array.isArray(v) &&
      !(name.startsWith("source.recorded") && path === "request") &&
      !path.endsWith("/baseline")
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
    // premises (§5.7)
    [
      "write.head (premises)",
      "ops/0/premises/0",
      { range: "from_now" },
      "ops/0/premises/0: range whole exactly on a row",
    ],
    [
      "write.head (premises)",
      "ops/0/premises/1",
      { range: "whole" },
      "ops/0/premises/1: range whole exactly on a row",
    ],
    ["write.head (premises)", "ops/0/premises/0", { range: "always" }, "ops/0/premises/0: range"],
    ["write.head (premises)", "ops/0/premises/0", { state: "stale" }, "ops/0/premises/0: state"],
    [
      "write.head (premises)",
      "ops/0/premises/0",
      { ver: { op: 21, restore_count: 0, basis: "external_key" } },
      "ops/0/premises/0.ver: basis",
    ],
    ["write.head (premises)", "ops/0/premises/0", { fields: [] }, "ops/0/premises/0.fields: empty"],
    [
      "write.head (premises)",
      "ops/0/premises/0",
      { fields: ["f2", "f2"] },
      "ops/0/premises/0.fields: duplicate field",
    ],
    [
      "write.head (premises)",
      "ops/0/premises/0",
      { reason: "update" },
      "ops/0/premises/0: reason or since on a current premise",
    ],
    [
      "write.head (premises)",
      "ops/0/premises/1",
      { reason: "schema_changed" },
      "ops/0/premises/1: reason",
    ],
    ["write.head (premises)", "ops/0/premises/1", { since: "22" }, "ops/0/premises/1: since"],
    [
      "write.head (premises)",
      "ops/0/premises/1",
      { row: ROW },
      "ops/0/premises/1: exactly one of row and entity",
    ],
    [
      "write.head (premises)",
      "ops/0/premise_valid/1",
      { during: { from: "2026-12-01", to: "2026-11-01" } },
      "ops/0/premise_valid/1.during: to after from",
    ],
    [
      "write.head (premises)",
      "ops/0/premise_valid/1",
      { deps: [] },
      "ops/0/premise_valid/1.deps: empty",
    ],
    [
      "write.head (premises)",
      "ops/1/premise_valid/0",
      { at: "11/10" },
      "ops/1/premise_valid/0: at",
    ],
    [
      "premise.changed",
      "targets/0",
      { changed: [{ op: 20, i: 0, j: 0, reason: "schema_changed" }] },
      "targets/0.changed[0]: reason",
    ],
    ["premise.changed", "targets/0", { matched: [] }, "targets/0.matched: empty"],
    [
      "premise.changed",
      "targets/0",
      { matched: [{ op: 20, i: 0, j: 0 }] },
      "targets/0: a declaration twice",
    ],
    [
      "premise.changed",
      "targets/1",
      { matched: undefined },
      "targets/1: none of changed, matched, repointed",
    ],
    ["premise.changed", "targets/0", { by_event: 0 }, "targets/0: by_event"],
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
    // §5.1: only write.head has it; a decision's write checks nothing literally.
    ["item.resolved", "ctx", { literal_checker: "literal@1" }, "ctx: unknown key literal_checker"],
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
    // open at the start: on existence only (§1.2); a field's spans and entries have a start
    [
      "write.base",
      "span/f3/0",
      { valid: { to: "2026-11-09" } },
      "span/f3/0.valid: missing key from",
    ],
    [
      "write.base",
      "span/f4/0",
      { seen_valid: { to: "2026-11-09" } },
      "span/f4/0.seen_valid: missing key from",
    ],
    [
      "item.created",
      "current/0",
      { valid: { to: "2026-11-09" } },
      "current/0.valid: missing key from",
    ],
    [
      "item.created",
      "previous/0",
      { valid: { to: "2026-11-09" } },
      "previous/0.valid: missing key from",
    ],
    [
      "item.created",
      "impact/0",
      { valid: { to: "2026-11-09" } },
      "impact/0.valid: missing key from",
    ],
    [
      "item.created",
      "candidates/0",
      { items: [{ field: "f3", k: 0, value: "32", valid: { to: "2026-11-09" } }] },
      "candidates/0.items[0].valid: missing key from",
    ],
    [
      "item.created (awaiting, on existence)",
      "proposed/0",
      { valid: { to: "2026-11-09" } },
      "proposed/0.valid: missing key from",
    ],
    ["write.base", "span/f3/0", { valid: {} }, "span/f3/0.valid: missing key from"],
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
    // §5.2 `ver.current`: only true, and only on an explicit or fallback version.
    [
      "write.head",
      "ops/0/target",
      { ver: { op: 21, restore_count: 0, basis: "explicit", current: false } },
      "ops/0/target.ver: current",
    ],
    [
      "write.head",
      "ops/0/target",
      { ver: { op: 21, restore_count: 0, basis: "same_request", current: true } },
      "ops/0/target.ver: current on this basis",
    ],
    // write.derived (§5.7)
    ["write.derived", "target", { table: "x" }, "target: table"],
    ["write.derived", "target", { rule: "t1" }, "target: rule"],
    ["write.derived", "target", { rule_version: 0 }, "target: rule_version"],
    ["write.derived", "target", { rule_version: "1" }, "target: rule_version"],
    ["write.derived", "target", { partition: "p_1" }, "target: partition"],
    ["write.derived", "target", { partition: BAD_ID }, "target: partition"],
    ["write.derived", "target", { read_pos: 0 }, "target: read_pos"],
    ["write.derived", "target", { read_pos: -1 }, "target: read_pos"],
    [
      "write.derived",
      "target",
      { reads: [{ table: "t1" }, { table: "t1" }] },
      "target.reads: not in ascending order without repeats",
    ],
    [
      "write.derived",
      "target",
      { reads: [{ table: "t3" }, { table: "t1" }] },
      "target.reads: not in ascending order without repeats",
    ],
    [
      "write.derived",
      "target",
      { reads: [{ table: "t2" }, { table: "t10" }] },
      "target.reads: not in ascending order without repeats",
    ],
    ["write.derived", "target", { read_pos: 1.5 }, "target: read_pos"],
    ["write.derived", "target", { reads: [] }, "target.reads: empty"],
    ["write.derived", "target", { reads: {} }, "target.reads: not an array"],
    ["write.derived", "target", { reads: [{ table: "f1" }] }, "target.reads[0]: table"],
    [
      "write.derived",
      "target",
      { reads: [{ table: "t1", x: 1 }] },
      "target.reads[0]: unknown key x",
    ],
    ["write.derived", "target", { reads: ["t1"] }, "target.reads[0]: not an object"],
    ["write.derived", "target", { emptied: "no" }, "target: emptied"],
    ["write.derived", "key", { values: "2026-11-01" }, "key.values: not an array"],
    ["write.derived", "key", { values: [{ value: "05", unit: "km" }] }, "key.values[0]: decimal"],
    ["write.derived", "key", { values: [1] }, "key.values[0]: not a field value"],
    ["write.derived", "checksum", { checksum: "abc" }, "checksum: checksum"],
    ["write.derived", "checksum", { checksum: HASH.toUpperCase() }, "checksum: checksum"],
  ];
  it.each(cases)("%s %s %j: %s", (name, path, patch, issue) => {
    expect(issues(parse(patched(name, path, patch)))).toContain(issue);
  });

  it("refuses an empty no-op or named-fields list", () => {
    expect(issues(parse(withBlock(S("write.head"), "ops/0/noop", [])))).toContain(
      "ops/0/noop: empty",
    );
    expect(issues(parse(withBlock(S("write.head"), "ops/0/explicit", [])))).toContain(
      "ops/0/explicit: empty",
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

  it("write.derived: emptied has neither key nor checksum; a row has its checksum", () => {
    const emptied = S("write.derived emptied");
    expect(issues(parse(withBlock(emptied, "key", { values: ["2026-11-01"] })))).toContain(
      "key: not with emptied",
    );
    expect(issues(parse(withBlock(emptied, "checksum", { checksum: HASH })))).toContain(
      "checksum: not with emptied",
    );
    // A cleared block counts as present.
    expect(issues(parse(emptied, ["checksum"]))).toContain("checksum: not with emptied");
    const row = S("write.derived");
    expect(issues(parse(without(row, "checksum")))).toContain("checksum: required unless emptied");
    // A checksum cleared by a deletion (09 §5.7) is still there.
    expect(parse(without(row, "checksum"), ["checksum"])).toEqual({
      ok: true,
      type: "write.derived",
    });
    expect(parse(without(row, "key"))).toEqual({ ok: true, type: "write.derived" });
  });

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

  it("write.head: a premise's business time exactly with row_time or given; clearing has no premises; covers need either", () => {
    const head = S("write.head (premises)");
    expect(issues(parse(without(head, "ops/0/premise_valid/1")))).toContain(
      "ops/0/premises/1: premise_valid required",
    );
    expect(issues(parse(withBlock(head, "ops/0/premise_valid/0", { at: "2026-11-10" })))).toContain(
      "ops/0/premises/0: premise_valid only with row_time or given",
    );
    expect(issues(parse(withBlock(head, "ops/0/premise_valid/2", { at: "2026-11-10" })))).toContain(
      "ops/0/premise_valid/2: no such premise",
    );
    const both = withBlock(head, "ops/2/premises/0", head.blocks["ops/0/premises/0"]);
    expect(issues(parse(both))).toContain("ops/2/premises_cleared: premises with premises_cleared");
    const covers = without(without(head, "ops/1/premises/0"), "ops/1/premise_valid/0");
    expect(issues(parse(covers))).toContain(
      "ops/1/premise_covers: premise_covers without premises",
    );
    // Two declarations of one op on one target: refused (one item, one declaration per target).
    const again = withBlock(head, "ops/0/premises/2", {
      ...(head.blocks["ops/0/premises/0"] as object),
      fields: ["f3"],
    });
    expect(issues(parse(again))).toContain(
      "ops/0/premises/2: the target of ops/0/premises/0 again",
    );
    // Named by order, not by the text of the paths.
    const late = withBlock(head, "ops/0/premises/10", head.blocks["ops/0/premises/0"]);
    expect(issues(parse(late))).toContain(
      "ops/0/premises/10: the target of ops/0/premises/0 again",
    );
    // On different ops it is a later declaration taking over, not refused.
    const otherOp = withBlock(head, "ops/1/premises/1", head.blocks["ops/0/premises/0"]);
    expect(parse(otherOp)).toEqual({ ok: true, type: "write.head" });
    // A clearing covers what it clears without declarations of its own.
    expect(parse(head)).toEqual({ ok: true, type: "write.head" });
  });

  it("write.head: premise blocks on an op that cannot take them, or out of order", () => {
    const head = S("write.head (premises)");
    const decl = head.blocks["ops/0/premises/0"] as Record<string, unknown>;
    // On a revoke, on a revert, and a clearing other than an update.
    const revoke = withBlock(head, "ops/1/target", {
      ...(head.blocks["ops/1/target"] as object),
      intent: "revoke",
    });
    expect(issues(parse(revoke))).toContain("ops/1/premises/0: premises on a revoke");
    const revert = withBlock(head, "ops/1/revert", { undo_op: 20, include_later: false });
    expect(issues(parse(revert))).toContain("ops/1/premises/0: premises with revert");
    const correct = withBlock(head, "ops/2/target", {
      ...(head.blocks["ops/2/target"] as object),
      intent: "correct",
    });
    expect(issues(parse(correct))).toContain("ops/2/premises_cleared: a clearing not an update");
    // An op by external key: neither declarations nor a clearing.
    const byKey = (i: number) =>
      withBlock(head, `ops/${i}/target`, {
        ...(head.blocks[`ops/${i}/target`] as object),
        by_external_key: true,
      });
    expect(issues(parse(byKey(1)))).toContain(
      "ops/1/premises/0: premises on a write by external key",
    );
    expect(issues(parse(byKey(2)))).toContain(
      "ops/2/premises_cleared: premises on a write by external key",
    );
    // A clearing with a revert.
    const clearRevert = withBlock(head, "ops/2/revert", { undo_op: 20, include_later: false });
    expect(issues(parse(clearRevert))).toContain("ops/2/premises_cleared: premises with revert");
    // The op's own target.
    const self = withBlock(head, "ops/0/premises/0", { ...decl, table: "t1", row: ROW });
    expect(issues(parse(self))).toContain("ops/0/premises/0: the op's own target");
    // No ops/<i>/target.
    const noTarget = without(head, "ops/2/target");
    expect(issues(parse(noTarget))).toContain("ops/2/premises_cleared: no ops target for it");
    // Indices with a gap.
    const gap = without(without(head, "ops/1/premises/0"), "ops/1/premise_valid/0");
    const gapped = withBlock(
      withBlock(gap, "ops/1/premises/1", head.blocks["ops/1/premises/0"]),
      "ops/1/premise_valid/1",
      head.blocks["ops/1/premise_valid/0"],
    );
    expect(issues(parse(gapped))).toContain("ops/1/premises: indices not from 0 without a gap");
    // Versions: none before 1; one at or after this operation (25) is not the shape's to refuse
    // (a ver given before an import may be past this log's end, 04-contract §15: apply checks where
    // it reads); a version of this request is this operation's; since by this operation at the
    // latest.
    const ver = (v: object) => withBlock(head, "ops/0/premises/0", { ...decl, ver: v });
    expect(issues(parse(ver({ op: 0, restore_count: 0, basis: "explicit" })))).toContain(
      "ops/0/premises/0: a version seen not an operation",
    );
    expect(issues(parse(ver({ op: 25, restore_count: 0, basis: "explicit" })))).not.toContain(
      "ops/0/premises/0: a version seen not an operation",
    );
    expect(issues(parse(ver({ op: 24, restore_count: 0, basis: "same_request" })))).toContain(
      "ops/0/premises/0: a version of this request not this operation",
    );
    expect(parse(ver({ op: 25, restore_count: 0, basis: "same_request" }))).toEqual({
      ok: true,
      type: "write.head",
    });
    const since = withBlock(head, "ops/0/premises/1", {
      ...(head.blocks["ops/0/premises/1"] as object),
      since: 26,
    });
    expect(issues(parse(since))).toContain("ops/0/premises/1: since after this operation");
    // An item twice in premise_covers, its keys in another order.
    const covers = withBlock(head, "ops/1/premise_covers", [
      { event: 20, field: "f3", k: 0 },
      { k: 0, field: "f3", event: 20 },
    ]);
    expect(issues(parse(covers))).toContain("ops/1/premise_covers: an item twice");
  });

  it("premise.changed: targets from 0 without a gap, a declaration in one block, nothing after this event", () => {
    const pc = S("premise.changed");
    const gap = withBlock(without(pc, "targets/1"), "targets/2", pc.blocks["targets/1"]);
    expect(issues(parse(gap))).toContain("targets: indices not from 0 without a gap");
    // The declaration (23, 1, 0) of targets/0 named again in targets/1.
    const twice = withBlock(pc, "targets/1", {
      table: "t2",
      entity: ENTITY,
      by_event: 28,
      changed: [{ op: 23, i: 1, j: 0, reason: "update" }],
    });
    expect(issues(parse(twice))).toContain("targets/1: a declaration of targets/0 again");
    // The event is seq 44 of operation 25.
    const later = withBlock(pc, "targets/1", {
      table: "t2",
      entity: ENTITY,
      by_event: 44,
      matched: [{ op: 26, i: 0, j: 1 }],
    });
    expect(issues(parse(later))).toEqual(
      expect.arrayContaining([
        "targets/1: by_event not before this event",
        "targets/1: a declaration after this operation",
      ]),
    );
    // by_event of an earlier operation (this one is 25), and a declaration of operation 0.
    const earlier = withBlock(pc, "targets/1", {
      table: "t2",
      entity: ENTITY,
      by_event: 3,
      matched: [{ op: 0, i: 0, j: 1 }],
    });
    expect(issues(parse(earlier))).toEqual(
      expect.arrayContaining([
        "targets/1: by_event not of this operation",
        "targets/1: a declaration of no operation",
      ]),
    );
  });

  it("premise.changed: one block for each target, at least one", () => {
    const pc = S("premise.changed");
    expect(issues(parse(without(without(pc, "targets/0"), "targets/1")))).toContain(
      "event: no target",
    );
    const twice = withBlock(pc, "targets/1", {
      table: "t3",
      row: ROW,
      by_event: 28,
      matched: [{ op: 23, i: 0, j: 1 }],
    });
    expect(issues(parse(twice))).toContain("targets/1: a target twice");
  });

  it("premise.changed: schema_switched is a reason (§6.8); an unknown one is not", () => {
    const pc = S("premise.changed");
    const at = (reason: string) =>
      parse(
        withBlock(pc, "targets/0", {
          table: "t3",
          row: ROW,
          by_event: 27,
          changed: [{ op: 20, i: 0, j: 0, reason }],
        }),
      );
    expect(at("schema_switched").ok).toBe(true);
    expect(issues(at("schema_changed"))).toContain("targets/0.changed[0]: reason");
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

  it("write.base: the target's sv is a version, from 1", () => {
    const base = S("write.base");
    const target = base.blocks["target"] as Record<string, unknown>;
    for (const sv of [0, -1])
      expect(issues(parse(withBlock(base, "target", { ...target, sv })))).toContain("target: sv");
    expect(parse(withBlock(base, "target", { ...target, sv: 2 })).ok).toBe(true);
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
    expect(issues(parse(withBlock(head, "ops/0/explicit", ["f2", "f2"])))).toContain(
      "ops/0/explicit: duplicate field",
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

describe("open at the start: existence's spans and entries (§1.2)", () => {
  it("accepts an existence span, an existence candidate item and an existence entry open at the start", () => {
    const open = { to: "2026-11-03" };
    expect(issues(parse(patched("write.base", "span/existence/0", { valid: open })))).toEqual([]);
    expect(
      issues(
        parse(
          patched("item.created (awaiting, on existence)", "candidates/0", {
            items: [{ existence: 0, valid: open }],
          }),
        ),
      ),
    ).toEqual([]);
    expect(
      issues(
        parse(
          withBlock(S("item.created"), "current/1", {
            field: "existence",
            valid: open,
            deps,
          }),
        ),
      ),
    ).toEqual([]);
  });
});

describe("scope_valid: the item's interval as its spans (§5.8)", () => {
  const scope = (spans: unknown) =>
    issues(parse(withBlock(S("item.created"), "scope_valid", { spans, deps })));
  const span = (from: string, to?: string) => ({ from, ...(to !== undefined ? { to } : {}) });

  it("accepts spans by start, apart, one granularity, the last one open", () => {
    expect(scope([span("2026-11-01", "2026-11-03"), span("2026-11-05")])).toEqual([]);
    expect(scope([span("2026-11-01T00:00:00.000Z", "2026-11-01T06:00:00.000Z")])).toEqual([]);
  });

  it("accepts the whole time as [{}]", () => {
    expect(scope([{}])).toEqual([]);
  });

  it("accepts the first span open at the start, alone or before others", () => {
    expect(scope([{ to: "2026-11-03" }])).toEqual([]);
    expect(scope([{ to: "2026-11-03" }, span("2026-11-05")])).toEqual([]);
    expect(scope([{ to: "2026-11-01T06:00:00.000Z" }, span("2026-11-02T00:00:00.000Z")])).toEqual(
      [],
    );
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
    [
      "the whole time before another span",
      [{}, span("2026-11-05", "2026-11-07")],
      "scope_valid: the whole time alone",
    ],
    [
      "open at the start after the first",
      [span("2026-11-01", "2026-11-03"), { to: "2026-11-07" }],
      "scope_valid.spans[1]: missing key from",
    ],
    [
      "the whole time after the first",
      [span("2026-11-01", "2026-11-03"), {}],
      "scope_valid.spans[1]: missing key from",
    ],
    [
      "open at the start overlapping the next",
      [{ to: "2026-11-05" }, span("2026-11-03", "2026-11-07")],
      "scope_valid: spans by start, apart",
    ],
    [
      "open at the start touching the next",
      [{ to: "2026-11-05" }, span("2026-11-05", "2026-11-07")],
      "scope_valid: spans by start, apart",
    ],
    [
      "open at the start, dates and instants mixed",
      [{ to: "2026-11-03" }, span("2026-11-05T00:00:00.000Z")],
      "scope_valid: spans of one granularity",
    ],
    [
      "open at both ends with another span",
      [{}, span("2026-11-05")],
      "scope_valid: the whole time alone",
    ],
  ])("refuses spans %s", (_, spans, issue) => {
    expect(scope(spans)).toContain(issue);
  });
});

describe("impact: a gap filled, apart from a value cleared to null (§5.8)", () => {
  const impact = (v: unknown) => issues(parse(withBlock(S("item.created"), "impact/0", v)));
  const seg = { kind: "overwritten_segment", field: "f3", deps };

  it("accepts a gap with or without the revoke that left it, and a null value with its write", () => {
    expect(impact({ ...seg, value: null, gap: true })).toEqual([]);
    expect(impact({ ...seg, value: null, gap: true, op: 21 })).toEqual([]);
    expect(impact({ ...seg, value: null, op: 21 })).toEqual([]);
  });

  it.each([
    ["a null value without its write", { ...seg, value: null }, "impact/0: op"],
    ["a gap with a value", { ...seg, value: "30", gap: true, op: 21 }, "impact/0: gap"],
    ["a gap marked false", { ...seg, value: null, gap: false, op: 21 }, "impact/0: gap"],
  ])("refuses %s", (_, v, issue) => {
    expect(impact(v)).toContain(issue);
  });
});

describe("an op by external key and its sync baseline (§5.7)", () => {
  const name = "write.head (by external key)";
  const target = (patch: Record<string, unknown>) => patched(name, "ops/0/target", patch);
  const ver = (v: Record<string, unknown>) => target({ ver: { restore_count: 0, ...v } });

  it.each([
    ["not an object", ["f3"], "ops/0/baseline: baseline"],
    ["empty", {}, "ops/0/baseline: empty baseline"],
    ["a key not a field ID", { f3: 12, f4: 24, x: 12 }, "ops/0/baseline: field x"],
    ["a position 0", { f3: 0, f4: 24 }, "ops/0/baseline: operation number of f3"],
    ["a position not an integer", { f3: 12, f4: "24" }, "ops/0/baseline: operation number of f4"],
  ])("the block's shape: refuses %s", (_, b, issue) => {
    expect(issues(parse(withBlock(S(name), "ops/0/baseline", b)))).toContain(issue);
  });

  it("refuses a baseline on an op not by external key, and a key's basis on one", () => {
    const plain = withBlock(S("write.head"), "ops/0/baseline", { f3: 12 });
    expect(issues(parse(plain))).toContain("ops/0/target: baseline without the external_key basis");
    expect(issues(parse(ver({ op: 12, basis: "explicit" })))).toEqual(
      expect.arrayContaining([
        "ops/0/target: a write by external key without its basis",
        "ops/0/target: baseline without the external_key basis",
      ]),
    );
    const notByKey = withBlock(S(name), "ops/0/target", {
      table: "t1",
      row: ROW,
      intent: "update",
      ver: { op: 12, restore_count: 0, basis: "external_key" },
    });
    expect(issues(parse(notByKey))).toContain(
      "ops/0/target: external_key basis without by_external_key",
    );
  });

  it("an op by key hitting a row: no ver, or no baseline, is refused", () => {
    expect(issues(parse(target({ ver: undefined })))).toEqual(
      expect.arrayContaining([
        "ops/0/target: a write by external key without its basis",
        "ops/0/target: baseline without the external_key basis",
      ]),
    );
    const s = S(name);
    const { ["ops/0/baseline"]: _, ...rest } = s.blocks;
    expect(issues(parse({ ...s, blocks: rest }))).toContain(
      "ops/0/target: external_key basis without baseline",
    );
  });

  it("an op by key creating its row: no ver, no baseline", () => {
    const withVer = patched(name, "ops/2/target", {
      ver: { op: 12, restore_count: 0, basis: "external_key" },
    });
    expect(issues(parse(withVer))).toEqual(
      expect.arrayContaining([
        "ops/2/target: ver on a creation by external key",
        "ops/2/target: external_key basis on a creation",
      ]),
    );
    const explicit = patched(name, "ops/2/target", {
      ver: { op: 12, restore_count: 0, basis: "explicit" },
    });
    expect(issues(parse(explicit))).toContain("ops/2/target: ver on a creation by external key");
    const based = withBlock(S(name), "ops/2/baseline", { f1: 3, f3: 3 });
    expect(issues(parse(based))).toContain("ops/2/target: baseline without the external_key basis");
  });

  it("ver.op is the earliest position", () => {
    expect(issues(parse(ver({ op: 24, basis: "external_key" })))).toContain(
      "ops/0/target: ver.op not the earliest baseline",
    );
    expect(issues(parse(ver({ op: 11, basis: "external_key" })))).toContain(
      "ops/0/target: ver.op not the earliest baseline",
    );
  });

  it("every position is before this operation (25); no lower bound", () => {
    const at = (f4: number) => withBlock(S(name), "ops/0/baseline", { f3: 12, f4 });
    expect(issues(parse(at(25)))).toContain(
      "ops/0/baseline: baseline of f4 not before this operation",
    );
    expect(issues(parse(at(26)))).toContain(
      "ops/0/baseline: baseline of f4 not before this operation",
    );
    expect(parse(at(24))).toEqual({ ok: true, type: "write.head" });
    const early = withBlock(ver({ op: 1, basis: "external_key" }), "ops/0/baseline", {
      f3: 1,
      f4: 1,
    });
    expect(parse(early)).toEqual({ ok: true, type: "write.head" });
  });

  it("the fields with a position are exactly the fields set: not a no-op one, none missing", () => {
    const noop = withBlock(S(name), "ops/0/baseline", { f1: 12, f3: 12, f4: 24 });
    expect(issues(parse(noop))).toContain(
      "ops/0/baseline: baseline on f1, a field the op does not set",
    );
    const missing = withBlock(S(name), "ops/0/baseline", { f3: 12 });
    expect(issues(parse(missing))).toContain("ops/0/set/f4: a field set without its baseline");
  });

  it.each([
    [
      "intent insert, creating",
      "ops/2/target",
      { intent: "insert" },
      "intent of a write by external key",
    ],
    [
      "intent revoke, creating",
      "ops/2/target",
      { intent: "revoke" },
      "intent of a write by external key",
    ],
    [
      "intent revoke, hitting a row",
      "ops/0/target",
      { intent: "revoke" },
      "intent of a write by external key",
    ],
    [
      "an entity target",
      "ops/2/target",
      { row: undefined, entity: ENTITY },
      "by_external_key on an entity",
    ],
    ["key_from", "ops/2/target", { key_from: ROW }, "key_from on a write by external key"],
  ])("a write by external key: refuses %s", (_, path, patch, issue) => {
    expect(issues(parse(patched(name, path, patch)))).toContain(`${path}: ${issue}`);
  });

  it("a write by external key: no revert, creating or hitting a row; key_from stays on an update by row", () => {
    const revert = { undo_op: 20, include_later: false };
    expect(issues(parse(withBlock(S(name), "ops/0/revert", revert)))).toContain(
      "ops/0/target: revert on a write by external key",
    );
    expect(issues(parse(withBlock(S(name), "ops/2/revert", revert)))).toContain(
      "ops/2/target: revert on a write by external key",
    );
    const addKey = patched("write.head", "ops/0/target", { intent: "update", key_from: ROW_B });
    expect(parse(addKey)).toEqual({ ok: true, type: "write.head" });
  });

  it("several fields at fault: each named", () => {
    const b = withBlock(S(name), "ops/0/baseline", { f1: 3, f2: 3, f3: 3, f4: 3 });
    const ver3 = withBlock(b, "ops/0/target", {
      ...(S(name).blocks["ops/0/target"] as object),
      ver: { op: 3, restore_count: 0, basis: "external_key" },
    });
    expect(issues(parse(ver3))).toEqual(
      expect.arrayContaining([
        "ops/0/baseline: baseline on f1, a field the op does not set",
        "ops/0/baseline: baseline on f2, a field the op does not set",
      ]),
    );
  });

  it("a baseline with no target of its op", () => {
    const s = withBlock(S(name), "ops/1/baseline", { f3: 12 });
    expect(issues(parse(s))).toContain("ops/1/baseline: no ops target for it");
  });
});
