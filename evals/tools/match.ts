// The matchers of an assertion's machine form (docs/zh-CN/spec/10-evals.md §2.5): a path into
// what was recorded, and what the value there must be. Pure: what a matcher needs from the run
// (the bound names, the latest read of a target) comes in through `Context`.
//
// A path is keys joined by dots, with `[n]` for an index, `[*]` for any element and `["k"]` for a
// key that is not a plain name (`ops[0].fields["*"].result`). An expected value is
//   - a scalar: equal; numbers and numeric strings compare as numbers; `$name` is a bound value;
//   - an object with one operator key: that operator, as §2.5 has them: `in` (any one of the
//     matchers listed, `{absent: true}` among them), `not` (the matcher does not hold; on an
//     absent key it holds unless the matcher itself matches absence), `present`, `absent`,
//     `every` (a non-empty array whose every element matches), `gt` / `gte` / `lt` / `lte`
//     (numbers, or ISO dates as strings; false when the two cannot be compared), `quantity` (with
//     an optional `within`, a tolerance in the expected unit), `from_read`, `written_in_step` (a
//     whole value in the result of an earlier `saveslot_write` of the same step and session),
//     `contains`, `has_code`, `lacks_code`, `has`, `lacks`;
//   - any other object: each key is a path under the value, matched in turn (a subset);
//   - an array: as many elements, each matching in order.

export type Obj = Record<string, unknown>;

/** What a matcher may ask of the run. */
export interface Context {
  /** A name bound by the fixture or captured from an agent's call; undefined if there is none. */
  readonly bound: (name: string) => unknown;
  /**
   * For `from_read`: the version token the latest read before this call, in its session,
   * returned for the target of the object holding the matched key; undefined if there was none.
   */
  readonly latestRead?: (holder: unknown) => string | undefined;
  /** For `written_in_step`: whether `value` is in an earlier write's result in this step. */
  readonly writtenInStep?: (value: unknown) => boolean;
}

export const OPERATORS = [
  "in",
  "present",
  "absent",
  "quantity",
  "from_read",
  "contains",
  "has_code",
  "lacks_code",
  "has",
  "lacks",
  "not",
  "every",
  "gt",
  "gte",
  "lt",
  "lte",
  "written_in_step",
] as const;

const MISSING: unique symbol = Symbol("missing");
type Found = { value: unknown; holder: unknown };

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);

/** Any element of an array, in a parsed path; a key named `*` (`["*"]`) stays the string. */
export const ANY: unique symbol = Symbol("any element");

/** The keys of a path: names, numbers, or `ANY`. */
export function parsePath(path: string): (string | number | typeof ANY)[] {
  const out: (string | number | typeof ANY)[] = [];
  const re = /([^.[\]]+)|\[(\d+)\]|\[\*\]|\["([^"]*)"\]|\.|\[/g;
  let m: RegExpExecArray | null;
  let last = 0;
  // biome-ignore lint/suspicious/noAssignInExpressions: the usual exec loop
  while ((m = re.exec(path)) !== null) {
    if (m.index !== last) throw new Error(`path ${path}: cannot read at ${m.index}`);
    last = re.lastIndex;
    if (m[1] !== undefined) out.push(m[1]);
    else if (m[2] !== undefined) out.push(Number(m[2]));
    else if (m[0] === "[*]") out.push(ANY);
    else if (m[3] !== undefined) out.push(m[3]);
    else if (m[0] === "[") throw new Error(`path ${path}: an index is [n], [*] or ["key"]`);
  }
  if (last !== path.length || out.length === 0) throw new Error(`path ${path}: cannot read it`);
  return out;
}

/** Every value at `path` under `x` (several when it has `[*]`), each with the object holding it. */
export function resolvePath(x: unknown, path: string): Found[] {
  let cur: Found[] = [{ value: x, holder: undefined }];
  for (const key of parsePath(path)) {
    const next: Found[] = [];
    for (const { value } of cur) {
      if (key === ANY) {
        if (Array.isArray(value)) for (const v of value) next.push({ value: v, holder: value });
      } else if (typeof key === "number") {
        next.push({
          value: Array.isArray(value) && key < value.length ? value[key] : MISSING,
          holder: value,
        });
      } else {
        next.push({
          value: isObj(value) && Object.hasOwn(value, key) ? value[key] : MISSING,
          holder: value,
        });
      }
    }
    cur = next;
  }
  return cur;
}

const numeric = (x: unknown): number | undefined => {
  if (typeof x === "number") return x;
  if (typeof x === "string" && /^-?\d+(\.\d+)?$/.test(x.trim())) return Number(x);
  return undefined;
};

/** Lengths in metres; other units compare only with themselves. */
const LENGTH: Record<string, number> = { m: 1, km: 1000, mi: 1609.344 };

/** Whether a quantity `{value, unit}` equals the expected one, converted to the same unit. */
export function sameQuantity(actual: unknown, expected: Obj): boolean {
  if (!isObj(actual)) return false;
  const a = numeric(actual["value"]);
  const e = numeric(expected["value"]);
  const au = String(actual["unit"] ?? "");
  const eu = String(expected["unit"] ?? "");
  if (a === undefined || e === undefined) return false;
  const within = numeric(expected["within"]) ?? 0;
  if (au === eu) return Math.abs(a - e) <= within;
  const af = LENGTH[au];
  const ef = LENGTH[eu];
  if (af === undefined || ef === undefined) return false;
  // At least a millimetre: a conversion stored to a scale rounds.
  return Math.abs(a * af - e * ef) <= Math.max(within * ef, 0.001);
}

