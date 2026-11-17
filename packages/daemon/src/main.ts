// The service's foreground entry: `--home <dir>` (default `~/.saveslot`); the data directory is the
// one the home's tenant directory records. Runs until stopped and sets the process exit code (0
// after a stop, 1 when it could not start or failed). Starting in the background, configuration
// and the other service commands come with the `saveslot` entry package.

import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import { runService } from "./service.ts";

/** This package's version: what `GET /health` reports and `saveslot start` compares. */
export function daemonVersion(): string {
  const pkg = JSON.parse(readFileSync(new URL("../package.json", import.meta.url), "utf8")) as {
    version: string;
  };
  return pkg.version;
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
  const service = await runService({
    home,
    version: daemonVersion(),
  });
  return (await service.exited).code;
}
