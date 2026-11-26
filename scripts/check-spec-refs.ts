// Checks the references to the specification in the code: every `«…»` in a TypeScript file of
// packages/ and scripts/ names a heading or a bold item of the specification
// (docs/zh-CN/spec), in the file the reference names when it names one.
//
// A reference is written as the file, then the title in `«»`, as the specification has it (in
// Chinese while the specification is): `05-time «挡点»`, `04-contract §5.2 «状态类表的区间»`,
// `03-deletion.md «重放规则 · 人的决定»`.
//
// - The file is the last one named before the `«`, on the same line or, in a comment, on the
//   comment's earlier lines: a file's number (`07`), its name with or without the number and
//   `.md` (`07-schema-evolution`, `write-and-read`), or `data-model` for any file of
//   03-data-model. A name that is a file's whole name is that file alone: `04-contract` is
//   04-contract.md, not 04-contract-types.md. A name cut short at a hyphen stands for a file
//   only when one file starts with it (`02-integrity` for 02-integrity-and-records.md). A number
//   names every file that starts with it (07-scope-v1.md and 03-data-model/07-schema-evolution.md).
//   With no file named, any file will do; a name that starts with a file's number and is no file
//   of the specification (`04-contrakt`, `99 §2`) is reported, not passed over.
// - A title is a heading, a bold item, or the first cell of a table row; of `A：B`, `A` alone
//   will do. It is compared without code marks, a leading section number and a closing colon.
//   `A · B` names B under A: both must be titles of the file.
//
// What is quoted from the specification's running text is not a reference: write it in plain
// quotation marks.
//
// Not checked:
// - What stands in plain quotation marks. Whoever writes a quotation sees that the named file has
//   those words.
// - Section numbers: `07 §99 «取舍原则»` passes when 07 has the title, whatever its section is.
// - The order of `A · B`: both are titles of the file, B need not stand under A.
// - That a title is a heading: the first cell of every table row counts (some six thousand
//   titles in all), so a reference to a row such as `«insert»` passes in any file with that row.
// - A name without a number that is no file (`contrakt «…»`): it reads as an ordinary word, and
//   the reference is then looked for in the file named before it, or in any file.
// - Anything but the `.ts` files of packages/ and scripts/: other file types, the documents, and
//   the root's own files are not read.

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { basename, join } from "node:path";
import { splitFences } from "./markdown.ts";

export const SPEC_DIR = "docs/zh-CN/spec";
/** Where references are looked for; golden files are data, not code. */
export const CODE_DIRS = ["packages", "scripts"];

export interface SpecRefProblem {
  file: string;
  line: number;
  ref: string;
  reason: string;
}

/** A title as it is compared: no code marks, no leading section number, no closing colon. */
export function titleOf(text: string): string {
  return text
    .replaceAll("`", "")
    .trim()
    .replace(/^(?:(?:§\s*)?\d+(?:\.\d+)*\.?|[①-⑳])\s+/, "")
    .replace(/\s+/g, " ")
    .replace(/[：:。.]+$/, "")
    .trim();
}

/**
 * The titles of a Markdown text: its headings, its bold items, and the first cell of each table
 * row (a table's rows are named by it). A heading or bold item `A：B` is also titled `A`, and one
 * that ends in a code span or in brackets (`版本标记 \`ver\``, `引用字段（\`ref\`）`) also by what stands
 * before it.
 */
