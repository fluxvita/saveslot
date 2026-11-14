// Schema documents for the compiler's tests: a document that creates a slot covering every base
// field type and every time type, mirroring apply's hand-written version 1 (../apply/slot.fixture.ts)
// without its aliases. Fictional names.

import { parseEvent } from "@fluxvita/saveslot-contract-core";
import { compileNewSlot } from "./compile.ts";
import type { CompileNewSlotInput, CompileResult } from "./model.ts";

export const SLOT_ID = `sl_${"4".repeat(16)}` as const;

// biome-ignore lint/suspicious/noExplicitAny: test documents are edited freely, as JSON
export type Doc = any;

export function ledger(): Doc {
  return {
    slot: "ledger",
    base_version: null,
    timezone: "Asia/Shanghai",
    tables: [
      {
        name: "expenses",
        kind: "base",
        description: "one row per expense",
        time: { type: "event", field: "date" },
        fields: [
          { name: "date", type: "date", required: true, description: "the day" },
          { name: "category", type: "enum", description: "kind", values: ["food", "rent"] },
          {
            name: "amount",
            type: "quantity",
            required: true,
            description: "how much",
            min: 0,
            unit: "CNY",
          },
          { name: "note", type: "text", description: "free text" },
          { name: "pieces", type: "integer", description: "how many" },
          {
            name: "rate",
            type: "decimal",
            description: "a rate",
            scale: 4,
            rounding: "half_even",
          },
          { name: "paid", type: "boolean", description: "settled" },
          { name: "at", type: "zoned_datetime", description: "when" },
          {
            name: "account",
            type: "ref",
            description: "paid from",
            ref: { table: "accounts", target: "entity" },
          },
        ],
        together: [["category", "amount"]],
        duplicate_keys: [["date", "category", "amount"]],
      },
      {
        name: "accounts",
        kind: "base",
        description: "an account over time",
        time: { type: "state", granularity: "date" },
        fields: [
          { name: "name", type: "text", required: true, description: "its name" },
          { name: "limit", type: "integer", description: "its limit" },
        ],
        entity_key: ["name"],
      },
      {
        name: "rooms",
        kind: "base",
        description: "occupancy by the instant",
        time: { type: "state", granularity: "instant" },
        fields: [{ name: "guest", type: "text", description: "who" }],
      },
      {
        name: "settings",
        kind: "base",
        description: "timeless",
        time: { type: "none" },
        fields: [{ name: "key", type: "text", required: true, description: "a key" }],
      },
    ],
  };
}

/** A copy of `ledger()` changed by `f`. */
export function edit(f: (d: Doc) => void, base: Doc = ledger()): Doc {
  const d = structuredClone(base);
  f(d);
  return d;
}

export function compile(
  document: unknown,
  o: Partial<Omit<CompileNewSlotInput, "document">> = {},
): CompileResult {
  return compileNewSlot({
    document,
    slotId: SLOT_ID,
    nextTableNumber: 1,
    existingSlotNames: [],
    ...o,
  });
}

/**
 * The result put into a `schema.compiled` event and parsed strictly: the issues, empty when the
 * event is valid. Fails the shape checks of contract-core, not only the compiler's.
 */
export function eventIssues(r: CompileResult): readonly string[] {
  if (!r.ok) return [`not compiled: ${JSON.stringify(r.error)}`];
  const header = {
    type: "schema.compiled",
    v: 1,
    seq: 3,
    op: 2,
    at: "2026-11-10T03:00:00.000Z",
    prev_hash: "a".repeat(64),
    actor: `u_${"1".repeat(26)}`,
    slot: SLOT_ID,
  };
  const blocks = {
    target: {
      draft_id: `d_${"1".repeat(16)}`,
      target_version: r.targetVersion,
      outcome: r.outcome,
    },
    compiled: r.compiled,
    changes: r.changes,
  };
  const p = parseEvent(header, blocks);
  if (p.ok) return [];
  return p.kind === "invalid" ? p.issues : p.shapes.map((s) => `unsupported ${s}`);
}

/** The error of a result that should not compile. */
export function errorOf(r: CompileResult) {
  if (r.ok) throw new Error("compiled");
  return r.error;
}

/** `path code` of each detail of a `validation_failed`. */
export function details(r: CompileResult): string[] {
  const e = errorOf(r);
  if (e.code !== "validation_failed")
    throw new Error(`not validation_failed: ${JSON.stringify(e)}`);
  return e.details.map((d) => `${d.path} ${d.code}`);
}
