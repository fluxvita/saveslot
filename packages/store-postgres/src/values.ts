// What a result's values are in JavaScript, and how a parameter is sent.
//
// The kernel reads the values a backend gives as they are, and it was written against PGlite's:
// replay on both backends is the same only if both give the same value for the same column. So
// the parsers here are PGlite's own table (its `types` module, 0.5.16), by type OID over the text
// format, and the driver's defaults are not used at all: they differ on `int8` (text), `date` and
// `timestamp` (the local time zone), `bytea` (a Buffer), `interval` (an object) and the elements
// of arrays. `values.test.ts` runs the same queries on PGlite and through this file and compares.
//
// A type without a parser is given as its text, as PGlite gives it (`numeric` among them: a
// decimal keeps its digits).

/** Type OIDs (pg_type.dat). */
const BOOL = 16;
const BYTEA = 17;
const INT8 = 20;
const INT2 = 21;
const INT4 = 23;
const OID = 26;
const JSON_ = 114;
const FLOAT4 = 700;
const FLOAT8 = 701;
const DATE = 1082;
const TIMESTAMP = 1114;
const TIMESTAMPTZ = 1184;
const JSONB = 3802;
/** `box[]`: the one array type whose elements are separated by `;`. */
const BOX_ARRAY = 1020;

export type Parser = (text: string) => unknown;

const number: Parser = (s) => +s;

/** A JavaScript number while it is exact, a bigint beyond. */
const bigint: Parser = (s) => {
  const n = BigInt(s);
  return n < Number.MIN_SAFE_INTEGER || n > Number.MAX_SAFE_INTEGER ? n : Number(n);
};

const json: Parser = (s) => JSON.parse(s);

const boolean: Parser = (s) => s === "t";

/**
 * `date`, `timestamp` and `timestamptz` alike, by the Date constructor on the ISO output, as
 * PGlite reads them. Not all of it is free of the process's time zone: a `timestamp` (no zone in
 * its text) and a date past the year 9999 (not the form the constructor takes as UTC) are read in
 * the local zone, there as here. The kernel's own columns hold instants as text.
 */
const date: Parser = (s) =>
  s === "infinity" ? Infinity : s === "-infinity" ? -Infinity : new Date(s);

/** The hex output (`\x…`). */
const bytea: Parser = (s) => {
  const hex = s.slice(2);
  return Uint8Array.from({ length: hex.length / 2 }, (_, i) =>
    Number.parseInt(hex.substring(i * 2, (i + 1) * 2), 16),
  );
};

const SCALARS: ReadonlyMap<number, Parser> = new Map([
  [INT2, number],
  [INT4, number],
  [OID, number],
  [FLOAT4, number],
  [FLOAT8, number],
  [INT8, bigint],
  [JSON_, json],
  [JSONB, json],
  [BOOL, boolean],
  [DATE, date],
  [TIMESTAMP, date],
  [TIMESTAMPTZ, date],
  [BYTEA, bytea],
]);

/** The parser's place in the text; one for all levels of an array, as in PGlite's. */
interface Cursor {
  i: number;
  last: number;
  quoted: boolean;
  str: string;
  char: string | undefined;
  prev: string | undefined;
}

/**
 * An array's text (`{1,2,NULL}`, `{"a b","c\"d"}`, `{{1,2},{3,4}}`) as nested arrays, each element
 * by `element` (its text when there is none). PGlite's parser, step for step: what it does with
 * text that is not an array's is kept too.
 */
export function parseArray(text: string, element: Parser | undefined, arrayOid: number): unknown {
  const c: Cursor = { i: 0, last: 0, quoted: false, str: "", char: undefined, prev: undefined };
  return level(c, text, element, arrayOid === BOX_ARRAY ? ";" : ",")[0];
}

