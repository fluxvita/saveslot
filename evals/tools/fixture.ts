// Installs one evaluation variant's fixture and runs its script steps (docs/zh-CN/spec/10-evals.md
// §2.1, §2.5, §16): a new home, the service on the test clock, the slots, the connection
// instances, the seed calls in order (each write with its idempotency key), then the steps, in
// order. A script step's calls and an `advance` are made here; an agent step is a person's: the
// runner says what to say, on which connection, in which session, and waits. The assertions are
// not judged here. Nothing goes through MCP or an agent.
//
//   node --conditions=source evals/tools/fixture.ts <variant.yaml> <run directory>
//     [--fixture-only] [--today YYYY-MM-DD]
//
// The variant's dates are moved to the day it runs (./shift.ts): by the same number of days, so
// that the system prompt's "today" is the machine's date, which the hosts go by. A variant that
// cannot keep its meaning on that day (its weeks or months would shift) is refused, with the next
// days it can run on; a date written in a form the shift does not know stops the run. A variant
// that writes its dates as anchors (`@month+7`, ./anchors.ts) is given them on that day instead,
// and runs on the days its anchors keep what they had on its clock's day. `--today` sets the day
// to run as, to check a shift: a host still goes by the machine's date.
//
// The run directory must not exist. In it:
//   home/                      the saveslot home (data, control files, the service's log)
//   tokens.json (0600)         the connection instances' tokens, for the host's MCP setup only
//   run.json                   the variant, the clock, the commit, the fixture's hash, the
//                              connection instances (no tokens), the system prompt, what was bound
//   calls/NN-….json            every call the runner made: what it sent and what came back
//   state/<when>/….json        what the user session reads after the fixture and after each step
//   variant.shifted.yaml       the variant as it runs, its dates moved: what the assertions are read
//                              against
//   shift.json                 how far the dates moved, and each replacement with its YAML path;
//                              for anchors, what each one is on the reference day and on this one
//   records/<key>/             `saveslot mcp --record` for connection <key>: a new file per
//                              session (the host starts the bridge anew), the latest one last
//   calls.jsonl                each tool call the agents made, paired with its contract result
//                              from the service's evaluation results (./pair.ts)
//   state/final/history/       at the end: every row's and entity's history (timeline, every page)
//   state/final/pending-all.json  at the end: every item, closed ones too, each with its detail
// `--fixture-only` stops after the fixture (and its state), without running the steps, and leaves
// the service running; otherwise the service the runner started is stopped on every way out.

