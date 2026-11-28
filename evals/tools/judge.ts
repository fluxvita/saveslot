// Judges one evaluation run against its variant's assertions (docs/zh-CN/spec/10-evals.md §2.4,
// §2.5), from what the run directory kept: no service, no host, no model.
//
//   node --conditions=source evals/tools/judge.ts <run directory> [<run directory> …]
//
// Writes <run>/judgement.json and prints one line per run. Each assertion gets a verdict:
//   pass / fail       its machine form was judged (S and H; `mentions` of R, by rule)
//   rubric            an R `rubric`: left to the judge model (./rubric.ts), with what it may see
//   unjudged          it has only `text`, so a person judges it
//   error             its machine form could not be judged (says why)
//   recorded          an N assertion: not judged (§2.4), its machine form's outcome kept as a note
// A run passes when every S, H and R assertion passes; while one is rubric, unjudged or error,
// the run's outcome is open.
//
// What the run directory must hold, besides what evals/tools/fixture.ts writes there:
//   transcript/steps.json   10-evals «留档»: `host`, and in `steps` the host's invocations in order
//                           (the agent steps and any follow-up in the same step), each
//                           `{step, key, session, model?, reply?, file?}`, with `session` the
//                           host's session (a new one per `new_session`) and `reply` the
//                           invocation's final reply; without `reply`, the reply is read from the
//                           host's raw output `transcript/<file>` (Claude Code stream-json, or
//                           Codex `exec --json`).
// A call is in the step of the invocation that made it: each invocation starts the MCP bridge
// anew, so a connection's record files, by name, are its invocations in order.

