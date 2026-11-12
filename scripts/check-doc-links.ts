// Checks that every relative link in the repository's Markdown files points to an existing file,
// and that every `#fragment` on a link to a Markdown file names a heading in that file.
// External links (with a URL scheme) are not fetched.

import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, resolve } from "node:path";
import { listMarkdownFiles, splitFences } from "./markdown.ts";

export interface LinkProblem {
  file: string;
  line: number;
  target: string;
  reason: string;
}

/** Inline links and images: `[text](target)` / `![alt](target "title")`. */
const INLINE_LINK = /!?\[(?:[^\][]|\[[^\]]*\])*\]\(\s*<?([^)\s>]+)>?(?:\s+"[^"]*")?\s*\)/g;
/** Reference definitions: `[label]: target`. */
const REF_DEF = /^ {0,3}\[[^\]]+\]:\s*<?(\S+?)>?(?:\s+.*)?$/;
const SCHEME = /^[a-z][a-z0-9+.-]*:/i;

/** GitHub-style heading anchor. */
export function slugify(heading: string): string {
  return heading
    .trim()
    .toLowerCase()
    .replace(/<[^>]+>/g, "")
    .replace(/[^\p{L}\p{M}\p{N}\s_-]/gu, "")
    .replace(/\s/g, "-");
}

/** Anchors defined by the headings of a Markdown document, with GitHub's duplicate suffixes. */
export function headingAnchors(text: string): Set<string> {
  const anchors = new Set<string>();
  const seen = new Map<string, number>();
  for (const line of splitFences(text).prose) {
    const m = /^ {0,3}#{1,6}\s+(.*?)\s*#*\s*$/.exec(line);
    if (m?.[1] === undefined) continue;
    const plain = m[1].replace(/`([^`]*)`/g, "$1").replace(/\[([^\]]*)\]\([^)]*\)/g, "$1");
    const base = slugify(plain);
    const n = seen.get(base) ?? 0;
    seen.set(base, n + 1);
    anchors.add(n === 0 ? base : `${base}-${n}`);
  }
  return anchors;
}

/** Link targets in prose (fenced code is skipped; inline code spans are removed). */
export function extractLinks(text: string): { line: number; target: string }[] {
  const out: { line: number; target: string }[] = [];
  splitFences(text).prose.forEach((raw, i) => {
    const line = raw.replace(/`+[^`]*`+/g, "");
    const def = REF_DEF.exec(line);
    if (def?.[1] !== undefined) out.push({ line: i + 1, target: def[1] });
    for (const m of line.matchAll(INLINE_LINK)) {
      if (m[1] !== undefined) out.push({ line: i + 1, target: m[1] });
    }
  });
  return out;
}

export function checkDocLinks(root: string, files = listMarkdownFiles(root)): LinkProblem[] {
  const problems: LinkProblem[] = [];
  const anchorCache = new Map<string, Set<string>>();
  const anchorsOf = (abs: string): Set<string> => {
    let a = anchorCache.get(abs);
    if (a === undefined) {
      a = headingAnchors(readFileSync(abs, "utf8"));
      anchorCache.set(abs, a);
    }
    return a;
  };
  for (const file of files) {
    const abs = join(root, file);
    const text = readFileSync(abs, "utf8");
    for (const { line, target } of extractLinks(text)) {
      if (SCHEME.test(target) || target.startsWith("//")) continue;
      const hashAt = target.indexOf("#");
      const pathPart = hashAt === -1 ? target : target.slice(0, hashAt);
      const fragment = hashAt === -1 ? undefined : decodeURIComponent(target.slice(hashAt + 1));
      let resolved = abs;
      if (pathPart !== "") {
        resolved = normalize(resolve(dirname(abs), decodeURIComponent(pathPart)));
        if (!resolved.startsWith(resolve(root))) {
          problems.push({ file, line, target, reason: "points outside the repository" });
          continue;
        }
        if (!existsSync(resolved)) {
          problems.push({ file, line, target, reason: "file does not exist" });
          continue;
        }
      }
      if (
        fragment !== undefined &&
        fragment !== "" &&
        resolved.endsWith(".md") &&
        statSync(resolved).isFile() &&
        !anchorsOf(resolved).has(fragment.toLowerCase())
      ) {
        problems.push({ file, line, target, reason: "no heading with this anchor" });
      }
    }
  }
  return problems;
}

if (import.meta.main) {
  const root = process.cwd();
  const files = listMarkdownFiles(root);
  const problems = checkDocLinks(root, files);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.target} (${p.reason})`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} broken link(s) in ${files.length} Markdown files.`);
    process.exit(1);
  }
  console.log(`Doc links OK: ${files.length} Markdown files checked.`);
}