export function titlesIn(markdown: string): Set<string> {
  const titles = new Set<string>();
  const add = (text: string) => {
    titles.add(titleOf(text));
    titles.add(titleOf(text.replace(/\s*(?:`[^`]*`|（[^（）]*）|\([^()]*\))\s*$/, "")));
    const lead = /^(.+?)[：:]/.exec(titleOf(text));
    if (lead?.[1] !== undefined) titles.add(lead[1].trim());
  };
  for (const line of splitFences(markdown).prose) {
    const heading = /^#{1,6}\s+(.*)$/.exec(line);
    if (heading !== null) add(heading[1] ?? "");
    for (const m of line.matchAll(/\*\*(.+?)\*\*/g)) add(m[1] ?? "");
    const cell = /^\s*\|([^|]+)\|/.exec(line);
    if (cell !== null) add((cell[1] ?? "").replaceAll("**", ""));
  }
  titles.delete("");
  return titles;
}

function walk(dir: string, keep: (file: string) => boolean, out: string[] = []): string[] {
  if (!existsSync(dir)) return out;
  for (const e of readdirSync(dir, { withFileTypes: true })) {
    if (e.name === "node_modules" || e.name === "dist" || e.name.startsWith(".")) continue;
    const at = join(dir, e.name);
    if (e.isDirectory()) walk(at, keep, out);
    else if (keep(at)) out.push(at);
  }
  return out;
}

/** The specification's files (from the repository root) and their titles. */
export function specTitles(root: string): Map<string, Set<string>> {
  const titles = new Map<string, Set<string>>();
  for (const at of walk(join(root, SPEC_DIR), (f) => f.endsWith(".md")).sort()) {
    titles.set(at.slice(root.length + 1), titlesIn(readFileSync(at, "utf8")));
  }
  return titles;
}

/**
 * What can name a file: its name with or without its number, and `.md` or not; or its number
 * alone, where a section number or a reference follows it (`07 §3`, `07 «…»`), so that no other
 * number is taken for one.
 */
const NAME =
  /(?<![\w.§-])((?:\d\d(?:-[a-z0-9]+)+|[a-z]+(?:-[a-z0-9]+)+)(?:\.md)?|\d\d(?=\s*(?:§|«|$)))(?![\w-])/g;

/** The specification files a name stands for; none when it is not a file's name. */
export function filesNamed(name: string, files: readonly string[]): string[] {
  const n = name.replace(/\.md$/, "");
  if (n === "data-model" || n === "03-data-model")
    return files.filter((f) => f.includes("/03-data-model/"));
  if (/^\d\d$/.test(n)) return files.filter((f) => basename(f, ".md").startsWith(`${n}-`));
  const as = (f: string) =>
    /^\d\d-/.test(n) ? basename(f, ".md") : basename(f, ".md").replace(/^\d\d-/, "");
  const whole = files.filter((f) => as(f) === n);
  if (whole.length > 0) return whole;
  const cut = files.filter((f) => as(f).startsWith(`${n}-`));
  return cut.length === 1 ? cut : [];
}

/**
 * Whether a name can only be meant as a file: a number and a name (`04-contrakt`; `11-05` is a
 * date), or a number alone with a section number after it (`99 §2`).
 */
const meantAsFile = (name: string, after: string): boolean =>
  /^\d\d-[a-z0-9-]*[a-z]/.test(name) || (/^\d\d$/.test(name) && /^\s*§/.test(after));

const COMMENT = /^\s*(?:\/\/|\/\*|\*)/;

export interface SpecRef {
  line: number;
  ref: string;
  /** The specification files named before the reference; empty when none is. */
  named: string[];
  /** The name before the reference, when it starts with a number and is no file. */
  unknown?: string;
}

/**
 * The references of a source text, each with the files named for it: by the last name before it
 * that is a file of the specification, on its line or, in a comment, on the comment's earlier
 * lines. A name that starts with a number and is no file is not passed over for an earlier one:
 * the reference is given it as `unknown`.
 */
export function refsIn(source: string, files: readonly string[]): SpecRef[] {
  const lines = source.split("\n");
  type Named = { files: string[]; unknown?: string };
  const lastNamed = (text: string): Named | undefined =>
    [...text.matchAll(NAME)]
      .map((m): Named => {
        const name = m[1] ?? "";
        const found = filesNamed(name, files);
        const after = text.slice(m.index + m[0].length);
        return found.length === 0 && meantAsFile(name, after)
          ? { files: [], unknown: name }
          : { files: found };
      })
      .findLast((n) => n.files.length > 0 || n.unknown !== undefined);
  const out: SpecRef[] = [];
  lines.forEach((text, i) => {
    for (const m of text.matchAll(/«([^»]*)»/g)) {
      let named = lastNamed(text.slice(0, m.index).replace(/«[^»]*»/g, "«»"));
      for (let k = i - 1; named === undefined && k >= 0 && COMMENT.test(lines[k] ?? ""); k--) {
        if (!COMMENT.test(text)) break;
        named = lastNamed((lines[k] ?? "").replace(/«[^»]*»/g, "«»"));
      }
      out.push({
        line: i + 1,
        ref: m[1] ?? "",
        named: named?.files ?? [],
        ...(named?.unknown !== undefined ? { unknown: named.unknown } : {}),
      });
    }
  });
  return out;
}

function resolves(ref: string, titles: Set<string>): boolean {
  if (titles.has(titleOf(ref))) return true;
  const parts = ref.split(/\s·\s/).map(titleOf);
  return parts.length > 1 && parts.every((p) => titles.has(p));
}

export function checkSpecRefs(root: string): {
  problems: SpecRefProblem[];
  refs: number;
  files: number;
} {
  const titles = specTitles(root);
  const specFiles = [...titles.keys()];
  const problems: SpecRefProblem[] = [];
  let refs = 0;
  let files = 0;
  for (const dir of CODE_DIRS) {
    const sources = walk(
      join(root, dir),
      (f) =>
        f.endsWith(".ts") && !f.includes("/golden/") && !/check-spec-refs(\.test)?\.ts$/.test(f),
    );
    for (const at of sources.sort()) {
      const found = refsIn(readFileSync(at, "utf8"), specFiles);
      if (found.length === 0) continue;
      files++;
      for (const r of found) {
        refs++;
        if (r.unknown !== undefined) {
          problems.push({
            file: at.slice(root.length + 1),
            line: r.line,
            ref: r.ref,
            reason: `«${r.ref}» is said to be in ${r.unknown}, which is no file of the specification`,
          });
          continue;
        }
        const named = r.named;
        const where = named.length > 0 ? named : specFiles;
        if (where.some((f) => resolves(r.ref, titles.get(f) ?? new Set()))) continue;
        problems.push({
          file: at.slice(root.length + 1),
          line: r.line,
          ref: r.ref,
          reason:
            named.length > 0
              ? `no heading or bold item «${r.ref}» in ${named.join(" or ")}`
              : `no heading or bold item «${r.ref}» in the specification`,
        });
      }
    }
  }
  return { problems, refs, files };
}

if (import.meta.main) {
  const { problems, refs, files } = checkSpecRefs(process.cwd());
  for (const p of problems) console.error(`${p.file}:${p.line}: ${p.reason}`);
  if (problems.length > 0) {
    console.error(
      `\n${problems.length} reference(s) to the specification do not resolve. Name the title as ${SPEC_DIR} has it (a heading or a bold item); what is quoted from running text goes in plain quotation marks, not «».`,
    );
    process.exit(1);
  }
  console.log(`Spec references OK: ${refs} references in ${files} files.`);
}
