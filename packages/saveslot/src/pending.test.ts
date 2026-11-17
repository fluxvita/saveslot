// `saveslot pending`, `reads` and `verify` against a real service (06-cli §4.5, §4.8, §5.1): two
// writes to one row from the same version make a conflict item; the command line lists it and
// shows it with its candidate and choices; the reads are listed; the log checks out.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { request, resolveCredential } from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-pending-"));
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
  };

let item = "";

beforeAll(async () => {
  expect((await saveslot("init")).code).toBe(0);
  expect((await saveslot("start")).code).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
  expect(
    (await saveslot("slot", "create", "ledger", "--template", "spending", "--timezone", "UTC"))
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
  const row = a.ops[0]?.target.row as string;
  const ver = a.ops[0]?.ver as string;
  // Two corrections from the same version: the second meets the first, a conflict.
  for (const v of ["54", "60"]) {
    await write({
      sv: 1,
      evidence: [{ kind: "user_message", text: `it was ${v}` }],
      ops: [
        {
          intent: "correct",
          table: "expenses",
          row,
          ver,
          set: { amount: { value: v, unit: "CNY" } },
        },
      ],
    });
  }
  const list = JSON.parse((await saveslot("pending", "--json")).out) as {
    items: { id: string; type: string }[];
  };
  item = list.items.find((i) => i.type === "conflict")?.id as string;
});

afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("saveslot pending", () => {
  it("lists the conflict, how long it has been open", async () => {
    expect(item).toMatch(/^pi_/);
    const r = await saveslot("pending");
    expect(r.code).toBe(0);
    const line = r.out.split("\n").find((l) => l.startsWith(item));
    expect(line).toMatch(/ conflict · ledger\.expenses r_\w+ · stale_write · open 0 min$/);
  });

  it("shows it: in effect, the candidate, before both, the choices", async () => {
    const r = await saveslot("pending", "show", item);
    expect(r.code).toBe(0);
    const lines = r.out.split("\n");
    expect(lines[0]).toMatch(
      new RegExp(`^${item} conflict · ledger\\.expenses r_\\w+ · open · open 0 min · version iv_`),
    );
    expect(lines.some((l) => /^ {2}in effect: .*amount 54 「CNY」/.test(l))).toBe(true);
    expect(
      lines.some((l) => /^ {2}candidate 0: correct .*amount 60 「CNY」.*stale_write\)$/.test(l)),
    ).toBe(true);
    expect(lines.some((l) => /^ {2}before both: .*amount 45 「CNY」/.test(l))).toBe(true);
    expect(lines.some((l) => /^ {2}choices: .*keep_effective/.test(l))).toBe(true);
  });
});

describe("saveslot reads and verify", () => {
  it("reads: the reads made, by the user session", async () => {
    const r = await saveslot("reads", "--since", "1h", "--json");
    expect(r.code).toBe(0);
    const j = JSON.parse(r.out) as { reads: { operation: string }[] };
    expect(j.reads.map((x) => x.operation)).toContain("pending");
  });

  it("verify: the log checks out, exit 0", async () => {
    const r = await saveslot("verify");
    expect(r.code).toBe(0);
    expect(r.out).toMatch(/^\d+ events · chain intact\n/);
    expect(r.out).toContain("no problems found");
  });
});
