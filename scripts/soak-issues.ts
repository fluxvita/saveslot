// What a failed property soak found, as issues (02-architecture §11): one issue per failing test,
// labelled `soak`, opened the first time the test fails and commented on each time it fails again
// while the issue is open. Each says the file, the test, the seed and path, the counterexample and
// the run, so that it can be replayed without the run's artifact. A soak that failed without
// leaving `failures.jsonl` (it stopped before its report, or ran out of time) gets an issue of its
// own, kept the same way.
//
// An issue is found again by a marker in its body (the key's hash), not by its title: a test's name
// can be longer than a title may be.
//
// Usage (the soak workflow, after a failed soak): node scripts/soak-issues.ts
//   SOAK_DIR           the soak's output directory (default soak)
//   GITHUB_TOKEN       the workflow's token, allowed to write issues
//   GITHUB_REPOSITORY, GITHUB_SERVER_URL, GITHUB_RUN_ID, GITHUB_REF_NAME, GITHUB_SHA  as GitHub sets them

import { createHash } from "node:crypto";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { SoakFailure } from "./soak-props.ts";

export const LABEL = "soak";

/** The run the failures come from. */
export interface SoakRun {
  readonly url: string;
  readonly branch: string;
  readonly sha: string;
}

export interface Issue {
  readonly number: number;
  readonly body: string;
}

/** What the report needs of the issue tracker. */
export interface Tracker {
  /** The open issues labelled `soak`. */
  openIssues(): Promise<Issue[]>;
  /** Makes the label if it is not there. */
  ensureLabel(): Promise<void>;
  create(title: string, body: string): Promise<number>;
  comment(issue: number, body: string): Promise<void>;
}

/** A failure of one test, or of the soak itself (`test` and `file` both undefined). */
type Found = Partial<Omit<SoakFailure, "file">> & { readonly file: string | undefined };

const keyOf = (f: Found): string =>
  f.file === undefined
    ? "the soak did not report"
    : f.test === undefined
      ? `${f.file} (no failing test named)`
      : `${f.file} > ${f.test}`;

/** The marker that finds a key's issue again. */
export const marker = (key: string): string =>
  `<!-- soak:${createHash("sha256").update(key).digest("hex").slice(0, 16)} -->`;

/** At most this many characters of one line in an issue (a counterexample can be very long). */
const LINE_MAX = 4_000;
const cut = (l: string): string =>
  l.length <= LINE_MAX
    ? l
    : `${l.slice(0, LINE_MAX)} … (cut at ${LINE_MAX} characters; the whole line is in the run's artifact)`;

function occurrence(f: Found, run: SoakRun): string {
  if (f.file === undefined)
    return `The soak failed without leaving its report (\`failures.jsonl\`): it stopped before the end, or ran out of time. Run: ${run.url} (branch \`${run.branch}\`, ${run.sha.slice(0, 12)}).\n`;
  return [
    `Run: ${run.url} (branch \`${run.branch}\`, ${run.sha.slice(0, 12)}), round ${f.round}, ${f.outcome}. Whole output: \`${f.log}\` in the run's \`soak\` artifact.`,
    "",
    "```",
    ...(f.lines ?? []).map(cut),
    "```",
    "",
  ].join("\n");
}

function title(f: Found): string {
  if (f.file === undefined) return "soak: the property soak did not report";
  const where = f.file.split("/").slice(-1)[0] as string;
  const what = f.test === undefined ? where : `${f.test} (${where})`;
  const t = `soak: ${what}`;
  return t.length <= 200 ? t : `${t.slice(0, 199)}…`;
}

function newBody(key: string, f: Found, run: SoakRun): string {
  const head =
    f.file === undefined
      ? []
      : [
          `- File: \`${f.file}\``,
          `- Test: ${f.test === undefined ? "none named (the run stalled, or the file failed as a whole)" : f.test}`,
          "",
          "Replay with the seed and path below (fast-check's `seed` and `path` options on the property). Each new failure of this test while this issue is open is added as a comment.",
          "",
        ];
  return [marker(key), "The property soak found a failure.", "", ...head, occurrence(f, run)].join(
    "\n",
  );
}

/**
 * Opens or updates one issue per failing test. `failures` empty means the soak failed without its
 * report. Returns what it did, one line per issue.
 */
