import { describe, expect, it } from "vitest";
import { EVENT_TYPES } from "./enums.ts";
import { HEADER_RULES } from "./header.ts";
import { checkPathSyntax, matchPath, matchPathAll, VOCABULARY } from "./vocabulary.ts";

/** A concrete path for a pattern: placeholders replaced by sample IDs and indexes. */
function instantiate(pattern: string, sample = { table: "t1", field: "f2", n: "0" }): string {
  return pattern
    .replaceAll("<table>", sample.table)
    .replaceAll("<field>", sample.field)
    .replaceAll("<n>", sample.n);
}

describe("vocabulary table", () => {
  it("covers exactly the v1 event types", () => {
    expect(Object.keys(VOCABULARY).sort()).toEqual([...EVENT_TYPES].sort());
    expect(Object.keys(HEADER_RULES).sort()).toEqual([...EVENT_TYPES].sort());
  });

  it("has no duplicate pattern within a type", () => {
    for (const [type, entries] of Object.entries(VOCABULARY)) {
      const paths = entries.map((e) => e.path);
      expect(new Set(paths).size, type).toBe(paths.length);
    }
  });

  it("matches every instantiated pattern to exactly that entry", () => {
    for (const [type, entries] of Object.entries(VOCABULARY)) {
      for (const entry of entries) {
        for (const sample of [
          { table: "t1", field: "f2", n: "0" },
          { table: "t12", field: "f30", n: "907" },
        ]) {
          const path = instantiate(entry.path, sample);
          expect(matchPathAll(type, path), `${type} ${path}`).toEqual([entry]);
        }
      }
    }
  });
});

/**
 * Every concrete path that appears in docs/zh-CN/spec/09-event-format.md (examples, tables and
 * prose), with the event type it belongs to and its block kind as the spec states it.
 */
