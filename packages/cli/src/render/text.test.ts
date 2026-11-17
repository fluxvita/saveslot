// The parts of a CLI text (06-cli §6.1, §6.4): only saveslot's static texts stand as its own words
// (checked by the type), one boundary number per output that the output holds nowhere but in its
// tags, values that cannot run together, cutting before escaping.

import { describe, expect, it } from "vitest";
import { TEXTS } from "../texts.ts";
import { cut, id, type Line, name, render, t, untrusted, words } from "./text.ts";

const cp = (...points: number[]) => String.fromCodePoint(...points);

describe("saveslot's own words", () => {
  it("are its static texts only: a string made at run time does not type-check", () => {
    const fromOutside: string = ["user", "text"].join(" ");
    // @ts-expect-error a runtime string is no Static text
    words(fromOutside);
    expect(render([[words(TEXTS.warning)]], { kind: "plain" })).toBe("warning");
  });

  it("a part cannot be written by hand: an object with the same fields does not type-check", () => {
    const fromOutside: string = ["user", "text"].join(" ");
    // @ts-expect-error a Part is made in render/text.ts only
    const forged: Line = [{ kind: "own", text: fromOutside }];
    expect(forged).toHaveLength(1);
  });

  it("a shape that does not fit goes inside", () => {
    const line = [...t`${id("r_not_an_id")} ${name("1table")}`];
    expect(render([line], { kind: "terminal", color: false })).toBe(
      `${cp(0x300c)}r_not_an_id${cp(0x300d)} ${cp(0x300c)}1table${cp(0x300d)}`,
    );
  });
});

describe("one boundary number per output", () => {
  it("the same number in every tag of the output", () => {
    const text = render([[untrusted("a")], [untrusted("b")]], { kind: "tagged" });
    const ns = [...text.matchAll(/untrusted-data-([0-9a-f]{32})>/g)].map((m) => m[1]);
    expect(ns).toHaveLength(4);
    expect(new Set(ns).size).toBe(1);
  });

  it("drawn again while the output holds it outside the values too (checked on the whole text)", () => {
    const first = "0123456789abcdef0123456789abcdef";
    const second = "f".repeat(32);
    const draws = [first, second];
    // No value holds the first number; saveslot's own text of this output does.
    const lines = [[...t`count 0123456789abcdef0123456789abcdef: `, untrusted("a")]];
    const text = render(lines, { kind: "tagged" }, () => draws.shift() as string);
    expect(text).toBe(`count ${first}: <untrusted-data-${second}>a</untrusted-data-${second}>`);
  });

  it("a draw that is no number is refused", () => {
    expect(() => render([[untrusted("a")]], { kind: "tagged" }, () => "NOT-HEX")).toThrow();
  });
});

describe("values side by side", () => {
  it("plain: kept apart by a space, so that they cannot read as one", () => {
    const text = render([[untrusted("<"), untrusted("U+202E>")]], { kind: "plain" });
    expect(text).toBe("<U+003C> U+202E>");
  });

  it("in a terminal or tagged, each in its own brackets or tags", () => {
    expect(render([[untrusted("a"), untrusted("b")]], { kind: "terminal", color: false })).toBe(
      `${cp(0x300c)}a${cp(0x300d)}${cp(0x300c)}b${cp(0x300d)}`,
    );
  });
});

describe("cutting", () => {
  it("the value is cut, then escaped; the marker stands outside the boundary", () => {
    const marker = TEXTS.warning;
    const parts = cut(`ab${cp(0x5c)}cd`, 3, marker);
    expect(render([parts], { kind: "terminal", color: false })).toBe(
      `${cp(0x300c)}ab${cp(0x5c, 0x5c)}${cp(0x300d)}${marker}`,
    );
    expect(cut("ab", 3, marker)).toHaveLength(1);
  });
});
