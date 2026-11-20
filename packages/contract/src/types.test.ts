// Type-level checks: JSON examples from the spec are assignable to the contract types. The checks
// happen at type-check time (`tsc -p tsconfig.tests.json`). Each example is the spec's own: at run
// time it is compared with the JSON block of 04-contract-types it was copied from, so a copy that
// drops or changes a field fails.

import { readFileSync } from "node:fs";
import { describe, expect, expectTypeOf, it } from "vitest";
import type {
  ConnectionsIssueResult,
  ERROR_CODES,
  ErrorCode,
  ErrorEnvelope,
  NOTICE_CODES,
  Notice,
  PendingDetailResult,
  QueryResult,
  ResolveResult,
  SqlParams,
  SqlResult,
  TimelineResult,
  WARNING_CODES,
  Warning,
} from "./index.ts";

// 04-contract-types §4.3, the first `query` example.
const queryEvent = {
  table: "ledger.expenses",
  slot: "ledger",
  sv: 1,
  total: 1,
  rows: [
    {
      table: "ledger.expenses",
      row: "r_01JC8Z…",
      ver: "v25.0",
      values: {
        date: "2026-11-10",
        category: "餐饮",
        amount: { value: "54", unit: "CNY" },
        note: null,
      },
      marks: { corrected: true },
    },
  ],
} satisfies QueryResult;

// 04-contract-types §4.3, the state table example with `valid_during`.
const queryState = {
  table: "ledger.budgets",
  slot: "ledger",
  sv: 2,
  total: 3,
  rows: [
    {
      table: "ledger.budgets",
      entity: "e_01JCB2…",
      entity_key: { category: "餐饮" },
      ver: "v55.0",
      values: { category: "餐饮", amount: { value: "5000", unit: "CNY" } },
      valid_from: "2026-10-01",
      valid_to: "2026-11-02",
      valid_to_inclusive: "2026-11-01",
    },
    {
      table: "ledger.budgets",
      entity: "e_01JCB2…",
      entity_key: { category: "餐饮" },
      ver: "v55.0",
      values: { category: "餐饮", amount: { value: "3000", unit: "CNY" } },
      valid_from: "2026-11-02",
      valid_to: "2026-11-10",
      valid_to_inclusive: "2026-11-09",
    },
    {
      table: "ledger.budgets",
      entity: "e_01JCB2…",
      entity_key: { category: "餐饮" },
      ver: "v55.0",
      values: { category: "餐饮", amount: { value: "4000", unit: "CNY" } },
      valid_from: "2026-11-10",
      valid_to: null,
    },
  ],
} satisfies QueryResult;

// 04-contract-types §4.4, the `sql` example: the call and its result.
const sqlCall = {
  sql: "SELECT category, sum(amount) AS total FROM expenses WHERE date >= $1 GROUP BY 1 ORDER BY 2 DESC",
  params: ["2026-11-01"],
} satisfies SqlParams;
const sqlResult = {
  sv: { ledger: 1 },
  columns: [
    { name: "category", type: "text" },
    { name: "total", type: "quantity", unit: "CNY" },
  ],
  rows: [
    ["餐饮", "54"],
    ["交通", "35"],
  ],
  total: 2,
  marks_summary: { disputed: 1, awaiting: 0, flagged: 0, premise_changed: 0, items: ["pi_7C2E…"] },
} satisfies SqlResult;

