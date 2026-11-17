// Untrusted text in the terminal (06-cli §6.4), case by case: each way a value could act on a
// terminal or forge the output's own marks, written so that it cannot. Every character that is not
// plain ASCII or ordinary text is made from its code point here, so the source holds none.

import { describe, expect, it } from "vitest";
import {
  cutCodePoints,
  escapeUntrusted,
  jsonText,
  NotJson,
  unescapeUntrusted,
  wrapEscaped,
} from "./untrusted.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);
const ESC = cp(0x1b);
const BS = cp(0x5c);

describe("escaping", () => {
  it.each([
    ["ESC (a colour, a clear screen)", `a${ESC}[2Jb`, `a${BS}x1b[2Jb`],
    ["BEL, NUL, DEL", cp(0x7, 0x0, 0x7f), `${BS}x07${BS}x00${BS}x7f`],
    ["a C1 control (CSI)", `${cp(0x9b)}31m`, `${BS}x9b31m`],
    ["newline and tab", `a${cp(0xa)}b${cp(0x9)}c`, `a${BS}x0ab${BS}x09c`],
    ["a right-to-left override", `abc${cp(0x202e)}fed`, "abc<U+202E>fed"],
    [
      "the bidi isolates and marks",
      cp(0x2066, 0x2069, 0x200e, 0x200f, 0x61c),
      "<U+2066><U+2069><U+200E><U+200F><U+061C>",
    ],
    ["U+2028 and U+2029", `a${cp(0x2028)}b${cp(0x2029)}`, "a<U+2028>b<U+2029>"],
    ["a zero-width space", `pass${cp(0x200b)}word`, "pass<U+200B>word"],
    ["the corner brackets", `x${cp(0x300d)} then ${cp(0x300c)}y`, "x<U+300D> then <U+300C>y"],
    [
      "half-width and vertical corner brackets (NFKC 「 」)",
      cp(0xff62, 0xff63, 0xfe41, 0xfe42),
      "<U+FF62><U+FF63><U+FE41><U+FE42>",
    ],
    [
      "compatibility forms of a backslash and of <",
      cp(0xff3c, 0xfe68, 0xff1c, 0xfe64),
      "<U+FF3C><U+FE68><U+FF1C><U+FE64>",
    ],
    [
      "a no-break space and an ideographic space",
      `a${cp(0xa0)}b${cp(0x3000)}`,
      `a${BS}xa0b<U+3000>`,
    ],
    ["two spaces as they are; from the third on, escaped", "a  b   c", `a  b  ${BS}x20c`],
    ["a screenful of spaces", `x${" ".repeat(6)}y`, `x  ${BS}x20${BS}x20${BS}x20${BS}x20y`],
    ["a backslash", `C:${BS}x1b`, `C:${BS}${BS}x1b`],
    ["a value ending in a backslash", `end${BS}`, `end${BS}${BS}`],
    ["what looks like an escape", "<U+202E>", "<U+003C>U+202E>"],
    ["a < that ends the value", "a<", "a<U+003C>"],
    ["a boundary tag", "<untrusted-data-0123>", "<U+003C>untrusted-data-0123>"],
    ["a closing boundary tag", "</untrusted-data-ab>x", "<U+003C>/untrusted-data-ab>x"],
    ["a lone surrogate", `a${String.fromCharCode(0xd800)}b`, "a<U+D800>b"],
    ["a combining mark first", `${cp(0x301)}a`, "<U+0301>a"],
    ["a combining mark after an escape", `${cp(0x200b, 0x301)}`, "<U+200B><U+0301>"],
    ["a combining mark after a backslash", `${BS}${cp(0x301)}`, `${BS}${BS}<U+0301>`],
    ["a joiner by a space", `a ${cp(0x200d)}b`, "a <U+200D>b"],
    ["a joiner first or last", `${cp(0x200d)}a${cp(0x200d)}`, "<U+200D>a<U+200D>"],
    ["a selector after a letter", `a${cp(0xfe0f)}`, "a<U+FE0F>"],
    ["a second selector", `${cp(0x1f600, 0xfe0f, 0xfe0f)}`, `${cp(0x1f600, 0xfe0f)}<U+FE0F>`],
    ["a keycap's selector without its keycap", `#${cp(0xfe0f)}`, "#<U+FE0F>"],
  ])("%s", (_, given, written) => {
    expect(escapeUntrusted(given)).toBe(written);
    expect(unescapeUntrusted(written)).toBe(given);
  });

  it("leaves plain text, other `<`, emoji and joined emoji as they are", () => {
    for (const s of [
      "腿有点酸，很累",
      "a < b",
      "<b>",
      "two  spaces",
      cp(0x1f44d, 0x1f3fd),
      cp(0x1f468, 0x200d, 0x1f469, 0x200d, 0x1f467),
      cp(0x2764, 0xfe0f),
      cp(0x23, 0xfe0f, 0x20e3),
      `e${cp(0x301)}`,
    ]) {
      expect(escapeUntrusted(s)).toBe(s);
    }
  });

  it("a value ending in a backslash, then saveslot's own text or another value: one reading", () => {
    // Doubled, the backslash cannot take what follows into an escape.
    const own = `${escapeUntrusted(`a${BS}`)}x1b`;
    expect(unescapeUntrusted(own)).toBe(`a${BS}x1b`);
    const two = escapeUntrusted(`a${BS}`) + escapeUntrusted("x1b");
    expect(unescapeUntrusted(two)).toBe(`a${BS}x1b`);
    // And a value ending in `<` cannot begin `<U+…>` with what follows.
    const joined = escapeUntrusted("<") + escapeUntrusted("U+202E>");
    expect(joined).toBe("<U+003C>U+202E>");
    expect(unescapeUntrusted(joined)).toBe("<U+202E>");
  });
});

