// The MCP adapter's own source files hold none of the characters a result's text escapes
// (05-surfaces §5): those characters are built from code points where they are needed, so that
// none sits unseen in the code that decides what the boundary is.

import { readdirSync, readFileSync } from "node:fs";
import { expect, it } from "vitest";

const HIDDEN = new Set<number>([
  ...Array.from({ length: 0x20 }, (_, i) => i).filter((i) => i !== 0x09 && i !== 0x0a),
  ...Array.from({ length: 0xa0 - 0x7f }, (_, i) => 0x7f + i),
  0x061c,
  0x200b,
  0x200e,
  0x200f,
  0x2028,
  0x2029,
  0x202a,
  0x202b,
  0x202c,
  0x202d,
  0x202e,
  0x2060,
  0x2066,
  0x2067,
  0x2068,
  0x2069,
  0xfeff,
  0xfff9,
  0xfffa,
  0xfffb,
  ...Array.from({ length: 0x80 }, (_, i) => 0xe0000 + i),
]);

it("no source file of the MCP adapter holds a character the text escapes", () => {
  const dir = new URL("./", import.meta.url);
  const files = readdirSync(dir).filter((f) => f.endsWith(".ts"));
  expect(files.length).toBeGreaterThan(5);
  for (const f of files) {
    const text = readFileSync(new URL(f, dir), "utf8");
    const found = [...text]
      .map((c) => c.codePointAt(0) ?? 0)
      .filter((p) => HIDDEN.has(p) || (p >= 0xd800 && p <= 0xdfff))
      .map((p) => p.toString(16));
    expect({ file: f, found }).toEqual({ file: f, found: [] });
  }
});
