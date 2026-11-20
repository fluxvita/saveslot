// The literal checker `literal@1` (04-write-and-read «来源级别：声明级别与字面命中»; 10-types-and-
// units «单位同义表»): each field type's hit, miss and not applicable, the bounds of a number token
// and of a date, every writing of the synonym table, and the table itself held to the spec's.

import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { unitCodes, unitOf } from "../schema/units.ts";
import {
  checkLiteral,
  indexEvidence,
  type LiteralField,
  literalKey,
  normalizeText,
  numberKey,
} from "./literal.ts";
import { CURRENCY_SYMBOLS, expandWriting, UNIT_SYNONYM_ROWS, writingsOf } from "./literal-units.ts";

const at = (field: LiteralField, raw: unknown, text: string | undefined) =>
  checkLiteral(field, raw, text === undefined ? undefined : indexEvidence(text));
const INT: LiteralField = { type: "integer" };
const DEC: LiteralField = { type: "decimal" };
const q = (value: string, unit: string) => ({ value, unit });
const QTY: LiteralField = { type: "quantity" };
// A currency by the raw value's unit, as any quantity: the same field description.
const CUR = QTY;

describe("normalization", () => {
  it("NFC, then fullwidth to halfwidth (U+FF01–U+FF5E, the ideographic space)", () => {
    expect(normalizeText("ｋｍ１２．５　％")).toBe("km12.5 %");
    expect(normalizeText("é")).toBe("é");
    // Outside the range: the fullwidth yen sign stays (the table names it).
    expect(normalizeText("￥")).toBe("￥");
    // The Chinese comma stays: a clause's end, never a thousands separator.
    expect(normalizeText("45，11")).toBe("45，11");
  });
});

describe("numbers (integer, decimal)", () => {
  it("the value, compared as a number: padding, trailing zeros, thousands, an exponent in the value", () => {
    expect(at(INT, "1500", "花了1,500")).toBe("hit");
    expect(at(INT, "1500", "花了 1500 元")).toBe("hit");
    expect(at(DEC, "12.50", "12.5")).toBe("hit");
    expect(at(DEC, "12.5", "012.500")).toBe("hit");
    expect(at(DEC, "1.5e3", "1500")).toBe("hit");
    expect(at(INT, "1500", "1,500.0")).toBe("hit");
    expect(at(INT, "0", "0.00")).toBe("hit");
    expect(at(INT, "1500", "15")).toBe("miss");
  });

  it("the sign is not part of the token: -8 hits 8, 8 hits -8", () => {
    expect(at(INT, "-8", "欠 8 元")).toBe("hit");
    expect(at(INT, "8", "-8")).toBe("hit");
  });

  it.each([
    ["inside a longer number", "5", "15"],
    ["after a thousands separator", "500", "1,500"],
    ["after a point", "14", "3.14"],
    ["before a point", "3", "3.14"],
    ["a comma not before three digits", "1", "1,5"],
    ["a comma before four digits", "5000", "1,5000"],
    ["in a date", "11", "2026-11-05"],
    ["in a time", "30", "10:30"],
    ["in a fraction", "2", "1/2"],
    ["in a range", "5", "3-5"],
    ["in an exponent", "2", "1e2"],
    ["before an exponent", "1", "1e2"],
    ["in a signed exponent", "2", "1e-2"],
    ["a percentage", "50", "涨了 50%"],
    ["a percentage, spaced", "50", "50 %"],
    ["Chinese numerals", "5", "五"],
  ])("no token %s", (_, value, text) => {
    expect(at(INT, value, text)).toBe("miss");
  });

  it("a Chinese comma ends a clause: ¥45，11月5号 has 45 (and its date)", () => {
    expect(at(INT, "45", "午饭 ¥45，11月5号")).toBe("hit");
    expect(at({ type: "date" }, "2026-11-05", "午饭 ¥45，11月5号")).toBe("hit");
    expect(at(INT, "1500", "1，500")).toBe("miss");
  });

  it("a fullwidth point and colon are halfwidth ones: 45．5 is 45.5; in 3：5 neither is", () => {
    expect(at(DEC, "45.5", "45．5")).toBe("hit");
    expect(at(INT, "45", "45．5")).toBe("miss");
    expect(at(INT, "3", "3：5")).toBe("miss");
    expect(at(INT, "5", "3：5")).toBe("miss");
  });

  it("a point with nothing after it ends a sentence", () => {
    expect(at(INT, "3", "跑了3.")).toBe("hit");
  });

  it("literalKey: one key for values compared alike", () => {
    expect(literalKey({ type: "text" }, "  park ")).toBe(literalKey({ type: "text" }, "ｐａｒｋ"));
    expect(literalKey({ type: "enum" }, "Food")).toBe(literalKey({ type: "enum" }, "food"));
    expect(literalKey({ type: "text" }, "Park")).not.toBe(literalKey({ type: "text" }, "park"));
    expect(literalKey({ type: "integer" }, "5")).not.toBe(literalKey({ type: "decimal" }, "5"));
  });

  it("numberKey: the value, without the sign; not a decimal, none", () => {
    expect(numberKey("-0012.3400")).toBe(numberKey("12.34"));
    expect(numberKey("1.2e1")).toBe(numberKey("12"));
    expect(numberKey("0.000")).toBe("0");
    expect(numberKey("1e999")).toBe("1|1000");
    expect(numberKey("abc")).toBeUndefined();
  });
});