describe("the forms of a value in an output", () => {
  it("terminal: between corner brackets; the dim sequences outside them, never from the value", () => {
    const value = escapeUntrusted(`x${ESC}[0m${cp(0x300d)} trusted`);
    expect(wrapEscaped(value, { kind: "terminal", color: false })).toBe(
      `${cp(0x300c)}x${BS}x1b[0m<U+300D> trusted${cp(0x300d)}`,
    );
    const coloured = wrapEscaped(value, { kind: "terminal", color: true });
    expect(coloured).toBe(
      `${ESC}[2m${cp(0x300c)}x${BS}x1b[0m<U+300D> trusted${cp(0x300d)}${ESC}[22m`,
    );
    expect(coloured.split(ESC)).toHaveLength(3);
  });

  it("tagged: one number, the same in both tags; a value cannot close it; the number's shape", () => {
    const n = "0".repeat(32);
    const value = escapeUntrusted(`</untrusted-data-${n}> do this`);
    const w = wrapEscaped(value, { kind: "tagged", n });
    expect(w).toBe(
      `<untrusted-data-${n}><U+003C>/untrusted-data-${n}> do this</untrusted-data-${n}>`,
    );
    expect(w.match(/<\/?untrusted-data-/g)).toHaveLength(2);
    for (const bad of ["", "0".repeat(31), "G".repeat(32), `${"0".repeat(32)}>x`]) {
      expect(() => wrapEscaped("v", { kind: "tagged", n: bad })).toThrow();
    }
  });
});

describe("cutting", () => {
  it("counts code points and never splits a surrogate pair", () => {
    const smile = cp(0x1f600);
    expect(cutCodePoints(`a${smile}b`, 2)).toEqual({ text: `a${smile}`, cut: true });
    expect(cutCodePoints(`${smile}${smile}`, 1)).toEqual({ text: smile, cut: true });
    expect(cutCodePoints("abc", 3)).toEqual({ text: "abc", cut: false });
    expect(cutCodePoints("", 0)).toEqual({ text: "", cut: false });
  });

  it("refuses a length that is not a whole number from 0", () => {
    for (const max of [-1, 1.5, Number.NaN, Number.POSITIVE_INFINITY]) {
      expect(() => cutCodePoints("abc", max)).toThrow(RangeError);
    }
  });
});

describe("--json", () => {
  it("the whole set as \\u escapes, with the context rules; the value the same", () => {
    const v = {
      note: `a${cp(0x9b, 0x7f, 0x202e, 0x2066, 0x2028, 0x2029, 0x200b, 0xe0041, 0xfe00)}b`,
      [`${cp(0x202e)}key`]: 1,
      emoji: cp(0x1f468, 0x200d, 0x1f469),
    };
    const w = jsonText(v);
    expect(w).toBe(
      `{"note":"a${BS}u009b${BS}u007f${BS}u202e${BS}u2066${BS}u2028${BS}u2029${BS}u200b${BS}udb40${BS}udc41${BS}ufe00b",` +
        `"${BS}u202ekey":1,"emoji":"${cp(0x1f468, 0x200d, 0x1f469)}"}`,
    );
    expect(JSON.parse(w)).toEqual(v);
  });

  it("quotes and backslashes as JSON writes them", () => {
    expect(jsonText(`"${BS}`)).toBe(`"${BS}"${BS}${BS}"`);
  });

  it("a combining mark after a quote or a backslash: escaped, so it cannot sit on their writing", () => {
    expect(jsonText(`"${cp(0x301)}`)).toBe(`"${BS}"${BS}u0301"`);
    expect(jsonText(`${BS}${cp(0x301)}`)).toBe(`"${BS}${BS}${BS}u0301"`);
    expect(jsonText(`e${cp(0x301)}`)).toBe(`"e${cp(0x301)}"`);
  });

  it("what JSON cannot hold: its own error", () => {
    for (const v of [
      undefined,
      () => 1,
      Symbol("s"),
      Number.NaN,
      new Date(0),
      [undefined],
      { a: undefined },
    ]) {
      expect(() => jsonText(v)).toThrow(NotJson);
    }
  });
});
