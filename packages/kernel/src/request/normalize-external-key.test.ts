// normalizeWrite on `external_key` (03-data-model/04-write-and-read «按来源键写入», «给没有来源键的行补
// 键»; 04-contract §5.1): an op by key and a key added to a row, read and normalized at step 1, and
// each refusal with its code, reason and path. Locating, the key index and the three-way comparison
// are the write pipeline's; a key field in an update by `row` is checked there against the row.

import type { CompiledSchema } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import { COMPILED, errorOf, normalize as onFixture, onlyOp, ROW } from "./requests.fixture.ts";

// The fixture slot plus two keyed tables: `meals` (an event table, a key of two text fields) and
// `cards` (timeless, a key of an enum and an integer, the same shape `snacks` has).
const KEYED = {
  ...COMPILED,
  tables: [
    ...COMPILED.tables,
    {
      id: "t8",
      name: "meals",
      kind: "base",
      description: "one row per meal",
      time: { type: "event", field: "f1" },
      physical: { table: "t_t8_v1" },
      fields: [
        { id: "f1", name: "eaten_on", type: "date", required: true, description: "the day" },
        { id: "f2", name: "origin", type: "text", description: "the source system" },
        { id: "f3", name: "external_id", type: "text", description: "its ID there" },
        { id: "f4", name: "energy", type: "integer", description: "kcal" },
      ],
      external_key: ["f2", "f3"],
    },
    {
      id: "t9",
      name: "cards",
      kind: "base",
      description: "timeless, keyed",
      time: { type: "none" },
      physical: { table: "t_t9_v1" },
      fields: [
        { id: "f1", name: "bank", type: "enum", description: "its bank", values: ["a", "b"] },
        { id: "f2", name: "number", type: "integer", description: "its number" },
        { id: "f3", name: "label", type: "text", description: "a label" },
      ],
      external_key: ["f1", "f2"],
    },
    {
      id: "t10",
      name: "snacks",
      kind: "base",
      description: "timeless, keyed as cards",
      time: { type: "none" },
      physical: { table: "t_t10_v1" },
      fields: [
        { id: "f1", name: "bank", type: "enum", description: "its bank", values: ["a", "b"] },
        { id: "f2", name: "number", type: "integer", description: "its number" },
      ],
      external_key: ["f1", "f2"],
    },
  ],
} as CompiledSchema;

const normalize = (params: unknown) => onFixture(params, { compiled: KEYED });
const KEY = { origin: "band_app", external_id: "m-2" };
const byKey = (more: Record<string, unknown> = {}) => ({
  intent: "update",
  table: "meals",
  external_key: KEY,
  set: { energy: 650 },
  ...more,
});
const addKey = (more: Record<string, unknown> = {}) => ({
  intent: "update",
  table: "meals",
  row: ROW,
  ver: "v41.0",
  external_key: KEY,
  ...more,
});
const ops = (...o: Record<string, unknown>[]) => ({ ops: o });
const refusal = (reason: string, param: string, more: Record<string, unknown> = {}) => ({
  code: "invalid_argument",
  reason,
  param,
  ...more,
});

