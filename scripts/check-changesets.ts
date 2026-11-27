// Checks that a pull request whose change a user can notice says so in a changeset (RELEASING.md,
// "Versions"): the changelogs are written from the changesets, so a change without one is missing
// from the next version's changelogs.
//
// A changeset is needed when the title's type is fix, feat or perf, and the change touches a file
// under src/ of a published package (packages/<dir>/ whose package.json is not private) that is not a
// test: not *.test.*, not *.fixture.* (left out of the published files) and not under __golden__/.
// It is given by an added .changeset/*.md, or by a line in the description that begins
// `No changeset: <reason>`. Anything else passes.
//
// Usage: node scripts/check-changesets.ts
// Reads the pull request's base, title and description from SAVESLOT_CI_BASE, SAVESLOT_CI_TITLE
// and SAVESLOT_CI_BODY (./ci-env.ts), never from the command line.

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { ciEnv } from "./ci-env.ts";

/** A changed file: its path and git's status letter (A added, M modified, D deleted, …). */
export interface Changed {
  readonly path: string;
  readonly status: string;
}

/** The title types whose changes reach users. */
export const NEEDS = ["fix", "feat", "perf"] as const;

const TYPE = /^([a-z]+)(?:\([^)]*\))?!?:/;
const SOURCE = /^packages\/([^/]+)\/src\//;
const TEST = /(?:\.(?:test|fixture)\.[^/]+$)|(?:\/__golden__\/)/;
const CHANGESET = /^\.changeset\/[^/]+\.md$/;
/** A line of the description that says why no changeset is needed; the reason may not be empty. */
const NO_CHANGESET = /^No changeset:[ \t]*(\S.*)$/m;

/** The title's Conventional Commit type, or undefined when it has none. */
export function titleType(title: string): string | undefined {
  return TYPE.exec(title.trim())?.[1];
}

/** The reason a `No changeset:` line gives, comments and the template's placeholder left out. */
export function noChangesetReason(body: string): string | undefined {
  const text = body.replace(/<!--[\s\S]*?-->/g, "");
  const reason = NO_CHANGESET.exec(text)?.[1]?.trim();
  if (reason === undefined || reason === "" || reason === "<reason>") return undefined;
  return reason;
}

/**
 * The changed files that a user can notice: non-test files under src/ of a published package.
 * `published` says whether packages/<dir>/ is published.
 */
export function noticeable(
  changed: readonly Changed[],
  published: (dir: string) => boolean,
): string[] {
  return changed
    .filter((c) => {
      const m = SOURCE.exec(c.path);
      return m?.[1] !== undefined && published(m[1]) && !TEST.test(c.path);
    })
    .map((c) => c.path);
}

/** Undefined when the pull request passes; else what it lacks. */
export function changesetProblem(
  title: string,
  body: string,
  changed: readonly Changed[],
  published: (dir: string) => boolean,
): string | undefined {
  const type = titleType(title);
  if (type === undefined || !(NEEDS as readonly string[]).includes(type)) return undefined;
  const files = noticeable(changed, published);
  if (files.length === 0) return undefined;
  if (
    changed.some(
      (c) => c.status === "A" && CHANGESET.test(c.path) && !c.path.endsWith("/README.md"),
    )
  ) {
    return undefined;
  }
  if (noChangesetReason(body) !== undefined) return undefined;
  const shown =
    files.slice(0, 5).join(", ") + (files.length > 5 ? `, and ${files.length - 5} more` : "");
  return `a ${type} that changes a published package (${shown}) adds no changeset: add one with \`pnpm changeset\`, or write a line in the description that begins "No changeset: " and says why`;
}

/** Whether packages/<dir>/ is a published package: its package.json is there and not private. */
export function publishedIn(root: string): (dir: string) => boolean {
  return (dir) => {
    const file = join(root, "packages", dir, "package.json");
    if (!existsSync(file)) return false;
    return (JSON.parse(readFileSync(file, "utf8")) as { private?: unknown }).private !== true;
  };
}

/** The files changed between `base` and HEAD, with their status (renames as a deletion and an addition). */
export function changedSince(root: string, base: string): Changed[] {
  const out = execFileSync("git", ["diff", "--name-status", "--no-renames", base, "HEAD"], {
    cwd: root,
    encoding: "utf8",
  });
  return out
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [status = "", path = ""] = l.split("\t");
      return { status: status.slice(0, 1), path };
    });
}

if (import.meta.main) {
  const root = process.cwd();
  const { base, title, body } = ciEnv(process.env);
  if (base === undefined || title === undefined) {
    console.error(
      "Not a pull request: set SAVESLOT_CI_BASE and SAVESLOT_CI_TITLE (and SAVESLOT_CI_BODY for its description).",
    );
    process.exit(2);
  }
  const problem = changesetProblem(title, body ?? "", changedSince(root, base), publishedIn(root));
  if (problem !== undefined) {
    console.error(`Changesets: ${problem}.`);
    process.exit(1);
  }
  console.log("Changesets OK.");
}
