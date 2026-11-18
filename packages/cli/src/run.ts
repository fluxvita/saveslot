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
import { homedir, hostname } from "node:os";
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
  type PendingDetailResult,
  resolveCredential,
  type TimelineResult,
  TransportError,
} from "@fluxvita/saveslot-client";
import {
  APPLIES,
  addCommand,
  appliedWhy,
  createsSlots,
  entryMayGo,
  entryPath,
  HOSTS,
  type Host,
  issueAndAdd,
  issueChecked,
  onPath,
  parseScopes,
  revokeQuietly,
  writes,
} from "./connect.ts";
import { describeError, timezoneHint } from "./errors.ts";
import { logVerified, readsList, verifyFound } from "./render/admin.ts";
import {
  alreadyLines,
  appliedLines,
  connectionLine,
  connectionsList,
  hostSetup,
  revokedLines,
  selfcheckLine,
  setupShowable,
  snippetHint,
  snippetLines,
} from "./render/connections.ts";
import { pendingDetail, pendingList, resolveResult } from "./render/pending.ts";
import { asOfResult, queryResult, timelineResult } from "./render/reads.ts";
import { catalogList, catalogTables, schemaTemplates, slotCreated } from "./render/results.ts";
import { type Boundary, type Line, render, t, untrusted, words } from "./render/text.ts";
import { TEMPLATES, templateDocument } from "./templates.ts";
import { type Static, TEXTS } from "./texts.ts";

/** The options some commands have; any other command given one is a usage error. */
const OWN_OPTIONS = {
  template: { type: "string", multiple: true },
  file: { type: "string" },
  timezone: { type: "string" },
  tables: { type: "string" },
  where: { type: "string", multiple: true },
  "where-json": { type: "string", multiple: true },
  candidate: { type: "string" },
  "item-ver": { type: "string" },
  note: { type: "string" },
  "evidence-json": { type: "string" },
  yes: { type: "boolean" },
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
  name: { type: "string" },
  scope: { type: "string", multiple: true },
  slots: { type: "string" },
  apply: { type: "boolean" },
  lang: { type: "string" },
  host: { type: "string", multiple: true },
} as const;
type OwnValue = string | string[] | boolean;

/** A command's own option: a string; repeated ones as a list; flags as true. */
const ownString = (o: Options, k: string): string | undefined =>
  typeof o.own[k] === "string" ? (o.own[k] as string) : undefined;
const ownList = (o: Options, k: string): string[] =>
  Array.isArray(o.own[k]) ? (o.own[k] as string[]) : [];
const ownFlag = (o: Options, k: string): boolean => o.own[k] === true;

import { allConnections, everyPage } from "./pages.ts";
import { type SetupServices, STOP_SIGNALS, type StopSignal, setup } from "./setup.ts";
import { jsonText } from "./untrusted.ts";
import { Failed, NotDone, UsageError } from "./usage.ts";
import { type FieldInfo, foldName, parseCondition, parseConditionsJson } from "./where.ts";

export interface CliIO {
  /** Writes to stdout; a promise of false when it could not be written (stdout closed). */
  readonly out: (text: string) => unknown;
  readonly err: (text: string) => void;
  /** Whether stdout and stderr are terminals. */
  readonly stdoutIsTTY: boolean;
  readonly stderrIsTTY: boolean;
  /** Whether stdin is a terminal: only then does a command ask (06 §5.4). */
  readonly stdinIsTTY?: boolean;
  /** Writes `prompt` to stderr and reads one line from stdin; undefined when stdin ends. */
  readonly ask?: (prompt: string) => Promise<string | undefined>;
  /** The path this program was started by, absolute, links kept (`connect` puts it in commands). */
  readonly entry?: string;
  /** Tests only: how long `connect --apply` lets the host's command run (60 s otherwise). */
  readonly hostTimeoutMs?: number;
  /** Tests only: how long `setup` lets a host's version and look-up commands run (5 s otherwise). */
  readonly probeTimeoutMs?: number;
  /** Tests only: the platform `setup` takes this one for. */
  readonly platform?: NodeJS.Platform;
  /** Tests only: this computer's name, as `setup` names instances after it. */
  readonly hostname?: string;
  /** Tests only: how `setup` hears of SIGINT and SIGTERM (the process's own otherwise). */
  readonly watchSignals?: (on: (signal: StopSignal) => void) => () => void;
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
  /** The service's side, for `setup` (the entry package hands it in). */
  readonly services: SetupServices | undefined;
}

