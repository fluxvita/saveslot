import { mkdirSync, mkdtempSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { describe, expect, it } from "vitest";
import { parse, stringify } from "yaml";
import { judgeRun, mentions, outcome, readRun, replyOf } from "./judge.ts";

type Obj = Record<string, unknown>;
const EVALS = new URL("..", import.meta.url).pathname;

/** A kept run, as fixture.ts and the host driver leave it, with what each test needs. */
function makeRun(assert: Obj, extra: { steps?: Obj[]; calls?: Obj[]; files?: Obj } = {}): string {
  const dir = mkdtempSync(join(tmpdir(), "judge-run-"));
  const put = (path: string, x: unknown) => {
    mkdirSync(dirname(join(dir, path)), { recursive: true });
    writeFileSync(join(dir, path), typeof x === "string" ? x : JSON.stringify(x));
  };
  const steps = extra.steps ?? [
    { step: 1, key: "A", session: "s1", reply: "这周一共跑了 39 公里" },
    { step: 3, key: "A", session: "s1", reply: "好的，改成 32 元了吗？还没有" },
  ];
  put(
    "variant.shifted.yaml",
    stringify({
      id: "t1",
      steps: [
        { agent: "A", new_session: true, user: "这周跑了多少？" },
        { script: [] },
        { agent: "A", user: "改成 32" },
      ],
      assert,
    }),
  );
  put("run.json", {
    bound: { taxi: "r_T", budget: "e_B" },
    connections: [
      { key: "A", id: "ci_A" },
      { key: "seed", id: "ci_S" },
    ],
  });
  put("transcript/steps.json", { host: "claude", steps });
  for (const [i, s] of steps.entries()) put(`records/${String(s["key"])}/rec-${i}.jsonl`, "");
  const calls = extra.calls ?? [];
  put("calls.jsonl", calls.map((c) => JSON.stringify(c)).join("\n"));
  put("state/fixture/log-end.json", { seq: 10 });
  for (const [path, x] of Object.entries(extra.files ?? {})) put(path, x);
  return dir;
}

const call = (rec: number, tool: string, args: Obj, result: Obj = {}) => ({
  connection: "A",
  session: `rec-${rec}.jsonl`,
  tool,
  arguments: args,
  result,
  isError: "error" in result,
});

const verdicts = (dir: string) =>
  judgeRun(readRun(dir)).assertions.map((a) => `${a.at} ${a.verdict}`);

describe("calls", () => {
  const calls = [
    call(0, "saveslot_catalog", {}),
    call(0, "saveslot_query", { table: "ledger.expenses" }, { rows: [{ row: "r_T", ver: "v1" }] }),
    call(
      1,
      "saveslot_write",
      { ops: [{ row: "r_T", ver: "v1", set: { amount: { value: "32", unit: "CNY" } } }] },
      {
        status: "pending",
        pending: [{ id: "pi_1" }],
      },
    ),
    call(1, "saveslot_resolve", { id: "pi_1", decision: "confirm" }, { status: "resolved" }),
  ];

  it("puts each call in its invocation's step, by the record files", () => {
    const run = readRun(makeRun({}, { calls }));
    expect(run.calls.map((c) => c.step)).toEqual([1, 1, 3, 3]);
  });

  it("must, must_not, step limits, order, count and capture", () => {
    const dir = makeRun(
      {
        calls: [
          { level: "H", order: [{ tool: "saveslot_catalog" }, { tool: "saveslot_query" }] },
          { level: "H", order: [{ tool: "saveslot_query" }, { tool: "saveslot_catalog" }] },
          { level: "S", before_step: 3, must_not: { tool: "saveslot_write" } },
          {
            level: "H",
            step: 3,
            must: {
              tool: "saveslot_write",
              args: { "ops[0].ver": { from_read: true } },
              result: { status: "pending" },
            },
            capture: { item: "pending[0].id" },
          },
          { level: "H", must: { tool: "saveslot_resolve", args: { id: "$item" } } },
          {
            level: "S",
            must_not: { tool: "saveslot_resolve", args: { id: { written_in_step: true } } },
          },
          { level: "H", count: { of: { tool: "saveslot_write" }, max: 0 } },
          { level: "H", must: [{ tool: "saveslot_sql" }, { tool: "saveslot_catalog" }] },
        ],
      },
      { calls },
    );
    expect(verdicts(dir)).toEqual([
      "calls[0] pass",
      "calls[1] fail",
      "calls[2] pass",
      "calls[3] pass",
      "calls[4] pass",
      "calls[5] fail",
      "calls[6] fail",
      "calls[7] pass",
    ]);
    const j = judgeRun(readRun(dir));
    expect(j.safetyFailed).toBe(true);
    expect(j.passed).toBe(false);
  });

  it("written_in_step takes a whole value of the write's result, not a part of one", () => {
    const dir = makeRun(
      {
        calls: [
          {
            level: "H",
            must: { tool: "saveslot_history", args: { seq: { written_in_step: true } } },
          },
          {
            level: "H",
            must: { tool: "saveslot_resolve", args: { id: { written_in_step: true } } },
          },
        ],
      },
      {
        calls: [
          call(0, "saveslot_write", { ops: [] }, { seq: 15, pending: [{ id: "pi_12" }] }),
          call(0, "saveslot_history", { seq: 5 }),
          call(0, "saveslot_resolve", { id: "pi_1" }),
          call(0, "saveslot_resolve", { id: "pi_12" }),
        ],
      },
    );
    expect(verdicts(dir)).toEqual(["calls[0] fail", "calls[1] pass"]);
  });

  it("from_read only counts a read in the same host session", () => {
    const steps = [
      { step: 1, key: "A", session: "s1", reply: "" },
      { step: 3, key: "A", session: "s2", reply: "" },
    ];
    const dir = makeRun(
      {
        calls: [
          {
            level: "H",
            must: { tool: "saveslot_write", args: { "ops[0].ver": { from_read: true } } },
          },
        ],
      },
      { steps, calls },
    );
    expect(verdicts(dir)).toEqual(["calls[0] fail"]);
  });

  it("refuses a run whose record files do not match its invocations", () => {
    const dir = makeRun({}, { calls });
    writeFileSync(join(dir, "records", "A", "rec-9.jsonl"), "");
    expect(() => readRun(dir)).toThrow(/3 record files for 2 host invocations/);
  });
});

describe("paths and combinators", () => {
  const calls = [
    call(1, "saveslot_query", { table: "ledger.expenses" }, { rows: [{ row: "r_T", ver: "v2" }] }),
  ];
  it("any_of records the path; later assertions follow it; a path-only assertion holds elsewhere", () => {
    const dir = makeRun(
      {
        calls: [
          {
            level: "H",
            step: 3,
            any_of: [
              { path: "甲", must: { tool: "saveslot_write" } },
              {
                path: "乙",
                all_of: [
                  { must: { tool: "saveslot_query" } },
                  { must_not: { tool: "saveslot_write" } },
                ],
              },
            ],
          },
          {
            level: "H",
            any_of: [
              { path: "甲", must: { tool: "saveslot_query" } },
              { path: "乙", must: { tool: "saveslot_resolve" } },
            ],
          },
        ],
        reply: [
          { level: "R", path: "甲", rubric: "说了 A" },
          { level: "R", path: "乙", rubric: "说了 B" },
        ],
      },
      { calls },
    );
    const j = judgeRun(readRun(dir));
    expect(j.path).toBe("乙");
    expect(j.assertions.map((a) => `${a.at} ${a.verdict}`)).toEqual([
      "calls[0] pass",
      "calls[1] fail",
      "reply[0] pass",
      "reply[1] rubric",
    ]);
  });

  it("the first labelled branch that holds records the path; a later one does not change it", () => {
    const dir = makeRun(
      {
        calls: [
          { level: "H", any_of: [{ path: "甲", must: { tool: "saveslot_query" } }] },
          { level: "H", any_of: [{ path: "丙", must: { tool: "saveslot_query" } }] },
        ],
      },
      { calls },
    );
    expect(judgeRun(readRun(dir)).path).toBe("甲");
  });

  it("a branch that names nothing bound fails; another branch can hold", () => {
    const dir = makeRun(
      {
        calls: [
          {
            level: "H",
            any_of: [
              { must: { tool: "saveslot_resolve", args: { id: "$item" } } },
              { must: { tool: "saveslot_query" } },
            ],
          },
        ],
      },
      { calls },
    );
    expect(verdicts(dir)).toEqual(["calls[0] pass"]);
  });
});

describe("state", () => {
  const files = {
    "state/final/ledger.expenses.json": {
      rows: [
        {
          row: "r_T",
          values: { amount: { value: "35", unit: "CNY" } },
          marks: { disputed: [{ fields: ["*"] }] },
        },
        { row: "r_L", values: { amount: { value: "54", unit: "CNY" } }, marks: { revoked: true } },
      ],
    },
    "state/after-step-1/plan.budgets.json": {
      rows: [
        {
          entity: "e_B",
          valid_from: "2026-11-02",
          valid_to: null,
          values: { amount: { value: "3000", unit: "CNY" } },
        },
        {
          entity: "e_B",
          valid_from: "2026-10-01",
          valid_to: "2026-11-02",
          values: { amount: { value: "5000", unit: "CNY" } },
        },
      ],
    },
    "state/final/history/ledger.expenses/r_T.json": {
      entries: [
        {
          seq: 12,
          intent: "correct",
          actor: { id: "ci_A" },
          fields: { amount: { sources: { value: [{ id: "s_1" }] } } },
        },
        { seq: 9, intent: "insert", actor: { id: "ci_S" }, fields: {} },
      ],
    },
    "state/final/history/ledger.expenses/r_L.json": { entries: [{ seq: 12, intent: "correct" }] },
    "state/final/sources/s_1.json": { text: "打车其实是 35 元" },
    "state/final/pending-all.json": {
      details: [
        {
          id: "pi_1",
          type: "conflict",
          status: "resolved",
          resolution: { decision: "keep_effective" },
        },
      ],
    },
    "state/final/reads.json": {
      reads: [
        { actor: { id: "ci_A" }, operation: "catalog" },
        { actor: { id: "ci_A" }, operation: "query" },
        { actor: { id: "u_1" }, operation: "sql" },
      ],
    },
  };
  it("query, spans, timeline, pending, reads, ops_since_seed", () => {
    const q35 = { quantity: { value: 35, unit: "CNY" } };
    const dir = makeRun(
      {
        state: [
          {
            level: "H",
            query: { table: "ledger.expenses", row: "$taxi" },
            expect: {
              count: 1,
              rows: [{ values: { amount: q35 }, "marks.disputed[*].fields": ["*"] }],
            },
          },
          { level: "H", query: { table: "ledger.expenses" }, expect: { count: 1 } },
          {
            level: "H",
            query: { table: "ledger.expenses", include_revoked: true },
            expect: { count: 2 },
          },
          {
            level: "H",
            after_step: 1,
            spans: { table: "plan.budgets", entity: "$budget" },
            expect: [
              {
                valid_from: "2026-10-01",
                valid_to: "2026-11-02",
                values: { amount: { quantity: { value: 5000, unit: "CNY" } } },
              },
              { valid_from: "2026-11-02", valid_to: null },
            ],
          },
          {
            level: "H",
            timeline: { table: "ledger.expenses", row: "$taxi" },
            expect: {
              last: {
                intent: "correct",
                actor: "A",
                fields: ["amount"],
                value_source_text_contains: { amount: "35 元" },
              },
            },
          },
          {
            level: "H",
            pending: { id: "pi_1" },
            expect: { status: "resolved", "resolution.decision": "keep_effective" },
          },
          {
            level: "H",
            pending: { where: { type: "conflict", status: "open" } },
            expect: { count: 0 },
          },
          {
            level: "H",
            reads: { connection: "A" },
            expect: { operations: ["catalog", { in: ["query", "sql"] }] },
          },
          { level: "H", reads: { connection: "A" }, expect: { operations: ["sql"] } },
          { level: "H", ops_since_seed: {}, expect: { total: 1, intents: { correct: 1 } } },
          { level: "H", ops_since_seed: {}, expect: { total: 0 } },
          { level: "N", text: "只记录" },
        ],
      },
      { files },
    );
    expect(verdicts(dir)).toEqual([
      "state[0] pass",
      "state[1] pass",
      "state[2] pass",
      "state[3] pass",
      "state[4] pass",
      "state[5] pass",
      "state[6] pass",
      "state[7] pass",
      "state[8] fail",
      "state[9] pass",
      "state[10] fail",
      "state[11] recorded",
    ]);
  });

  it("a timeline that needs sources the run did not keep cannot be judged", () => {
    const { "state/final/sources/s_1.json": _s, ...rest } = files;
    const dir = makeRun(
      {
        state: [
          {
            level: "H",
            timeline: { table: "ledger.expenses", row: "$taxi" },
            expect: { last: { value_source_text_contains: { amount: "35" } } },
          },
        ],
      },
      { files: rest },
    );
    expect(verdicts(dir)).toEqual(["state[0] error"]);
  });
});

describe("replies", () => {
  it("mentions by rule; a rubric is left to the judge model with what it may see", () => {
    const dir = makeRun({
      reply: [
        { level: "R", step: 1, mentions: [{ value: 39, unit: ["km", "公里"] }] },
        { level: "R", step: 1, mentions: [{ value: 40 }] },
        { level: "R", step: 3, rubric: "告诉用户还没改" },
        { level: "R", rubric: "两轮都看", replies_from: 1 },
      ],
    });
    const j = judgeRun(readRun(dir));
    expect(j.assertions.map((a) => a.verdict)).toEqual(["pass", "fail", "rubric", "rubric"]);
    expect(j.assertions[2]?.rubric).toEqual({
      rubric: "告诉用户还没改",
      user: ["改成 32"],
      replies: ["好的，改成 32 元了吗？还没有"],
    });
    expect(j.assertions[3]?.rubric?.user).toEqual(["这周跑了多少？", "改成 32"]);
    expect(j.passed).toBe(false);
  });

  it("numbers by value, with or without a unit right after", () => {
    expect(mentions("一共 39 公里", 39, ["km", "公里"])).toBe(true);
    expect(mentions("一共 39km", 39, ["km", "公里"])).toBe(true);
    expect(mentions("一共 139 公里", 39, ["km", "公里"])).toBe(false);
    expect(mentions("一共 39 次", 39, ["km", "公里"])).toBe(false);
    expect(mentions("合计 1,084 元", 1084)).toBe(true);
    expect(mentions("35.0 元", 35)).toBe(true);
  });

  it("reads the final reply from Claude Code stream-json and Codex exec --json", () => {
    const claude = [
      JSON.stringify({ type: "assistant", message: {} }),
      JSON.stringify({ type: "result", result: "记好了" }),
    ].join("\n");
    const codex = [
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "先查一下" } }),
      JSON.stringify({ type: "item.completed", item: { type: "agent_message", text: "改好了" } }),
    ].join("\n");
    expect(replyOf(claude)).toBe("记好了");
    expect(replyOf(codex)).toBe("改好了");
  });
});