import { execFileSync, spawnSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { request } from "node:http";
import { join, resolve } from "node:path";
import { initLocalHome, sessionFile } from "@fluxvita/saveslot-service";
import { osFileLock, PgliteBackend } from "@fluxvita/saveslot-store-pglite";
import { parse, stringify } from "yaml";
// The templates as the CLI ships them (06-cli §3.1); not part of its exports.
import { templateDocument } from "../../packages/cli/src/templates.ts";
import { anchored, cannotRunAnchored, nextAnchoredDays, usesAnchors } from "./anchors.ts";
import { pairCalls } from "./pair.ts";
import { prompt as askPerson } from "./prompt.ts";
import { cannotRun, dayOf, nextRunDays, offsetHolds, shiftVariant, todayIn } from "./shift.ts";

type Obj = Record<string, unknown>;

const REPO = resolve(new URL("../..", import.meta.url).pathname);
const BIN = join(REPO, "packages", "saveslot", "src", "bin.ts");

interface Call {
  readonly as: string;
  readonly op: string;
  readonly params?: Obj;
  readonly bind?: Record<string, string>;
}
interface Variant {
  readonly id: string;
  readonly clock: string;
  readonly fixture: {
    readonly slots: { name: string; template?: string; schema?: Obj; timezone?: string }[];
    readonly connections: { key: string; name: string; scopes: string[] }[];
    readonly seed?: Call[];
  };
  readonly steps: (
    | { agent: string; new_session?: boolean; user: string }
    | { script: Call[] }
    | { advance: string }
  )[];
}

/** Whether this run started the service, so that every way out stops it. */
let started = false;
let keepRunning = false;

const fail = (message: string): never => {
  process.stderr.write(`error: ${message}\n`);
  stopService();
  process.exit(1);
};

// --- the command line ----------------------------------------------------------------------------

const args = process.argv.slice(2);
const fixtureOnly = args.includes("--fixture-only");
const todayAt = args.indexOf("--today");
const todayArg = todayAt >= 0 ? args[todayAt + 1] : undefined;
if (todayAt >= 0 && (todayArg === undefined || !/^\d{4}-\d{2}-\d{2}$/.test(todayArg))) {
  fail("--today takes a day, YYYY-MM-DD");
}
const [file, dirArg] = args.filter((a, i) => !a.startsWith("--") && i !== todayAt + 1);
if (file === undefined || dirArg === undefined) {
  fail("usage: fixture.ts <variant.yaml> <run directory> [--fixture-only] [--today YYYY-MM-DD]");
}
const dir = resolve(dirArg as string);
if (existsSync(dir)) fail(`${dir} exists: every run starts from a new directory`);
const text = readFileSync(file as string, "utf8");
const original = parse(text) as Variant;

// --- the day it runs (./shift.ts) ----------------------------------------------------------------

/** A slot's schema document: its template's, or the one the variant gives. */
const documentOf = (s: Variant["fixture"]["slots"][number]): Obj | undefined =>
  s.template !== undefined
    ? (templateDocument(s.template, s.name, s.timezone)?.doc as Obj | undefined)
    : { ...s.schema, slot: s.name, base_version: null, timezone: s.timezone };
const rules = original.fixture.slots.flatMap((s) =>
  ((documentOf(s)?.["tables"] ?? []) as Obj[]).flatMap((t) => {
    const sql = (t["rule"] as Obj | undefined)?.["sql"];
    return typeof sql === "string" ? [sql] : [];
  }),
);
const zone = original.fixture.slots[0]?.timezone ?? "Asia/Shanghai";
const today = todayArg ?? todayIn(zone);
const days = dayOf(today) - dayOf(original.clock);
const offsetRefusal = offsetHolds(original.clock, days, zone)
  ? []
  : [`the clock's offset does not hold in ${zone} on the moved day (daylight saving)`];
const listed = (us: readonly { path: string; text: string; why: string }[]) =>
  us.map((u) => `${u.path}: ${u.text} (${u.why})`).join("\n  ");

/** A variant with anchors (./anchors.ts): given on the day it runs; otherwise moved (./shift.ts). */
const withAnchors = usesAnchors(original as unknown as Obj)
  ? anchored(original as unknown as Obj, dayOf(today))
  : undefined;
let shifted: { variant: Obj; replacements: { path: string; from: string; to: string }[] };
if (withAnchors !== undefined) {
  if (withAnchors.unknown.length > 0) {
    fail(
      `the variant writes its dates as anchors; these are not:\n  ${listed(withAnchors.unknown)}`,
    );
  }
  const refusals = [
    ...cannotRunAnchored(original as unknown as Obj, dayOf(today)),
    ...offsetRefusal,
  ];
  if (refusals.length > 0) {
    fail(
      `${original.id} cannot run on ${today}:\n  ${refusals.join("\n  ")}\n  it can on: ${nextAnchoredDays(original as unknown as Obj, today).join(", ")}`,
    );
  }
  shifted = withAnchors;
} else {
  const refusals = [...cannotRun(original as unknown as Obj, days, rules), ...offsetRefusal];
  if (refusals.length > 0) {
    fail(
      `${original.id} cannot run on ${today}:\n  ${refusals.join("\n  ")}\n  it can on: ${nextRunDays(original as unknown as Obj, today, rules).join(", ")}`,
    );
  }
  const moved = shiftVariant(original as unknown as Obj, days);
  if (moved.unknown.length > 0) {
    fail(
      `dates the shift does not know how to move; write them as YYYY-MM-DD, "M 月 D 日" or MM-DD:\n  ${listed(moved.unknown)}`,
    );
  }
  shifted = moved;
}
const v = shifted.variant as unknown as Variant;
const home = join(dir, "home");
const socketPath = join(home, "run", "saveslot.sock");

// --- the service ---------------------------------------------------------------------------------

/** `saveslot <args>` from the sources; its output as it is. */
function saveslot(argv: string[]): string {
  const r = spawnSync(process.execPath, ["--conditions=source", BIN, ...argv], {
    encoding: "utf8",
    env: { ...process.env, SAVESLOT_TOKEN: "" },
  });
  if (r.status !== 0) fail(`saveslot ${argv[0]} exited ${r.status}: ${r.stderr.trim()}`);
  return r.stdout;
}

/** One request on the service's socket; the answer's JSON. */
function http(
  method: string,
  path: string,
  token: string,
  body?: unknown,
  headers: Record<string, string> = {},
): Promise<{ status: number; json: Obj }> {
  return new Promise((done, reject) => {
    const data = body === undefined ? undefined : JSON.stringify(body);
    const req = request(
      {
        socketPath,
        method,
        path,
        headers: {
          authorization: `Bearer ${token}`,
          ...(data !== undefined ? { "content-type": "application/json" } : {}),
          ...headers,
        },
      },
      (res) => {
        let s = "";
        res.setEncoding("utf8").on("data", (c: string) => {
          s += c;
        });
        res.on("end", () => done({ status: res.statusCode ?? 0, json: JSON.parse(s || "{}") }));
      },
    );
    req.on("error", reject);
    if (data !== undefined) req.write(data);
    req.end();
  });
}

// --- calls, references, bindings -----------------------------------------------------------------

const bound: Obj = {};
const sv: Record<string, number> = {};
const tokens: Record<string, string> = {};
let callNo = 0;

/** `params` with every `$name` replaced by what was bound under it. */
function resolveRefs(x: unknown): unknown {
  if (typeof x === "string" && /^\$[A-Za-z_][A-Za-z0-9_]*$/.test(x)) {
    const name = x.slice(1);
    if (!Object.hasOwn(bound, name)) fail(`$${name} is not bound yet`);
    return bound[name];
  }
  if (Array.isArray(x)) return x.map(resolveRefs);
  if (x !== null && typeof x === "object") {
    return Object.fromEntries(Object.entries(x).map(([k, y]) => [k, resolveRefs(y)]));
  }
  return x;
}

/** The value at `path` (`ops[0].target.row`, `seq`) in `x`; undefined when there is none. */
function at(x: unknown, path: string): unknown {
  let cur = x;
  for (const part of path.match(/[^.[\]]+/g) ?? []) {
    if (cur === null || typeof cur !== "object") return undefined;
    cur = (cur as Obj)[part];
  }
  return cur;
}

/** The HTTP route of a contract call (05-surfaces §14). */
function route(op: string, p: Obj): { method: string; path: string; body?: Obj } {
  const id = encodeURIComponent(String(p["id"] ?? ""));
  const { id: _, ...rest } = p;
  switch (op) {
    case "write":
      return { method: "POST", path: "/v1/writes", body: p };
    case "query":
      return { method: "POST", path: "/v1/query", body: p };
    case "history":
      return { method: "POST", path: "/v1/history", body: p };
    case "pending":
      return p["id"] !== undefined
        ? { method: "GET", path: `/v1/pending/${id}` }
        : { method: "GET", path: "/v1/pending" };
    case "resolve":
      return { method: "POST", path: `/v1/pending/${id}/resolution`, body: rest };
    default:
      return fail(`${op}: not an operation this runner makes`);
  }
}

/** Makes `c` as its connection instance, records it, binds what it names; the result. */
async function call(c: Call, key: string): Promise<Obj> {
  const token = tokens[c.as];
  if (token === undefined) fail(`${c.as} is not a connection instance of this fixture`);
  const p = resolveRefs(c.params ?? {}) as Obj;
  // A seed write carries no sv: the one its slot's creation gave (10-evals §2.1).
  if (c.op === "write" && p["sv"] === undefined) {
    const table = String(at(p, "ops[0].table") ?? "");
    const slot = table.split(".")[0] as string;
    if (sv[slot] === undefined) fail(`${table}: no slot of that name in the fixture`);
    p["sv"] = sv[slot];
  }
  const r = route(c.op, p);
  const headers = c.op === "write" || c.op === "resolve" ? { "idempotency-key": key } : {};
  const a = await http(r.method, r.path, token as string, r.body, headers);
  callNo += 1;
  const name = `${String(callNo).padStart(2, "0")}-${c.as}-${c.op}.json`;
  writeFileSync(
    join(dir, "calls", name),
    `${JSON.stringify({ key, as: c.as, op: c.op, params: p, status: a.status, result: a.json }, null, 2)}\n`,
  );
  if (a.status !== 200) fail(`${name}: ${a.status} ${JSON.stringify(a.json)}`);
  for (const [k, path] of Object.entries(c.bind ?? {})) {
    const value = at(a.json, path);
    if (value === undefined) fail(`${name}: nothing at ${path} to bind as ${k}`);
    bound[k] = value;
  }
  return a.json;
}

// --- state ---------------------------------------------------------------------------------------

/** What the user session reads: each slot's tables (state tables over all time), pending, reads. */
async function snapshot(session: string, when: string): Promise<void> {
  const out = join(dir, "state", when);
  mkdirSync(out, { recursive: true });
  const save = (name: string, x: unknown) =>
    writeFileSync(join(out, `${name}.json`), `${JSON.stringify(x, null, 2)}\n`);
  for (const s of v.fixture.slots) {
    const cat = await http("GET", `/v1/slots/${s.name}/schema`, session);
    const tables = (at(cat.json, "document.tables") ?? []) as Obj[];
    if (tables.length === 0) fail(`${s.name}: its schema lists no tables`);
    for (const t of tables) {
      const name = `${s.name}.${String(t["name"])}`;
      const state = at(t, "time.type") === "state";
      // Every page: the rows as the user session reads them, revoked ones too.
      const rows: unknown[] = [];
      let cursor: unknown;
      let last: Obj = {};
      do {
        const q = await http("POST", "/v1/query", session, {
          table: name,
          include_revoked: true,
          ...(state ? { valid_during: ["1900-01-01", null] } : {}),
          ...(cursor !== undefined ? { cursor } : {}),
        });
        if (q.status !== 200) fail(`state of ${name}: ${q.status} ${JSON.stringify(q.json)}`);
        rows.push(...((q.json["rows"] as unknown[]) ?? []));
        cursor = q.json["next_cursor"];
        last = q.json;
      } while (cursor !== undefined);
      save(name, { ...last, rows });
    }
  }
  for (const [name, path] of [
    ["pending", "/v1/pending"],
    ["reads", "/v1/reads"],
    ["log-end", "/v1/log/end"],
  ] as const) {
    const r = await http("GET", path, session);
    if (r.status !== 200) fail(`state ${name}: ${r.status} ${JSON.stringify(r.json)}`);
    save(name, r.json);
  }
}

/** Every page of a GET or POST read: the pages' list at `key`, the last page's other fields. */
async function allPages(
  method: string,
  path: string,
  session: string,
  key: string,
  body: Obj = {},
): Promise<Obj> {
  const items: unknown[] = [];
  let cursor: unknown;
  let last: Obj = {};
  do {
    const r =
      method === "GET"
        ? await http(
            "GET",
            `${path}${cursor !== undefined ? `${path.includes("?") ? "&" : "?"}cursor=${encodeURIComponent(String(cursor))}` : ""}`,
            session,
          )
        : await http("POST", path, session, {
            ...body,
            ...(cursor !== undefined ? { cursor } : {}),
          });
    if (r.status !== 200) fail(`${path}: ${r.status} ${JSON.stringify(r.json)}`);
    items.push(...((r.json[key] as unknown[]) ?? []));
    cursor = r.json["next_cursor"];
    last = r.json;
  } while (cursor !== undefined);
  return { ...last, [key]: items };
}

/**
 * At the end, what cannot be read once the service is stopped: every row's and entity's history
 * (timeline), and every item with its detail, closed ones too.
 */
async function archive(session: string): Promise<void> {
  const out = join(dir, "state", "final");
  const historyDir = join(out, "history");
  mkdirSync(historyDir, { recursive: true });
  for (const s of v.fixture.slots) {
    const cat = await http("GET", `/v1/slots/${s.name}/schema`, session);
    for (const t of (at(cat.json, "document.tables") ?? []) as Obj[]) {
      if (t["kind"] === "derived") continue;
      const table = `${s.name}.${String(t["name"])}`;
      const state = JSON.parse(readFileSync(join(out, `${table}.json`), "utf8")) as Obj;
      const targets = new Set<string>();
      for (const row of (state["rows"] ?? []) as Obj[]) {
        const id = row["entity"] ?? row["row"];
        if (typeof id === "string") targets.add(id);
      }
      mkdirSync(join(historyDir, table), { recursive: true });
      for (const id of targets) {
        const key = id.startsWith("e_") ? "entity" : "row";
        const h = await allPages("POST", "/v1/history", session, "entries", { table, [key]: id });
        writeFileSync(join(historyDir, table, `${id}.json`), `${JSON.stringify(h, null, 2)}\n`);
      }
    }
  }
  const list = await allPages("GET", "/v1/pending?status=all", session, "items");
  const details: Obj[] = [];
  for (const item of (list["items"] ?? []) as Obj[]) {
    const r = await http("GET", `/v1/pending/${encodeURIComponent(String(item["id"]))}`, session);
    if (r.status !== 200)
      fail(`pending ${String(item["id"])}: ${r.status} ${JSON.stringify(r.json)}`);
    details.push(r.json);
  }
  writeFileSync(
    join(out, "pending-all.json"),
    `${JSON.stringify({ ...list, details }, null, 2)}\n`,
  );
}

/** Stops the service this run started, once; not after `--fixture-only`, which leaves it running. */
function stopService(): void {
  if (!started || keepRunning) return;
  started = false;
  const r = spawnSync(process.execPath, ["--conditions=source", BIN, "stop", "--home", home], {
    encoding: "utf8",
    env: { ...process.env, SAVESLOT_TOKEN: "" },
  });
  if (r.status !== 0) process.stderr.write(`stopping the service: ${r.stderr.trim()}\n`);
}

// --- the system prompt (10-evals §2.2) ------------------------------------------------------------

function systemPrompt(clock: string, timezone: string): string {
  const d = new Date(clock);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone: timezone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).format(d);
  const weekday = new Intl.DateTimeFormat("zh-CN", { timeZone: timezone, weekday: "long" }).format(
    d,
  );
  return `你是用户的个人助手，可以使用已连接的工具。\n今天是 ${parts}（${weekday}），时区 ${timezone}。`;
}

