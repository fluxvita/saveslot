// Helpers of the strict block shape checks (./parse.ts, ./shapes-write.ts).

export type Json = unknown;
export type Issues = string[];

export const isObject = (v: Json): v is Record<string, Json> =>
  v !== null && typeof v === "object" && !Array.isArray(v);

/**
 * Checks that `v` is an object whose keys are exactly the required ones plus some optional ones.
 * Returns whether the values should be checked.
 */
export function keys(
  v: Json,
  at: string,
  required: readonly string[],
  optional: readonly string[],
  issues: Issues,
): v is Record<string, Json> {
  if (!isObject(v)) {
    issues.push(`${at}: not an object`);
    return false;
  }
  for (const k of Object.keys(v)) {
    if (!required.includes(k) && !optional.includes(k)) issues.push(`${at}: unknown key ${k}`);
  }
  const missing = required.filter((k) => !(k in v));
  for (const k of missing) issues.push(`${at}: missing key ${k}`);
  // Values are checked only when every required key is there, so a missing key is reported once.
  return missing.length === 0;
}

export function check(cond: boolean, at: string, what: string, issues: Issues): void {
  if (!cond) issues.push(`${at}: ${what}`);
}

export const str = (v: Json): v is string => typeof v === "string";

export type ShapeChecker = (v: Json, at: string, issues: Issues) => void;
