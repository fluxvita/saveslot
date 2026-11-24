// Names in requests (docs/zh-CN/spec/04-contract.md §1): tables qualified `slot.table` or bare, field
// names, all without ASCII case; aliases are not names and take no part. Unknown names come with the
// nearest names (04-contract-types §9 `unknown_table` / `unknown_field`: at most 3, those with an
// alias equal to the name after folding first, then by edit distance after folding, then by name in
// C order). The folding is `keymatch@1`'s (04-contract §11; 10-types-and-units «相近的键»).

// ASCII case folding: names are unique without ASCII case (04-contract §1).
import { fold } from "../schema/index.ts";
import { distance, foldKey } from "./keymatch/index.ts";

export { fold };

const same = (a: readonly number[], b: readonly number[]) =>
  a.length === b.length && a.every((x, i) => x === b[i]);

/** Something with a name and, possibly, aliases (a table or a field). */
export interface Named {
  readonly name: string;
  readonly aliases?: readonly string[];
}

/**
 * The nearest names to `name`: at most 3. Those with an alias equal to `name` after `keymatch@1`'s
 * fold come first, then the rest by edit distance (over code points) after that fold; ties by name
 * in C order.
 */
export function nearest(name: string, candidates: readonly Named[]): string[] {
  const n = foldKey(name);
  const byC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return candidates
    .map((c) => ({
      x: c.name,
      alias: (c.aliases ?? []).some((a) => same(foldKey(a), n)) ? 0 : 1,
      d: distance(n, foldKey(c.name)),
    }))
    .sort((a, b) => a.alias - b.alias || a.d - b.d || byC(a.x, b.x))
    .slice(0, 3)
    .map((e) => e.x);
}

/** `slot.table` → [slot, table]; a bare name → [undefined, name]. The slot part has no dot. */
export function splitTableName(name: string): [string | undefined, string] {
  const dot = name.indexOf(".");
  return dot < 0 ? [undefined, name] : [name.slice(0, dot), name.slice(dot + 1)];
}

/** Longest name or path segment an error echoes, in code points (a longer one is cut). */
export const ECHO_CHARS = 200;

/** A name as an error echoes it: at most `ECHO_CHARS` code points. */
export function echoName(s: string): string {
  const cps = [...s];
  return cps.length > ECHO_CHARS ? cps.slice(0, ECHO_CHARS).join("") : s;
}

/** A parameter path as an error echoes it: each segment at most `ECHO_CHARS` code points. */
export const echoPath = (path: string): string => path.split("/").map(echoName).join("/");

/** A table as receipts and errors name it: `slot.table`, never the bare name another slot may share. */
export const qualifiedTable = (slot: string, table: { readonly name: string }): string =>
  `${slot}.${table.name}`;
