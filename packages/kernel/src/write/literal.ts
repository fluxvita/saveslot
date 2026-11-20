// The literal checker `literal@1` (04-write-and-read «来源级别：声明级别与字面命中»; its unit
// writings `units@1`, 10-types-and-units «单位同义表», in ./literal-units.ts): does a value a write
// gives appear, literally, in the text of a segment of its evidence. Hit, miss, or not applicable.
// It checks that the value appears, not that the evidence asserts it; whatever it is unsure of is a
// miss. The results are recorded once, at the write, and never checked again: this version is
// frozen once released.
//
// A segment is indexed once (`indexEvidence`): its text normalized, its number tokens by value,
// its dates. Each field then looks its value up (`checkLiteral`), so the cost of a request is its
// segments' length once, plus a lookup a field, plus a substring search for text and enum fields.

import type { FieldType } from "@fluxvita/saveslot-contract-core";
import { unitOf } from "../schema/units.ts";
import { CURRENCY_SYMBOLS, expandWriting, UNIT_SYNONYM_ROWS, writingsOf } from "./literal-units.ts";

/** Every unit writing of the table that stands after a number (no currency symbol). */
const ALL_WRITINGS: readonly string[] = UNIT_SYNONYM_ROWS.flatMap((r) =>
  r.writings.flatMap((ws) => ws.flatMap(expandWriting)),
).filter((w) => !CURRENCY_SYMBOLS.has(w));

export const LITERAL_CHECKER = "literal@1";

export type LiteralResult = "hit" | "miss" | "na";

/**
 * Unicode NFC, then fullwidth forms to halfwidth (U+FF01–U+FF5E; U+3000 to a space), but the
 * Chinese comma U+FF0C: it ends a clause, never groups thousands (`¥45，11月` has 45).
 */
export function normalizeText(s: string): string {
  let out = "";
  for (const ch of s.normalize("NFC")) {
    const c = ch.codePointAt(0) as number;
    out +=
      c >= 0xff01 && c <= 0xff5e && c !== 0xff0c
        ? String.fromCodePoint(c - 0xfee0)
        : c === 0x3000
          ? " "
          : ch;
  }
  return out;
}

/** An ASCII digit: what a number token is made of (fullwidth digits normalized to these). */
const isAscii = (c: string | undefined) => c !== undefined && c >= "0" && c <= "9";
/** A digit of any script, superscripts included: what a token, a date or a writing may not touch. */
const isDigit = (c: string | undefined) => c !== undefined && /^\p{N}$/u.test(c);
/** The character at `i`, a whole code point. */
const charAt = (t: string, i: number): string | undefined => {
  const c = t.codePointAt(i);
  return c === undefined ? undefined : String.fromCodePoint(c);
};
/** The character just before `i`, a whole code point. */
const charBefore = (t: string, i: number): string | undefined => {
  if (i <= 0) return undefined;
  const lo = t.charCodeAt(i - 1);
  if (lo >= 0xdc00 && lo <= 0xdfff && i >= 2) {
    const hi = t.charCodeAt(i - 2);
    if (hi >= 0xd800 && hi <= 0xdbff) return t.slice(i - 2, i);
  }
  return t[i - 1];
};
const isLatin = (c: string | undefined) =>
  c !== undefined && ((c >= "a" && c <= "z") || (c >= "A" && c <= "Z"));
const isSpace = (c: string | undefined) => c !== undefined && /\s/u.test(c);

/**
 * The value of a decimal as a key: its significant digits and where the point stands among them,
 * the sign dropped (the checker looks for the number; whether it is owed or held is what the
 * evidence asserts). `undefined` for text that is no decimal.
 */
export function numberKey(text: string): string | undefined {
  const m = /^-?([0-9]+)(?:\.([0-9]+))?(?:[eE]([+-]?[0-9]+))?$/.exec(text);
  if (m === null) return undefined;
  const int = m[1] as string;
  const frac = m[2] ?? "";
  const exp = Number(m[3] ?? "0");
  const all = int + frac;
  const lead = all.length - all.replace(/^0+/, "").length;
  const digits = all.slice(lead).replace(/0+$/, "");
  if (digits === "") return "0";
  // The point stands `int.length + exp` digits from the left of `all`, `lead` of them zeros.
  return `${digits}|${int.length + exp - lead}`;
}

