// Small helpers shared by the experiment harnesses.

import { type ChildProcess, spawn } from "node:child_process";
import { mkdirSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { createInterface } from "node:readline";

export const EXPERIMENTS = resolve(import.meta.dirname, "..");
export const OUT = join(EXPERIMENTS, "out");

export function outDir(name: string): string {
  const d = join(OUT, name);
  mkdirSync(d, { recursive: true });
  return d;
}

export function scratch(prefix: string): string {
  return mkdtempSync(join(tmpdir(), `saveslot-${prefix}-`));
}

/** Wall-clock milliseconds with sub-millisecond precision, comparable across processes. */
export function nowMs(): number {
  return performance.timeOrigin + performance.now();
}

export const sleep = (ms: number) => new Promise<void>((r) => setTimeout(r, ms));

/** Starts a TypeScript harness file under experiments/ as a child process. */
export function node(script: string, args: readonly string[] = []): ChildProcess {
  return spawn(
    process.execPath,
    ["--conditions=source", "--no-warnings", join(EXPERIMENTS, script), ...args],
    { stdio: ["pipe", "pipe", "inherit"] },
  );
}

/** Lines of a child's stdout, parsed as JSON, delivered in order. */
export class Lines {
  readonly #queue: unknown[] = [];
  readonly #waiters: ((v: unknown) => void)[] = [];
  #ended = false;

  constructor(child: ChildProcess) {
    if (!child.stdout) throw new Error("child has no stdout");
    const rl = createInterface({ input: child.stdout });
    rl.on("line", (l) => {
      let v: unknown;
      try {
        v = JSON.parse(l);
      } catch {
        v = { raw: l };
      }
      const w = this.#waiters.shift();
      if (w) w(v);
      else this.#queue.push(v);
    });
    rl.on("close", () => {
      this.#ended = true;
      for (const w of this.#waiters.splice(0)) w(undefined);
    });
  }

  /** The next line, or undefined when the stream ended. */
  next(timeoutMs = 120_000): Promise<unknown> {
    const v = this.#queue.shift();
    if (v !== undefined) return Promise.resolve(v);
    if (this.#ended) return Promise.resolve(undefined);
    return new Promise((res, rej) => {
      const t = setTimeout(() => rej(new Error("timed out waiting for a line")), timeoutMs);
      this.#waiters.push((x) => {
        clearTimeout(t);
        res(x);
      });
    });
  }
}

export function exited(child: ChildProcess): Promise<number | null> {
  return new Promise((r) => {
    if (child.exitCode !== null || child.signalCode !== null) r(child.exitCode);
    else child.once("exit", (code) => r(code));
  });
}

export function percentile(sorted: readonly number[], p: number): number {
  if (sorted.length === 0) return Number.NaN;
  const i = Math.min(sorted.length - 1, Math.ceil((p / 100) * sorted.length) - 1);
  return sorted[Math.max(0, i)] as number;
}

export function summary(values: readonly number[]) {
  const s = [...values].sort((a, b) => a - b);
  const r = (x: number) => Math.round(x * 1000) / 1000;
  return {
    n: s.length,
    min: r(s[0] ?? Number.NaN),
    p50: r(percentile(s, 50)),
    p95: r(percentile(s, 95)),
    p99: r(percentile(s, 99)),
    max: r(s[s.length - 1] ?? Number.NaN),
  };
}

export function arg(name: string, fallback?: string): string {
  const i = process.argv.indexOf(`--${name}`);
  const v = i >= 0 ? process.argv[i + 1] : fallback;
  if (v === undefined) throw new Error(`missing --${name}`);
  return v;
}

export function ensureParent(path: string): void {
  mkdirSync(dirname(path), { recursive: true });
}
