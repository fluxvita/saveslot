// The check of the code's references to the specification (./check-spec-refs.ts): what names a
// file, what counts as a title, and that a reference with no such title is reported.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkSpecRefs, filesNamed, refsIn, titlesIn } from "./check-spec-refs.ts";

const dirs: string[] = [];
afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

function tree(files: Record<string, string>): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-spec-refs-"));
  dirs.push(root);
  for (const [path, body] of Object.entries(files)) {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  }
  return root;
}

const SPEC = {
  "docs/zh-CN/spec/02-architecture.md": "# 架构\n\n## 5. 服务层\n\n| 句柄 | 签发 |\n",
  "docs/zh-CN/spec/07-scope-v1.md": "# 范围\n\n## 2. 取舍原则\n",
  "docs/zh-CN/spec/03-data-model/05-time.md":
    "# 时间\n\n### 状态机：读永远不停\n\n#### 版本标记 `ver`\n\n- **挡点**：一处。\n- **① 回退记录**\n\n```\n## 不是标题\n```\n",
  "docs/zh-CN/spec/03-data-model/07-schema-evolution.md":
    "## 改动分类与迁移手段\n\n#### 引用字段（`ref`）\n",
};
const FILES = Object.keys(SPEC);

describe("spec references", () => {
  it("takes headings, bold items and table row names as titles, in their short forms too", () => {
    const t = titlesIn(SPEC["docs/zh-CN/spec/03-data-model/05-time.md"]);
    expect([...t].sort()).toEqual(
      [
        "时间",
        "状态机：读永远不停",
        "状态机",
        "版本标记 ver",
        "版本标记",
        "挡点",
        "回退记录",
      ].sort(),
    );
    expect(titlesIn(SPEC["docs/zh-CN/spec/02-architecture.md"]).has("句柄")).toBe(true);
    expect(titlesIn(SPEC["docs/zh-CN/spec/02-architecture.md"]).has("服务层")).toBe(true);
    expect(
      titlesIn(SPEC["docs/zh-CN/spec/03-data-model/07-schema-evolution.md"]).has("引用字段"),
    ).toBe(true);
  });

  it("names files by number, by name with or without the number, and by the directory", () => {
    expect(filesNamed("07", FILES)).toEqual([
      "docs/zh-CN/spec/07-scope-v1.md",
      "docs/zh-CN/spec/03-data-model/07-schema-evolution.md",
    ]);
    expect(filesNamed("05-time.md", FILES)).toEqual(["docs/zh-CN/spec/03-data-model/05-time.md"]);
    expect(filesNamed("schema-evolution", FILES)).toEqual([
      "docs/zh-CN/spec/03-data-model/07-schema-evolution.md",
    ]);
    expect(filesNamed("data-model", FILES)).toHaveLength(2);
    expect(filesNamed("write-pipeline", FILES)).toEqual([]);
  });

  it("gives a reference the last file named before it, on its line or earlier in its comment", () => {
    const refs = refsIn(
      [
        "// The points (05-time «挡点», «状态机»; 02-architecture §5",
        "// «句柄»), with K12 and §11 between: «服务层».",
        "const a = 1; // «挡点»",
        'it("a title (07 «改动分类与迁移手段»)", () => {});',
      ].join("\n"),
      FILES,
    );
    expect(refs.map((r) => [r.ref, r.named.map((f) => f.split("/").at(-1))])).toEqual([
      ["挡点", ["05-time.md"]],
      ["状态机", ["05-time.md"]],
      ["句柄", ["02-architecture.md"]],
      ["服务层", ["02-architecture.md"]],
      ["挡点", []],
      ["改动分类与迁移手段", ["07-scope-v1.md", "07-schema-evolution.md"]],
    ]);
  });

  it("passes references that name a title of the named file, `A · B` by both", () => {
    const root = tree({
      ...SPEC,
      "packages/a/src/x.ts":
        "// 05-time «挡点», «状态机 · 挡点»; 07 «改动分类与迁移手段».\nexport const a = 1; // «句柄» of any file\n",
      "packages/a/src/golden/y.ts": "// 05-time «没有»\n",
      "packages/a/node_modules/z.ts": "// 05-time «没有»\n",
    });
    expect(checkSpecRefs(root)).toEqual({ problems: [], refs: 4, files: 1 });
  });

  it("reports a title the named file does not have, one no file has, and a shortened one", () => {
    const root = tree({
      ...SPEC,
      "packages/a/src/x.ts": "// 05-time «句柄»\n// «不存在»\n",
      "scripts/y.ts": "// 07 «改动分类»\n",
    });
    expect(
      checkSpecRefs(root).problems.map((p) => `${p.file}:${p.line} ${p.ref}: ${p.reason}`),
    ).toEqual([
      "packages/a/src/x.ts:1 句柄: no heading or bold item «句柄» in docs/zh-CN/spec/03-data-model/05-time.md",
      "packages/a/src/x.ts:2 不存在: no heading or bold item «不存在» in docs/zh-CN/spec/03-data-model/05-time.md",
      "scripts/y.ts:1 改动分类: no heading or bold item «改动分类» in docs/zh-CN/spec/03-data-model/07-schema-evolution.md or docs/zh-CN/spec/07-scope-v1.md",
    ]);
  });

  it("takes a whole name for that file alone, and a name cut short only when one file starts with it", () => {
    const files = [
      ...FILES,
      "docs/zh-CN/spec/04-contract.md",
      "docs/zh-CN/spec/04-contract-types.md",
      "docs/zh-CN/spec/03-data-model/02-integrity-and-records.md",
    ];
    expect(filesNamed("04-contract", files)).toEqual(["docs/zh-CN/spec/04-contract.md"]);
    expect(filesNamed("contract", files)).toEqual(["docs/zh-CN/spec/04-contract.md"]);
    expect(filesNamed("04-contract-types.md", files)).toEqual([
      "docs/zh-CN/spec/04-contract-types.md",
    ]);
    expect(filesNamed("02-integrity", files)).toEqual([
      "docs/zh-CN/spec/03-data-model/02-integrity-and-records.md",
    ]);
    // Two files start with it: it names neither.
    expect(filesNamed("07-sc", files)).toEqual([]);
    expect(filesNamed("07-s", files)).toEqual([]);

    const root = tree({
      ...SPEC,
      "docs/zh-CN/spec/04-contract.md": "# 契约\n\n- **值的编码**：一处。\n",
      "docs/zh-CN/spec/04-contract-types.md": "# 类型\n\n| 概况 | 行数 |\n",
      "packages/a/src/x.ts":
        "// 04-contract «值的编码»; 04-contract-types «概况».\n// 04-contract «概况»\n",
    });
    expect(checkSpecRefs(root).problems.map((p) => `${p.line} ${p.reason}`)).toEqual([
      "2 no heading or bold item «概况» in docs/zh-CN/spec/04-contract.md",
    ]);
  });

  it("reports a name that starts with a file's number and is no file, and looks in no other file", () => {
    const root = tree({
      ...SPEC,
      "packages/a/src/x.ts": [
        "// 05-time «挡点»; 05-tiem «挡点», and «状态机» after it.",
        "// 99 §2 «挡点»",
        "const a = 1; // Until 11-05 nothing changes; 24 of them: «挡点».",
      ].join("\n"),
    });
    expect(checkSpecRefs(root).problems.map((p) => `${p.line} ${p.reason}`)).toEqual([
      "1 «挡点» is said to be in 05-tiem, which is no file of the specification",
      "1 «状态机» is said to be in 05-tiem, which is no file of the specification",
      "2 «挡点» is said to be in 99, which is no file of the specification",
    ]);
  });

  it("passes on the repository", () => {
    expect(checkSpecRefs(join(import.meta.dirname, "..")).problems).toEqual([]);
  });
});