// 04-contract-types §4.5, the `timeline` example.
const timeline = {
  mode: "timeline",
  target: { table: "ledger.expenses", row: "r_01JC8Z…" },
  sv: 1,
  timezone: "Asia/Shanghai",
  ver: "v25.0",
  total: 2,
  entries: [
    {
      seq: 25,
      recorded_at: "2026-11-10T12:41:07+08:00",
      actor: { kind: "connection", id: "ci_01A…", name: "MacBook · Claude Code" },
      intent: "correct",
      fields: {
        amount: {
          result: "applied",
          before: { value: "45", unit: "CNY" },
          after: { value: "54", unit: "CNY" },
          sources: {
            value: [
              {
                id: "s_2",
                kind: "user_message",
                correction: true,
                level: "user_stated",
                literal: "hit",
              },
            ],
            operation: [],
          },
        },
      },
      affected: {
        derived: [
          {
            table: "ledger.monthly_total",
            key: { month: "2026-11-01" },
            field: "total",
            before: { value: "45", unit: "CNY" },
            after: { value: "54", unit: "CNY" },
          },
        ],
        reads: 0,
      },
    },
    {
      seq: 21,
      recorded_at: "2026-11-10T12:31:40+08:00",
      actor: { kind: "connection", id: "ci_01A…", name: "MacBook · Claude Code" },
      intent: "insert",
      fields: {
        date: {
          result: "applied",
          after: "2026-11-10",
          sources: { value: [{ id: "s_1", kind: "user_message", literal: "miss" }], operation: [] },
        },
        category: {
          result: "applied",
          after: "餐饮",
          sources: { value: [{ id: "s_1", kind: "user_message", literal: "miss" }], operation: [] },
        },
        amount: {
          result: "applied",
          after: { value: "45", unit: "CNY" },
          sources: {
            value: [{ id: "s_1", kind: "user_message", level: "user_stated", literal: "hit" }],
            operation: [],
          },
        },
      },
    },
  ],
} satisfies TimelineResult;

// 04-contract-types §4.8, the conflict item detail example.
const conflictDetail = {
  id: "pi_7C2E…",
  item_ver: "iv_4f81…",
  type: "conflict",
  status: "open",
  slot: "ledger",
  reason: "stale_write",
  opened_at: "2026-11-10T15:02:11+08:00",
  opened_by: { kind: "connection", id: "ci_01A…", name: "MacBook · Claude Code" },
  decisions: ["keep_effective", "take_candidate", "take_previous"],
  target: { table: "ledger.expenses", row: "r_01JD3K…", unit: ["amount"] },
  effective: {
    seq: 33,
    actor: { kind: "connection", id: "ci_01B…", name: "MacBook · Codex" },
    values: { amount: { value: "35", unit: "CNY" } },
    exists: true,
  },
  candidates: [
    {
      index: 0,
      seq: 37,
      actor: { kind: "connection", id: "ci_01A…", name: "MacBook · Claude Code" },
      intent: "correct",
      ver: "v29.0",
      values: { amount: { value: "32", unit: "CNY" } },
      cause: "stale_write",
      level: "user_stated",
      literal: "hit",
    },
  ],
  previous: { seq: 29, exists: true, values: { amount: { value: "30", unit: "CNY" } } },
  reverted_by_previous: [
    {
      seq: 33,
      actor: { kind: "connection", id: "ci_01B…", name: "MacBook · Codex" },
      fields: ["amount"],
    },
  ],
} satisfies PendingDetailResult;

// 04-contract-types §5.2, `take_candidate` triggering a write.
const resolveWithWrite = {
  id: "pi_7C2E…",
  type: "conflict",
  decision: "take_candidate",
  item_ver: "iv_9b02…",
  status: "resolved",
  write: {
    seq: 41,
    sv: 1,
    ops: [
      {
        target: { table: "ledger.expenses", row: "r_01JD3K…" },
        intent: "correct",
        ver: "v41.0",
        fields: {
          amount: {
            result: "applied",
            before: { value: "35", unit: "CNY" },
            after: { value: "32", unit: "CNY" },
          },
        },
      },
    ],
    derived: [
      {
        table: "ledger.monthly_total",
        key: { month: "2026-11-01" },
        field: "total",
        before: { value: "89", unit: "CNY" },
        after: { value: "86", unit: "CNY" },
      },
    ],
    derived_total: 1,
    pending: [],
    superseded: [],
    affected_reads: {
      count: 0,
      by_reason: {},
      covered_since: "2026-05-14T00:00:00+08:00",
      not_covered: ["derived_reads"],
    },
  },
} satisfies ResolveResult;

