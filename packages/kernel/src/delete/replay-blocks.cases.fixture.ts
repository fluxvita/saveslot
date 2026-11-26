// Counterexamples of the block model property (replay-blocks.prop.test.ts): rows with several
// deletions confirmed and cancelled in turn whose replay from an empty store brought back an item
// the live state had dropped, before rule 2 restated a dropped block a deletion's own list clears.

import type { Op } from "@fluxvita/saveslot-reference";
import type { Decision } from "../judge/scenarios.fixture.ts";

export interface BlockCase {
  readonly name: string;
  readonly tables: readonly ("state" | "event")[];
  readonly ops: readonly Op[];
  readonly decisions: readonly Decision[];
  /** The sources each deletion `D<i>` deletes. */
  readonly dels: readonly (readonly string[])[];
  /** In turn: confirm `D<c>`, or cancel `D<x>` (skipped when not pending). */
  readonly script: readonly ({ readonly c: number } | { readonly x: number })[];
}

export const BLOCK_CASES: readonly BlockCase[] = [
  {
    name: "an awaiting item (state table)",
    tables: ["state"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-07" },
        },
        validSources: ["S20"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-11-05" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "open" } },
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
    ] as unknown as Op[],
    decisions: [
      { after: 1081178015, pick: 862730085, kind: "revoke", flag: 0, focus: true },
      { after: 1294759463, pick: 474576510, kind: "undo", flag: 0, focus: false },
    ] as unknown as Decision[],
    dels: [["S30"], [], ["S20"], ["S10"]],
    script: [{ x: 2 }, { c: 2 }, { x: 1 }, { c: 3 }, { x: 0 }, { x: 0 }],
  },
  {
    name: "a found case (state table)",
    tables: ["state"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        valid: { from: { mode: "given", value: "2026-11-09" }, to: { mode: "open" } },
        fields: { f2: { value: "7", sources: ["S12"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 20,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 40,
        event: 41,
        seen: 30,
        valid: { from: { mode: "given", value: "2026-11-11" }, to: { mode: "open" } },
        validSources: ["S30"],
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        valid: { from: { mode: "given", value: "2026-11-03" }, to: { mode: "next_change" } },
        fields: { f2: { value: "5", sources: ["S40"] }, f3: { value: "b", sources: ["S40"] } },
      },
      {
        kind: "undo",
        op: 60,
        event: 61,
        target: 20,
        includeLater: false,
        seen: 50,
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        valid: { from: { mode: "given", value: "2026-11-07" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 80,
        event: 81,
        valid: { from: { mode: "given", value: "2026-11-09" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
    ] as unknown as Op[],
    decisions: [
      { after: 317395191, pick: 643417157, kind: "keep", flag: 7, focus: false },
      { after: 1891073714, pick: 472924968, kind: "confirm", flag: 1, focus: false },
      { after: 1880932743, pick: 25665683, kind: "keep", flag: 0, focus: true },
      { after: 2039607122, pick: 47838808, kind: "undo", flag: 2, focus: true },
    ] as unknown as Decision[],
    dels: [["S30"], ["S12"], ["S10"], []],
    script: [{ c: 2 }, { x: 0 }, { c: 1 }, { c: 0 }, { c: 2 }, { x: 3 }],
  },
  {
    name: "a take_previous write-back with no value (event table)",
    tables: ["event"],
    ops: [
      {
        kind: "write",
        op: 20,
        event: 21,
        fields: { f2: { value: "1", sources: ["S2"], explicit: false } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 0,
        fields: { f2: { value: "9", sources: ["S1", "S6"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        fields: { f2: { value: "1", sources: ["S5"], explicit: true } },
        acknowledge: ["overwrite"],
      },
      { kind: "undo", op: 70, event: 71, target: 60, includeLater: true },
    ] as unknown as Op[],
    decisions: [
      { after: 434452625, pick: 1821381607, kind: "previous", flag: 5, focus: false },
      { after: 342516441, pick: 425323074, kind: "keep", flag: 7, focus: false },
      { after: 1017069728, pick: 204341478, kind: "take", flag: 4, focus: false },
      { after: 1993688426, pick: 133702558, kind: "take", flag: 5, focus: false },
      { after: 463624382, pick: 361057083, kind: "confirm", flag: 3, focus: false },
    ] as unknown as Decision[],
    dels: [["S1"], ["S6"], ["S5"], []],
    script: [{ c: 0 }, { c: 1 }, { x: 2 }],
  },
  {
    name: "a carried undo write-back (event table)",
    tables: ["event"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "1", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        fields: { f2: { value: "2", sources: ["S20"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        fields: { f2: { value: "3", sources: ["S30"] } },
        acknowledge: ["overwrite"],
      },
      { kind: "undo", op: 40, event: 41, target: 20, includeLater: true },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 10,
        fields: { f2: { value: "9", sources: ["S3"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        fields: { f2: { value: "3", sources: ["S1"], explicit: true } },
        acknowledge: ["overwrite"],
      },
    ] as unknown as Op[],
    decisions: [
      { after: 1588320584, pick: 814294892, kind: "take", flag: 1, focus: false },
      { after: 1745999863, pick: 1170785072, kind: "undo", flag: 0, focus: false },
      { after: 1024906406, pick: 837944112, kind: "revoke", flag: 1, focus: true },
      { after: 1928063619, pick: 1849102269, kind: "confirm", flag: 4, focus: true },
    ] as unknown as Decision[],
    dels: [["S20"], ["S3"], ["S30"], ["S10"]],
    script: [{ x: 0 }, { c: 0 }, { c: 1 }, { c: 2 }],
  },
  {
    name: "min0: a revoke, a candidate, a stale write (state table)",
    tables: ["state"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-10-01" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-01" },
          to: { mode: "given", value: "2026-11-07" },
        },
        validSources: ["S20"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "2", sources: ["S30"] }, f3: { value: "b", sources: ["S30"] } },
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 30,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "2", sources: ["S1"], explicit: false } },
      },
    ] as unknown as Op[],
    decisions: [] as unknown as Decision[],
    dels: [["S20"], ["S10"]],
    script: [{ c: 0 }, { c: 1 }],
  },
  {
    name: "an awaiting write dropped, its block a restatement as dropped (state table)",
    tables: ["state"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        valid: { from: { mode: "given", value: "2026-11-05" }, to: { mode: "open" } },
        fields: { f2: { value: "1", sources: ["S10"] }, f3: { value: "a", sources: ["S10"] } },
        acknowledge: ["overwrite"],
      },
      {
        kind: "revoke",
        op: 20,
        event: 21,
        seen: 10,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-09" },
        },
        validSources: ["S20"],
      },
      {
        kind: "write",
        op: 30,
        event: 31,
        valid: {
          from: { mode: "given", value: "2026-11-05" },
          to: { mode: "given", value: "2026-11-11" },
        },
        fields: { f2: { value: "2", sources: ["S30"] } },
      },
      {
        kind: "resolve",
        op: 40,
        event: 41,
        decision: "take_candidate",
        candidates: [31],
        take: 31,
        unit: "existence",
      },
      {
        kind: "write",
        op: 50,
        event: 51,
        seen: 40,
        valid: {
          from: { mode: "given", value: "2026-11-03" },
          to: { mode: "given", value: "2026-11-05" },
        },
        fields: { f2: { value: "1", sources: ["S2", "S4"], explicit: false } },
      },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        valid: {
          from: { mode: "given", value: "2026-11-05" },
          to: { mode: "given", value: "2026-11-11" },
        },
        fields: { f2: { value: "2", sources: ["S6"], explicit: false } },
        acknowledge: ["overwrite"],
      },
    ] as unknown as Op[],
    decisions: [
      { after: 348493349, pick: 202108313, kind: "revoke", flag: 7, focus: true },
    ] as unknown as Decision[],
    dels: [["S20"], [], ["S10"]],
    script: [{ c: 1 }, { c: 0 }, { c: 3 }, { c: 2 }, { c: 0 }],
  },
  {
    name: "dropped blocks marked as restatements (state and event tables)",
    tables: ["state", "event"],
    ops: [
      {
        kind: "write",
        op: 10,
        event: 11,
        seen: 0,
        fields: { f2: { value: "3", sources: ["S1"] } },
      },
      {
        kind: "write",
        op: 20,
        event: 21,
        fields: { f2: { value: "9", sources: ["S3", "S4"], explicit: true } },
      },
      {
        kind: "write",
        op: 40,
        event: 41,
        seen: 30,
        fields: { f2: { value: "3", sources: ["S1"], explicit: false } },
      },
      { kind: "undo", op: 50, event: 51, target: 40, includeLater: false },
      {
        kind: "write",
        op: 60,
        event: 61,
        seen: 50,
        fields: { f2: { value: "1", sources: ["S1"], explicit: false } },
      },
      {
        kind: "write",
        op: 70,
        event: 71,
        fields: { f2: { value: "3", sources: ["S1"], explicit: false } },
      },
    ] as unknown as Op[],
    decisions: [
      { after: 6, pick: 13, kind: "undo", flag: 5, focus: true },
      { after: 27, pick: 1281193021, kind: "take", flag: 5, focus: true },
    ] as unknown as Decision[],
    dels: [["S1"], ["S4"], [], ["S3"]],
    script: [{ c: 1 }, { c: 1 }, { x: 3 }, { c: 3 }],
  },
];
