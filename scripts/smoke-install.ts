// The packages as npm installs them (02-architecture §11 «发布»): publishes every package that is
// not private to a throwaway npm registry on 127.0.0.1, installs `@fluxvita/saveslot` globally into
// a prefix of its own, with an empty HOME, and runs the installed command. Nothing is published
// anywhere else. Run it before a release, after `pnpm build`.
//
// Usage: pnpm build && node scripts/smoke-install.ts [--keep]
//
// The registry is verdaccio, fetched by npx at the version below; packages that are not ours are
// proxied from npmjs. `--keep` leaves the temporary directory (registry storage, prefix, HOME and
// the logs) for a look afterwards; it is removed otherwise.
//
// `releaseProblems` checks the release set without publishing anything; its test runs in
// `pnpm check`.

import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import {
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { createServer } from "node:net";
import { tmpdir } from "node:os";
import { dirname, join, resolve } from "node:path";

export const ENTRY = "@fluxvita/saveslot";
export const VERDACCIO = "verdaccio@7.1.2";
export const INTERNAL_NOTE = "**Internal package of saveslot.**";
/** What every published package leaves out of `dist`: test fixtures and the build cache. */
export const FILES = ["dist", "!dist/**/*.fixture.*", "!dist/.tsbuildinfo"];

interface Manifest {
  name: string;
  private?: boolean;
  files?: unknown;
  publishConfig?: { access?: unknown };
  dependencies?: Record<string, string>;
}

export interface Pkg {
  dir: string;
  manifest: Manifest;
}

export function workspacePackages(root: string): Pkg[] {
  const out: Pkg[] = [];
  for (const name of readdirSync(join(root, "packages")).sort()) {
    const file = join(root, "packages", name, "package.json");
    if (!existsSync(file)) continue;
    out.push({ dir: join("packages", name), manifest: JSON.parse(readFileSync(file, "utf8")) });
  }
  return out;
}

/**
 * What is wrong with the release set under `root`, one line each: the published packages (those
 * not private) must be the Changesets fixed group, be closed under their workspace dependencies,
 * carry the same `files` and public access, and have a README whose opening says what they are.
 */
export function releaseProblems(root: string): string[] {
  const problems: string[] = [];
  const pkgs = workspacePackages(root);
  const published = pkgs.filter((p) => p.manifest.private !== true);
  const names = new Set(published.map((p) => p.manifest.name));
  if (!names.has(ENTRY)) problems.push(`${ENTRY} is not published`);

  const config = JSON.parse(readFileSync(join(root, ".changeset/config.json"), "utf8")) as {
    fixed?: string[][];
  };
  const fixed = config.fixed ?? [];
  const group = new Set(fixed[0] ?? []);
  if (fixed.length !== 1)
    problems.push(`.changeset/config.json: expected one fixed group, found ${fixed.length}`);
  for (const n of names)
    if (!group.has(n)) problems.push(`${n}: published but not in the fixed group`);
  for (const n of group)
    if (!names.has(n)) problems.push(`${n}: in the fixed group but not published`);

  for (const { dir, manifest: m } of published) {
    for (const [dep, range] of Object.entries(m.dependencies ?? {})) {
      if (!range.startsWith("workspace:")) continue;
      if (!names.has(dep)) problems.push(`${m.name}: depends on ${dep}, which is not published`);
      else if (range !== "workspace:*")
        problems.push(`${m.name}: ${dep} is ${range}, not workspace:*`);
    }
    if (JSON.stringify(m.files) !== JSON.stringify(FILES)) {
      problems.push(`${m.name}: files is ${JSON.stringify(m.files)}, not ${JSON.stringify(FILES)}`);
    }
    if (m.publishConfig?.access !== "public")
      problems.push(`${m.name}: publishConfig.access is not "public"`);
    const readme = join(root, dir, "README.md");
    if (!existsSync(readme)) {
      problems.push(`${m.name}: no README.md`);
      continue;
    }
    const lines = readFileSync(readme, "utf8").split("\n");
    if (lines[0] !== `# ${m.name}`)
      problems.push(`${m.name}: README.md does not begin with "# ${m.name}"`);
    const internal = (lines[2] ?? "").startsWith(INTERNAL_NOTE);
    if (m.name !== ENTRY && !internal) {
      problems.push(`${m.name}: README.md does not open with ${JSON.stringify(INTERNAL_NOTE)}`);
    }
    if (m.name === ENTRY && internal) problems.push(`${ENTRY}: README.md calls it internal`);
  }
  return problems;
}

function freePort(): Promise<number> {
  return new Promise((ok, fail) => {
    const s = createServer();
    s.once("error", fail);
    s.listen(0, "127.0.0.1", () => {
      const a = s.address();
      s.close(() =>
        typeof a === "object" && a !== null ? ok(a.port) : fail(new Error("no port")),
      );
    });
  });
}

async function waitFor(url: string, child: ChildProcess, ms: number): Promise<void> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    if (child.exitCode !== null) throw new Error(`the registry exited with ${child.exitCode}`);
    try {
      if ((await fetch(url)).ok) return;
    } catch {
      // Not listening yet.
    }
    await new Promise((r) => setTimeout(r, 250));
  }
  throw new Error(`the registry did not answer at ${url} within ${ms / 1000} s`);
}

interface Step {
  name: string;
  ok: boolean;
  seconds: number;
  detail: string;
}

