// `saveslot query` and `saveslot history` against a real service (06-cli §4.7): a slot made from a
// file with a quantity and a zoned_datetime field, rows written, then read through the command
// line: --where by the fields' types, the timeline of a row, the row as of an operation.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, resolveCredential, TEXTS } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-reads-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
let token = "";

async function saveslot(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await dispatch(
    [...argv, "--home", home],
    { NO_COLOR: "1" },
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: true,
      stderrIsTTY: true,
    },
  );
  return { code, out, err };
}

const write = async (body: unknown) =>
  (await request({
    socketPath: socketFile(home),
    method: "POST",
    path: "/v1/writes",
    token,
    body,
  })) as {
    status: string;
    ops: { target: { row: string }; ver: string }[];
    seq: number;
  };

let first = "";
let firstSeq = 0;

beforeAll(async () => {
  expect((await saveslot("init")).code).toBe(0);
  expect((await saveslot("start")).code).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
  const file = join(root, "meals.json");
  writeFileSync(
    file,
    JSON.stringify({
      timezone: "Asia/Shanghai",
      tables: [
        {
          name: "meals",
          kind: "base",
          description: "each meal",
          time: { type: "event", field: "at" },
          fields: [
            { name: "at", type: "zoned_datetime", required: true, description: "when" },
            {
              name: "cost",
              type: "quantity",
              unit: "CNY",
              required: true,
              min: 0,
              description: "cost",
            },
            { name: "note", type: "text", description: "what" },
          ],
        },
      ],
    }),
  );
  expect((await saveslot("slot", "create", "food", "--file", file)).code).toBe(0);
  const a = await write({
    sv: 1,
    evidence: [{ kind: "user_message", text: "lunch 45" }],
    ops: [
      {
        intent: "insert",
        table: "meals",
        set: {
          at: "2026-11-10T12:31:00+08:00[Asia/Shanghai]",
          cost: { value: "45", unit: "CNY" },
          note: "lunch",
        },
      },
    ],
  });
  first = a.ops[0]?.target.row as string;
  firstSeq = a.seq;
  await write({
    sv: 1,
    evidence: [{ kind: "user_message", text: "dinner 80" }],
    ops: [
      {
        intent: "insert",
        table: "meals",
        set: { at: "2026-11-10T19:02:00+08:00[Asia/Shanghai]", cost: { value: "80", unit: "CNY" } },
      },
    ],
  });
  await write({
    sv: 1,
    evidence: [{ kind: "user_message", text: "lunch was 54, not 45" }],
    ops: [
      {
        intent: "correct",
        table: "meals",
        row: first,
        ver: a.ops[0]?.ver,
        set: { cost: { value: "54", unit: "CNY" } },
      },
    ],
  });
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot query", () => {
  it("--where on a quantity, with its unit: the matching row only; a moment shown as written", async () => {
    const r = await saveslot("query", "food.meals", "--where", "cost>60CNY");
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toBe("food.meals · food schema v1 · 1 rows");
    expect(lines[1]).toContain("「2026-11-10T19:02:00+08:00[Asia/Shanghai]」");
    expect(lines[1]).toContain("cost 80 「CNY」");
  });

  it("--json: the contract's result; --where-json and --order", async () => {
    const r = await saveslot(
      "query",
      "food.meals",
      "--where-json",
      '{"field":"note","op":"is_null","value":false}',
      "--json",
    );
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { rows: { row: string }[] };
    expect(j.rows.map((x) => x.row)).toEqual([first]);
  });

  it("--detail detailed: not in this version; the service's refusal said plainly, 5", async () => {
    for (const argv of [
      ["query", "food.meals", "--detail", "detailed"],
      ["history", "food.meals", first, "--as-of", "1", "--detail", "detailed"],
    ]) {
      const r = await saveslot(...argv);
      expect(r.code).toBe(5);
      expect(r.out).toBe("");
      expect(r.err).toMatch(/^error not_in_this_version /);
      expect(r.err).toContain("detail: detailed");
      // Then what to do instead, as the CLI's own words.
      expect(r.err.trim().split("\n")).toEqual([expect.any(String), `  ${TEXTS.detailedNotYet}`]);
    }
  });

  it("a quantity --where with no unit: a usage error before any query", async () => {
    const r = await saveslot("query", "food.meals", "--where", "cost>60");
    expect(r.code).toBe(2);
  });
});

describe("saveslot history", () => {
  it("the row's timeline: the correction newest first, before and after", async () => {
    const r = await saveslot("history", "food.meals", first);
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(/^food\.meals r_\w+ · current ver=v\d+\.0 · 2 changes$/);
    // The user session has no name of its own: its ID, inside the boundary.
    expect(lines[1]).toMatch(
      / correct {2}「u_\w+」 {2}cost 45 「CNY」 -> 54 「CNY」 {2}source s_\w+ \(correction\)$/,
    );
    expect(lines[2]).toMatch(/ insert /);
  });

  it("as of the first write: the row as it was, not for writing", async () => {
    const r = await saveslot("history", "food.meals", first, "--as-of", String(firstSeq));
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(new RegExp(`^as of #${firstSeq} `));
    expect(lines[1]).toContain("(a historical version, not for writing)");
    expect(lines[1]).toContain("cost 45 「CNY」");
  });
});

