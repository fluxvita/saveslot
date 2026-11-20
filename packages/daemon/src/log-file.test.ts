// The service's log file rotated past its size (06-cli §3 «分步做»): after a line that takes it
// past the limit the file becomes `.1`, `.1` becomes `.2`, the oldest goes; each 0600.

import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  renameSync,
  rmSync,
  statSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import { LOG_KEEP, LOG_MAX_BYTES, rotatingLog } from "./log-file.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-log-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

describe("the service's log file", () => {
  it("is 10 MiB at most before it rotates, with two older copies kept", () => {
    expect([LOG_MAX_BYTES, LOG_KEEP]).toEqual([10 * 1024 * 1024, 2]);
  });

  it("rotates after the line that reaches the limit: .1 and .2 kept, a third older copy gone", () => {
    const file = join(root, `${n++}.log`);
    const write = rotatingLog(file, 1000);
    const line = (i: number) => `${String(i).padStart(4, "0")} ${"x".repeat(94)}`; // 100 bytes
    // Four files' worth and some: the first one written has been dropped.
    for (let i = 0; i < 45; i++) write(line(i));
    expect(existsSync(`${file}.1`)).toBe(true);
    expect(existsSync(`${file}.2`)).toBe(true);
    expect(existsSync(`${file}.3`)).toBe(false);
    for (const f of [file, `${file}.1`, `${file}.2`]) {
      expect(statSync(f).mode & 0o777).toBe(0o600);
      expect(statSync(f).size).toBeLessThanOrEqual(1000);
    }
    // Newest last: the current file has the latest lines, .1 the ten before them, .2 the ten before.
    const first = (f: string) => readFileSync(f, "utf8").split("\n")[0]?.slice(0, 4);
    expect(first(file)).toBe("0040");
    expect(first(`${file}.1`)).toBe("0030");
    expect(first(`${file}.2`)).toBe("0020");
    expect(readFileSync(`${file}.2`, "utf8")).not.toContain("0019 ");
  });

  it("a file already past the limit is rotated after the first line written to it", () => {
    const file = join(root, `${n++}.log`);
    writeFileSync(file, "y".repeat(2000), { mode: 0o600 });
    const write = rotatingLog(file, 1000);
    write("next");
    expect(readFileSync(`${file}.1`, "utf8")).toBe(`${"y".repeat(2000)}next\n`);
    expect(readFileSync(file, "utf8")).toBe("");
  });

  it("moved away while written to: another file now at the path is not rotated, and the lines go on to the moved one", () => {
    const dir = join(root, `${n++}`);
    mkdirSync(dir);
    const file = join(dir, "saveslot.log");
    const write = rotatingLog(file, 300);
    write("a".repeat(99));
    renameSync(dir, `${dir}-moved`);
    mkdirSync(dir);
    writeFileSync(file, "the new home's log\n");
    for (let i = 0; i < 5; i++) write("b".repeat(99));
    expect(readFileSync(file, "utf8")).toBe("the new home's log\n");
    expect(existsSync(`${file}.1`)).toBe(false);
    const moved = readFileSync(join(`${dir}-moved`, "saveslot.log"), "utf8");
    expect(moved.split("\n").filter((l) => l !== "")).toHaveLength(6);
    expect(existsSync(join(`${dir}-moved`, "saveslot.log.1"))).toBe(false);
  });
});
