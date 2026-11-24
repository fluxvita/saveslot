// keymatch@1 (docs/zh-CN/spec/03-data-model/10-types-and-units.md «相近的键»): the data generated
// from the Unicode Character Database 17.0.0 as committed (third_party/unicode/17.0.0: the files'
// digests, the tables generated again byte for byte, offline); NFKC against NormalizationTest.txt
// in full; simple case folding and White_Space code point by code point; the spec's test vectors.

import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { build, FILES, readFiles, render } from "../../../../../scripts/gen-keymatch.ts";
import {
  distance,
  distanceWithin,
  foldKey,
  matchFolded,
  matchKey,
  matchText,
  nfkc,
  UNICODE_VERSION,
} from "./index.ts";

const DIR = new URL("../../../../../third_party/unicode/17.0.0/", import.meta.url);
const read = (f: string) => readFileSync(new URL(f, DIR), "utf8");
const hex = (s: string) => Number.parseInt(s, 16);
const cps = (s: string) => s.trim().split(" ").map(hex);
const str = (xs: readonly number[]) => String.fromCodePoint(...xs);

describe("the data", () => {
  it("the source files match their digests in SHA256SUMS", () => {
    for (const line of read("SHA256SUMS").trim().split("\n")) {
      const [digest, name] = line.split(/\s+/) as [string, string];
      const actual = createHash("sha256")
        .update(readFileSync(new URL(name, DIR)))
        .digest("hex");
      expect({ name, digest: actual }).toEqual({ name, digest });
    }
    expect(UNICODE_VERSION).toBe("17.0.0");
  });

  it("the committed tables are what the script generates from them, byte for byte", () => {
    const committed = readFileSync(new URL("./data.ts", import.meta.url), "utf8");
    expect(render(build(readFiles()))).toBe(committed);
    expect(FILES.length).toBeGreaterThan(0);
  });
});