describe("quantity", () => {
  it("the raw number followed by a writing of the raw unit, a space between or not", () => {
    expect(at(QTY, q("5", "km"), "跑了 5 公里")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了5km")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了 5 KM")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了 5 ｋｍ")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了 5 公里路")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了 5 千米")).toBe("hit");
    expect(at(QTY, q("5", "km"), "跑了 5 英里")).toBe("miss");
    expect(at(QTY, q("5", "km"), "跑了 5")).toBe("miss");
    expect(at(QTY, q("5", "km"), "公里 5")).toBe("miss");
  });

  it("a Latin writing is one only where no Latin letter or digit follows; a Chinese one anywhere", () => {
    expect(at(QTY, q("5", "m"), "5 mi")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 m2")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 m.")).toBe("hit");
    expect(at(QTY, q("5", "m"), "5 meters")).toBe("hit");
    expect(at(QTY, q("30", "min"), "30 mins")).toBe("hit");
    expect(at(QTY, q("30", "min"), "30 minutes later")).toBe("hit");
  });

  it("a currency symbol before the number, a space between or not; after it, no", () => {
    expect(at(CUR, q("45", "CNY"), "¥45")).toBe("hit");
    expect(at(CUR, q("45", "CNY"), "￥ 45")).toBe("hit");
    expect(at(CUR, q("12.5", "USD"), "$12.50")).toBe("hit");
    expect(at(CUR, q("12.5", "USD"), "HK$12.5")).toBe("miss");
    expect(at(CUR, q("12.5", "HKD"), "HK$12.5")).toBe("hit");
    expect(at(CUR, q("12.5", "USD"), "US$12.5")).toBe("miss");
    expect(at(CUR, q("45", "CNY"), "45¥")).toBe("miss");
    expect(at(CUR, q("45", "CNY"), "45 元")).toBe("hit");
  });

  it("a currency not in the table: its ISO code only", () => {
    expect(at(CUR, q("100", "CHF"), "100 CHF")).toBe("hit");
    expect(at(CUR, q("100", "CHF"), "100 francs")).toBe("miss");
  });

  it("the unit 1: the number alone", () => {
    expect(at(QTY, q("3", "1"), "3 次")).toBe("hit");
    expect(at(QTY, q("3", "1"), "3%")).toBe("miss");
  });

  it("the unit %: the percent sign or the word", () => {
    expect(at(QTY, q("50", "%"), "50%")).toBe("hit");
    expect(at(QTY, q("50", "%"), "50 ％")).toBe("hit");
    expect(at(QTY, q("50", "%"), "50 percent")).toBe("hit");
    expect(at(QTY, q("50", "%"), "50")).toBe("miss");
  });

  it("the writings of the field's unit only: pound(s) for lb is not GBP's, oz for floz not oz's", () => {
    expect(at(QTY, q("2", "lb"), "2 pounds")).toBe("hit");
    expect(at(CUR, q("2", "GBP"), "2 pounds")).toBe("hit");
    expect(at(QTY, q("2", "lb"), "2 英镑")).toBe("miss");
    expect(at(QTY, q("8", "floz"), "8 oz")).toBe("hit");
    expect(at(QTY, q("8", "oz"), "8 fl oz")).toBe("miss");
  });

  it("both micro signs", () => {
    expect(at(QTY, q("5", "ug"), "5 µg")).toBe("hit");
    expect(at(QTY, q("5", "ug"), "5 μg")).toBe("hit");
  });
});

