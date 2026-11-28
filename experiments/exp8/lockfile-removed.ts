// Experiment 8, a removed lock file at process level (pre-dev-w0-experiments 实验 8; spec 02 §7
// «进程、单写者、串行写»). Real service processes, started as `saveslot start --foreground`:
//
// 1. service 1 starts and is ready; a writer sends it one write every `--every` ms over one kept-open
//    connection (so it still reaches service 1 if its socket file is replaced);
// 2. after `--before` writes, the scenario's lock file(s) are removed and service 2 is started;
// 3. while service 2 is ready, a second writer sends it writes over its socket;
// 4. after `--after` ms both are stopped, and a fresh service checks the data: every acknowledged
//    write is there, the log verifies, and no write of service 1 was acknowledged after service 2
//    opened the store.
//
//   node --conditions=source experiments/exp8/lockfile-removed.ts --scenario data|home|both|two-homes
//        [--rounds 5] [--every 100] [--before 20] [--after 8000]
//
// Scenarios: `data` removes `<data dir>/saveslot.lock`; `home` removes `<home>/run/saveslot.lock`;
// `both` removes both; `two-homes`: a second home recording the same data directory (a copy of the
// first one's control files), and `<data dir>/saveslot.lock` removed. Results:
// experiments/out/exp8/lockfile-removed-<scenario>.json.

import { type ChildProcess, spawn } from "node:child_process";
import { cpSync, existsSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { Agent, request } from "node:http";
import { join, resolve } from "node:path";
import { arg, EXPERIMENTS, exited, nowMs, outDir, scratch, sleep } from "../lib/util.ts";

const BIN = resolve(EXPERIMENTS, "..", "packages", "saveslot", "src", "bin.ts");
const scenario = arg("scenario");
const rounds = Number(arg("rounds", "5"));
const every = Number(arg("every", "100"));
const before = Number(arg("before", "20"));
const after = Number(arg("after", "8000"));
if (!["data", "home", "both", "two-homes"].includes(scenario))
  throw new Error(`unknown scenario ${scenario}`);

const LEDGER = {
  slot: "ledger",
  base_version: null,
  timezone: "UTC",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
  ],
};

interface Reply {
  status: number;
  body: string;
}
function http(
  o: { socket: string; agent?: Agent; token?: string },
  method: string,
  path: string,
  body?: unknown,
  timeoutMs = 10_000,
): Promise<Reply> {
  return new Promise((res, rej) => {
    const req = request(
      {
        socketPath: o.socket,
        ...(o.agent ? { agent: o.agent } : {}),
        method,
        path,
        timeout: timeoutMs,
        headers: {
          ...(o.token ? { authorization: `Bearer ${o.token}` } : {}),
          ...(body !== undefined ? { "content-type": "application/json" } : {}),
        },
      },
      (r) => {
        let b = "";
        r.setEncoding("utf8").on("data", (c: string) => {
          b += c;
        });
        r.on("end", () => res({ status: r.statusCode ?? 0, body: b }));
      },
    );
    req.on("timeout", () => req.destroy(new Error("timeout")));
    req.on("error", rej);
    req.end(body !== undefined ? JSON.stringify(body) : undefined);
  });
}

function cli(args: string[]): Promise<{ code: number | null; out: string }> {
  return new Promise((res) => {
    const p = spawn(process.execPath, ["--conditions=source", "--no-warnings", BIN, ...args], {
      stdio: ["ignore", "pipe", "pipe"],
    });
    let out = "";
    p.stdout.on("data", (c) => {
      out += c;
    });
    p.stderr.on("data", (c) => {
      out += c;
    });
    p.on("exit", (code) => res({ code, out }));
  });
}

