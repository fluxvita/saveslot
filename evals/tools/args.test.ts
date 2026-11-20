// The runner's command line (./args.ts).

import { describe, expect, it } from "vitest";
import { runnerArgs, USAGE } from "./args.ts";

describe("the runner's command line", () => {
  it("without --today: the variant and the run directory, as given", () => {
    expect(runnerArgs(["evals/3a.yaml", "runs/3a-1"])).toEqual({
      file: "evals/3a.yaml",
      dir: "runs/3a-1",
      fixtureOnly: false,
      today: undefined,
    });
  });

  it("--today and --fixture-only anywhere; the day is taken after --today only", () => {
    for (const args of [
      ["--today", "2026-11-20", "evals/3a.yaml", "runs/x", "--fixture-only"],
      ["evals/3a.yaml", "--today", "2026-11-20", "runs/x", "--fixture-only"],
      ["evals/3a.yaml", "runs/x", "--fixture-only", "--today", "2026-11-20"],
    ]) {
      expect(runnerArgs(args)).toEqual({
        file: "evals/3a.yaml",
        dir: "runs/x",
        fixtureOnly: true,
        today: "2026-11-20",
      });
    }
  });

  it("refused: a word missing or one too many, --today without a day", () => {
    expect(runnerArgs(["evals/3a.yaml"])).toEqual({ error: USAGE });
    expect(runnerArgs(["evals/3a.yaml", "a", "b"])).toEqual({ error: USAGE });
    expect(runnerArgs(["evals/3a.yaml", "a", "--today"])).toEqual({
      error: "--today takes a day, YYYY-MM-DD",
    });
    expect(runnerArgs(["evals/3a.yaml", "a", "--today", "11/20"])).toEqual({
      error: "--today takes a day, YYYY-MM-DD",
    });
  });
});