describe("every writing of the table", () => {
  const rows = UNIT_SYNONYM_ROWS.flatMap((r) => r.codes.map((code) => [code] as const));
  it.each(rows)("%s", (code) => {
    const currency = unitOf(code)?.dimension.startsWith("currency:") === true;
    const field: LiteralField = { type: "quantity" };
    for (const w of writingsOf(code, currency)) {
      const ev = CURRENCY_SYMBOLS.has(w) ? `付了${w}7.5。` : `记 7.5 ${w}。`;
      expect({ w, r: at(field, q("7.5", code), ev) }).toEqual({ w, r: "hit" });
      // Latin letters by any case.
      if (/[a-z]/i.test(w)) {
        const upper = CURRENCY_SYMBOLS.has(w)
          ? `付了${w.toUpperCase()}7.5。`
          : `记 7.5 ${w.toUpperCase()}。`;
        expect({ w, r: at(field, q("7.5", code), upper) }).toEqual({ w, r: "hit" });
      }
    }
  });

  it("every unit of the vocabulary has a row, but 1", () => {
    const listed = new Set(UNIT_SYNONYM_ROWS.flatMap((r) => r.codes));
    const missing = unitCodes().filter(
      (c) => c !== "1" && !listed.has(c) && !unitOf(c)?.dimension.startsWith("currency:"),
    );
    expect(missing).toEqual([]);
  });
});

describe("the table is the spec's (10-types-and-units «单位同义表»)", () => {
  const spec = readFileSync(
    new URL("../../../../docs/zh-CN/spec/03-data-model/10-types-and-units.md", import.meta.url),
    "utf8",
  );
  const section = spec.slice(spec.indexOf("## 单位同义表"));
  const lines = section
    .split("\n")
    .filter((l) => l.startsWith("| ") && !l.startsWith("| 代码") && !l.startsWith("|---"));
  const parsed = lines
    .map((l) => l.split("|").map((c) => c.trim()))
    .filter(([, codes]) => codes !== "其他货币")
    .map(([, codes, writings]) => ({
      codes: (codes as string).split("、").map((c) => c.replaceAll("`", "")),
      writings: (writings as string).split("；").map((g) => g.split("、")),
    }));

  it("row for row, writing for writing", () => {
    expect(parsed).toEqual(UNIT_SYNONYM_ROWS);
  });

  it("other currencies: their ISO code only", () => {
    expect(lines.some((l) => l.includes("| 其他货币 | 只认 ISO 代码 |"))).toBe(true);
    expect(writingsOf("CHF", true)).toEqual(["CHF"]);
  });

  it("expandWriting: a plural in brackets, both forms", () => {
    expect(expandWriting("dollar(s)")).toEqual(["dollar", "dollars"]);
    expect(expandWriting("inch(es)")).toEqual(["inch", "inches"]);
    expect(expandWriting("fl. oz.")).toEqual(["fl. oz."]);
  });
});

