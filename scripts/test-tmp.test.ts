// Tests for the run's temporary directory (./test-tmp.ts): which processes and which directories
// it takes for its own to clear, and that it leaves the others.

import { spawn } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { processesUnder, RUN_PREFIX, staleRuns, stopProcessesUnder } from "./test-tmp.ts";

const dirs: string[] = [];
const pids: number[] = [];

function scratch(): string {
  const d = mkdtempSync(join(tmpdir(), "saveslot-test-tmp-"));
  dirs.push(d);
  return d;
}

/** A process whose command line names `path`, running until stopped; `deaf` ignores SIGTERM. */
async function holder(path: string, o: { deaf?: boolean } = {}): Promise<number> {
  const code = `${o.deaf === true ? 'process.on("SIGTERM", () => {});' : ""}
    process.stdout.write("up\\n"); setInterval(() => {}, 1000);`;
  const child = spawn(process.execPath, ["-e", code, path], {
    detached: true,
    stdio: ["ignore", "pipe", "ignore"],
  });
  const pid = child.pid as number;
  pids.push(pid);
  await new Promise((r) => child.stdout?.once("data", r));
  child.stdout?.destroy();
  child.unref();
  return pid;
}

const running = (pid: number): boolean => {
  try {
    process.kill(pid, 0);
    return true;
  } catch {
    return false;
  }
};

async function gone(pid: number): Promise<boolean> {
  for (let i = 0; i < 100 && running(pid); i++) await new Promise((r) => setTimeout(r, 50));
  return !running(pid);
}

afterEach(() => {
  for (const pid of pids.splice(0)) {
    try {
      process.kill(pid, "SIGKILL");
    } catch {
      // Stopped by the test.
    }
  }
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the processes under a directory", () => {
  const PS = [
    "    1 /sbin/launchd",
    "  412 node --conditions=source /repo/packages/daemon/src/bin.ts --home /tmp/sst-aaaaaa/t/h-1/home",
    "  413 node /repo/bin.js --home /tmp/sst-aaaaaa-other/t/home",
    "  414 node /repo/bin.js --home /tmp/sst-aaaaaa",
    "  415 /bin/sleep 30",
    "77777 node /tmp/sst-aaaaaa/t/script.js",
    "",
  ].join("\n");

  it("are those whose command line names a path in it: not a sibling, not the directory alone", () => {
    expect(processesUnder(PS, "/tmp/sst-aaaaaa", 1).map((p) => p.pid)).toEqual([412, 77777]);
  });

  it("never the process that asks", () => {
    expect(processesUnder(PS, "/tmp/sst-aaaaaa", 77777).map((p) => p.pid)).toEqual([412]);
  });

  it("each with its whole command line", () => {
    expect(processesUnder(PS, "/tmp/sst-aaaaaa", 1)[1]).toEqual({
      pid: 77777,
      command: "node /tmp/sst-aaaaaa/t/script.js",
    });
  });
});

describe("the runs left by a killed process", () => {
  it("are the run directories whose owner is not running; others are not touched", () => {
    const base = scratch();
    const run = (name: string, owner?: string) => {
      mkdirSync(join(base, name));
      if (owner !== undefined) writeFileSync(join(base, name, "owner"), owner);
    };
    run(`${RUN_PREFIX}dead`, "101\n");
    run(`${RUN_PREFIX}live`, "102\n");
    run(`${RUN_PREFIX}no-owner`);
    run(`${RUN_PREFIX}not-a-pid`, "soon\n");
    run(`${RUN_PREFIX}zero`, "0\n");
    run("another-dead", "101\n");
    expect(staleRuns(base, (pid) => pid === 102)).toEqual([join(base, `${RUN_PREFIX}dead`)]);
  });
});

describe("stopping the processes under a directory", () => {
  it("stops those started from under it, and no other", async () => {
    const dir = scratch();
    const other = scratch();
    const mine = await holder(join(dir, "home"));
    const theirs = await holder(join(other, "home"));
    expect(stopProcessesUnder(dir).map((p) => p.pid)).toEqual([mine]);
    expect(await gone(mine)).toBe(true);
    expect(running(theirs)).toBe(true);
  });

  it("kills one that does not end when asked", async () => {
    const dir = scratch();
    const deaf = await holder(join(dir, "home"), { deaf: true });
    expect(stopProcessesUnder(dir, 300).map((p) => p.pid)).toEqual([deaf]);
    expect(await gone(deaf)).toBe(true);
  });

  it("finds nothing under a directory nothing was started from", () => {
    expect(stopProcessesUnder(scratch())).toEqual([]);
  });
});
