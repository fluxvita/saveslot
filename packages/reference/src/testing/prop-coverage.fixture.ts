// Run counts and hit counts for property tests.
//
// Every property runs `propRuns(default)` samples; `PROP_RUNS` overrides the default for all of
// them (a soak run). Each property also counts its hits: the samples that reached the situation
// it checks (an assertion that can fail, or for a property whose assertion fires only on a
// violation, the situation in which it would). A property whose share of hits falls below its
// stated minimum fails, so a generator that stops reaching the checked situation does not pass
// vacuously.

import { appendFileSync } from "node:fs";
import fc from "fast-check";
import { expect } from "vitest";

/** The run count of a property: `PROP_RUNS` when set, otherwise `fallback`. */
export function propRuns(fallback: number): number {
  const runs = Number(process.env["PROP_RUNS"]);
  return Number.isInteger(runs) && runs > 0 ? runs : fallback;
}

export class Hits {
  /** Samples skipped by `fc.pre`. */
  skipped = 0;
  /** Samples run to the end (not skipped). */
  samples = 0;
  /** Samples run to the end that hit. */
  hits = 0;
  private hitNow = false;
  /** The smallest share of samples run to the end that must hit. */
  readonly min: number;

  constructor(min: number) {
    this.min = min;
  }

  /** The predicate, counting its samples. A sample hits when it calls `hit()`. */
  track<A extends unknown[]>(predicate: (...args: A) => void): (...args: A) => void {
    return (...args: A) => {
      this.hitNow = false;
      try {
        predicate(...args);
      } catch (e) {
        if (fc.PreconditionFailure.isFailure(e)) this.skipped++;
        throw e;
      }
      this.samples++;
      if (this.hitNow) this.hits++;
    };
  }

  hit(): void {
    this.hitNow = true;
  }

  get share(): number {
    return this.samples === 0 ? 0 : this.hits / this.samples;
  }

  /**
   * Fails when the share of hits is below the minimum. With `PROP_COVERAGE` set to a file path,
   * appends one JSON line per property: name, samples skipped, run and hit, share, minimum.
   */
  check(): void {
    const name = expect.getState().currentTestName ?? "";
    const out = process.env["PROP_COVERAGE"];
    if (out) {
      const { skipped, samples, hits, min } = this;
      const share = Math.round(this.share * 1000) / 1000;
      appendFileSync(out, `${JSON.stringify({ name, skipped, samples, hits, share, min })}\n`);
    }
    expect(
      { property: name, share: this.share >= this.min ? "at least the minimum" : this.share },
      `share of samples that reached the checked situation, minimum ${this.min}`,
    ).toEqual({ property: name, share: "at least the minimum" });
  }
}
