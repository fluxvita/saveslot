// The CLI's commands (docs/zh-CN/spec/06-cli.md §4, §6): the global options, the credential, the
// client, a command, its output and its exit code. The entry package hands every command but the
// service ones (`init`, `start`, `stop`, `status`, `config`, `mcp`) to `run`.
//
// - Global options: `--json` (the contract's result as JSON on stdout; an error as
//   `{"error": …}`), `--limit` / `--cursor` (paging, for the commands that page),
//   `--untrusted-tags auto|always|never` (06 §6.4), `--profile` (only `local` in this version;
//   another is a usage error, 2). `--home` is for tests and development, not in the help text.
// - The credential: `SAVESLOT_TOKEN` when set, otherwise the user session (the client's rules).
// - The socket: the home's, `run/saveslot.sock` (06 §8.1); no variable or option changes it.
// - Human text on stdout; errors, with the next step, on stderr (06 §6.3).

import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type Client,
  ContractCallError,
  createClient,
  resolveCredential,
} from "@fluxvita/saveslot-client";
import { describeError } from "./errors.ts";
import { catalogList, schemaTemplates } from "./render/results.ts";
import { type Boundary, type Line, render, t, untrusted, words } from "./render/text.ts";
import { TEMPLATES } from "./templates.ts";
import { TEXTS } from "./texts.ts";
import { jsonText } from "./untrusted.ts";

export interface CliIO {
  readonly out: (text: string) => void;
  readonly err: (text: string) => void;
  /** Whether stdout and stderr are terminals. */
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
}

interface Options {
  readonly json: boolean;
  readonly limit: number | undefined;
  readonly cursor: string | undefined;
  readonly tags: "auto" | "always" | "never";
  readonly home: string;
}

/** What a command gives: a result to write, as text and as JSON. */
interface Output {
  readonly json: unknown;
  readonly lines: Line[];
}

type Command = (o: Options, client: () => Promise<Client>) => Promise<Output>;

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  [
    "slot list",
    async (o, client) => {
      const r = await (await client()).catalog({
        level: "list",
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
      });
      return { json: r, lines: catalogList(r) };
    },
  ],
  [
    "schema templates",
    async () => ({
      json: { templates: [...TEMPLATES.keys()] },
      lines: schemaTemplates(),
    }),
  ],
]);

/** How untrusted values are written on a stream (06 §6.4). */
function boundaryFor(isTTY: boolean, tags: Options["tags"], env: Env): Boundary {
  if (tags === "always") return { kind: "tagged" };
  if (isTTY) {
    const color = (env["NO_COLOR"] ?? "") === "" && env["TERM"] !== "dumb";
    return { kind: "terminal", color };
  }
  return tags === "never" ? { kind: "plain" } : { kind: "tagged" };
}

type Env = Readonly<Record<string, string | undefined>>;

/** Runs one command line (without the program name); resolves with its exit code. */
export async function run(argv: readonly string[], env: Env, io: CliIO): Promise<number> {
  let values: Record<string, string | boolean | undefined>;
  let positionals: string[];
  try {
    ({ values, positionals } = parseArgs({
      args: [...argv],
      options: {
        json: { type: "boolean" },
        limit: { type: "string" },
        cursor: { type: "string" },
        "untrusted-tags": { type: "string" },
        profile: { type: "string" },
        home: { type: "string" },
        help: { type: "boolean", short: "h" },
      },
      strict: true,
      allowPositionals: true,
    }));
  } catch (e) {
    // The message echoes the arguments, the user's text: written as untrusted.
    const said = [...t`${words(TEXTS.badArguments)} `, untrusted((e as Error).message)];
    io.err(`${render([said], boundaryFor(io.stderrIsTTY, "auto", env))}\n`);
    return 2;
  }
  if (values["help"] === true || positionals.length === 0) {
    (values["help"] === true ? io.out : io.err)(`${TEXTS.usage}\n`);
    return values["help"] === true ? 0 : 2;
  }
  if (values["profile"] !== undefined && values["profile"] !== "local") {
    io.err(`${TEXTS.profileNotYet}\n`);
    return 2;
  }
  const tags = values["untrusted-tags"] ?? "auto";
  if (tags !== "auto" && tags !== "always" && tags !== "never") {
    io.err(`${TEXTS.usageError(TEXTS.untrustedTagsInvalid)}\n`);
    return 2;
  }
  let limit: number | undefined;
  if (values["limit"] !== undefined) {
    const l = String(values["limit"]);
    if (!/^[1-9][0-9]{0,8}$/.test(l)) {
      io.err(`${TEXTS.usageError(TEXTS.limitInvalid)}\n`);
      return 2;
    }
    limit = Number(l);
  }
  const command = COMMANDS.get(positionals.join(" "));
  if (command === undefined) {
    io.err(`${TEXTS.unknownCommand}\n`);
    return 2;
  }
  const o: Options = {
    json: values["json"] === true,
    limit,
    cursor: typeof values["cursor"] === "string" ? values["cursor"] : undefined,
    tags,
    home: resolve(
      typeof values["home"] === "string" ? values["home"] : join(homedir(), ".saveslot"),
    ),
  };
  const client = async () => {
    const credential = await resolveCredential({ home: o.home, env });
    return createClient({
      socketPath: join(o.home, "run", "saveslot.sock"),
      token: credential.token,
    });
  };
  try {
    const r = await command(o, client);
    io.out(
      o.json
        ? `${jsonText(r.json)}\n`
        : `${render(r.lines, boundaryFor(io.stdoutIsTTY, o.tags, env))}\n`,
    );
    return 0;
  } catch (e) {
    const d = describeError(e);
    if (o.json && e instanceof ContractCallError) io.out(`${jsonText({ error: e.body })}\n`);
    io.err(`${render(d.lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
    return d.exit;
  }
}
