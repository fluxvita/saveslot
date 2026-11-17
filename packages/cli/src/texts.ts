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
