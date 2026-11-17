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
