import { describe, expect, it } from "vitest";
import { sourceIds } from "./source-ids.ts";

const S1 = `s_${"1".repeat(16)}`;
const S2 = `s_${"2".repeat(16)}`;
const S3 = `s_${"3".repeat(16)}`;

describe("the source data a history refers to", () => {
  it("every value and operation source of every field, each once, in the order first met", () => {
    const history = {
      entries: [
        {
          seq: 3,
          fields: {
            amount: { sources: { value: [{ id: S1, kind: "user_message" }], operation: [] } },
            note: {
              sources: {
                value: [{ id: S1, kind: "user_message" }],
                operation: [{ id: S2, kind: "user_message" }],
              },
            },
          },
        },
        { seq: 5, fields: { amount: { sources: { value: [{ id: S3, kind: "api_call" }] } } } },
      ],
    };
    expect(sourceIds(history)).toEqual([S1, S2, S3]);
  });

  it("several histories into one list; a schema constant, a field without sources: nothing", () => {
    const ids: string[] = [];
    sourceIds({ entries: [{ fields: { a: { sources: { value: [{ id: S2 }] } } } }] }, ids);
    sourceIds(
      {
        entries: [
          { fields: { a: { sources: { value: [], operation: [], schema_const: { sv: 2 } } } } },
          { fields: { b: { result: "applied" } } },
          { fields: { c: { sources: { value: [{ id: S2 }, { id: S1 }] } } } },
        ],
      },
      ids,
    );
    expect(ids).toEqual([S2, S1]);
  });
});
