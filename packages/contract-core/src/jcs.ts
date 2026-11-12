// JSON Canonicalization Scheme (RFC 8785, "JCS"), the authoritative byte form of event headers,
// content blocks and export lines (docs/zh-CN/spec/09-event-format.md §1.2, §1.5, §8).
//
// This is a small, dependency-free implementation instead of the `canonicalize` npm package.
// RFC 8785 delegates string and number serialization to ECMAScript's JSON.stringify, and key
// ordering to UTF-16 code unit comparison, which is what JavaScript's `<` on strings does; so the
// whole algorithm is a key sort around JSON.stringify. What this module adds over a generic JCS
// library is a strict input domain suited to the event format:
//
// - `undefined` object members are omitted (§1.2: absent optional fields are not encoded). This
//   matches JSON.stringify and is the only lenient case.
// - `undefined` inside an array, functions, symbols, bigints, non-finite numbers, lone surrogates
//   (in values and in keys), cycles, symbol-keyed properties and any object that is not a plain
//   object or array (Date, Map, class instances, boxed primitives, objects with toJSON) throw a
//   JcsError instead of being coerced. A coercion would silently change the bytes that get hashed.
//
// The test suite checks this implementation against the vectors of RFC 8785 itself and, as a
// differential property test, against the `canonicalize` package (dev dependency only).

/** A JSON value as accepted by `canonicalize`. Object members whose value is `undefined` are omitted. */
export type JcsValue =
  | null
  | boolean
  | number
  | string
  | readonly JcsValue[]
  | { readonly [key: string]: JcsValue | undefined };

/** The input cannot be canonicalized (it is not JSON, or it would need a lossy coercion). */
export class JcsError extends Error {
  override readonly name = "JcsError";
}

/** Serialize `value` as the RFC 8785 canonical JSON text. */
export function canonicalize(value: JcsValue): string {
  const parts: string[] = [];
  write(value, parts, new Set<object>(), "$");
  return parts.join("");
}

const utf8 = new TextEncoder();

/** The RFC 8785 canonical form as UTF-8 bytes (§3.2.4): the bytes that are hashed. */
export function canonicalizeToBytes(value: JcsValue): Uint8Array<ArrayBuffer> {
  return utf8.encode(canonicalize(value));
}

function write(value: unknown, out: string[], seen: Set<object>, at: string): void {
  switch (typeof value) {
    case "string":
      out.push(serializeString(value, at));
      return;
    case "number":
      if (!Number.isFinite(value))
        throw new JcsError(`${at}: ${String(value)} is not a JSON number`);
      // ECMAScript Number::toString, which RFC 8785 §3.2.2.3 adopts; -0 serializes as "0".
      out.push(JSON.stringify(value));
      return;
    case "boolean":
      out.push(value ? "true" : "false");
      return;
    case "object":
      break;
    default:
      throw new JcsError(`${at}: a ${typeof value} is not a JSON value`);
  }
  if (value === null) {
    out.push("null");
    return;
  }
  if (seen.has(value)) throw new JcsError(`${at}: circular reference`);
  seen.add(value);
  if (Array.isArray(value)) {
    out.push("[");
    for (let i = 0; i < value.length; i++) {
      if (i > 0) out.push(",");
      const element: unknown = value[i];
      if (element === undefined) {
        throw new JcsError(`${at}[${i}]: undefined is not allowed in an array`);
      }
      write(element, out, seen, `${at}[${i}]`);
    }
    out.push("]");
  } else {
    const proto: unknown = Object.getPrototypeOf(value);
    if (proto !== Object.prototype && proto !== null) {
      throw new JcsError(`${at}: only plain objects and arrays are allowed`);
    }
    if (Object.getOwnPropertySymbols(value).length > 0) {
      throw new JcsError(`${at}: symbol-keyed properties are not allowed`);
    }
    const record = value as Record<string, unknown>;
    // RFC 8785 §3.2.3: sort by UTF-16 code units; `<` on JavaScript strings compares exactly that.
    const keys = Object.keys(record).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
    out.push("{");
    let first = true;
    for (const key of keys) {
      const member = record[key];
      if (member === undefined) continue;
      if (!first) out.push(",");
      first = false;
      out.push(serializeString(key, at), ":");
      write(member, out, seen, `${at}.${key}`);
    }
    out.push("}");
  }
  seen.delete(value);
}

function serializeString(s: string, at: string): string {
  // RFC 8785 §3.2.2.2: lone surrogates must terminate with an error. For well-formed strings,
  // JSON.stringify produces exactly the RFC's escaping (\b \t \n \f \r, other C0 controls as
  // lowercase \u00hh, \" and \\; everything else literal, without Unicode normalization).
  if (!s.isWellFormed()) throw new JcsError(`${at}: string contains a lone surrogate`);
  return JSON.stringify(s);
}