const SPEC_PATHS: ReadonlyArray<readonly [string, string, "meta" | "data"]> = [
  // §5.1
  ["write.head", "ctx", "meta"],
  ["write.head", "task", "data"],
  ["write.head", "request_key", "data"],
  ["write.head", "idempotency", "data"],
  ["item.resolved", "ctx", "meta"],
  ["deletion.confirmed", "ctx", "meta"],
  ["deletion.cancelled", "ctx", "meta"],
  ["schema.draft_submitted", "ctx", "meta"],
  ["principal.registered", "ctx", "meta"],
  ["principal.renamed", "ctx", "meta"],
  ["principal.revoked", "ctx", "meta"],
  ["slot.removed", "ctx", "meta"],
  ["item.resolved", "task", "data"],
  ["item.resolved", "request_key", "data"],
  ["item.resolved", "idempotency", "data"],
  ["deletion.confirmed", "task", "data"],
  ["deletion.confirmed", "request_key", "data"],
  ["deletion.confirmed", "idempotency", "data"],
  ["deletion.cancelled", "task", "data"],
  ["deletion.cancelled", "request_key", "data"],
  ["deletion.cancelled", "idempotency", "data"],
  ["schema.draft_submitted", "task", "data"],
  ["schema.draft_submitted", "request_key", "data"],
  ["schema.draft_submitted", "idempotency", "data"],
  // §5.2
  ["tenant.genesis", "tenant", "meta"],
  ["tenant.genesis", "user", "meta"],
  ["tenant.genesis", "system", "meta"],
  ["tenant.imported", "tenant", "meta"],
  ["tenant.imported", "user", "meta"],
  ["tenant.imported", "export", "meta"],
  // §5.3
  ["principal.registered", "principal", "meta"],
  ["principal.registered", "name", "data"],
  ["principal.renamed", "principal", "meta"],
  ["principal.renamed", "name", "data"],
  ["principal.revoked", "principal", "meta"],
  // §5.4
  ["slot.policy_set", "policy", "meta"],
  ["slot.removed", "target", "meta"],
  ["slot.removed", "name", "data"],
  // §5.5
  ["schema.draft_submitted", "target", "meta"],
  ["schema.draft_submitted", "draft", "data"],
  ["schema.compiled", "target", "meta"],
  ["schema.compiled", "compiled", "data"],
  ["schema.compiled", "changes", "meta"],
  ["schema.confirmed", "target", "meta"],
  ["schema.rejected", "target", "meta"],
  ["schema.superseded", "target", "meta"],
  ["schema.migration_started", "target", "meta"],
  ["schema.switched", "target", "meta"],
  ["schema.switched", "tables/t1", "data"],
  ["schema.switched", "backfill_rows/t1/f5/0", "meta"],
  ["schema.switched", "backfill/t3/f2/0", "data"],
  ["schema.migration_failed", "target", "meta"],
  // §5.6
  ["source.recorded", "target", "meta"],
  ["source.recorded", "text", "data"],
  ["source.recorded", "file", "data"],
  ["source.recorded", "request", "data"],
  ["source.recorded", "stated_at", "data"],
  // §5.7 write.head
  ["write.head", "request", "meta"],
  ["write.head", "ops/0/target", "meta"],
  ["write.head", "ops/0/set/f3", "data"],
  ["write.head", "ops/0/noop", "meta"],
  ["write.head", "ops/0/explicit", "meta"],
  ["write.head", "ops/0/valid", "data"],
  ["write.head", "ops/0/revert", "meta"],
  ["write.head", "ops/0/acknowledge", "meta"],
  ["write.head", "ops/0/named_fields", "meta"],
  ["write.head", "ops/0/refs", "data"],
  ["write.head", "ops/0/baseline", "meta"],
  ["write.head", "ops/0/premises/0", "meta"],
  ["write.head", "ops/1/premise_valid/0", "data"],
  ["write.head", "ops/0/premise_covers", "meta"],
  ["write.head", "ops/0/premises_cleared", "meta"],
  // §5.7 write.base
  ["write.base", "target", "meta"],
  ["write.base", "fields/f3/0", "data"],
  ["write.base", "sources/f3/0", "data"],
  ["write.base", "literal/f3/0", "data"],
  ["write.base", "span/f2/0", "data"],
  ["write.base", "fields/f2/1", "data"],
  ["write.base", "sources/f2/1", "data"],
  ["write.base", "span/f2/1", "data"],
  ["write.base", "fields/f4/0", "data"],
  ["write.base", "existence/0", "meta"],
  ["write.base", "existence/1", "meta"],
  ["write.base", "span/existence/0", "data"],
  ["write.base", "span/existence/1", "data"],
  ["write.base", "valid_sources", "meta"],
  ["write.base", "op_sources", "meta"],
  ["write.base", "duplicate", "data"],
  ["write.base", "ack/0", "data"],
  ["write.base", "revert", "meta"],
  ["write.base", "take", "meta"],
  // §5.7 write.derived
  ["write.derived", "target", "meta"],
  ["write.derived", "key", "data"],
  ["write.derived", "checksum", "data"],
  // §5.8
  ["item.created", "target", "meta"],
  ["item.created", "scope_valid", "data"],
  ["item.created", "current/0", "data"],
  ["item.created", "candidates/0", "data"],
  ["item.created", "proposed/0", "data"],
  ["item.created", "previous/0", "data"],
  ["item.created", "impact/0", "data"],
  ["item.created", "matched/0", "data"],
  ["item.merged", "target", "meta"],
  ["item.merged", "candidates/1", "data"],
  ["item.merged", "scope_valid", "data"],
  ["item.merged", "current/0", "data"],
  ["item.merged", "previous/0", "data"],
  ["item.merged", "impact/0", "data"],
  ["item.refreshed", "target", "meta"],
  ["item.refreshed", "current/0", "data"],
  ["item.refreshed", "previous/0", "data"],
  ["item.refreshed", "impact/0", "data"],
  ["item.refreshed", "proposed/0", "data"],
  ["item.refreshed", "scope_valid", "data"],
  ["item.refreshed", "candidates/0", "data"],
  ["item.refreshed", "matched/0", "data"],
  ["item.superseded", "target", "meta"],
  ["item.resolved", "target", "meta"],
  ["item.resolved", "op_sources", "meta"],
  ["item.resolved", "confirmation", "data"],
  // §5.9
  ["deletion.confirmed", "target", "meta"],
  ["deletion.confirmed", "positions", "meta"],
  ["deletion.confirmed", "summary", "data"],
  ["deletion.confirmed", "results/0/target", "meta"],
  ["deletion.confirmed", "results/0/fields/f3/0", "data"],
  ["deletion.confirmed", "results/0/existence", "data"],
  ["deletion.confirmed", "restated/0", "data"],
  ["deletion.confirmed", "recreated/0", "meta"],
  ["deletion.confirmed", "superseded_items", "meta"],
  ["deletion.cancelled", "target", "meta"],
  ["deletion.cancelled", "results/0/target", "meta"],
  ["deletion.cancelled", "results/2/fields/f2/1", "data"],
  ["deletion.cancelled", "results/0/existence", "data"],
  ["deletion.cancelled", "restated/0", "data"],
  ["deletion.cancelled", "recreated/0", "meta"],
  ["deletion.cancelled", "restored_items", "meta"],
  ["deletion.cancelled", "kept_superseded/0", "meta"],
  ["deletion.cancelled", "kept_effective/0", "meta"],
  ["deletion.executed", "target", "meta"],
  ["deletion.executed", "positions", "meta"],
  // §5.10
  ["premise.changed", "targets/0", "meta"],
];

