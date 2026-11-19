// A schema draft's receipt and refusals as text (05-surfaces §6 `saveslot_schema_draft`, §5, §7),
// against golden files. In this version a draft only creates a slot. The samples are what a
// running service gave back (schema-drafts.samples.json; the refusals as MCP gives them, with
// their message): a new slot with an event, a state, a timeless and a derived table, the same
// request replayed, a document that does not compile, tags left in a description, a connection
// whose range is not every slot, a rule's SQL refused with its reason and a fix, too many tables,
// no table; and what a derived table's document gets wrong: `sql` outside the rule, a rule that is
// not an object, a time dependency missing or not one, a type on a derived field, an unknown
// type, an event table's time field not required, or of another type and not required. Update the golden files with
// `pnpm exec vitest run packages/server/src/mcp/schema-drafts.test.ts -u`.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import type { ToolName } from "./names.ts";
import { renderError, renderStrict } from "./render.ts";

type R = Record<string, unknown>;
type Sample = { tool: ToolName; result: R } | { error: R };
const SAMPLES = JSON.parse(
  readFileSync(new URL("./schema-drafts.samples.json", import.meta.url), "utf8"),
) as Record<string, Sample>;

/** The text with the boundary's number, drawn anew for each result, made one fixed value. */
const fixed = (s: string) => s.replace(/untrusted-data-[0-9a-f]{32}/g, "untrusted-data-N");
const text = (s: Sample) =>
  fixed("error" in s ? renderError(s.error) : renderStrict(s.tool, s.result));

describe("schema drafts as text (golden)", () => {
  it.each(Object.keys(SAMPLES))("%s", async (name) => {
    await expect(`${text(SAMPLES[name] as Sample)}\n`).toMatchFileSnapshot(
      `./__golden__/${name}.txt`,
    );
  });
});

describe("schema drafts as text: what the samples do not show", () => {
  const created = (SAMPLES["schema-draft-created"] as { result: R }).result;

  it("a change this version does not make is shown as written, inside the boundary", () => {
    const changes = [{ target: { table: "meals" }, change: "drop_field", class: "destructive" }];
    expect(text({ tool: "saveslot_schema_draft", result: { ...created, changes } })).toContain(
      'Change: <untrusted-data-N>{"target":{"table":"meals"},"change":"drop_field","class":"destructive"}</untrusted-data-N>',
    );
  });

  it("names that are not names, in the document given back, go inside the boundary", () => {
    const document = {
      tables: [
        {
          name: "a b",
          kind: "base",
          time: { type: "none" },
          fields: [{ name: "c-d", type: "text" }],
        },
      ],
    };
    expect(text({ tool: "saveslot_schema_draft", result: { ...created, document } })).toContain(
      "<untrusted-data-N>a b</untrusted-data-N> (base · no time): <untrusted-data-N>c-d</untrusted-data-N> text",
    );
  });

  it("a draft not applied (a change awaiting confirmation, later versions) is not drawn", () => {
    expect(() =>
      renderStrict("saveslot_schema_draft", { ...created, outcome: "pending" }),
    ).toThrow();
  });

  it("allowed values: the service's own codes as they are, anything else inside the boundary", () => {
    const error = {
      code: "validation_failed",
      reason: "schema",
      details: [
        { path: "tables/0/fields/2/type", code: "unknown_type", allowed_values: ["text", "texts"] },
      ],
    };
    expect(fixed(renderError(error))).toContain(
      "    allowed: text, <untrusted-data-N>texts</untrusted-data-N>",
    );
    // A parameter's values, as a write's enum field gives them: the caller's words.
    const param = { code: "invalid_argument", reason: "malformed", param: "where/0/value" };
    expect(fixed(renderError({ ...param, allowed_values: ["food", "date"] }))).toContain(
      "Allowed: <untrusted-data-N>food</untrusted-data-N>, date",
    );
  });

  it("a path's segment that is no name or number is inside the boundary", () => {
    const error = {
      code: "validation_failed",
      reason: "schema",
      details: [{ path: "tables/0/x y", code: "unknown_reference" }],
    };
    expect(fixed(renderError(error))).toContain(
      "  tables/0/<untrusted-data-N>x y</untrusted-data-N>: unknown_reference",
    );
  });
});
