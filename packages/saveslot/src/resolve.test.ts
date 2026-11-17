// `saveslot pending resolve` against a real service (06-cli §5.2, §5.4): a conflict, shown and
// resolved by take_candidate with the version shown; the item then closed (3 on another try);
// and the executable itself, its stdin no terminal, doing nothing (8).

import { spawnSync } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { request, resolveCredential } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-resolve-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
let token = "";
let item = "";
let row = "";

async function saveslot(argv: string[], answers?: string[]) {
  let out = "";
  let err = "";
  const asked: string[] = [];
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
      stdinIsTTY: answers !== undefined,
      ask: async (p) => {
        asked.push(p);
        return answers?.shift();
      },
    },
  );
  return { code, out, err, asked };
}

const write = async (body: unknown) =>
  (await request({
    socketPath: socketFile(home),
    method: "POST",
    path: "/v1/writes",
    token,
    body,
  })) as {
    ops: { target: { row: string }; ver: string }[];
  };

beforeAll(async () => {
  expect((await saveslot(["init"])).code).toBe(0);
  expect((await saveslot(["start"])).code).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
  expect(
    (await saveslot(["slot", "create", "ledger", "--template", "spending", "--timezone", "UTC"]))
      .code,
  ).toBe(0);
  const a = await write({
    sv: 1,
    evidence: [{ kind: "user_message", text: "lunch 45" }],
    ops: [
      {
        intent: "insert",
        table: "expenses",
        set: { date: "2026-11-10", category: "food", amount: { value: "45", unit: "CNY" } },
      },
    ],
  });
  row = a.ops[0]?.target.row as string;
  for (const v of ["54", "60"]) {
    await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: `it was ${v}` }],
      ops: [
        {
          intent: "correct",
          table: "expenses",
          row,
          ver: a.ops[0]?.ver,
          set: { amount: { value: v, unit: "CNY" } },
        },
      ],
    });
  }
  const list = JSON.parse((await saveslot(["pending", "--json"])).out) as {
    items: { id: string }[];
  };
  item = list.items[0]?.id as string;
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot pending resolve", () => {
  it("the executable with stdin no terminal: nothing done, 8", () => {
    const bin = fileURLToPath(new URL("./bin.ts", import.meta.url));
    const r = spawnSync(
      process.execPath,
      ["--conditions=source", bin, "pending", "resolve", item, "take_candidate", "--home", home],
      { input: "y\n", encoding: "utf8", env: { PATH: process.env["PATH"] ?? "" }, timeout: 60_000 },
    );
    expect(r.status).toBe(8);
    expect(r.stdout).toBe("");
  });

  it("shown, asked, resolved by take_candidate: the candidate's value in effect", async () => {
    const r = await saveslot(["pending", "resolve", item, "take_candidate"], ["y"]);
    expect(r.code).toBe(0);
    expect(r.err).toMatch(/candidate 0: correct .*amount 60 「CNY」/);
    expect(r.asked).toEqual([`take_candidate ${item}? [y/N] `]);
    expect(r.out).toMatch(new RegExp(`^${item} resolved: take_candidate · version iv_`));
    const q = JSON.parse((await saveslot(["query", "ledger.expenses", "--json"])).out) as {
      rows: { values: { amount: { value: string } } }[];
    };
    expect(q.rows[0]?.values.amount.value).toBe("60");
  });

  it("asked again: closed now, said how, 3", async () => {
    const r = await saveslot(["pending", "resolve", item, "keep_effective"], ["y"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain("resolved: take_candidate");
    expect(r.asked).toEqual([]);
  });
});
