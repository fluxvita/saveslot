// The soak's issues: one per failing test, opened once and commented on when it fails again while
// open; a soak that left no report gets one too; the GitHub calls are the ones the REST interface
// documents. The tracker here is a stand-in.

import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  github,
  type Issue,
  marker,
  readFailures,
  report,
  type SoakRun,
  type Tracker,
} from "./soak-issues.ts";
import type { SoakFailure } from "./soak-props.ts";

const RUN: SoakRun = {
  url: "https://github.com/example/repo/actions/runs/42",
  branch: "main",
  sha: "0123456789abcdef0123",
};

const failure = (o: Partial<SoakFailure> = {}): SoakFailure => ({
  file: "packages/kernel/src/judge/replay-deletion.prop.test.ts",
  test: "state table > a deletion's replay leaves what the reference evaluator gives",
  round: 6,
  outcome: "failed",
  log: "failure-1-src-judge-replay-deletion.log",
  lines: [
    "Error: Property failed after 79 tests",
    '{ seed: -652076658, path: "80:3:2", endOnFailure: true }',
    'Counterexample: [{"ops":[]}]',
  ],
  ...o,
});

/** A tracker in memory. */
function stand(open: Issue[] = []) {
  const made: { number: number; title: string; body: string }[] = [];
  const comments: { issue: number; body: string }[] = [];
  let labels = 0;
  const tracker: Tracker = {
    openIssues: async () => [...open, ...made],
    ensureLabel: async () => {
      labels++;
    },
    create: async (title, body) => {
      const number = 100 + made.length;
      made.push({ number, title, body });
      return number;
    },
    comment: async (issue, body) => {
      comments.push({ issue, body });
    },
  };
  return { tracker, made, comments, labels: () => labels };
}

describe("report", () => {
  it("a new failure opens an issue with the file, the test, the seed and path, the counterexample and the run", async () => {
    const s = stand();
    const done = await report([failure()], RUN, s.tracker);
    expect(s.labels()).toBe(1);
    expect(s.made).toHaveLength(1);
    const [issue] = s.made;
    expect(issue?.title).toBe(
      "soak: state table > a deletion's replay leaves what the reference evaluator gives (replay-deletion.prop.test.ts)",
    );
    for (const part of [
      "- File: `packages/kernel/src/judge/replay-deletion.prop.test.ts`",
      "- Test: state table > a deletion's replay leaves what the reference evaluator gives",
      '{ seed: -652076658, path: "80:3:2", endOnFailure: true }',
      'Counterexample: [{"ops":[]}]',
      "Run: https://github.com/example/repo/actions/runs/42 (branch `main`, 0123456789ab), round 6, failed.",
      "`failure-1-src-judge-replay-deletion.log`",
    ])
      expect(issue?.body).toContain(part);
    expect(done).toEqual([
      "#100 opened: packages/kernel/src/judge/replay-deletion.prop.test.ts > state table > a deletion's replay leaves what the reference evaluator gives",
    ]);
  });

  it("a test that fails again while its issue is open: a comment on it, no new issue", async () => {
    const key =
      "packages/kernel/src/judge/replay-deletion.prop.test.ts > state table > a deletion's replay leaves what the reference evaluator gives";
    const s = stand([
      { number: 7, body: "unrelated" },
      { number: 9, body: `${marker(key)}\nThe property soak found a failure.` },
    ]);
    const done = await report([failure({ lines: ['{ seed: 5, path: "1" }'] })], RUN, s.tracker);
    expect(s.made).toEqual([]);
    expect(s.comments).toHaveLength(1);
    expect(s.comments[0]?.issue).toBe(9);
    expect(s.comments[0]?.body).toContain('{ seed: 5, path: "1" }');
    expect(done).toEqual([`#9 updated: ${key}`]);
  });

  it("one issue per test: two tests, two issues; one test failing twice in a run, one issue with both", async () => {
    const s = stand();
    await report(
      [
        failure({ round: 1 }),
        failure({ test: "state table > another", round: 1 }),
        failure({ round: 3, lines: ['{ seed: 3, path: "3" }'] }),
      ],
      RUN,
      s.tracker,
    );
    expect(s.made).toHaveLength(2);
    expect(s.made[0]?.body).toContain("round 1, failed");
    expect(s.made[0]?.body).toContain('{ seed: 3, path: "3" }');
    expect(s.made[1]?.title).toBe("soak: state table > another (replay-deletion.prop.test.ts)");
  });

  it("a stalled run, no test named: an issue for its file, saying so", async () => {
    const s = stand();
    await report(
      [
        failure({
          test: undefined,
          outcome: "stalled",
          lines: ["stopped after 15 min without finishing"],
        }),
      ],
      RUN,
      s.tracker,
    );
    expect(s.made[0]?.title).toBe("soak: replay-deletion.prop.test.ts");
    expect(s.made[0]?.body).toContain("- Test: none named");
    expect(s.made[0]?.body).toContain("stopped after 15 min without finishing");
  });

  it("a soak that failed without its report: an issue of its own, then comments on it", async () => {
    const s = stand();
    await report([], RUN, s.tracker);
    expect(s.made[0]?.title).toBe("soak: the property soak did not report");
    expect(s.made[0]?.body).toContain("failed without leaving its report");
    await report([], RUN, s.tracker);
    expect(s.made).toHaveLength(1);
    expect(s.comments.map((c) => c.issue)).toEqual([100]);
  });

  it("a very long counterexample is cut in the issue, the artifact named for the rest", async () => {
    const s = stand();
    await report([failure({ lines: [`Counterexample: ${"x".repeat(10_000)}`] })], RUN, s.tracker);
    expect(s.made[0]?.body.length).toBeLessThan(6_000);
    expect(s.made[0]?.body).toContain("the whole line is in the run's artifact");
  });
});