// --- the run -------------------------------------------------------------------------------------

mkdirSync(join(dir, "calls"), { recursive: true });
writeFileSync(
  join(dir, "variant.shifted.yaml"),
  `# ${v.id} ${withAnchors !== undefined ? "given with its anchors" : "moved"}, ${days} days from ${original.clock} to ${v.clock} (the day it ran: ${today}).\n${stringify(v)}`,
);
writeFileSync(
  join(dir, "shift.json"),
  `${JSON.stringify(
    {
      variant: v.id,
      mode: withAnchors !== undefined ? "anchors" : "shift",
      today,
      days,
      original_clock: original.clock,
      clock: v.clock,
      ...(withAnchors !== undefined
        ? {
            reference: withAnchors.reference,
            bases: withAnchors.bases,
            anchors: withAnchors.uses,
            runs_when: withAnchors.runsWhen,
          }
        : {}),
      replacements: shifted.replacements,
    },
    null,
    2,
  )}\n`,
);
// The tenant's genesis at the clock's moment, not this computer's: a clock behind the log's end
// would record every later event at that end (02-architecture §8), and the test clock would show
// in nothing the log keeps. `saveslot init` takes no clock, so the home is made as it makes it.
await initLocalHome({
  home,
  backend: new PgliteBackend(),
  lock: osFileLock,
  now: new Date(v.clock).toISOString(),
});
// Every way out from here stops the service: an interrupt or a terminal closed, a failure, the
// end, and anything unforeseen (the exit handler; spawnSync runs there). Marked started before
// the start, so that a start cut short is stopped too (stopping a home with no service only
// says so).
for (const sig of ["SIGINT", "SIGTERM", "SIGHUP"] as const)
  process.on(sig, () => fail("interrupted"));
