// Test vectors for the JCS encoder.
//
// The "RFC 8785" vectors are taken from the text of RFC 8785 (JSON Canonicalization Scheme),
// §3.2.2, §3.2.3, §3.2.4 and Appendix B, by A. Rundgren, B. Jordan and S. Erdtman,
// https://www.rfc-editor.org/rfc/rfc8785. Copyright (c) 2020 IETF Trust and the persons identified
// as the document authors. All rights reserved. Code Components extracted from IETF documents are
// licensed under the Revised BSD License (https://trustee.ietf.org/license-info). The remaining
// vectors are derived from the RFC's rules for what the event format relies on.

import { describe, expect, it } from "vitest";
import { canonicalize, canonicalizeToBytes, JcsError, type JcsValue } from "./jcs.ts";

const hex = (bytes: Uint8Array) =>
  Array.from(bytes, (b) => b.toString(16).padStart(2, "0")).join(" ");

/** A double from its IEEE 754 bit pattern (16 hex digits), as RFC 8785 Appendix B lists them. */
function fromBits(bits: string): number {
  const view = new DataView(new ArrayBuffer(8));
  view.setBigUint64(0, BigInt(`0x${bits}`));
  return view.getFloat64(0);
}

/** A string from code points: keeps invisible and non-ASCII characters readable in source. */
const cp = (...points: number[]) => String.fromCodePoint(...points);

/** RFC JSON text written with `%` for each backslash, so the escapes survive verbatim. */
const rfcText = (s: string) => s.replaceAll("%", String.fromCharCode(0x5c));

describe("RFC 8785 vectors", () => {
  // §3.2.2: the input as JavaScript parses it (JSON.parse applies the same number rounding).
  const sample: JcsValue = JSON.parse(
    rfcText(`{
      "numbers": [333333333.33333329, 1E30, 4.50, 2e-3, 0.000000000000000000000000001],
      "string": "%u20ac$%u000F%u000aA'%u0042%u0022%u005c%%%"%/",
      "literals": [null, true, false]
    }`),
  );

  it("§3.2.3: canonicalizes the primitive serialization sample", () => {
    expect(canonicalize(sample)).toBe(
      rfcText(
        `{"literals":[null,true,false],"numbers":[333333333.3333333,1e+30,4.5,0.002,1e-27],"string":"${cp(0x20ac)}$%u000f%nA'B%"%%%%%"/"}`,
      ),
    );
  });

  it("§3.2.4: produces the listed UTF-8 bytes", () => {
    expect(hex(canonicalizeToBytes(sample))).toBe(
      [
        "7b 22 6c 69 74 65 72 61 6c 73 22 3a 5b 6e 75 6c 6c 2c 74 72",
        "75 65 2c 66 61 6c 73 65 5d 2c 22 6e 75 6d 62 65 72 73 22 3a",
        "5b 33 33 33 33 33 33 33 33 33 2e 33 33 33 33 33 33 33 2c 31",
        "65 2b 33 30 2c 34 2e 35 2c 30 2e 30 30 32 2c 31 65 2d 32 37",
        "5d 2c 22 73 74 72 69 6e 67 22 3a 22 e2 82 ac 24 5c 75 30 30",
        "30 66 5c 6e 41 27 42 5c 22 5c 5c 5c 5c 5c 22 2f 22 7d",
      ].join(" "),
    );
  });

  it("§3.2.3: sorts properties by UTF-16 code units", () => {
    const input: JcsValue = JSON.parse(
      rfcText(`{
        "%u20ac": "Euro Sign",
        "%r": "Carriage Return",
        "%ufb33": "Hebrew Letter Dalet With Dagesh",
        "1": "One",
        "%ud83d%ude00": "Emoji: Grinning Face",
        "%u0080": "Control",
        "%u00f6": "Latin Small Letter O With Diaeresis"
      }`),
    );
    // Read the order from the text: JS objects enumerate integer-like keys ("1") first.
    const order = [...canonicalize(input).matchAll(/:"([^"]+)"/g)].map((m) => m[1]);
    expect(order).toEqual([
      "Carriage Return",
      "One",
      "Control",
      "Latin Small Letter O With Diaeresis",
      "Euro Sign",
      "Emoji: Grinning Face",
      "Hebrew Letter Dalet With Dagesh",
    ]);
    expect(canonicalize(input)).toBe(
      `{"\\r":"Carriage Return","1":"One","${cp(0x80)}":"Control","${cp(0xf6)}":"Latin Small Letter O With Diaeresis","${cp(0x20ac)}":"Euro Sign","${cp(0x1f600)}":"Emoji: Grinning Face","${cp(0xfb33)}":"Hebrew Letter Dalet With Dagesh"}`,
    );
  });

  // Appendix B, Table 1.
  it.each([
    ["0000000000000000", "0"],
    ["8000000000000000", "0"],
    ["0000000000000001", "5e-324"],
    ["8000000000000001", "-5e-324"],
    ["7fefffffffffffff", "1.7976931348623157e+308"],
    ["ffefffffffffffff", "-1.7976931348623157e+308"],
    ["4340000000000000", "9007199254740992"],
    ["c340000000000000", "-9007199254740992"],
    ["4430000000000000", "295147905179352830000"],
    ["44b52d02c7e14af5", "9.999999999999997e+22"],
    ["44b52d02c7e14af6", "1e+23"],
    ["44b52d02c7e14af7", "1.0000000000000001e+23"],
    ["444b1ae4d6e2ef4e", "999999999999999700000"],
    ["444b1ae4d6e2ef4f", "999999999999999900000"],
    ["444b1ae4d6e2ef50", "1e+21"],
    ["3eb0c6f7a0b5ed8c", "9.999999999999997e-7"],
    ["3eb0c6f7a0b5ed8d", "0.000001"],
    ["41b3de4355555553", "333333333.3333332"],
    ["41b3de4355555554", "333333333.33333325"],
    ["41b3de4355555555", "333333333.3333333"],
    ["41b3de4355555556", "333333333.3333334"],
    ["41b3de4355555557", "333333333.33333343"],
    ["becbf647612f3696", "-0.0000033333333333333333"],
    ["43143ff3c1cb0959", "1424953923781206.2"],
  ])("Appendix B: %s serializes as %s", (bits, expected) => {
    expect(canonicalize(fromBits(bits))).toBe(expected);
    expect(canonicalize([fromBits(bits)])).toBe(`[${expected}]`);
  });

  it.each([
    ["7fffffffffffffff", "NaN"],
    ["7ff0000000000000", "Infinity"],
  ])("Appendix B: %s (%s) is an error", (bits) => {
    expect(() => canonicalize(fromBits(bits))).toThrow(JcsError);
    expect(() => canonicalize({ n: fromBits(bits) })).toThrow(JcsError);
  });

  it("-Infinity is an error", () => {
    expect(() => canonicalize(Number.NEGATIVE_INFINITY)).toThrow(JcsError);
  });

  it("§3.2.2.2: a lone surrogate is an error, in a value or a key", () => {
    expect(() => canonicalize("\udead")).toThrow(JcsError);
    expect(() => canonicalize("a\ud83d")).toThrow(JcsError);
    expect(() => canonicalize({ "\ude00": 1 })).toThrow(JcsError);
    expect(() => canonicalize(["\ud800x"])).toThrow(JcsError);
  });
});

