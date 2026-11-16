// How a result becomes the text a model reads (docs/zh-CN/spec/05-surfaces.md §4.1, §5).
//
// A result's text is made of parts made here, and of nothing else:
//   - static: saveslot's own wording, written with the `t` tag;
//   - a value of a checked shape, outside the boundary: an ID, a name, a number, a date or a
//     moment, a code of the contract's; each made by its own function, which takes a string only
//     and throws when it is not of that shape;
//   - untrusted: every other string (UntrustedText, the names of connection instances, enum
//     values written by a schema's author, messages), escaped and inside the boundary.
// A part is registered when it is made, keeps its kind and text in private fields and is frozen;
// `t`, `join` and `render` take registered parts only, and `render` reads each part once before it
// checks and joins them. So a part cannot be forged or changed from outside this module, and a
// string cannot reach the text except as one of the shapes or as untrusted.
//
// Known limit: `t` tells a template call by its strings being frozen with their raw form; code
// that builds such an array by hand gets static text through. Only code of the adapter can do
// that: no string of a result reaches `t` but as a part.
//
// Escaping (05 §5): which code points of a string are written as escapes is decided once, on the
// string itself (`escapes`); the text writes them as `\u{XXXX}` (with `\\`, `\n`, `\t`, `\|` for
// those four), JSON as written as `\uXXXX`. Every backslash in the text starts an escape, and
// `unescapeText` undoes exactly what `escapeText` writes.

import { boundaryNumber, type Draw } from "./boundary.ts";
import { UNTRUSTED_NOTICE } from "./texts.ts";

type Kind = "static" | "value" | "untrusted";

/** A part of a result's text. Made only here, and not changed once made. */
class Piece {
  readonly #kind: Kind;
  readonly #text: string;
  constructor(kind: Kind, text: string) {
    this.#kind = kind;
    this.#text = text;
    Object.freeze(this);
  }
  get kind(): Kind {
    return this.#kind;
  }
  get text(): string {
    return this.#text;
  }
  static is(x: unknown): x is Piece {
    return typeof x === "object" && x !== null && #kind in x && MADE.has(x as Piece);
  }
}

/** Every part made here. */
const MADE = new WeakSet<Piece>();

const make = (kind: Kind, text: string): Piece => {
  const p = new Piece(kind, text);
  MADE.add(p);
  return p;
};

const mustString = (v: unknown): string => {
  if (typeof v !== "string") throw new Error("a part is made of a string");
  return v;
};

export type Part = Piece;

/** One line of a result's text. */
export type Line = readonly Part[];

/** UntrustedText, and any string not of a checked shape: escaped, inside the boundary. */
export const untrusted = (text: string): Part => make("untrusted", mustString(text));

const CROCKFORD = "[0-9A-HJKMNP-TV-Z]";
const SEQ = "[1-9][0-9]{0,15}";
const RESTORES = "(?:0|[1-9][0-9]{0,8})";

/** The shapes a value outside the boundary may have. */
const SHAPES = {
  // IDs as the kernel writes them; versions; item versions.
  id: new RegExp(
    `^(?:(?:tn|u|ci|r|e)_${CROCKFORD}{26}|(?:sl|s|pi|d|rd)_${CROCKFORD}{16}|[vh]${SEQ}\\.${RESTORES}|iv_${CROCKFORD}{16}\\.${SEQ}\\.${RESTORES})$`,
  ),
  // A paging handle as the service signs it.
  handle: /^cur_[A-Za-z0-9_-]{1,1024}\.[A-Za-z0-9_-]{43}$/,
  // Slot, table and field names of this version.
  name: /^[A-Za-z][A-Za-z0-9_]{0,63}$/,
  // Canonical decimal text.
  number: /^-?(?:0|[1-9][0-9]{0,30})(?:\.[0-9]{0,29}[1-9])?$/,
  // A code of the contract's (and from the set allowed where it is made).
  code: /^[a-z][a-z0-9_.]{0,63}$/,
} as const;

/** The time zones a moment may name: the runtime's, and UTC. */
const ZONES = new Set<string>([...Intl.supportedValuesOf("timeZone"), "UTC"]);

const MOMENT =
  /^([0-9]{4})-([0-9]{2})-([0-9]{2})(?:T([0-9]{2}):([0-9]{2})(?::([0-9]{2})(?:\.[0-9]{1,9})?)?(Z|[+-]([0-9]{2}):([0-9]{2}))(?:\[([A-Za-z0-9_/+-]{1,64})\])?)?$/;