describe("date", () => {
  it.each([
    ["2026-11-05"],
    ["2026-11-5"],
    ["2026/11/5"],
    ["2026/11/05"],
    ["2026年11月5日"],
    ["2026年11月05日"],
    ["2026年11月5号"],
    ["11月5日"],
    ["11月05日"],
    ["11月5号"],
    ["11-5"],
    ["11-05"],
    ["11/5"],
    ["那天是 11月5号，晴"],
  ])("%s hits 2026-11-05", (text) => {
    expect(at({ type: "date" }, "2026-11-05", text)).toBe("hit");
  });

  it.each([
    ["another year", "2025-11-05"],
    ["another day", "11月6日"],
    ["inside a longer date", "12026-11-05"],
    ["out of 1/2/3", "1/2/3"],
    ["touching a digit", "11-051"],
    ["touching a dash", "11-05-"],
    ["another year, with 号", "2025年11月5号"],
    ["an English month", "Nov 5"],
    ["M.D", "11.5"],
    ["a relative day", "今天"],
    ["no such day", "2026-02-30"],
  ])("%s: no", (_, text) => {
    expect(at({ type: "date" }, "2026-11-05", text)).toBe("miss");
  });

  it("a date of a leap day without its year", () => {
    expect(at({ type: "date" }, "2028-02-29", "2月29日")).toBe("hit");
    expect(at({ type: "date" }, "2027-03-01", "2027-02-29")).toBe("miss");
  });
});

describe("the same text, two rules, both meant", () => {
  // `3-5`: no number token for an integer (a joiner between digits), and March 5th for a date
  // (`M-D`). Neither is a gap in the other.
  it("3-5: an integer 5 misses", () => {
    expect(at(INT, "5", "跑了 3-5 公里")).toBe("miss");
  });
  it("3-5: the date 3月5日 hits", () => {
    expect(at({ type: "date" }, "2026-03-05", "跑了 3-5 公里")).toBe("hit");
  });
});

describe("enum and text", () => {
  it("enum: the value's literal, by any case", () => {
    expect(at({ type: "enum" }, "food", "Lunch was FOOD")).toBe("hit");
    expect(at({ type: "enum" }, "food", "ｆｏｏｄ")).toBe("hit");
    expect(at({ type: "enum" }, "rent", "food")).toBe("miss");
  });

  it("text: contained, by case, both sides normalized and the value trimmed", () => {
    expect(at({ type: "text" }, "  park  ", "ran in the park")).toBe("hit");
    expect(at({ type: "text" }, "Park", "ran in the park")).toBe("miss");
    expect(at({ type: "text" }, "ｐａｒｋ", "park")).toBe("hit");
    expect(at({ type: "text" }, "   ", "park")).toBe("na");
  });
});

describe("not applicable", () => {
  it.each<[string, LiteralField, unknown, string | undefined]>([
    ["no text (an api_call, a file without an excerpt, a source deleted)", INT, "5", undefined],
    ["an empty value", INT, null, "5"],
    ["boolean", { type: "boolean" }, true, "true"],
    ["zoned_datetime", { type: "zoned_datetime" }, "2026-11-05T09:30:00+08:00[Asia/Shanghai]", "x"],
    ["ref", { type: "ref" }, `r_${"1".repeat(26)}`, `r_${"1".repeat(26)}`],
  ])("%s", (_, field, raw, text) => {
    expect(at(field, raw, text)).toBe("na");
  });
});