describe("NFKC (NormalizationTest.txt)", () => {
  const text = read("NormalizationTest.txt");
  const listed = new Set<number>();
  let part = "";
  const rows: string[][] = [];
  const counts = new Map<string, number>();
  for (const line of text.split("\n")) {
    if (line.startsWith("@Part")) {
      part = line.split(" ")[0] as string;
      continue;
    }
    const data = line.replace(/#.*/, "").trim();
    if (data === "") continue;
    const f = data.split(";");
    rows.push(f);
    counts.set(part, (counts.get(part) ?? 0) + 1);
    if (part === "@Part1") listed.add(hex(f[0] as string));
  }

  it("c4 = NFKC(c1) = NFKC(c2) = NFKC(c3) = NFKC(c4) = NFKC(c5), every line", () => {
    let bad = 0;
    const first: string[] = [];
    for (const f of rows) {
      const c4 = cps(f[3] as string);
      for (const i of [0, 1, 2, 3, 4]) {
        const got = nfkc(cps(f[i] as string));
        if (got.join(" ") !== c4.join(" ")) {
          bad++;
          if (first.length < 5)
            first.push(
              `${f.slice(0, 5).join(";")} c${i + 1} → ${got.map((x) => x.toString(16)).join(" ")}`,
            );
        }
      }
    }
    expect({ bad, first }).toEqual({ bad: 0, first: [] });
    // Every part read, each its whole (NormalizationTest-17.0.0.txt).
    expect(Object.fromEntries(counts)).toEqual({
      "@Part0": 45,
      "@Part1": 17086,
      "@Part2": 1936,
      "@Part3": 194,
      "@Part4": 735,
      "@Part5": 38,
    });
  });

  it("a code point not in part 1 is its own NFKC", () => {
    const bad: number[] = [];
    for (let cp = 0; cp <= 0x10ffff; cp++) {
      if (cp >= 0xd800 && cp <= 0xdfff) continue;
      if (listed.has(cp)) continue;
      const got = nfkc([cp]);
      if (got.length !== 1 || got[0] !== cp) bad.push(cp);
    }
    expect(bad.slice(0, 5)).toEqual([]);
  });
});

describe("Hangul at its edges (Unicode §3.12)", () => {
  it("a T of index 0 (U+11A7) does not join an LV; nor does a T after a mark between", () => {
    expect(nfkc([0xac00, 0x11a7])).toEqual([0xac00, 0x11a7]);
    expect(nfkc([0xac00, 0x0301, 0x11a8])).toEqual([0xac00, 0x0301, 0x11a8]);
    // And the T that does: 가 + ᆨ = 각.
    expect(nfkc([0xac00, 0x11a8])).toEqual([0xac01]);
  });
});

describe("long keys", () => {
  it("a key of 200 code points against 5,000 others, folded once: well under the full distance's time", () => {
    const fresh = foldKey("推".repeat(199) + "x");
    const others = Array.from({ length: 5000 }, (_, i) =>
      foldKey(`${"推".repeat(190 + (i % 20))}${String(i)}`),
    );
    const start = performance.now();
    let alike = 0;
    for (const o of others) if (matchFolded(fresh, o) !== undefined) alike++;
    const ms = performance.now() - start;
    // The full O(n·m) distance took about 700 ms here; the bounded one a few tens.
    expect({ under: ms < 250 }).toEqual({ under: true });
    expect(alike).toBeGreaterThan(0);
  });

  it("two keys of 200,000 code points differing in one: no row ends it early, yet linear", () => {
    const a = Array.from({ length: 200_000 }, (_, i) => 0x4e00 + (i % 500));
    const b = [...a];
    b[100_000] = 0x41;
    const start = performance.now();
    const d = distanceWithin(a, b, 2);
    const ms = performance.now() - start;
    expect(d).toBe(1);
    // A row allocated whole made this quadratic: 200,000 rows of 200,001 cells.
    expect({ under: ms < 250 }).toEqual({ under: true });
  });
});

describe("simple case folding and White_Space", () => {
  it("each C and S line of CaseFolding.txt folds its code point; others are kept", () => {
    const folds = new Map<number, number>();
    for (const line of read("CaseFolding.txt").split("\n")) {
      const f = line
        .replace(/#.*/, "")
        .split(";")
        .map((x) => x.trim());
      if (f[1] === "C" || f[1] === "S") folds.set(hex(f[0] as string), hex(f[2] as string));
    }
    expect(folds.size).toBeGreaterThan(1400);
    // Each folded alone, on a code point NFKC keeps.
    for (const [from, to] of folds) {
      if (nfkc([from]).join(" ") !== String(from)) continue;
      expect({ from, to: foldKey(str([from])) }).toEqual({ from, to: [to] });
    }
    expect(foldKey("a")).toEqual([0x61]);
  });

  it("every White_Space code point is removed, and only those", () => {
    const space = new Set<number>();
    for (const line of read("PropList.txt").split("\n")) {
      const f = line
        .replace(/#.*/, "")
        .split(";")
        .map((x) => x.trim());
      if (f[1] !== "White_Space") continue;
      const [a, b] = (f[0] as string).split("..");
      for (let cp = hex(a as string); cp <= hex(b ?? (a as string)); cp++) space.add(cp);
    }
    expect(space.size).toBe(25);
    for (const cp of space) {
      // NFKC may map a space to U+0020, itself White_Space.
      expect({ cp, folded: foldKey(`x${str([cp])}y`) }).toEqual({ cp, folded: [0x78, 0x79] });
    }
    // Not White_Space, though JavaScript's \s takes it.
    expect(foldKey("x﻿y")).toEqual([0x78, 0xfeff, 0x79]);
  });
});

describe("the spec's test vectors (10-types-and-units «相近的键»)", () => {
  it.each([
    ["q4 推广", "Q4推广", "fold", undefined],
    ["ＡＢＣ部", "abc部", "fold", undefined],
    ["STRAẞE", "straße", "fold", undefined],
    ["Q4推广预算", "Q4推广", "affix", undefined],
    ["marketting", "marketing", "edit", 1],
    ["marketnig", "marketing", "edit", 2],
    ["abdc", "abcd", null, 2],
    ["CA", "ABC", null, 3],
    ["房贷", "房租", null, 1],
    ["推廣", "推广", null, 1],
  ])("%s / %s: %s", (a, b, match, d) => {
    expect(matchText(a, b)?.match ?? null).toBe(match);
    if (d !== undefined) expect(distance(foldKey(a), foldKey(b))).toBe(d);
  });
});

describe("the thresholds at their edges", () => {
  it("edit: distance 2 at a shorter key of 8 code points, not at 7; distance 1 from 3, not at 2", () => {
    expect(matchText("abcdefgh", "abcdefXY")).toEqual({ match: "edit", distance: 2 });
    expect(matchText("abcdefg", "abcdeXY")).toBeUndefined();
    expect(matchText("abc", "abX")).toEqual({ match: "edit", distance: 1 });
    expect(matchText("ab", "aX")).toBeUndefined();
  });

  it("affix: the shorter at least 2 code points", () => {
    expect(matchText("ab", "abcdef")).toEqual({ match: "affix", distance: 4 });
    expect(matchText("a", "abcdef")).toBeUndefined();
  });
});

describe("keys of several fields", () => {
  it("a field not text must be the same; text fields alike or as written; one at least not as written", () => {
    const t = (a: string, b: string) => ({ text: true as const, a, b });
    const o = (equal: boolean) => ({ text: false as const, equal });
    expect(matchKey([t("q4 推广", "Q4推广"), o(true)])).toEqual({ match: "fold", distance: 0 });
    expect(matchKey([t("q4 推广", "Q4推广"), o(false)])).toBeUndefined();
    expect(matchKey([t("same", "same"), o(true)])).toBeUndefined();
    expect(matchKey([o(true)])).toBeUndefined();
    expect(matchKey([t("q4 推广", "Q4推广"), t("marketting", "marketing")])).toEqual({
      match: "edit",
      distance: 1,
    });
    expect(matchKey([t("q4 推广", "Q4推广"), t("房贷", "房租")])).toBeUndefined();
  });
});
