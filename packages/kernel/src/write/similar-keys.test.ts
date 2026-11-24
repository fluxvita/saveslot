// `similarKeys` over a stubbed store (10-types-and-units «相近的键»: 比较范围是最近写入的 5,000 个实体):
// the 5,000th most recently written entity is compared, the 5,001st is not; what is read of the
// store is read once a request (`SimilarCache`). The store's three reads are answered by their SQL:
// the keys (`row_origins` with `content`), the latest write (`__ver`), the entities with a value.

import type { CompiledBaseTable, EntityId, FieldId } from "@fluxvita/saveslot-contract-core";
import { describe, expect, it } from "vitest";
import type { ReadTx } from "../store/ports.ts";
import { createSimilarCache, SIMILAR_SCOPE, similarKeys } from "./keys.ts";

const TABLE = {
  id: "t2",
  name: "budgets",
  kind: "base",
  description: "budgets",
  time: { type: "state", granularity: "date" },
  physical: { table: "t_t2_v1" },
  fields: [{ id: "f1", name: "category", type: "text", required: true, description: "category" }],
  entity_key: ["f1"],
} as unknown as CompiledBaseTable;

/** A store of entities with keys, the first written the oldest; the count of reads it answered. */
function stubStore(keys: readonly string[]) {
  const id = (i: number) => `e_${String(i).padStart(26, "0")}`;
  const reads = { n: 0 };
  const tx = {
    query: async (sql: string) => {
      reads.n++;
      if (sql.includes("FROM row_origins"))
        return {
          rows: keys.map((k, i) => ({
            row_id: id(i),
            path: "fields/f1",
            body: JSON.stringify({ value: k }),
          })),
        };
      if (sql.includes("__ver"))
        return { rows: keys.map((_, i) => ({ row_id: id(i), at: i + 1 })) };
      if (sql.includes("SELECT DISTINCT entity_id"))
        return { rows: keys.map((_, i) => ({ id: id(i) })) };
      throw new Error(`not stubbed: ${sql}`);
    },
  } as unknown as ReadTx;
  return { tx, reads };
}

const fresh = { f1: "q4 推广" } as Record<FieldId, string>;
const others = (n: number) => Array.from({ length: n }, (_, i) => `#${String(i).padStart(6, "0")}`);

describe("similarKeys: the scope and the cache", () => {
  it("the 5,000th most recently written is compared; one written after it puts it beyond", async () => {
    expect(SIMILAR_SCOPE).toBe(5000);
    const at = stubStore(["Q4推广", ...others(SIMILAR_SCOPE - 1)]);
    expect(await similarKeys(at.tx, TABLE, fresh, [], createSimilarCache())).toEqual([
      { key: "Q4推广", match: "fold" },
    ]);
    const beyond = stubStore(["Q4推广", ...others(SIMILAR_SCOPE)]);
    expect(await similarKeys(beyond.tx, TABLE, fresh, [], createSimilarCache())).toEqual([]);
  });

  it("this request's entities come first and push the oldest stored one out", async () => {
    const st = stubStore(["Q4推广", ...others(SIMILAR_SCOPE - 1)]);
    const here = [
      {
        entity: "e_x" as EntityId,
        key: { f1: "#here" } as Record<FieldId, string>,
        revoked: false,
      },
    ];
    expect(await similarKeys(st.tx, TABLE, fresh, here, createSimilarCache())).toEqual([]);
  });

  it("the store is read once a request: a second comparison reads nothing", async () => {
    const st = stubStore(["Q4推广", "办公用品"]);
    const cache = createSimilarCache();
    await similarKeys(st.tx, TABLE, fresh, [], cache);
    const first = st.reads.n;
    expect(await similarKeys(st.tx, TABLE, { f1: "办公 用品" } as never, [], cache)).toEqual([
      { key: "办公用品", match: "fold" },
    ]);
    expect(st.reads.n).toBe(first);
  });
});
