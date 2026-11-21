// Deletion events decoded into records (09 §5.9) for the deletion replay: each event, hand
// written as the spec gives it, passes the strict parse of its type and decodes into the record
// below. No judgement reads these records yet; `decodeRecords` still refuses a log with them.

import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import {
  decodeDeletionRecords,
  decodeRecords,
  type RowContext,
  type StoredEvent,
} from "./record.ts";

/** A JSON value as `parseEvent` takes it. */
type Json = unknown;

const USER = `u_${"1".repeat(26)}`;
const SLOT = `sl_${"2".repeat(16)}`;
const HASH = "a".repeat(64);
const ITEM = `pi_${"3".repeat(16)}`;
const ITEM2 = `pi_${"4".repeat(16)}`;
const ROW = `r_${"5".repeat(26)}`;
const ENTITY = `e_${"6".repeat(26)}`;
const CTX = {
  now: "2026-11-10T05:02:11.000Z",
  today: "2026-11-10",
  ruleset_version: 1,
  policy_version: 1,
};

const STATE: RowContext = {
  shape: { kind: "state" },
  granularity: "date",
} as unknown as RowContext;
const EVENT: RowContext = {
  shape: { kind: "event" },
  granularity: "instant",
} as unknown as RowContext;

/** A head event as stored: its header and blocks; the strict parse is checked on both. */
function head(
  seq: number,
  type: string,
  blocks: Record<string, Json>,
  system?: string,
): StoredEvent & { full: Record<string, Json> } {
  const full: Record<string, Json> = {
    v: 1,
    seq,
    at: "2026-11-10T05:02:11.000Z",
    prev_hash: HASH,
    actor: system === undefined ? USER : "system",
    slot: SLOT,
    type,
    ...(system !== undefined ? { trigger: system } : {}),
  };
  return { header: { type, seq }, blocks, full };
}

/** The strict parse of the event's type passes. */
const parses = (e: { full: Record<string, Json>; blocks: Readonly<Record<string, Json>> }) =>
  expect(parseEvent(e.full, e.blocks as Record<string, Json>)).toEqual({
    ok: true,
    type: e.full["type"],
  });