interface Service {
  name: string;
  proc: ChildProcess;
  log: string[];
  exit?: { code: number | null; signal: string | null; at: number };
}
function startService(name: string, home: string): Service {
  const proc = spawn(
    process.execPath,
    ["--conditions=source", "--no-warnings", BIN, "start", "--foreground", "--home", home],
    { stdio: ["ignore", "ignore", "pipe"] },
  );
  const s: Service = { name, proc, log: [] };
  proc.stderr?.setEncoding("utf8").on("data", (c: string) => {
    for (const l of c.split("\n")) if (l.trim() !== "") s.log.push(`${Math.round(nowMs())} ${l}`);
  });
  proc.on("exit", (code, signal) => {
    s.exit = { code, signal, at: nowMs() };
  });
  return s;
}

async function health(socket: string): Promise<Record<string, unknown> | undefined> {
  try {
    const r = await http({ socket }, "GET", "/health", undefined, 2000);
    return JSON.parse(r.body) as Record<string, unknown>;
  } catch {
    return undefined;
  }
}

/** Waits until `s` answers ready on `socket` (with its own pid), or exits; the outcome. */
async function readyOrExit(s: Service, socket: string, timeoutMs = 60_000) {
  const t0 = nowMs();
  while (nowMs() - t0 < timeoutMs) {
    if (s.exit) return { ready: false as const, exit: s.exit };
    const h = await health(socket);
    if (h?.["state"] === "ready" && h["pid"] === s.proc.pid)
      return { ready: true as const, at: nowMs() };
    await sleep(50);
  }
  return { ready: false as const, timeout: true };
}

interface Ack {
  i: number;
  at: number;
  sentAt: number;
}
/** Writes `<tag>-<i>` every `every` ms until `stop()`; acknowledged writes and refusals. */
function writer(tag: string, socket: string, token: string, agent: Agent) {
  const acks: Ack[] = [];
  const refusals: { i: number; at: number; status?: number; error: string }[] = [];
  let stopped = false;
  const done = (async () => {
    for (let i = 1; !stopped; i++) {
      const sentAt = nowMs();
      try {
        const r = await http({ socket, agent, token }, "POST", "/v1/writes", {
          sv: 1,
          ops: [
            {
              intent: "insert",
              table: "ledger.expenses",
              set: { date: "2026-11-27", note: `${tag}-${i}` },
            },
          ],
        });
        if (r.status === 200) acks.push({ i, at: nowMs(), sentAt });
        else {
          let code = "";
          try {
            code = String((JSON.parse(r.body) as { error?: { code?: string } }).error?.code);
          } catch {
            code = r.body.slice(0, 120);
          }
          refusals.push({ i, at: nowMs(), status: r.status, error: code });
        }
      } catch (e) {
        refusals.push({ i, at: nowMs(), error: (e as Error).message });
        if (refusals.length > 20) break;
      }
      await sleep(every);
    }
  })();
  return {
    acks,
    refusals,
    stop: async () => {
      stopped = true;
      await done;
    },
  };
}

async function stopService(s: Service) {
  if (s.exit) return;
  s.proc.kill("SIGTERM");
  const t = setTimeout(() => s.proc.kill("SIGKILL"), 20_000);
  await exited(s.proc);
  clearTimeout(t);
}

