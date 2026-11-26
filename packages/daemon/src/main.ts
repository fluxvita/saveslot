// The service's foreground entry: `--home <dir>` (default `~/.saveslot`); the data directory is the
// one the home's tenant directory records. Runs until stopped and sets the process exit code (0
// after a stop, 1 when it could not start or failed, 5 for a config.toml refused). Starting in the
// background, configuration and the other service commands come with the `saveslot` entry package.
//
// `--supervised` (the job `saveslot service install` writes, ./autostart.ts): non-zero only for a
// service that failed after it was ready, the one case the job starts it again (02-architecture
// §7). One that failed before it served (config.toml refused, the home's lock held by another
// process, a data directory not where the home records it, a store of another format, …) exits 0,
// its reason in the log as before: the cause stays, and the job would start it again every few
// seconds.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigInvalid, readConfig } from "./config.ts";
import { rotatingLog } from "./log-file.ts";
import { type RunServiceOptions, runService } from "./service.ts";
import { TEXTS } from "./texts.ts";

/** This package's version: what `GET /health` reports and `saveslot start` compares. */
export function daemonVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
}

/** What the foreground service runs with: the home's configuration; throws `ConfigInvalid`. */
export async function foregroundOptions(
  home: string,
  evalClock?: string,
  noUpgradeBackup?: boolean,
): Promise<RunServiceOptions> {
  const config = await readConfig(home);
  return {
    home,
    version: daemonVersion(),
    readsFlushMs: config.readsFlushSeconds * 1000,
    // `--no-upgrade-backup` for this start, or `upgrade.backup = false` for every start.
    upgradeBackup: config.upgradeBackup && noUpgradeBackup !== true,
    ...(evalClock !== undefined ? { evalClock } : {}),
  };
}

/** Runs the service in the foreground; resolves with the exit code once it has stopped. */
export async function main(argv: readonly string[]): Promise<number> {
  let values: {
    home?: string | undefined;
    "eval-clock"?: string | undefined;
    "no-upgrade-backup"?: boolean | undefined;
    log?: string | undefined;
    supervised?: boolean | undefined;
  };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      // `--eval-clock`: the test clock, for evaluations only (02-architecture §11).
      // `--log`: the file the service writes its own lines to, rotating it (`saveslot start`).
      options: {
        home: { type: "string" },
        "eval-clock": { type: "string" },
        "no-upgrade-backup": { type: "boolean" },
        log: { type: "string" },
        supervised: { type: "boolean" },
      },
      strict: true,
      allowPositionals: false,
    }));
  } catch (e) {
    process.stderr.write(`${(e as Error).message}\n`);
    return 2;
  }
  const home = resolve(values.home ?? join(homedir(), ".saveslot"));
  let options: RunServiceOptions;
  try {
    options = await foregroundOptions(home, values["eval-clock"], values["no-upgrade-backup"]);
  } catch (e) {
    if (!(e instanceof ConfigInvalid)) throw e;
    // In the background stderr is the service's log: the known keys by name, how many unknown
    // ones (their names are the user's), never a value. The texts go to a terminal only.
    const known = e.problems.flatMap((p) =>
      "key" in p && p.kind !== "unknown_key" ? [p.key] : [],
    );
    const unknown = e.problems.filter((p) => p.kind === "unknown_key").length;
    process.stderr.write(
      `${new Date().toISOString()} config_invalid${known.length > 0 ? ` keys=${known.join(",")}` : ""}${unknown > 0 ? ` unknown_keys=${unknown}` : ""}\n`,
    );
    if (process.stderr.isTTY === true) {
      for (const line of [TEXTS.configInvalid, ...e.problems.map(TEXTS.configProblem)]) {
        process.stderr.write(`${line}\n`);
      }
    }
    return values.supervised === true ? 0 : 5;
  }
  const log = values.log !== undefined ? { log: rotatingLog(resolve(values.log)) } : {};
  const service = await runService({ ...options, ...log });
  const exited = await service.exited;
  return supervisedExit(exited.code, service.served, values.supervised === true);
}

/** The exit code: as the service ended, or with `--supervised` 0 for one that never served. */
export function supervisedExit(code: number, served: boolean, supervised: boolean): number {
  return supervised && !served ? 0 : code;
}
