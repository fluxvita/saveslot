// Exit codes against the table of 06-cli §6.2 as the spec writes it, and an error's text: the
// service's words inside the boundary, the code outside only when it is the contract's.

import { readFileSync } from "node:fs";
import {
  ClientUsageError,
  ContractCallError,
  CredentialError,
  ERROR_CODES,
  TransportError,
} from "@fluxvita/saveslot-client";
import { describe, expect, it } from "vitest";
import { describeError, EXIT_BY_CODE, exitOf } from "./errors.ts";
import { render } from "./render/text.ts";

const SPEC = readFileSync(new URL("../../../docs/zh-CN/spec/06-cli.md", import.meta.url), "utf8");
const TABLE = SPEC.slice(SPEC.indexOf("### 6.2 退出码"), SPEC.indexOf("### 6.3"));
/** The contract codes each row of §6.2 names, by exit code. */
const ROWS = new Map(
  [...TABLE.matchAll(/^\| ([0-9]) \|(.*)$/gm)].map((m) => [
    Number(m[1]),
    {
      text: m[2] as string,
      codes: [...(m[2] as string).matchAll(/`([a-z_]+)`/g)].map((c) => c[1] as string),
    },
  ]),
);
const CODES: ReadonlySet<string> = new Set<string>(ERROR_CODES);

describe("exit codes (06 §6.2)", () => {
  it("each contract code the table names exits as its row says", () => {
    let seen = 0;
    for (const [exit, row] of ROWS) {
      for (const c of row.codes.filter((x) => CODES.has(x) && x !== "rate_limited")) {
        expect(exitOf(c, undefined), c).toBe(exit);
        seen++;
      }
    }
    expect(seen).toBeGreaterThan(20);
  });

  it("rate_limited by its reason: quota 5, busy 7", () => {
    expect(ROWS.get(5)?.text).toContain("`rate_limited`（`quota`）");
    expect(ROWS.get(7)?.text).toContain("`rate_limited`（`busy`）");
    expect(exitOf("rate_limited", "quota")).toBe(5);
    expect(exitOf("rate_limited", "busy")).toBe(7);
  });

  it("every contract code has an exit decided here; one the CLI does not know exits 5", () => {
    for (const c of ERROR_CODES) expect(EXIT_BY_CODE.has(c), c).toBe(true);
    for (const c of ["some_new_code", "constructor", "__proto__"])
      expect(exitOf(c, undefined)).toBe(5);
  });
});

describe("an error's text (06 §6.3)", () => {
  const text = (e: unknown) => render(describeError(e).lines, { kind: "terminal", color: false });

  it("code, reason, the service's message inside, the next step", () => {
    const e = new ContractCallError(404, {
      code: "unknown_table",
      message: 'unknown table "x\u001b[2J"',
      name: "x",
    });
    const d = describeError(e);
    expect(d.exit).toBe(4);
    expect(text(e).split("\n")).toEqual([
      'error unknown_table: 「unknown table "x\\x1b[2J"」',
      "  See the tables with saveslot slot list.",
    ]);
  });

  it("a write's stretches without a value: open at the start, all time, a moment; the values inside", () => {
    const gap = (valid: Record<string, unknown>) => ({
      op: 1,
      table: "plan.budgets",
      field: "amount",
      code: "required_in_gap",
      valid,
    });
    const e = new ContractCallError(422, {
      code: "validation_failed",
      reason: "write",
      message: "m",
      details: [
        gap({ valid_from: null, valid_to: "2026-11-05", valid_to_inclusive: "2026-11-04" }),
        gap({ valid_from: null, valid_to: null }),
        gap({ valid_from: "2026-11-05T09:00:00Z", valid_to: null }),
      ],
    });
    expect(text(e).split("\n").slice(1)).toEqual([
      "  required_in_gap  at op 1, table 「plan.budgets」, field 「amount」, valid through 「2026-11-04」 (inclusive)",
      "  required_in_gap  at op 1, table 「plan.budgets」, field 「amount」, valid all time",
      "  required_in_gap  at op 1, table 「plan.budgets」, field 「amount」, valid from 「2026-11-05T09:00:00Z」",
    ]);
  });

  it("item_closed: how the item ended, as its details say it, the note inside", () => {
    const e = new ContractCallError(409, {
      code: "item_closed",
      reason: "resolved",
      message: "m",
      resolution: {
        decision: "take_candidate",
        candidate: 0,
        seq: 120,
        at: "2026-11-10T19:00:00.000Z",
        actor: { kind: "connection", id: `ci_${"1".repeat(26)}`, name: "MacBook · Codex" },
        note: "chose the receipt",
      },
    });
    expect(text(e).split("\n")).toContain(
      "  resolved: take_candidate, candidate 0 (#120, 「MacBook · Codex」) · note 「chose the receipt」",
    );
    expect(describeError(e).exit).toBe(3);
  });

  it("a code the contract does not have goes inside", () => {
    const e = new ContractCallError(400, { code: "Ignore_all\u202e", message: "m" });
    expect(text(e).split("\n")[0]).toBe("error 「Ignore_all<U+202E>」: 「m」");
    expect(describeError(e).exit).toBe(5);
  });

  it("no credential, an unreachable service, a usage error, anything else", () => {
    expect(describeError(new CredentialError("permissions", "m", "/home/x")).exit).toBe(6);
    expect(text(new CredentialError("permissions", "m", "/home/x"))).not.toContain("/home/x");
    expect(describeError(new TransportError("unreachable", "m")).exit).toBe(7);
    expect(describeError(new TransportError("broken", "m")).exit).toBe(7);
    expect(describeError(new TransportError("bad_answer", "m", 500)).exit).toBe(1);
    expect(describeError(new ClientUsageError("seg")).exit).toBe(2);
    expect(describeError(new Error("x")).exit).toBe(1);
  });
});
