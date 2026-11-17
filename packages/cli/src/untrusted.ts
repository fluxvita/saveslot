// Untrusted text in the terminal (docs/zh-CN/spec/06-cli.md §6.4): the contract's UntrustedText,
// and every string of a stored value, as the CLI writes it. Two risks: the text rewriting the
// terminal (escape sequences, clearing, bidirectional overrides showing one text as another), and
// an agent with a shell reading the CLI's output and taking instructions in the text for its own.
//
// - Escaped, always, in every mode: what the MCP renderer escapes (below), among it every control
//   (ESC too), the bidirectional marks, overrides and isolates, zero-width characters and U+2028 /
//   U+2029; besides, every space character but U+0020, and U+0020 from the third in a row on (a
//   screenful of spaces would let the terminal's wrapping fake a line of its own). A code point up
//   to U+00FF as `\xNN`, others as `<U+XXXX>`. So that an escaped text reads back to one text only,
//   a backslash is written `\\`, and a `<` that would begin `<U+` or a boundary tag
//   (`<untrusted-data-`, `</untrusted-data-`), or that ends the value (what follows is not the
//   value's to decide), is written `<U+003C>`.
// - The corner brackets 「 and 」 are escaped too (`<U+300C>`, `<U+300D>`), and what compatibility
//   normalization turns into them: in a terminal a value is put between them, and a value holding
//   one would close its own bracket.
// - Terminal: the escaped value between 「 and 」. With colour, the dim on and off sequences go
//   outside the brackets; they are the renderer's own, never from the value (whose ESC is escaped).
// - Not a terminal (piped, or read by an agent), or `--untrusted-tags always`: the escaped value in
//   `<untrusted-data-N>…</untrusted-data-N>`, N 32 lowercase hex digits drawn once per output, the
//   same in every tag of it; the renderer draws again while the output holds N anywhere but in its
//   tags. A value cannot hold a tag of its own: its `<` before `untrusted-data-` or
//   `/untrusted-data-` is escaped.
// - `--untrusted-tags never` with no terminal: the escaped value as it is, for people piping
//   output to their own tools (06 §6.4); `--json` is the way for those.
// - `--json`: JSON with every code point of the set (its context rules as in the text) written as
//   `\uXXXX`, as the MCP renderer writes JSON (05 §5). The value is the same.
// - Cutting counts code points, never splitting a surrogate pair, and is done to the value before it
//   is escaped (an escaped text cut could read back to more than one text): see `cut` in
//   ./render/text.ts.

import { randomBytes } from "node:crypto";

// The set written escaped is the MCP renderer's (05-surfaces §5; server/src/mcp/text.ts), written
// here again (the CLI cannot depend on the server; the two are to be changed together, and a test
// with a table shared through the contract's testing fixtures holds them to one another):
// controls, lone surrogates, default ignorable code points, bidi controls, noncharacters, a few
// others, and what compatibility normalization turns into a character the writing gives a
// meaning to; with its two exceptions (one emoji presentation selector after an emoji, one
// zero-width joiner or non-joiner between characters shown as they are) and its rule for
// combining characters. Added here, the terminal's own: 「 and 」, and the space characters other
// than U+0020.
const PROPERTY =
  /^[\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]$/v;
const MORE = new Set([0x2028, 0x2029, 0xfff9, 0xfffa, 0xfffb, 0xfffc, 0x2800, 0x300c, 0x300d]);
const SPACE = /^\p{White_Space}$/v;
const OTHER_SPACE = /^\p{Zs}$/v;
const EMOJI = /^[\p{Emoji}\p{Extended_Pictographic}]$/v;
const COMBINING = /^[\p{M}\p{Emoji_Modifier}]$/v;
const KEYCAP = 0x20e3;
/** What the writing gives a meaning to: the escape, `<U+…>` and tags, the corner brackets. */
const SYNTAX = /[\\<「」]/;

const cpOf = (c: string | undefined) => c?.codePointAt(0) ?? -1;

/** Whether a character is of the set written escaped, its context aside. */
export function inEscapedSet(c: string): boolean {
  return (
    PROPERTY.test(c) ||
    MORE.has(cpOf(c)) ||
    (OTHER_SPACE.test(c) && c !== " ") ||
    (!SYNTAX.test(c) && SYNTAX.test(c.normalize("NFKC")))
  );
}

/** A base an emoji presentation selector may follow (as in the MCP renderer). */
function emojiBase(cs: readonly string[], j: number): boolean {
  const c = cs[j];
  if (c === undefined || inEscapedSet(c) || !EMOJI.test(c)) return false;
  return cpOf(c) >= 0x80 || cpOf(cs[j + 2]) === KEYCAP;
}

/**
 * Which code points of `cs` are written escaped (as in the MCP renderer, see there). `short`: the
 * characters the writing escapes in a form of its own (a combining character after one of them is
 * escaped too).
 */
export function escapes(cs: readonly string[], short: (c: string) => boolean): boolean[] {
  const out = cs.map((c) => inEscapedSet(c));
  const kept = cs.map((c, i) => (cpOf(c) === 0xfe0e || cpOf(c) === 0xfe0f) && emojiBase(cs, i - 1));
  const neighbour = (j: number) => {
    const c = cs[j];
    return c !== undefined && ((!inEscapedSet(c) && !SPACE.test(c)) || kept[j] === true);
  };
  cs.forEach((c, i) => {
    if (kept[i]) out[i] = false;
    const p = cpOf(c);
    if ((p === 0x200c || p === 0x200d) && neighbour(i - 1) && neighbour(i + 1)) out[i] = false;
  });
  cs.forEach((c, i) => {
    if (out[i] || !COMBINING.test(c)) return;
    const before = cs[i - 1];
    if (before === undefined || out[i - 1] === true || short(before)) out[i] = true;
  });
  return out;
}

