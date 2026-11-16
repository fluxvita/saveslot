// The untrusted boundary (docs/zh-CN/spec/05-surfaces.md §5): stored data in a result's text is
// put inside `<untrusted-data-N>…</untrusted-data-N>`, N a 128-bit random number in 32 lowercase
// hex digits, one per result, the same in the opening and closing tag; the content as it is, not
// written as `text.ts` escapes it; when the content holds N, another N is drawn.

import { randomBytes } from "node:crypto";

/** Draws a boundary number: 32 lowercase hex digits. */
export type Draw = () => string;

const draw: Draw = () => randomBytes(16).toString("hex");

/** A number that does not occur in any of `contents`. */
export function boundaryNumber(contents: readonly string[], next: Draw = draw): string {
  // 128 random bits found in the data a hundred times running is no accident.
  for (let i = 0; i < 100; i++) {
    const n = next();
    if (!/^[0-9a-f]{32}$/.test(n)) throw new Error("a boundary number is 32 lowercase hex digits");
    if (!contents.some((c) => c.includes(n))) return n;
  }
  throw new Error("no boundary number is free of the data");
}