describe("what literal@1 does not take", () => {
  it("the longest writing after the number is the unit written: km/h, m/s, 公里/小时 are not km or m", () => {
    expect(at(QTY, q("5", "km"), "5 km/h")).toBe("miss");
    expect(at(QTY, q("5", "km/h"), "5 km/h")).toBe("hit");
    expect(at(QTY, q("5", "km"), "5 公里/小时")).toBe("miss");
    expect(at(QTY, q("5", "km/h"), "5 公里/小时")).toBe("hit");
    expect(at(QTY, q("5", "m"), "5 m/s")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 米/秒")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 minutes")).toBe("miss");
  });

  it("no writing before /, ^ or a superscript digit: areas and volumes are not lengths", () => {
    expect(at(QTY, q("5", "m"), "5 m²")).toBe("miss");
    expect(at(QTY, q("5", "km"), "5 km²")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 m³")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 m^2")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 米²")).toBe("miss");
    expect(at(QTY, q("5", "m"), "5 米长")).toBe("hit");
  });

  it("a number in a date or a time of day as written is no token", () => {
    expect(at(INT, "5", "11月5日")).toBe("miss");
    expect(at(INT, "11", "11月5日")).toBe("miss");
    expect(at(QTY, q("5", "d"), "11月5日")).toBe("miss");
    expect(at(QTY, q("30", "min"), "10点30分")).toBe("miss");
    expect(at(INT, "10", "10点")).toBe("miss");
    // 点 not as a time of day takes its number all the same: taking less (04 «数字记号»).
    expect(at(INT, "5", "给了5点建议")).toBe("miss");
    expect(at(QTY, q("30", "min"), "10时30分")).toBe("miss");
    // Not in a date or a time: as before.
    expect(at(QTY, q("5", "d"), "住了 5 日")).toBe("hit");
    expect(at(QTY, q("30", "min"), "跑了 30 分")).toBe("hit");
  });

  it("a number before % or ‰ is a ratio, whatever the field's unit", () => {
    expect(at(CUR, q("50", "USD"), "$50%")).toBe("miss");
    expect(at(INT, "5", "5‰")).toBe("miss");
    expect(at(QTY, q("5", "%"), "5‰")).toBe("miss");
    expect(at(QTY, q("50", "%"), "50%")).toBe("hit");
  });

  it("bounds: any script's digits, a point before, a first group of four", () => {
    expect(at(INT, "5", "5²")).toBe("miss");
    expect(at(INT, "5", "٣5")).toBe("miss");
    expect(at(INT, "5", ".5")).toBe("miss");
    expect(at(INT, "1234567", "1234,567")).toBe("miss");
    expect(at(INT, "1234", "1234,567")).toBe("miss");
    expect(at(INT, "567", "1234,567")).toBe("miss");
    expect(at(INT, "150", "1,50")).toBe("miss");
    expect(at(INT, "15000", "1,5000")).toBe("miss");
    expect(at(INT, "1234567", "1,234,567")).toBe("hit");
  });

  it("a date without its year after 年 across spaces or 的; a date before : or a point and a digit", () => {
    expect(at({ type: "date" }, "2026-11-05", "2025年 11月5日")).toBe("miss");
    expect(at({ type: "date" }, "2026-11-05", "2025年的11月5日")).toBe("miss");
    expect(at({ type: "date" }, "2026-11-05", "11-05:30")).toBe("miss");
    expect(at({ type: "date" }, "2026-11-05", "11/5.5")).toBe("miss");
    expect(at({ type: "date" }, "2026-11-05", "11/5. 后来")).toBe("hit");
  });

  it("years 0000–0099 are years like any (no two-digit year taken for 19xx)", () => {
    expect(at({ type: "date" }, "0050-11-05", "0050-11-05")).toBe("hit");
    expect(at({ type: "date" }, "0004-02-29", "0004-02-29")).toBe("hit");
    expect(at({ type: "date" }, "0001-02-29", "0001-02-29")).toBe("miss");
    expect(at({ type: "date" }, "1900-02-29", "1900-02-29")).toBe("miss");
    expect(at({ type: "date" }, "2000-02-29", "2000-02-29")).toBe("hit");
  });
});