/** A date, or a moment (RFC 3339, with a zone name as RFC 9557 when there is one), in range. */
function isTime(v: string): boolean {
  const m = MOMENT.exec(v);
  if (m === null) return false;
  const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
  const day = new Date(Date.UTC(y, mo - 1, d));
  if (day.getUTCFullYear() !== y || day.getUTCMonth() !== mo - 1 || day.getUTCDate() !== d) {
    return false;
  }
  if (m[4] === undefined) return true;
  const within = (x: string | undefined, max: number) => x === undefined || Number(x) <= max;
  return (
    within(m[4], 23) &&
    within(m[5], 59) &&
    within(m[6], 60) &&
    within(m[8], 23) &&
    within(m[9], 59) &&
    (m[10] === undefined || ZONES.has(m[10]))
  );
}

const isShaped = (v: string) =>
  SHAPES.id.test(v) ||
  SHAPES.handle.test(v) ||
  SHAPES.name.test(v) ||
  SHAPES.number.test(v) ||
  SHAPES.code.test(v) ||
  isTime(v);

function shaped(ok: boolean, what: string, v: string): Part {
  if (!ok) throw new Error(`not of the shape of ${what}`);
  return make("value", v);
}

/** The next page's handle the service just signed; never one a caller sent. */
export const handle = (v: string): Part =>
  shaped(SHAPES.handle.test(mustString(v)), "a paging handle", v);

/** An ID or a version token, as the service writes it; never one a caller sent. */
export const id = (v: string): Part => shaped(SHAPES.id.test(mustString(v)), "an ID", v);
/** A slot, table or field name. */
export const name = (v: string): Part => shaped(SHAPES.name.test(mustString(v)), "a name", v);
/** A number: canonical decimal text, or a safe integer. */
export const num = (v: string | number): Part => {
  if (typeof v === "number") {
    if (!Number.isSafeInteger(v)) throw new Error("not a safe integer");
    return make("value", String(v));
  }
  return shaped(SHAPES.number.test(mustString(v)), "a number", v);
};
/** A date or a moment. */
export const time = (v: string): Part => shaped(isTime(mustString(v)), "a moment", v);
/**
 * A code of the contract's, from `allowed`: a constant set in the source where it is made, never
 * one built from a result.
 */
export const code = (v: string, allowed: ReadonlySet<string>): Part =>
  shaped(allowed.has(mustString(v)) && SHAPES.code.test(v), "an allowed code", v);

/** A template call: frozen strings with their raw form. */
const isTemplate = (x: unknown): x is TemplateStringsArray =>
  Array.isArray(x) &&
  Object.isFrozen(x) &&
  Array.isArray((x as { raw?: unknown }).raw) &&
  x.every((s) => typeof s === "string");

const flat = (p: unknown): Piece[] => {
  const xs = Array.isArray(p) ? p : [p];
  for (const x of xs) if (!Piece.is(x)) throw new Error("only parts go into a result's text");
  return xs as Piece[];
};

/** saveslot's wording, with parts in it: `t\`${num(n)} rows\``. */
export function t(strings: TemplateStringsArray, ...parts: readonly (Part | Line)[]): Part[] {
  if (!isTemplate(strings)) throw new Error("t takes a template only");
  const out: Part[] = [];
  strings.forEach((s, i) => {
    if (s !== "") out.push(make("static", s));
    if (i < parts.length) out.push(...flat(parts[i]));
  });
  return out;
}

/** Parts joined with `sep`, itself a part (`t\`, \``). */
export function join(parts: readonly (Part | Line)[], sep: Part | Line): Part[] {
  const s = flat(sep);
  const out: Part[] = [];
  parts.forEach((p, i) => {
    if (i > 0) out.push(...s);
    out.push(...flat(p));
  });
  return out;
}

// The set written as escapes (05 §5): controls, lone surrogates, default ignorable code points,
// bidi controls, noncharacters, and a few that are none of these.
const PROPERTY =
  /^[\p{Cc}\p{Cs}\p{Default_Ignorable_Code_Point}\p{Bidi_Control}\p{Noncharacter_Code_Point}]$/v;
const MORE = new Set([0x2028, 0x2029, 0xfff9, 0xfffa, 0xfffb, 0xfffc, 0x2800]);
const SPACE = /^\p{White_Space}$/v;
const EMOJI = /^[\p{Emoji}\p{Extended_Pictographic}]$/v;
const COMBINING = /^[\p{M}\p{Emoji_Modifier}]$/v;
const KEYCAP = 0x20e3;

const cpOf = (c: string | undefined) => c?.codePointAt(0) ?? -1;

