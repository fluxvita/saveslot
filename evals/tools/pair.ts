// A run's tool calls, each with its contract result (docs/zh-CN/spec/10-evals.md §2.4, §16): the
// call record (`saveslot mcp --record`, what the agent sent and the text it got back) paired with
// the service's evaluation results (`run/eval-results.jsonl`, the contract result of each call).
// A tool result over MCP is text only (05-surfaces §3), so the result an assertion matches comes
// from the service's side, never from parsing the text.
//
// Per connection instance, in order: its sessions' record files by name (start time), and in each
// the `tools/call` requests as they were read. A call the service answered with a tool result
// takes the next entry of that connection's evaluation results; their tool and arguments must be
// the same. A call refused before it reached a tool (a JSON-RPC error: no scope, unknown tool) has
// no entry there. A call made while another was in flight (the bridge forwards up to 8 at once)
// may end in another order: it is paired by tool and arguments, and said so to be checked; a
// batch is not paired. Writes `calls.jsonl` in the run directory and says what to check.
//
//   node --conditions=source evals/tools/pair.ts <run directory>

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";

type Obj = Record<string, unknown>;

const lines = (file: string): Obj[] =>
  readFileSync(file, "utf8")
    .split("\n")
    .filter((l) => l.trim() !== "")
    .map((l) => JSON.parse(l) as Obj);

/** `x` as JSON with every object's keys sorted: two values the same whatever their key order. */
const canonical = (x: unknown): string =>
  JSON.stringify(x, (_, v) =>
    v !== null && typeof v === "object" && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Obj).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );

export interface Paired {
  readonly paired: number;
  readonly problems: readonly string[];
}

/** Pairs the run in `dir`; writes `calls.jsonl`. */
export function pairCalls(dir: string): Paired {
  const run = JSON.parse(readFileSync(join(dir, "run.json"), "utf8")) as {
    connections: { key: string; id: string }[];
  };
  const resultsFile = join(dir, "home", "run", "eval-results.jsonl");
  const results = existsSync(resultsFile) ? lines(resultsFile) : [];
  const queue = new Map<string, Obj[]>();
  for (const r of results) {
    const id = String(r["connection"]);
    queue.set(id, [...(queue.get(id) ?? []), r]);
  }
  const out: Obj[] = [];
  const problems: string[] = [];
  for (const c of run.connections) {
    const records = join(dir, "records", c.key);
    if (!existsSync(records)) continue;
    const pending = queue.get(c.id) ?? [];
    for (const file of readdirSync(records).sort()) {
      const record = lines(join(records, file));
      const answers = new Map<string, Obj>();
      for (const l of record) {
        const m = l["msg"] as Obj | undefined;
        if (l["dir"] === "out" && m !== undefined && Object.hasOwn(m, "id")) {
          answers.set(JSON.stringify(m["id"]), m);
        }
      }
      // Calls in flight together (the bridge forwards up to 8 at once) may end in another order
      // than they came: such a call is paired by its tool and arguments, and said so.
      let open = 0;
      const ended = new Set<string>();
      for (const l of record) {
        const m = l["msg"] as Obj | undefined;
        if (l["dir"] === "out" && m !== undefined && Object.hasOwn(m, "id")) {
          if (!ended.has(JSON.stringify(m["id"]))) open = Math.max(0, open - 1);
          ended.add(JSON.stringify(m["id"]));
        }
        if (l["dir"] === "in" && Array.isArray(m)) {
          // A batch: its calls are not paired here.
          problems.push(`${c.key} ${file}: a batch of ${m.length} messages, not paired`);
          continue;
        }
        if (l["dir"] !== "in" || m === undefined || m["method"] !== "tools/call") continue;
        const concurrent = open > 0;
        open++;
        const params = (m["params"] ?? {}) as Obj;
        const tool = String(params["name"]);
        const args = (params["arguments"] ?? {}) as Obj;
        const answer = answers.get(JSON.stringify(m["id"]));
        const where = `${c.key} ${file} id ${JSON.stringify(m["id"])} ${tool}`;
        if (answer === undefined) {
          problems.push(`${where}: no answer in the record`);
          continue;
        }
        const toolResult = answer["result"] as Obj | undefined;
        if (toolResult === undefined) {
          // Refused before any tool: nothing of it in the evaluation results.
          out.push({
            connection: c.key,
            session: file,
            id: m["id"],
            tool,
            arguments: args,
            error: answer["error"],
          });
          continue;
        }
        // The first of this connection's results left with the same tool and arguments.
        const k = pending.findIndex(
          (x) => x["tool"] === tool && canonical(x["arguments"]) === canonical(args),
        );
        if (k < 0) {
          problems.push(`${where}: no evaluation result left with this tool and these arguments`);
          continue;
        }
        if (k > 0 || concurrent) {
          problems.push(
            `${where}: paired by tool and arguments${concurrent ? ", made while another call was in flight" : ""}; check the pairing`,
          );
        }
        const [seen] = pending.splice(k, 1) as [Obj];
        const text = ((toolResult["content"] as { text?: string }[] | undefined) ?? [])[0]?.text;
        out.push({
          connection: c.key,
          session: file,
          id: m["id"],
          tool,
          arguments: args,
          isError: toolResult["isError"] === true,
          text,
          result: seen["result"],
          at: seen["t"],
        });
      }
    }
    for (const left of pending) {
      problems.push(
        `${c.key}: an evaluation result of ${String(left["tool"])} with no call in the record`,
      );
    }
  }
  writeFileSync(join(dir, "calls.jsonl"), out.map((x) => `${JSON.stringify(x)}\n`).join(""));
  return { paired: out.length, problems };
}

if (import.meta.url === `file://${process.argv[1]}`) {
  const dir = process.argv[2];
  if (dir === undefined) {
    process.stderr.write("usage: pair.ts <run directory>\n");
    process.exit(2);
  }
  const r = pairCalls(resolve(dir));
  process.stdout.write(`${r.paired} calls in ${join(resolve(dir), "calls.jsonl")}\n`);
  for (const p of r.problems) process.stdout.write(`pairing: ${p}\n`);
  process.exit(r.problems.length > 0 ? 1 : 0);
}
