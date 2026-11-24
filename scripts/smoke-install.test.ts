// Tests for the release set's check (scripts/smoke-install.ts): the repository passes it, and each
// rule fails on the input it exists to catch.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { ENTRY, FILES, INTERNAL_NOTE, releaseProblems } from "./smoke-install.ts";

const REPO = resolve(import.meta.dirname, "..");
const dirs: string[] = [];

afterEach(() => {
  for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true });
});

interface Spec {
  name: string;
  private?: boolean;
  deps?: Record<string, string>;
  files?: unknown;
  access?: string;
  readme?: string | null;
}

function repo(pkgs: Spec[], fixed: string[][]): string {
  const root = mkdtempSync(join(tmpdir(), "saveslot-release-"));
  dirs.push(root);
  const put = (path: string, body: string): void => {
    mkdirSync(dirname(join(root, path)), { recursive: true });
    writeFileSync(join(root, path), body);
  };
  put(".changeset/config.json", JSON.stringify({ fixed }));
  for (const p of pkgs) {
    const dir = `packages/${p.name.replace(/^@fluxvita\/(saveslot-)?/, "") || "saveslot"}`;
    put(
      `${dir}/package.json`,
      JSON.stringify({
        name: p.name,
        ...(p.private ? { private: true } : {}),
        files: p.files ?? FILES,
        publishConfig: { access: p.access ?? "public" },
        dependencies: p.deps ?? {},
      }),
    );
    const readme =
      p.readme === undefined
        ? `# ${p.name}\n\n${p.name === ENTRY ? "saveslot." : `${INTERNAL_NOTE} More.`}\n`
        : p.readme;
    if (readme !== null) put(`${dir}/README.md`, readme);
  }
  return root;
}

const KERNEL = "@fluxvita/saveslot-kernel";
const REF = "@fluxvita/saveslot-reference";

describe("release set", () => {
  it("has no problems in this repository", () => {
    expect(releaseProblems(REPO)).toEqual([]);
  });

  it("passes a published entry and internal package in one fixed group", () => {
    const root = repo(
      [
        { name: ENTRY, deps: { [KERNEL]: "workspace:*", other: "1.0.0" } },
        { name: KERNEL },
        { name: REF, private: true },
      ],
      [[ENTRY, KERNEL]],
    );
    expect(releaseProblems(root)).toEqual([]);
  });

  it("reports a published package left out of the fixed group, and a member that is private", () => {
    const root = repo(
      [{ name: ENTRY }, { name: KERNEL }, { name: REF, private: true }],
      [[ENTRY, REF]],
    );
    expect(releaseProblems(root)).toEqual([
      `${KERNEL}: published but not in the fixed group`,
      `${REF}: in the fixed group but not published`,
    ]);
  });

  it("reports a published package that depends on a private one, or not by workspace:*", () => {
    const root = repo(
      [
        { name: ENTRY, deps: { [REF]: "workspace:*", [KERNEL]: "workspace:^" } },
        { name: KERNEL },
        { name: REF, private: true },
      ],
      [[ENTRY, KERNEL]],
    );
    expect(releaseProblems(root)).toEqual([
      `${ENTRY}: depends on ${REF}, which is not published`,
      `${ENTRY}: ${KERNEL} is workspace:^, not workspace:*`,
    ]);
  });

  it("reports files that ship the fixtures, and access that is not public", () => {
    const root = repo([{ name: ENTRY, files: ["dist"], access: "restricted" }], [[ENTRY]]);
    expect(releaseProblems(root)).toEqual([
      `${ENTRY}: files is ["dist"], not ${JSON.stringify(FILES)}`,
      `${ENTRY}: publishConfig.access is not "public"`,
    ]);
  });

  it("reports a missing README, and an opening that does not say what the package is", () => {
    const root = repo(
      [
        { name: ENTRY, readme: `# ${ENTRY}\n\n${INTERNAL_NOTE}\n` },
        { name: KERNEL, readme: `# ${KERNEL}\n\nThe kernel.\n` },
        { name: "@fluxvita/saveslot-cli", readme: null },
      ],
      [[ENTRY, KERNEL, "@fluxvita/saveslot-cli"]],
    );
    expect(releaseProblems(root)).toEqual([
      "@fluxvita/saveslot-cli: no README.md",
      `${KERNEL}: README.md does not open with ${JSON.stringify(INTERNAL_NOTE)}`,
      `${ENTRY}: README.md calls it internal`,
    ]);
  });

  it("reports an entry package that is not published, and more than one fixed group", () => {
    const root = repo([{ name: ENTRY, private: true }, { name: KERNEL }], [[KERNEL], [ENTRY]]);
    expect(releaseProblems(root)).toEqual([
      `${ENTRY} is not published`,
      ".changeset/config.json: expected one fixed group, found 2",
    ]);
  });
});