/** What a command gives: a result to write, as text and as JSON, and its exit code (default 0). */
interface Output {
  readonly json: unknown;
  /** Nothing on stdout when there are none (and no --json). */
  readonly lines: Line[];
  /** Lines for stderr, written before stdout's. */
  readonly errLines?: Line[];
  /** When stdout could not be written: what to do about it, and what to say on stderr then. */
  readonly unwritten?: () => Promise<Line[]>;
  readonly exit?: number;
}

interface Command {
  /** The options of this command besides the global ones (string-valued). */
  readonly options: readonly string[];
  readonly run: (o: Options, client: () => Promise<Client>, io: CliIO, env: Env) => Promise<Output>;
  /** What to say when the connection broke after the request went: where to see what happened. */
  readonly whenBroken?: Static;
  /** A line to add to an error this command knows the cause of, from its own options. */
  readonly hint?: (e: ContractCallError, o: Options) => Static | undefined;
}
const command = (
  options: readonly string[],
  run: Command["run"],
  hint?: Command["hint"],
  whenBroken?: Static,
): Command => ({
  options,
  run,
  ...(hint !== undefined ? { hint } : {}),
  ...(whenBroken !== undefined ? { whenBroken } : {}),
});

/** The schema document `slot create` submits: a template's or a file's, named and timed. */
async function documentFor(o: Options): Promise<{ doc: Record<string, unknown>; chosen?: string }> {
  const slot = o.args[0];
  if (slot === undefined || o.args.length > 1) throw new UsageError(TEXTS.slotNameMissing);
  const templates = ownList(o, "template");
  // Repeatable for `setup`; one template makes one slot here.
  if (templates.length > 1) throw new UsageError(TEXTS.optionTwice);
  const template = templates[0];
  const file = ownString(o, "file");
  if ((template === undefined) === (file === undefined)) throw new UsageError(TEXTS.createNeedsOne);
  const given = ownString(o, "timezone");
  if (template !== undefined) {
    const made = templateDocument(template, slot, given);
    if (made === undefined) throw new UsageError(TEXTS.templateUnknown);
    return made;
  }
  let v: unknown;
  try {
    v = JSON.parse(await readFile(resolve(file as string), "utf8"));
  } catch {
    throw new UsageError(TEXTS.fileUnreadable);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) {
    throw new UsageError(TEXTS.fileUnreadable);
  }
  const doc = v as Record<string, unknown>;
  // The name is the command line's; a new slot has no base version (06 §3 step 4); a file keeps
  // its own time zone unless one is given.
  doc["slot"] = slot;
  doc["base_version"] = null;
  if (given !== undefined) doc["timezone"] = given;
  return { doc };
}