describe("deletion events decoded into records (09 §5.9)", () => {
  const confirmed = head(42, "deletion.confirmed", {
    ctx: CTX,
    target: {
      deletion: ITEM,
      kind: "privacy",
      due_at: "2026-11-11T05:02:11.000Z",
      sources: [26],
      origin: "request",
    },
    positions: [
      { seq: 26, path: "text" },
      { seq: 27, path: "fields/f3/0" },
      { seq: 42, path: "summary" },
    ],
    summary: { hash: HASH },
    "results/0/target": { table: "t1", entity: ENTITY, outcome: "resegmented" },
    "results/0/fields/f2/0": {
      valid: { from: "2026-11-20" },
      value: { value: "5000", unit: "CNY" },
      sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
      deps: [
        { event: 12, field: "f2", k: 0 },
        { event: 32, field: "f2", k: 0 },
      ],
    },
    "results/0/fields/f2/1": {
      valid: { from: "2026-11-01", to: "2026-11-20" },
      value: null,
      sources: [],
      deps: [{ event: 30, existence: 0 }],
    },
    "results/0/existence": {
      gaps: [{ from: "2026-11-01", to: "2026-11-20" }],
      deps: [{ event: 30, existence: 0 }],
    },
    "restated/0": {
      event: 18,
      field: "f2",
      k: 0,
      status: "applied",
      valid: { from: "2026-11-02" },
      deps: [{ event: 12, field: "f2", k: 0 }],
    },
    "restated/1": { event: 19, field: "f2", k: 1, status: "dropped" },
    "restated/2": {
      event: 33,
      field: "f2",
      k: 0,
      status: "applied",
      valid: { from: "2026-11-01" },
      deps: [{ event: 12, field: "f2", k: 0 }],
      value: { value: "4000", unit: "CNY" },
      sources: [{ kind: "value", carried: { event: 12, field: "f2", k: 0 } }],
    },
    "restated/3": {
      event: 30,
      existence: 0,
      status: "candidate",
      seen_valid: { from: "2026-11-01", to: "2026-11-20" },
      deps: [],
    },
    "restated/4": {
      event: 36,
      field: "f2",
      k: 0,
      status: "applied",
      valid: { from: "2026-11-25" },
      deps: [],
      value: "9",
      sources: [{ kind: "schema_const", sv: 2, field: "f2" }],
    },
    "recreated/0": { event: 18, created: true },
    superseded_items: [ITEM2],
  });

  it("deletion.confirmed: target, positions, results, restatements, recreated, superseded", () => {
    parses(confirmed);
    expect(decodeDeletionRecords(STATE, [confirmed])).toEqual([
      {
        kind: "deletion",
        event: 42,
        op: 42,
        id: ITEM,
        sources: [26],
        dueAt: "2026-11-11T05:02:11.000Z",
        origin: "request",
        positions: [
          { seq: 26, path: "text" },
          { seq: 27, path: "fields/f3/0" },
          { seq: 42, path: "summary" },
        ],
        results: [
          {
            table: "t1",
            id: ENTITY,
            outcome: "resegmented",
            stretches: [
              {
                field: "f2",
                j: 0,
                value: { value: "5000", unit: "CNY" },
                carried: [{ event: 12, target: "f2", k: 0 }],
                valid: [{ from: "2026-11-20", to: null }],
                deps: [
                  { event: 12, target: "f2", k: 0 },
                  { event: 32, target: "f2", k: 0 },
                ],
              },
              {
                field: "f2",
                j: 1,
                value: null,
                carried: [],
                valid: [{ from: "2026-11-01", to: "2026-11-20" }],
                deps: [{ event: 30, target: "existence", k: 0 }],
              },
            ],
            gaps: {
              gaps: [{ from: "2026-11-01", to: "2026-11-20" }],
              deps: [{ event: 30, target: "existence", k: 0 }],
            },
          },
        ],
        restated: [
          {
            item: { event: 18, target: "f2", k: 0 },
            status: "applied",
            valid: [{ from: "2026-11-02", to: null }],
            deps: [{ event: 12, target: "f2", k: 0 }],
          },
          { item: { event: 19, target: "f2", k: 1 }, status: "dropped", deps: [] },
          {
            item: { event: 33, target: "f2", k: 0 },
            status: "applied",
            valid: [{ from: "2026-11-01", to: null }],
            deps: [{ event: 12, target: "f2", k: 0 }],
            content: { kind: "value", value: { value: "4000", unit: "CNY" } },
            carried: [{ event: 12, target: "f2", k: 0 }],
          },
          {
            item: { event: 30, target: "existence", k: 0 },
            status: "candidate",
            valid: [{ from: "2026-11-01", to: "2026-11-20" }],
            deps: [],
          },
          // A value restated onto a schema constant: its source kept, not dropped.
          {
            item: { event: 36, target: "f2", k: 0 },
            status: "applied",
            valid: [{ from: "2026-11-25", to: null }],
            deps: [],
            content: { kind: "value", value: "9" },
            schemaConst: { sv: 2, field: "f2" },
          },
        ],
        recreated: [{ event: 18, created: true }],
        superseded: [ITEM2],
      },
    ]);
  });

  it("deletion.cancelled: restored items, kept superseded, kept in effect by (event, target)", () => {
    const cancelled = head(50, "deletion.cancelled", {
      ctx: CTX,
      target: { deletion: ITEM, origin: "request" },
      "results/0/target": { table: "t1", row: ROW, outcome: "sources_changed" },
      "results/0/fields/f2/0": {
        value: "7",
        sources: [{ kind: "value", carried: { event: 21, field: "f2", k: 0 } }],
      },
      "restated/0": { event: 21, field: "f2", k: 0, status: "candidate" },
      restored_items: [ITEM2],
      "kept_superseded/0": { item: ITEM2, by_event: 47 },
      "kept_effective/0": {
        event: 31,
        items: [{ field: "f2", k: 0 }, { field: "f2", k: 1 }, { existence: 0 }],
        by_event: 45,
      },
    });
    parses(cancelled);
    expect(decodeDeletionRecords(EVENT, [cancelled])).toEqual([
      {
        kind: "cancellation",
        event: 50,
        op: 50,
        id: ITEM,
        origin: "request",
        results: [
          {
            table: "t1",
            id: ROW,
            outcome: "sources_changed",
            stretches: [
              {
                field: "f2",
                j: 0,
                value: "7",
                carried: [{ event: 21, target: "f2", k: 0 }],
                deps: [],
              },
            ],
          },
        ],
        restated: [{ item: { event: 21, target: "f2", k: 0 }, status: "candidate", deps: [] }],
        recreated: [],
        restoredItems: [ITEM2],
        keptSuperseded: [{ item: ITEM2, byEvent: 47 }],
        keptEffective: [{ event: 31, targets: ["existence", "f2"], byEvent: 45 }],
      },
    ]);
  });

  it("deletion.executed: the tombstone's positions", () => {
    const executed = head(
      60,
      "deletion.executed",
      {
        target: { deletion: ITEM, reason: "expiry" },
        positions: [{ seq: 27, path: "fields/f3/0" }],
      },
      "deletion_expiry",
    );
    parses(executed);
    expect(decodeDeletionRecords(STATE, [executed])).toEqual([
      {
        kind: "execution",
        event: 60,
        op: 60,
        id: ITEM,
        reason: "expiry",
        positions: [{ seq: 27, path: "fields/f3/0" }],
      },
    ]);
  });

  it("in log order; a log with deletion events is still refused by decodeRecords", () => {
    const executed = head(
      60,
      "deletion.executed",
      { target: { deletion: ITEM, reason: "expiry" }, positions: [] },
      "deletion_expiry",
    );
    expect(decodeDeletionRecords(STATE, [executed, confirmed]).map((r) => r.event)).toEqual([
      42, 60,
    ]);
    expect(() => decodeRecords(STATE, [confirmed])).toThrow(/does not handle deletion.confirmed/);
  });

  it("item.refreshed re-giving candidates: each replaces the one at its index", () => {
    // A member of the deletion's operation (09 §5.8): the deletion removed one of the item's
    // candidates (`entries_deleted`) and re-gives another whose block it cleared.
    const refreshed: StoredEvent & { full: Record<string, Json> } = {
      header: { type: "item.refreshed", seq: 43, op: 42 },
      blocks: {
        target: { item: ITEM2, cause: "entries_deleted", dropped_candidates: [0] },
        "candidates/1": {
          event: 31,
          items: [
            { field: "f2", k: 0 },
            { field: "f2", k: 2 },
          ],
          deps: [],
        },
      },
      full: {
        v: 1,
        seq: 43,
        op: 42,
        at: "2026-11-10T05:02:11.000Z",
        prev_hash: HASH,
        actor: USER,
        slot: SLOT,
        type: "item.refreshed",
      },
    };
    expect(decodeDeletionRecords(STATE, [refreshed])).toEqual([
      {
        kind: "refresh",
        event: 43,
        op: 42,
        item: ITEM2,
        cause: "entries_deleted",
        dropped: [0],
        restored: [],
        candidates: [
          {
            k: 1,
            event: 31,
            items: [
              { target: "f2", k: 0 },
              { target: "f2", k: 2 },
            ],
          },
        ],
      },
    ]);
  });

  it("a block outside 09 §5.9 is refused, not passed over", () => {
    const putBack = head(50, "deletion.cancelled", {
      ctx: CTX,
      target: { deletion: ITEM, origin: "request" },
      "put_back/0": { event: 21, field: "f2", k: 0 },
    });
    expect(() => decodeDeletionRecords(STATE, [putBack])).toThrow(/not decoded: put_back\/0/);
  });
});
