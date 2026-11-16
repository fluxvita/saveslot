// The untrusted boundary (docs/zh-CN/spec/05-surfaces.md §5): stored data in a result's text is
// put inside `<untrusted-data-N>…</untrusted-data-N>`, N a 128-bit random number in 32 lowercase
// hex digits, one per result, the same in the opening and closing tag; the content as it is, not
// escaped; when the content holds N, another N is drawn. A result with such content starts with a
// fixed line. Nothing is nested: content already inside a boundary is not wrapped again.

import { randomBytes } from "node:crypto";
import { UNTRUSTED_NOTICE } from "./texts.ts";

/** Draws a boundary number: 32 lowercase hex digits. */
export type Draw = () => string;

const draw: Draw = () => randomBytes(16).toString("hex");

/** A number that does not occur in any of `contents`. */
export function boundaryNumber(contents: readonly string[], next: Draw = draw): string {
  for (;;) {
    const n = next();
    if (!/^[0-9a-f]{32}$/.test(n)) throw new Error("a boundary number is 32 lowercase hex digits");
    if (!contents.some((c) => c.includes(n))) return n;
  }
}

/** `content` inside one boundary, after the fixed first line (05 §5, the whole-JSON form). */
export function wrapWhole(content: string, next: Draw = draw): string {
  const n = boundaryNumber([content], next);
  return `${UNTRUSTED_NOTICE}\n<untrusted-data-${n}>${content}</untrusted-data-${n}>`;
}