export async function report(
  failures: readonly SoakFailure[],
  run: SoakRun,
  tracker: Tracker,
): Promise<string[]> {
  const found: readonly Found[] =
    failures.length > 0 ? failures : [{ file: undefined, test: undefined }];
  // One issue a test however often it failed in this run: its occurrences go together.
  const byKey = new Map<string, Found[]>();
  for (const f of found) byKey.set(keyOf(f), [...(byKey.get(keyOf(f)) ?? []), f]);
  await tracker.ensureLabel();
  const open = await tracker.openIssues();
  const done: string[] = [];
  for (const [key, fs] of byKey) {
    const first = fs[0] as Found;
    const existing = open.find((i) => i.body.includes(marker(key)));
    if (existing) {
      await tracker.comment(
        existing.number,
        ["It failed again.", "", ...fs.map((f) => occurrence(f, run))].join("\n"),
      );
      done.push(`#${existing.number} updated: ${key}`);
    } else {
      const rest = fs.slice(1).map((f) => occurrence(f, run));
      const n = await tracker.create(title(first), [newBody(key, first, run), ...rest].join("\n"));
      done.push(`#${n} opened: ${key}`);
    }
  }
  return done;
}

/** The soak's failures, from its output directory; empty when it left no `failures.jsonl`. */
export function readFailures(dir: string): SoakFailure[] {
  const path = join(dir, "failures.jsonl");
  if (!existsSync(path)) return [];
  return readFileSync(path, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => JSON.parse(l) as SoakFailure);
}

/** The tracker on GitHub's REST interface, with the workflow's token. */
export function github(o: {
  token: string;
  repository: string;
  api?: string;
  fetch?: typeof fetch;
}): Tracker {
  const f = o.fetch ?? fetch;
  const base = `${o.api ?? "https://api.github.com"}/repos/${o.repository}`;
  const call = async (method: string, path: string, body?: unknown): Promise<Response> => {
    const res = await f(`${base}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${o.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(body !== undefined ? { "content-type": "application/json" } : {}),
      },
      ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
      signal: AbortSignal.timeout(30_000),
    });
    return res;
  };
  const ok = async (res: Response, what: string): Promise<Response> => {
    if (!res.ok) throw new Error(`${what}: ${res.status} ${await res.text()}`);
    return res;
  };
  return {
    async openIssues() {
      const all: Issue[] = [];
      for (let page = 1; ; page++) {
        const res = await ok(
          await call("GET", `/issues?labels=${LABEL}&state=open&per_page=100&page=${page}`),
          "listing the open soak issues",
        );
        const items = (await res.json()) as {
          number: number;
          body: string | null;
          pull_request?: unknown;
        }[];
        for (const i of items)
          if (i.pull_request === undefined) all.push({ number: i.number, body: i.body ?? "" });
        if (items.length < 100) return all;
      }
    },
    async ensureLabel() {
      const res = await call("POST", "/labels", {
        name: LABEL,
        color: "d93f0b",
        description: "Found by the scheduled property soak",
      });
      // 422: the label is there already.
      if (res.status !== 422) await ok(res, "making the soak label");
    },
    async create(t, body) {
      const res = await ok(
        await call("POST", "/issues", { title: t, body, labels: [LABEL] }),
        "opening an issue",
      );
      return ((await res.json()) as { number: number }).number;
    },
    async comment(issue, body) {
      await ok(await call("POST", `/issues/${issue}/comments`, { body }), "commenting");
    },
  };
}

async function main(): Promise<void> {
  const env = (name: string): string => {
    const v = process.env[name];
    if (v === undefined || v === "") throw new Error(`${name} is not set`);
    return v;
  };
  const repository = env("GITHUB_REPOSITORY");
  const run: SoakRun = {
    url: `${env("GITHUB_SERVER_URL")}/${repository}/actions/runs/${env("GITHUB_RUN_ID")}`,
    branch: env("GITHUB_REF_NAME"),
    sha: env("GITHUB_SHA"),
  };
  const done = await report(
    readFailures(process.env["SOAK_DIR"] ?? "soak"),
    run,
    github({ token: env("GITHUB_TOKEN"), repository }),
  );
  for (const l of done) console.log(l);
}

if (import.meta.main) await main();
