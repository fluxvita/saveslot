// Makes the sample of the storage format this version writes
// (docs/zh-CN/process/decisions/data-compatibility.md §4.5): data written through the service as
// an agent and a user would, left where the tests of every later version read it. Run on the commit
// a release is made from, once for each mode, and commit what it leaves.
//
// Usage: node scripts/make-format-sample.ts <local|server> [--switch] [output directory]
//
// The output directory defaults to packages/test-backend/fixtures/storage-format/<format>/<mode>
// (`<mode>-switch` with --switch) and must not hold a sample yet: a format's sample is made once
// and not replaced. --switch: the history goes on with a schema switch (format-sample.fixture.ts).
//
// Beside the sample, `made-from.json`: the release tag before the commit it was made on, that tag's
// commit, and the files changed since the tag. A sample made after a release is made from the tag's
// tree plus those files, which may only be the sample's own test files; the commit it was made on
// is not recorded, since it need not be one the repository keeps.
//
// local:  `home.tar.gz`, a home's data directory with its anchor and credentials, and
//         `expected.json`.
// server: `control.sql` and one `tenant-<database>.sql` for each tenant, made by pg_dump (on the
//         PATH, not older than the server), and `expected.json`. SAVESLOT_TEST_POSTGRES_URL names
//         the PostgreSQL to make them on, as for `pnpm test:postgres`.
//
// The history and the reading are those of packages/daemon/src/format-sample.test.ts and
// format-sample-server.test.ts: this runs the one of the mode, told to leave its sample.

import { spawnSync } from "node:child_process";
import { existsSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { CURRENT_FORMAT, SAMPLES_DIR } from "../packages/daemon/src/format-sample-paths.fixture.ts";

const MODES = { local: "format-sample.test.ts", server: "format-sample-server.test.ts" } as const;

function git(repo: string, ...args: string[]): string {
  const r = spawnSync("git", args, { cwd: repo, encoding: "utf8" });
  if (r.status !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout.trim();
}

/** The release tag before the commit a sample is made on, its commit, and what changed since. */
function madeFrom(repo: string) {
  const tag = git(repo, "describe", "--tags", "--abbrev=0", "--match", "v*");
  return {
    tag,
    tag_commit: git(repo, "rev-list", "-n", "1", tag),
    changed_since_tag: git(repo, "diff", "--name-only", tag, "HEAD")
      .split("\n")
      .filter((l) => l !== ""),
    uncommitted: git(repo, "status", "--porcelain", "--untracked-files=no") !== "",
  };
}

if (import.meta.main) {
  const args = process.argv.slice(2);
  const switched = args.includes("--switch");
  const [mode, given] = args.filter((a) => a !== "--switch");
  if (mode !== "local" && mode !== "server") {
    console.error(
      "usage: node scripts/make-format-sample.ts <local|server> [--switch] [output directory]",
    );
    process.exit(2);
  }
  const repo = resolve(import.meta.dirname, "..");
  const name = `${mode}${switched ? "-switch" : ""}`;
  const out = resolve(given ?? resolve(repo, SAMPLES_DIR, String(CURRENT_FORMAT), name));
  if (existsSync(resolve(out, "expected.json"))) {
    console.error(`${out} already holds a sample: a format's sample is not replaced.`);
    process.exit(2);
  }
  const url = process.env["SAVESLOT_TEST_POSTGRES_URL"];
  if (mode === "server" && (url === undefined || url === "")) {
    console.error(
      "SAVESLOT_TEST_POSTGRES_URL is not set: it names the PostgreSQL to make the sample on.",
    );
    process.exit(2);
  }
  const r = spawnSync(
    process.execPath,
    [resolve(repo, "node_modules/vitest/vitest.mjs"), "run", `packages/daemon/src/${MODES[mode]}`],
    {
      cwd: repo,
      stdio: "inherit",
      env: {
        ...process.env,
        SAVESLOT_FORMAT_SAMPLE_OUT: out,
        ...(switched ? { SAVESLOT_FORMAT_SAMPLE_SWITCH: "1" } : {}),
        ...(mode === "server"
          ? { SAVESLOT_TEST_BACKEND: "postgres", SAVESLOT_TEST_POSTGRES_REQUIRED: "1" }
          : {}),
      },
    },
  );
  if (r.status === 0) {
    writeFileSync(resolve(out, "made-from.json"), `${JSON.stringify(madeFrom(repo), null, 2)}\n`);
    console.log(`the format ${CURRENT_FORMAT} sample, ${name}: ${out}`);
  }
  process.exit(r.status ?? 1);
}
