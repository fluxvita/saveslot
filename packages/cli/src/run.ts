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

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { parseArgs } from "node:util";
import {
  type CatalogTables,
  type Client,
  ContractCallError,
  createClient,
  resolveCredential,
} from "@fluxvita/saveslot-client";
import { describeError } from "./errors.ts";
import { catalogList, catalogTables, schemaTemplates, slotCreated } from "./render/results.ts";
import { type Boundary, type Line, render, t, untrusted, words } from "./render/text.ts";
import { TEMPLATES } from "./templates.ts";
import { type Static, TEXTS } from "./texts.ts";

/** The options some commands have; any other command given one is a usage error. */
const OWN_OPTIONS = ["template", "file", "timezone", "tables"] as const;

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
  /** The positionals after the command's words. */
  readonly args: readonly string[];
  /** The command's own options, as given. */
  readonly own: Readonly<Record<string, string | undefined>>;
}

/** A command line the command cannot take: exit 2, with its static text. */
class UsageError extends Error {
  readonly text: Static;
  constructor(text: Static) {
    super(text);
    this.text = text;
  }
}

/** What a command gives: a result to write, as text and as JSON. */
interface Output {
  readonly json: unknown;
  readonly lines: Line[];
}

interface Command {
  /** The options of this command besides the global ones (string-valued). */
  readonly options: readonly string[];
  readonly run: (o: Options, client: () => Promise<Client>) => Promise<Output>;
}
const command = (options: readonly string[], run: Command["run"]): Command => ({ options, run });

/** The schema document `slot create` submits: a template's or a file's, named and timed. */
async function documentFor(o: Options): Promise<{ doc: Record<string, unknown>; chosen?: string }> {
  const slot = o.args[0];
  if (slot === undefined || o.args.length > 1) throw new UsageError(TEXTS.slotNameMissing);
  const template = o.own["template"];
  const file = o.own["file"];
  if ((template === undefined) === (file === undefined)) throw new UsageError(TEXTS.createNeedsOne);
  let doc: Record<string, unknown>;
  if (template !== undefined) {
    const t = TEMPLATES.get(template);
    if (t === undefined) throw new UsageError(TEXTS.templateUnknown);
    doc = structuredClone(t.document) as Record<string, unknown>;
  } else {
    let v: unknown;
    try {
      v = JSON.parse(await readFile(resolve(file as string), "utf8"));
    } catch {
      throw new UsageError(TEXTS.fileUnreadable);
    }
    if (typeof v !== "object" || v === null || Array.isArray(v)) {
      throw new UsageError(TEXTS.fileUnreadable);
    }
    doc = v as Record<string, unknown>;
  }
  // The name is the command line's; a new slot has no base version (06 §3 step 4).
  doc["slot"] = slot;
  doc["base_version"] = null;
  const given = o.own["timezone"];
  if (given !== undefined) {
    doc["timezone"] = given;
    return { doc };
  }
  // A template without --timezone: this computer's (06 §3.1); a file keeps its own.
  if (template !== undefined) {
    const local = Intl.DateTimeFormat().resolvedOptions().timeZone;
    doc["timezone"] = local;
    return { doc, chosen: local };
  }
  return { doc };
}

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  [
    "slot create",
    command(["template", "file", "timezone"], async (o, client) => {
      const { doc, chosen } = await documentFor(o);
      const r = await (await client()).schemaDraft({ document: doc });
      return { json: r, lines: slotCreated(r, chosen) };
    }),
  ],
  [
    "slot show",
    command(["tables"], async (o, client) => {
      const [slot, ...named] = o.args;
      if (slot === undefined) throw new UsageError(TEXTS.slotShowMissing);
      const listed = [
        ...named,
        ...(o.own["tables"] ?? "").split(",").filter((x) => x.trim() !== ""),
      ].map((x) => x.trim());
      const c = await client();
      // No tables named: every table of the slot, as the list gives them.
      const tables =
        listed.length > 0
          ? listed
          : (await c.catalog({ level: "list", slot })).slots.flatMap((x) =>
              x.tables.map((tb) => tb.table),
            );
      const qualified = tables.map((x) => (x.includes(".") ? x : `${slot}.${x}`));
      // The table level takes at most 10 tables a call (04-contract-types §4.2).
      const parts: CatalogTables[] = [];
      for (let i = 0; i < qualified.length; i += 10) {
        parts.push(await c.catalog({ level: "table", tables: qualified.slice(i, i + 10) }));
      }
      const r: CatalogTables = {
        level: "table",
        tables: parts.flatMap((x) => x.tables),
        ...(parts.some((x) => x.warnings !== undefined)
          ? { warnings: parts.flatMap((x) => x.warnings ?? []) }
          : {}),
        ...(parts.some((x) => x.notices !== undefined)
          ? { notices: parts.flatMap((x) => x.notices ?? []) }
          : {}),
      };
      return { json: r, lines: catalogTables(r) };
    }),
  ],
  [
    "slot list",
    command([], async (o, client) => {
      const r = await (await client()).catalog({
        level: "list",
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
      });
      return { json: r, lines: catalogList(r) };
    }),
  ],
  [
    "schema templates",
    command([], async () => ({
      json: { templates: [...TEMPLATES.keys()] },
      lines: schemaTemplates(),
    })),
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
        // The commands' own options, checked against the command below.
        template: { type: "string" },
        file: { type: "string" },
        timezone: { type: "string" },
        tables: { type: "string" },
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
  const found = COMMANDS.get(positionals.slice(0, 2).join(" "));
  if (found === undefined) {
    io.err(`${TEXTS.unknownCommand}\n`);
    return 2;
  }
  const own: Record<string, string | undefined> = {};
  for (const k of OWN_OPTIONS) {
    const v = values[k];
    if (v === undefined) continue;
    if (!found.options.includes(k)) {
      io.err(`${TEXTS.usageError(TEXTS.optionNotHere)}\n`);
      return 2;
    }
    own[k] = String(v);
  }
  const o: Options = {
    json: values["json"] === true,
    limit,
    cursor: typeof values["cursor"] === "string" ? values["cursor"] : undefined,
    tags,
    home: resolve(
      typeof values["home"] === "string" ? values["home"] : join(homedir(), ".saveslot"),
    ),
    args: positionals.slice(2),
    own,
  };
  const client = async () => {
    const credential = await resolveCredential({ home: o.home, env });
    return createClient({
      socketPath: join(o.home, "run", "saveslot.sock"),
      token: credential.token,
    });
  };
  try {
    const r = await found.run(o, client);
    io.out(
      o.json
        ? `${jsonText(r.json)}\n`
        : `${render(r.lines, boundaryFor(io.stdoutIsTTY, o.tags, env))}\n`,
    );
    return 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${TEXTS.usageError(e.text)}\n`);
      return 2;
    }
    const d = describeError(e);
    if (o.json && e instanceof ContractCallError) io.out(`${jsonText({ error: e.body })}\n`);
    io.err(`${render(d.lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
    return d.exit;
  }
}