const BACKSLASH = String.fromCodePoint(0x5c);

/** One character as written escaped. */
function escapeChar(c: string): string {
  const cp = c.codePointAt(0) as number;
  return cp <= 0xff
    ? `${BACKSLASH}x${cp.toString(16).padStart(2, "0")}`
    : `<U+${cp.toString(16).toUpperCase().padStart(4, "0")}>`;
}

/** Whether a `<` at `i` would read as the start of an escape or a tag, or ends the value. */
function lessThanEscaped(cs: readonly string[], i: number): boolean {
  if (i === cs.length - 1) return true;
  return /^(?:U\+|\/?untrusted-data-)/.test(cs.slice(i + 1, i + 17).join(""));
}

/** `s` with what may act on a terminal, or forge the output's own marks, written escaped. */
export function escapeUntrusted(s: string): string {
  const cs = Array.from(s);
  const e = escapes(cs, (c) => c === BACKSLASH);
  let out = "";
  let spaces = 0;
  cs.forEach((c, i) => {
    spaces = c === " " ? spaces + 1 : 0;
    if (c === BACKSLASH) out += BACKSLASH + BACKSLASH;
    else if (c === "<" && lessThanEscaped(cs, i)) out += "<U+003C>";
    else if (c === " " && spaces >= 3) out += escapeChar(c);
    else out += e[i] ? escapeChar(c) : c;
  });
  return out;
}

/** The text `escapeUntrusted` was given (for tests: an escaped text reads back to one text). */
export function unescapeUntrusted(w: string): string {
  const pattern = new RegExp(
    `${BACKSLASH}${BACKSLASH}${BACKSLASH}${BACKSLASH}|${BACKSLASH}${BACKSLASH}x([0-9a-f]{2})|<U${BACKSLASH}+([0-9A-F]{4,6})>`,
    "g",
  );
  return w.replace(pattern, (m, x?: string, u?: string) => {
    if (m === BACKSLASH + BACKSLASH) return BACKSLASH;
    return String.fromCodePoint(Number.parseInt((x ?? u) as string, 16));
  });
}

/**
 * `s` cut to at most `max` code points, and whether it was cut; `max` a whole number from 0. On
 * the value, before it is escaped.
 */
export function cutCodePoints(s: string, max: number): { text: string; cut: boolean } {
  if (!Number.isInteger(max) || max < 0) throw new RangeError("max is a whole number from 0");
  let n = 0;
  for (let i = 0; i < s.length; ) {
    if (n === max) return { text: s.slice(0, i), cut: true };
    i += (s.codePointAt(i) as number) > 0xffff ? 2 : 1;
    n++;
  }
  return { text: s, cut: false };
}

/** How untrusted values are written in one output. */
export type UntrustedMode =
  | { readonly kind: "terminal"; readonly color: boolean }
  | { readonly kind: "tagged"; readonly n: string }
  | { readonly kind: "plain" };

/** A boundary number: 32 lowercase hex digits. */
export type Draw = () => string;
export const drawNumber: Draw = () => randomBytes(16).toString("hex");
const NUMBER = /^[0-9a-f]{32}$/;

const DIM = `${String.fromCodePoint(0x1b)}[2m`;
const UNDIM = `${String.fromCodePoint(0x1b)}[22m`;

/** An already escaped value as written in `mode`. */
export function wrapEscaped(escaped: string, mode: UntrustedMode): string {
  switch (mode.kind) {
    case "terminal":
      return mode.color ? `${DIM}「${escaped}」${UNDIM}` : `「${escaped}」`;
    case "tagged":
      if (!NUMBER.test(mode.n)) throw new Error("a boundary number is 32 lowercase hex digits");
      return `<untrusted-data-${mode.n}>${escaped}</untrusted-data-${mode.n}>`;
    case "plain":
      return escaped;
  }
}

/** A value that is not JSON: `--json` writes only what JSON can hold. */
export class NotJson extends Error {
  override readonly name = "NotJson";
}

/** A JSON string with the code points `escapes` decides on written as `\uXXXX`. */
function jsonString(s: string): string {
  const cs = Array.from(s);
  const e = escapes(cs, (c) => c === '"' || c === BACKSLASH);
  const body = cs
    .map((c, i) => {
      if (e[i]) {
        return Array.from({ length: c.length }, (_, k) => c.charCodeAt(k))
          .map((u) => `${BACKSLASH}u${u.toString(16).padStart(4, "0")}`)
          .join("");
      }
      return c === '"' ? `${BACKSLASH}"` : c === BACKSLASH ? BACKSLASH + BACKSLASH : c;
    })
    .join("");
  return `"${body}"`;
}

/** `v` as JSON for `--json`, the set written as `\uXXXX` (05 §5); plain JSON values only. */
export function jsonText(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new NotJson("a number JSON cannot hold");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return jsonString(v);
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new NotJson("not a plain array");
    const out: string[] = [];
    // A hole reads as undefined, which is no JSON value.
    for (let i = 0; i < v.length; i++) out.push(jsonText(v[i]));
    return `[${out.join(",")}]`;
  }
  const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
  if (typeof v === "object" && (proto === Object.prototype || proto === null)) {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{${entries.map(([k, x]) => `${jsonString(k)}:${jsonText(x)}`).join(",")}}`;
  }
  throw new NotJson(`${typeof v} is no JSON value`);
}
