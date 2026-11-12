// Checks that a merge request title is a Conventional Commit: it becomes the squash commit's
// subject on main (CONTRIBUTING.md).
//
// Usage: node scripts/check-mr-title.ts [<title>]
// The title defaults to $CI_MERGE_REQUEST_TITLE.

export const TYPES = [
  "feat",
  "fix",
  "docs",
  "test",
  "build",
  "ci",
  "chore",
  "refactor",
  "perf",
  "revert",
  "style",
] as const;

const TITLE = new RegExp(`^(?:${TYPES.join("|")})(?:\\([a-z0-9][a-z0-9-]*\\))?!?: \\S`);

/** GitLab marks drafts with a prefix that is not part of the eventual commit subject. */
const DRAFT = /^(?:Draft:\s*|\[Draft\]\s*|\(Draft\)\s*)/i;

/** Undefined when the title is a Conventional Commit; else the reason it is not. */
export function titleProblem(title: string): string | undefined {
  const t = title.replace(DRAFT, "");
  if (t.trim() === "") return "the title is empty";
  if (t !== t.trim()) return "the title has leading or trailing whitespace";
  if (!TITLE.test(t)) {
    return `expected "type(scope)?!?: subject" with type one of ${TYPES.join(", ")}; scope in lower case`;
  }
  return undefined;
}

if (import.meta.main) {
  const title = process.argv[2] ?? process.env["CI_MERGE_REQUEST_TITLE"];
  if (title === undefined) {
    console.error("No title: pass it as an argument or set CI_MERGE_REQUEST_TITLE.");
    process.exit(2);
  }
  const problem = titleProblem(title);
  if (problem !== undefined) {
    console.error(`Merge request title is not a Conventional Commit: ${problem}.`);
    console.error(`Title: ${title}`);
    process.exit(1);
  }
  console.log("MR title OK.");
}
