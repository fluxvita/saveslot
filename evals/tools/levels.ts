// Each assertion's level (docs/zh-CN/spec/10-evals.md §2.4): S, H and R are judged and count
// towards the pass line; N is only recorded. The runner judges none of them, but a level written
// wrong would be judged wrong later, so a variant with another value, or none, is refused.

export const LEVELS = ["S", "H", "R", "N"] as const;

type Obj = Record<string, unknown>;

/** The assertions whose level is not one of `LEVELS`, by their YAML path. */
export function badLevels(variant: Obj): { path: string; level: unknown }[] {
  const out: { path: string; level: unknown }[] = [];
  const assert = variant["assert"];
  if (assert === undefined) return out;
  if (typeof assert !== "object" || assert === null || Array.isArray(assert)) {
    return [{ path: "assert", level: undefined }];
  }
  for (const [kind, list] of Object.entries(assert as Obj)) {
    if (!Array.isArray(list)) {
      out.push({ path: `assert.${kind}`, level: undefined });
      continue;
    }
    list.forEach((a: unknown, i) => {
      const level = typeof a === "object" && a !== null ? (a as Obj)["level"] : undefined;
      if (!(LEVELS as readonly unknown[]).includes(level)) {
        out.push({ path: `assert.${kind}[${i}]`, level });
      }
    });
  }
  return out;
}
