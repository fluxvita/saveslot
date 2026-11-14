// Reading the caller's objects: only their own enumerable properties count, the way JSON has them.
// A key whose value is `undefined` counts as not written. Nothing is read through a prototype, and
// an array with holes is no JSON array. The kernel can be embedded, so its input is not always the
// output of `JSON.parse`.

import { isJsonNumber } from "./number.ts";

export type Obj = Readonly<Record<string, unknown>>;

/** A JSON object: not null, not an array, not a JsonNumber. Any prototype (it is not read through). */
export const isObj = (v: unknown): v is Obj =>
  v !== null && typeof v === "object" && !Array.isArray(v) && !isJsonNumber(v);

const enumerable = (o: object, k: string) => Object.prototype.propertyIsEnumerable.call(o, k);

/** Whether the object has `k` as its own enumerable key with a value other than `undefined`. */
export const has = (o: Obj, k: string): boolean =>
  Object.hasOwn(o, k) && enumerable(o, k) && o[k] !== undefined;

/** The value of the object's own key `k`; `undefined` when it has none (see `has`). */
export const get = (o: Obj, k: string): unknown => (has(o, k) ? o[k] : undefined);

/** The object's own keys that count as written, in order. */
export const keysOf = (o: Obj): string[] => Object.keys(o).filter((k) => o[k] !== undefined);

/** An array without holes. */
export function isDenseArray(v: unknown): v is readonly unknown[] {
  if (!Array.isArray(v)) return false;
  for (let i = 0; i < v.length; i++) if (!Object.hasOwn(v, i)) return false;
  return true;
}