import { existsSync, readdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { parse } from "yaml";
import { type Context, matchAll, matchValue, type Obj, resolvePath } from "./match.ts";

const isObj = (x: unknown): x is Obj => typeof x === "object" && x !== null && !Array.isArray(x);
const json = (file: string): Obj => JSON.parse(readFileSync(file, "utf8")) as Obj;

// --- the run, as kept ----------------------------------------------------------------------------

/** One agent call as `calls.jsonl` has it, with the step and host session it was made in. */
export interface AgentCall {
  readonly index: number;
  readonly connection: string;
  readonly tool: string;
  readonly arguments: Obj;
  readonly result: unknown;
  readonly isError: boolean;
  readonly step: number;
  readonly session: string;
}

export interface Invocation {
  readonly step: number;
  readonly key: string;
  readonly session: string;
  readonly reply: string;
}

/** What a run kept, read once. Snapshots are read on demand by `snapshot`. */
export interface Run {
  readonly dir: string;
  readonly variant: Obj;
  readonly bound: Obj;
  /** Connection key → connection instance ID. */
  readonly connections: Record<string, string>;
  readonly calls: readonly AgentCall[];
  readonly invocations: readonly Invocation[];
  readonly snapshot: (when: string, name: string) => Obj | undefined;
}

/** The final reply in a host's raw output: Claude Code stream-json, or Codex `exec --json`. */
export function replyOf(raw: string): string {
  let reply = "";
  for (const line of raw.split("\n")) {
    if (line.trim() === "") continue;
    let e: Obj;
    try {
      e = JSON.parse(line) as Obj;
    } catch {
      continue;
    }
    if (e["type"] === "result" && typeof e["result"] === "string") reply = e["result"];
    const item = e["item"];
    if (
      e["type"] === "item.completed" &&
      isObj(item) &&
      item["type"] === "agent_message" &&
      typeof item["text"] === "string"
    ) {
      reply = item["text"];
    }
  }
  return reply;
}

export function readRun(dir: string): Run {
  const variant = parse(readFileSync(join(dir, "variant.shifted.yaml"), "utf8")) as Obj;
  const run = json(join(dir, "run.json"));
  const connections: Record<string, string> = {};
  for (const c of (run["connections"] ?? []) as Obj[]) {
    connections[String(c["key"])] = String(c["id"]);
  }
  const steps = (json(join(dir, "transcript", "steps.json"))["steps"] ?? []) as Obj[];
  const invocations: Invocation[] = steps.map((s) => ({
    step: Number(s["step"]),
    key: String(s["key"]),
    session: String(s["session"] ?? ""),
    reply:
      typeof s["reply"] === "string"
        ? s["reply"]
        : typeof s["file"] === "string" && existsSync(join(dir, "transcript", s["file"]))
          ? replyOf(readFileSync(join(dir, "transcript", s["file"]), "utf8"))
          : "",
  }));
  // A connection's record files by name are its invocations in order.
  const fileOf = new Map<string, Invocation>();
  for (const key of new Set(invocations.map((i) => i.key))) {
    const mine = invocations.filter((i) => i.key === key);
    const recDir = join(dir, "records", key);
    const files = existsSync(recDir) ? readdirSync(recDir).sort() : [];
    if (files.length !== mine.length) {
      throw new Error(
        `${key}: ${files.length} record files for ${mine.length} host invocations; the calls cannot be put in their steps`,
      );
    }
    for (const [i, f] of files.entries()) fileOf.set(`${key}/${f}`, mine[i] as Invocation);
  }
  const lines = existsSync(join(dir, "calls.jsonl"))
    ? readFileSync(join(dir, "calls.jsonl"), "utf8")
        .split("\n")
        .filter((l) => l.trim() !== "")
    : [];
  const calls = lines.map((l, index): AgentCall => {
    const c = JSON.parse(l) as Obj;
    const inv = fileOf.get(`${String(c["connection"])}/${String(c["session"])}`);
    if (inv === undefined) {
      throw new Error(`call ${index + 1}: record ${String(c["session"])} is no host invocation`);
    }
    return {
      index,
      connection: String(c["connection"]),
      tool: String(c["tool"]),
      arguments: (c["arguments"] ?? {}) as Obj,
      result: c["result"],
      isError: c["isError"] === true,
      step: inv.step,
      session: inv.session,
    };
  });
  return {
    dir,
    variant,
    bound: (run["bound"] ?? {}) as Obj,
    connections,
    calls,
    invocations,
    snapshot: (when, name) => {
      const f = join(dir, "state", when, `${name}.json`);
      return existsSync(f) ? json(f) : undefined;
    },
  };
}

// --- verdicts ------------------------------------------------------------------------------------

export type Verdict = "pass" | "fail" | "rubric" | "unjudged" | "error" | "recorded";

export interface AssertionVerdict {
  readonly at: string;
  readonly level: string;
  readonly verdict: Verdict;
  readonly note?: string;
  /** For a rubric: what the judge model sees (10-evals §2.4). */
  readonly rubric?: {
    readonly rubric: string;
    readonly user: string[];
    readonly replies: string[];
  };
  /** For a rubric the judge model judged (./rubric.ts). */
  readonly judge?: {
    readonly model: string;
    readonly holds: boolean;
    readonly reason: string;
    readonly spot_check: boolean;
  };
}

export interface Judgement {
  readonly variant: string;
  readonly dir: string;
  /** The path the run took, where its variant labels the acceptable paths. */
  readonly path?: string;
  readonly assertions: readonly AssertionVerdict[];
  /** true / false once every S, H and R assertion is pass or fail; null while one is open. */
  readonly passed: boolean | null;
  /** Whether an S assertion failed: the variant fails whatever the other runs do. */
  readonly safetyFailed: boolean;
}

/** The outcome of a run from its assertions' verdicts. */
export function outcome(as: readonly AssertionVerdict[]): {
  passed: boolean | null;
  safetyFailed: boolean;
} {
  const counted = as.filter((a) => a.level !== "N");
  const safetyFailed = counted.some((a) => a.level === "S" && a.verdict === "fail");
  if (counted.some((a) => a.verdict === "fail")) return { passed: false, safetyFailed };
  if (counted.every((a) => a.verdict === "pass")) return { passed: true, safetyFailed };
  return { passed: null, safetyFailed };
}

// --- calls ---------------------------------------------------------------------------------------

/** The targets a read's result returned, with the version token for each. */
function readTargets(c: AgentCall): Map<string, string> {
  const out = new Map<string, string>();
  if (c.isError || !isObj(c.result)) return out;
  const r = c.result;
  if (c.tool === "saveslot_query") {
    for (const row of (r["rows"] ?? []) as Obj[]) {
      const id = row["row"] ?? row["entity"];
      if (typeof id === "string" && typeof row["ver"] === "string") out.set(id, row["ver"]);
    }
  } else if (c.tool === "saveslot_history") {
    const t = r["target"];
    const id = isObj(t) ? (t["row"] ?? t["entity"]) : undefined;
    if (typeof id === "string" && typeof r["ver"] === "string") out.set(id, r["ver"]);
  }
  return out;
}

/** The ver the latest read before `call`, in its host session, returned for `holder`'s target. */
function latestRead(run: Run, call: AgentCall, holder: unknown): string | undefined {
  if (!isObj(holder)) return undefined;
  const id = holder["row"] ?? holder["entity"];
  if (typeof id !== "string") return undefined;
  let ver: string | undefined;
  for (const c of run.calls) {
    if (c.index >= call.index) break;
    if (c.session !== call.session || c.connection !== call.connection) continue;
    const v = readTargets(c).get(id);
    if (v !== undefined) ver = v;
  }
  return ver;
}

function inSteps(a: Obj, c: AgentCall): boolean {
  const after = a["after_step"];
  const before = a["before_step"];
  // `step: n`: only the calls made in step n.
  if (typeof a["step"] === "number" && c.step !== a["step"]) return false;
  if (typeof after === "number" && c.step <= after) return false;
  if (typeof before === "number" && c.step >= before) return false;
  return true;
}

/** Every scalar anywhere in `x`. */
function scalars(x: unknown, out: unknown[] = []): unknown[] {
  if (Array.isArray(x)) for (const v of x) scalars(v, out);
  else if (isObj(x)) for (const v of Object.values(x)) scalars(v, out);
  else out.push(x);
  return out;
}

/**
 * Whether `value` is a whole value (an item ID, a write sequence) in the result of an earlier
 * `saveslot_write` in `call`'s step and session.
 */
function writtenInStep(run: Run, call: AgentCall, value: unknown): boolean {
  if (isObj(value) || Array.isArray(value)) return false;
  return run.calls.some(
    (c) =>
      c.index < call.index &&
      c.step === call.step &&
      c.session === call.session &&
      c.tool === "saveslot_write" &&
      scalars(c.result).includes(value),
  );
}

/** Whether `c` matches a pattern (`tool`, `args`, `result`), or one of a list of patterns. */
function callMatches(run: Run, c: AgentCall, pattern: unknown, bound: Obj): boolean {
  if (Array.isArray(pattern)) return pattern.some((p) => callMatches(run, c, p, bound));
  if (!isObj(pattern)) throw new Error("a call pattern is an object or a list of them");
  const base = { bound: (n: string) => bound[n] };
  if (pattern["tool"] !== undefined && !matchValue(c.tool, pattern["tool"], base)) return false;
  const args = pattern["args"];
  if (isObj(args)) {
    const ctx: Context = {
      ...base,
      latestRead: (h) => latestRead(run, c, h),
      writtenInStep: (v) => writtenInStep(run, c, v),
    };
    if (!matchAll(c.arguments, args, ctx)) return false;
  }
  const result = pattern["result"];
  if (isObj(result) && !matchAll(c.result, result, base)) return false;
  return true;
}

const at = (c: AgentCall) => `call ${c.index + 1} (step ${c.step})`;

type Outcome = { verdict: Verdict; note?: string };

function judgeCall(run: Run, a: Obj, bound: Obj): Outcome {
  const calls = run.calls.filter((c) => inSteps(a, c));
  if (a["must"] !== undefined) {
    const hit = calls.find((c) => callMatches(run, c, a["must"], bound));
    if (hit === undefined) return { verdict: "fail", note: "no call matches" };
    for (const [name, path] of Object.entries((a["capture"] ?? {}) as Obj)) {
      const value = resolvePath(hit.result, String(path))[0]?.value;
      if (typeof value === "symbol" || value === undefined) {
        return {
          verdict: "error",
          note: `capture ${name}: nothing at ${String(path)} in ${at(hit)}`,
        };
      }
      bound[name] = value;
    }
    return { verdict: "pass", note: at(hit) };
  }
  if (a["must_not"] !== undefined) {
    const hit = calls.find((c) => callMatches(run, c, a["must_not"], bound));
    return hit === undefined
      ? { verdict: "pass" }
      : { verdict: "fail", note: `${at(hit)} matches` };
  }
  // `order: [p, q]`: a call matches p, and the first one comes before every call matching q.
  if (Array.isArray(a["order"])) {
    const [p, q] = a["order"] as unknown[];
    const first = calls.find((c) => callMatches(run, c, p, bound));
    if (first === undefined) return { verdict: "fail", note: "no call matches the first pattern" };
    const second = calls.find((c) => callMatches(run, c, q, bound));
    if (second !== undefined && second.index < first.index) {
      return { verdict: "fail", note: `${at(second)} comes before ${at(first)}` };
    }
    return { verdict: "pass", note: at(first) };
  }
  // `count: {of: pattern, min, max}`: how many calls match.
  if (isObj(a["count"])) {
    const n = a["count"] as Obj;
    const k = calls.filter((c) => callMatches(run, c, n["of"], bound)).length;
    const okMin = typeof n["min"] !== "number" || k >= n["min"];
    const okMax = typeof n["max"] !== "number" || k <= n["max"];
    return { verdict: okMin && okMax ? "pass" : "fail", note: `${k} calls match` };
  }
  return { verdict: "unjudged" };
}

// --- state ---------------------------------------------------------------------------------------

const when = (a: Obj) =>
  typeof a["after_step"] === "number" ? `after-step-${a["after_step"]}` : "final";

const isRevoked = (row: Obj) => isObj(row["marks"]) && Boolean(row["marks"]["revoked"]);
const idOf = (row: Obj) => row["row"] ?? row["entity"];

/** Each expected element matched by a different actual one, in any order. */
function matchSet(actual: unknown[], expected: unknown[], ctx: Context): boolean {
  const used = new Set<number>();
  const go = (i: number): boolean => {
    if (i === expected.length) return true;
    for (const [j, x] of actual.entries()) {
      if (used.has(j) || !matchValue(x, expected[i], ctx)) continue;
      used.add(j);
      if (go(i + 1)) return true;
      used.delete(j);
    }
    return false;
  };
  return go(0);
}

function tableRows(run: Run, a: Obj, table: string): Obj[] {
  const snap = run.snapshot(when(a), table);
  if (snap === undefined) throw new Error(`no snapshot of ${table} in state/${when(a)}`);
  return (snap["rows"] ?? []) as Obj[];
}

/** A history kept at the end, for a row or entity ID. */
function historyOf(run: Run, table: string, id: string): Obj {
  const f = join(run.dir, "state", "final", "history", table, `${id}.json`);
  if (!existsSync(f)) throw new Error(`no history of ${table} ${id}`);
  return json(f);
}

function sourceText(run: Run, id: string): string {
  const dir = join(run.dir, "state", "final", "sources");
  if (!existsSync(dir)) throw new Error("the run kept no sources (state/final/sources)");
  const f = join(dir, `${id}.json`);
  if (!existsSync(f)) return "";
  const s = json(f);
  return typeof s["text"] === "string" ? s["text"] : "";
}

/** The rows of a state table's entity, as spans in time order. */
function spansOf(run: Run, a: Obj, spec: Obj, ctx: Context): Obj[] {
  const rows = tableRows(run, a, String(spec["table"])).filter((r) => !isRevoked(r));
  const mine = rows.filter((r) =>
    spec["entity"] !== undefined
      ? matchValue(r["entity"], spec["entity"], ctx)
      : matchAll(r["entity_key"], (spec["entity_key"] ?? {}) as Obj, ctx),
  );
  return mine.sort((x, y) => String(x["valid_from"]).localeCompare(String(y["valid_from"])));
}

/** The last write ops after the seed, from the histories: distinct sequence numbers. */
function opsSinceSeed(run: Run): Obj[] {
  const end = run.snapshot("fixture", "log-end");
  const seedEnd = Number(end?.["seq"] ?? Number.NaN);
  if (Number.isNaN(seedEnd)) throw new Error("no state/fixture/log-end.json");
  const dir = join(run.dir, "state", "final", "history");
  const seen = new Map<number, Obj>();
  if (existsSync(dir)) {
    for (const t of readdirSync(dir)) {
      for (const f of readdirSync(join(dir, t))) {
        for (const e of (json(join(dir, t, f))["entries"] ?? []) as Obj[]) {
          const seq = Number(e["seq"]);
          if (seq > seedEnd && !seen.has(seq)) seen.set(seq, e);
        }
      }
    }
  }
  return [...seen.values()];
}

function judgeState(run: Run, a: Obj, bound: Obj): Outcome {
  const ctx: Context = { bound: (n) => bound[n] };
  const expect = (a["expect"] ?? {}) as Obj;
  const ok = (b: boolean, note?: string) => ({
    verdict: (b ? "pass" : "fail") as Verdict,
    ...(note !== undefined ? { note } : {}),
  });
  if (isObj(a["query"])) {
    const q = a["query"] as Obj;
    let rows = tableRows(run, a, String(q["table"]));
    if (q["include_revoked"] !== true) rows = rows.filter((r) => !isRevoked(r));
    if (q["row"] !== undefined) rows = rows.filter((r) => matchValue(idOf(r), q["row"], ctx));
    if (q["entity"] !== undefined)
      rows = rows.filter((r) => matchValue(r["entity"], q["entity"], ctx));
    if (isObj(q["where"])) rows = rows.filter((r) => matchAll(r["values"], q["where"] as Obj, ctx));
    if (typeof expect["count"] === "number" && rows.length !== expect["count"]) {
      return ok(false, `${rows.length} rows, ${expect["count"]} expected`);
    }
    if (Array.isArray(expect["rows"]) && !matchSet(rows, expect["rows"], ctx)) {
      return ok(false, `rows: ${JSON.stringify(rows.map((r) => r["values"]))}`);
    }
    return ok(true);
  }
  if (isObj(a["spans"])) {
    const spans = spansOf(run, a, a["spans"] as Obj, ctx);
    const want = Array.isArray(a["expect"]) ? (a["expect"] as unknown[]) : [];
    const shown = spans.map((s) => [s["valid_from"], s["valid_to"], s["values"]]);
    return ok(matchValue(spans, want, ctx), `spans: ${JSON.stringify(shown)}`);
  }
  if (isObj(a["timeline"])) {
    const t = a["timeline"] as Obj;
    const target = t["row"] ?? t["entity"];
    const id =
      typeof target === "string" && target.startsWith("$") ? bound[target.slice(1)] : target;
    if (typeof id !== "string")
      return { verdict: "error", note: `timeline: no target ${String(target)}` };
    const entries = (historyOf(run, String(t["table"]), id)["entries"] ?? []) as Obj[];
    const last = expect["last"];
    if (isObj(last)) {
      const e = entries[0];
      if (e === undefined) return ok(false, "no entries");
      const { actor, fields, value_source_text_contains: texts, ...rest } = last;
      if (!matchAll(e, rest, ctx)) return ok(false, `last: ${JSON.stringify(e).slice(0, 300)}`);
      if (
        actor !== undefined &&
        (e["actor"] as Obj | undefined)?.["id"] !== run.connections[String(actor)]
      ) {
        return ok(false, `last by ${JSON.stringify(e["actor"])}`);
      }
      const ef = isObj(e["fields"]) ? Object.keys(e["fields"]).sort() : [];
      if (
        Array.isArray(fields) &&
        JSON.stringify(ef) !== JSON.stringify([...fields].map(String).sort())
      ) {
        return ok(false, `last changed ${JSON.stringify(ef)}`);
      }
      for (const [field, text] of Object.entries((texts ?? {}) as Obj)) {
        const f = (e["fields"] as Obj | undefined)?.[field];
        const ids = isObj(f) && isObj(f["sources"]) ? ((f["sources"]["value"] ?? []) as Obj[]) : [];
        if (!ids.some((s) => sourceText(run, String(s["id"])).includes(String(text)))) {
          return ok(false, `no value source of ${field} contains ${String(text)}`);
        }
      }
    }
    if (typeof expect["count"] === "number" && entries.length !== expect["count"]) {
      return ok(false, `${entries.length} entries`);
    }
    return ok(true);
  }
  if (isObj(a["pending"])) {
    const p = a["pending"] as Obj;
    const items =
      when(a) === "final"
        ? ((run.snapshot("final", "pending-all")?.["details"] ?? []) as Obj[])
        : ((run.snapshot(when(a), "pending")?.["items"] ?? []) as Obj[]);
    let mine = items;
    if (p["id"] !== undefined) mine = mine.filter((i) => matchValue(i["id"], p["id"], ctx));
    if (isObj(p["where"])) mine = mine.filter((i) => matchAll(i, p["where"] as Obj, ctx));
    if (typeof expect["count"] === "number") {
      return ok(mine.length === expect["count"], `${mine.length} items`);
    }
    const { count: _c, ...fields } = expect;
    return ok(
      mine.length > 0 && mine.every((i) => matchAll(i, fields, ctx)),
      `items: ${JSON.stringify(mine.map((i) => [i["id"], i["status"], i["resolution"] ?? i["superseded"]]))}`,
    );
  }
  if (isObj(a["reads"])) {
    const r = a["reads"] as Obj;
    const id = run.connections[String(r["connection"])];
    const reads = ((run.snapshot(when(a), "reads")?.["reads"] ?? []) as Obj[]).filter(
      (x) => (x["actor"] as Obj | undefined)?.["id"] === id,
    );
    const ops = reads.map((x) => x["operation"]);
    const want = (expect["operations"] ?? []) as unknown[];
    return ok(
      want.every((w) => ops.some((o) => matchValue(o, w, ctx))),
      `operations: ${JSON.stringify([...new Set(ops)])}`,
    );
  }
  if (isObj(a["ops_since_seed"]) || a["ops_since_seed"] === true) {
    const ops = opsSinceSeed(run);
    const intents: Record<string, number> = {};
    for (const o of ops) intents[String(o["intent"])] = (intents[String(o["intent"])] ?? 0) + 1;
    const note = `${ops.length} ops: ${JSON.stringify(intents)}`;
    if (typeof expect["total"] === "number" && ops.length !== expect["total"])
      return ok(false, note);
    if (isObj(expect["intents"]) && !matchValue(intents, expect["intents"], ctx))
      return ok(false, note);
    return ok(true, note);
  }
  if (a["verify"] !== undefined || a["sources"] !== undefined) {
    return { verdict: "error", note: "this state kind is not judged from a kept run yet" };
  }
  return { verdict: "unjudged" };
}

// --- replies -------------------------------------------------------------------------------------

/** The step's final reply: its last invocation's (a follow-up's, if there was one). */
function replyAt(run: Run, step: number): string {
  const mine = run.invocations.filter((i) => i.step === step);
  return mine[mine.length - 1]?.reply ?? "";
}

const lastAgentStep = (run: Run) => Math.max(0, ...run.invocations.map((i) => i.step));

const escapeRe = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

/** Whether `text` gives the number `value` (by value, not by how it is written), with a unit. */
export function mentions(text: string, value: number, units?: string[]): boolean {
  const flat = text.replace(/(\d),(?=\d{3}\b)/g, "$1");
  const unit = units?.length ? `\\s*(?:${units.map(escapeRe).join("|")})` : "";
  const re = new RegExp(`(?<![\\d.])(-?\\d+(?:\\.\\d+)?)${unit}`, "g");
  for (const m of flat.matchAll(re)) if (Number(m[1]) === value) return true;
  return false;
}

function judgeReply(run: Run, a: Obj): Omit<AssertionVerdict, "at" | "level"> {
  const step = typeof a["step"] === "number" ? a["step"] : lastAgentStep(run);
  const reply = replyAt(run, step);
  if (Array.isArray(a["mentions"])) {
    const missing = (a["mentions"] as Obj[]).filter(
      (m) => !mentions(reply, Number(m["value"]), (m["unit"] as string[] | undefined) ?? undefined),
    );
    return missing.length === 0
      ? { verdict: "pass" }
      : { verdict: "fail", note: `step ${step} reply lacks ${JSON.stringify(missing)}` };
  }
  if (typeof a["rubric"] === "string") {
    // The judge model sees the user's words, the reply and the rubric (§2.4); a variant may let it
    // see the replies since an earlier step (`replies_from`).
    const from = typeof a["replies_from"] === "number" ? a["replies_from"] : step;
    const steps = (run.variant["steps"] ?? []) as Obj[];
    const user: string[] = [];
    const replies: string[] = [];
    for (let n = from; n <= step; n++) {
      const s = steps[n - 1];
      if (s === undefined || typeof s["user"] !== "string") continue;
      user.push(s["user"]);
      replies.push(replyAt(run, n));
    }
    return { verdict: "rubric", rubric: { rubric: a["rubric"], user, replies } };
  }
  return { verdict: "unjudged" };
}

// --- one run -------------------------------------------------------------------------------------

/** The paths a run took, by label (`path` on a branch of `any_of`), as it is judged. */
interface Judging {
  readonly run: Run;
  bound: Obj;
  path?: string;
}

/**
 * One assertion of a kind, with the combinators of §2.5: `any_of` (in order, one branch holds; the
 * first labelled branch that holds, `path: <label>`, records the path the run took, and once a path
 * is recorded only its branch is judged where there is one), `all_of` (every branch holds), and
 * `path` on an assertion (it applies only to a run that took that path; on another it holds; with
 * no path recorded yet it is an error). A branch is an assertion of the same kind without a level,
 * and inherits the step limits; what a failing branch captured is dropped.
 */
function judgeOne(
  j: Judging,
  kind: string,
  a: Obj,
  base: (a: Obj, bound: Obj) => Omit<AssertionVerdict, "at" | "level">,
): Omit<AssertionVerdict, "at" | "level"> {
  if (typeof a["path"] === "string" && !Array.isArray(a["any_of"])) {
    if (j.path === undefined) {
      return {
        verdict: "error",
        note: `applies on path ${a["path"]}, and no path is recorded yet`,
      };
    }
    if (j.path !== a["path"]) return { verdict: "pass", note: `not on path ${a["path"]}` };
  }
  if (Array.isArray(a["any_of"])) {
    let branches = a["any_of"] as Obj[];
    if (j.path !== undefined && branches.some((b) => b["path"] === j.path)) {
      branches = branches.filter((b) => b["path"] === j.path);
    }
    const notes: string[] = [];
    for (const b of branches) {
      const bound = { ...j.bound };
      let r: Omit<AssertionVerdict, "at" | "level">;
      const { path: _label, ...body } = b;
      try {
        r = judgeOne({ ...j, bound }, kind, { ...pick(a), ...body }, base);
      } catch (e) {
        r = { verdict: "fail", note: e instanceof Error ? e.message : String(e) };
      }
      const label = typeof b["path"] === "string" ? b["path"] : undefined;
      if (r.verdict === "pass") {
        j.bound = bound;
        if (label !== undefined && j.path === undefined) j.path = label;
        return {
          verdict: "pass",
          note: [label && `path ${label}`, r.note].filter(Boolean).join(": "),
        };
      }
      notes.push(`${label ?? "branch"}: ${r.verdict}${r.note ? ` (${r.note})` : ""}`);
    }
    return { verdict: "fail", note: notes.join("; ") };
  }
  if (Array.isArray(a["all_of"])) {
    const notes: string[] = [];
    for (const b of a["all_of"] as Obj[]) {
      const r = judgeOne(j, kind, { ...pick(a), ...b }, base);
      if (r.verdict !== "pass")
        return { ...r, note: [r.note, ...notes].filter(Boolean).join("; ") };
      if (r.note) notes.push(r.note);
    }
    return { verdict: "pass", note: notes.join("; ") };
  }
  return base(a, j.bound);
}

/** What a branch inherits from its assertion: the step limits. */
const pick = (a: Obj): Obj =>
  Object.fromEntries(
    ["after_step", "before_step", "step"].filter((k) => a[k] !== undefined).map((k) => [k, a[k]]),
  );

export function judgeRun(run: Run): Judgement {
  const j: Judging = { run, bound: { ...run.bound } };
  const out: AssertionVerdict[] = [];
  const assert = (run.variant["assert"] ?? {}) as Obj;
  const kinds: [string, (a: Obj, bound: Obj) => Omit<AssertionVerdict, "at" | "level">][] = [
    ["calls", (a, bound) => judgeCall(run, a, bound)],
    ["state", (a, bound) => judgeState(run, a, bound)],
    ["reply", (a) => judgeReply(run, a)],
  ];
  for (const [kind, base] of kinds) {
    for (const [i, a] of ((assert[kind] ?? []) as Obj[]).entries()) {
      const level = String(a["level"]);
      let v: Omit<AssertionVerdict, "at" | "level">;
      try {
        v = judgeOne(j, kind, a, base);
      } catch (e) {
        v = { verdict: "error", note: e instanceof Error ? e.message : String(e) };
      }
      if (level === "N" && v.verdict !== "error") {
        v = { verdict: "recorded", note: [v.verdict, v.note].filter(Boolean).join(": ") };
      }
      out.push({ at: `${kind}[${i}]`, level, ...v });
    }
  }
  return {
    variant: String(run.variant["id"]),
    dir: run.dir,
    ...(j.path !== undefined ? { path: j.path } : {}),
    assertions: out,
    ...outcome(out),
  };
}

// --- the command ---------------------------------------------------------------------------------

if (import.meta.url === `file://${process.argv[1]}`) {
  const dirs = process.argv.slice(2);
  if (dirs.length === 0) {
    process.stderr.write("usage: judge.ts <run directory> [<run directory> …]\n");
    process.exit(2);
  }
  let bad = false;
  for (const d of dirs) {
    const dir = resolve(d);
    try {
      const j = judgeRun(readRun(dir));
      writeFileSync(join(dir, "judgement.json"), `${JSON.stringify(j, null, 2)}\n`);
      const n = (v: Verdict) => j.assertions.filter((a) => a.verdict === v).length;
      const res = j.passed === null ? "open" : j.passed ? "pass" : "fail";
      process.stdout.write(
        `${dir}: ${res}${j.safetyFailed ? " (S failed)" : ""} · pass ${n("pass")} fail ${n("fail")} rubric ${n("rubric")} unjudged ${n("unjudged")} error ${n("error")}\n`,
      );
    } catch (e) {
      bad = true;
      process.stderr.write(`${dir}: ${e instanceof Error ? e.message : String(e)}\n`);
    }
  }
  process.exit(bad ? 1 : 0);
}
