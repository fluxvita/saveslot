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
  type AsOfResult,
  type CatalogTables,
  type Client,
  ContractCallError,
  createClient,
  ITEM_STATUSES,
  ITEM_TYPES,
  resolveCredential,
  type TimelineResult,
} from "@fluxvita/saveslot-client";
import { describeError } from "./errors.ts";
import { logVerified, readsList, verifyFound } from "./render/admin.ts";
import { pendingDetail, pendingList } from "./render/pending.ts";
import { asOfResult, queryResult, timelineResult } from "./render/reads.ts";
import { catalogList, catalogTables, schemaTemplates, slotCreated } from "./render/results.ts";
import { type Boundary, type Line, render, t, untrusted, words } from "./render/text.ts";
import { TEMPLATES } from "./templates.ts";
import { type Static, TEXTS } from "./texts.ts";

/** The options some commands have; any other command given one is a usage error. */
const OWN_OPTIONS = {
  template: { type: "string" },
  file: { type: "string" },
  timezone: { type: "string" },
  tables: { type: "string" },
  where: { type: "string", multiple: true },
  "where-json": { type: "string", multiple: true },
  slot: { type: "string" },
  type: { type: "string" },
  status: { type: "string" },
  connection: { type: "string" },
  since: { type: "string" },
  order: { type: "string", multiple: true },
  fields: { type: "string" },
  "valid-at": { type: "string" },
  "valid-during": { type: "string" },
  "include-revoked": { type: "boolean" },
  detail: { type: "string" },
  "as-of": { type: "string" },
  "as-of-read": { type: "string" },
  key: { type: "string", multiple: true },
  sources: { type: "boolean" },
} as const;
type OwnValue = string | string[] | boolean;

/** A command's own option: a string; repeated ones as a list; flags as true. */
const ownString = (o: Options, k: string): string | undefined =>
  typeof o.own[k] === "string" ? (o.own[k] as string) : undefined;
const ownList = (o: Options, k: string): string[] =>
  Array.isArray(o.own[k]) ? (o.own[k] as string[]) : [];
const ownFlag = (o: Options, k: string): boolean => o.own[k] === true;

import { jsonText } from "./untrusted.ts";
import { UsageError } from "./usage.ts";
import { type FieldInfo, foldName, parseCondition, parseConditionsJson } from "./where.ts";

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
  readonly own: Readonly<Record<string, OwnValue | undefined>>;
}

/** What a command gives: a result to write, as text and as JSON, and its exit code (default 0). */
interface Output {
  readonly json: unknown;
  readonly lines: Line[];
  readonly exit?: number;
}

interface Command {
  /** The options of this command besides the global ones (string-valued). */
  readonly options: readonly string[];
  readonly run: (o: Options, client: () => Promise<Client>) => Promise<Output>;
  /** A line to add to an error this command knows the cause of, from its own options. */
  readonly hint?: (e: ContractCallError, o: Options) => Static | undefined;
}
const command = (
  options: readonly string[],
  run: Command["run"],
  hint?: Command["hint"],
): Command => ({ options, run, ...(hint !== undefined ? { hint } : {}) });

/** Whether an error's details point at `path` in the document. */
function detailAt(e: ContractCallError, path: string): boolean {
  const details = Object.hasOwn(e.body, "details") ? e.body["details"] : undefined;
  return (
    Array.isArray(details) &&
    details.some(
      (d) => typeof d === "object" && d !== null && (d as { path?: unknown }).path === path,
    )
  );
}

