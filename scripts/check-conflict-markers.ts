// Checks that no tracked text file holds a line a merge conflict leaves behind: one that starts
// with `<<<<<<< ` or `>>>>>>> `. A conflict resolved by hand can keep one of these lines, and
// nothing else notices it in a Markdown file.
//
// Usage: node scripts/check-conflict-markers.ts
// A line of `=======` alone is not looked for: Markdown underlines a heading with it.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { trackedFiles } from "./check-forbidden-terms.ts";

const MARKER = /^(?:<{7}|>{7}) /;

/** The numbers (from 1) of the lines of a text that start with a conflict marker. */
export function markerLines(text: string): number[] {
  const out: number[] = [];
  text.split("\n").forEach((line, i) => {
    if (MARKER.test(line)) out.push(i + 1);
  });
  return out;
}

/** "path:line" for each conflict marker in the tracked text files of the repository at `root`. */
export function checkConflictMarkers(root: string): { hits: string[]; files: number } {
  const hits: string[] = [];
  let files = 0;
  for (const file of trackedFiles(root)) {
    let buf: Buffer;
    try {
      buf = readFileSync(join(root, file));
    } catch {
      // Tracked but not in the working tree (deleted and not yet committed), or a directory link.
      continue;
    }
    if (buf.subarray(0, 8000).includes(0)) continue;
    files++;
    for (const line of markerLines(buf.toString("utf8"))) hits.push(`${file}:${line}`);
  }
  return { hits, files };
}

if (import.meta.main) {
  const { hits, files } = checkConflictMarkers(process.cwd());
  for (const h of hits) console.error(`${h}: a merge conflict marker`);
  if (hits.length > 0) {
    console.error(
      `\n${hits.length} line(s) start with a merge conflict marker. Finish resolving the conflict and delete the line.`,
    );
    process.exit(1);
  }
  console.log(`Conflict markers OK: ${files} tracked text files, none has one.`);
}
