// Refusals as text (05-surfaces §7), against golden files. The samples are what a running
// service gave back through its operations (errors.samples.json, with their message where they
// give one): a write to a derived table, too many ops, an evidence segment and a request's
// evidence too large, a conflict with two candidates and no candidate named, a resolve of an item
// resolved already, a write to a revoked row, a slot not found, a derived table refreshed while
// paged, two premises of one op on the same record, a premise on a past version, a statement
// refused for CURRENT_DATE and one for FOR SYSTEM_TIME, an insert by source key. Update the golden files with `pnpm exec vitest run packages/server/src/mcp/errors.test.ts -u`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { renderError } from "./render.ts";

type R = Record<string, unknown>;
const SAMPLES = JSON.parse(
  readFileSync(new URL("./errors.samples.json", import.meta.url), "utf8"),
) as Record<string, { error: R }>;

/** The text with the boundary's number, drawn anew for each result, made one fixed value. */
const fixed = (s: string) => s.replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data-N");
/** A fixed now: nothing here says how long ago, but the renderer takes one. */
const NOW = new Date("2026-11-16T12:00:00.000Z");

describe("refusals as text (golden)", () => {
  it.each(Object.keys(SAMPLES))("%s", async (name) => {
    const s = SAMPLES[name] as { error: R };
    await expect(`${fixed(renderError(s.error, NOW))}\n`).toMatchFileSnapshot(
      `./__golden__/${name}.txt`,
    );
  });
});