/** The schema document `slot create` submits: a template's or a file's, named and timed. */
async function documentFor(o: Options): Promise<{ doc: Record<string, unknown>; chosen?: string }> {
  const slot = o.args[0];
  if (slot === undefined || o.args.length > 1) throw new UsageError(TEXTS.slotNameMissing);
  const template = ownString(o, "template");
  const file = ownString(o, "file");
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
  const given = ownString(o, "timezone");
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

/** Every table of `slot`, from the list level, page after page (at most 200 a page). */
async function tablesOf(c: Client, slot: string): Promise<string[]> {
  const out: string[] = [];
  let cursor: string | undefined;
  do {
    const page = await c.catalog({
      level: "list",
      slot,
      limit: 200,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    out.push(...page.slots.flatMap((x) => x.tables.map((tb) => tb.table)));
    cursor = page.next_cursor;
  } while (cursor !== undefined);
  return out;
}

/** A table's fields by folded name, with their type and unit, from its catalog. */
async function fieldsOf(c: Client, tableName: string): Promise<Map<string, FieldInfo>> {
  const r = await c.catalog({ level: "table", tables: [tableName] });
  return new Map(
    (r.tables[0]?.fields ?? []).map((f) => [
      foldName(f.name),
      { type: f.type, ...(f.unit !== undefined ? { unit: f.unit } : {}) },
    ]),
  );
}

/** `--key field=value` (repeatable): a state table's entity key, each value by its field's type. */
function entityKey(o: Options, fields: ReadonlyMap<string, FieldInfo>): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  ownList(o, "key").forEach((k, i) => {
    const eq = k.indexOf("=");
    if (eq <= 0) throw new UsageError(TEXTS.keyBad);
    const c = parseCondition(`${k.slice(0, eq)}=${k.slice(eq + 1)}`, fields, i + 1);
    out[c.field] = c.value;
  });
  return out;
}

/** `saveslot pending [list]` (06 §4.5): the open items by default, oldest first. */
const pendingListCommand = command(["slot", "type", "status"], async (o, client) => {
  if (o.args.length > 0) throw new UsageError(TEXTS.pendingListArgs);
  const type = ownString(o, "type");
  if (type !== undefined && !ITEM_TYPES.includes(type as never))
    throw new UsageError(TEXTS.pendingTypeBad);
  const status = ownString(o, "status");
  if (status !== undefined && status !== "all" && !ITEM_STATUSES.includes(status as never)) {
    throw new UsageError(TEXTS.pendingStatusBad);
  }
  const slot = ownString(o, "slot");
  const r = await (await client()).pending({
    ...(slot !== undefined ? { slot } : {}),
    ...(type !== undefined ? { type: type as never } : {}),
    ...(status !== undefined ? { status: status as never } : {}),
    ...(o.limit !== undefined ? { limit: o.limit } : {}),
    ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
  });
  return { json: r, lines: pendingList(r, new Date()) };
});

/** `--since`: a moment, or how long ago (`10m`, `2h`, `1d`, `30s`). */
function sinceOf(text: string, now: Date): string {
  const m = /^([0-9]{1,9})(s|m|h|d)$/.exec(text.trim());
  if (m !== null) {
    const unit = new Map([
      ["s", 1_000],
      ["m", 60_000],
      ["h", 3_600_000],
      ["d", 86_400_000],
    ]).get(m[2] as string) as number;
    return new Date(now.getTime() - Number(m[1]) * unit).toISOString();
  }
  if (Number.isNaN(Date.parse(text))) throw new UsageError(TEXTS.sinceBad);
  return text;
}

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["pending", pendingListCommand],
  ["pending list", pendingListCommand],
  [
    "pending show",
    command([], async (o, client) => {
      const [id, ...extra] = o.args;
      if (id === undefined || extra.length > 0 || !/^pi_/.test(id))
        throw new UsageError(TEXTS.pendingShowArgs);
      const r = await (await client()).pending({ id: id as `pi_${string}` });
      return { json: r, lines: pendingDetail(r, new Date()) };
    }),
  ],
  [
    "reads",
    command(["connection", "since"], async (o, client) => {
      if (o.args.length > 0) throw new UsageError(TEXTS.readsArgs);
      const connection = ownString(o, "connection");
      const since = ownString(o, "since");
      const r = await (await client()).readsList({
        ...(connection !== undefined ? { connection } : {}),
        ...(since !== undefined ? { since: sinceOf(since, new Date()) } : {}),
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
      });
      return { json: r, lines: readsList(r) };
    }),
  ],
  [
    "verify",
    command([], async (o, client) => {
      if (o.args.length > 0) throw new UsageError(TEXTS.verifyArgs);
      const r = await (await client()).logVerify();
      // Problems found: 9 (06 §6.2), with the result written all the same.
      return { json: r, lines: logVerified(r), exit: verifyFound(r) ? 9 : 0 };
    }),
  ],
  [
    "query",
    command(
      [
        "where",
        "where-json",
        "order",
        "fields",
        "valid-at",
        "valid-during",
        "include-revoked",
        "detail",
      ],
      async (o, client) => {
        const [tableName, ...extra] = o.args;
        if (tableName === undefined || extra.length > 0)
          throw new UsageError(TEXTS.queryTableMissing);
        const c = await client();
        const wheres = ownList(o, "where");
        // The fields' types make the values (06 §4.7): one catalog read, only with --where.
        const fields =
          wheres.length > 0 ? await fieldsOf(c, tableName) : new Map<string, FieldInfo>();
        const where = [
          ...wheres.map((w, i) => parseCondition(w, fields, i + 1)),
          ...parseConditionsJson(ownList(o, "where-json")),
        ];
        const order = ownList(o, "order").map((x) => {
          const m = /^([A-Za-z][A-Za-z0-9_]{0,62})(?::(asc|desc))?$/.exec(x.trim());
          if (m === null) throw new UsageError(TEXTS.orderBad);
          return {
            field: m[1] as string,
            ...(m[2] !== undefined ? { dir: m[2] as "asc" | "desc" } : {}),
          };
        });
        const fieldsShown = (ownString(o, "fields") ?? "")
          .split(",")
          .map((x) => x.trim())
          .filter((x) => x !== "");
        const during = ownString(o, "valid-during");
        let validDuring: [string, string | null] | undefined;
        if (during !== undefined) {
          const [from, to, ...more] = during.split(",").map((x) => x.trim());
          if (from === undefined || from === "" || more.length > 0)
            throw new UsageError(TEXTS.validDuringBad);
          validDuring = [from, to === undefined || to === "" ? null : to];
        }
        const detail = ownString(o, "detail");
        if (detail !== undefined && detail !== "concise" && detail !== "detailed") {
          throw new UsageError(TEXTS.detailBad);
        }
        const validAt = ownString(o, "valid-at");
        const r = await c.query({
          table: tableName,
          ...(where.length > 0 ? { where: where as never } : {}),
          ...(order.length > 0 ? { order } : {}),
          ...(fieldsShown.length > 0 ? { fields: fieldsShown } : {}),
          ...(validAt !== undefined ? { valid_at: validAt } : {}),
          ...(validDuring !== undefined ? { valid_during: validDuring } : {}),
          ...(ownFlag(o, "include-revoked") ? { include_revoked: true } : {}),
          ...(detail !== undefined ? { detail } : {}),
          ...(o.limit !== undefined ? { limit: o.limit } : {}),
          ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
        });
        return { json: r, lines: queryResult(r) };
      },
    ),
  ],
  [
    "history",
    command(["as-of", "as-of-read", "valid-at", "key", "sources", "detail"], async (o, client) => {
      const [tableName, ref, ...extra] = o.args;
      const keys = ownList(o, "key");
      if (
        tableName === undefined ||
        extra.length > 0 ||
        (ref === undefined) === (keys.length === 0)
      ) {
        throw new UsageError(TEXTS.historyTarget);
      }
      const c = await client();
      let target: Record<string, unknown>;
      if (ref !== undefined) {
        if (/^r_/.test(ref)) target = { row: ref };
        else if (/^e_/.test(ref)) target = { entity: ref };
        else throw new UsageError(TEXTS.historyTarget);
      } else {
        target = { entity_key: entityKey(o, await fieldsOf(c, tableName)) };
      }
      const asOf = ownString(o, "as-of");
      const asOfRead = ownString(o, "as-of-read");
      if (asOf !== undefined && asOfRead !== undefined) throw new UsageError(TEXTS.asOfBoth);
      const validAt = ownString(o, "valid-at");
      const detail = ownString(o, "detail");
      if (detail !== undefined && detail !== "concise" && detail !== "detailed") {
        throw new UsageError(TEXTS.detailBad);
      }
      const page = {
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
      };
      if (asOf !== undefined || asOfRead !== undefined) {
        const point =
          asOfRead !== undefined
            ? { read: asOfRead }
            : /^[0-9]{1,15}$/.test(asOf as string)
              ? Number(asOf)
              : (asOf as string);
        const r = await c.history({
          table: tableName,
          ...target,
          mode: "as_of",
          as_of: point,
          ...(validAt !== undefined ? { valid_at: validAt } : {}),
          ...(detail !== undefined ? { detail } : {}),
          ...page,
        } as never);
        return { json: r, lines: asOfResult(r as unknown as AsOfResult) };
      }
      if (validAt !== undefined || detail !== undefined) throw new UsageError(TEXTS.asOfOnly);
      const r = await c.history({
        table: tableName,
        ...target,
        mode: "timeline",
        ...(ownFlag(o, "sources") ? { expand_sources: true } : {}),
        ...page,
      } as never);
      return { json: r, lines: timelineResult(r as TimelineResult) };
    }),
  ],
  [
    "slot create",
    command(
      ["template", "file", "timezone"],
      async (o, client) => {
        const { doc, chosen } = await documentFor(o);
        const r = await (await client()).schemaDraft({ document: doc });
        return { json: r, lines: slotCreated(r, chosen) };
      },
      // The time zone the command line gave, refused: say so, and what it takes.
      (e, o) =>
        ownString(o, "timezone") !== undefined && detailAt(e, "timezone")
          ? TEXTS.timezoneRefused
          : undefined,
    ),
  ],
  [
    "slot show",
    command(["tables"], async (o, client) => {
      const [slot, ...named] = o.args;
      if (slot === undefined) throw new UsageError(TEXTS.slotShowMissing);
      const listed = [
        ...named,
        ...(ownString(o, "tables") ?? "").split(",").filter((x) => x.trim() !== ""),
      ].map((x) => x.trim());
      const c = await client();
      // No tables named: every table of the slot, as the list gives them.
      const tables = listed.length > 0 ? listed : await tablesOf(c, slot);
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
  let values: Record<string, string | string[] | boolean | undefined>;
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
        ...OWN_OPTIONS,
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
  // A command of two words (`slot list`), or of one (`query <table>`).
  const two = COMMANDS.get(positionals.slice(0, 2).join(" "));
  const found = two ?? COMMANDS.get(positionals[0] ?? "");
  const words_ = two !== undefined ? 2 : 1;
  if (found === undefined) {
    io.err(`${TEXTS.unknownCommand}\n`);
    return 2;
  }
  const own: Record<string, OwnValue> = {};
  for (const k of Object.keys(OWN_OPTIONS)) {
    const v = values[k];
    if (v === undefined) continue;
    if (!found.options.includes(k)) {
      io.err(`${TEXTS.usageError(TEXTS.optionNotHere)}\n`);
      return 2;
    }
    own[k] = v as OwnValue;
  }
  const o: Options = {
    json: values["json"] === true,
    limit,
    cursor: typeof values["cursor"] === "string" ? values["cursor"] : undefined,
    tags,
    home: resolve(
      typeof values["home"] === "string" ? values["home"] : join(homedir(), ".saveslot"),
    ),
    args: positionals.slice(words_),
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
    return r.exit ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${TEXTS.usageError(e.text)}\n`);
      return 2;
    }
    const d = describeError(e);
    const hint = e instanceof ContractCallError ? found.hint?.(e, o) : undefined;
    if (hint !== undefined) d.lines.push(t`  ${words(hint)}`);
    if (o.json && e instanceof ContractCallError) io.out(`${jsonText({ error: e.body })}\n`);
    io.err(`${render(d.lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
    return d.exit;
  }
}
