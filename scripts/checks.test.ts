// Tests for the repository check scripts: each check must fail on the inputs it exists to catch.

import { execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { dcoProblem } from "./check-dco.ts";
import { checkDocLinks, headingAnchors, slugify } from "./check-doc-links.ts";
import { checkJsonExamples, parseError } from "./check-json-examples.ts";

const REPO = resolve(import.meta.dirname, "..");
const dirs: string[] = [];

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-checks-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

describe("doc links", () => {
  it("slugs headings the way GitHub does, including CJK text", () => {
    expect(slugify("8. 存储抽象")).toBe("8-存储抽象");
    expect(slugify("`ops` 的调用上下文")).toBe("ops-的调用上下文");
    expect([...headingAnchors("# A\n## A\n```\n# not a heading\n```\n")]).toEqual(["a", "a-1"]);
  });

  it("reports missing files and missing anchors, and ignores code and external links", () => {
    const root = tree({
      "a.md": [
        "[ok](b.md) [ok anchor](b.md#2-存储格式-v1) [self](#top)",
        "[missing](nope.md) [bad anchor](b.md#no-such) [outside](../x.md)",
        "`[in code](nope2.md)` [ext](https://example.com/nope.md)",
        "```",
        "[in fence](nope3.md)",
        "```",
        "# Top",
      ].join("\n"),
      "b.md": "## 2. 存储格式 v1\n",
    });
    const problems = checkDocLinks(root).map((p) => `${p.line}:${p.target}:${p.reason}`);
    expect(problems).toEqual([
      "2:nope.md:file does not exist",
      "2:b.md#no-such:no heading with this anchor",
      "2:../x.md:points outside the repository",
    ]);
  });
});

describe("JSON examples", () => {
  it("accepts JSON values and member fragments, rejects anything else", () => {
    expect(parseError('{"a": [1, 2]}')).toBeUndefined();
    expect(parseError('"deps": [{"event": 15}]')).toBeUndefined();
    expect(parseError('{ "name": "x", … }')).toBeDefined();
    expect(parseError('targets/0  {"a": 1}')).toBeDefined();
    expect(parseError("{'a': 1}")).toBeDefined();
  });

  it("checks only json blocks and reports their first content line", () => {
    const root = tree({
      "a.md": '```json\n{"ok": 1}\n```\n\n```text\nnot json\n```\n\n```json\n{bad}\n```\n',
    });
    const { problems, blocks } = checkJsonExamples(root);
    expect(blocks).toBe(2);
    expect(problems.map((p) => p.line)).toEqual([10]);
  });
});

describe("DCO", () => {
  const commit = (message: string) => ({
    sha: "0",
    authorName: "A",
    authorEmail: "a@example.com",
    message,
  });

  it("requires a sign-off by the author", () => {
    expect(dcoProblem(commit("feat: x\n\nSigned-off-by: A <a@example.com>\n"))).toBeUndefined();
    expect(dcoProblem(commit("feat: x\n"))).toBe("missing Signed-off-by");
    expect(dcoProblem(commit("feat: x\n\nSigned-off-by: B <b@example.com>\n"))).toMatch(
      /from the author/,
    );
  });
});

describe("dependency rules", () => {
  function violations(files: Record<string, string>, links: Record<string, string> = {}): string[] {
    const root = tree(files);
    for (const [link, target] of Object.entries(links)) {
      mkdirSync(dirname(join(root, link)), { recursive: true });
      symlinkSync(target, join(root, link));
    }
    let out: string;
    try {
      out = execFileSync(
        join(REPO, "node_modules/.bin/depcruise"),
        ["packages", "--config", join(REPO, ".dependency-cruiser.cjs"), "--output-type", "json"],
        { cwd: root, encoding: "utf8" },
      );
    } catch (e) {
      out = (e as { stdout: string }).stdout;
    }
    const result = JSON.parse(out) as {
      summary: { violations: { rule: { name: string }; from: string; to: string }[] };
    };
    return result.summary.violations.map((v) => `${v.rule.name}: ${v.from} -> ${v.to}`).sort();
  }

  it("passes allowed edges", () => {
    expect(
      violations({
        "packages/contract-core/src/index.ts": "export const c = 1;\n",
        "packages/kernel/src/time/t.ts": "export const t = 1;\n",
        "packages/kernel/src/judge/j.ts":
          'import { t } from "../time/t.ts";\nexport const j = t;\n',
        "packages/kernel/src/index.ts":
          'import "../../contract-core/src/index.ts";\nimport "./judge/j.ts";\n',
      }),
    ).toEqual([]);
  });

  it("rejects upward package edges, kernel module edges outside §4, unknown modules and transports", () => {
    expect(
      violations({
        "packages/service/src/index.ts": "export const s = 1;\n",
        "packages/contract/src/index.ts": "export const c = 1;\n",
        "packages/kernel/src/write/w.ts": "export const w = 1;\n",
        "packages/kernel/src/misc/m.ts": "export const m = 1;\n",
        "packages/kernel/src/judge/j.ts": [
          'import "../write/w.ts";',
          'import "../misc/m.ts";',
          'import "node:http";',
          "export const j = 1;",
        ].join("\n"),
        "packages/kernel/src/index.ts": [
          'import "../../service/src/index.ts";',
          'import "./judge/j.ts";',
        ].join("\n"),
        "packages/contract-core/src/index.ts": 'import "../../contract/src/index.ts";\n',
      }),
    ).toEqual([
      "kernel-module-judge: packages/kernel/src/judge/j.ts -> packages/kernel/src/misc/m.ts",
      "kernel-module-judge: packages/kernel/src/judge/j.ts -> packages/kernel/src/write/w.ts",
      "kernel-no-transport: packages/kernel/src/judge/j.ts -> http",
      "kernel-unknown-module: packages/kernel/src/judge/j.ts -> packages/kernel/src/misc/m.ts",
      "package-contract-core: packages/contract-core/src/index.ts -> packages/contract/src/index.ts",
      "package-kernel: packages/kernel/src/index.ts -> packages/service/src/index.ts",
    ]);
  });

  it("rejects a kernel module reaching another module through a file at the kernel/src root", () => {
    expect(
      violations({
        "packages/kernel/src/write/w.ts": "export const w = 1;\n",
        "packages/kernel/src/barrel.ts": 'export { w } from "./write/w.ts";\n',
        "packages/kernel/src/judge/j.ts":
          'import { w } from "../barrel.ts";\nexport const j = w;\n',
      }),
    ).toEqual([
      "kernel-module-no-root: packages/kernel/src/judge/j.ts -> packages/kernel/src/barrel.ts",
    ]);
  });

  it("rejects the same bypass through the kernel's own package name", () => {
    const kernelPkg = JSON.stringify({
      name: "@fluxvita/saveslot-kernel",
      type: "module",
      exports: { ".": { source: "./src/index.ts", default: "./dist/index.js" } },
    });
    expect(
      violations(
        {
          "packages/kernel/package.json": kernelPkg,
          "packages/kernel/src/write/w.ts": "export const w = 1;\n",
          "packages/kernel/src/index.ts": 'export { w } from "./write/w.ts";\n',
          "packages/kernel/src/judge/j.ts":
            'import { w } from "@fluxvita/saveslot-kernel";\nexport const j = w;\n',
        },
        { "node_modules/@fluxvita/saveslot-kernel": "../../packages/kernel" },
      ),
    ).toContain(
      "kernel-module-no-root: packages/kernel/src/judge/j.ts -> packages/kernel/src/index.ts",
    );
  });
});
