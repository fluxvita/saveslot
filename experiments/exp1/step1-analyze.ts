// Experiment 1, step 1: match each commit of the traced writer to the sync calls the tracer saw
// between the start of the transaction and the moment the commit returned.
//
//   node --conditions=source experiments/exp1/step1-analyze.ts --tracer linux-strace|macos-fs_usage
//        --trace <trace.txt> --writer <writer.jsonl>
//
// Prints counts per commit window. A commit "has a WAL sync" when a sync call on a pg_wal file falls
// in its window. Linux: the path is decoded by strace -y. macOS: fs_usage prints no path on fcntl /
// fsync lines, so the descriptor's path is learnt from earlier lines of the trace (see below); sync
// calls on a descriptor whose path never showed are counted in `unknownFdSyncs` and not as WAL.
//
// Refuses (exit 1, no counts) when the trace holds no line from the writer: on Linux no line carries
// the pid from the writer's "ready" line, on macOS no line comes from a `node` process. A trace of
// the wrong process would otherwise read as "0 sync calls", which looks like a valid result.

import { readFileSync } from "node:fs";
import { arg } from "../lib/util.ts";

const tracer = arg("tracer");
const lines = readFileSync(arg("trace"), "utf8").split("\n");
const writerLines = readFileSync(arg("writer"), "utf8").split("\n");
const ready = writerLines
  .filter((l) => l.includes('"ready"'))
  .map((l) => JSON.parse(l) as { pid: number })[0];
if (!ready) fail("the writer output has no ready line");
const writerPid = ready.pid;
const commits = writerLines
  .filter((l) => l.includes('"commitStart"'))
  .map(
    (l) =>
      JSON.parse(l) as { n: number; commitStart: number; committedAt: number; walFsyncs: number },
  );

interface Ev {
  t: number;
  kind: string;
  wal: boolean;
  line: string;
}
const events: Ev[] = [];

function fail(message: string): never {
  console.error(`step1-analyze: ${message}; no result reported`);
  process.exit(1);
}

// Lines the tracer attributes to the writer process.
let writerTraceLines = 0;
// macOS: sync calls on a descriptor whose path the trace never showed (counted as not on pg_wal).
let unknownFdSyncs = 0;

if (tracer === "linux-strace") {
  // "<pid> 1731400000.123456 fsync(12</path/pg_wal/000000010000000000000001>) = 0"
  const re =
    /^(?:\d+\s+)?(\d+\.\d+)\s+(fsync|fdatasync|sync_file_range|msync|fcntl|openat|open)\((.*)$/;
  for (const line of lines) {
    if (new RegExp(`^${writerPid}\\s`).test(line)) writerTraceLines++;
    const m = re.exec(line);
    if (!m) continue;
    const [, ts, call, rest] = m as unknown as [string, string, string, string];
    const isSync =
      call === "fsync" ||
      call === "fdatasync" ||
      call === "sync_file_range" ||
      call === "msync" ||
      ((call === "open" || call === "openat") && /O_SYNC|O_DSYNC/.test(rest));
    if (!isSync) continue;
    events.push({ t: Number(ts) * 1000, kind: call, wal: rest.includes("/pg_wal/"), line });
  }
} else if (tracer === "macos-fs_usage") {
  // fs_usage -w lines: "<hh:mm:ss.us>  <call>  <fields>  <elapsed> [W] <process>.<thread>".
  // fcntl and fsync lines carry no path, and the WAL segment is usually opened before the tracer
  // attaches, so a descriptor's path is learnt from the trace itself:
  //   open   F=<fd> (...) <path>            → fd is <path>
  //   pwrite F=<fd> ...                      followed, on the same thread, by
  //     WrData[<flags>] D=... B=... <dev> <path>  → fd is <path>
  //   close  F=<fd>                          → fd forgotten
  // Only F_FULLFSYNC (fcntl 51), F_BARRIERFSYNC (85), fsync and fdatasync count as sync calls.
  const day = commits[0] ? new Date(commits[0].commitStart) : new Date();
  const fdPath = new Map<string, string>();
  const lastWriteFd = new Map<string, string>(); // thread → fd of its last write / pwrite
  for (const line of lines) {
    const owner = /\snode\.(\d+)\s*$/.exec(line);
    if (!owner) continue;
    writerTraceLines++;
    const thread = owner[1] as string;
    const m = /^(\d\d):(\d\d):(\d\d\.\d+)\s+(\S+)(.*)$/.exec(line);
    if (!m) continue;
    const [, hh, mm, ss, call, rest] = m as unknown as [
      string,
      string,
      string,
      string,
      string,
      string,
    ];
    const fd = /\bF=(\d+)/.exec(rest)?.[1];
    const path = /\s(\/?private\/\S+|\/\S+)\s+\d+\.\d+/.exec(rest)?.[1];
    if (call.startsWith("WrData")) {
      const writeFd = lastWriteFd.get(thread);
      if (writeFd !== undefined && path !== undefined) fdPath.set(writeFd, path);
      lastWriteFd.delete(thread);
      continue;
    }
    lastWriteFd.delete(thread);
    if ((call === "write" || call === "pwrite") && fd !== undefined) lastWriteFd.set(thread, fd);
    if (call.startsWith("open") && fd !== undefined && path !== undefined) fdPath.set(fd, path);
    if (call === "close" && fd !== undefined) fdPath.delete(fd);
    const text = `${call}${rest}`;
    const kind = /FULLFSYNC|cmd=51\b/.test(text)
      ? "F_FULLFSYNC"
      : /BARRIERFSYNC|cmd=85\b/.test(text)
        ? "F_BARRIERFSYNC"
        : call === "fsync" || call === "fdatasync"
          ? call
          : undefined;
    if (kind === undefined) continue;
    const d = new Date(day);
    d.setHours(Number(hh), Number(mm), 0, 0);
    const target = fd === undefined ? undefined : fdPath.get(fd);
    if (target === undefined) unknownFdSyncs++;
    events.push({
      t: d.getTime() + Number(ss) * 1000,
      kind,
      wal: target?.includes("/pg_wal/") ?? false,
      line,
    });
  }
} else {
  throw new Error(`unknown tracer ${tracer}`);
}

if (commits.length === 0) fail("the writer output has no commits");
if (writerTraceLines === 0) {
  fail(
    `the trace has no line from the writer (pid ${writerPid}); it traced another process or nothing`,
  );
}

const perCommit = commits.map((c) => {
  const inWindow = events.filter((e) => e.t >= c.commitStart && e.t <= c.committedAt);
  return {
    n: c.n,
    syncCalls: inWindow.length,
    walSyncCalls: inWindow.filter((e) => e.wal).length,
    kinds: [...new Set(inWindow.map((e) => e.kind))],
    hookWalFsyncs: c.walFsyncs,
  };
});
const byKind: Record<string, number> = {};
for (const e of events) byKind[e.kind] = (byKind[e.kind] ?? 0) + 1;
console.log(
  JSON.stringify(
    {
      tracer,
      writerPid,
      writerTraceLines,
      unknownFdSyncs,
      commits: commits.length,
      commitsWithAnySyncCall: perCommit.filter((c) => c.syncCalls > 0).length,
      commitsWithWalSyncCall: perCommit.filter((c) => c.walSyncCalls > 0).length,
      syncCallsByKind: byKind,
      firstCommits: perCommit.slice(0, 5),
      commitsWithoutSync: perCommit.filter((c) => c.syncCalls === 0).map((c) => c.n),
      sampleLines: events.slice(0, 10).map((e) => e.line),
    },
    null,
    2,
  ),
);