/** Every table of `slot`, from the list level, page after page (at most 200 a page). */
async function tablesOf(c: Client, slot: string): Promise<string[]> {
  return everyPage(async (cursor) => {
    const page = await c.catalog({
      level: "list",
      slot,
      limit: 200,
      ...(cursor !== undefined ? { cursor } : {}),
    });
    return {
      items: page.slots.flatMap((x) => x.tables.map((tb) => tb.table)),
      next: page.next_cursor,
    };
  });
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

/** The decisions this version resolves, and the kind of item each is for (06 §7: P1). */
const DECISIONS_NOW: ReadonlyMap<string, string> = new Map([
  ["confirm", "awaiting_confirmation"],
  ["reject", "awaiting_confirmation"],
  ["keep_effective", "conflict"],
  ["take_candidate", "conflict"],
  ["take_previous", "conflict"],
]);

/** `--evidence-json <file>`: evidence segments, or `{evidence, evidence_by_field}` (04-contract-types §5.2). */
async function evidenceOf(file: string | undefined): Promise<Record<string, unknown>> {
  if (file === undefined) return {};
  let v: unknown;
  try {
    v = JSON.parse(await readFile(resolve(file), "utf8"));
  } catch {
    throw new UsageError(TEXTS.evidenceBad);
  }
  if (Array.isArray(v)) return { evidence: v };
  if (typeof v !== "object" || v === null) throw new UsageError(TEXTS.evidenceBad);
  const o = v as Record<string, unknown>;
  if (Object.keys(o).some((k) => k !== "evidence" && k !== "evidence_by_field")) {
    throw new UsageError(TEXTS.evidenceBad);
  }
  return o;
}

/**
 * `saveslot pending resolve <pi_…> <decision>` (06 §5.2, §5.4). Asked on a terminal: the item is
 * read, shown, and the decision sent with the version of that very read (never the version the
 * service would fall back to). With --yes: the --item-ver given, the item not read. Not a
 * terminal and no --yes: not done (8).
 */
async function resolveCommand(
  o: Options,
  client: () => Promise<Client>,
  io: CliIO,
  env: Env,
): Promise<Output> {
  const [pid, decision, ...extra] = o.args;
  // The ID goes into the question as it is: only an ID of its exact shape is taken.
  if (
    pid === undefined ||
    decision === undefined ||
    extra.length > 0 ||
    !/^pi_[0-9A-HJKMNP-TV-Z]{16}$/.test(pid)
  ) {
    throw new UsageError(TEXTS.resolveArgs);
  }
  if (!DECISIONS_NOW.has(decision)) throw new UsageError(TEXTS.decisionNotYet);
  const candidateText = ownString(o, "candidate");
  if (candidateText !== undefined && !/^[0-9]{1,6}$/.test(candidateText)) {
    throw new UsageError(TEXTS.candidateBad);
  }
  let candidate = candidateText !== undefined ? Number(candidateText) : undefined;
  const given = ownString(o, "item-ver");
  const note = ownString(o, "note");
  const evidence = await evidenceOf(ownString(o, "evidence-json"));
  const id = pid as `pi_${string}`;
  const send = async (itemVer: string | undefined) =>
    (await client()).resolve({
      id,
      decision: decision as never,
      ...(itemVer !== undefined ? { item_ver: itemVer as never } : {}),
      ...(candidate !== undefined ? { candidate } : {}),
      ...(note !== undefined ? { note } : {}),
      ...evidence,
    });
  if (ownFlag(o, "yes")) {
    if (given === undefined) throw new NotDone(TEXTS.yesNeedsItemVer);
    const r = await send(given);
    return { json: r, lines: resolveResult(r) };
  }
  if (io.stdinIsTTY !== true || io.ask === undefined) throw new NotDone(TEXTS.noTerminal);
  const ask = io.ask;
  const say = (lines: Line[]) =>
    io.err(`${render(lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
  // A version that changed under the question is shown again and asked again, a few times.
  let shown: PendingDetailResult | undefined;
  for (let round = 0; round < 3; round++) {
    const detail = shown ?? (await (await client()).pending({ id }));
    shown = undefined;
    const d = detail as unknown as Record<string, unknown>;
    if (d["status"] !== "open") {
      say([...pendingDetail(detail, new Date()), [words(TEXTS.closed)]]);
      return { json: detail, lines: [], exit: 3 };
    }
    if (d["type"] !== DECISIONS_NOW.get(decision)) throw new UsageError(TEXTS.itemTypeNotYet);
    say(pendingDetail(detail, new Date()));
    if (given !== undefined && given !== d["item_ver"] && round === 0)
      say([[words(TEXTS.changedSince)]]);
    if (decision === "take_candidate" && candidate === undefined) {
      const indexes = (Array.isArray(d["candidates"]) ? d["candidates"] : []).map(
        (c) => (c as { index: number }).index,
      );
      if (indexes.length === 1) candidate = indexes[0];
      while (candidate === undefined) {
        const a = (await ask(`${TEXTS.candidateNumber} (${indexes.join(", ")}): `))?.trim();
        if (a === undefined) throw new NotDone(TEXTS.declined);
        if (/^[0-9]{1,6}$/.test(a) && indexes.includes(Number(a))) candidate = Number(a);
      }
    }
    const answer = await ask(`${decision} ${id}? [y/N] `);
    if (!/^(y|yes)$/i.test((answer ?? "").trim())) throw new NotDone(TEXTS.declined);
    try {
      const r = await send(String(d["item_ver"]));
      return { json: r, lines: resolveResult(r) };
    } catch (e) {
      // Changed between the question and the answer: the new content is shown, and asked again.
      if (!(e instanceof ContractCallError) || e.code !== "confirmation_mismatch") throw e;
      const current = e.body["current"];
      if (typeof current === "object" && current !== null) shown = current as PendingDetailResult;
      say([[words(TEXTS.changedSince)]]);
    }
  }
  throw new NotDone(TEXTS.keptChanging);
}

/**
 * `saveslot connect <host>` (06 §3.2): issue, self-check with the new token, then the host's setup
 * with the token in it, on stdout, once; with `--apply`, the host's command run as well. The token
 * is in this function's memory and in what it writes to stdout (and in the host command's
 * arguments): never on stderr, never in an error.
 */
async function connectCommand(
  o: Options,
  client: () => Promise<Client>,
  io: CliIO,
  env: Env,
): Promise<Output> {
  const [hostName, ...extra] = o.args;
  if (
    hostName === undefined ||
    extra.length > 0 ||
    !(HOSTS as readonly string[]).includes(hostName)
  )
    throw new UsageError(TEXTS.connectArgs);
  const host = hostName as Host;
  const connectionName = ownString(o, "name");
  if (connectionName === undefined || connectionName.trim() === "")
    throw new UsageError(TEXTS.nameMissing);
  if (ownString(o, "slots") !== undefined) throw new UsageError(TEXTS.slotsNotYet);
  const apply = ownFlag(o, "apply");
  if (apply && !APPLIES.has(host)) throw new UsageError(TEXTS.applyNotHere);
  const scopes = parseScopes(ownList(o, "scope"));
  // The path the host starts saveslot by: checked before anything is issued.
  const entry = host === "http" ? "" : await entryPath(io.entry);
  const notes: Line[] = entryMayGo(entry) ? [[words(TEXTS.entryMayGo)]] : [];
  // `--apply`: the host's executable, found on PATH before anything is issued; run and shown by
  // that absolute path, so that what is shown is what ran.
  const exe = apply
    ? await onPath((addCommand(host, "", entry) as string[])[0] as string, env["PATH"])
    : undefined;
  if (apply && exe === undefined) throw new Failed(TEXTS.applyNotFound, 1);
  if (!setupShowable(host, entry, socketOf(o), exe)) throw new Failed(TEXTS.setupUnshowable, 1);

  const session = await client();
  const params = { name: connectionName, ...(scopes !== undefined ? { scopes } : {}) };
  // With --apply, the one way a host is given an instance (as `setup` does); else issued only.
  const added = apply
    ? await issueAndAdd({
        session,
        socketPath: socketOf(o),
        params,
        host,
        exe: exe as string,
        entry,
        env,
        timeoutMs: io.hostTimeoutMs,
      })
    : undefined;
  const checked = added?.checked ?? (await issueChecked(session, socketOf(o), params));
  const { connection } = checked;
  if (checked.kind !== "ready") {
    // Issued and not usable: revoked, the token not shown, why said without it; 1.
    const e = checked.error;
    const why =
      checked.kind === "malformed"
        ? [[words(TEXTS.tokenMalformed)]]
        : // The new token was refused: the general next step (about SAVESLOT_TOKEN) is not this one's.
          [[words(TEXTS.selfcheckFailed)], ...describeError(e, { nextStep: false }).lines];
    return {
      json: {
        error:
          checked.kind === "malformed"
            ? { code: "internal", message: "token_malformed" }
            : e instanceof ContractCallError
              ? e.body
              : { code: "internal" },
        connection: { id: connection.id, name: connection.name, revoked: checked.revoked },
      },
      lines: [],
      errLines: [
        ...notes,
        ...why,
        t`  ${connectionLine(connection)}`,
        [words(checked.revoked ? TEXTS.selfcheckRevoked : TEXTS.selfcheckNotRevoked)],
      ],
      exit: 1,
    };
  }
  const { token, slots, more, issued } = checked;
  const revoke = () => revokeQuietly(session, connection.id);
  // The token's only copy is in the output: lost with it, the instance is no one's.
  const lost = async (): Promise<Line[]> =>
    (await revoke())
      ? [[words(TEXTS.outputLostRevoked)], t`  ${connectionLine(connection)}`]
      : [[words(TEXTS.selfcheckNotRevoked)], t`  ${connectionLine(connection)}`];

  const head: Line[] = [
    t`${words(TEXTS.issued)} ${connectionLine(connection)}`,
    selfcheckLine(slots, more),
    ...(createsSlots(scopes) ? [] : [[words(TEXTS.noSchemaHint(writes(scopes)))]]),
  ];
  const selfcheck = { slots, ...(more ? { more: true } : {}) };
  if (!apply) {
    return {
      json: { ...issued, selfcheck },
      lines: [...head, ...hostSetup(host, token, entry, socketOf(o)), ...snippetHint(host)],
      errLines: [...notes, [words(TEXTS.tokenOnce)]],
      unwritten: lost,
    };
  }
  const ran = (added as Extract<typeof added, { kind: "ran" }>).ran;
  const ok = ran.kind === "done";
  const why = appliedWhy(ran);
  return {
    json: { ...issued, selfcheck, applied: ok },
    lines: [...head, ...appliedLines(host, token, entry, exe as string, ok), ...snippetHint(host)],
    // Run, the host has the token, and the output has it only with --json; failed, the output is
    // where it is.
    errLines: ok
      ? notes
      : [...notes, [words(why)], [words(TEXTS.applyKept)], [words(TEXTS.tokenOnce)]],
    ...(ok ? {} : { unwritten: lost }),
    exit: ok ? 0 : 1,
  };
}

/** `saveslot connections revoke <name or ID>` (06 §4.9): asked first, unless `--yes`. */
async function revokeCommand(
  o: Options,
  client: () => Promise<Client>,
  io: CliIO,
  env: Env,
): Promise<Output> {
  const [which, ...extra] = o.args;
  if (which === undefined || extra.length > 0) throw new UsageError(TEXTS.revokeArgs);
  const c = await client();
  // By ID over the whole list first; by name only when no ID is it. A name can look like another
  // instance's ID, and two instances can share a name: that one is not guessed at.
  const all = await allConnections(c);
  const named = all.filter((x) => x.name === which);
  const found = all.find((x) => x.id === which) ?? (named.length === 1 ? named[0] : undefined);
  if (found === undefined && named.length > 1) {
    return {
      json: { error: { code: "ambiguous_name", ids: named.map((x) => x.id) } },
      lines: [],
      errLines: [[words(TEXTS.nameAmbiguous)], ...named.map((x) => t`  ${connectionLine(x)}`)],
      exit: 2,
    };
  }
  if (found === undefined) throw new Failed(TEXTS.connectionNotFound, 4);
  if (found.state !== undefined) return { json: found, lines: alreadyLines(found) };
  if (!ownFlag(o, "yes")) {
    if (io.stdinIsTTY !== true || io.ask === undefined) throw new NotDone(TEXTS.revokeNoTerminal);
    const prompt = render(
      [t`${words(TEXTS.revokeAsk)} ${connectionLine(found)}? [y/N] `],
      boundaryFor(io.stderrIsTTY, o.tags, env),
    );
    const answer = await io.ask(prompt);
    if (!/^(y|yes)$/i.test((answer ?? "").trim())) throw new NotDone(TEXTS.declined);
  }
  const r = await c.connections.revoke({ id: found.id });
  return { json: r, lines: revokedLines(r) };
}

const socketOf = (o: Options) => join(o.home, "run", "saveslot.sock");

/**
 * SIGINT, SIGTERM, SIGHUP (the terminal closed) and SIGQUIT to `on` while `setup` runs, in place of
 * ending the process at once: it then stops cleanly (06 §3.3 item 8).
 */
function watchProcessSignals(on: (signal: StopSignal) => void): () => void {
  const handlers = STOP_SIGNALS.map((sig) => [sig, () => on(sig)] as const);
  for (const [sig, h] of handlers) process.on(sig, h);
  return () => {
    for (const [sig, h] of handlers) process.off(sig, h);
  };
}

/** `saveslot setup` (06 §3.3): ./setup.ts, with the command line and this process. */
async function setupCommand(
  o: Options,
  client: () => Promise<Client>,
  io: CliIO,
  env: Env,
): Promise<Output> {
  if (o.args.length > 0) throw new UsageError(TEXTS.setupArgs);
  if (o.services === undefined) throw new Failed(TEXTS.setupNotHere, 2);
  const r = await setup({
    home: o.home,
    socket: socketOf(o),
    json: o.json,
    yes: ownFlag(o, "yes"),
    templates: ownList(o, "template"),
    timezone: ownString(o, "timezone"),
    hosts: ownList(o, "host"),
    scopes: ownList(o, "scope"),
    env,
    // Asked only where someone sees the questions: stdin, and stderr where they are written.
    stdinTerminal: io.stdinIsTTY === true && io.ask !== undefined,
    stderrTerminal: io.stderrIsTTY,
    ask: io.ask,
    entry: io.entry,
    platform: io.platform ?? process.platform,
    hostname: io.hostname ?? (hostname().split(".")[0] as string),
    probeTimeoutMs: io.probeTimeoutMs,
    hostTimeoutMs: io.hostTimeoutMs,
    say: (lines) => io.out(`${render(lines, boundaryFor(io.stdoutIsTTY, o.tags, env))}\n`),
    sayErr: (lines) => io.err(`${render(lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`),
    passOn: { out: (l) => io.out(`${l}\n`), err: (l) => io.err(`${l}\n`) },
    client,
    services: o.services,
    watchSignals: io.watchSignals ?? watchProcessSignals,
  });
  return { json: r.json, lines: r.lines, errLines: r.errLines, exit: r.exit };
}

/** `--detail detailed` refused (P2, with premises): what to do instead (06 §4.7). */
const detailNotYet: Command["hint"] = (e, o) =>
  e.code === "not_in_this_version" && ownString(o, "detail") === "detailed"
    ? TEXTS.detailedNotYet
    : undefined;

const COMMANDS: ReadonlyMap<string, Command> = new Map<string, Command>([
  ["setup", command(["template", "timezone", "host", "scope", "yes"], setupCommand)],
  [
    "connect",
    command(["name", "scope", "slots", "apply"], connectCommand, undefined, TEXTS.connectUnknown),
  ],
  [
    "connections list",
    command([], async (o, client) => {
      if (o.args.length > 0) throw new UsageError(TEXTS.connectionsListArgs);
      const r = await (await client()).connections.list({
        include_revoked: true,
        ...(o.limit !== undefined ? { limit: o.limit } : {}),
        ...(o.cursor !== undefined ? { cursor: o.cursor } : {}),
      });
      return { json: r, lines: connectionsList(r) };
    }),
  ],
  ["connections revoke", command(["yes"], revokeCommand, undefined, TEXTS.revokeUnknown)],
  [
    "snippet",
    command(["lang"], async (o) => {
      const [host, ...extra] = o.args;
      if (extra.length > 0 || (host !== undefined && !TEXTS.snippetPlace.has(host)))
        throw new UsageError(TEXTS.snippetArgs);
      const lang = ownString(o, "lang") ?? "en";
      if (lang !== "en" && lang !== "zh-CN") throw new UsageError(TEXTS.langBad);
      const lines = snippetLines(host, lang);
      const snippet = (TEXTS.snippet.get(lang) ?? []).join("\n");
      return { json: { snippet, ...(host !== undefined ? { host } : {}) }, lines };
    }),
  ],
  ["pending", pendingListCommand],
  ["pending list", pendingListCommand],
  [
    "pending resolve",
    command(
      ["candidate", "item-ver", "note", "evidence-json", "yes"],
      resolveCommand,
      undefined,
      TEXTS.unknownOutcome,
    ),
  ],
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
      detailNotYet,
    ),
  ],
  [
    "history",
    command(
      ["as-of", "as-of-read", "valid-at", "key", "sources", "detail"],
      async (o, client) => {
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
      },
      detailNotYet,
    ),
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
      (e, o) => timezoneHint(e, ownString(o, "timezone") !== undefined),
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

/**
 * `--scope -write` as 06 §3.2 writes it: a value that begins with `-` is taken for an option by the
 * parser, so `--scope` and such a value are joined (`--scope=-write`) first.
 */
function scopeValuesJoined(argv: readonly string[]): string[] {
  const out: string[] = [];
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] as string;
    const next = argv[i + 1];
    if (a === "--") {
      out.push(...argv.slice(i));
      break;
    }
    if (a === "--scope" && next !== undefined && next.startsWith("-") && next !== "--") {
      out.push(`--scope=${next}`);
      i++;
    } else out.push(a);
  }
  return out;
}

/** Runs one command line (without the program name); resolves with its exit code. */
export async function run(
  argv: readonly string[],
  env: Env,
  io: CliIO,
  services?: SetupServices,
): Promise<number> {
  let values: Record<string, string | string[] | boolean | undefined>;
  let positionals: string[];
  let tokens: ReturnType<typeof parseArgs>["tokens"];
  try {
    ({ values, positionals, tokens } = parseArgs({
      args: scopeValuesJoined(argv),
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
      tokens: true,
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
  // A command's option of one value given twice is not taken as the last one given (06 §6.2).
  for (const [k, spec] of Object.entries(OWN_OPTIONS)) {
    if (spec.type !== "string" || "multiple" in spec) continue;
    if ((tokens ?? []).filter((x) => x.kind === "option" && x.name === k).length > 1) {
      io.err(`${TEXTS.usageError(TEXTS.optionTwice)}\n`);
      return 2;
    }
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
    services,
  };
  const client = async () => {
    const credential = await resolveCredential({ home: o.home, env });
    return createClient({ socketPath: socketOf(o), token: credential.token });
  };
  try {
    const r = await found.run(o, client, io, env);
    if (r.errLines !== undefined && r.errLines.length > 0) {
      io.err(`${render(r.errLines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
    }
    const text = o.json
      ? `${jsonText(r.json)}\n`
      : r.lines.length > 0
        ? `${render(r.lines, boundaryFor(io.stdoutIsTTY, o.tags, env))}\n`
        : undefined;
    if (text !== undefined && (await io.out(text)) === false) {
      const said: Line[] = [[words(TEXTS.outputLost)], ...((await r.unwritten?.()) ?? [])];
      io.err(`${render(said, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
      return 1;
    }
    return r.exit ?? 0;
  } catch (e) {
    if (e instanceof UsageError) {
      io.err(`${TEXTS.usageError(e.text)}\n`);
      return 2;
    }
    if (e instanceof NotDone) {
      io.err(`${e.text}\n`);
      return 8;
    }
    if (e instanceof Failed) {
      io.err(`${e.text}\n`);
      return e.exit;
    }
    const d = describeError(e);
    const hint = e instanceof ContractCallError ? found.hint?.(e, o) : undefined;
    if (hint !== undefined) d.lines.push(t`  ${words(hint)}`);
    // The request went and the answer did not come: say where to see whether it took effect.
    if (e instanceof TransportError && e.code === "broken" && found.whenBroken !== undefined) {
      d.lines.push(t`  ${words(found.whenBroken)}`);
    }
    if (o.json && e instanceof ContractCallError) io.out(`${jsonText({ error: e.body })}\n`);
    io.err(`${render(d.lines, boundaryFor(io.stderrIsTTY, o.tags, env))}\n`);
    return d.exit;
  }
}
