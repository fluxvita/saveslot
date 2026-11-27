// Checks the two editions of the documents: Chinese under docs/zh-CN/, English at the same path
// under docs/ (docs/zh-CN/guide/x.md and docs/guide/x.md). The two are aligned in meaning and
// changed in the same pull request.
//
// Fails when:
// - a Chinese document has no English file at the same path, outside the directories listed in
//   NOT_YET; or an English file under the translated directories has no Chinese file at the same
//   path;
// - a file of a pair does not carry, within its first lines, the language switch that links the
//   other file of the pair: `English · [简体中文](<path>)` in the English file,
//   `[English](<path>) · 简体中文` in the Chinese one, with <path> relative to the file;
//
// - an English document (any Markdown file outside docs/zh-CN/ that is not a `*.zh-CN.md`) links a
//   file or directory under docs/zh-CN/ that has an English edition at the same path under docs/,
//   outside its own language line and the links listed in ZH_LINKS_KEPT: its reader should land
//   on the English page. Links to what exists only in Chinese (process/, research/) and to
//   docs/zh-CN/ itself pass.
//
// Reports without failing (drift): when git says one file of a pair was last changed after the
// other, and the other carries no line saying it is behind (`The Chinese edition has changed since:
// …` in an English file, `英文版此后有改动：…` in a Chinese one). Drift is brought to nothing
// before a release (RELEASING.md). Dating files needs the full history in CI (a shallow clone dates
// every file to the boundary commit and hides drift).

import { execFileSync } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { dirname, join, normalize, relative, resolve } from "node:path";
import { extractLinks } from "./check-doc-links.ts";
import { listMarkdownFiles } from "./markdown.ts";

export interface TranslationProblem {
  file: string;
  reason: string;
}

/** Directories, and single files, whose English files pair with the same path under docs/zh-CN/. */
const TRANSLATED = [
  "docs/spec/",
  "docs/guide/",
  "docs/process/",
  "docs/research/",
  "docs/integration/",
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
    why: "the index of both editions: its Chinese column links each document's Chinese edition",
  },
  {
    file: "docs/guide/README.md",
    target: "docs/zh-CN/guide/README.md",
    why: "the note under the head pointing to the Chinese edition of every chapter",
  },
  {
    file: "docs/spec/README.md",
    target: "docs/zh-CN/spec/README.md",
    why: "the note under the head pointing to the Chinese edition of every specification document",
  },
  {
    file: "CONTRIBUTING.md",
    target: "docs/zh-CN/guide/12-contributing.md",
    why: "names the Chinese edition of the contributor guide next to the English link",
  },
  ...["AGENTS.md", "CONTRIBUTING.md", "RELEASING.md"].map((file) => ({
    file,
    target: "docs/zh-CN/spec/",
    why: "addresses contributors, who change both editions of the specification",
  })),
];

/** How many lines from the top the language switch may sit at (a title and a blank line come first). */
const HEAD_LINES = 6;
const EN_SWITCH = /^(?:>\s*)?English · \[简体中文\]\(([^)\s]+)\)\s*$/;
const ZH_SWITCH = /^(?:>\s*)?\[English\]\(([^)\s]+)\) · 简体中文\s*$/;
/** The earlier head of an English file, which named its Chinese source as a translation. */
const OLD_HEAD = /Translated from |The Chinese edition is authoritative/;
const EN_BEHIND = /The Chinese edition has changed since/;
const ZH_BEHIND = /英文版此后有改动/;

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

const isChinese = (file: string): boolean => file.startsWith("docs/zh-CN/");

/** The other file of a pair: docs/zh-CN/x ↔ docs/x. */
export function counterpart(file: string): string {
  return isChinese(file)
    ? `docs/${file.slice("docs/zh-CN/".length)}`
    : `docs/zh-CN/${file.slice("docs/".length)}`;
}

/** The relative link from `file` to `target`, both repository paths. */
const linkFrom = (file: string, target: string): string =>
  relative(dirname(file), target).split("\\").join("/");

/** The language switch `file` should carry. */
export function switchLine(file: string): string {
  const link = linkFrom(file, counterpart(file));
  return isChinese(file) ? `[English](${link}) · 简体中文` : `English · [简体中文](${link})`;
}

/**
 * The language line in the head of `file`: its line number (1-based) and the repository path it
 * links, or undefined when there is none (or its link cannot be decoded).
 */
export function switchOf(file: string, text: string): { line: number; path: string } | undefined {
  const re = isChinese(file) ? ZH_SWITCH : EN_SWITCH;
  const head = text.split("\n").slice(0, HEAD_LINES);
  for (const [i, line] of head.entries()) {
    const m = re.exec(line);
    if (m?.[1] === undefined) continue;
    let link: string;
    try {
      link = decodeURIComponent(m[1]);
    } catch {
      return undefined;
    }
    return {
      line: i + 1,
      path: normalize(join(dirname(file), link))
        .split("\\")
        .join("/"),
    };
  }
  return undefined;
}

