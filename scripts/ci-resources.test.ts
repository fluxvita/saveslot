// ci-resources.ts: the limits read off a cgroup's files, v2 and v1, and "none" when there are none.

import { describe, expect, it } from "vitest";
import { cpuLimit, memoryLimit, resources } from "./ci-resources.ts";

describe("cpuLimit", () => {
  it.each([
    ["200000 100000\n", 2],
    ["150000 100000", 1.5],
    ["max 100000\n", undefined],
    ["-1 100000", undefined],
    ["", undefined],
  ])("%j is %j", (text, want) => {
    expect(cpuLimit(text)).toBe(want);
  });
});

describe("memoryLimit", () => {
  it.each([
    ["4294967296\n", 4294967296],
    ["max\n", undefined],
    ["9223372036854771712\n", undefined],
    ["", undefined],
  ])("%j is %j", (text, want) => {
    expect(memoryLimit(text)).toBe(want);
  });
});

describe("resources", () => {
  const files =
    (map: Record<string, string>) =>
    (path: string): string | undefined =>
      map[path];

  it("reads cgroup v2", () => {
    const [cpu, mem] = resources(
      files({
        "/sys/fs/cgroup/cpu.max": "200000 100000",
        "/sys/fs/cgroup/memory.max": "4294967296",
      }),
    );
    expect(cpu).toMatch(/, cgroup limit 2\.00$/);
    expect(mem).toMatch(/^memory: cgroup limit 4096 MiB, host total \d+ MiB, host free \d+ MiB$/);
  });

  it("reads cgroup v1", () => {
    const [cpu, mem] = resources(
      files({
        "/sys/fs/cgroup/cpu/cpu.cfs_quota_us": "100000\n",
        "/sys/fs/cgroup/cpu/cpu.cfs_period_us": "100000\n",
        "/sys/fs/cgroup/memory/memory.limit_in_bytes": "2147483648\n",
      }),
    );
    expect(cpu).toMatch(/, cgroup limit 1\.00$/);
    expect(mem).toMatch(/^memory: cgroup limit 2048 MiB,/);
  });

  it("says none without a cgroup, or with one that sets no limit", () => {
    for (const map of [
      {},
      { "/sys/fs/cgroup/cpu.max": "max 100000", "/sys/fs/cgroup/memory.max": "max" },
    ]) {
      const [cpu, mem] = resources(files(map));
      expect(cpu).toMatch(/^CPUs: Node availableParallelism \d+, cpus \d+, cgroup limit none$/);
      expect(mem).toMatch(/^memory: cgroup limit none,/);
    }
  });
});