describe("external_key", () => {
  it("an op by key: the key as its target, normalized by field ID; no ver; its fields named", () => {
    const op = onlyOp(normalize(ops(byKey())));
    expect(op.target).toEqual({
      kind: "external_key",
      key: { f2: { value: "band_app", raw: "band_app" }, f3: { value: "m-2", raw: "m-2" } },
    });
    expect(op.ver).toBeUndefined();
    expect(op.externalKey).toBeUndefined();
    expect(op.intent).toBe("update");
    expect(op.fields).toEqual({ f4: { value: "650", raw: "650" } });
    expect(op.named).toEqual([
      { field: "f4", name: "energy", param: "ops/0/set/energy" },
      { field: "f2", name: "origin", param: "ops/0/external_key/origin" },
      { field: "f3", name: "external_id", param: "ops/0/external_key/external_id" },
    ]);
  });

  it("a correction by key; a key on a timeless table, an enum and an integer, names by case", () => {
    expect(onlyOp(normalize(ops(byKey({ intent: "correct" })))).intent).toBe("correct");
    const op = onlyOp(
      normalize(
        ops({
          intent: "update",
          table: "cards",
          external_key: { BANK: "a", number: 7 },
          set: { label: "x" },
        }),
      ),
    );
    expect(op.target).toEqual({
      kind: "external_key",
      key: { f1: { value: "a", raw: "a" }, f2: { value: "7", raw: "7" } },
    });
  });

  it("a key's text is normalized to NFC; the raw value stays as written", () => {
    const decomposed = `caf${"e"}${String.fromCodePoint(0x301)}`;
    const op = onlyOp(
      normalize(ops(byKey({ external_key: { origin: decomposed, external_id: "1" } }))),
    );
    expect(op.target).toMatchObject({
      key: { f2: { value: "café".normalize("NFC"), raw: decomposed } },
    });
  });

  it("a key added to a row: target the row, the key beside it; without set, or with set and premises", () => {
    const op = onlyOp(normalize(ops(addKey())));
    expect(op.target).toEqual({ kind: "row", row: ROW });
    expect(op.ver).toEqual({ op: 41, restoreCount: 0 });
    expect(op.fields).toBeUndefined();
    expect(op.externalKey).toEqual({
      f2: { value: "band_app", raw: "band_app" },
      f3: { value: "m-2", raw: "m-2" },
    });
    const more = onlyOp(
      normalize(
        ops(
          addKey({
            set: { energy: 600 },
            premises: [{ table: "settings", row: `r_${"3".repeat(26)}` }],
          }),
        ),
      ),
    );
    expect(more.fields).toEqual({ f4: { value: "600", raw: "600" } });
    expect(more.premises).toHaveLength(1);
    // Without ver: the fallback's, as any update by row.
    expect(onlyOp(normalize(ops(addKey({ ver: undefined })))).ver).toBeUndefined();
  });

  it.each([
    [
      "on a table with no key",
      byKey({ table: "settings", set: { key: "x" } }),
      refusal("no_external_key", "ops/0/external_key"),
    ],
    [
      "on a state table",
      {
        intent: "update",
        table: "accounts",
        entity_key: { name: "cash" },
        external_key: { name: "c" },
        set: { limit: 1 },
      },
      refusal("no_external_key", "ops/0/external_key"),
    ],
    [
      "an insert with external_key",
      byKey({ intent: "insert" }),
      refusal("insert_with_external_key", "ops/0/external_key"),
    ],
    [
      "an insert with a key field in set",
      { intent: "insert", table: "meals", set: { eaten_on: "2026-11-10", origin: "band_app" } },
      refusal("insert_with_external_key", "ops/0/set/origin"),
    ],
    [
      "a revoke by key",
      { intent: "revoke", table: "meals", external_key: KEY },
      refusal("mutually_exclusive", "ops/0/external_key"),
    ],
    [
      "a revoke by row with a key",
      { intent: "revoke", table: "meals", row: ROW, ver: "v4.0", external_key: KEY },
      refusal("mutually_exclusive", "ops/0/external_key"),
    ],
    [
      "a revert with a key",
      { table: "meals", row: ROW, revert: { undo: 3 }, external_key: KEY },
      refusal("mutually_exclusive", "ops/0/external_key"),
    ],
    ["an op by key with ver", byKey({ ver: "v4.0" }), refusal("mutually_exclusive", "ops/0/ver")],
    [
      "an op by key with premises",
      byKey({ premises: [] }),
      refusal("premises_with_external_key", "ops/0/premises"),
    ],
    [
      "a correction adding a key to a row",
      addKey({ intent: "correct", set: { energy: 1 } }),
      refusal("mutually_exclusive", "ops/0/external_key"),
    ],
    [
      "an entity on an event table with a key",
      byKey({ entity: `e_${"2".repeat(26)}` }),
      refusal("not_state_table", "ops/0/entity"),
    ],
    [
      "external_key not an object",
      byKey({ external_key: ["band_app", "m-2"] }),
      refusal("malformed", "ops/0/external_key"),
    ],
    [
      "a field not in the key",
      byKey({ external_key: { ...KEY, energy: 1 } }),
      refusal("malformed", "ops/0/external_key/energy"),
    ],
    [
      "a field the table does not have",
      byKey({ external_key: { ...KEY, nope: 1 } }),
      refusal("malformed", "ops/0/external_key/nope"),
    ],
    [
      "a key field twice, by case",
      byKey({ external_key: { ...KEY, ORIGIN: "x" } }),
      refusal("malformed", "ops/0/external_key/ORIGIN"),
    ],
    [
      "a key field missing",
      byKey({ external_key: { origin: "band_app" } }),
      refusal("missing", "ops/0/external_key/external_id"),
    ],
    [
      "a key field null",
      byKey({ external_key: { origin: "band_app", external_id: null } }),
      refusal("missing", "ops/0/external_key/external_id"),
    ],
    ["an op by key without set", byKey({ set: undefined }), refusal("missing", "ops/0/set")],
  ])("refuses %s", (_, o, error) => {
    const op = { ...o } as Record<string, unknown>;
    for (const k of Object.keys(op)) if (op[k] === undefined) delete op[k];
    expect(errorOf(normalize(ops(op)))).toEqual(error);
  });

  it("a key value of the wrong kind is a value error, and no duplicate is looked for", () => {
    const bad = {
      intent: "update",
      table: "cards",
      external_key: { bank: "z", number: 7 },
      set: { label: "x" },
    };
    expect(errorOf(normalize(ops(bad, bad)))).toMatchObject({
      code: "validation_failed",
      details: [
        { op: 0, table: "ledger.cards", field: "bank" },
        { op: 1, table: "ledger.cards", field: "bank" },
      ],
    });
  });

  describe("a key field in the set of an op by key", () => {
    it("the key's value again (by the same-value criterion: NFC) is let through", () => {
      const decomposed = `m-${"e"}${String.fromCodePoint(0x301)}`;
      const op = onlyOp(
        normalize(
          ops(
            byKey({
              external_key: { origin: "band_app", external_id: "m-é" },
              set: { external_id: decomposed },
            }),
          ),
        ),
      );
      expect(op.fields).toEqual({ f3: { value: "m-é", raw: decomposed } });
    });

    it.each([
      ["another value", "m-3"],
      ["by case", "M-2"],
      ["with a space", "m-2 "],
    ])("%s is key_field_changed at that field", (_, v) => {
      expect(errorOf(normalize(ops(byKey({ set: { energy: 1, External_ID: v } }))))).toEqual(
        refusal("key_field_changed", "ops/0/set/External_ID"),
      );
    });

    it("an integer key field compares as its value", () => {
      const o = { intent: "update", table: "cards", external_key: { bank: "a", number: 7 } };
      expect(onlyOp(normalize(ops({ ...o, set: { number: 7.0 } }))).fields).toEqual({
        f2: { value: "7", raw: "7" },
      });
      expect(errorOf(normalize(ops({ ...o, set: { number: 8 } })))).toEqual(
        refusal("key_field_changed", "ops/0/set/number"),
      );
    });
  });

  describe("the same key twice in a request", () => {
    it("two ops by key: refused at the later, with both indices", () => {
      expect(
        errorOf(
          normalize(ops(byKey(), { intent: "insert", table: "kv", set: { rank: 1 } }, byKey())),
        ),
      ).toEqual(refusal("duplicate_external_key", "ops/2/external_key", { ops: [0, 2] }));
    });

    it("as normalized values: NFC-equal text and an integer written two ways are the same key", () => {
      const nfd = `band_app${String.fromCodePoint(0x301)}`;
      const nfc = nfd.normalize("NFC");
      expect(
        errorOf(
          normalize(
            ops(
              byKey({ external_key: { origin: nfc, external_id: "1" } }),
              byKey({ external_key: { origin: nfd, external_id: "1" } }),
            ),
          ),
        ),
      ).toMatchObject({ reason: "duplicate_external_key", ops: [0, 1] });
      const card = (n: unknown) => ({
        intent: "update",
        table: "cards",
        external_key: { bank: "a", number: n },
        set: { label: "x" },
      });
      expect(errorOf(normalize(ops(card(7), card(7.0))))).toMatchObject({
        reason: "duplicate_external_key",
        ops: [0, 1],
      });
    });

    it("one op by key and one adding the key to a row: the same key, refused", () => {
      expect(errorOf(normalize(ops(addKey(), byKey())))).toEqual(
        refusal("duplicate_external_key", "ops/1/external_key", { ops: [0, 1] }),
      );
    });

    it("not the same key: another value, another case, or the same values in another table", () => {
      const other = byKey({ external_key: { origin: "band_app", external_id: "m-3" } });
      const cased = byKey({ external_key: { origin: "Band_app", external_id: "m-2" } });
      expect(normalize(ops(byKey(), other, cased)).ok).toBe(true);
      const key = { bank: "a", number: 7 };
      expect(
        normalize(
          ops(
            { intent: "update", table: "cards", external_key: key, set: { label: "x" } },
            { intent: "update", table: "snacks", external_key: key, set: { number: 7 } },
          ),
        ).ok,
      ).toBe(true);
    });
  });
});