interface NumberToken {
  readonly start: number;
  readonly end: number;
  /** Followed by a percent or per-mille sign (`50%`, `5‰`): a ratio, not the number. */
  readonly percent: boolean;
}

/** A segment's text as the checker reads it: normalized, its numbers and dates found once. */
export interface EvidenceIndex {
  readonly text: string;
  readonly numbers: ReadonlyMap<string, readonly NumberToken[]>;
  /** `y-m-d` for a date given with its year, `-m-d` for one without (month and day unpadded). */
  readonly dates: ReadonlySet<string>;
  lower?: string;
}

/**
 * Separators that, between digits, make a run part of something else (`1,5`, `10:30`, `3-5`).
 * `:` between digits is a time of day as well (`H:M`, below), whose numbers are no tokens: so its
 * place here decides nothing today (a mutant taking it out survives); it stays, should the time of
 * day's forms change.
 */
const JOINERS = new Set([".", ",", ":", "/", "-"]);

const DATE_PATTERNS: readonly RegExp[] = [
  /([0-9]{4})-([0-9]{1,2})-([0-9]{1,2})/gu,
  /([0-9]{4})\/([0-9]{1,2})\/([0-9]{1,2})/gu,
  /([0-9]{4})年([0-9]{1,2})月([0-9]{1,2})[日号]/gu,
  /()([0-9]{1,2})月([0-9]{1,2})[日号]/gu,
  /()([0-9]{1,2})-([0-9]{1,2})/gu,
  /()([0-9]{1,2})\/([0-9]{1,2})/gu,
];
/** Times of day as written: `H点`, `H点M分`, `H时M分`, `H:M`. Their numbers are no tokens. */
const CLOCK_PATTERNS: readonly RegExp[] = [
  /[0-9]{1,2}点(?:[0-9]{1,2}分)?/gu,
  /[0-9]{1,2}时[0-9]{1,2}分/gu,
  /[0-9]{1,2}:[0-9]{1,2}/gu,
];
const DATE_EDGE = new Set(["-", "/"]);

function daysIn(y: number | undefined, m: number): number {
  if (m === 2) {
    if (y === undefined) return 29;
    return (y % 4 === 0 && y % 100 !== 0) || y % 400 === 0 ? 29 : 28;
  }
  return [4, 6, 9, 11].includes(m) ? 30 : 31;
}

/**
 * Dates as written: `YYYY-MM-DD`, `YYYY-M-D`, `YYYY/M/D`, `YYYY年M月D日`, `YYYY年M月D号`,
 * `M月D日`, `M月D号`, `M-D`, `M/D`, month and day padded or not, any year from 0000. A date is none
 * where it touches a digit, `-` or `/` (no `11-05` out of `2026-11-05`, nothing out of `1/2/3`),
 * where `:` or a `.` before a digit follows it (`11-05:30`, `11/5.5`), and, without its year,
 * where `年` stands before it, but for spaces or `的` (its year is that one, in a form taken or
 * not). Returns the dates and where each stands.
 */
function dates(t: string): { keys: Set<string>; spans: [number, number][] } {
  const keys = new Set<string>();
  const spans: [number, number][] = [];
  for (const re of DATE_PATTERNS) {
    for (const m of t.matchAll(re)) {
      const start = m.index;
      const end = start + m[0].length;
      const before = charBefore(t, start);
      const after = charAt(t, end);
      if (isDigit(before) || (before !== undefined && DATE_EDGE.has(before))) continue;
      if (/[0-9]$/.test(m[0]) && (isDigit(after) || (after !== undefined && DATE_EDGE.has(after))))
        continue;
      if (after === ":" || (after === "." && isDigit(charAt(t, end + 1)))) continue;
      const y = m[1] as string;
      if (y === "") {
        let k = start - 1;
        while (isSpace(t[k]) || t[k] === "的") k--;
        if (t[k] === "年") continue;
      }
      const year = y === "" ? undefined : Number(y);
      const month = Number(m[2]);
      const day = Number(m[3]);
      if (month < 1 || month > 12 || day < 1 || day > daysIn(year, month)) continue;
      keys.add(`${year ?? ""}-${month}-${day}`);
      spans.push([start, end]);
    }
  }
  return { keys, spans };
}

