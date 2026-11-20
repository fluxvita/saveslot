// `premiseDelta` on the cases 02-integrity «写入的前提» names: only values count, declared fields and
// business time only, a revoke whatever was declared, and the changed stretches kept as they are.

import type { FieldId, FieldValue } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { premiseDelta } from "./premise.ts";
import type { EntitySegment, Range, TargetState } from "./types.ts";

const f1 = "f1" as FieldId;
const f2 = "f2" as FieldId;

const row = (
  presence: "live" | "revoked",
  fields: Record<string, FieldValue>,
  source: Record<string, string> = {},
): TargetState => ({
  kind: "row",
  presence,
  fields: Object.fromEntries(
    Object.entries(fields).map(([k, value]) => [k, { value, source: source[k] ?? "s1" }]),
  ),
});

const seg = (
  from: string,
  to: string | null,
  values: Record<string, FieldValue>,
  source: Record<string, string> = {},
): EntitySegment => ({
  from,
  to,
  values,
  source: Object.fromEntries(Object.keys(values).map((k) => [k, source[k] ?? "s1"])),
});
const entity = (segments: EntitySegment[], revoked: Range[] = []): TargetState => ({
  kind: "entity",
  segments,
  revoked,
});

describe("premiseDelta on a row", () => {
  const seen = row("live", { f1: "2026-12-01", f2: "release" });

  it("is empty when the values are the same, whatever gave them", () => {
    expect(
      premiseDelta(seen, row("live", { f1: "2026-12-01", f2: "release" }, { f1: "s2" }), {}),
    ).toEqual([]);
  });

  it("gives a declared field whose value changed, with both values", () => {
    const now = row("live", { f1: "2026-11-20", f2: "release" });
    expect(premiseDelta(seen, now, { fields: [f1] })).toEqual([
      { comparable: true, field: f1, before: "2026-12-01", after: "2026-11-20" },
    ]);
  });

  it("does not give a field that was not declared", () => {
    const now = row("live", { f1: "2026-12-01", f2: "launch" });
    expect(premiseDelta(seen, now, { fields: [f1] })).toEqual([]);
    expect(premiseDelta(seen, now, {}).map((d) => d.field)).toEqual([f2]);
  });

  it("gives a revoke whatever fields were declared, and taking it back too", () => {
    const revoked = row("revoked", { f1: "2026-12-01", f2: "release" });
    expect(premiseDelta(seen, revoked, { fields: [f2] })).toEqual([
      { comparable: true, field: "existence", before: true, after: false },
    ]);
    expect(premiseDelta(revoked, seen, { fields: [f2] })).toEqual([
      { comparable: true, field: "existence", before: false, after: true },
    ]);
  });

  it("gives a row's existence that changed without a revoke only to a premise on the whole row", () => {
    // A row with no cell on the seen side (not reachable for a premise, whose target exists at the
    // version it saw; the function's definition all the same): created, its fields given.
    const none: TargetState = { kind: "row", presence: "absent", fields: {} };
    const made = row("live", { f1: "2026-12-01", f2: "release" });
    expect(premiseDelta(none, made, { fields: [f1] }).map((d) => d.field)).toEqual([f1]);
    expect(premiseDelta(none, made, {}).map((d) => d.field)).toEqual(["existence", f1, f2]);
  });

  it("refuses business time on a row", () => {
    expect(() => premiseDelta(seen, seen, { range: { at: "2026-11-01" } })).toThrow(TypeError);
  });
});

