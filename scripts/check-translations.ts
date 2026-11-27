// Checks the English edition of the documents. The Chinese text (docs/zh-CN/) is the source of truth.
//
// Fails when:
// - a Chinese document has no English file at the same path under docs/ (docs/zh-CN/guide/x.md →
//   docs/guide/x.md), outside the directories listed in NOT_YET;
// - an English file does not name its Chinese source within its first lines, as `Translated from
//   docs/zh-CN/<same path>, updated in the same commit as this file.`, or that file does not exist.
//   No commit is named: a branch's commits are gone once it is squash-merged.
//
// - an English document (any Markdown file outside docs/zh-CN/ that is not a `*.zh-CN.md`) links a
//   file or directory under docs/zh-CN/ that has an English edition at the same path under docs/,
//   outside the links listed in ZH_LINKS_KEPT: its reader should land on the English page. Links to
//   what exists only in Chinese (process/, research/) and to docs/zh-CN/ itself pass.
//
// Reports without failing (drift): when git says the Chinese file was last changed after the
// English one, and the English head does not carry a line `The Chinese edition has changed since:
// …`. Drift is brought to nothing before a release (RELEASING.md). Dating files needs the full
// history in CI (a shallow clone dates every file to the boundary commit and hides drift).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { extractLinks } from "./check-doc-links.ts";
import { listMarkdownFiles } from "./markdown.ts";

export interface TranslationProblem {
  file: string;
  reason: string;
}

/**
 * Directories, and single files, whose English files are translations of the same path under
 * docs/zh-CN/.
 */
const TRANSLATED = [
  "docs/spec/",
  "docs/guide/",
  "docs/process/",
  "docs/research/",
  "docs/development.md",
];

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

/**
 * Links from English documents to a Chinese document that has an English edition, kept on purpose.
 * `target` is a repository path the link resolves to, or a prefix of it ending in "/".
 */
export const ZH_LINKS_KEPT: readonly { file: string; target: string; why: string }[] = [
  {
    file: "docs/README.md",
    target: "docs/zh-CN/",
    why: "the index of both editions: its Chinese column links each document's Chinese source",
  },
  {
    file: "docs/guide/README.md",
    target: "docs/zh-CN/guide/README.md",
    why: "the line saying the Chinese edition is authoritative",
  },
  {
    file: "docs/spec/README.md",
    target: "docs/zh-CN/spec/README.md",
    why: "the line saying the Chinese edition is authoritative",
  },
  {
    file: "docs/development.md",
    target: "docs/zh-CN/development.md",
    why: "the language switcher at the head of the development guide",
  },
  {
    file: "CONTRIBUTING.md",
    target: "docs/zh-CN/guide/12-contributing.md",
    why: "names the Chinese edition of the contributor guide next to the English link",
  },
  ...["AGENTS.md", "CONTRIBUTING.md", "RELEASING.md"].map((file) => ({
    file,
    target: "docs/zh-CN/spec/",
    why: "addresses contributors, who change the Chinese specification first",
  })),
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

/** Whether `file` is an English document: outside docs/zh-CN/ and not a `*.zh-CN.md`. */
const isEnglish = (file: string): boolean =>
  !file.startsWith("docs/zh-CN/") && !file.endsWith(".zh-CN.md");

/**
 * Links from English documents to a file or directory under docs/zh-CN/ whose English edition
 * exists (docs/zh-CN/x → docs/x), outside ZH_LINKS_KEPT.
 */
export function zhLinksWithEnglish(
  root: string,
  files: readonly string[],
): (TranslationProblem & { line: number })[] {
  const out: (TranslationProblem & { line: number })[] = [];
  for (const file of files.filter(isEnglish)) {
    const text = readFileSync(join(root, file), "utf8");
    for (const { line, target } of extractLinks(text)) {
      if (/^[a-z][a-z0-9+.-]*:/i.test(target) || target.startsWith("//")) continue;
      const pathPart = target.split("#")[0] ?? "";
      if (pathPart === "") continue;
      const abs = normalize(resolve(dirname(join(root, file)), decodeURIComponent(pathPart)));
      const path = relative(resolve(root), abs).split("\\").join("/");
      if (!path.startsWith("docs/zh-CN/")) continue;
      const rest = path.slice("docs/zh-CN/".length);
      if (rest === "") continue;
      if (!existsSync(join(root, "docs", rest))) continue;
      const dir = pathPart.endsWith("/") ? "/" : "";
      const shown = `${path}${dir}`;
      const en = `docs/${rest}${dir}`;
      if (
        ZH_LINKS_KEPT.some(
          (k) =>
            k.file === file &&
            (k.target.endsWith("/") ? `${path}/`.startsWith(k.target) : path === k.target),
        )
      ) {
        continue;
      }
      out.push({ file, line, reason: `links ${shown}, which has an English edition: link ${en}` });
    }
  }
  return out;
}

export function checkTranslations(
  root: string,
  files = listMarkdownFiles(root),
  changedAt: (file: string) => number | undefined = (f) => lastChange(root, f),
): { problems: TranslationProblem[]; drift: TranslationProblem[] } {
  const problems: TranslationProblem[] = [
    ...missingEnglish(root, files),
    ...zhLinksWithEnglish(root, files).map((p) => ({
      file: `${p.file}:${p.line}`,
      reason: p.reason,
    })),
  ];
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