async function round(r: number) {
  const root = scratch(`exp8-rmlock-${scenario}`);
  const home1 = join(root, "home");
  const dataDir = join(root, "data");
  const init = await cli(["init", "--home", home1, "--data-dir", dataDir]);
  if (init.code !== 0) throw new Error(`init: ${init.out}`);
  let home2 = home1;
  if (scenario === "two-homes") {
    home2 = join(root, "home2");
    cpSync(home1, home2, { recursive: true, filter: (src) => !src.startsWith(join(home1, "run")) });
  }
  const token = readFileSync(join(home1, "credentials", "session"), "utf8").trim();
  const sock1 = join(home1, "run", "saveslot.sock");
  const sock2 = join(home2, "run", "saveslot.sock");

  const s1 = startService("service1", home1);
  const r1 = await readyOrExit(s1, sock1);
  if (!r1.ready) throw new Error(`service 1 not ready: ${JSON.stringify(r1)} ${s1.log.join("\n")}`);
  const agent1 = new Agent({ keepAlive: true, maxSockets: 1 });
  const draft = await http({ socket: sock1, agent: agent1, token }, "POST", "/v1/drafts", {
    document: LEDGER,
  });
  if (draft.status !== 200) throw new Error(`draft: ${draft.status} ${draft.body}`);
  const w1 = writer("s1", sock1, token, agent1);
  while (w1.acks.length < before && w1.refusals.length === 0) await sleep(20);

  const removed: Record<string, boolean> = {};
  const dataLock = join(dataDir, "saveslot.lock");
  const homeLock = join(home1, "run", "saveslot.lock");
  if (scenario !== "home") {
    removed[dataLock] = existsSync(dataLock);
    rmSync(dataLock, { force: true });
  }
  if (scenario === "home" || scenario === "both") {
    removed[homeLock] = existsSync(homeLock);
    rmSync(homeLock, { force: true });
  }
  const removedAt = nowMs();
  // When the owner file changes: the moment another opener named itself the owner.
  const ownerFile = join(dataDir, "saveslot.owner");
  const ownerBefore = readFileSync(ownerFile, "utf8");
  let ownerChangedAt: number | undefined;
  const watch = setInterval(() => {
    if (ownerChangedAt !== undefined) return;
    try {
      if (readFileSync(ownerFile, "utf8") !== ownerBefore) ownerChangedAt = nowMs();
    } catch {}
  }, 5);
  const s2 = startService("service2", home2);
  const r2 = await readyOrExit(s2, sock2, 60_000);
  let w2: ReturnType<typeof writer> | undefined;
  let agent2: Agent | undefined;
  if (r2.ready) {
    agent2 = new Agent({ keepAlive: true, maxSockets: 1 });
    w2 = writer("s2", sock2, token, agent2);
  }
  await sleep(after);
  await w1.stop();
  await w2?.stop();
  agent1.destroy();
  agent2?.destroy();
  const sock1Exists = existsSync(sock1);
  const h1 = s1.exit ? undefined : await health(sock1);
  clearInterval(watch);
  const s1ExitBeforeStop = s1.exit;
  const s2ExitBeforeStop = s2.exit;
  await stopService(s2);
  await stopService(s1);

  // Check the data with a fresh service on the first home.
  rmSync(join(home1, "run"), { recursive: true, force: true });
  const s3 = startService("check", home1);
  const r3 = await readyOrExit(s3, sock1);
  let check: Record<string, unknown> = { ready: r3.ready };
  if (r3.ready) {
    const notes = new Set<string>();
    let cursor: string | undefined;
    let q: Reply;
    do {
      q = await http({ socket: sock1, token }, "POST", "/v1/query", {
        table: "ledger.expenses",
        ...(cursor !== undefined ? { cursor } : {}),
      });
      for (const m of q.body.matchAll(/"(s[12]-\d+)"/g)) notes.add(m[1] as string);
      cursor =
        q.status === 200 ? (JSON.parse(q.body) as { next_cursor?: string }).next_cursor : undefined;
    } while (cursor !== undefined);
    const verify = await http({ socket: sock1, token }, "GET", "/v1/log/verify");
    const lost1 = w1.acks.filter((a) => !notes.has(`s1-${a.i}`)).map((a) => a.i);
    const lost2 = (w2?.acks ?? []).filter((a) => !notes.has(`s2-${a.i}`)).map((a) => a.i);
    check = {
      ready: true,
      queryStatus: q.status,
      ...(q.status !== 200 ? { queryBody: q.body.slice(0, 300) } : {}),
      rowsS1: [...notes].filter((n) => n.startsWith("s1-")).length,
      rowsS2: [...notes].filter((n) => n.startsWith("s2-")).length,
      lostAcknowledgedS1: lost1,
      lostAcknowledgedS2: lost2,
      verifyStatus: verify.status,
      verify: verify.body.slice(0, 400),
    };
  } else check = { ...check, r3, log: s3.log };
  await stopService(s3);

  const s2ReadyAt = r2.ready ? r2.at : undefined;
  const s1AcksAfterS2Ready =
    s2ReadyAt === undefined ? [] : w1.acks.filter((a) => a.at > s2ReadyAt).map((a) => a.i);
  const s1AcksAfterRemoval = w1.acks.filter((a) => a.at > removedAt).length;
  // Two writers: service 1 acknowledged a write after another opener named itself the owner, or
  // after service 2 acknowledged its first write.
  const s2FirstAck = w2?.acks[0]?.at;
  const changedAt = ownerChangedAt as number | undefined;
  const s1AcksAfterOwnerChange =
    changedAt === undefined ? [] : w1.acks.filter((a) => a.at > changedAt).map((a) => a.i);
  const s1AcksAfterS2FirstAck =
    s2FirstAck === undefined ? [] : w1.acks.filter((a) => a.at > s2FirstAck).map((a) => a.i);
  const twoWriters = s1AcksAfterOwnerChange.length > 0 || s1AcksAfterS2FirstAck.length > 0;
  const s1LastAck = w1.acks.at(-1)?.at;
  const result = {
    round: r,
    removed,
    service2: r2.ready
      ? { ready: true, readyAfterRemovalMs: Math.round((r2.at as number) - removedAt) }
      : r2,
    service2ExitBeforeStop: s2ExitBeforeStop
      ? { code: s2ExitBeforeStop.code, signal: s2ExitBeforeStop.signal }
      : null,
    service1ExitBeforeStop: s1ExitBeforeStop
      ? {
          code: s1ExitBeforeStop.code,
          signal: s1ExitBeforeStop.signal,
          afterRemovalMs: Math.round(s1ExitBeforeStop.at - removedAt),
        }
      : null,
    service1HealthAtEnd: h1 ?? null,
    service1SocketFileAtEnd: sock1Exists,
    s1Acks: w1.acks.length,
    s1AcksAfterRemoval,
    s1AcksAfterS2Ready,
    ownerChangedAfterRemovalMs:
      ownerChangedAt === undefined ? null : Math.round(ownerChangedAt - removedAt),
    s1LastAckBeforeOwnerChangeMs:
      ownerChangedAt === undefined || s1LastAck === undefined
        ? null
        : Math.round(ownerChangedAt - s1LastAck),
    s1AcksAfterOwnerChange,
    s1AcksAfterS2FirstAck,
    s1Refusals: summarizeRefusals(w1.refusals),
    s1FirstRefusalAfterS2ReadyMs:
      s2ReadyAt === undefined || w1.refusals[0] === undefined
        ? null
        : Math.round(w1.refusals[0].at - s2ReadyAt),
    s2Acks: w2?.acks.length ?? 0,
    s2Refusals: summarizeRefusals(w2?.refusals ?? []),
    twoWriters,
    check,
    service1Log: s1.log.slice(-6),
    service2Log: s2.log.slice(-6),
  };
  console.log(JSON.stringify(result));
  rmSync(root, { recursive: true, force: true });
  return result;
}

function summarizeRefusals(rs: { error: string; status?: number }[]) {
  const by: Record<string, number> = {};
  for (const x of rs) {
    const k = `${x.status ?? "-"} ${x.error}`;
    by[k] = (by[k] ?? 0) + 1;
  }
  return by;
}

const results = [];
for (let r = 1; r <= rounds; r++) results.push(await round(r));
const file = join(outDir("exp8"), `lockfile-removed-${scenario}.json`);
writeFileSync(
  file,
  `${JSON.stringify(
    {
      experiment: "lockfile-removed",
      scenario,
      rounds,
      roundsWithTwoWriters: results.filter((x) => x.twoWriters).length,
      roundsWithLostAcknowledged: results.filter(
        (x) =>
          ((x.check["lostAcknowledgedS1"] as number[] | undefined)?.length ?? 0) +
            ((x.check["lostAcknowledgedS2"] as number[] | undefined)?.length ?? 0) >
          0,
      ).length,
      results,
      platform: process.platform,
      node: process.version,
    },
    null,
    2,
  )}\n`,
);
console.log(`written ${file}`);
process.exit(0);
