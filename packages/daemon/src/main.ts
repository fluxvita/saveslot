// The service's foreground entry: `--home <dir>` (default `~/.saveslot`); the data directory is the
// one the home's tenant directory records. Runs until stopped and sets the process exit code (0
// after a stop, 1 when it could not start or failed). Starting in the background, configuration
// and the other service commands come with the `saveslot` entry package.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { ConfigInvalid, readConfig } from "./config.ts";
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
export async function foregroundOptions(home: string): Promise<RunServiceOptions> {
  const config = await readConfig(home);
  return {
    home,
    version: daemonVersion(),
    readsFlushMs: config.readsFlushSeconds * 1000,
  };
}

/** Runs the service in the foreground; resolves with the exit code once it has stopped. */
export async function main(argv: readonly string[]): Promise<number> {
  let values: { home?: string | undefined };
  try {
    ({ values } = parseArgs({
      args: [...argv],
      options: { home: { type: "string" } },
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
    options = await foregroundOptions(home);
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
    return 5;
  }
  const service = await runService(options);
  return (await service.exited).code;
}
