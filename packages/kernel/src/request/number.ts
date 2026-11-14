// How a decimal reaches the kernel (docs/zh-CN/spec/04-contract.md §1 «值的编码»), in three forms:
//
// a. a string: the caller's text, by the JSON number grammar (the recommended form);
// b. a JsonNumber: a JSON number with the text it had in the request body, made by a surface that
//    parses the body itself (HTTP: `JSON.parse` with a reviver reading `context.source`);
// c. a plain JS number (MCP and SDK arguments, parsed by the host): finite; read as its shortest
//    round-trip decimal text (`String(n)`, exponent form included). A safe integer is accepted
//    whatever its digits: it is exact. Anything else is accepted with at most 15 significant digits:
//    decimal text of up to 15 significant digits parses to a double whose shortest text is that
//    text again, so nothing was lost; with 16 or 17 the host's parse may have changed the value
//    (0.1 + 0.2 is 0.30000000000000004), refused as malformed: write a string.
//
// Decimal text longer than 100 characters is malformed, judged before it is parsed (04-contract §1).
//
// A JsonNumber is told apart by being an instance of a class this module alone constructs, not by
// any key a caller's data could also carry.

/** The JSON number grammar (RFC 8259 §6). */
const GRAMMAR = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

const token = Symbol("JsonNumber");

/** A JSON number with its text as it appeared in the request body. Frozen. */
export class JsonNumber {
  readonly text: string;
  constructor(t: typeof token, text: string) {
    if (t !== token) throw new TypeError("use jsonNumber(text)");
    this.text = text;
    Object.freeze(this);
  }
  /** As a JS number, for code that does not care about the text. */
  valueOf(): number {
    return Number(this.text);
  }
  toJSON(): number {
    return Number(this.text);
  }
}

/** Wraps a JSON number's source text; throws when the text is not a JSON number. */
export function jsonNumber(text: string): JsonNumber {
  if (!GRAMMAR.test(text)) throw new TypeError(`not a JSON number: ${JSON.stringify(text)}`);
  return new JsonNumber(token, text);
}

export function isJsonNumber(v: unknown): v is JsonNumber {
  return v instanceof JsonNumber;
}

/**
 * A reviver for `JSON.parse` that keeps every number's text (Node 24 passes `context.source` for
 * primitive values): `JSON.parse(body, keepNumberText)`.
 */
export function keepNumberText(
  this: unknown,
  _key: string,
  value: unknown,
  context?: { source?: string },
): unknown {
  return typeof value === "number" && typeof context?.source === "string"
    ? jsonNumber(context.source)
    : value;
}

/** Significant digits of decimal text (leading and trailing zeros of the digits aside). */
function significantDigits(text: string): number {
  const mantissa = text
    .replace(/^-/, "")
    .replace(/[eE].*$/, "")
    .replace(".", "");
  return mantissa.replace(/^0+/, "").replace(/0+$/, "").length;
}

export type DecimalText =
  | { readonly ok: true; readonly text: string }
  | { readonly ok: false; readonly why: "not_a_number" | "malformed" };

/** Most significant digits a plain number carries without loss (form c). */
export const PLAIN_NUMBER_DIGITS = 15;

/** Longest decimal text taken, in characters (04-contract §1). */
export const DECIMAL_TEXT_CHARS = 100;

/**
 * The decimal text of a value in one of the three forms; `not_a_number` for any other JSON type.
 * Only the length is checked here; the grammar later, by the parser.
 */
export function decimalText(v: unknown): DecimalText {
  const text =
    typeof v === "string" ? v : isJsonNumber(v) ? v.text : typeof v === "number" ? plain(v) : null;
  if (text === null) return { ok: false, why: "not_a_number" };
  if (text === undefined || text.length > DECIMAL_TEXT_CHARS)
    return { ok: false, why: "malformed" };
  return { ok: true, text };
}

/** A plain number's text (form c), or `undefined` when it may not be what the caller wrote. */
function plain(v: number): string | undefined {
  if (!Number.isFinite(v)) return undefined;
  const text = String(v);
  if (Number.isSafeInteger(v)) return text;
  return significantDigits(text) > PLAIN_NUMBER_DIGITS ? undefined : text;
}
