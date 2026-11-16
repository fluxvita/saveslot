// The result budget (05-surfaces §3), on results taken from a running service and a small budget:
// a page cut where the budget ends and asked for again for that many, saying shown of total, its
// next page from the first not shown; a single entry or a result that is no page over the budget
// refused as too large; a receipt never refused, shortened, keeping what it must; a result that
// fits left as it is.

import { describe, expect, it } from "vitest";
import { budgetFor } from "./budget.ts";
import type { ToolName } from "./names.ts";
import { renderError, renderResult } from "./render.ts";
import { SAMPLES } from "./samples.fixture.ts";

type R = Record<string, unknown>;

/** What the kernel does with the budget's fit: measure once, compute again for what it keeps. */
async function fit(
  tool: ToolName,
  result: R,
  budget: number,
  again: (limit: number) => Promise<R>,
): Promise<R> {
  const b = budgetFor(tool, budget);
  const keep = b.fit(result);
  return b.finish(keep === undefined ? result : await again(keep));
}
const sample = (k: string): R => {
  const s = SAMPLES[k];
  if (s === undefined) throw new Error(k);
  return structuredClone(s.result);
};
const CURSOR = `cur_abc.${"A".repeat(43)}`;
const CROCK = "0123456789ABCDEFGHJKMNPQRSTVWXYZ";
const rowId = (i: number) =>
  `r_${Array.from({ length: 26 }, (_, k) => CROCK[(i >> (k % 5)) % 32]).join("")}`;

/** A query page of `n` rows, each with a long note, of `total`. */
function page(n: number, total: number): R {
  const q = sample("query");
  const row = (q["rows"] as R[])[0] as R;
  return {
    ...q,
    total,
    rows: Array.from({ length: n }, (_, i) => ({
      ...row,
      row: rowId(i),
      values: { ...(row["values"] as R), note: `note ${i} ${"x".repeat(200)}` },
    })),
    next_cursor: CURSOR,
  };
}

describe("a page over the budget", () => {
  it("is cut where the budget ends and asked for again for that many: shown of total, the next page", async () => {
    const full = page(50, 500);
    const budget = 3000;
    const asked: number[] = [];
    const out = await fit("saveslot_query", full, budget, async (limit) => {
      asked.push(limit);
      return { ...page(limit, 500), next_cursor: CURSOR };
    });
    expect(asked).toHaveLength(1);
    const shown = asked[0] ?? 0;
    expect(shown).toBeGreaterThan(0);
    expect(shown).toBeLessThan(50);
    expect((out["rows"] as unknown[]).length).toBe(shown);
    expect(out["truncated"]).toEqual({ shown, total: 500 });
    const text = renderResult("saveslot_query", out);
    expect(text.length).toBeLessThanOrEqual(budget);
    expect(text).toContain(`Showing ${shown} of 500 rows; next page: cursor=${CURSOR}`);
    // One more row would not have fitted.
    const more = { ...page(shown + 1, 500), truncated: { shown: shown + 1, total: 500 } };
    // (less the room kept for the line of the next page's handle)
    expect(renderResult("saveslot_query", more).length).toBeGreaterThan(budget - 1_200);
  });

  it("the catalog's list is cut by tables", async () => {
    const cat = sample("catalog_list");
    const slot = (cat["slots"] as R[])[0] as R;
    const tables = Array.from({ length: 40 }, (_, i) => ({
      table: `t${i}`,
      kind: "base",
      description: "d".repeat(150),
    }));
    const full = { ...cat, total: 40, slots: [{ ...slot, tables }] };
    const out = await fit("saveslot_catalog", full, 2000, async (limit) => ({
      ...cat,
      total: 40,
      slots: [{ ...slot, tables: tables.slice(0, limit) }],
      next_cursor: CURSOR,
    }));
    const shown = (((out["slots"] as R[])[0] ?? {})["tables"] as unknown[]).length;
    expect(out["truncated"]).toEqual({ shown, total: 40 });
    expect(renderResult("saveslot_catalog", out).length).toBeLessThanOrEqual(2000);
  });

  it("one entry larger than the budget: too large", async () => {
    await expect(
      fit("saveslot_query", page(3, 3), 100, async () => {
        throw new Error("not asked for none");
      }),
    ).rejects.toMatchObject({
      code: "too_large",
      detail: { reason: "result_budget" },
    });
  });

  it("the page computed again that still does not fit: the adapter's fault, not the caller's", async () => {
    // By construction it cannot happen (one read, room kept); should it, it is an internal error.
    await expect(
      fit("saveslot_query", page(50, 500), 3000, async () => page(50, 500)),
    ).rejects.toThrow(/did not fit/);
  });
});

