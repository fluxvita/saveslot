// Names in requests (docs/zh-CN/spec/04-contract.md §1): tables qualified `slot.table` or bare, field
// names, all without ASCII case; aliases are not names and take no part. Unknown names come with the
// nearest names (04-contract-types §9 `unknown_table` / `unknown_field`: at most 3, those with an
// alias equal to the name after folding first, then by edit distance after folding, then by name in
// C order).

/** ASCII case folding: names are unique without ASCII case (04-contract §1). */
export const fold = (s: string): string => s.replace(/[A-Z]/g, (c) => c.toLowerCase());

/** Folding for nearness (keymatch@1's fold, as far as names need it): NFKC, case, white space. */
const nearFold = (s: string): string => s.normalize("NFKC").toLowerCase().replace(/\s+/g, "");

/** Edit distance over code points. */
function distance(a: string, b: string): number {
  const x = [...a];
  const y = [...b];
  let prev = Array.from({ length: y.length + 1 }, (_, j) => j);
  for (let i = 1; i <= x.length; i++) {
    const cur = [i];
    for (let j = 1; j <= y.length; j++) {
      cur[j] = Math.min(
        (prev[j] as number) + 1,
        (cur[j - 1] as number) + 1,
        (prev[j - 1] as number) + (x[i - 1] === y[j - 1] ? 0 : 1),
      );
    }
    prev = cur;
  }
  return prev[y.length] as number;
}

/** Something with a name and, possibly, aliases (a table or a field). */
export interface Named {
  readonly name: string;
  readonly aliases?: readonly string[];
}

/**
 * The nearest names to `name`: at most 3. Those with an alias equal to `name` after folding come
 * first, then the rest by edit distance after folding; ties by name in C order.
 */
export function nearest(name: string, candidates: readonly Named[]): string[] {
  const n = nearFold(name);
  const byC = (a: string, b: string) => (a < b ? -1 : a > b ? 1 : 0);
  return candidates
    .map((c) => ({
      x: c.name,
      alias: (c.aliases ?? []).some((a) => nearFold(a) === n) ? 0 : 1,
      d: distance(n, nearFold(c.name)),
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
