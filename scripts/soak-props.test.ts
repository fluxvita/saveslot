// The soak script: a failed property run must leave its seed, replay path and counterexample in
// the report; a run that does not end is stopped, with whatever it started; one stopped by the
// budget's end is not a pass, and one that had found a failure by then is a failure; what the
// properties count is added up. The runs here are stand-ins, small scripts run by node.

import { existsSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  cannotListGroups,
  groupPids,
  outcomeOf,
  type RunRecord,
  replayLines,
  slug,
  soak,
  testsMs,
} from "./soak-props.ts";

const FAILED = ` FAIL  packages/reference/src/log.prop.test.ts > state table > «撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay
Error: Property failed after 1083 tests
{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }
Counterexample: [{"st":[{"t":"cancel","back":0}]},false]
Shrunk 5 time(s)

Hint: Enable verbose mode in order to have the list of all failing values encountered during the run
 ❯ buildError node_modules/.pnpm/fast-check/lib/fast-check.js:2469:16
   × state table > «撤回还原» 12ms
{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }
`;

describe("replayLines", () => {
  it("keeps the failure, the seed and path, and the counterexample, once each", () => {
    expect(replayLines(FAILED)).toEqual([
      " FAIL  packages/reference/src/log.prop.test.ts > state table > «撤回还原»: after a cancellation, what grace-period writes did not cover is as the forced replay",
      "Error: Property failed after 1083 tests",
      '{ seed: 615083135, path: "1180:48:0:0:1:2", endOnFailure: true }',
      'Counterexample: [{"st":[{"t":"cancel","back":0}]},false]',
      "   × state table > «撤回还原» 12ms",
    ]);
  });

  it("keeps the same lines from a colored run, as Vitest writes them in CI, without the colors", () => {
    const E = "\u001b";
    const colored = [
      `${E}[41m${E}[1m FAIL ${E}[22m${E}[49m packages/reference/src/log.prop.test.ts${E}[2m > ${E}[22mevent table${E}[2m > ${E}[22m«撤回还原»`,
      `${E}[31m${E}[1mError${E}[22m: Property failed after 460 tests`,
      '{ seed: -520325339, path: "498:57:56:57:57:57:57:57:57:57", endOnFailure: true }',
      'Counterexample: [{"st":[]}]',
      `${E}[31m     ${E}[31m×${E}[31m «撤回还原» 1087ms${E}[39m`,
    ].join("\n");
    expect(replayLines(colored)).toEqual([
      " FAIL  packages/reference/src/log.prop.test.ts > event table > «撤回还原»",
      "Error: Property failed after 460 tests",
      '{ seed: -520325339, path: "498:57:56:57:57:57:57:57:57:57", endOnFailure: true }',
      'Counterexample: [{"st":[]}]',
      "     × «撤回还原» 1087ms",
    ]);
  });

  it("finds nothing in a passing run", () => {
    expect(
      replayLines(" ✓ packages/a.prop.test.ts (2 tests) 300ms\n Test Files  1 passed (1)\n"),
    ).toEqual([]);
  });

  it("names a file by its last parts", () => {
    expect(slug("packages/kernel/src/write/record.prop.test.ts")).toBe("src-write-record");
  });
});

describe("how a run ended", () => {
  const run = (o: Partial<Parameters<typeof outcomeOf>[0]>) =>
    outcomeOf({ status: 0, signal: null, output: "", stopped: undefined, ...o });

  it("ended: passed on 0, failed otherwise", () => {
    expect(run({})).toBe("passed");
    expect(run({ status: 1 })).toBe("failed");
    expect(run({ status: null, signal: "SIGKILL" })).toBe("failed");
  });

  it("stopped at its limit: stalled, or failed when its output shows a failure", () => {
    expect(run({ status: null, signal: "SIGTERM", stopped: "limit" })).toBe("stalled");
    expect(run({ status: null, signal: "SIGTERM", stopped: "limit", output: FAILED })).toBe(
      "failed",
    );
  });

  it("stopped at the budget's end: never passed; failed when its output shows a failure", () => {
    expect(run({ stopped: "budget" })).toBe("stopped at the end");
    expect(run({ status: null, signal: "SIGTERM", stopped: "budget", output: FAILED })).toBe(
      "failed",
    );
  });

  it("the time in the tests: Vitest's Duration times the share it gives the tests", () => {
    expect(testsMs("\n   Duration  9.04s (tests 99%, import 1%)\n")).toBeCloseTo(8949.6);
    expect(testsMs("\n   Duration  830ms (transform 40%, tests 50%, import 10%)\n")).toBe(415);
    expect(testsMs("\n   Duration  830ms (import 100%)\n")).toBeUndefined();
    expect(testsMs("no report")).toBeUndefined();
    // As Vitest writes it in CI.
    expect(
      testsMs("\u001b[2m   Duration \u001b[22m 14.26s\u001b[2m (tests 100%)\u001b[22m\n"),
    ).toBe(14260);
  });
});

