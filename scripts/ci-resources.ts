// Prints the CPUs and the memory a CI job can use, at the head of each heavy job's log. Vitest runs
// one worker fewer than the CPUs Node reports, so a job given one or two runs the test files one
// after another; and a worker the kernel kills for want of memory shows only as
// "Worker exited unexpectedly with signal SIGKILL". Either is then read off the log, not guessed.
//
// The container's limits are its cgroup's (v2: `cpu.max`, `memory.max`; v1: `cpu.cfs_quota_us`
// over `cpu.cfs_period_us`, `memory.limit_in_bytes`); with none, the host's.
//
// Usage: node scripts/ci-resources.ts

import { readFileSync } from "node:fs";
import { availableParallelism, cpus, freemem, totalmem } from "node:os";

const MIB = 1024 * 1024;

/** A cgroup's CPU limit in CPUs, or undefined for none: v2 `cpu.max` is "<quota> <period>" or "max <period>". */
export function cpuLimit(cpuMax: string): number | undefined {
  const [quota, period] = cpuMax.trim().split(/\s+/);
  if (quota === undefined || quota === "max" || period === undefined) return undefined;
  const q = Number(quota);
  const p = Number(period);
  return q > 0 && p > 0 ? q / p : undefined;
}

/**
 * A cgroup's memory limit in bytes, or undefined for none: v2 writes "max", v1 a number near 2^63
 * (rounded down to the page size).
 */
export function memoryLimit(memoryMax: string): number | undefined {
  const t = memoryMax.trim();
  if (t === "" || t === "max") return undefined;
  const n = Number(t);
  return Number.isFinite(n) && n > 0 && n < 2 ** 62 ? n : undefined;
}

function read(path: string): string | undefined {
  try {
    return readFileSync(path, "utf8");
  } catch {
    return undefined;
  }
}

/** What the job can use, one line each. */
export function resources(file: (path: string) => string | undefined = read): string[] {
  const v2 = file("/sys/fs/cgroup/cpu.max");
  const v1 = [
    file("/sys/fs/cgroup/cpu/cpu.cfs_quota_us"),
    file("/sys/fs/cgroup/cpu/cpu.cfs_period_us"),
  ];
  const cpu =
    v2 !== undefined
      ? cpuLimit(v2)
      : v1[0] !== undefined && v1[1] !== undefined
        ? cpuLimit(`${v1[0].trim()} ${v1[1].trim()}`)
        : undefined;
  const memText =
    file("/sys/fs/cgroup/memory.max") ?? file("/sys/fs/cgroup/memory/memory.limit_in_bytes");
  const mem = memText === undefined ? undefined : memoryLimit(memText);
  return [
    `CPUs: Node availableParallelism ${availableParallelism()}, cpus ${cpus().length}, cgroup limit ${cpu === undefined ? "none" : cpu.toFixed(2)}`,
    `memory: cgroup limit ${mem === undefined ? "none" : `${Math.round(mem / MIB)} MiB`}, host total ${Math.round(totalmem() / MIB)} MiB, host free ${Math.round(freemem() / MIB)} MiB`,
  ];
}

if (import.meta.main) {
  for (const line of resources()) console.log(line);
}
