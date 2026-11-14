// The unit vocabulary units@1 against 03-data-model/10-types-and-units.md «单位词表», and the
// currency table generated from ISO 4217 list one.

import { describe, expect, it } from "vitest";
import { parseListOne, render } from "../../../../scripts/gen-currencies.ts";
import { defaultScale, unitCandidates, unitCodes, unitOf } from "./units.ts";
import { CURRENCY_MINOR_UNITS, ISO_4217_PUBLISHED } from "./units-currency.ts";

describe("units@1", () => {
  // The table of 10 «单位词表», row by row.
  it.each([
    ["length", "mm 0.001 cm 0.01 m 1 km 1000 in 0.0254 ft 0.3048 yd 0.9144 mi 1609.344"],
    ["mass", "ug 0.000001 mg 0.001 g 1 kg 1000 oz 28.349523125 lb 453.59237"],
    ["duration", "ms 0.001 s 1 min 60 h 3600 d 86400 wk 604800"],
    ["volume", "mL 0.001 L 1 floz 0.0295735295625"],
    ["energy", "J 1 kJ 1000 cal 4.184 kcal 4184"],
    ["frequency", "/d 1 /h 24 /min 1440 /s 86400"],
    ["speed", "km/h 1 m/s 3.6 mi/h 1.609344"],
    ["dimensionless", "1 1 % 0.01"],
  ])("%s", (dimension, row) => {
    const words = row.split(" ");
    for (let i = 0; i < words.length; i += 2) {
      const code = words[i] as string;
      expect(unitOf(code)).toEqual({ code, dimension, to_base: words[i + 1] });
    }
    const listed = unitCodes().filter((c) => unitOf(c)?.dimension === dimension);
    expect(listed.length).toBe(words.length / 2);
  });

  it("temperatures are each their own dimension, without a factor", () => {
    for (const code of ["Cel", "degF", "K"]) {
      expect(unitOf(code)).toEqual({ code, dimension: `temperature:${code}` });
    }
  });

  it("currencies are each their own dimension, without a factor", () => {
    expect(unitOf("CNY")).toEqual({ code: "CNY", dimension: "currency:CNY" });
    expect(unitOf("USN")).toEqual({ code: "USN", dimension: "currency:USN" });
  });

  it("is case-sensitive, and has no months, years or cups", () => {
    for (const code of ["KM", "ml", "cny", "Min", "mo", "yr", "cup", "dL", "IU", "mg/dL"]) {
      expect(unitOf(code)).toBeUndefined();
    }
  });

  it("default scale: the currency's minor unit, else 6", () => {
    const scale = (c: string) => defaultScale(unitOf(c) as never);
    expect([
      scale("CNY"),
      scale("JPY"),
      scale("KWD"),
      scale("CLF"),
      scale("km"),
      scale("Cel"),
    ]).toEqual([2, 0, 3, 4, 6, 6]);
  });

  it("suggests codes by case and by written form", () => {
    expect(unitCandidates("ML")).toEqual(["mL"]);
    expect(unitCandidates("元")).toEqual(["CNY"]);
    expect(unitCandidates("rmb")).toEqual(["CNY"]);
    expect(unitCandidates("pound")).toEqual(["GBP", "lb"]);
    expect(unitCandidates(" bpm ")).toEqual(["/min"]);
    expect(unitCandidates("斤")).toEqual([]);
  });
});

describe("the currency table", () => {
  it("was generated from the list published on 2026-09-17", () => {
    expect(ISO_4217_PUBLISHED).toBe("2026-09-17");
    expect(Object.keys(CURRENCY_MINOR_UNITS).length).toBe(165);
    for (const code of ["XAU", "XAG", "XPD", "XPT", "XDR", "XUA", "XSU", "XBA", "XTS", "XXX"]) {
      expect(CURRENCY_MINOR_UNITS).not.toHaveProperty(code);
    }
  });

  const entry = (code: string | null, units: string, name = "X") =>
    `<CcyNtry><CtryNm>${name}</CtryNm><CcyNm>c</CcyNm>${code === null ? "" : `<Ccy>${code}</Ccy>`}<CcyNbr>1</CcyNbr><CcyMnrUnts>${units}</CcyMnrUnts></CcyNtry>`;
  const list = (...entries: string[]) =>
    `<ISO_4217 Pblshd="2026-01-02"><CcyTbl>${entries.join("")}</CcyTbl></ISO_4217>`;

  it("the generator keeps codes with a minor unit, once each", () => {
    const { published, minor } = parseListOne(
      list(
        entry("AAA", "2"),
        entry("AAA", "2", "Y"),
        entry("BBB", "N.A."),
        entry(null, ""),
        entry("CCC", "0"),
      ),
    );
    expect(published).toBe("2026-01-02");
    expect([...minor]).toEqual([
      ["AAA", 2],
      ["CCC", 0],
    ]);
    expect(render(published, minor)).toContain("AAA: 2, CCC: 0,");
  });

  it("the generator stops on what it does not understand", () => {
    expect(() => parseListOne(list(entry("AAA", "2"), entry("AAA", "3", "Y")))).toThrow(
      /two minor/,
    );
    expect(() => parseListOne(list(entry("aa1", "2")))).toThrow(/not a currency/);
    expect(() => parseListOne(list(entry("AAA", "two")))).toThrow(/minor unit of/);
    expect(() => parseListOne("<ISO_4217>")).toThrow(/publication/);
    expect(() => parseListOne(list())).toThrow(/no currencies/);
  });
});