/** What the writing gives a meaning to: the escape, the quote of JSON, the cell separator. */
const SYNTAX = /[\\"|]/;

/**
 * Whether a character is of the set written as escapes, its context aside. With the set by
 * property: the characters a compatibility normalization (NFKC) turns into a backslash, a quote
 * or a vertical bar, so that a host normalizing the text cannot make one where the writing put
 * none (an escape that is none, a JSON string that ends, a cell that splits).
 */
export function inEscapedSet(c: string): boolean {
  return (
    PROPERTY.test(c) || MORE.has(cpOf(c)) || (!SYNTAX.test(c) && SYNTAX.test(c.normalize("NFKC")))
  );
}

/**
 * A base an emoji presentation selector may follow: an emoji character not of the set; one that
 * is ASCII (a digit, `#`, `*`) only in a keycap sequence (selector, then U+20E3).
 */
function emojiBase(cs: readonly string[], j: number): boolean {
  const c = cs[j];
  if (c === undefined || inEscapedSet(c) || !EMOJI.test(c)) return false;
  return cpOf(c) >= 0x80 || cpOf(cs[j + 2]) === KEYCAP;
}

/**
 * Which code points of `cs` are written as escapes (05 §5): those of the set but for the two
 * exceptions, and combining characters with nothing written as it is before them.
 *   - Exception 2: one U+FE0E or U+FE0F right after an emoji base. Every other variation
 *     selector is escaped.
 *   - Exception 1: one U+200C or U+200D with, right before and after it, a character not of the
 *     set and not white space, or a selector kept by exception 2.
 *   - A combining character is kept only right after a character written as it is; first in the
 *     string, or after one written as an escape (`short` tells which characters the writing
 *     escapes besides the set), it is escaped, and the ones after it follow.
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

const hex = (p: number) => p.toString(16).toUpperCase().padStart(4, "0");
const SHORT_TEXT: Readonly<Record<string, string>> = {
  "\\": "\\\\",
  "\n": "\\n",
  "\t": "\\t",
  "|": "\\|",
};

/** A data part's writing in the text (05 §4.1, §5). */
export function escapeText(s: string): string {
  const cs = Array.from(mustString(s));
  const e = escapes(cs, (c) => c in SHORT_TEXT);
  return cs.map((c, i) => SHORT_TEXT[c] ?? (e[i] ? `\\u{${hex(cpOf(c))}}` : c)).join("");
}

/** What `escapeText` was given, from exactly what it writes; anything else throws. */
export function unescapeText(w: string): string {
  let out = "";
  for (let i = 0; i < w.length; ) {
    const c = w[i] ?? "";
    if (c !== "\\") {
      out += c;
      i++;
      continue;
    }
    const n = w[i + 1];
    if (n === "\\" || n === "n" || n === "t" || n === "|") {
      out += n === "\\" ? "\\" : n === "n" ? "\n" : n === "t" ? "\t" : "|";
      i += 2;
      continue;
    }
    const m = /^u\{([0-9A-F]{4,6})\}/.exec(w.slice(i + 1));
    const h = m?.[1];
    const p = h !== undefined ? Number.parseInt(h, 16) : -1;
    if (h === undefined || p > 0x10ffff) throw new Error("not a writing of escapeText");
    out += String.fromCodePoint(p);
    i += 1 + (m?.[0].length ?? 0);
  }
  // Exactly what the writing would be (no extra digits, no escape too many or too few).
  if (escapeText(out) !== w) throw new Error("not a writing of escapeText");
  return out;
}

/** A JSON string with the code points `escapes` decides on written as `\uXXXX`. */
function jsonString(s: string): string {
  const cs = Array.from(s);
  if (cut !== undefined && cs.length > SHOWN_CHARS) {
    cut.n++;
    cs.length = SHOWN_CHARS;
  }
  const e = escapes(cs, (c) => c === '"' || c === "\\");
  const body = cs
    .map((c, i) => {
      if (e[i]) {
        return Array.from({ length: c.length }, (_, k) => c.charCodeAt(k))
          .map((u) => `\\u${u.toString(16).padStart(4, "0")}`)
          .join("");
      }
      return c === '"' ? '\\"' : c === "\\" ? "\\\\" : c;
    })
    .join("");
  return `"${body}"`;
}

/** While JSON as written is made for the text: the strings cut there, counted. */
let cut: { n: number } | undefined;

/**
 * JSON as written (05 §5): the value as JSON, every string (keys too) with the code points the
 * text would escape written in JSON's own escapes, so that it parses to the same value.
 */
export function escapeJson(v: unknown): string {
  if (v === null || typeof v === "boolean") return JSON.stringify(v);
  if (typeof v === "number") {
    if (!Number.isFinite(v)) throw new Error("not a JSON value");
    return JSON.stringify(v);
  }
  if (typeof v === "string") return jsonString(v);
  // Plain JSON only (a result is made so before it is written): no holes, no other objects.
  if (Array.isArray(v)) {
    if (Object.getPrototypeOf(v) !== Array.prototype) throw new Error("not a JSON value");
    const out: string[] = [];
    // A hole reads as undefined, which is no JSON value.
    for (let i = 0; i < v.length; i++) out.push(escapeJson(v[i]));
    return `[${out.join(",")}]`;
  }
  const proto = typeof v === "object" ? Object.getPrototypeOf(v) : undefined;
  if (typeof v === "object" && (proto === Object.prototype || proto === null)) {
    const entries = Object.entries(v as Record<string, unknown>);
    return `{${entries.map(([k, x]) => `${jsonString(k)}:${escapeJson(x)}`).join(",")}}`;
  }
  throw new Error("not a JSON value");
}

/** The kind and text of each part, read once. */
function readParts(lines: readonly Line[]): { kind: Kind; text: string }[][] {
  return lines.map((l) => flat(l).map((p) => ({ kind: p.kind, text: p.text })));
}

/** Each part checked again, by its kind. */
function check(lines: readonly { kind: Kind; text: string }[][]): void {
  for (const l of lines) {
    for (const p of l) {
      if (typeof p.text !== "string") throw new Error("a part of no text");
      // A value is made checked; this holds should a part ever be made some other way.
      if (p.kind === "value" && !isShaped(p.text)) throw new Error("a value out of shape");
      if (p.kind !== "static" && p.kind !== "value" && p.kind !== "untrusted") {
        throw new Error("a part of no kind");
      }
      if (p.kind === "static" && p.text.includes("untrusted-data")) {
        throw new Error("wording that holds a tag");
      }
    }
  }
}

/** A number that occurs in the text built with it exactly twice for each boundary. */
function numberFor(build: (n: string) => string, boundaries: number, draw?: Draw): string {
  for (let i = 0; i < 100; i++) {
    const n = boundaryNumber([], draw);
    if (build(n).split(n).length - 1 === 2 * boundaries) return n;
  }
  throw new Error("no boundary number is free of the data");
}

/**
 * How much of one untrusted part, or of one string in JSON as written, the text shows (05 §3):
 * past it, the first part only, and a note of the service's saying how long the whole is, which
 * is in the structured result.
 */
export const SHOWN_CHARS = 2_000;

/** The first `SHOWN_CHARS` characters of `s`, and how many it has, when it has more. */
function shown(s: string): { text: string; of?: number } {
  const cs = Array.from(s);
  return cs.length <= SHOWN_CHARS
    ? { text: s }
    : { text: cs.slice(0, SHOWN_CHARS).join(""), of: cs.length };
}

/** The note after a part shown in part: the service's words, and one number. */
const partNote = (of: number) =>
  ` [the text shows the first ${SHOWN_CHARS} of ${of} characters; the whole value is in the structured result]`;

/**
 * The text of a result: its lines, the untrusted parts inside a boundary whose number occurs in
 * the whole text in its tags only; when there is untrusted data, the fixed line first.
 */
export function render(lines: readonly Line[], draw?: Draw): string {
  const parts = readParts(lines);
  check(parts);
  const tags = parts.reduce((k, l) => k + l.filter((p) => p.kind === "untrusted").length, 0);
  const build = (n: string) =>
    parts
      .map((l) =>
        l
          .map((p) =>
            p.kind === "untrusted"
              ? (() => {
                  const v = shown(p.text);
                  const note = v.of !== undefined ? partNote(v.of) : "";
                  return `<untrusted-data-${n}>${escapeText(v.text)}</untrusted-data-${n}>${note}`;
                })()
              : p.text,
          )
          .join(""),
      )
      .join("\n");
  const text = build(numberFor(build, tags, draw));
  return tags > 0 ? `${UNTRUSTED_NOTICE}\n${text}` : text;
}

/** JSON as written (05 §5): the whole of it inside one boundary, with `lead` before it. */
export function renderJson(lead: readonly Line[], json: unknown, draw?: Draw): string {
  const parts = readParts(lead);
  check(parts);
  // Nothing is nested: what leads the JSON is saveslot's wording and checked values only.
  if (parts.some((l) => l.some((p) => p.kind === "untrusted"))) {
    throw new Error("untrusted text before JSON as written");
  }
  // In the text, a string past SHOWN_CHARS shows its first part only; the lead says so.
  cut = { n: 0 };
  let content: string;
  try {
    content = escapeJson(json);
  } finally {
    const n = cut.n;
    cut = undefined;
    if (n > 0) {
      parts.push([
        {
          kind: "static",
          text: `${n} strings below show their first ${SHOWN_CHARS} characters only; the whole values are in the structured result.`,
        },
      ]);
    }
  }
  const build = (n: string) =>
    [
      ...parts.map((l) => l.map((p) => p.text).join("")),
      `<untrusted-data-${n}>${content}</untrusted-data-${n}>`,
    ].join("\n");
  return `${UNTRUSTED_NOTICE}\n${build(numberFor(build, 1, draw))}`;
}