describe("matchPath on the spec's paths", () => {
  it.each(SPEC_PATHS)("%s %s is one %s block", (type, path, kind) => {
    const all = matchPathAll(type, path);
    expect(all).toHaveLength(1);
    expect(all[0]?.kind).toBe(kind);
    expect(matchPath(type, path)).toBe(all[0]);
  });

  it("lists every vocabulary entry at least once (the list above is complete)", () => {
    for (const [type, entries] of Object.entries(VOCABULARY)) {
      for (const entry of entries) {
        const covered = SPEC_PATHS.some(([t, p]) => t === type && matchPath(t, p) === entry);
        expect(covered, `${type} ${entry.path}`).toBe(true);
      }
    }
  });
});

describe("matchPath rejects", () => {
  it.each([
    ["write.base", "fields/f3/00", "index with a leading zero"],
    ["write.base", "fields/f3/01", "index with a leading zero"],
    ["write.base", "fields/f03/0", "field ID with a leading zero"],
    ["write.base", "fields/f0/0", "field ID 0"],
    ["write.base", "fields/f3/-1", "negative index"],
    ["write.base", "fields/f3/1.0", "non-integer index"],
    ["write.base", "fields/f3/9007199254740992", "index above 2^53 - 1"],
    ["write.base", "fields/f3", "too few segments"],
    ["write.base", "fields/f3/0/0", "too many segments"],
    ["write.base", "fields/t3/0", "table ID where a field ID belongs"],
    ["write.base", "fields/0/0", "index where a field ID belongs"],
    ["write.base", "fields/note/0", "word where a field ID belongs"],
    ["write.base", "span/f3/existence", "word where an index belongs"],
    ["write.base", "feilds/f3/0", "unknown fixed word"],
    ["write.base", "Fields/f3/0", "uppercase word"],
    ["write.base", "fields/f３/0", "non-ASCII"],
    ["write.base", "fields/金额/0", "non-ASCII"],
    ["write.base", "/target", "empty segment"],
    ["write.base", "target/", "empty segment"],
    ["write.base", "", "empty path"],
    ["write.base", "ops/0/target", "path of another event type"],
    ["write.head", "fields/f3/0", "path of another event type"],
    ["schema.switched", "tables/f1", "field ID where a table ID belongs"],
    ["schema.switched", "backfill/f1/t3/0", "swapped ID kinds"],
    ["tenant.restored", "target", "a type without blocks"],
    ["principal.registered", "task", "§5.3: no task on principal events in v1"],
    ["slot.policy_set", "ctx", "slot.policy_set as a head event is reserved"],
    ["write.unknown", "target", "unknown event type"],
  ])("%s %s (%s)", (type, path) => {
    expect(matchPath(type, path)).toBeUndefined();
    expect(matchPathAll(type, path)).toEqual([]);
  });
});

describe("checkPathSyntax", () => {
  it("classifies segments", () => {
    const result = checkPathSyntax("results/12/fields/f3/0");
    expect(result).toEqual({
      ok: true,
      segments: [
        { kind: "word", text: "results" },
        { kind: "index", text: "12", value: 12 },
        { kind: "word", text: "fields" },
        { kind: "field", text: "f3" },
        { kind: "index", text: "0", value: 0 },
      ],
    });
    expect(checkPathSyntax("tables/t7")).toMatchObject({
      ok: true,
      segments: [{ kind: "word" }, { kind: "table", text: "t7" }],
    });
  });

  it.each([
    "",
    "a//b",
    "a/",
    "00",
    "fields/f3/007",
    "f01",
    "t0",
    "x1",
    "r_01JC8Z",
    "s_1",
    "a-b",
    "a b",
    "ａ",
    "é",
    "😀",
    "A",
  ])("rejects %j", (path) => {
    expect(checkPathSyntax(path).ok).toBe(false);
  });
});
