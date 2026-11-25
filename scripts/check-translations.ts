// Checks the English edition of the documents. The Chinese text (docs/zh-CN/) is the source of truth.
//
// Fails when:
// - a Chinese document has no English file at the same path under docs/ (docs/zh-CN/guide/x.md →
//   docs/guide/x.md), outside the directories listed in NOT_YET;
// - an English file does not name its Chinese source within its first lines, as `Translated from
//   docs/zh-CN/<same path>, updated in the same commit as this file.`, or that file does not exist.
//   No commit is named: a branch's commits are gone once it is squash-merged.
//
// Reports without failing (drift): when git says the Chinese file was last changed after the
// English one, and the English head does not carry a line `The Chinese edition has changed since:
// …`. Drift is brought to nothing before a release (RELEASING.md). Dating files needs the full
// history in CI (a shallow clone dates every file to the boundary commit and hides drift).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { listMarkdownFiles } from "./markdown.ts";

export interface TranslationProblem {
  file: string;
  reason: string;
}

/** Directories whose English files are translations of the same path under docs/zh-CN/. */
const TRANSLATED = ["docs/spec/", "docs/guide/", "docs/process/", "docs/research/"];

/**
 * Chinese directories whose English edition is not required yet. Each entry says why and until
 * when; remove it once its English files are in.
 */
export const NOT_YET: readonly { dir: string; why: string; until: string }[] = [
  {
    dir: "docs/zh-CN/process/",
    why: "decision records, walkthroughs and experiment notes; the spec and guide came first",
    until: "a week after 0.1.0",
  },
  {
    dir: "docs/zh-CN/research/",
    why: "technical research behind the spec; the spec and guide came first",
    until: "a week after 0.1.0",
  },
];

/** How many lines from the top the source line may sit at (a title and a blank line come first). */
const HEAD_LINES = 6;
const SOURCE =
  /Translated from `?(docs\/zh-CN\/[^\s`,]+)`?, updated in the same commit as this file\./;
/** The earlier form, which named a commit. */
const OLD_SOURCE = /Translated from `?[0-9a-f]{7,40}`? of /;
const BEHIND = /The Chinese edition has changed since/;

/** Commit time (seconds) of the last change to `file`, or undefined outside git or for new files. */
export function lastChange(root: string, file: string): number | undefined {
  try {
    const out = execFileSync("git", ["log", "-1", "--format=%ct", "--", file], {
      cwd: root,
      encoding: "utf8",
      stdio: ["ignore", "pipe", "ignore"],
    }).trim();
    return out === "" ? undefined : Number(out);
  } catch {
    return undefined;
  }
}

const day = (t: number): string => new Date(t * 1000).toISOString().slice(0, 10);

export function sourceLine(path: string): string {
  return `Translated from ${path}, updated in the same commit as this file.`;
}

/** The Chinese path the head names, "old" for the earlier form with a commit, or undefined. */
export function sourceOf(text: string): string | "old" | undefined {
  for (const line of text.split("\n").slice(0, HEAD_LINES)) {
    const m = SOURCE.exec(line);
    if (m?.[1] !== undefined) return m[1];
    if (OLD_SOURCE.test(line)) return "old";
  }
  return undefined;
}

/** Chinese documents without an English file at the same path, outside NOT_YET. */
export function missingEnglish(root: string, files: readonly string[]): TranslationProblem[] {
  return files
    .filter((f) => f.startsWith("docs/zh-CN/") && !NOT_YET.some((n) => f.startsWith(n.dir)))
    .map((zh) => ({ zh, en: `docs/${zh.slice("docs/zh-CN/".length)}` }))
    .filter(({ en }) => !existsSync(join(root, en)))
    .map(({ zh, en }) => ({ file: zh, reason: `no English edition (${en})` }));
}

export function checkTranslations(
  root: string,
  files = listMarkdownFiles(root),
  changedAt: (file: string) => number | undefined = (f) => lastChange(root, f),
): { problems: TranslationProblem[]; drift: TranslationProblem[] } {
  const problems = missingEnglish(root, files);
  const drift: TranslationProblem[] = [];
  for (const file of files) {
    if (!TRANSLATED.some((d) => file.startsWith(d))) continue;
    const expected = `docs/zh-CN/${file.slice("docs/".length)}`;
    const text = readFileSync(join(root, file), "utf8");
    const source = sourceOf(text);
    if (source === "old") {
      problems.push({
        file,
        reason: `names a commit, which squash merges lose; write "${sourceLine(expected)}"`,
      });
    } else if (source === undefined) {
      problems.push({
        file,
        reason: `no "${sourceLine(expected)}" in its first ${HEAD_LINES} lines`,
      });
    } else if (source !== expected) {
      problems.push({ file, reason: `says it is translated from ${source}, expected ${expected}` });
    } else if (!existsSync(join(root, expected))) {
      problems.push({ file, reason: `its source ${expected} does not exist` });
    } else {
      const zh = changedAt(expected);
      const en = changedAt(file);
      const behind = text
        .split("\n")
        .slice(0, HEAD_LINES)
        .some((l) => BEHIND.test(l));
      if (zh !== undefined && en !== undefined && zh > en && !behind) {
        drift.push({
          file,
          reason: `${expected} changed after it (${day(zh)}, translation ${day(en)}); update it, or add "The Chinese edition has changed since: …" under the source line`,
        });
      }
    }
  }
  return { problems, drift };
}

if (import.meta.main) {
  const root = process.cwd();
  const { problems, drift } = checkTranslations(root);
  for (const d of drift) console.warn(`${d.file}: ${d.reason}`);
  if (drift.length > 0) {
    console.warn(
      `\n${drift.length} translation(s) behind their Chinese source: not a failure; bring them up to date before a release (RELEASING.md).\n`,
    );
  }
  for (const p of problems) console.error(`${p.file}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) with the English edition.`);
    process.exit(1);
  }
  const english = listMarkdownFiles(root).filter((f) => TRANSLATED.some((d) => f.startsWith(d)));
  console.log(
    `Translations OK: ${english.length} English documents, each naming its Chinese source; not required yet: ${NOT_YET.map((n) => `${n.dir} (until ${n.until})`).join(", ")}.`,
  );
}
