// Tests for the build step that makes the built `bin` entries runnable, and for the entry's source.

import { mkdirSync, mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { markBins, SHEBANG } from "./mark-bins.ts";

const REPO = resolve(import.meta.dirname, "..");
const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-bins-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body, { mode: 0o644 });
  }
  return root;
}

const executable = (path: string): boolean => (statSync(path).mode & 0o111) === 0o111;

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("the saveslot entry", () => {
  it("its source begins with the shebang, which tsc keeps in the built file", () => {
    const source = readFileSync(join(REPO, "packages/saveslot/src/bin.ts"), "utf8");
    expect(source.startsWith(SHEBANG)).toBe(true);
  });

  it("the package's bin is the built entry the build step marks", () => {
    const pkg = JSON.parse(readFileSync(join(REPO, "packages/saveslot/package.json"), "utf8")) as {
      bin?: unknown;
    };
    expect(pkg.bin).toEqual({ saveslot: "./dist/bin.js" });
  });
});

describe("marking the built bin entries", () => {
  it("makes each entry executable, in both forms of `bin`; other files stay as they are", () => {
    const root = tree({
      "packages/a/package.json": JSON.stringify({ bin: { a: "./dist/bin.js", a2: "dist/two.js" } }),
      "packages/a/dist/bin.js": `${SHEBANG}console.log(1);\n`,
      "packages/a/dist/two.js": `${SHEBANG}console.log(2);\n`,
      "packages/a/dist/index.js": "export {};\n",
      "packages/b/package.json": JSON.stringify({ bin: "./dist/cli.js" }),
      "packages/b/dist/cli.js": `${SHEBANG}console.log(3);\n`,
      "packages/c/package.json": JSON.stringify({ name: "no-bin" }),
      "packages/c/dist/bin.js": "export {};\n",
    });
    expect(markBins(root)).toEqual([]);
    expect(executable(join(root, "packages/a/dist/bin.js"))).toBe(true);
    expect(executable(join(root, "packages/a/dist/two.js"))).toBe(true);
    expect(executable(join(root, "packages/b/dist/cli.js"))).toBe(true);
    expect(executable(join(root, "packages/a/dist/index.js"))).toBe(false);
    expect(executable(join(root, "packages/c/dist/bin.js"))).toBe(false);
  });

  it("an entry without the shebang is a problem, and is not made executable", () => {
    const root = tree({
      "packages/a/package.json": JSON.stringify({ bin: { a: "./dist/bin.js" } }),
      "packages/a/dist/bin.js": "// The executable.\nconsole.log(1);\n",
    });
    expect(markBins(root)).toEqual([
      `packages/a/dist/bin.js: does not begin with ${JSON.stringify(SHEBANG)}`,
    ]);
    expect(executable(join(root, "packages/a/dist/bin.js"))).toBe(false);
  });

  it("an entry that was not built is a problem", () => {
    const root = tree({
      "packages/a/package.json": JSON.stringify({ bin: { a: "./dist/bin.js" } }),
    });
    expect(markBins(root)).toEqual(["packages/a/dist/bin.js: no such file"]);
  });

  it("a directory under packages without a package.json is passed over", () => {
    const root = tree({ "packages/notes/README.md": "x\n" });
    expect(markBins(root)).toEqual([]);
  });
});