describe("premiseDelta on an entity", () => {
  // A budget of 5000 from 10-01 on.
  const seen = entity([seg("2026-10-01", null, { f1: "5000", f2: "eur" })]);
  // From 12-01 on it is 3000.
  const later = entity([
    seg("2026-10-01", "2026-12-01", { f1: "5000", f2: "eur" }),
    seg("2026-12-01", null, { f1: "3000", f2: "eur" }),
  ]);

  it("is empty when only the cuts differ, or only what gave the values", () => {
    const recut = entity([
      seg("2026-10-01", "2026-11-01", { f1: "5000", f2: "eur" }, { f1: "s2" }),
      seg("2026-11-01", null, { f1: "5000", f2: "eur" }),
    ]);
    expect(premiseDelta(seen, recut, {})).toEqual([]);
  });

  it("does not give a change outside the declared stretch", () => {
    expect(
      premiseDelta(seen, later, { fields: [f1], range: { from: "2026-11-01", to: "2026-12-01" } }),
    ).toEqual([]);
    expect(premiseDelta(seen, later, { range: { at: "2026-11-15" } })).toEqual([]);
  });

  it("gives the changed stretch cut to the declared one", () => {
    expect(
      premiseDelta(seen, later, { fields: [f1], range: { from: "2026-11-01", to: "2027-01-01" } }),
    ).toEqual([
      {
        comparable: true,
        field: f1,
        stretches: [
          { from: "2026-12-01", to: "2027-01-01", change: "value", before: "5000", after: "3000" },
        ],
      },
    ]);
  });

  it("gives, for a point, the whole stretch that holds it", () => {
    expect(premiseDelta(seen, later, { range: { at: "2026-12-10" } })).toEqual([
      {
        comparable: true,
        field: f1,
        stretches: [
          { from: "2026-12-01", to: null, change: "value", before: "5000", after: "3000" },
        ],
      },
    ]);
  });

  it("keeps two changed stretches apart, from now on", () => {
    const now = entity([
      seg("2026-10-01", "2026-11-10", { f1: "5000", f2: "eur" }),
      seg("2026-11-10", "2026-11-20", { f1: "4000", f2: "eur" }),
      seg("2026-11-20", "2026-12-01", { f1: "5000", f2: "eur" }),
      seg("2026-12-01", null, { f1: "3000", f2: "eur" }),
    ]);
    const d = premiseDelta(seen, now, { fields: [f1], range: { from: "2026-11-15", to: null } });
    expect(d).toHaveLength(1);
    expect((d[0] as { stretches: unknown }).stretches).toEqual([
      { from: "2026-11-15", to: "2026-11-20", change: "value", before: "5000", after: "4000" },
      { from: "2026-12-01", to: null, change: "value", before: "5000", after: "3000" },
    ]);
  });

  it("gives a revoke meeting the declared time whatever fields were declared", () => {
    // The declared field is empty: only the revoke can show there.
    const blank = entity([seg("2026-10-01", null, { f1: "5000", f2: null })]);
    const revoked = entity(
      [seg("2026-10-01", "2026-12-01", { f1: "5000", f2: null })],
      [{ from: "2026-12-01", to: null }],
    );
    const existence = {
      comparable: true,
      field: "existence",
      stretches: [{ from: "2026-12-01", to: null, change: "value", before: true, after: false }],
    };
    expect(premiseDelta(blank, revoked, { fields: [f2], range: { at: "2026-12-05" } })).toEqual([
      existence,
    ]);
    expect(premiseDelta(blank, revoked, { fields: [f2], range: { at: "2026-11-05" } })).toEqual([]);
    // A declared field with a value goes with the revoke, and shows too.
    expect(
      premiseDelta(
        seen,
        entity(
          [seg("2026-10-01", "2026-12-01", { f1: "5000", f2: "eur" })],
          [{ from: "2026-12-01", to: null }],
        ),
        {
          fields: [f2],
          range: { at: "2026-12-05" },
        },
      ).map((d) => d.field),
    ).toEqual(["existence", f2]);
  });

  it("gives a declared field that lost its value without a revoke as changed; existence too on the whole row", () => {
    // An undo of a fill: no value from 12-01, no revoke.
    const gone = entity([seg("2026-10-01", "2026-12-01", { f1: "5000", f2: "eur" })]);
    const whole = premiseDelta(seen, gone, { range: { from: "2026-12-01", to: null } });
    expect(whole.map((d) => d.field)).toEqual(["existence", f1, f2]);
    // On declared fields it shows through the field, whose value went.
    const declared = premiseDelta(seen, gone, {
      fields: [f1],
      range: { from: "2026-12-01", to: null },
    });
    expect(declared).toEqual([
      {
        comparable: true,
        field: f1,
        stretches: [{ from: "2026-12-01", to: null, change: "value", before: "5000" }],
      },
    ]);
  });

  it("does not give an empty value that went to a declared field, only by existence to the whole row", () => {
    // f2 is null; from 12-01 the entity has no value, and no revoke.
    const blank = entity([seg("2026-10-01", null, { f1: "5000", f2: null })]);
    const cut = entity([seg("2026-10-01", "2026-12-01", { f1: "5000", f2: null })]);
    expect(premiseDelta(blank, cut, { fields: [f2] })).toEqual([]);
    const whole = premiseDelta(blank, cut, { range: { from: "2026-12-01", to: null } });
    expect(whole.map((d) => d.field)).toEqual(["existence", f1]);
    expect((whole[0] as { stretches: unknown }).stretches).toEqual([
      { from: "2026-12-01", to: null, change: "value", before: true },
    ]);
  });
});