process.on("exit", () => stopService());
started = true;
saveslot(["start", "--home", home, "--eval-clock", v.clock]);
const session = readFileSync(sessionFile(home), "utf8").trim();

for (const s of v.fixture.slots) {
  const document = documentOf(s);
  if (document === undefined) fail(`${s.template}: no such template`);
  const r = await http("POST", "/v1/drafts", session, { document });
  writeFileSync(
    join(dir, "calls", `00-slot-${s.name}.json`),
    `${JSON.stringify({ status: r.status, result: r.json }, null, 2)}\n`,
  );
  if (r.status !== 200) fail(`slot ${s.name}: ${r.status} ${JSON.stringify(r.json)}`);
  sv[s.name] = r.json["sv"] as number;
}
const connections: Obj[] = [];
for (const c of v.fixture.connections) {
  const r = await http("POST", "/v1/connections", session, { name: c.name, scopes: c.scopes });
  if (r.status !== 200) fail(`connection ${c.key}: ${r.status} ${JSON.stringify(r.json)}`);
  tokens[c.key] = r.json["token"] as string;
  connections.push({ key: c.key, id: r.json["id"], name: c.name, scopes: c.scopes });
}
writeFileSync(join(dir, "tokens.json"), `${JSON.stringify(tokens, null, 2)}\n`, { mode: 0o600 });
for (const [i, c] of (v.fixture.seed ?? []).entries()) await call(c, `${v.id}-seed-${i + 1}`);
await snapshot(session, "fixture");