describe("readFailures", () => {
  const dir = mkdtempSync(join(tmpdir(), "soak-issues-"));
  afterAll(() => rmSync(dir, { recursive: true, force: true }));

  it("reads failures.jsonl; none without the file", () => {
    expect(readFailures(join(dir, "missing"))).toEqual([]);
    writeFileSync(join(dir, "failures.jsonl"), `${JSON.stringify(failure())}\n`);
    expect(readFailures(dir)).toEqual([failure()]);
  });
});

describe("the GitHub tracker", () => {
  const calls: { method: string; url: string; body: unknown; auth: string | null }[] = [];
  const reply = (status: number, body: unknown) =>
    new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json" } });
  const fake = (answer: (method: string, url: string) => Response): typeof fetch =>
    (async (url: string | URL | Request, init?: RequestInit) => {
      const method = init?.method ?? "GET";
      calls.push({
        method,
        url: String(url),
        body: init?.body === undefined ? undefined : JSON.parse(String(init.body)),
        auth: new Headers(init?.headers).get("authorization"),
      });
      return answer(method, String(url));
    }) as typeof fetch;

  it("lists the open issues labelled soak page by page, leaving out pull requests", async () => {
    calls.length = 0;
    const page1 = Array.from({ length: 100 }, (_, i) => ({ number: i + 1, body: null }));
    const t = github({
      token: "t0ken",
      repository: "example/repo",
      fetch: fake((_, url) =>
        url.endsWith("page=1")
          ? reply(200, page1)
          : reply(200, [
              { number: 101, body: "b" },
              { number: 102, body: "pr", pull_request: {} },
            ]),
      ),
    });
    const open = await t.openIssues();
    expect(open).toHaveLength(101);
    expect(open[100]).toEqual({ number: 101, body: "b" });
    expect(calls.map((c) => c.url)).toEqual([
      "https://api.github.com/repos/example/repo/issues?labels=soak&state=open&per_page=100&page=1",
      "https://api.github.com/repos/example/repo/issues?labels=soak&state=open&per_page=100&page=2",
    ]);
    expect(calls[0]?.auth).toBe("Bearer t0ken");
  });

  it("makes the label unless it is there (422), opens issues with it, comments", async () => {
    calls.length = 0;
    const t = github({
      token: "t0ken",
      repository: "example/repo",
      fetch: fake((_method, url) =>
        url.endsWith("/labels")
          ? reply(422, { message: "Validation Failed" })
          : url.endsWith("/issues")
            ? reply(201, { number: 5 })
            : reply(201, {}),
      ),
    });
    await t.ensureLabel();
    expect(await t.create("soak: x", "body")).toBe(5);
    await t.comment(5, "again");
    expect(
      calls.map((c) => [
        c.method,
        c.url.replace("https://api.github.com/repos/example/repo", ""),
        c.body,
      ]),
    ).toEqual([
      [
        "POST",
        "/labels",
        { name: "soak", color: "d93f0b", description: "Found by the scheduled property soak" },
      ],
      ["POST", "/issues", { title: "soak: x", body: "body", labels: ["soak"] }],
      ["POST", "/issues/5/comments", { body: "again" }],
    ]);
  });

  it("a refused call fails with what GitHub said", async () => {
    const t = github({
      token: "t0ken",
      repository: "example/repo",
      fetch: fake(() => reply(403, { message: "Resource not accessible by integration" })),
    });
    await expect(t.create("soak: x", "body")).rejects.toThrow(
      /opening an issue: 403 .*Resource not accessible by integration/,
    );
    await expect(t.ensureLabel()).rejects.toThrow(/making the soak label: 403/);
  });
});
