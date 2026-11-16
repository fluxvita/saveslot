// The secret-scanning rules for saveslot tokens (`.gitleaks.toml`), read from the file and run as
// JavaScript regular expressions (the patterns use only what RE2 and JavaScript share): a token
// is found however it is glued to what surrounds it.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { newToken } from "./tokens.ts";

const toml = readFileSync(new URL("../../../.gitleaks.toml", import.meta.url), "utf8");
const rules = [...toml.matchAll(/^regex = '''(.*)'''$/gm)].map((m) => new RegExp(m[1] as string));

describe(".gitleaks.toml", () => {
  it("has one rule for each token prefix", () => {
    expect(rules.map((r) => r.source.slice(0, 4))).toEqual(["slt_", "sls_"]);
  });

  const t = newToken("connection");
  const s = newToken("session");
  it.each([
    ["alone", t],
    ["after an escaped newline in a JSON log", `"auth":"\\n${t}"`],
    ["after an escaped tab", `\\t${s}`],
    ["URL-encoded after a space", `Bearer%20${t}`],
    ["after an environment variable prefix", `SAVESLOT_${t}`],
    ["after letters", `token${t}`],
    ["before an underscore suffix", `${t}_backup`],
    ["before more base64url characters", `${s}AAAA`],
  ])("finds a token %s", (_, text) => {
    expect(rules.some((r) => r.test(text))).toBe(true);
  });

  it("does not find a prefix with too few characters", () => {
    expect(rules.some((r) => r.test(`slt_${"A".repeat(42)}`))).toBe(false);
  });
});
