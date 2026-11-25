// Checks that every commit in a range carries a Developer Certificate of Origin sign-off
// (`Signed-off-by:`) by its author.
//
// Usage: node scripts/check-dco.ts [<base>]
// The range is <base>..HEAD. <base> defaults to the pull or merge request's base (./ci-env.ts),
// then origin/main.

import { execFileSync } from "node:child_process";
import { ciEnv } from "./ci-env.ts";

export interface CommitInfo {
  sha: string;
  authorName: string;
  authorEmail: string;
  message: string;
}

/** Undefined when the commit is signed off by its author; else the reason it is not. */
export function dcoProblem(c: CommitInfo): string | undefined {
  const signoffs = [...c.message.matchAll(/^Signed-off-by:\s*(.+?)\s*<([^>]+)>\s*$/gm)];
  if (signoffs.length === 0) return "missing Signed-off-by";
  const byAuthor = signoffs.some((m) => m[2]?.toLowerCase() === c.authorEmail.toLowerCase());
  if (!byAuthor) return `no Signed-off-by from the author <${c.authorEmail}>`;
  return undefined;
}

function commitsIn(range: string): CommitInfo[] {
  const SEP = "\u001e";
  const out = execFileSync(
    "git",
    ["log", "--no-merges", `--format=%H%n%an%n%ae%n%B${SEP}`, range],
    {
      encoding: "utf8",
    },
  );
  return out
    .split(SEP)
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim() !== "")
    .map((s) => {
      const [sha = "", authorName = "", authorEmail = "", ...rest] = s.split("\n");
      return { sha, authorName, authorEmail, message: rest.join("\n") };
    });
}

if (import.meta.main) {
  const base = process.argv[2] ?? ciEnv(process.env).base ?? "origin/main";
  const commits = commitsIn(`${base}..HEAD`);
  let bad = 0;
  for (const c of commits) {
    const problem = dcoProblem(c);
    if (problem !== undefined) {
      bad++;
      console.error(`${c.sha.slice(0, 12)} ${c.message.split("\n")[0]}: ${problem}`);
    }
  }
  if (bad > 0) {
    console.error(
      `\n${bad} of ${commits.length} commit(s) lack a DCO sign-off. Use git commit -s.`,
    );
    process.exit(1);
  }
  console.log(`DCO OK: ${commits.length} commit(s) in ${base}..HEAD signed off.`);
}
