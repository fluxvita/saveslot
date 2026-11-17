// The text of `saveslot connect`, `connections list` / `revoke` and `snippet` (06-cli §3.2, §3.4,
// §4.9). A connection's name is the user's text: inside the boundary. The host's setup is
// saveslot's own making, to paste: outside, when it can be shown as it is (./text.ts).

import { type Connection, SCOPES } from "@fluxvita/saveslot-client";
import { APPLIES, addCommand, type Host, pastedConfig } from "../connect.ts";
import { TEXTS } from "../texts.ts";
import { arr, obj, str } from "./reads.ts";
import {
  code,
  handle,
  id,
  join,
  type Line,
  name,
  num,
  pasteLines,
  shellLine,
  t,
  time,
  untrusted,
  words,
} from "./text.ts";

const SCOPE_SET: ReadonlySet<string> = new Set<string>(SCOPES);
const scopesOf = (x: unknown) =>
  join(
    arr(x).map((s) => [code(String(s), SCOPE_SET)]),
    t` `,
  );

/** The connection instance in one line: name, ID, scopes. */
export const connectionLine = (c: Connection): Line =>
  t`${untrusted(String(c.name))} (${id(String(c.id))}) · ${words(TEXTS.scopeWord)} ${scopesOf(c.scopes)}`;

/** The self-check's line: how many slots the new token read. */
export const selfcheckLine = (slots: number, more: boolean): Line =>
  t`${words(TEXTS.selfcheckPassed)} ${num(slots)}${more ? t` ${words(TEXTS.selfcheckMore)}` : []} ${words(TEXTS.selfcheckSlots)}`;

/** What the host is given (06 §3.2): its command, a configuration to paste, or the token. */
export function hostSetup(host: Host, token: string, entry: string, socket: string): Line[] {
  const command = addCommand(host, token, entry);
  if (command !== undefined) return [[words(TEXTS.pasteCommand)], t`  ${shellLine(command)}`];
  if (host === "http") {
    return [
      [words(TEXTS.pasteHttp)],
      t`  ${shellLine([`SAVESLOT_TOKEN=${token}`])}`,
      t`  ${words(TEXTS.socketWord)} ${shellLine([socket])}`,
    ];
  }
  return [
    [words(host === "generic" ? TEXTS.pasteGeneric : TEXTS.pasteConfig)],
    ...pasteLines(JSON.stringify(pastedConfig(host, token, entry), null, 2)),
  ];
}

/**
 * `--apply` (06 §8.2), the command as it ran, the host's executable by its absolute path: run, with
 * `<token>` where the token is (the host has it; the terminal need not keep another copy); failed,
 * the whole command, for the user to run.
 */
export function appliedLines(
  host: Host,
  token: string,
  entry: string,
  exe: string,
  ok: boolean,
): Line[] {
  // As it ran: the host's executable by the absolute path found on PATH.
  const command = [exe, ...(addCommand(host, token, entry) as string[]).slice(1)];
  if (!ok) return [[words(TEXTS.applyFailedOut)], t`  ${shellLine(command)}`];
  const at = command.indexOf(`SAVESLOT_TOKEN=${token}`);
  return [
    [words(TEXTS.appliedTo(host))],
    t`  ${shellLine(command.slice(0, at))} ${words(TEXTS.tokenArg)} ${shellLine(command.slice(at + 1))}`,
  ];
}

/** A token of the shape the service gives, to try the output on before anything is issued. */
const SAMPLE_TOKEN = `slt_${"A".repeat(43)}`;

/**
 * Whether everything `connect` would write for this host can be shown as it is, outside the
 * boundary: the setup (a shell line, JSON lines, the socket line) and, with `--apply`, the host's
 * command by its path, run or failed. Asked before anything is issued: an output that would come
 * out inside the boundary is no use to paste, and its token would be shown for nothing.
 */
export function setupShowable(host: Host, entry: string, socket: string, exe?: string): boolean {
  const lines = [
    ...hostSetup(host, SAMPLE_TOKEN, entry, socket),
    ...(exe !== undefined
      ? [
          ...appliedLines(host, SAMPLE_TOKEN, entry, exe, true),
          ...appliedLines(host, SAMPLE_TOKEN, entry, exe, false),
        ]
      : []),
  ];
  return lines.every((line) => line.every((p) => p.kind === "own"));
}

/** The closing hint of `connect`, for a host `snippet` knows. */
export function snippetHint(host: Host): Line[] {
  return APPLIES.has(host) || host === "cursor" || host === "claude-desktop"
    ? [[words(TEXTS.snippetHint(host))]]
    : [];
}

/** `saveslot connections list` (06 §4.9): name, ID, scopes, range, when issued, revoked or not. */
export function connectionsList(r: unknown): Line[] {
  const x = obj(r);
  const cs = arr(x["connections"]);
  const out: Line[] = [t`${num(cs.length)} ${words(TEXTS.connectionsCount)}`];
  for (const c of cs) {
    const e = obj(c);
    const slots = arr(e["slots"]);
    const range =
      slots.length > 0
        ? join(
            slots.map((s) => [name(String(obj(s)["slot"] ?? ""))]),
            t`,`,
          )
        : [words(TEXTS.allSlots)];
    const state =
      e["state"] === "revoked"
        ? t`  ${words(TEXTS.revokedAt)} ${time(String(e["revoked_at"] ?? ""))}`
        : e["state"] === "disabled"
          ? t`  ${words(TEXTS.disabled)}`
          : [];
    out.push(
      t`${untrusted(String(e["name"] ?? ""))}  ${id(String(e["id"] ?? ""))}  ${scopesOf(e["scopes"])}  ${range}  ${words(TEXTS.issuedAt)} ${time(String(e["created_at"] ?? ""))}${state}`,
    );
  }
  const next = str(x["next_cursor"]);
  if (next !== undefined) out.push(t`next page: the same command with --cursor ${handle(next)}`);
  return out;
}

/** `saveslot connections revoke`: the connection, when it was revoked, and what that means. */
export function revokedLines(c: Connection): Line[] {
  return [
    t`${untrusted(String(c.name))} (${id(String(c.id))}) ${words(TEXTS.revokedAt)} ${time(String(c.revoked_at ?? ""))}: ${words(TEXTS.revokedNow)}`,
  ];
}

/** A connection that is revoked or disabled already: nothing done. */
export const alreadyLines = (c: Connection): Line[] => [
  t`${untrusted(String(c.name))} (${id(String(c.id))}) ${words(c.state === "disabled" ? TEXTS.alreadyDisabled : TEXTS.alreadyRevoked)}`,
];

/** `saveslot snippet` (06 §3.4): with a host, where it goes and the text; without, the text and the table. */
export function snippetLines(host: string | undefined, lang: "en" | "zh-CN"): Line[] {
  const body = (TEXTS.snippet.get(lang) ?? []).map((l) => [words(l)]);
  if (host !== undefined) {
    const place = TEXTS.snippetPlace.get(host);
    if (place !== undefined) return [[words(place.before)], [], ...body];
  }
  return [
    ...body,
    [],
    [words(TEXTS.snippetPlaces)],
    ...[...TEXTS.snippetPlace.values()].map((p) => [words(p.row)]),
  ];
}
