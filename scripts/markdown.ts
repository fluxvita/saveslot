// Shared helpers for the documentation checks.

import { readdirSync } from "node:fs";
import { join, relative } from "node:path";

const SKIP_DIRS = new Set(["node_modules", "dist", ".git", ".obsidian", ".worktrees", "coverage"]);

/** All Markdown files under `root`, as paths relative to `root`, sorted. */
export function listMarkdownFiles(root: string): string[] {
  const out: string[] = [];
  const walk = (dir: string): void => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      if (entry.isDirectory()) {
        if (!SKIP_DIRS.has(entry.name)) walk(join(dir, entry.name));
      } else if (entry.isFile() && entry.name.endsWith(".md")) {
        out.push(relative(root, join(dir, entry.name)));
      }
    }
  };
  walk(root);
  return out.sort();
}

export interface FencedBlock {
  /** Info string after the opening fence, e.g. "json". */
  info: string;
  /** 1-based line number of the first content line. */
  line: number;
  body: string;
}

const FENCE = /^ {0,3}(`{3,}|~{3,})(.*)$/;

/**
 * Splits Markdown into fenced code blocks and the remaining prose lines.
 * Prose lines inside a fence are replaced by empty strings so line numbers stay stable.
 */
export function splitFences(text: string): { blocks: FencedBlock[]; prose: string[] } {
  const lines = text.split("\n");
  const blocks: FencedBlock[] = [];
  const prose: string[] = [];
  let open: { marker: string; info: string; start: number; body: string[] } | undefined;
  lines.forEach((line, i) => {
    const m = FENCE.exec(line);
    if (open === undefined) {
      if (m?.[1] !== undefined) {
        open = { marker: m[1], info: (m[2] ?? "").trim(), start: i + 2, body: [] };
        prose.push("");
      } else {
        prose.push(line);
      }
      return;
    }
    const closing = m?.[1];
    if (
      closing !== undefined &&
      closing[0] === open.marker[0] &&
      closing.length >= open.marker.length &&
      (m?.[2] ?? "").trim() === ""
    ) {
      blocks.push({ info: open.info, line: open.start, body: open.body.join("\n") });
      open = undefined;
    } else {
      open.body.push(line);
    }
    prose.push("");
  });
  if (open !== undefined) {
    blocks.push({ info: open.info, line: open.start, body: open.body.join("\n") });
  }
  return { blocks, prose };
}
