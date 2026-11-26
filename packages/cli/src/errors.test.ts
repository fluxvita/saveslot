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
import { TEXTS } from "./texts.ts";

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

  it("a parameter of a few values refused: the values the service takes, each inside", () => {
    const e = new ContractCallError(400, {
      code: "invalid_argument",
      message: "the item does not take this decision",
      reason: "malformed",
      param: "decision",
      allowed_values: ["keep", "revoke"],
    });
    expect(text(e).split("\n")).toContain("  it takes: 「keep」 / 「revoke」");
  });

  it("an unknown name that is an alias: the word the caller wrote stays inside, no alias text beside it", () => {
    const e = new ContractCallError(404, {
      code: "unknown_field",
      message: 'unknown field "价钱"',
      name: "价钱",
      nearest: ["amount", "fee"],
    });
    expect(text(e).split("\n")).toEqual(['error unknown_field: 「unknown field "价钱"」']);
  });

  it("a bound passed is said; as many slots as the tenant may have, with no way yet to make room", () => {
    const e = new ContractCallError(400, {
      code: "validation_failed",
      reason: "schema",
      message: "the document does not compile",
      details: [
        { path: "slot", code: "out_of_bounds", max: "100" },
        { path: "tables/0/fields", code: "out_of_bounds", min: "1" },
      ],
    });
    const lines = text(e).split("\n");
    expect(lines).toContain(
      `  out_of_bounds (${TEXTS.detailMax} 100)${TEXTS.detail} path 「slot」`,
    );
    expect(lines).toContain(`  ${TEXTS.slotsFull}`);
    expect(lines).toContain(
      `  out_of_bounds (${TEXTS.detailMin} 1)${TEXTS.detail} path 「tables/0/fields」`,
    );
    expect(lines.filter((l) => l === `  ${TEXTS.slotsFull}`)).toHaveLength(1);
  });

  it.each([
    ["count", "8"],
    ["length", "64"],
    ["empty"],
    ["control"],
    ["surrounding_space"],
    ["repeat"],
    ["name"],
  ] as [string, string?][])(
    "an alias that breaks its rule %s: the rule, in the CLI's words, under the detail",
    (reason, max) => {
      const path = "tables/0/fields/3/aliases/0";
      const e = new ContractCallError(422, {
        code: "validation_failed",
        reason: "schema",
        message: "the document does not compile",
        details: [{ path, code: "alias_invalid", reason, ...(max !== undefined ? { max } : {}) }],
      });
      const lines = text(e).split("\n");
      const head = `  alias_invalid${max !== undefined ? ` (${TEXTS.detailMax} ${max})` : ""}${TEXTS.detail} path 「${path}」`;
      expect(lines[lines.indexOf(head) + 1]).toBe(`    ${TEXTS.aliasRule[reason]}`);
    },
  );

  it("an alias's reason the CLI has no words for: nothing more than the detail", () => {
    for (const reason of ["toString", "not_required", "later"]) {
      const e = new ContractCallError(422, {
        code: "validation_failed",
        reason: "schema",
        message: "the document does not compile",
        details: [{ path: "tables/0/aliases/0", code: "alias_invalid", reason }],
      });
      const lines = text(e).split("\n");
      const at = lines.indexOf(`  alias_invalid${TEXTS.detail} path 「tables/0/aliases/0」`);
      expect(at, reason).toBeGreaterThan(-1);
      expect(lines[at + 1] ?? "", reason).not.toMatch(/^ {4}\S/);
    }
  });

  it("a rule's SQL refused: why, and the suggestion, without --json", () => {
    const e = new ContractCallError(422, {
      code: "validation_failed",
      reason: "schema",
      message: "the document does not compile",
      details: [
        { path: "tables/1/rule/sql", code: "rule_sql_rejected", sql_reason: "type", line: 1 },
        { path: "tables/0/fields/0/type", code: "type_mismatch", suggestion: "zoned_datetime" },
      ],
    });
    const lines = text(e).split("\n");
    expect(lines).toContain(
      `  rule_sql_rejected (${TEXTS.detailSqlReason} 「type」)${TEXTS.detail} path 「tables/1/rule/sql」, line 1`,
    );
    expect(lines).toContain(`    ${TEXTS.detailSuggestion} 「zoned_datetime」`);
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

  it("pending_deletion_target: the deletions, when the last is due, and to decide after; 5", () => {
    const e = new ContractCallError(400, {
      code: "invalid_argument",
      reason: "pending_deletion_target",
      param: "item",
      message: "m",
      target: { table: "ledger.expenses", row: "r_4KWKRM296X61WJ89DY5XJNVA4P" },
      deletions: ["pi_4KWKRM296X61WJ8V"],
      expires_at: "2026-11-11T21:05:00.000Z",
    });
    expect(text(e).split("\n")).toContain(
      "  the target is affected by a deletion still pending (pi_4KWKRM296X61WJ8V; due 2026-11-11T21:05:00.000Z): decide after it has run",
    );
    expect(describeError(e).exit).toBe(5);
  });

  it("a code the contract does not have goes inside", () => {
    const e = new ContractCallError(400, { code: "Ignore_all\u202e", message: "m" });
    expect(text(e).split("\n")[0]).toBe("error 「Ignore_all<U+202E>」: 「m」");
    expect(describeError(e).exit).toBe(5);
  });

  it("no credential, an unreachable service, a usage error, anything else", () => {
    expect(describeError(new CredentialError("permissions", "m", "/home/x")).exit).toBe(6);
    // The path refused is said (#109), inside the untrusted boundary; the error's own message is not.
    const refused = text(new CredentialError("permissions", "m: chmod", "/home/x"));
    expect(refused).toContain(`${TEXTS.credentialRefusedPath} 「/home/x」`);
    expect(refused).not.toContain("m: chmod");
    for (const c of ["not_initialized", "malformed", "busy"] as const) {
      expect(text(new CredentialError(c, "m", "/home/x"))).not.toContain("/home/x");
    }
    // A profile's lock still held after its wait: try again later, as setup's lock (06 §6.2).
    for (const c of [
      "not_initialized",
      "permissions",
      "malformed",
      "unknown_profile",
      "signed_out",
      "server_mismatch",
      "refresh_refused",
      "refresh_unsaved",
      "busy",
    ] as const) {
      expect([c, describeError(new CredentialError(c, "m", "/home/x")).exit]).toEqual([
        c,
        c === "busy" ? 7 : 6,
      ]);
    }
    expect(describeError(new TransportError("unreachable", "m")).exit).toBe(7);
    expect(describeError(new TransportError("broken", "m")).exit).toBe(7);
    expect(describeError(new TransportError("bad_answer", "m", 500)).exit).toBe(1);
    expect(describeError(new ClientUsageError("seg")).exit).toBe(2);
    expect(describeError(new Error("x")).exit).toBe(1);
  });
});