/**
 * Number tokens: Arabic digits, thousands separators only as `,` before exactly three digits after
 * a first group of one to three, a point only before at least one digit. A token is not one where
 * it touches another digit (any script's), a `.` before it (`.5`), a joiner followed by a digit
 * (`1,5`, `3.14.15`, `1234,567`, `10:30`, `1/2`), or an exponent (`1e2`); nor where it stands in a
 * date or a time of day as written (`11月5日`, `10点30分`).
 */
function numbers(t: string, inside: readonly [number, number][]): Map<string, NumberToken[]> {
  const out = new Map<string, NumberToken[]>();
  let i = 0;
  while (i < t.length) {
    if (!isAscii(t[i]) || isAscii(t[i - 1])) {
      i++;
      continue;
    }
    const start = i;
    while (isAscii(t[i])) i++;
    if (i - start <= 3) {
      while (
        t[i] === "," &&
        isAscii(t[i + 1]) &&
        isAscii(t[i + 2]) &&
        isAscii(t[i + 3]) &&
        !isDigit(charAt(t, i + 4))
      ) {
        i += 4;
      }
    }
    if (t[i] === "." && isAscii(t[i + 1])) {
      i++;
      while (isAscii(t[i])) i++;
    }
    const end = i;
    const before = charBefore(t, start);
    const after = charAt(t, end);
    const touches =
      isDigit(before) ||
      isDigit(after) ||
      before === "." ||
      (before !== undefined && JOINERS.has(before) && isDigit(charBefore(t, start - 1))) ||
      (after !== undefined && JOINERS.has(after) && isDigit(charAt(t, end + 1))) ||
      ((before === "e" || before === "E") && isDigit(charBefore(t, start - 1))) ||
      ((before === "+" || before === "-") &&
        (t[start - 2] === "e" || t[start - 2] === "E") &&
        isDigit(charBefore(t, start - 2))) ||
      ((after === "e" || after === "E") &&
        (isDigit(charAt(t, end + 1)) ||
          ((t[end + 1] === "+" || t[end + 1] === "-") && isDigit(charAt(t, end + 2)))));
    if (touches || inside.some(([a, b]) => start < b && end > a)) continue;
    const key = numberKey(t.slice(start, end).replaceAll(",", "")) as string;
    let j = end;
    while (isSpace(t[j])) j++;
    const list = out.get(key) ?? [];
    list.push({ start, end, percent: t[j] === "%" || t[j] === "‰" });
    out.set(key, list);
  }
  return out;
}

/** Indexes a segment's text once, for every field checked against it. */
export function indexEvidence(text: string): EvidenceIndex {
  const t = normalizeText(text);
  const d = dates(t);
  const clocks = CLOCK_PATTERNS.flatMap((re) =>
    [...t.matchAll(re)].map((m): [number, number] => [m.index, m.index + m[0].length]),
  );
  return { text: t, numbers: numbers(t, [...d.spans, ...clocks]), dates: d.keys };
}

/** What the checker needs of a field: its type (a quantity's unit is the raw value's own). */
export interface LiteralField {
  readonly type: FieldType;
}

/** Superscript digits, `/`, `^`: after a unit's writing they make it another (`m²`, `km/h`). */
const AFTER_WRITING = /^[/^²³¹⁰-⁹]/u;

/**
 * The unit written after a number at `at`: the longest of all the table's writings, and the raw
 * unit's own, that the text has there (by any case of Latin letters), if nothing that makes it
 * another follows it: `/`, `^`, a superscript digit, and after a Latin letter a Latin letter or a
 * digit. `5 公里/小时` is km/h's writing, not km's; `5 m²` none.
 */