describe("too large: how to ask for less (05 §7)", () => {
  it("the error names the parameters, and its text says how, with no data", async () => {
    const error = await fit(
      "saveslot_catalog",
      sample("catalog_table"),
      100,
      async () => ({}),
    ).catch((e: { code: string; detail: Record<string, unknown> }) => e);
    expect(error).toMatchObject({ detail: { reason: "result_budget", narrow_by: ["tables"] } });
    const text = renderError({
      code: "too_large",
      ...(error as { detail: Record<string, unknown> }).detail,
    });
    expect(text).toContain("To read less: fewer tables (tables).");
    expect(text).not.toContain("untrusted-data");
    const q = await fit("saveslot_query", page(3, 3), 100, async () => {
      throw new Error("not asked for none");
    }).catch((e: { detail: Record<string, unknown> }) => e);
    expect(
      renderError({ code: "too_large", ...(q as { detail: Record<string, unknown> }).detail }),
    ).toContain("To read less: ask for fewer fields (fields).");
  });
});

describe("a result that is no page, over the budget", () => {
  it("is refused as too large", async () => {
    await expect(
      fit("saveslot_catalog", sample("catalog_table"), 100, async () => ({})),
    ).rejects.toMatchObject({ code: "too_large", detail: { reason: "result_budget" } });
  });
});

describe("a receipt over the budget", () => {
  it("is not refused: shortened, keeping its number, each op's target and ver, and its items", async () => {
    const w = sample("write_conflict");
    const ops = Array.from({ length: 30 }, () => (w["ops"] as R[])[0]);
    const big = { ...w, ops };
    const budget = renderResult("saveslot_write", big).length - 100;
    const out = await fit("saveslot_write", big, budget, async () => {
      throw new Error("a receipt is not asked for again");
    });
    expect(out["omitted"]).toContain("field_results");
    expect(out["seq"]).toBe(w["seq"]);
    expect(out["pending"]).toEqual(w["pending"]);
    for (const op of out["ops"] as R[]) {
      expect(op).toHaveProperty("target");
      expect(op).toHaveProperty("ver");
      expect(op).not.toHaveProperty("fields");
    }
    const text = renderResult("saveslot_write", out);
    expect(text).toContain(
      "The receipt was shortened to fit; the write is recorded, not all of it in effect.",
    );
    expect(text).toContain("pi_8VEZWJ3J7BMKMXTV");
  });
});

describe("a result within the budget", () => {
  it("is as it was, not asked for again", async () => {
    const q = sample("query");
    const out = await fit("saveslot_query", q, 100_000, async () => {
      throw new Error("not asked again");
    });
    expect(out).toEqual(q);
  });
});