function level(c: Cursor, text: string, element: Parser | undefined, delimiter: string): unknown[] {
  const out: unknown[] = [];
  const value = (s: string) => (element ? element(s) : s);
  for (; c.i < text.length; c.i++) {
    const ch = text[c.i] as string;
    c.char = ch;
    if (c.quoted) {
      if (ch === "\\") {
        c.str += text[++c.i];
      } else if (ch === '"') {
        out.push(value(c.str));
        c.str = "";
        c.quoted = text[c.i + 1] === '"';
        c.last = c.i + 2;
      } else {
        c.str += ch;
      }
    } else if (ch === '"') {
      c.quoted = true;
    } else if (ch === "{") {
      c.last = ++c.i;
      out.push(level(c, text, element, delimiter));
    } else if (ch === "}") {
      if (c.last < c.i) {
        const s = text.slice(c.last, c.i);
        out.push(s === "NULL" ? null : value(s));
      }
      c.quoted = false;
      c.last = c.i + 1;
      break;
    } else if (ch === delimiter && c.prev !== "}" && c.prev !== '"') {
      const s = text.slice(c.last, c.i);
      out.push(s === "NULL" ? null : value(s));
      c.last = c.i + 1;
    }
    // After a nested level this is its closing brace, not the opening one: the separator that
    // follows a nested array ends no element.
    c.prev = c.char;
  }
  if (c.last < c.i) out.push(value(text.slice(c.last, c.i + 1)));
  return out;
}

/** An array type of the database: its OID and its element type's (pg_type.typarray, .oid). */
export interface ArrayType {
  readonly oid: number;
  readonly element: number;
}

/** The array types of a database, as PGlite asks for them when it starts. */
export const ARRAY_TYPES_SQL = `
  SELECT b.typarray::int4 AS oid, b.oid::int4 AS element
  FROM pg_catalog.pg_type a
  LEFT JOIN pg_catalog.pg_type b ON b.oid = a.typelem
  WHERE a.typcategory = 'A' AND b.typarray <> 0
  GROUP BY b.oid, b.typarray
  ORDER BY b.oid`;

const text: Parser = (s) => s;

/** The parsers of a connection: by type OID; text for a type that has none. */
export function parsers(arrays: readonly ArrayType[]): (oid: number) => Parser {
  const all = new Map<number, Parser>(SCALARS);
  for (const a of arrays) {
    const element = SCALARS.get(a.element);
    all.set(a.oid, (s) => parseArray(s, element, a.oid));
  }
  return (oid) => all.get(oid) ?? text;
}

const hex = (v: Uint8Array): string =>
  `\\x${Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("hex")}`;

/** An element of an array parameter as text; null for one that is absent. */
function elementText(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return hex(v);
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : String(v);
}

/**
 * An array as PostgreSQL's array text, as PGlite writes one: every element quoted, `\` and `"`
 * escaped, an absent element `null`, a nested array a level of its own.
 */
export function arrayText(v: readonly unknown[]): string {
  if (v.length === 0) return "{}";
  const parts = v.map((x) => {
    if (Array.isArray(x)) return arrayText(x);
    const text = elementText(x);
    return text === null ? "null" : `"${text.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
  });
  return `{${parts.join(",")}}`;
}

/**
 * A parameter as the driver is to send it: bytes as bytes, an array as its text, an instant as
 * ISO text, every other value by its text; nothing (`undefined`) as NULL.
 *
 * The port's `SqlValue` has no array in it, and the kernel passes arrays all the same
 * (`= ANY($1)`): PGlite takes them, so this backend does.
 */
export function parameter(v: unknown): string | Buffer | null {
  if (v === null || v === undefined) return null;
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength);
  if (Array.isArray(v)) return arrayText(v);
  if (v instanceof Date) return v.toISOString();
  return typeof v === "string" ? v : String(v);
}

/** The commands whose result counts the rows they changed (as PGlite counts them). */
const COUNTED = new Set(["INSERT", "UPDATE", "DELETE", "COPY", "MERGE"]);

/** The rows a statement changed: its count for a command that changes rows, 0 for any other. */
export function affectedRows(command: string | null, rowCount: number | null): number {
  return command !== null && COUNTED.has(command) ? (rowCount ?? 0) : 0;
}
