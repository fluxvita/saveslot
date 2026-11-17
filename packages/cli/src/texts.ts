// Every static text the CLI writes (docs/zh-CN/spec/06-cli.md §4, §6), here and nowhere else, in
// English. None holds a token, a path or a value from a result: those are parts the renderers add.

import type { ErrorCode } from "@fluxvita/saveslot-client";

declare const brand: unique symbol;
/**
 * A text of saveslot's own, fixed in this file: the only kind of string the renderers take as
 * their own wording (`words` in ./render/text.ts). Only this file makes one.
 */
export type Static = string & { readonly [brand]: true };
const s = (text: string): Static => text as Static;

/** Spaces to line things up: their number is the renderer's, the text is spaces only. */
export const gap = (n: number): Static => s(" ".repeat(Math.max(0, Math.trunc(n))));

export const TEXTS = {
  usage: s(
    [
      "usage: saveslot <command> [options]",
      "",
      "  slot list                 the slots and their tables",
      "  slot show <slot> [table…]  a slot's tables: fields, rule, rows",
      "  slot create <name> --template <template> | --file <schema.json> [--timezone <zone>]",
      "  query <table> [--where 'field<op>value']… [--where-json <json>] [--order f[:desc]] [--fields a,b]",
      "        quote a condition with < or > in it, or the shell takes it as a redirection",
      "  history <table> <row or entity> | --key field=value … [--as-of <#seq or moment>] [--sources]",
      "  pending [list] [--slot s] [--type t] [--status open|resolved|superseded|all]",
      "  pending show <pi_…>",
      "  pending resolve <pi_…> <decision> [--candidate n] [--note text] [--yes --item-ver iv_…]",
      "  reads [--connection <name or ID>] [--since 10m]",
      "  verify                    check the log: chain, checksums, index, gaps",
      "  connect <host> --name <name> [--scope +schema | -write | read,write…] [--apply]",
      "        hosts: claude-code, codex, cursor, claude-desktop, generic, http",
      "  connections list          the connection instances, revoked ones too",
      "  connections revoke <name or ci_…> [--yes]",
      "  snippet [<host>] [--lang en|zh-CN]   text for the host's custom instructions",
      "  schema templates          the schema templates this saveslot ships",
      "",
      "  init | start | stop | status | config get | mcp   the local service",
      "",
      "options: --json  --limit <n>  --cursor <handle>  --untrusted-tags auto|always|never",
    ].join("\n"),
  ),
  usageError: (what: Static) => s(`error: ${what}. See saveslot --help.`),
  badArguments: s("error: the arguments are not the command's (see saveslot --help):"),
  unknownCommand: s("error: not a command of saveslot. See saveslot --help."),
  profileNotYet: s(
    "error: --profile is not in this version: saveslot connects to the local service only.",
  ),
  limitInvalid: s("--limit takes a whole number from 1"),
  optionTwice: s("an option that takes one value was given twice"),
  untrustedTagsInvalid: s("--untrusted-tags takes auto, always or never"),

  /** The next step after a contract error, by code (06 §6.3); none for the codes not listed. */
  nextStep: new Map<ErrorCode, Static>([
    ["unauthenticated", s("Check SAVESLOT_TOKEN, or unset it to run as the user session.")],
    ["insufficient_scope", s("This connection instance has no scope for that.")],
    ["unavailable", s("Try again shortly; see saveslot status.")],
    ["unknown_table", s("See the tables with saveslot slot list.")],
    ["internal", s("The service log is in run/saveslot.log under the home.")],
  ]),
  credential: (c: "not_initialized" | "permissions" | "malformed"): Static =>
    c === "not_initialized"
      ? s("error: no user session here. Run saveslot init first, or set SAVESLOT_TOKEN.")
      : c === "permissions"
        ? s(
            "error: the credentials are open to others, or not this user's; saveslot will not use them. Make the home and credentials/ 0700 and the session file 0600.",
          )
        : s(
            "error: SAVESLOT_TOKEN, or the session file, does not hold a token of its form. Unset SAVESLOT_TOKEN to run as the user session.",
          ),
  transport: (c: "unreachable" | "broken" | "bad_answer"): Static =>
    c === "unreachable"
      ? s("error: the saveslot service is not running. Start it with saveslot start.")
      : c === "broken"
        ? s(
            "error: the connection to the saveslot service broke, or it did not answer in time. Try again; see saveslot status.",
          )
        : s(
            "error: the saveslot service gave an answer saveslot cannot read. See saveslot status.",
          ),
  internal: s(
    "error: saveslot failed. This is a bug; the service log is in run/saveslot.log under the home.",
  ),

  // slot list
  noSlots: s("No slots yet. Create one with saveslot slot create <name> --template <template>."),
  slotHead: s("slot"),
  schemaVersion: s("schema v"),
  derived: s("derived, read-only"),
  migrating: s("migrating"),
  more: s("more:"),
  shownOf: (shown: number, total: number) => s(`${shown} of ${total} shown`),

  // slot show
  eventBy: s("base · event, by"),
  stateBy: s("base · state, by"),
  noTime: s("base · no time"),
  decimals: s(" decimal places"),
  required: s("required"),
  rule: s("rule"),
  rows: s("rows:"),

  // slot create
  created: s("Created slot"),
  tables: s("tables"),
  timezoneRefused: s(
    "The --timezone given is not a time zone the service knows: give a zone name such as Asia/Shanghai or UTC.",
  ),
  timezoneChosen: s("time zone: this computer's, as no --timezone was given:"),
  awaitingConfirmation: s("awaiting confirmation; see saveslot pending show"),
  createNeedsOne: s("give one of --template <template> and --file <schema.json>"),
  templateUnknown: s("not a template of this saveslot; see saveslot schema templates"),
  fileUnreadable: s("the --file cannot be read, or is not a JSON object"),
  slotNameMissing: s("give the slot's name: saveslot slot create <name>"),
  optionNotHere: s("that option is not one of this command's"),
  slotShowMissing: s("give the slot: saveslot slot show <slot> [table…]"),
  detail: s("  at"),

  // pending resolve (06 §5.2, §5.4)
  itemVersionNow: s("the item's version now:"),
  resolveArgs: s("give the item and the decision: saveslot pending resolve <pi_…> <decision>"),
  decisionNotYet: s(
    "that decision is not in this version: confirm and reject (a change awaiting confirmation), keep_effective, take_candidate and take_previous (a conflict)",
  ),
  itemTypeNotYet: s(
    "this kind of item is not resolved by this version of the CLI (a flagged item comes in a later version, a schema change too)",
  ),
  yesNeedsItemVer: s(
    "--yes resolves without showing the item: give the version that was shown with --item-ver (saveslot pending show <pi_…> --json has it)",
  ),
  noTerminal: s(
    "not run: stdin is no terminal to ask on. Read the item with saveslot pending show <pi_…> --json, then run this again with --yes and --item-ver",
  ),
  closed: s("the item is closed already; nothing was done"),
  changedSince: s("the item changed since the version given; this is what it is now"),
  declined: s("not done"),
  keptChanging: s(
    "not done: the item changed each time it was asked about. Try again shortly (saveslot pending show <pi_…>)",
  ),
  candidateNumber: s("which candidate? give its number"),
  candidateBad: s("--candidate takes a candidate's number, as pending show lists them"),
  evidenceBad: s(
    "--evidence-json takes a file of JSON: evidence segments, or {evidence, evidence_by_field}",
  ),
  unknownOutcome: s(
    "the connection broke before the answer: it is not known whether the decision was recorded. See saveslot pending show <pi_…>",
  ),

  // pending, reads, verify (06 §4.5, §4.8)
  pendingListArgs: s("saveslot pending [list] takes options only: --slot, --type, --status"),
  pendingShowArgs: s("give the item: saveslot pending show <pi_…>"),
  pendingTypeBad: s(
    "--type takes conflict, awaiting_confirmation, flagged, schema_change or deletion",
  ),
  pendingStatusBad: s("--status takes open, resolved, superseded or all"),
  readsArgs: s("saveslot reads takes options only: --connection, --since"),
  sinceBad: s("--since takes a moment (RFC 3339) or how long ago: 30s, 10m, 2h, 1d"),
  verifyArgs: s("saveslot verify takes no arguments"),

  // query and history (06 §4.7)
  queryTableMissing: s("give the table: saveslot query <table> [--where 'field>value']…"),
  orderBad: s("--order takes a field, with :asc or :desc after it if wanted"),
  validDuringBad: s("--valid-during takes <from>,<to>; leave <to> out for an open end"),
  detailBad: s("--detail takes concise or detailed"),
  historyTarget: s(
    "give the table and a row (r_…) or an entity (e_…), or a state table's --key field=value instead",
  ),
  keyBad: s("--key takes field=value"),
  asOfBoth: s("give one of --as-of and --as-of-read"),
  asOfOnly: s("--valid-at and --detail are for --as-of / --as-of-read"),

  whereNoField: (n: number) => s(`--where number ${n} does not begin with a field name`),
  whereNoOperator: (n: number, at: number) =>
    s(
      `--where number ${n} has no operator at character ${at}: one of = != < <= > >= (in, contains and is_null go in --where-json)`,
    ),
  whereNoValue: (n: number) => s(`--where number ${n} has no value after its operator`),
  whereBadString: (n: number) => s(`--where number ${n}: a value in quotes is a JSON string`),
  whereNotNumber: (n: number) => s(`--where number ${n}: the field takes a number`),
  whereUnitMissing: (n: number) =>
    s(`--where number ${n}: the field is a quantity; write its unit after the number (5km)`),
  whereNotBoolean: (n: number) => s(`--where number ${n}: the field takes true or false`),
  whereJsonBad: (n: number) =>
    s(`--where-json number ${n} is not a JSON condition object, or an array of them`),

  // connect, connections, snippet (06 §3.2, §3.4, §4.9)
  connectArgs: s(
    "give the host: saveslot connect claude-code|codex|cursor|claude-desktop|generic|http --name <name>",
  ),
  nameMissing: s('give the connection instance a name: --name "<device> · <host>"'),
  slotsNotYet: s("--slots is not in this version: a connection instance sees every slot"),
  applyNotHere: s(
    "--apply runs a host's add command: claude-code and codex have one; for the others, paste what connect prints",
  ),
  scopeBad: s("--scope takes scope names, comma separated: +schema, -write, or read,write,schema"),
  scopeMixed: s(
    "--scope is either changes to the default (+schema, -write) or the whole set (read,write), not both",
  ),
  scopeUnknown: s("--scope takes read, write, schema and delete (saveslot. in front or not)"),
  scopeNoRead: s(
    "every connection instance has saveslot.read: -read, or a set without read, is refused",
  ),
  entryUnusable: s(
    "error: the path this saveslot was started by is not an executable file this host could start (or cannot be shown as it is); nothing was issued. Run saveslot by its installed path",
  ),
  setupUnshowable: s(
    "error: what this host would be given cannot be shown as it is (in its configuration, the socket's path or the host's command, a character that would be escaped); nothing was issued",
  ),
  entryMayGo: s(
    "note: saveslot was started from npx's cache: the path in the command may stop working after an upgrade or when the cache is cleared. Install it (npm install -g @fluxvita/saveslot) for a lasting one",
  ),
  issued: s("issued connection instance"),
  scopeWord: s("scope"),
  selfcheckPassed: s("self-check passed: the new token read"),
  selfcheckSlots: s("slot(s)"),
  selfcheckMore: s("or more"),
  tokenOnce: s(
    "The token is shown this once and kept nowhere. If it is lost, revoke this connection instance (saveslot connections revoke) and connect again under another name",
  ),
  pasteCommand: s("Paste this command into a terminal:"),
  pasteConfig: s("Put this in the host's MCP configuration, as a server of its own:"),
  pasteHttp: s("Send the token as Authorization: Bearer <token> on the socket:"),
  pasteGeneric: s("An MCP client's server entry:"),
  socketWord: s("socket"),
  tokenOnceGeneric: s("The token is shown this once. An MCP client's server entry:"),
  appliedTo: (host: string) => s(`added to ${host}, by running (the token not shown again):`),
  tokenArg: s("SAVESLOT_TOKEN=<token>"),
  applyFailedOut: s("the host's command did not succeed; run it yourself:"),
  applyExit: (code: number) => s(`error: the host's command exited with status ${code}`),
  applySignal: s("error: the host's command was stopped by a signal"),
  applyNotFound: s(
    "error: --apply: the host's command is not on PATH; nothing was issued. Install the host, or connect without --apply",
  ),
  applyGone: s("error: the host's command was no longer there when it was run"),
  applyCannotRun: s(
    "error: the host's command could not be run: the file is not one this system can execute",
  ),
  applyTimeout: s("error: the host's command did not finish in 60 seconds and was stopped"),
  applyKept: s(
    "the connection instance is kept: the command above holds its token. If it is not used, revoke it with saveslot connections revoke",
  ),
  snippetHint: (host: string) =>
    s(`optional: saveslot snippet ${host} (text to put in the host's custom instructions)`),
  selfcheckFailed: s("error: the self-check failed: the new token could not read the catalog"),
  tokenMalformed: s(
    "error: the service gave no token of the shape it gives; it was not shown or used",
  ),
  outputLost: s("error: the output could not be written (stdout was closed)"),
  outputLostRevoked: s(
    "the connection instance was revoked: its token was in the output that was lost. Connect again under another name",
  ),
  selfcheckRevoked: s(
    "the connection instance was revoked, its token not shown; its name stays taken. Check saveslot status, then connect again under another name",
  ),
  selfcheckNotRevoked: s(
    "and the connection instance could not be revoked: revoke it with saveslot connections revoke",
  ),
  connectUnknown: s(
    "the connection broke before the answer: the connection instance may have been issued without its token shown. If saveslot connections list shows this name, its token cannot be had again: revoke it and connect again",
  ),
  connectionsListArgs: s("saveslot connections list takes no arguments"),
  connectionsCount: s("connection instance(s)"),
  allSlots: s("all slots"),
  issuedAt: s("issued"),
  revokedAt: s("revoked"),
  disabled: s("disabled by an import"),
  revokeArgs: s("give the connection instance: saveslot connections revoke <name or ci_…>"),
  connectionNotFound: s(
    "error: no connection instance of that name or ID. See saveslot connections list",
  ),
  revokeAsk: s("revoke"),
  nameAmbiguous: s(
    "error: more than one connection instance has that name; give the ID of the one to revoke:",
  ),
  pagesRepeat: s("error: the service gave the same page twice; stopped"),
  pagesTooMany: s("error: more pages than this command reads (1000); stopped"),
  revokeNoTerminal: s(
    "not run: stdin is no terminal to ask on. Run this again with --yes to revoke without asking",
  ),
  alreadyRevoked: s("is revoked already; nothing was done"),
  alreadyDisabled: s("is disabled already (by an import); nothing was done"),
  revokedNow: s("its token is refused from now on"),
  revokeUnknown: s(
    "the connection broke before the answer: it is not known whether it was revoked. See saveslot connections list",
  ),
  snippetArgs: s(
    "saveslot snippet takes at most one host: claude-code, codex, vscode, cursor, gemini, claude-desktop or chatgpt",
  ),
  langBad: s("--lang takes en or zh-CN"),
  snippetPlaces: s(
    "Where to put it (user level is best: saveslot is per person, not per project):",
  ),
  snippet: new Map<"en" | "zh-CN", readonly Static[]>([
    [
      "en",
      (
        [
          "## saveslot",
          "My long-term records (things that change over time: spending, workouts, budgets, progress) live in saveslot and are shared by all my agents.",
          "- When I ask about my own records, numbers or history, check saveslot first (`saveslot_catalog`, then `saveslot_query` or `saveslot_sql`) rather than answering from memory.",
          "- When I state a new fact that belongs in one of its tables, or correct an earlier one, save it with `saveslot_write` and include my exact words as evidence.",
          "- If a receipt says something is pending confirmation, or a deletion is involved, show me the details and wait for my go-ahead.",
        ] as const
      ).map(s),
    ],
    [
      "zh-CN",
      (
        [
          "## saveslot",
          "我的长期记录（会随时间变化的事情：支出、运动、预算、进度）都在 saveslot 里，我用的各个 Agent 共用同一份。",
          "- 我问到自己的记录、数字或过去的情况时，先查 saveslot（`saveslot_catalog`，再 `saveslot_query` 或 `saveslot_sql`），不要凭记忆回答。",
          "- 我说出一件属于其中某张表的新事实、或更正之前说过的，用 `saveslot_write` 记下，并把我的原话作为证据带上。",
          "- 回执说有内容待确认、或涉及删除时，先把详情给我看，等我同意再继续。",
        ] as const
      ).map(s),
    ],
  ]),
  /** Where each host takes the text (06 §3.4's table): the line before it, and a row of the table. */
  snippetPlace: new Map<string, { readonly before: Static; readonly row: Static }>([
    [
      "claude-code",
      {
        before: s(
          "Add this to ~/.claude/CLAUDE.md (for every project), or to a project's CLAUDE.md:",
        ),
        row: s(
          "  Claude Code        ~/.claude/CLAUDE.md; a project's ./CLAUDE.md or ./.claude/CLAUDE.md",
        ),
      },
    ],
    [
      "codex",
      {
        before: s(
          "Add this to ~/.codex/AGENTS.md (for every project), or to an AGENTS.md in a project:",
        ),
        row: s("  Codex              ~/.codex/AGENTS.md; AGENTS.md from the project root down"),
      },
    ],
    [
      "vscode",
      {
        before: s(
          "Add this to ~/.copilot/copilot-instructions.md (for every project), or to a project's .github/copilot-instructions.md or AGENTS.md:",
        ),
        row: s(
          "  VS Code (Copilot)  ~/.copilot/copilot-instructions.md; .github/copilot-instructions.md or AGENTS.md",
        ),
      },
    ],
    [
      "cursor",
      {
        before: s(
          "Add this as a User Rule in Cursor's settings (for every project), or to a project's AGENTS.md or a rule under .cursor/rules/:",
        ),
        row: s(
          "  Cursor             User Rules in the settings only; AGENTS.md or .cursor/rules/*.mdc",
        ),
      },
    ],
    [
      "gemini",
      {
        before: s(
          "Add this to ~/.gemini/GEMINI.md (for every project), or to a GEMINI.md in the workspace:",
        ),
        row: s("  Gemini CLI         ~/.gemini/GEMINI.md; GEMINI.md in the workspace and above"),
      },
    ],
    [
      "claude-desktop",
      {
        before: s(
          "Add this to the global instructions in Claude's settings, or to a project's instructions:",
        ),
        row: s(
          "  Claude (desktop and web)  global instructions in the settings; a project's instructions",
        ),
      },
    ],
    [
      "chatgpt",
      {
        before: s(
          "Add this to the custom instructions in ChatGPT's settings, or to a project's instructions (not verified):",
        ),
        row: s(
          "  ChatGPT            custom instructions in the settings; a project's instructions (not verified)",
        ),
      },
    ],
  ]),

  // schema templates
  templates: new Map<string, Static>([
    ["running", s("running records: runs (events) + weekly_mileage (derived, distance per week)")],
    ["spending", s("daily spending: expenses (events, CNY) + monthly_total (derived)")],
    ["budget", s("budget: budgets (state, by category)")],
  ]),

  // warnings and notices (06 §6.1): every warning, the notices at the end
  warning: s("warning"),
  notice: s("note"),
} as const;
