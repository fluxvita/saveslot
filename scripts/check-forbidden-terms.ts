// Checks that a list of forbidden terms appears nowhere in the repository: not in any tracked
// file or path, and in a merge request pipeline not in its commit messages or its title. Also
// checks that code and the spec do not cite ruling numbers (they cite spec sections instead).
//
// Usage: node scripts/check-forbidden-terms.ts
// The terms come from $SAVESLOT_FORBIDDEN_TERMS_B64: base64 of newline-separated terms. The list
// is not part of the repository. Output names a term only by its index in the list, never by its
// text, so the list does not reach CI logs. Without the variable the term check fails in the
// project's own pipelines ($CI_PROJECT_PATH = agentx/saveslot) and is skipped elsewhere (forks,
// local runs). In a merge request pipeline, commit messages of
// $CI_MERGE_REQUEST_DIFF_BASE_SHA..HEAD and $CI_MERGE_REQUEST_TITLE are checked too.

import { execFileSync } from "node:child_process";
import { readFileSync } from "node:fs";
import { join } from "node:path";

export const PROJECT_PATH = "agentx/saveslot";

/**
 * Ruling numbers are internal; code and the spec cite spec sections. Any number from R100 up (the
 * rulings run past R299); two digits or a leading zero are not one.
 */
export const RULING_REF = /\bR[1-9][0-9]{2,}\b/;
export const RULING_SCOPES = ["packages/", "docs/zh-CN/spec/", "docs/zh-CN/guide/"];

export interface Hit {
  /** "path:line", "path (file name)", "commit <sha>:line" or "MR title". */
  where: string;
  /** Index (from 1) of the term in the list; undefined for a ruling-number reference. */
  term?: number;
}

/** Newline-separated terms from base64; blank lines and surrounding spaces ignored. */
export function decodeTerms(b64: string): string[] {
  return Buffer.from(b64, "base64")
    .toString("utf8")
    .split(/\r?\n/)
    .map((t) => t.trim())
    .filter((t) => t !== "");
}

const WORD = /[\p{L}\p{N}_]/u;

/**
 * A case-insensitive matcher for one term. Word boundaries apply at an end of the term whose
 * character is a Latin letter, digit or underscore; at other ends (CJK text, punctuation) the term
 * matches as written, since such text has no spaces between words.
 */
export function termMatcher(term: string): RegExp {
  const escaped = term.replace(/[.*+?^${}()|[\]\\]/g, "\\$&").replace(/\s+/g, "\\s+");
  const latin = /[A-Za-z0-9_]/;
  const first = term[0] ?? "";
  const last = term[term.length - 1] ?? "";
  const before = latin.test(first) ? `(?<!${WORD.source})` : "";
  const after = latin.test(last) ? `(?!${WORD.source})` : "";
  return new RegExp(`${before}${escaped}${after}`, "iu");
}

/** Hits of the terms in a text, one per (line, term), with `where` built from the line number. */
export function scanText(
  text: string,
  matchers: readonly RegExp[],
  where: (line: number) => string,
): Hit[] {
  const hits: Hit[] = [];
  const lines = text.split("\n");
  lines.forEach((line, i) => {
    matchers.forEach((m, t) => {
      if (m.test(line)) hits.push({ where: where(i + 1), term: t + 1 });
    });
  });
  return hits;
}

function isBinary(buf: Buffer): boolean {
  return buf.subarray(0, 8000).includes(0);
}

/** Tracked files of the repository at `root`. */
export function trackedFiles(root: string): string[] {
  return execFileSync("git", ["ls-files", "-z"], { cwd: root, encoding: "utf8" })
    .split("\0")
    .filter((p) => p !== "");
}

export interface ScanInput {
  root: string;
  files: readonly string[];
  terms: readonly string[];
  commits?: readonly { sha: string; message: string }[];
  title?: string;
}

/** All hits: terms in paths, file contents, commit messages and the title; ruling references. */
export function scan(input: ScanInput): Hit[] {
  const matchers = input.terms.map(termMatcher);
  const hits: Hit[] = [];
  for (const path of input.files) {
    hits.push(...scanText(path, matchers, () => `${path} (file name)`));
    const buf = readFileSync(join(input.root, path));
    if (isBinary(buf)) continue;
    const text = buf.toString("utf8");
    hits.push(...scanText(text, matchers, (line) => `${path}:${line}`));
    if (RULING_SCOPES.some((s) => path.startsWith(s))) {
      text.split("\n").forEach((line, i) => {
        if (RULING_REF.test(line)) hits.push({ where: `${path}:${i + 1}` });
      });
    }
  }
  for (const c of input.commits ?? []) {
    hits.push(...scanText(c.message, matchers, (line) => `commit ${c.sha.slice(0, 12)}:${line}`));
  }
  if (input.title !== undefined) {
    hits.push(...scanText(input.title, matchers, () => "MR title"));
  }
  return hits;
}

/** One line per hit. Names a term by index only. */
export function formatHit(h: Hit): string {
  return h.term === undefined
    ? `${h.where}: ruling-number reference (cite the spec section instead)`
    : `${h.where}: forbidden term #${h.term}`;
}

function commitsIn(range: string): { sha: string; message: string }[] {
  const SEP = "\u001e";
  return execFileSync("git", ["log", `--format=%H%n%B${SEP}`, range], { encoding: "utf8" })
    .split(SEP)
    .map((s) => s.replace(/^\n/, ""))
    .filter((s) => s.trim() !== "")
    .map((s) => {
      const [sha = "", ...rest] = s.split("\n");
      return { sha, message: rest.join("\n") };
    });
}

if (import.meta.main) {
  const env = process.env;
  const b64 = env["SAVESLOT_FORBIDDEN_TERMS_B64"];
  let terms: string[] = [];
  if (b64 === undefined || b64.trim() === "") {
    if (env["CI_PROJECT_PATH"] === PROJECT_PATH) {
      console.error("SAVESLOT_FORBIDDEN_TERMS_B64 is not set; it is required in this project.");
      process.exit(1);
    }
    console.warn(
      "Warning: SAVESLOT_FORBIDDEN_TERMS_B64 is not set; checking ruling references only.",
    );
  } else {
    terms = decodeTerms(b64);
    if (terms.length === 0) {
      console.error("SAVESLOT_FORBIDDEN_TERMS_B64 decodes to an empty list.");
      process.exit(1);
    }
  }
  const base = env["CI_MERGE_REQUEST_DIFF_BASE_SHA"];
  const title = env["CI_MERGE_REQUEST_TITLE"];
  const root = process.cwd();
  const hits = scan({
    root,
    files: trackedFiles(root),
    terms,
    ...(base ? { commits: commitsIn(`${base}..HEAD`) } : {}),
    ...(title !== undefined ? { title } : {}),
  });
  for (const h of hits) console.error(formatHit(h));
  if (hits.length > 0) {
    console.error(`\n${hits.length} problem(s). Terms are named by their index in the list only.`);
    process.exit(1);
  }
  const scope = base ? ", commit messages and the MR title" : "";
  console.log(`Forbidden terms OK: ${terms.length} term(s) checked in tracked files${scope}.`);
}