describe("finding what a run leaves", () => {
  it("ps finds a process group on this machine", async () => {
    expect(await cannotListGroups()).toBeUndefined();
  });

  it("a list that finds nothing, or cannot be made, is said so", async () => {
    expect(await cannotListGroups(() => [])).toMatch(
      /^cannot list a process group with ps on this machine: a process started for the purpose \(\d+\) was not found/,
    );
    expect(
      await cannotListGroups(() => {
        throw new Error(
          "cannot list a process group with ps on this machine (spawnSync ps ENOENT)",
        );
      }),
    ).toBe("cannot list a process group with ps on this machine (spawnSync ps ENOENT)");
  });

  it("an empty group is no processes", () => {
    // A group no process has: the probe's own pid is never one, after it is gone.
    expect(groupPids(2 ** 22 + 1)).toEqual([]);
  });
});

describe("the soak, with stand-in runs", () => {
  const root = mkdtempSync(join(tmpdir(), "soak-"));
  afterAll(() => rmSync(root, { recursive: true, force: true }));
  let n = 0;

  /** A stand-in run: a script for node. */
  const script = (name: string, body: string) => {
    const f = join(root, `${name}.mjs`);
    writeFileSync(f, body);
    return f;
  };
  /** A script that starts a process of its own that waits, its pid written to `pidFile`. */
  const startsOne = (pidFile: string) => `
    import { spawn } from "node:child_process";
    import { writeFileSync } from "node:fs";
    const c = spawn(process.execPath, ["-e", "setInterval(() => {}, 1000)"], { stdio: "ignore" });
    writeFileSync(${JSON.stringify(pidFile)}, String(c.pid));
  `;
  const alive = (pidFile: string) => {
    try {
      process.kill(Number(readFileSync(pidFile, "utf8")), 0);
      return true;
    } catch {
      return false;
    }
  };

  const run = async (
    files: string[],
    o: {
      budgetMs?: number;
      limitMs?: number;
      rounds?: number;
      listGroup?: (pgid: number) => number[];
      beforeEach?: () => void;
    },
  ) => {
    const dir = join(root, `out-${n++}`);
    const lines: string[] = [];
    const code = await soak({
      files,
      argvOf: (f) => {
        o.beforeEach?.();
        return [process.execPath, f];
      },
      ...(o.listGroup !== undefined ? { listGroup: o.listGroup } : {}),
      budgetMs: o.budgetMs ?? 60_000,
      runLimitMs: o.limitMs ?? 60_000,
      dir,
      env: process.env,
      graceMs: 300,
      maxRounds: o.rounds ?? 1,
      log: (l) => lines.push(l),
    });
    if (!existsSync(join(dir, "runs.jsonl"))) {
      return { code, runs: [] as RunRecord[], dir, read: (_: string) => "", lines };
    }
    const runs = readFileSync(join(dir, "runs.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as RunRecord);
    const read = (f: string) => readFileSync(join(dir, f), "utf8");
    return { code, runs, dir, read, lines };
  };

  it("a failing property: failed, exit 1; its seed, path and counterexample in failures.md, its output beside it", async () => {
    const fail = script(
      "fail",
      `process.stdout.write(${JSON.stringify(FAILED)}); process.exit(1);`,
    );
    const r = await run([fail], {});
    expect(r.code).toBe(1);
    expect(r.runs.map((x) => x.outcome)).toEqual(["failed"]);
    expect(r.read("failures.md")).toContain('{ seed: 615083135, path: "1180:48:0:0:1:2"');
    expect(r.read("failures.md")).toContain("Counterexample: ");
    const log = /Full output: `(failure-1-[^`]+\.log)`/.exec(r.read("failures.md"))?.[1];
    expect(r.read(log as string)).toContain("Shrunk 5 time(s)");
    expect(r.read("summary.md")).toContain("1 failed, 0 stalled");
  });

  it("a run that does not end, nor when asked to: stalled at its limit, killed with what it started; exit 1", async () => {
    const pid = join(root, "stalled.pid");
    const hang = script(
      "hang",
      `${startsOne(pid)}
      process.on("SIGTERM", () => {});
      setInterval(() => {}, 1000);`,
    );
    const r = await run([hang], { limitMs: 1_000 });
    expect(r.code).toBe(1);
    expect(r.runs.map((x) => x.outcome)).toEqual(["stalled"]);
    expect(r.read("failures.md")).toContain("stopped after 0 min without finishing");
    expect(alive(pid)).toBe(false);
  });

  it("the budget's end during a run with no failure seen: stopped at the end, not passed; exit 0", async () => {
    const slow = script("slow", "setInterval(() => {}, 1000);");
    const r = await run([slow], { budgetMs: 1_000 });
    expect(r.code).toBe(0);
    expect(r.runs.map((x) => x.outcome)).toEqual(["stopped at the end"]);
    expect(r.read("summary.md")).toContain("0 passed");
    expect(r.read("summary.md")).toContain(
      "1 stopped at the budget's end with no failure seen (not counted as passed)",
    );
  });

  it("the budget's end while a failure found is being shrunk: failed, with its seed and path; exit 1", async () => {
    const shrinking = script(
      "shrinking",
      `process.stdout.write(${JSON.stringify(FAILED)}); setInterval(() => {}, 1000);`,
    );
    const r = await run([shrinking], { budgetMs: 1_000 });
    expect(r.code).toBe(1);
    expect(r.runs.map((x) => x.outcome)).toEqual(["failed"]);
    expect(r.read("failures.md")).toContain("stopped at the budget's end");
    expect(r.read("failures.md")).toContain('{ seed: 615083135, path: "1180:48:0:0:1:2"');
  });

  it("a run that ends and leaves a process running: the process is stopped, and counted", async () => {
    const pid = join(root, "left.pid");
    const leaves = script("leaves", `${startsOne(pid)} process.exit(0);`);
    const r = await run([leaves], {});
    expect(r.runs.map((x) => [x.outcome, x.left])).toEqual([["passed", 1]]);
    expect(alive(pid)).toBe(false);
    expect(r.read("summary.md")).toContain(
      "Processes a run left and that were stopped with it: 1.",
    );
  });

  it("samples are added up over the runs that passed, for the files that count them; the time outside the tests is the run's time less Vitest's time in them", async () => {
    const counts = script(
      "counts",
      `import { appendFileSync } from "node:fs";
      appendFileSync(process.env.PROP_COVERAGE, JSON.stringify({ name: "p", skipped: 1, samples: 40, hits: 30, share: 0.75, min: 0.5 }) + "\\n");
      console.log("   Duration  20ms (tests 50%, import 50%)");`,
    );
    const quiet = script("quiet", "");
    const r = await run([counts, quiet], { rounds: 3 });
    expect(r.code).toBe(0);
    expect(r.runs.map((x) => x.outcome)).toEqual(Array(6).fill("passed"));
    const summary = r.read("summary.md");
    expect(summary).toContain("(1 of 2 files): 120 in the runs that passed");
    expect(summary).toMatch(/\| [^|]*counts\.mjs \| 3 \| 0 \| 0 \| 0 \| 120 \|/);
    expect(summary).toMatch(/\| [^|]*quiet\.mjs \| 3 \| 0 \| 0 \| 0 \| not counted \|/);
    const counted = r.runs.filter((x) => x.file === counts);
    for (const x of counted) expect(x.outsideMs).toBe(Math.max(0, x.ms - 10));
    expect(r.runs.filter((x) => x.file === quiet).every((x) => x.outsideMs === undefined)).toBe(
      true,
    );
    expect(existsSync(join(r.dir, "failures.md"))).toBe(true);
  });

  it("ps cannot find a process group: said, exit 2, nothing run and nothing written", async () => {
    const quiet = script("never", "");
    for (const listGroup of [
      () => [],
      () => {
        throw new Error(
          "cannot list a process group with ps on this machine (spawnSync ps ENOENT)",
        );
      },
    ]) {
      const r = await run([quiet], { listGroup });
      expect(r.code).toBe(2);
      expect(r.lines.join("\n")).toMatch(
        /^cannot list a process group with ps on this machine.*Nothing was run\.$/s,
      );
      expect(existsSync(r.dir)).toBe(false);
    }
  });

  it("ps failing during the soak stops it with the error: no run reported as having left nothing", async () => {
    const quiet = script("fine", "");
    let broken = false;
    await expect(
      run([quiet], {
        listGroup: (g) => {
          if (broken) throw new Error("cannot list a process group with ps on this machine (gone)");
          return groupPids(g);
        },
        beforeEach: () => {
          broken = true;
        },
      }),
    ).rejects.toThrow("cannot list a process group with ps on this machine (gone)");
  });
});