function equal(actual: unknown, expected: unknown): boolean {
  const a = numeric(actual);
  const e = numeric(expected);
  if (a !== undefined && e !== undefined) return a === e;
  if (Array.isArray(actual) && Array.isArray(expected)) {
    return actual.length === expected.length && actual.every((x, i) => equal(x, expected[i]));
  }
  if (isObj(actual) && isObj(expected)) {
    const ka = Object.keys(actual);
    return (
      ka.length === Object.keys(expected).length &&
      ka.every((k) => Object.hasOwn(expected, k) && equal(actual[k], expected[k]))
    );
  }
  return actual === expected;
}

const DATE = /^\d{4}-\d{2}-\d{2}/;

/** Numbers by value, ISO dates as strings; undefined when the two cannot be compared. */
function compare(actual: unknown, expected: unknown): number | undefined {
  const a = numeric(actual);
  const e = numeric(expected);
  if (a !== undefined && e !== undefined) return a - e;
  if (typeof actual === "string" && typeof expected === "string") {
    if (DATE.test(actual) && DATE.test(expected))
      return actual < expected ? -1 : actual > expected ? 1 : 0;
  }
  return undefined;
}

const operatorOf = (x: unknown): string | undefined => {
  if (!isObj(x)) return undefined;
  const keys = Object.keys(x);
  return keys.length === 1 && (OPERATORS as readonly string[]).includes(keys[0] as string)
    ? (keys[0] as string)
    : undefined;
};

const codes = (x: unknown): unknown[] =>
  Array.isArray(x) ? x.map((e) => (isObj(e) ? e["code"] : undefined)) : [];

/** Whether the value found (or its absence) matches what is expected. */
export function matchFound(found: Found, expected: unknown, ctx: Context): boolean {
  const { value, holder } = found;
  const op = operatorOf(expected);
  if (op === "present") return (value !== MISSING) === Boolean((expected as Obj)["present"]);
  if (op === "absent") return (value === MISSING) === Boolean((expected as Obj)["absent"]);
  // Not there: it lacks whatever is asked; it is none of several, or one of them that allows that.
  if (value === MISSING) {
    if (op === "lacks_code" || op === "lacks") return true;
    if (op === "not") return !matchFound(found, (expected as Obj)["not"], ctx);
    if (op === "in") {
      const alts = (expected as Obj)["in"];
      return Array.isArray(alts) && alts.some((e) => matchFound(found, e, ctx));
    }
    return false;
  }
  return matchValue(value, expected, ctx, holder);
}

/** Whether `actual` (present) matches `expected`. `holder` is the object `actual` was found in. */
export function matchValue(
  actual: unknown,
  expected: unknown,
  ctx: Context,
  holder?: unknown,
): boolean {
  const op = operatorOf(expected);
  if (op !== undefined) {
    const arg = (expected as Obj)[op];
    switch (op) {
      case "in":
        if (!Array.isArray(arg)) throw new Error("`in` takes a list");
        return arg.some((e) => matchValue(actual, e, ctx, holder));
      case "present":
      case "absent":
        return matchFound({ value: actual, holder }, expected, ctx);
      case "quantity":
        return sameQuantity(actual, arg as Obj);
      case "from_read": {
        if (ctx.latestRead === undefined) throw new Error("`from_read` only matches a call's args");
        const ver = ctx.latestRead(holder);
        return (ver !== undefined && actual === ver) === Boolean(arg);
      }
      case "contains":
        return typeof actual === "string" && actual.includes(String(arg));
      case "has_code":
        return codes(actual).includes(arg);
      case "lacks_code":
        return !codes(actual).includes(arg);
      case "not":
        return !matchValue(actual, arg, ctx, holder);
      case "every":
        return (
          Array.isArray(actual) &&
          actual.length > 0 &&
          actual.every((x) => matchValue(x, arg, ctx, actual))
        );
      case "gt":
      case "gte":
      case "lt":
      case "lte": {
        const c = compare(actual, arg);
        if (c === undefined) return false;
        return op === "gt" ? c > 0 : op === "gte" ? c >= 0 : op === "lt" ? c < 0 : c <= 0;
      }
      case "written_in_step":
        if (ctx.writtenInStep === undefined) {
          throw new Error("`written_in_step` only matches a call's args");
        }
        return ctx.writtenInStep(actual) === Boolean(arg);
      case "has":
      case "lacks": {
        const keys = Array.isArray(arg) ? arg : [arg];
        const on = (k: unknown) => isObj(actual) && Boolean(actual[String(k)]);
        return op === "has" ? keys.every(on) : !keys.some(on);
      }
    }
  }
  if (typeof expected === "string" && expected.startsWith("$")) {
    const b = ctx.bound(expected.slice(1));
    if (b === undefined) throw new Error(`${expected}: nothing bound or captured by that name`);
    return equal(actual, b);
  }
  if (Array.isArray(expected)) {
    return (
      Array.isArray(actual) &&
      actual.length === expected.length &&
      expected.every((e, i) => matchValue(actual[i], e, ctx, actual))
    );
  }
  if (isObj(expected)) return matchAll(actual, expected, ctx);
  return equal(actual, expected);
}

/** Whether every path of `expected` matches under `actual`; a `[*]` path, at any element. */
export function matchAll(actual: unknown, expected: Obj, ctx: Context): boolean {
  return Object.entries(expected).every(([path, e]) => {
    const found = resolvePath(actual, path);
    return found.some((f) => matchFound(f, e, ctx));
  });
}