function run(
  steps: Step[],
  name: string,
  cmd: string,
  args: string[],
  opts: { cwd?: string; env: NodeJS.ProcessEnv; expect?: number },
): boolean {
  const t = Date.now();
  const r = spawnSync(cmd, args, { cwd: opts.cwd, env: opts.env, encoding: "utf8" });
  const code = r.status ?? -1;
  const ok = code === (opts.expect ?? 0);
  const out = `${r.stdout ?? ""}${r.stderr ?? ""}`.trim();
  steps.push({
    name,
    ok,
    seconds: (Date.now() - t) / 1000,
    detail: `exit ${code}${r.error ? ` (${r.error.message})` : ""}${ok ? "" : `\n${out}`}`,
  });
  return ok;
}

async function smoke(root: string, keep: boolean): Promise<number> {
  const problems = releaseProblems(root);
  if (problems.length > 0) {
    for (const p of problems) console.error(p);
    return 1;
  }
  const published = workspacePackages(root).filter((p) => p.manifest.private !== true);
  for (const p of published) {
    if (!existsSync(join(root, p.dir, "dist"))) {
      console.error(`${p.dir}/dist does not exist: run pnpm build first`);
      return 1;
    }
  }

  const tmp = mkdtempSync(join(tmpdir(), "saveslot-smoke-"));
  const port = await freePort();
  const registry = `http://127.0.0.1:${port}/`;
  const host = `//127.0.0.1:${port}/`;
  writeFileSync(
    join(tmp, "verdaccio.yaml"),
    [
      `storage: ${join(tmp, "storage")}`,
      "auth:",
      "  htpasswd:",
      `    file: ${join(tmp, "htpasswd")}`,
      "uplinks:",
      "  npmjs:",
      "    url: https://registry.npmjs.org/",
      "packages:",
      "  '@fluxvita/*':",
      "    access: $all",
      "    publish: $authenticated",
      "  '**':",
      "    access: $all",
      "    proxy: npmjs",
      "log: { type: stdout, format: pretty, level: warn }",
      "",
    ].join("\n"),
  );
  const nodeBin = dirname(process.execPath);
  const base: NodeJS.ProcessEnv = {
    PATH: `${nodeBin}:/usr/bin:/bin`,
    HOME: join(tmp, "home"),
    npm_config_cache: join(tmp, "npm-cache"),
    npm_config_userconfig: join(tmp, "npmrc"),
    npm_config_update_notifier: "false",
  };
  mkdirSync(join(tmp, "home"));
  const log = join(tmp, "verdaccio.log");
  writeFileSync(log, "");
  const registryProc = spawn(
    "npx",
    ["--yes", VERDACCIO, "--config", join(tmp, "verdaccio.yaml"), "--listen", `127.0.0.1:${port}`],
    {
      env: { ...process.env, npm_config_cache: join(tmp, "npx-cache") },
      stdio: ["ignore", "pipe", "pipe"],
      detached: true,
    },
  );
  const chunks: Buffer[] = [];
  registryProc.stdout?.on("data", (b: Buffer) => chunks.push(b));
  registryProc.stderr?.on("data", (b: Buffer) => chunks.push(b));

  const steps: Step[] = [];
  let failed = true;
  try {
    let t = Date.now();
    await waitFor(`${registry}-/ping`, registryProc, 120_000);
    steps.push({ name: "registry", ok: true, seconds: (Date.now() - t) / 1000, detail: registry });

    t = Date.now();
    const res = await fetch(`${registry}-/user/org.couchdb.user:smoke`, {
      method: "PUT",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ name: "smoke", password: "smoke-local-only" }),
    });
    const { token } = (await res.json()) as { token?: string };
    if (!res.ok || token === undefined)
      throw new Error(`could not add the registry user: HTTP ${res.status}`);
    writeFileSync(join(tmp, "npmrc"), `registry=${registry}\n${host}:_authToken=${token}\n`);
    steps.push({ name: "registry user", ok: true, seconds: (Date.now() - t) / 1000, detail: "" });

    const pnpm = { ...base, PATH: process.env["PATH"] };
    for (const p of published) {
      const ok = run(
        steps,
        `publish ${p.manifest.name}`,
        "pnpm",
        ["publish", "--no-git-checks", "--registry", registry],
        {
          cwd: join(root, p.dir),
          env: pnpm,
        },
      );
      if (!ok) return 1;
    }

    const prefix = join(tmp, "prefix");
    const user: NodeJS.ProcessEnv = { ...base, npm_config_prefix: prefix };
    if (!run(steps, "npm install -g", "npm", ["install", "-g", ENTRY], { env: user })) return 1;
    const bin = join(prefix, "bin", "saveslot");
    const cmd = { ...user, PATH: `${join(prefix, "bin")}:${user["PATH"]}` };
    if (!run(steps, "saveslot --help", bin, ["--help"], { env: cmd })) return 1;
    if (
      !run(steps, "saveslot status (not set up: exit 7)", bin, ["status"], { env: cmd, expect: 7 })
    )
      return 1;
    failed = false;
    return 0;
  } catch (e) {
    steps.push({
      name: "error",
      ok: false,
      seconds: 0,
      detail: e instanceof Error ? e.message : String(e),
    });
    return 1;
  } finally {
    try {
      if (registryProc.pid !== undefined) process.kill(-registryProc.pid, "SIGTERM");
    } catch {
      // Already gone.
    }
    writeFileSync(log, Buffer.concat(chunks));
    for (const s of steps)
      console.log(`${s.ok ? "ok  " : "FAIL"} ${s.name} (${s.seconds.toFixed(1)} s) ${s.detail}`);
    if (keep || failed) console.log(`kept: ${tmp}`);
    else rmSync(tmp, { recursive: true, force: true });
  }
}

if (import.meta.main) {
  const root = resolve(import.meta.dirname, "..");
  process.exitCode = await smoke(root, process.argv.includes("--keep"));
}
