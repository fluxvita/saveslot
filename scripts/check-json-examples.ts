// Checks that every ```json code block in the repository's Markdown files parses as JSON.
// A block may also be a fragment of object members (`"key": value, ...`): it passes when it
// parses after being wrapped in braces. Examples that are deliberately not JSON (elisions,
// annotations) belong in a block with another info string, such as ```text.

import { readFileSync } from "node:fs";
import { join } from "node:path";
import { listMarkdownFiles, splitFences } from "./markdown.ts";

export interface JsonProblem {
  file: string;
  line: number;
  error: string;
}

/** Undefined when `body` is a JSON value or a fragment of object members; else the parse error. */
export function parseError(body: string): string | undefined {
  try {
    JSON.parse(body);
    return undefined;
  } catch (e) {
    try {
      JSON.parse(`{${body}}`);
      return undefined;
    } catch {
      return (e as Error).message;
    }
  }
}

export function checkJsonExamples(
  root: string,
  files = listMarkdownFiles(root),
): { problems: JsonProblem[]; blocks: number } {
  const problems: JsonProblem[] = [];
  let blocks = 0;
  for (const file of files) {
    for (const block of splitFences(readFileSync(join(root, file), "utf8")).blocks) {
      if (block.info.split(/\s+/)[0]?.toLowerCase() !== "json") continue;
      blocks++;
      const error = parseError(block.body);
      if (error !== undefined) problems.push({ file, line: block.line, error });
    }
  }
  return { problems, blocks };
}

if (import.meta.main) {
  const root = process.cwd();
  const { problems, blocks } = checkJsonExamples(root);
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.error}`);
  if (problems.length > 0) {
    console.error(`\n${problems.length} of ${blocks} JSON example(s) do not parse.`);
    process.exit(1);
  }
  console.log(`JSON examples OK: ${blocks} blocks parsed.`);
}