describe("saveslot history changes", () => {
  it("a window of operations: the table's changes newest first, the range in the first line", async () => {
    const r = await saveslot("history", "changes", "food.meals", "--since", String(firstSeq));
    expect(r.code).toBe(0);
    const lines = r.out.trim().split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^food\\.meals · after #${firstSeq} up to #\\d+ · 2 changes$`),
    );
    expect(lines[1]).toMatch(/ correct {2}「u_\w+」 {2}r_\w+ {2}cost 45 「CNY」 -> 54 「CNY」$/);
    expect(lines[2]).toMatch(/ insert {2}「u_\w+」 {2}r_\w+ {2}at 「\S+」; cost 80 「CNY」$/);
  });

  it("one row, from the start; --json is the contract's result", async () => {
    const r = await saveslot("history", "changes", "food.meals", first, "--since", "0", "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as {
      mode: string;
      since: number;
      total: number;
      target: { row: string };
      changes: { intent: string }[];
    };
    expect(j).toMatchObject({ mode: "changes", since: 0, total: 2, target: { row: first } });
    expect(j.changes.map((c) => c.intent)).toEqual(["correct", "insert"]);
  });

  it("my_last_read: the changes since the user's last read of the table; the call is a read too", async () => {
    expect((await saveslot("query", "food.meals")).code).toBe(0);
    await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: "snack 9" }],
      ops: [
        {
          intent: "insert",
          table: "meals",
          set: {
            at: "2026-11-11T16:00:00+08:00[Asia/Shanghai]",
            cost: { value: "9", unit: "CNY" },
          },
        },
      ],
    });
    const since = await saveslot("history", "changes", "food.meals", "--since", "my_last_read");
    expect(since.code).toBe(0);
    const lines = since.out.trim().split("\n");
    expect(lines[0]).toMatch(/ · 1 changes$/);
    expect(lines[1]).toMatch(/ insert {2}「u_\w+」 {2}r_\w+ {2}at 「\S+」; cost 9 「CNY」$/);
    // The call above read the table up to its end: nothing since.
    const none = await saveslot("history", "changes", "food.meals", "--since", "my_last_read");
    expect(none.code).toBe(0);
    expect(none.out).toContain("0 changes");
    expect(none.out).toContain("no changes");
  });

  it("a usage error before any call", async () => {
    const r = await saveslot("history", "changes", "food.meals");
    expect(r.code).toBe(2);
  });
});

describe("a table named changes", () => {
  // `history changes` is a subcommand: with a table that is itself named `changes`, the table's
  // timeline is asked for by its qualified name (06-cli §4.7).
  let row = "";
  beforeAll(async () => {
    const file = join(root, "changes.json");
    writeFileSync(
      file,
      JSON.stringify({
        timezone: "UTC",
        tables: [
          {
            name: "changes",
            kind: "base",
            description: "a table that is named like the mode",
            time: { type: "event", field: "at" },
            fields: [
              { name: "at", type: "zoned_datetime", required: true, description: "when" },
              { name: "note", type: "text", description: "what" },
            ],
          },
        ],
      }),
    );
    expect((await saveslot("slot", "create", "log", "--file", file)).code).toBe(0);
    const w = (await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: "a note" }],
      ops: [
        {
          intent: "insert",
          table: "log.changes",
          set: { at: "2026-11-10T12:00:00+00:00[UTC]", note: "n" },
        },
      ],
    })) as { ops: { target: { row: string } }[] };
    row = w.ops[0]?.target.row as string;
  });

  it("the timeline of a row of it, by the qualified name", async () => {
    const r = await saveslot("history", "log.changes", row);
    expect(r.code).toBe(0);
    expect(r.out.trim().split("\n")[0]).toMatch(
      /^log\.changes r_\w+ · current ver=v\d+\.0 · 1 changes$/,
    );
  });

  it("the changes of the table, named as the second word after the subcommand", async () => {
    for (const name of ["changes", "log.changes"]) {
      const r = await saveslot("history", "changes", name, "--since", "0");
      expect(r.code).toBe(0);
      expect(r.out.trim().split("\n")[0]).toMatch(
        /^log\.changes · from the start to #\d+ · 1 changes$/,
      );
    }
  });

  it("`history changes <row>` is the subcommand with the row as the table: refused", async () => {
    const r = await saveslot("history", "changes", row);
    expect(r.code).toBe(2);
    expect(r.err).toContain(TEXTS.changesSince);
    const withSince = await saveslot("history", "changes", row, "--since", "0");
    expect(withSince.code).toBe(4);
    expect(withSince.err).toContain("unknown_table");
  });
});
