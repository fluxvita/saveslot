// Generates packages/kernel/src/request/keymatch/data.ts, the Unicode data of keymatch@1, from the
// Unicode Character Database 17.0.0 in third_party/unicode/17.0.0 (as published, unchanged).
//
// docs/zh-CN/spec/03-data-model/10-types-and-units.md «相近的键»: the data is fixed with keymatch@1
// and packaged in the kernel, generated from the data files, never copied by hand; NFKC and case
// folding use one Unicode version. The kernel's tests generate it again from the same files and
// compare it byte for byte with the committed one (keymatch.test.ts), offline.
//
//   node scripts/gen-keymatch.ts
//
// What is generated:
// - the canonical combining class of each code point that has one (not 0);
// - each code point's full compatibility decomposition (the mappings of UnicodeData.txt applied
//   until none applies), Hangul syllables left out (decomposed by the algorithm, Unicode §3.12);
// - the primary composites: canonical decompositions of two code points whose result is not
//   excluded from composition (Full_Composition_Exclusion, DerivedNormalizationProps.txt);
// - simple case folding: CaseFolding.txt's statuses C and S;
// - White_Space (PropList.txt).

import { readFileSync, writeFileSync } from "node:fs";

const DIR = new URL("../third_party/unicode/17.0.0/", import.meta.url);
const OUT = new URL("../packages/kernel/src/request/keymatch/data.ts", import.meta.url);
export const VERSION = "17.0.0";
/** The files read, by name. */
export const FILES = [
  "UnicodeData.txt",
  "DerivedNormalizationProps.txt",
  "CaseFolding.txt",
  "PropList.txt",
] as const;

export interface Tables {
  readonly ccc: ReadonlyMap<number, number>;
  readonly decompose: ReadonlyMap<number, readonly number[]>;
  readonly compose: ReadonlyMap<string, number>;
  readonly fold: ReadonlyMap<number, number>;
  readonly space: ReadonlySet<number>;
}

const hex = (s: string) => Number.parseInt(s, 16);
/** The data lines of a UCD file: comments and blank lines left out, fields trimmed. */
const lines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.replace(/#.*/, "").trim())
    .filter((l) => l.length > 0)
    .map((l) => l.split(";").map((f) => f.trim()));
/** "0041" or "0041..005A" → the code points. */
function range(s: string): number[] {
  const [a, b] = s.split("..");
  const from = hex(a as string);
  const to = b === undefined ? from : hex(b);
  return Array.from({ length: to - from + 1 }, (_, i) => from + i);
}

const SBASE = 0xac00;
const SCOUNT = 11172;

export function build(files: Readonly<Record<(typeof FILES)[number], string>>): Tables {
  const ccc = new Map<number, number>();
  const raw = new Map<number, { canonical: boolean; to: number[] }>();
  for (const f of lines(files["UnicodeData.txt"])) {
    const cp = hex(f[0] as string);
    const c = Number(f[3]);
    if (c !== 0) ccc.set(cp, c);
    const d = f[5] ?? "";
    if (d === "") continue;
    const canonical = !d.startsWith("<");
    const to = d
      .replace(/^<[^>]*>\s*/, "")
      .split(" ")
      .map(hex);
    raw.set(cp, { canonical, to });
  }
  // Full decomposition: each mapping applied until none applies.
  const full = (cp: number): number[] => {
    const m = raw.get(cp);
    return m === undefined ? [cp] : m.to.flatMap(full);
  };
  const decompose = new Map<number, number[]>();
  for (const cp of raw.keys()) {
    if (cp >= SBASE && cp < SBASE + SCOUNT) continue;
    decompose.set(cp, full(cp));
  }
  const excluded = new Set<number>();
  for (const f of lines(files["DerivedNormalizationProps.txt"])) {
    if (f[1] === "Full_Composition_Exclusion")
      for (const cp of range(f[0] as string)) excluded.add(cp);
  }
  const compose = new Map<string, number>();
  for (const [cp, m] of raw) {
    if (!m.canonical || m.to.length !== 2 || excluded.has(cp)) continue;
    compose.set(`${m.to[0]} ${m.to[1]}`, cp);
  }
  const fold = new Map<number, number>();
  for (const f of lines(files["CaseFolding.txt"])) {
    if (f[1] !== "C" && f[1] !== "S") continue;
    fold.set(hex(f[0] as string), hex(f[2] as string));
  }
  const space = new Set<number>();
  for (const f of lines(files["PropList.txt"])) {
    if (f[1] === "White_Space") for (const cp of range(f[0] as string)) space.add(cp);
  }
  return { ccc, decompose, compose, fold, space };
}

const h = (n: number) => n.toString(16);
/** Entries of a sorted map, joined: `key=value`, `;` between. */
const entries = <K, V>(m: ReadonlyMap<K, V>, key: (k: K) => string, value: (v: V) => string) =>
  [...m].map(([k, v]) => `${key(k)}=${value(v)}`).join(";");

/** The generated module: each table a string of hexadecimal code points, read when loaded. */
export function render(t: Tables): string {
  const byKey = <V>(m: ReadonlyMap<number, V>) => new Map([...m].sort((a, b) => a[0] - b[0]));
  const pairs = new Map(
    [...t.compose].sort((a, b) => a[1] - b[1]).map(([k, v]) => [k, v] as const),
  );
  const wrap = (s: string) => {
    // A long string in lines of at most 96 characters, concatenated.
    const parts: string[] = [];
    for (let i = 0; i < s.length; i += 96) parts.push(JSON.stringify(s.slice(i, i + 96)));
    return parts.length === 0 ? '""' : parts.join(" +\n  ");
  };
  return `// Generated by scripts/gen-keymatch.ts from the Unicode Character Database ${VERSION}
// (third_party/unicode/${VERSION}). Do not edit by hand: change the script and run it again.
/* biome-ignore-all format: generated */

/** The Unicode version of keymatch@1's data. */
export const UNICODE_VERSION = "${VERSION}";

/** Canonical combining classes not 0: \`cp=class\`. */
export const CCC =
  ${wrap(entries(byKey(t.ccc), h, h))};

/** Full compatibility decompositions, Hangul syllables left out: \`cp=cp cp …\`. */
export const DECOMPOSE =
  ${wrap(entries(byKey(t.decompose), h, (v) => v.map(h).join(" ")))};

/** Primary composites: \`first second=composite\`. */
export const COMPOSE =
  ${wrap(
    entries(
      pairs,
      (k) =>
        k
          .split(" ")
          .map((x) => h(Number(x)))
          .join(" "),
      h,
    ),
  )};

/** Simple case folding (statuses C and S): \`cp=cp\`. */
export const FOLD =
  ${wrap(entries(byKey(t.fold), h, h))};

/** White_Space. */
export const WHITE_SPACE =
  ${wrap(
    [...t.space]
      .sort((a, b) => a - b)
      .map(h)
      .join(";"),
  )};
`;
}

/** The source files as read from the repository. */
export function readFiles(): Record<(typeof FILES)[number], string> {
  return Object.fromEntries(FILES.map((f) => [f, readFileSync(new URL(f, DIR), "utf8")])) as Record<
    (typeof FILES)[number],
    string
  >;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  writeFileSync(OUT, render(build(readFiles())));
}