// 04-contract-types §8.1, the `connections.issue` example.
const issued = {
  id: "ci_01A…",
  name: "MacBook · Claude Code",
  scopes: ["saveslot.read", "saveslot.write"],
  via: "token",
  created_at: "2026-11-10T12:20:00+08:00",
  token: "slt_…",
} satisfies ConnectionsIssueResult;

// The spec has no JSON error example; this one is built from the §9 table (`unknown_field`:
// `name`, `nearest`) and the HTTP body of 05-surfaces §13.
const errorBody = {
  error: { code: "unknown_field", name: "price", nearest: ["amount"] },
} satisfies ErrorEnvelope;

const SPEC = readFileSync(
  new URL("../../../docs/zh-CN/spec/04-contract-types.md", import.meta.url),
  "utf8",
);

/** The one JSON block of 04-contract-types holding `text` (whitespace runs read as one space). */
function specExample(text: string): unknown {
  const blocks = [...SPEC.matchAll(/^```json\n([\s\S]*?)^```$/gm)].map((m) => m[1] as string);
  const hits = blocks.filter((b) => b.replace(/\s+/g, " ").includes(text));
  expect(hits, text).toHaveLength(1);
  return JSON.parse(hits[0] as string);
}

/** 04-contract-types §9 `ErrorCode` without the `@later` codes, written out apart from ERROR_CODES. */
type SpecErrorCode =
  | "invalid_argument"
  | "unknown_table"
  | "unknown_field"
  | "not_found"
  | "revoked"
  | "derived_readonly"
  | "validation_failed"
  | "read_first"
  | "schema_incompatible"
  | "too_large"
  | "sql_rejected"
  | "sql_timeout"
  | "draft_outdated"
  | "field_unmatched"
  | "confirmation_mismatch"
  | "item_closed"
  | "preview_outdated"
  | "unauthenticated"
  | "insufficient_scope"
  | "rate_limited"
  | "handle_expired"
  | "not_in_this_version"
  | "unavailable"
  | "internal"
  | "import_rejected";

describe("contract types", () => {
  it.each([
    ['"table": "ledger.expenses", "slot": "ledger", "sv": 1, "total": 1,', queryEvent],
    ['"table": "ledger.budgets", "slot": "ledger", "sv": 2, "total": 3,', queryState],
    ['"sql": "SELECT category, sum(amount) AS total FROM expenses', sqlCall],
    ['"sv": { "ledger": 1 }, "columns"', sqlResult],
    ['"mode": "timeline", "target"', timeline],
    ['"item_ver": "iv_4f81…", "type": "conflict", "status": "open"', conflictDetail],
    [
      '"decision": "take_candidate", "item_ver": "iv_9b02…", "status": "resolved"',
      resolveWithWrite,
    ],
    ['"token": "slt_…"', issued],
  ])("the example holding %s is the spec's, as written there", (text, example) => {
    expect(example).toEqual(specExample(text));
  });

  it("has an error body built from the §9 table", () => {
    expect(errorBody.error.code).toBe("unknown_field");
  });

  it("enum arrays list exactly their union's members", () => {
    expectTypeOf<ErrorCode>().toEqualTypeOf<SpecErrorCode>();
    expectTypeOf<(typeof ERROR_CODES)[number]>().toEqualTypeOf<SpecErrorCode>();
    expectTypeOf<(typeof WARNING_CODES)[number]>().toEqualTypeOf<Warning["code"]>();
    expectTypeOf<(typeof NOTICE_CODES)[number]>().toEqualTypeOf<Notice["code"]>();
  });

  it("rejects what the contract does not have", () => {
    // @ts-expect-error `@later` error codes are not in this version
    const later: ErrorCode = "lease_expired";
    // @ts-expect-error not an error code of the contract
    const unknown: ErrorCode = "not_a_code";
    expect([later, unknown]).toHaveLength(2);
  });
});