const timezone = v.fixture.slots[0]?.timezone ?? "Asia/Shanghai";
const prompt = systemPrompt(v.clock, timezone);
const commit = (() => {
  try {
    return execFileSync("git", ["-C", REPO, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  } catch {
    return "unknown";
  }
})();
const writeRun = () =>
  writeFileSync(
    join(dir, "run.json"),
    `${JSON.stringify(
      {
        variant: v.id,
        clock: v.clock,
        saveslot_commit: commit,
        fixture_sha256: createHash("sha256").update(text).digest("hex"),
        shift: {
          mode: withAnchors !== undefined ? "anchors" : "shift",
          today,
          days,
          original_clock: original.clock,
        },
        connections,
        system_prompt: prompt,
        bound,
      },
      null,
      2,
    )}\n`,
  );
writeRun();

const say = (s = "") => process.stdout.write(`${s}\n`);
say(`fixture of ${v.id} installed in ${dir}`);
say(`bound: ${JSON.stringify(bound)}`);
if (fixtureOnly) {
  keepRunning = true;
  say(`the service keeps running on the test clock; stop it with: saveslot stop --home ${home}`);
  process.exit(0);
}

say("");
say("System prompt to add (10-evals §2.2), as it is:");
say(prompt);
// One MCP server per agent connection, set up once: each session the host starts records into
// its own new file in the connection's directory.
const agents = [...new Set(v.steps.flatMap((s) => ("agent" in s ? [s.agent] : [])))];
for (const key of agents) {
  const records = join(dir, "records", key);
  mkdirSync(records, { recursive: true, mode: 0o700 });
  say("");
  say(`The host's saveslot MCP server for ${key}, set up once before the first step:`);
  say(
    `  SAVESLOT_TOKEN=<tokens.json: ${key}> ${process.execPath} --conditions=source ${BIN} mcp --home ${home} --record ${records}`,
  );
}
// Ctrl-C at a question is a key in the terminal, not a signal (./prompt.ts).
const rl = askPerson(process.stdin, process.stdout, () => fail("interrupted"));
for (const [i, step] of v.steps.entries()) {
  const n = i + 1;
  say("");
  if ("agent" in step) {
    if (step.new_session === true) {
      say(
        `Step ${n}: a NEW session of the host, as ${step.agent}. Its calls are recorded in ${join(dir, "records", step.agent)}, the latest file.`,
      );
    } else {
      say(`Step ${n}: the same session as before, as ${step.agent}.`);
    }
    say("Say exactly this, then wait for the whole reply; do not add or correct anything:");
    say(`  ${step.user}`);
    await rl.ask("Press Enter once the agent has replied. ");
  } else if ("script" in step) {
    for (const [j, c] of step.script.entries()) await call(c, `${v.id}-step-${n}-${j + 1}`);
    say(`Step ${n}: script step made (${step.script.length} calls).`);
  } else {
    const r = await http("POST", "/v1/eval/clock", session, { advance: step.advance });
    if (r.status !== 200) fail(`advance: ${r.status} ${JSON.stringify(r.json)}`);
    say(`Step ${n}: the clock moved forward ${step.advance}, to ${String(r.json["now"])}.`);
  }
  await snapshot(session, `after-step-${n}`);
  writeRun();
}
rl.close();
await snapshot(session, "final");
await archive(session);
// The agents' tool calls with their contract results: the text the agent got is in the record,
// the result an assertion matches in the service's evaluation results.
const paired = pairCalls(dir);
say("");
say(`All steps done. State read back under ${join(dir, "state")}.`);
say(`${paired.paired} tool calls paired in ${join(dir, "calls.jsonl")}.`);
for (const p of paired.problems) say(`pairing: ${p}`);
stopService();
say(`The service is stopped; its home stays in ${home}.`);
