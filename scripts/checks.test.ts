// Tests for the repository check scripts: each check must fail on the inputs it exists to catch.

import { execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { checkClaims, claimRows, testCases } from "./check-claims.ts";
import { dcoProblem } from "./check-dco.ts";
import { checkDocLinks, headingAnchors, slugify } from "./check-doc-links.ts";
import {
  decodeTerms,
  formatHit,
  scan,
  termMatcher,
  trackedFiles,
} from "./check-forbidden-terms.ts";
import { checkJsonExamples, parseError } from "./check-json-examples.ts";
import { titleProblem } from "./check-mr-title.ts";
import {
  checkTranslations,
  lastChange,
  missingEnglish,
  NOT_YET,
  sourceLine,
  sourceOf,
} from "./check-translations.ts";
import { ciEnv } from "./ci-env.ts";
import { listMarkdownFiles } from "./markdown.ts";

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

describe("English documents", () => {
  const SRC =
    "Translated from docs/zh-CN/guide/01-what.md, updated in the same commit as this file.";

  it("checks links within the English tree, to the Chinese tree, and English heading anchors", () => {
    const root = tree({
      "docs/zh-CN/guide/01-what.md": "# 1. 它是什么\n## 1.1 一条日志\n",
      "docs/zh-CN/guide/02-how.md": "# 2. 怎么用\n",
      "docs/zh-CN/spec/02-architecture.md": "## 格式版本、导出导入与恢复\n",
      "docs/guide/01-what.md": [
        "# 1. What it is",
        "",
        `> ${SRC}`,
        "## 1.1 One log per user, the `ver` of a row",
        "[self](#11-one-log-per-user-the-ver-of-a-row) [ok](#1-what-it-is) [bad](#11-一条日志)",
        "[untranslated](../zh-CN/guide/02-how.md) [zh anchor](../zh-CN/guide/01-what.md#11-一条日志)",
        "[spec](../zh-CN/spec/02-architecture.md#格式版本导出导入与恢复)",
        "[missing](02-how.md) [en spec](../spec/02-architecture.md#format-versions)",
        "```json",
        '{"ok": true}',
        "```",
        "```json",
        "{bad}",
        "```",
      ].join("\n"),
    });
    const problems = checkDocLinks(root).map((p) => `${p.file}:${p.line}:${p.target}:${p.reason}`);
    expect(problems).toEqual([
      "docs/guide/01-what.md:5:#11-一条日志:no heading with this anchor",
      "docs/guide/01-what.md:8:02-how.md:file does not exist",
      "docs/guide/01-what.md:8:../spec/02-architecture.md#format-versions:file does not exist",
    ]);
    const { problems: json, blocks } = checkJsonExamples(root);
    expect(blocks).toBe(2);
    expect(json.map((p) => `${p.file}:${p.line}`)).toEqual(["docs/guide/01-what.md:13"]);
  });

  it("requires each English spec and guide file to name its Chinese source near the top", () => {
    expect(sourceOf(`# T\n\n<!-- ${SRC} -->\n`)).toBe("docs/zh-CN/guide/01-what.md");
    expect(
      sourceOf(
        "# T\n\nTranslated from `docs/zh-CN/a.md`, updated in the same commit as this file.",
      ),
    ).toBe("docs/zh-CN/a.md");
    expect(sourceOf("# T\nTranslated from 535b4e4b of docs/zh-CN/a.md")).toBe("old");
    expect(sourceOf("# T\nTranslated from docs/zh-CN/a.md")).toBeUndefined(); // the sentence is cut
    expect(sourceOf(`${"\n".repeat(6)}${SRC}`)).toBeUndefined(); // too far down
    const root = tree({
      "docs/zh-CN/guide/01-what.md": "# 1\n",
      "docs/zh-CN/guide/02-how.md": "# 2\n",
      "docs/zh-CN/guide/04-old.md": "# 4\n",
      "docs/zh-CN/spec/02-architecture.md": "# 2\n",
      "docs/guide/01-what.md": `# 1\n\n> ${SRC}\n> The Chinese edition has changed since: section 1.2.\n`,
      "docs/guide/02-how.md": "# 2\n\nNo source line.\n",
      "docs/guide/03-gone.md":
        "# 3\n\nTranslated from docs/zh-CN/guide/03-gone.md, updated in the same commit as this file.\n",
      "docs/guide/04-old.md": "# 4\n\nTranslated from 535b4e4b of docs/zh-CN/guide/04-old.md\n",
      "docs/spec/02-architecture.md":
        "# 2\n\nTranslated from docs/zh-CN/spec/09-other.md, updated in the same commit as this file.\n",
      "docs/README.md": "# Not a translation\n",
      "README.md": "# Not a translation\n",
    });
    expect(checkTranslations(root).problems.map((p) => `${p.file}: ${p.reason}`)).toEqual([
      `docs/guide/02-how.md: no "${sourceLine("docs/zh-CN/guide/02-how.md")}" in its first 6 lines`,
      "docs/guide/03-gone.md: its source docs/zh-CN/guide/03-gone.md does not exist",
      `docs/guide/04-old.md: names a commit, which squash merges lose; write "${sourceLine("docs/zh-CN/guide/04-old.md")}"`,
      "docs/spec/02-architecture.md: says it is translated from docs/zh-CN/spec/09-other.md, expected docs/zh-CN/spec/02-architecture.md",
    ]);
  });

  it("lists a translation the Chinese file has moved past as drift, not as a problem", () => {
    const zh = "docs/zh-CN/guide/01-what.md";
    const en = "docs/guide/01-what.md";
    const root = tree({ [zh]: "# 1\n", [en]: `# 1\n\n> ${SRC}\n` });
    const at: Record<string, number> = { [zh]: 2_000_000_000, [en]: 1_999_000_000 };
    const { problems, drift } = checkTranslations(root, undefined, (f) => at[f]);
    expect(problems).toEqual([]);
    expect(drift.map((p) => p.reason)).toEqual([
      `${zh} changed after it (2033-05-18, translation 2033-05-06); update it, or add "The Chinese edition has changed since: …" under the source line`,
    ]);
    writeFileSync(
      join(root, en),
      `# 1\n\n> ${SRC}\n> The Chinese edition has changed since: 1.2.\n`,
    );
    expect(checkTranslations(root, undefined, (f) => at[f]).drift).toEqual([]);
    expect(checkTranslations(root, undefined, () => undefined).drift).toEqual([]); // outside git
  });

  it("requires an English file for each Chinese document, outside the directories not due yet", () => {
    const root = tree({
      "docs/zh-CN/guide/01-what.md": "# 1\n",
      "docs/zh-CN/guide/02-how.md": "# 2\n",
      "docs/zh-CN/spec/03-data-model/01-objects.md": "# 3.1\n",
      "docs/zh-CN/process/decisions/a.md": "# a\n",
      "docs/zh-CN/research/b.md": "# b\n",
      "docs/guide/01-what.md": `# 1\n\n> ${SRC}\n`,
    });
    expect(missingEnglish(root, listMarkdownFiles(root))).toEqual([
      { file: "docs/zh-CN/guide/02-how.md", reason: "no English edition (docs/guide/02-how.md)" },
      {
        file: "docs/zh-CN/spec/03-data-model/01-objects.md",
        reason: "no English edition (docs/spec/03-data-model/01-objects.md)",
      },
    ]);
    // Each exception says why and until when.
    for (const n of NOT_YET) expect(n.why.length > 0 && n.until.length > 0).toBe(true);
  });

  it("dates files by their last commit", () => {
    const root = tree({ "docs/zh-CN/guide/01-what.md": "# 1\n" });
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    expect(lastChange(root, "docs/zh-CN/guide/01-what.md")).toBeUndefined(); // not a repository
    git("init", "-q");
    git("add", ".");
    git(
      "-c",
      "user.name=t",
      "-c",
      "user.email=t@example.com",
      "commit",
      "-qm",
      "a",
      "--date=@1800000000",
    );
    expect(lastChange(root, "docs/zh-CN/guide/01-what.md")).toBeGreaterThan(0);
    expect(lastChange(root, "docs/guide/01-what.md")).toBeUndefined(); // never committed
  });

  it("passes on the repository as it is", () => {
    expect(checkTranslations(REPO).problems).toEqual([]);
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

describe("claims index", () => {
  const TEST = [
    'describe("outer", () => {',
    '  it("holds", () => {});',
    '  it.each([1, 2])("case %s", () => {});',
    '  it.skip("skipped", () => {});',
    '  it.todo("to do");',
    '  describe.skip("off", () => {',
    '    it("inside", () => {});',
    "  });",
    '  describe.skipIf(process.env.X === undefined)("with a server", () => {',
    '    it("needs it", () => {});',
    "  });",
    // biome-ignore lint/suspicious/noTemplateCurlyInString: a test file's source, as text
    "  it(`a ${1} template`, () => {});",
    "});",
    'it("holds", () => {});',
    'const title = "not a case"; call("neither");',
  ].join("\n");
  const HEAD = "| 编号 | 断言 | 预言 | 测试 | 状态 |\n|---|---|---|---|---|\n";
  const index = (...rows: string[]) => ({
    "docs/zh-CN/spec/11-claims.md": `# Claims\n\n${HEAD}${rows.join("\n")}\n`,
    "docs/zh-CN/spec/a.md": "# A\n",
    "p/x.test.ts": TEST,
  });
  const reasons = (root: string) => checkClaims(root).problems.map((p) => `${p.id}: ${p.reason}`);

  it("reads a test file's cases: titles with their blocks, each's, skips and conditions", () => {
    expect(
      testCases(TEST).map(
        (c) => `${c.skipped ? "S " : ""}${c.conditional ? "C " : ""}${c.chain.join(" › ")}`,
      ),
    ).toEqual([
      "outer › holds",
      "outer › case %s",
      "S outer › skipped",
      "S outer › to do",
      "S outer › off › inside",
      "C outer › with a server › needs it",
      // biome-ignore lint/suspicious/noTemplateCurlyInString: the title as the source has it
      "outer › a ${1} template",
      "holds",
    ]);
  });

  it("reads rows by the header's columns, test references from code spans, an escaped pipe", () => {
    const [row] = claimRows(
      `${HEAD}| J1 | a [claim](a.md) | compares x \\| y | \`p/x.test.ts\` › \`outer\` › \`holds\`<br>\`p/y.test.ts\` › \`other\` | 成立 | \`kernel\` |\n\n| not | a | claims | table |\n|---|---|---|---|\n| 1 | 2 | 3 | 4 |\n`,
    );
    expect(row).toMatchObject({
      line: 3,
      id: "J1",
      oracle: "compares x | y",
      status: "成立",
      tests: [
        { file: "p/x.test.ts", chain: ["outer", "holds"] },
        { file: "p/y.test.ts", chain: ["other"] },
      ],
    });
    expect(claimRows(`${HEAD}| J1 | c | o | — | 无测试 |\n\ntext\n| a | b |\n`)).toHaveLength(1);
  });

  it("passes rows whose tests exist and run, a conditional one counted", () => {
    const root = tree(
      index(
        "| A1 | [c](a.md) | o | `p/x.test.ts` › `outer` › `holds`<br>`p/x.test.ts` › `case %s` | 成立 |",
        "| A2 | [c](a.md) | o | `p/x.test.ts` › `needs it` | 部分有测试 |",
        "| A3 | [c](a.md) | o | — | 无测试 |",
      ),
    );
    expect(checkClaims(root)).toEqual({ problems: [], rows: 3, tests: 3, conditional: 1 });
  });

  it("fails a test that is missing, skipped or unnamed, and a file that is missing", () => {
    const root = tree(
      index(
        "| B1 | [c](a.md) | o | `p/x.test.ts` › `no such case` | 成立 |",
        "| B2 | [c](a.md) | o | `p/x.test.ts` › `skipped` | 成立 |",
        "| B3 | [c](a.md) | o | `p/x.test.ts` › `off` › `inside` | 成立 |",
        "| B4 | [c](a.md) | o | `p/x.test.ts` › `to do` | 成立 |",
        "| B5 | [c](a.md) | o | `p/gone.test.ts` › `holds` | 成立 |",
        "| B6 | [c](a.md) | o | `p/x.test.ts` | 成立 |",
        "| B7 | [c](a.md) | o | `p/x.test.ts` › `inner` › `holds` | 成立 |",
        "| B8 | [c](a.md) | o | `holds` | 成立 |",
      ),
    );
    expect(reasons(root)).toEqual([
      'B1: p/x.test.ts: no case titled "no such case"',
      'B2: p/x.test.ts: "skipped" is skipped',
      'B3: p/x.test.ts: "off › inside" is skipped',
      'B4: p/x.test.ts: "to do" is skipped',
      "B5: p/gone.test.ts: file does not exist",
      "B6: p/x.test.ts: no case named; write the case's title after the file",
      'B7: p/x.test.ts: no case titled "inner › holds"',
      'B8: status "成立" needs a test reference; a row with no test is 无测试',
      'B8: title "holds" comes before any test file',
    ]);
  });

  it("fails a row without an id, a link, an oracle or a known status, and a status against its tests", () => {
    const root = tree(
      index(
        "| C1 | no link | o | `p/x.test.ts` › `holds` | 成立 |",
        "| C1 | [c](a.md) |  | `p/x.test.ts` › `holds` | holds |",
        "|  | [c](a.md) | o | — | 成立 |",
        "| C4 | [c](a.md) | o | `p/x.test.ts` › `holds` | 无测试 |",
      ),
    );
    expect(reasons(root)).toEqual([
      "C1: the claim does not link to where the spec states it",
      "C1: the id is used by an earlier row",
      "C1: no oracle",
      'C1: status "holds" is not one of: 成立, 部分有测试, 已知不成立, 无测试',
      ": no id",
      ': status "成立" needs a test reference; a row with no test is 无测试',
      "C4: status 无测试 on a row that names a test",
    ]);
  });

  it("fails an index with no rows, and passes the repository's own", () => {
    const root = tree({ "docs/zh-CN/spec/11-claims.md": "# Claims\n\nNo table yet.\n" });
    expect(reasons(root)).toEqual([": no claim rows found"]);
    const own = checkClaims(REPO);
    expect(own.problems).toEqual([]);
    expect(own.rows).toBeGreaterThan(20);
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

describe("MR title", () => {
  it("accepts Conventional Commits, with or without a scope or a breaking-change mark", () => {
    for (const t of [
      "feat(store-pglite): add the DB Worker backend",
      "fix: trace the writer itself",
      "docs(spec)!: rename a block",
      "Draft: test(reference): cover D.5",
    ]) {
      expect(titleProblem(t), t).toBeUndefined();
    }
  });

  it("rejects other titles", () => {
    for (const t of [
      "Add the DB Worker backend",
      "feature: x",
      "Feat: x",
      "feat(Kernel): x",
      "feat(): x",
      "feat:x",
      "feat: ",
      "feat(kernel) x",
      " feat: x",
      "",
    ]) {
      expect(titleProblem(t), JSON.stringify(t)).toBeDefined();
    }
  });
});

describe("forbidden terms", () => {
  // A made-up list; the real one is never part of the repository.
  const FAKE = ["Zorblax", "Quux Widget", "紫色河马"];
  const b64 = (terms: string[]) => Buffer.from(terms.join("\n")).toString("base64");

  function repo(files: Record<string, string | Buffer>): string {
    const root = mkdtempSync(join(tmpdir(), "saveslot-terms-"));
    dirs.push(root);
    for (const [path, body] of Object.entries(files)) {
      mkdirSync(dirname(join(root, path)), { recursive: true });
      writeFileSync(join(root, path), body);
    }
    const git = (...args: string[]) => execFileSync("git", args, { cwd: root, stdio: "pipe" });
    git("init", "-q");
    git("add", "-A");
    return root;
  }

  it("decodes newline-separated terms, ignoring blank lines and spaces", () => {
    expect(decodeTerms(Buffer.from(" a \r\n\nb c\n").toString("base64"))).toEqual(["a", "b c"]);
  });

  it("matches case-insensitively at word boundaries, and CJK terms inside CJK text", () => {
    const m = termMatcher("Zorblax");
    expect(m.test("see ZORBLAX here")).toBe(true);
    expect(m.test("zorblax.")).toBe(true);
    expect(m.test("Zorblaxes")).toBe(false);
    expect(m.test("myZorblax")).toBe(false);
    expect(termMatcher("Quux Widget").test("a quux  widget b")).toBe(true);
    expect(termMatcher("紫色河马").test("这是紫色河马的说明")).toBe(true);
    expect(termMatcher("a.b").test("axb")).toBe(false);
  });

  it("reports terms in contents, file names, commit messages and the title, by index", () => {
    const root = repo({
      "docs/a.md": "line one\nmentions zorblax here\n",
      "zorblax-notes.txt": "clean\n",
      "src/b.ts": "// 紫色河马\nconst quux = 1;\n",
      "img.bin": Buffer.from([0, 1, 2, 0x5a, 0x6f, 0x72, 0x62, 0x6c, 0x61, 0x78]),
    });
    const hits = scan({
      root,
      files: trackedFiles(root),
      terms: FAKE,
      commits: [{ sha: "abcdef0123456789", message: "feat: x\n\nabout Quux Widget\n" }],
      title: "fix: zorblax",
    }).map(formatHit);
    expect(hits.sort()).toEqual(
      [
        "docs/a.md:2: forbidden term #1",
        "zorblax-notes.txt (file name): forbidden term #1",
        "src/b.ts:1: forbidden term #3",
        "commit abcdef012345:3: forbidden term #2",
        "MR title: forbidden term #1",
      ].sort(),
    );
  });

  it("reports ruling-number references in packages and the spec, not elsewhere", () => {
    const root = repo({
      "packages/kernel/src/x.ts": "// see R204\n",
      "docs/zh-CN/spec/a.md": "按 R112 处理\n",
      "docs/zh-CN/process/b.md": "R204 is fine here\n",
      // Two digits, a leading zero, or inside a word: not a ruling number.
      "packages/kernel/src/y.ts": "const R20 = 1; // XR204 R042\n",
      // Any number from R100 up: R461 and R1000 as much as R204.
      "packages/kernel/src/z.test.ts": 'it("a fate (R461 ①)", () => {});\n',
      "docs/zh-CN/guide/c.md": "见 R1000\n",
    });
    const hits = scan({ root, files: trackedFiles(root), terms: [] }).map(formatHit);
    expect(hits.sort()).toEqual(
      [
        "docs/zh-CN/guide/c.md:1: ruling-number reference (cite the spec section instead)",
        "docs/zh-CN/spec/a.md:1: ruling-number reference (cite the spec section instead)",
        "packages/kernel/src/x.ts:1: ruling-number reference (cite the spec section instead)",
        "packages/kernel/src/z.test.ts:1: ruling-number reference (cite the spec section instead)",
      ].sort(),
    );
  });

  const SCRIPT = join(REPO, "scripts/check-forbidden-terms.ts");
  function run(root: string, env: Record<string, string>) {
    const clean = Object.fromEntries(
      Object.entries(process.env).filter(
        ([k]) =>
          !k.startsWith("CI_") &&
          !k.startsWith("SAVESLOT_CI_") &&
          k !== "SAVESLOT_FORBIDDEN_TERMS_B64",
      ),
    );
    const r = spawnSync("node", ["--no-warnings", SCRIPT], {
      cwd: root,
      env: { ...clean, ...env },
      encoding: "utf8",
    });
    return { code: r.status, output: `${r.stdout}${r.stderr}` };
  }

  it("fails on a hit and never prints a term or the encoded list", () => {
    const root = repo({ "a.md": "one Quux Widget, one 紫色河马\n" });
    const encoded = b64(FAKE);
    const r = run(root, { SAVESLOT_FORBIDDEN_TERMS_B64: encoded });
    expect(r.code).toBe(1);
    expect(r.output).toContain("a.md:1: forbidden term #2");
    expect(r.output).toContain("a.md:1: forbidden term #3");
    for (const secret of [...FAKE, encoded, ...FAKE.map((t) => t.toLowerCase())]) {
      expect(r.output).not.toContain(secret);
    }
    expect(r.output.toLowerCase()).not.toMatch(/zorblax|quux|widget|河马/);
  });

  it("passes a clean tree", () => {
    const root = repo({ "a.md": "nothing to see\n" });
    const r = run(root, { SAVESLOT_FORBIDDEN_TERMS_B64: b64(FAKE) });
    expect(r.code).toBe(0);
    expect(r.output).toContain("Forbidden terms OK: 3 term(s)");
  });

  it("without the list: fails where the workflow says it is required, warns elsewhere (a fork)", () => {
    const root = repo({ "a.md": "nothing to see\n" });
    expect(run(root, { SAVESLOT_CI_TERMS_REQUIRED: "true" }).code).toBe(1);
    const fork = run(root, { SAVESLOT_CI_TERMS_REQUIRED: "false" });
    expect(fork.code).toBe(0);
    expect(fork.output).toMatch(/Warning: SAVESLOT_FORBIDDEN_TERMS_B64 is not set/);
  });
});

describe("the CI run's variables", () => {
  it("the base, the title, and whether the list is required", () => {
    expect(
      ciEnv({
        SAVESLOT_CI_BASE: "def",
        SAVESLOT_CI_TITLE: "docs: y",
        SAVESLOT_CI_TERMS_REQUIRED: "false",
      }),
    ).toEqual({ base: "def", title: "docs: y", termsRequired: false });
    expect(ciEnv({ SAVESLOT_CI_TERMS_REQUIRED: "true" }).termsRequired).toBe(true);
    expect(ciEnv({})).toEqual({ base: undefined, title: undefined, termsRequired: false });
  });

  it("an empty base is none; an empty title is still a title, to be refused", () => {
    expect(ciEnv({ SAVESLOT_CI_BASE: "", SAVESLOT_CI_TITLE: "" })).toEqual({
      base: undefined,
      title: "",
      termsRequired: false,
    });
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