describe("a receipt shortened says what it left out, and nothing it did not see", () => {
  it("an op whose field results were left out says so, never 'no change'", async () => {
    const w = sample("write_conflict");
    const big = { ...w, ops: Array.from({ length: 40 }, () => (w["ops"] as R[])[0]) };
    const budget = renderResult("saveslot_write", big).length - 200;
    const out = await fit("saveslot_write", big, budget, async () => ({}));
    const text = renderResult("saveslot_write", out);
    expect(text).toContain("field results left out of this receipt");
    expect(text).not.toContain("no change");
    expect(out["omitted"]).toEqual(["field_results"]);
  });

  it("resolve's receipt: the write in it is shortened, and says so", async () => {
    const w = sample("write_conflict");
    const r = {
      ...sample("resolve"),
      write: { ...w, ops: Array.from({ length: 40 }, () => (w["ops"] as R[])[0]) },
    };
    const budget = renderResult("saveslot_resolve", r).length - 200;
    const out = await fit("saveslot_resolve", r, budget, async () => ({}));
    expect((out["write"] as R)["omitted"]).toContain("field_results");
    expect(renderResult("saveslot_resolve", out)).toContain("The receipt was shortened to fit");
    expect(renderResult("saveslot_resolve", out)).not.toContain("took effect");
    expect(renderResult("saveslot_resolve", out).length).toBeLessThanOrEqual(budget);
  });

  it("however large, the text fits: 4000 ops; 3000 items and 3000 warnings", async () => {
    const w = sample("write_conflict");
    const op = (w["ops"] as R[])[0];
    const many = { ...w, ops: Array.from({ length: 4000 }, () => op) };
    const a = await fit("saveslot_write", many, 100_000, async () => ({}));
    const at = renderResult("saveslot_write", a);
    expect(at.length).toBeLessThanOrEqual(100_000);
    expect(at).toContain("more ops are left out of this receipt");
    expect(at).toContain("#13");
    const pending = (w["pending"] as R[])[0];
    const noisy = {
      ...w,
      pending: Array.from({ length: 3000 }, () => pending),
      warnings: Array.from({ length: 3000 }, () => ({ code: "ver_fallback", op: 0 })),
    };
    const b = await fit("saveslot_write", noisy, 100_000, async () => ({}));
    expect(renderResult("saveslot_write", b).length).toBeLessThanOrEqual(100_000);
    // At the very least: the operation number, the counts, and that it was shortened.
    const tiny = await fit("saveslot_write", noisy, 400, async () => ({}));
    const tt = renderResult("saveslot_write", tiny);
    expect(tt.length).toBeLessThanOrEqual(400);
    expect(tt).toContain("#13");
  });

  it("'lists' only when a list was cut", async () => {
    const w = sample("write_conflict");
    const big = { ...w, ops: Array.from({ length: 40 }, () => (w["ops"] as R[])[0]) };
    const out = await fit(
      "saveslot_write",
      big,
      renderResult("saveslot_write", big).length - 200,
      async () => ({}),
    );
    expect(out["omitted"]).not.toContain("lists");
  });
});

describe("a value too long for the text", () => {
  it("is shown in part, saying how long it is; the page is not refused", async () => {
    const q = page(3, 3);
    const rows = q["rows"] as R[];
    (rows[1] as R)["values"] = { ...((rows[1] as R)["values"] as R), note: "y".repeat(13_000) };
    const out = await fit("saveslot_query", q, 100_000, async () => {
      throw new Error("not cut");
    });
    const text = renderResult("saveslot_query", out);
    expect(text.length).toBeLessThanOrEqual(100_000);
    expect(text).toContain(
      "[the text shows the first 2000 of 13000 characters; the whole value is in the structured result] (fields can leave this column out)",
    );
    // structuredContent keeps the value whole.
    expect((((out["rows"] as R[])[1] ?? {})["values"] as R)["note"]).toHaveLength(13_000);
  });
});

describe("the numbers of a cut page agree", () => {
  it("the first line and Showing give the page's own total; the catalog counts tables", async () => {
    const out = await fit("saveslot_query", page(50, 500), 3000, async (limit) => ({
      ...page(limit, 500),
      next_cursor: CURSOR,
    }));
    const shown = (out["rows"] as unknown[]).length;
    const text = renderResult("saveslot_query", out);
    expect(text).toContain(`· ${shown} of 500 rows`);
    expect(text).toContain(`Showing ${shown} of 500 rows`);
    const noTotal = await fit(
      "saveslot_query",
      { ...page(50, 500), total: undefined },
      3000,
      async (limit) => ({ ...page(limit, 500), total: undefined, next_cursor: CURSOR }),
    );
    expect(renderResult("saveslot_query", noTotal)).toMatch(/Showing \d+ rows/);
  });
});

