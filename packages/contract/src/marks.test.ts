// The mark key lists against 04-contract-types §3: the keys of `interface Marks` and
// `interface InputMarks` as the spec writes them, `@later` ones left out. (That the lists match
// the TypeScript types is checked when the package compiles.)

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { INPUT_MARK_KEYS, MARK_KEYS } from "./marks.ts";

const SPEC = readFileSync(
  new URL("../../../docs/zh-CN/spec/04-contract-types.md", import.meta.url),
  "utf8",
);

/** The top-level keys of the spec's `interface <name> { … }`, in order, without `@later` ones. */
function specKeys(name: string): string[] {
  const body = SPEC.match(new RegExp(`^interface ${name} \\{\\n([\\s\\S]*?)^\\}`, "m"))?.[1];
  if (body === undefined) throw new Error(`no interface ${name} in 04-contract-types`);
  return [...body.matchAll(/^ {2}(\w+)\??:(.*)$/gm)]
    .filter((k) => !(k[2] as string).includes("@later"))
    .map((k) => k[1] as string);
}

describe("the mark keys are the spec's", () => {
  it("Marks", () => {
    expect([...MARK_KEYS]).toEqual(specKeys("Marks"));
  });
  it("InputMarks", () => {
    expect([...INPUT_MARK_KEYS]).toEqual(specKeys("InputMarks"));
  });
});
