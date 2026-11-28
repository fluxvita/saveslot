// Judges the `rubric` assertions a run's judgement left open (./judge.ts) with a judge model, as
// docs/zh-CN/spec/10-evals.md §2.4 has it: the model sees only the user's words, the agent's
// replies and the rubric, and answers whether it holds, with one sentence why. A share of the
// judged assertions (20% by default, §17 item 6) is marked for a person to check; which ones is
// fixed by the run and the assertion, so judging again marks the same ones.
//
//   node --conditions=source evals/tools/rubric.ts --model <judge model> [--spot 0.2]
//     <run directory> [<run directory> …]
//
// The judge model is run through Claude Code (`claude -p`), with no tools, no MCP servers, no
// settings and a system prompt of its own, in an empty directory. It must not be the model the
// run's host used (§17 item 6). Rewrites <run>/judgement.json: each judged rubric becomes pass or
// fail, with `judge: {model, holds, reason, spot_check}`, and the run's outcome is worked out
// again. A rubric already judged is left as it is.

import { spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, join, resolve } from "node:path";
import { type AssertionVerdict, type Judgement, outcome } from "./judge.ts";

type Obj = Record<string, unknown>;

const SYSTEM = [
  "你是评测的评判员。你会看到用户对一个助手说的话、助手的回复，以及一条要求。",
  "只按这条要求判断助手的回复是否满足它：满足为 true，不满足为 false。",
  "不评价要求本身，不考虑要求以外的好坏；回复用什么语言都可以。",
  "reason 用一句中文说明依据，引用回复里的关键原话。",
].join("\n");

const SCHEMA = JSON.stringify({
  type: "object",
  properties: { holds: { type: "boolean" }, reason: { type: "string" } },
  required: ["holds", "reason"],
  additionalProperties: false,
});

/** What the judge model is given: the user's words and the replies, step by step, then the rubric. */
export function judgePrompt(r: { rubric: string; user: string[]; replies: string[] }): string {
  const turns = r.user.map((u, i) => `【用户】${u}\n【助手】${r.replies[i] ?? ""}`).join("\n\n");
  return `${turns}\n\n【要求】${r.rubric}\n\n助手的回复（多轮时看最后一轮，前面的轮次作为上下文）是否满足这条要求？`;
}

/** Whether an assertion is one of the share marked for a person to check. */
export function spotChecked(run: string, at: string, share: number): boolean {
  const h = createHash("sha256").update(`${run}\n${at}`).digest();
  return h.readUInt32BE(0) / 2 ** 32 < share;
}

function ask(model: string, prompt: string): { holds: boolean; reason: string } {
  const cwd = mkdtempSync(join(tmpdir(), "judge-"));
  try {
    for (let attempt = 1; ; attempt++) {
      const r = spawnSync(
        "claude",
        [
          "-p",
          prompt,
          "--model",
          model,
          "--system-prompt",
          SYSTEM,
          "--tools",
          "",
          "--strict-mcp-config",
          "--setting-sources",
          "",
          "--no-session-persistence",
          "--output-format",
          "json",
          "--json-schema",
          SCHEMA,
        ],
        { cwd, encoding: "utf8", timeout: 180_000, stdio: ["ignore", "pipe", "pipe"] },
      );
      try {
        const out = JSON.parse(r.stdout) as Obj;
        const s = (out["structured_output"] ?? JSON.parse(String(out["result"]))) as Obj;
        if (typeof s["holds"] === "boolean" && typeof s["reason"] === "string") {
          return { holds: s["holds"], reason: s["reason"] };
        }
      } catch {
        // judged again below, once
      }
      if (attempt === 2) {
        throw new Error(`the judge model gave no verdict: ${(r.stderr || r.stdout).slice(0, 300)}`);
      }
    }
  } finally {
    rmSync(cwd, { recursive: true, force: true });
  }
}

/** The models the run's host reported, from `transcript/steps.json`. */
function hostModels(dir: string): string[] {
  try {
    const s = JSON.parse(readFileSync(join(dir, "transcript", "steps.json"), "utf8")) as Obj;
    return [...new Set(((s["steps"] ?? []) as Obj[]).map((x) => String(x["model"] ?? "")))].filter(
      Boolean,
    );
  } catch {
    return [];
  }
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const args = process.argv.slice(2);
  let model = "";
  let share = 0.2;
  const dirs: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i] as string;
    if (a === "--model") model = args[++i] ?? "";
    else if (a === "--spot") share = Number(args[++i]);
    else dirs.push(a);
  }
  if (model === "" || dirs.length === 0 || !(share >= 0 && share <= 1)) {
    process.stderr.write("usage: rubric.ts --model <judge model> [--spot 0.2] <run directory> …\n");
    process.exit(2);
  }
  let bad = false;
  for (const d of dirs) {
    const dir = resolve(d);
    const file = join(dir, "judgement.json");
    try {
      if (hostModels(dir).some((m) => m === model || m.startsWith(`${model}[`))) {
        throw new Error(`the host used ${model}; the judge model must be another one`);
      }
      const j = JSON.parse(readFileSync(file, "utf8")) as Judgement;
      const assertions: AssertionVerdict[] = j.assertions.map((a) => {
        if (a.verdict !== "rubric" || a.rubric === undefined) return a;
        const v = ask(model, judgePrompt(a.rubric));
        const spot = spotChecked(basename(dir), a.at, share);
        return {
          ...a,
          verdict: v.holds ? "pass" : "fail",
          judge: { model, holds: v.holds, reason: v.reason, spot_check: spot },
        } as AssertionVerdict;
      });
      const next = { ...j, assertions, ...outcome(assertions) };
      writeFileSync(file, `${JSON.stringify(next, null, 2)}\n`);
      const res = next.passed === null ? "open" : next.passed ? "pass" : "fail";
      process.stdout.write(`${dir}: ${res}\n`);
    } catch (e) {
      bad = true;
      process.stderr.write(`${dir}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.exit(bad ? 1 : 0);
}
