// Makes the built `bin` entries of the packages runnable, after `tsc -b`: tsc writes them without
// the execute bits, and a host starts saveslot by executing the entry itself (06-cli §3.2). An
// entry that was not built, or that does not begin with the shebang, fails the build.
//
// Usage: node scripts/mark-bins.ts

import { chmodSync, existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join, resolve } from "node:path";

export const SHEBANG = "#!/usr/bin/env node\n";

/** The paths a package.json's `bin` names: one path, or a path for each command. */
function binPaths(bin: unknown): string[] {
  if (typeof bin === "string") return [bin];
  if (typeof bin !== "object" || bin === null) return [];
  return Object.values(bin).filter((p): p is string => typeof p === "string");
}

/**
 * Sets the execute bits on each `bin` entry of the packages under `root`. Returns the problems
 * found, one line each; an entry with a problem is left as it is.
 */
export function markBins(root: string): string[] {
  const problems: string[] = [];
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const manifest = join(root, "packages", name, "package.json");
    if (!existsSync(manifest)) continue;
    const pkg = JSON.parse(readFileSync(manifest, "utf8")) as { bin?: unknown };
    for (const path of binPaths(pkg.bin)) {
      const shown = join("packages", name, path);
      const file = join(root, shown);
      if (!existsSync(file)) {
        problems.push(`${shown}: no such file`);
      } else if (!readFileSync(file, "utf8").startsWith(SHEBANG)) {
        problems.push(`${shown}: does not begin with ${JSON.stringify(SHEBANG)}`);
      } else {
        chmodSync(file, statSync(file).mode | 0o111);
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const problems = markBins(resolve(import.meta.dirname, ".."));
  if (problems.length > 0) {
    console.error("A built bin entry cannot be run by executing it:");
    for (const p of problems) console.error(`  ${p}`);
    process.exit(1);
  }
}