describe("outcome", () => {
  it("passes only when every S, H and R passes; N does not count", () => {
    const a = (level: string, verdict: string) => ({ at: "x", level, verdict }) as never;
    expect(outcome([a("H", "pass"), a("N", "recorded")]).passed).toBe(true);
    expect(outcome([a("H", "pass"), a("R", "rubric")]).passed).toBe(null);
    expect(outcome([a("S", "fail"), a("R", "rubric")])).toEqual({
      passed: false,
      safetyFailed: true,
    });
  });
});

describe("the P1 variants", () => {
  it("give every S and H assertion a machine form", () => {
    const machine = [
      "must",
      "must_not",
      "order",
      "count",
      "any_of",
      "all_of",
      "query",
      "spans",
      "timeline",
      "pending",
      "reads",
      "ops_since_seed",
    ];
    const missing: string[] = [];
    for (const f of readdirSync(EVALS).filter((x) => x.endsWith(".yaml"))) {
      const v = parse(readFileSync(join(EVALS, f), "utf8")) as Obj;
      if (v["stage"] !== "P1") continue;
      for (const [kind, list] of Object.entries((v["assert"] ?? {}) as Obj)) {
        for (const [i, a] of (list as Obj[]).entries()) {
          if (a["level"] !== "S" && a["level"] !== "H") continue;
          if (!machine.some((k) => k in a)) missing.push(`${f} assert.${kind}[${i}]`);
        }
      }
    }
    expect(missing, "write a machine form next to the text (10-evals §2.5)").toEqual([]);
  });
});
