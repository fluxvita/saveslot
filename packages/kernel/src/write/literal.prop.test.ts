// The literal checker's number tokens, at random (04-write-and-read «来源级别»: a number compared by
// value, not by how it is written): a value written in evidence any way the checker takes
// (thousands separators, leading and trailing zeros, fullwidth digits), among words and other
// numbers, is a hit; evidence with only other numbers is a miss.

import { propRuns } from "@fluxvita/saveslot-reference/testing";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { checkLiteral, indexEvidence, numberKey } from "./literal.ts";

const RUNS = propRuns(500);

/** A canonical decimal: an integer part without leading zeros, maybe a fraction. */
const value = fc
  .tuple(
    fc.bigInt({ min: 0n, max: 10n ** 15n }),
    fc.option(fc.stringMatching(/^[0-9]{0,5}[1-9]$/), { nil: undefined }),
  )
  .map(([i, f]) => (f === undefined ? `${i}` : `${i}.${f}`));

/** One way of writing a decimal in evidence, by value the same. */
const written = (v: string) =>
  fc
    .record({
      thousands: fc.boolean(),
      lead: fc.nat(2),
      trail: fc.nat(2),
      fullwidth: fc.boolean(),
    })
    .map(({ thousands, lead, trail, fullwidth }) => {
      const [i, f] = v.split(".") as [string, string | undefined];
      const int =
        thousands && lead === 0 ? i.replace(/\B(?=([0-9]{3})+$)/g, ",") : "0".repeat(lead) + i;
      const frac =
        f === undefined ? (trail > 0 ? `.${"0".repeat(trail)}` : "") : `.${f}${"0".repeat(trail)}`;
      const s = int + frac;
      return fullwidth
        ? [...s]
            .map((c) => (c >= "0" && c <= "9" ? String.fromCodePoint(c.charCodeAt(0) + 0xfee0) : c))
            .join("")
        : s;
    });

/** Words between numbers: no digit, nothing that joins a number to the next. */
const words = fc.constantFrom("跑了", " 今天 ", "and ", "，然后", "元", " km ", "。", "\n");

describe("number tokens", () => {
  it("a value written any way taken, among words and other numbers: a hit", () => {
    fc.assert(
      fc.property(
        value.chain((v) =>
          fc.tuple(fc.constant(v), written(v), fc.array(value, { maxLength: 4 }), words, words),
        ),
        ([v, w, others, a, b]) => {
          const text = [...others.map((o) => `${o}${a}`), w, b].join(" ");
          expect(checkLiteral({ type: "decimal" }, v, indexEvidence(text))).toBe("hit");
        },
      ),
      { numRuns: RUNS },
    );
  });

  it("evidence with other numbers only: a miss", () => {
    fc.assert(
      fc.property(value, fc.array(value, { maxLength: 6 }), words, (v, others, a) => {
        const rest = others.filter((o) => numberKey(o) !== numberKey(v));
        const text = rest.map((o) => `${a}${o}${a}`).join(" ");
        expect(checkLiteral({ type: "decimal" }, v, indexEvidence(text))).toBe("miss");
      }),
      { numRuns: RUNS },
    );
  });
});