describe("the least receipt says only what it saw (05 §3)", () => {
  it("a replay whose original was deleted, with 3000 items: all three said, and items listed", async () => {
    const w = sample("write_conflict");
    const pending = (w["pending"] as R[])[0];
    const r = {
      ...w,
      replayed: true,
      original_deleted: { deletion: "pi_8VEZWJ3J7BMKMXTV" },
      ops: Array.from({ length: 4000 }, () => (w["ops"] as R[])[0]),
      pending: Array.from({ length: 3000 }, () => pending),
    };
    const out = await fit("saveslot_write", r, 6000, async () => ({}));
    const text = renderResult("saveslot_write", out);
    expect(text.length).toBeLessThanOrEqual(6000);
    expect(text).toContain(
      "This is the receipt of an earlier identical request; nothing new was recorded.",
    );
    expect(text).toContain("The original write was deleted (pi_8VEZWJ3J7BMKMXTV)");
    expect(text).toContain("The receipt was shortened to fit. saveslot_history shows all of it.");
    expect(text).not.toContain("took effect");
    expect(text).toContain("Pending: pi_8VEZWJ3J7BMKMXTV");
    expect(text).toMatch(/\d+ pending items are left out of this receipt/);
  });
});

describe("the structured result's own limit (05 §3)", () => {
  it("a page is cut where its structured result reaches 1 MiB, though its text is short", async () => {
    const q = sample("query");
    const row = (q["rows"] as R[])[0] as R;
    const big = (i: number) => ({
      ...row,
      row: rowId(i),
      values: { ...(row["values"] as R), note: "z".repeat(300_000) },
    });
    const full = {
      ...q,
      total: 10,
      rows: Array.from({ length: 10 }, (_, i) => big(i)),
      next_cursor: CURSOR,
    };
    const out = await fit("saveslot_query", full, 100_000, async (limit) => ({
      ...q,
      total: 10,
      rows: Array.from({ length: limit }, (_, i) => big(i)),
      next_cursor: CURSOR,
    }));
    expect(Buffer.byteLength(JSON.stringify(out))).toBeLessThanOrEqual(1024 * 1024);
    expect((out["rows"] as unknown[]).length).toBeGreaterThan(0);
    expect((out["rows"] as unknown[]).length).toBeLessThan(10);
  });

  it("one row over 1 MiB on its own: too large, read fewer fields", async () => {
    const q = sample("query");
    const row = (q["rows"] as R[])[0] as R;
    const one = { ...q, rows: [{ ...row, values: { note: "z".repeat(1_100_000) } }] };
    const e = await fit("saveslot_query", one, 100_000, async () => ({})).catch(
      (x: { code: string; detail: R }) => x,
    );
    expect(e).toMatchObject({
      code: "too_large",
      detail: { reason: "result_budget", narrow_by: ["fields"] },
    });
  });
});

describe("every untrusted part shown in part past its limit", () => {
  it("a writer's name of 60000 characters", () => {
    const h = sample("history");
    const entries = (h["entries"] as R[]).map((e) => ({
      ...e,
      actor: { kind: "connection", id: "x", name: "n".repeat(60_000) },
    }));
    const text = renderResult("saveslot_history", { ...h, entries });
    expect(text.length).toBeLessThan(10_000);
    expect(text).toContain(
      "[the text shows the first 2000 of 60000 characters; the whole value is in the structured result]",
    );
  });

  it("a long string in JSON as written: cut there, the lead says so", () => {
    const c = sample("catalog_schema");
    const doc = c["document"] as R;
    const long = { ...c, document: { ...doc, timezone: "t".repeat(5000) } };
    const text = renderResult("saveslot_catalog", long);
    expect(text).toContain("1 strings below show their first 2000 characters only");
    expect(text.length).toBeLessThan(6000);
  });
});
