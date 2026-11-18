// A write refused by the judgement, as the real service answers it and as the command line says it
// (04-contract-types §9, 06-cli §6.3): `validation_failed` with reason `write`, a detail for each
// stretch where a required field has no value, its op, table, field and stretch.

import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  ContractCallError,
  describeError,
  render,
  request,
  resolveCredential,
} from "@fluxvita/saveslot-cli/testing";
import { type CommandIO, serviceCommand, socketFile } from "@fluxvita/saveslot-daemon";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { dispatch } from "./dispatch.ts";

vi.setConfig({ testTimeout: 120_000, hookTimeout: 180_000 });

const root = mkdtempSync(join(tmpdir(), "saveslot-refusal-"));
const home = join(root, "home");
const quiet: CommandIO = { out: () => {}, err: () => {} };
let token = "";

const saveslot = (...argv: string[]) =>
  dispatch(
    [...argv, "--home", home],
    { NO_COLOR: "1" },
    {
      out: () => {},
      err: () => {},
      stdoutIsTTY: false,
      stderrIsTTY: false,
    },
  );

const write = (body: unknown) =>
  request({ socketPath: socketFile(home), method: "POST", path: "/v1/writes", token, body });

/** The refusal of a write, as the command line writes it on a terminal without colour. */
async function refusal(body: unknown): Promise<{ error: ContractCallError; text: string }> {
  const e = await write(body).then(
    () => undefined,
    (x: unknown) => x,
  );
  expect(e).toBeInstanceOf(ContractCallError);
  const error = e as ContractCallError;
  return { error, text: render(describeError(error).lines, { kind: "terminal", color: false }) };
}

let entity = "";
let ver = "";

beforeAll(async () => {
  expect(await saveslot("init")).toBe(0);
  expect(await saveslot("start")).toBe(0);
  token = (await resolveCredential({ home, env: {} })).token;
  expect(
    await saveslot("slot", "create", "plan", "--template", "budget", "--timezone", "UTC"),
  ).toBe(0);
  const r = (await write({
    sv: 1,
    evidence: [{ kind: "user_message", text: "food 100 for the first two days" }],
    ops: [
      {
        // A table with an entity key is written to by its key (04-contract §write).
        intent: "update",
        table: "budgets",
        entity_key: { category: "food" },
        valid_from: "2026-11-01",
        valid_to: "2026-11-03",
        set: { amount: { value: "100", unit: "CNY" } },
      },
    ],
  }).catch((e: unknown) => {
    throw new Error(JSON.stringify((e as ContractCallError).body));
  })) as { ops: { target: { entity: string }; ver: string }[] };
  entity = r.ops[0]?.target.entity as string;
  ver = r.ops[0]?.ver as string;
});
afterAll(async () => {
  await serviceCommand("stop", ["--home", home], quiet);
  rmSync(root, { recursive: true, force: true });
});

describe("validation_failed from the judgement of a write", () => {
  it("one stretch without the required field: op, table, field and the stretch, inclusive", async () => {
    const { error, text } = await refusal({
      sv: 1,
      evidence: [{ kind: "user_message", text: "food again" }],
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          ver,
          valid_from: "2026-11-05",
          valid_to: "2026-11-07",
          set: { category: "food" },
        },
      ],
    });
    expect(error.code).toBe("validation_failed");
    expect(error.body["reason"]).toBe("write");
    expect(text).toContain("error validation_failed (「write」)");
    expect(text).toContain(
      "  required_in_gap  at op 0, table 「plan.budgets」, field 「amount」, valid 「2026-11-05」 to 「2026-11-06」 (inclusive)",
    );
    expect(describeError(error).exit).toBe(5);
  });

  it("a stretch before the entity and one after it: a line each", async () => {
    const { text } = await refusal({
      sv: 1,
      evidence: [{ kind: "user_message", text: "food again" }],
      ops: [
        {
          intent: "update",
          table: "budgets",
          entity,
          ver,
          valid_from: "2026-10-30",
          valid_to: "2026-11-05",
          set: { category: "food" },
        },
      ],
    });
    const lines = text.split("\n").filter((l) => l.includes("required_in_gap"));
    expect(lines).toEqual([
      "  required_in_gap  at op 0, table 「plan.budgets」, field 「amount」, valid 「2026-10-30」 to 「2026-10-31」 (inclusive)",
      "  required_in_gap  at op 0, table 「plan.budgets」, field 「amount」, valid 「2026-11-03」 to 「2026-11-04」 (inclusive)",
    ]);
  });
});