/** Whether the head of `file` still has a line of the earlier translation head. */
export const hasOldHead = (text: string): boolean =>
  text
    .split("\n")
    .slice(0, HEAD_LINES)
    .some((l) => OLD_HEAD.test(l));

/** Chinese documents without an English file at the same path, outside NOT_YET. */
export function missingEnglish(root: string, files: readonly string[]): TranslationProblem[] {
  return files
    .filter((f) => isChinese(f) && !NOT_YET.some((n) => f.startsWith(n.dir)))
    .map((zh) => ({ zh, en: counterpart(zh) }))
    .filter(({ en }) => !existsSync(join(root, en)))
    .map(({ zh, en }) => ({ file: zh, reason: `no English edition (${en})` }));
}

/** Whether `file` is an English document: outside docs/zh-CN/ and not a `*.zh-CN.md`. */
const isEnglish = (file: string): boolean => !isChinese(file) && !file.endsWith(".zh-CN.md");

/**
 * Links from English documents to a file or directory under docs/zh-CN/ whose English edition
 * exists (docs/zh-CN/x → docs/x), outside a file's link to its own Chinese edition and
 * ZH_LINKS_KEPT.
 */
export function zhLinksWithEnglish(
  root: string,
  files: readonly string[],
): (TranslationProblem & { line: number })[] {
  const out: (TranslationProblem & { line: number })[] = [];
  for (const file of files.filter(isEnglish)) {
    const text = readFileSync(join(root, file), "utf8");
    const own = TRANSLATED.some((d) => file.startsWith(d)) ? switchOf(file, text) : undefined;
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
      if (own !== undefined && line === own.line && path === own.path) continue;
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

/** The problem with the language switch of `file`, whose counterpart exists, or undefined. */
function switchProblem(file: string, text: string): string | undefined {
  const expected = counterpart(file);
  const found = switchOf(file, text);
  if (hasOldHead(text)) {
    return found === undefined
      ? `still has the old "Translated from …" head; replace it with "${switchLine(file)}"`
      : `still has a line of the old "Translated from …" head; remove it`;
  }
  if (found === undefined) return `no "${switchLine(file)}" in its first ${HEAD_LINES} lines`;
  if (found.path !== expected) {
    return `its language switch links ${found.path}, expected ${expected}`;
  }
  return undefined;
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
  for (const en of files) {
    if (!TRANSLATED.some((d) => en.startsWith(d))) continue;
    const zh = counterpart(en);
    if (!existsSync(join(root, zh))) {
      problems.push({ file: en, reason: `no Chinese edition (${zh})` });
      continue;
    }
    const enText = readFileSync(join(root, en), "utf8");
    const zhText = readFileSync(join(root, zh), "utf8");
    const enProblem = switchProblem(en, enText);
    const zhProblem = switchProblem(zh, zhText);
    if (enProblem !== undefined) problems.push({ file: en, reason: enProblem });
    if (zhProblem !== undefined) problems.push({ file: zh, reason: zhProblem });
    if (enProblem !== undefined || zhProblem !== undefined) continue;
    const zhAt = changedAt(zh);
    const enAt = changedAt(en);
    if (zhAt === undefined || enAt === undefined || zhAt === enAt) continue;
    const head = (text: string) => text.split("\n").slice(0, HEAD_LINES);
    if (zhAt > enAt && !head(enText).some((l) => EN_BEHIND.test(l))) {
      drift.push({
        file: en,
        reason: `${zh} changed after it (${day(zhAt)}, this file ${day(enAt)}); bring it in line, or add "The Chinese edition has changed since: …" under the language switch`,
      });
    }
    if (enAt > zhAt && !head(zhText).some((l) => ZH_BEHIND.test(l))) {
      drift.push({
        file: zh,
        reason: `${en} changed after it (${day(enAt)}, this file ${day(zhAt)}); bring it in line, or add "英文版此后有改动：…" under the language switch`,
      });
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
      `\n${drift.length} document(s) behind the other edition: not a failure; bring them in line before a release (RELEASING.md).\n`,
    );
  }
  for (const p of problems) console.error(`${p.file}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} problem(s) with the two editions.`);
    process.exit(1);
  }
  const english = listMarkdownFiles(root).filter((f) => TRANSLATED.some((d) => f.startsWith(d)));
  console.log(
    `Editions OK: ${english.length} documents in both editions, each linking the other; English not required yet: ${NOT_YET.map((n) => `${n.dir} (until ${n.until})`).join(", ")}.`,
  );
}