describe("what the event format relies on", () => {
  it("orders keys by UTF-16 code units, not by code points", () => {
    // U+1F600 is the surrogate pair D83D DE00; U+FB33 is one unit FB33. Code point order would put
    // U+FB33 first; UTF-16 order puts the pair first because D83D < FB33.
    expect(canonicalize({ [cp(0xfb33)]: 1, [cp(0x1f600)]: 2 })).toBe(
      `{"${cp(0x1f600)}":2,"${cp(0xfb33)}":1}`,
    );
    // U+FF61 (halfwidth) is above the surrogates; U+10000 (pair D800 DC00) sorts before it.
    expect(canonicalize({ [cp(0xff61)]: 1, [cp(0x10000)]: 2 })).toBe(
      `{"${cp(0x10000)}":2,"${cp(0xff61)}":1}`,
    );
  });

  it("orders CJK keys by code unit and keeps them literal", () => {
    // 午 U+5348, 支 U+652F, 金 U+91D1, 餐 U+9910; 𠀀 U+20000 is the pair D840 DC00.
    expect(canonicalize({ 餐: 4, 金: 3, 𠀀: 5, 支: 2, 午: 1 })).toBe(
      '{"午":1,"支":2,"金":3,"餐":4,"𠀀":5}',
    );
  });

  it("orders ASCII keys byte-wise: uppercase, digits and underscore before lowercase", () => {
    expect(canonicalize({ b: 1, a: 2, B: 3, _: 4, "10": 5, "2": 6, aa: 7, "": 8 })).toBe(
      '{"":8,"10":5,"2":6,"B":3,"_":4,"a":2,"aa":7,"b":1}',
    );
  });

  it("orders a prefix before its extensions", () => {
    expect(canonicalize({ "fields/f3/0": 1, fields: 2, "fields/f3": 3 })).toBe(
      '{"fields":2,"fields/f3":3,"fields/f3/0":1}',
    );
  });

  it("escapes C0 controls, quote and backslash exactly as the RFC says", () => {
    const controls = Array.from({ length: 0x20 }, (_, i) => String.fromCharCode(i)).join("");
    expect(canonicalize(controls)).toBe(
      '"\\u0000\\u0001\\u0002\\u0003\\u0004\\u0005\\u0006\\u0007\\b\\t\\n\\u000b\\f\\r\\u000e\\u000f' +
        '\\u0010\\u0011\\u0012\\u0013\\u0014\\u0015\\u0016\\u0017\\u0018\\u0019\\u001a\\u001b\\u001c\\u001d\\u001e\\u001f"',
    );
    expect(canonicalize('say "hi" \\ /')).toBe('"say \\"hi\\" \\\\ /"');
  });

  it("keeps DEL, C1 controls, U+2028/U+2029 and all non-ASCII literal", () => {
    const s = `${cp(0x7f, 0x80, 0x9f, 0x2028, 0x2029)}午饭 45 元 ${cp(0x1f600)} ${cp(0xfeff)}`;
    expect(canonicalize(s)).toBe(`"${s}"`);
    expect(hex(canonicalizeToBytes(cp(0x2028)))).toBe("22 e2 80 a8 22");
    expect(hex(canonicalizeToBytes(cp(0x1f600)))).toBe("22 f0 9f 98 80 22");
  });

  it("does not normalize Unicode", () => {
    const nfc = cp(0xe9); // e with acute, precomposed
    const nfd = cp(0x65, 0x301); // e + combining acute
    expect(canonicalize(nfc)).not.toBe(canonicalize(nfd));
    expect(canonicalize({ [nfd]: 1, [nfc]: 2 })).toBe(`{"${nfd}":1,"${nfc}":2}`);
    expect(hex(canonicalizeToBytes(nfd))).toBe("22 65 cc 81 22");
  });

  it("writes integers from 0 to 2^53 - 1 as plain digits", () => {
    expect(canonicalize(0)).toBe("0");
    expect(canonicalize(-0)).toBe("0");
    expect(canonicalize(1)).toBe("1");
    expect(canonicalize(2 ** 53 - 1)).toBe("9007199254740991");
    expect(canonicalize({ seq: 2 ** 53 - 1, k: 0 })).toBe('{"k":0,"seq":9007199254740991}');
  });

  it("sorts nested objects recursively and keeps array order", () => {
    const value: JcsValue = {
      z: [{ b: 1, a: [3, 2, 1] }, [], {}, [{ y: null, x: false }]],
      a: { d: { f: "x", e: true }, c: [] },
    };
    expect(canonicalize(value)).toBe(
      '{"a":{"c":[],"d":{"e":true,"f":"x"}},"z":[{"a":[3,2,1],"b":1},[],{},[{"x":false,"y":null}]]}',
    );
  });

  it("omits undefined object members (absent optional fields are not encoded)", () => {
    expect(canonicalize({ a: 1, b: undefined, c: null })).toBe('{"a":1,"c":null}');
    expect(canonicalize({ only: undefined })).toBe("{}");
    expect(canonicalize({ n: { x: undefined } })).toBe('{"n":{}}');
  });

  it("rejects inputs that would need a coercion", () => {
    const cyclic: Record<string, unknown> = {};
    cyclic["self"] = cyclic;
    const bad: unknown[] = [
      [1, undefined],
      undefined,
      () => 1,
      Symbol("s"),
      10n,
      new Date(0),
      new Map(),
      { toJSON: () => 1 },
      Object.assign(Object.create({ inherited: 1 }), { own: 1 }),
      new Number(1),
      { [Symbol("k")]: 1 },
      cyclic,
      { a: { b: [() => 1] } },
    ];
    for (const value of bad) {
      expect(() => canonicalize(value as JcsValue), String(value)).toThrow(JcsError);
    }
  });

  it("accepts objects without a prototype", () => {
    const o = Object.assign(Object.create(null) as Record<string, number>, { b: 2, a: 1 });
    expect(canonicalize(o)).toBe('{"a":1,"b":2}');
  });

  it("serializes a shared (non-cyclic) subobject each time it appears", () => {
    const shared = { k: 0 };
    expect(canonicalize([shared, shared])).toBe('[{"k":0},{"k":0}]');
  });
});
