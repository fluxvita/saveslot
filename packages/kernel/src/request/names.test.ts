// `nearest` (04-contract §11): the names whose alias is the name after `keymatch@1`'s fold first,
// then by edit distance after that fold, then by name in C order; at most 3. The fold is the one
// `similar_keys` uses (10-types-and-units «相近的键»): NFKC, simple case folding, `White_Space`
// removed. The cases where it differs from `normalize("NFKC")`, `toLowerCase` and `\s` are fixed.

import { describe, expect, it } from "vitest";
import { nearest } from "./names.ts";

const BOM = String.fromCodePoint(0xfeff);

describe("nearest (04-contract §11, keymatch@1's fold)", () => {
  it("an alias the same after folding puts its name first", () => {
    expect(
      nearest("ＳＰＥＮＴ ", [{ name: "spend" }, { name: "cost", aliases: ["Spent"] }]),
    ).toEqual(["cost", "spend"]);
  });

  it("simple case folding, not toLowerCase: final sigma ς (U+03C2) folds to σ", () => {
    // NFKC and toLowerCase both keep ς; CaseFolding.txt folds it to σ (status C). (ſ would not do:
    // NFKC already maps it to s.)
    expect(nearest("λογοσ", [{ name: "aaaaa" }, { name: "word", aliases: ["λογος"] }])).toEqual([
      "word",
      "aaaaa",
    ]);
  });

  it("White_Space, not \\s: U+FEFF is kept", () => {
    // `\s` takes U+FEFF; it is not White_Space (PropList.txt), so x U+FEFF y is not xy.
    expect(nearest("xy", [{ name: "aa" }, { name: "zz", aliases: [`x${BOM}y`] }])).toEqual([
      "aa",
      "zz",
    ]);
  });

  it("by edit distance over code points after folding, then by name in C order; at most 3", () => {
    expect(
      nearest("Amout", [
        { name: "at" },
        { name: "amount" },
        { name: "account" },
        { name: "zzzzzz" },
      ]),
    ).toEqual(["amount", "account", "at"]);
    // A code point beyond the BMP is one, not two UTF-16 units.
    expect(nearest("a𝒳", [{ name: "abc" }, { name: "ab" }])).toEqual(["ab", "abc"]);
    expect(nearest("q", [{ name: "b" }, { name: "a" }])).toEqual(["a", "b"]);
  });
});