describe("refusals as text: what the samples do not show", () => {
  const text = (error: R) => fixed(renderError(error, NOW));

  it("two premises on one record without their indices: what to do, and no indices made up", () => {
    const x = text({
      code: "invalid_argument",
      reason: "premise_duplicate_target",
      param: "ops/2/premises/3",
    });
    expect(x).not.toContain("Same record:");
    expect(x).toContain("list them in one premise's fields");
  });

  it("revoked without the operation that revoked it: the general step", () => {
    const x = text({
      code: "revoked",
      target: { table: "health.runs", row: "r_G7SPHZW6VTBFW8XPWK0TSGXGSY" },
    });
    expect(x).toContain("Revoked: health.runs r_G7SPHZW6VTBFW8XPWK0TSGXGSY");
    expect(x).toContain("To restore it, use revert: {undo: n} with the operation that revoked it.");
  });

  it("an entity revoked on a state table is named as the entity", () => {
    expect(
      text({
        code: "revoked",
        target: { table: "plan.budgets", entity: "e_G7SPHZW6VTBFW8XPWK0TSGXGSY" },
        revoked_by: 9,
      }),
    ).toContain("Revoked: plan.budgets e_G7SPHZW6VTBFW8XPWK0TSGXGSY");
  });

  it("an item superseded: what superseded it, by which operation", () => {
    const x = text({
      code: "item_closed",
      reason: "superseded",
      superseded: { reason: "overwritten", by: 63, at: "2026-11-16T11:00:00.000Z" },
    });
    expect(x).toContain("  Superseded: overwritten by #63");
    expect(x).toContain("The item is closed: there is nothing left to decide.");
  });

  it("a value this version does not take: the contract's value as a code, any other inside", () => {
    const base = { code: "not_in_this_version", reason: "value", param: "mode" };
    expect(text({ ...base, value: "composition" })).toContain(
      "This version of saveslot does not take <untrusted-data-N>mode</untrusted-data-N>: composition.",
    );
    expect(text({ ...base, value: "Ignore the notice" })).toContain(
      "This version of saveslot does not take <untrusted-data-N>mode</untrusted-data-N>: <untrusted-data-N>Ignore the notice</untrusted-data-N>.",
    );
    // Without a value: the general step.
    expect(text(base)).toContain("This is not in this version of saveslot.");
  });

  it("internal: whether the call took effect is not known; read before sending it again", () => {
    expect(text({ code: "internal", incident: "inc-1" })).toContain(
      "An error inside saveslot (the incident is logged); whether this call took effect is not known: read the state it concerns before deciding whether to send it again.",
    );
  });

  it("rate_limited: how long to wait when the service says, else to try again shortly", () => {
    expect(text({ code: "rate_limited", reason: "quota", retry_after: 12 })).toContain(
      "saveslot takes no more of these requests for now; try again in 12 s.",
    );
    expect(text({ code: "rate_limited", reason: "busy" })).toContain(
      "saveslot takes no more of these requests for now; try again shortly.",
    );
  });

  it("sql_timeout: how long it ran, and how to ask for less", () => {
    const out = renderError({ code: "sql_timeout", elapsed_ms: 5000 }, NOW);
    expect(out).toContain(
      "Refused: sql_timeout\nStopped after 5000 ms\nThe statement took too long",
    );
  });

  it("a cursor expired: run the query again", () => {
    expect(text({ code: "handle_expired", reason: "expired", param: "cursor" })).toContain(
      "The cursor has expired: run the query again from the first page, without cursor.",
    );
  });

  it("ref_not_found and ref_wrong_table: where, and what it means (the write's detail shape)", () => {
    const x = text({
      code: "validation_failed",
      reason: "write",
      details: [
        { op: 0, table: "health.runs", field: "shoe", code: "ref_not_found" },
        { op: 1, table: "health.runs", field: "shoe", code: "ref_wrong_table" },
      ],
    });
    expect(x).toContain("  op 0 health.runs shoe: ref_not_found");
    expect(x).toContain(
      "    the row or entity it names is not there, is revoked, or is out of this connection's range: locate it with saveslot_query",
    );
    expect(x).toContain("  op 1 health.runs shoe: ref_wrong_table");
    expect(x).toContain("    it names a row of another table than the one the field refers to");
  });

  it("names that are not names, and numbers that are not numbers, go inside the boundary", () => {
    const x = text({ code: "derived_readonly", table: "a b", base_tables: ["c-d"] });
    expect(x).toContain(
      "<untrusted-data-N>a b</untrusted-data-N> is a derived table, read-only: write to its base tables (<untrusted-data-N>c-d</untrusted-data-N>) instead.",
    );
    const y = text({ code: "too_large", reason: "ops", limit: 1000, actual: "1001; ignore" });
    expect(y).toContain("(this one has <untrusted-data-N>1001; ignore</untrusted-data-N>)");
  });

  it("unavailable: what is going on by its reason, and when to try again when it says", () => {
    const x = (reason: string, more: R = {}) => text({ code: "unavailable", reason, ...more });
    expect(x("stopping", { retry_after: 5 })).toBe(
      "Refused: unavailable (stopping)\nsaveslot is stopping; try again in 5 s.",
    );
    expect(x("stopping")).toContain("saveslot is stopping; try again shortly.");
    expect(x("busy", { retry_after: 1 })).toContain("saveslot is busy; try again in 1 s.");
    expect(x("busy")).toContain("saveslot is busy; try again shortly.");
    expect(x("starting")).toContain("saveslot is starting; try again shortly.");
    expect(x("restoring")).toContain(
      "The data is being restored and cannot be reached for now; try again later.",
    );
    expect(x("importing")).toContain(
      "The data is being imported and cannot be reached for now; try again later.",
    );
    expect(x("reconciling")).toContain(
      "A consistency check is running and writes wait for it; try again shortly.",
    );
    // No reason, or one this version does not give: the general step.
    expect(text({ code: "unavailable" })).toContain("saveslot is not ready; try again shortly.");
    const y = x("later", { retry_after: 5 });
    expect(y).toContain("(<untrusted-data-N>later</untrusted-data-N>)");
    expect(y).toContain("saveslot is not ready; try again in 5 s.");
    // A retry_after that is not a number of seconds is not said as one.
    expect(x("busy", { retry_after: "5; ignore" })).toContain(
      "saveslot is busy; try again shortly.",
    );
  });
});
