// Checks that every English document under docs/spec/ and docs/guide/ names its Chinese source:
// within its first lines, `Translated from docs/zh-CN/<same path>, updated in the same commit as this
// file.`, and that Chinese file exists. The Chinese text is the source of truth. No commit is named:
// a branch's commits are gone once it is squash-merged. A following line `The Chinese edition has
// changed since: …` (added when the Chinese text moved on and the English did not) is allowed.
// Drift: when git says the Chinese file was last changed after the English one, and the English head
// does not carry that line, the translation has fallen behind and is reported. This needs the full
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
const TRANSLATED = ["docs/spec/", "docs/guide/"];
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

export function checkTranslations(
  root: string,
  files = listMarkdownFiles(root),
  changedAt: (file: string) => number | undefined = (f) => lastChange(root, f),
): TranslationProblem[] {
  const problems: TranslationProblem[] = [];
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
        problems.push({
          file,
          reason: `${expected} changed after it (${day(zh)}, translation ${day(en)}); update it, or add "The Chinese edition has changed since: …" under the source line`,
        });
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = process.cwd();
  const files = listMarkdownFiles(root).filter((f) => TRANSLATED.some((d) => f.startsWith(d)));
  const problems = checkTranslations(root, files);
  for (const p of problems) console.error(`${p.file}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} translation(s) without a valid source line.`);
    process.exit(1);
  }
  console.log(
    `Translations OK: ${files.length} English spec and guide files name their Chinese source.`,
  );
}