function writingAfter(t: string, at: number, own: readonly string[]): string | undefined {
  let found: string | undefined;
  for (const w of [...ALL_WRITINGS, ...own]) {
    if (found !== undefined && w.length <= found.length) continue;
    if (t.slice(at, at + w.length).toLowerCase() === w.toLowerCase()) found = w;
  }
  if (found === undefined) return undefined;
  const next = t.slice(at + found.length);
  if (AFTER_WRITING.test(next)) return undefined;
  const c = charAt(t, at + found.length);
  if (isLatin(found.at(-1)) && (isLatin(c) || isDigit(c))) return undefined;
  return found;
}

function quantityHit(ev: EvidenceIndex, key: string, unit: string): boolean {
  const tokens = (ev.numbers.get(key) ?? []).filter((x) => unit === "%" || !x.percent);
  if (unit === "1") return tokens.length > 0;
  const writings = writingsOf(unit, unitOf(unit)?.dimension.startsWith("currency:") === true);
  const own = writings.filter((w) => !CURRENCY_SYMBOLS.has(w)).map((w) => w.toLowerCase());
  const t = ev.text;
  for (const x of tokens) {
    let j = x.end;
    while (isSpace(t[j])) j++;
    const w = writingAfter(t, j, own);
    if (w !== undefined && own.includes(w.toLowerCase())) return true;
    // A percentage is one only as the unit `%` writes it after the number.
    if (x.percent) continue;
    let k = x.start;
    while (isSpace(t[k - 1])) k--;
    for (const s of writings) {
      if (!CURRENCY_SYMBOLS.has(s) || k - s.length < 0) continue;
      const before = charBefore(t, k - s.length);
      if (t.slice(k - s.length, k) === s && !isLatin(before) && !isDigit(before)) return true;
    }
  }
  return false;
}

/**
 * A value as the checker compares it, for a field's type: two values with the same key get the same
 * result against any segment (a request's cache keys on it).
 */
export function literalKey(field: LiteralField, raw: unknown): string {
  switch (field.type) {
    case "text":
      return `t:${typeof raw === "string" ? normalizeText(raw).trim() : JSON.stringify(raw)}`;
    case "enum":
      return `e:${typeof raw === "string" ? normalizeText(raw).toLowerCase() : JSON.stringify(raw)}`;
    default:
      return `${field.type}:${JSON.stringify(raw ?? null)}`;
  }
}

/**
 * Whether a field's raw value (09 §1.3: as the caller gave it) appears in a segment. `undefined`
 * evidence (no text to check: an api_call, a file reference without an excerpt) is not applicable, as are an empty value and the types the checker does not take.
 */
export function checkLiteral(
  field: LiteralField,
  raw: unknown,
  ev: EvidenceIndex | undefined,
): LiteralResult {
  if (ev === undefined || raw === null || raw === undefined) return "na";
  switch (field.type) {
    case "integer":
    case "decimal": {
      const key = typeof raw === "string" ? numberKey(raw) : undefined;
      if (key === undefined) return "na";
      return (ev.numbers.get(key) ?? []).some((x) => !x.percent) ? "hit" : "miss";
    }
    case "quantity": {
      const q = raw as { value?: unknown; unit?: unknown };
      const key = typeof q.value === "string" ? numberKey(q.value) : undefined;
      if (key === undefined || typeof q.unit !== "string") return "na";
      return quantityHit(ev, key, q.unit) ? "hit" : "miss";
    }
    case "date": {
      const m = typeof raw === "string" ? /^([0-9]{4})-([0-9]{2})-([0-9]{2})$/.exec(raw) : null;
      if (m === null) return "na";
      const [y, mo, d] = [Number(m[1]), Number(m[2]), Number(m[3])];
      return ev.dates.has(`${y}-${mo}-${d}`) || ev.dates.has(`-${mo}-${d}`) ? "hit" : "miss";
    }
    case "enum": {
      if (typeof raw !== "string" || raw === "") return "na";
      ev.lower ??= ev.text.toLowerCase();
      return ev.lower.includes(normalizeText(raw).toLowerCase()) ? "hit" : "miss";
    }
    case "text": {
      if (typeof raw !== "string") return "na";
      const v = normalizeText(raw).trim();
      if (v.length === 0) return "na";
      return ev.text.includes(v) ? "hit" : "miss";
    }
    default:
      return "na";
  }
}
