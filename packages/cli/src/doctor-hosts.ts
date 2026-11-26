// `saveslot doctor`'s check of the hosts' saveslot entries (06-cli §3 step 7): each host `setup`
// knows, found on PATH, asked through its own look-up command (`mcp get saveslot`), never by
// reading its configuration. The entry passes when it shows this saveslot's path (`entryHolds`,
// the one reading of that output, which is never shown: it may hold the token). One that does not
// show it is a reminder, not a failure: a host may write the path another way. A host with no
// look-up command is "not checked". A host not installed gives no line. A host with an entry whose
// instances have no read but the self-check gets a reminder with how it allows saveslot's tools:
// inferred from saveslot's own reads, not looked up (a call the host refuses never arrives). The
// daemon's `doctor` writes these lines; the entry package hands this function to it.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import { type Client, createClient, resolveCredential } from "@fluxvita/saveslot-client";
import {
  entryHolds,
  entryPath,
  HOST_INFO,
  hostEntry,
  onPath,
  removeCommand,
  SETUP_HOSTS,
  type SetupHost,
} from "./connect.ts";
import { hostInstances, lastRead } from "./host-instances.ts";
import { allConnections } from "./pages.ts";
import { TEXTS } from "./texts.ts";

export interface HostFinding {
  readonly verdict: "pass" | "remind" | "skipped";
  readonly item: string;
  readonly says: string;
  readonly fix?: string;
}

export async function doctorHosts(o: {
  readonly env: Readonly<Record<string, string | undefined>>;
  /** This saveslot's executable, as the entry package knows it. */
  readonly entry: string | undefined;
  readonly platform?: NodeJS.Platform;
  readonly userHome?: string;
  readonly timeoutMs?: number;
  /**
   * The local service's session, given only when the service said it is ready; none, or the
   * service not answering: no line on reads.
   */
  readonly session?: () => Promise<Pick<Client, "connections" | "readsList">>;
}): Promise<HostFinding[]> {
  const out: HostFinding[] = [];
  const self = await entryPath(o.entry).catch(() => undefined);
  let all: Promise<Awaited<ReturnType<typeof allConnections>> | undefined> | undefined;
  const unread = async (host: SetupHost): Promise<boolean> => {
    if (o.session === undefined) return false;
    try {
      const session = await o.session();
      all ??= allConnections(session).catch(() => undefined);
      const listed = await all;
      if (listed === undefined) return false;
      const mine = hostInstances(listed, host).like;
      if (mine.length === 0) return false;
      for (const c of mine) if ((await lastRead(session, c)) !== null) return false;
      return true;
    } catch {
      return false;
    }
  };
  for (const host of SETUP_HOSTS) {
    const info = HOST_INFO[host];
    const item = `host ${TEXTS.hostDisplay(host)}`;
    if (info.exe === undefined) {
      const dirs = info.dirs?.(o.userHome ?? homedir(), o.platform ?? process.platform) ?? [];
      const there = await Promise.all(
        dirs.map((d) =>
          access(d).then(
            () => true,
            () => false,
          ),
        ),
      );
      if (there.some(Boolean))
        out.push({ verdict: "skipped", item, says: TEXTS.doctorHostNoLookup });
      continue;
    }
    const exe = await onPath(info.exe, o.env["PATH"]);
    if (exe === undefined) continue;
    const e = await hostEntry(exe, o.env, o.timeoutMs);
    if (e.kind !== "yes") {
      out.push(
        e.kind === "no"
          ? { verdict: "skipped", item, says: TEXTS.doctorHostNoEntry }
          : { verdict: "remind", item, says: TEXTS.doctorHostLookupHung },
      );
      continue;
    }
    if (self === undefined) {
      out.push({ verdict: "remind", item, says: TEXTS.doctorHostSelfUnknown });
    } else if (entryHolds(e.out, self)) {
      out.push({ verdict: "pass", item, says: TEXTS.doctorHostOk(self) });
    } else {
      out.push({
        verdict: "remind",
        item,
        says: TEXTS.doctorHostPathNotSeen(self),
        fix: TEXTS.doctorHostFix((removeCommand(host) ?? []).join(" ")),
      });
    }
    if (await unread(host)) {
      out.push({
        verdict: "remind",
        item,
        says: TEXTS.doctorHostUnread,
        fix: TEXTS.doctorHostAllow(host),
      });
    }
  }
  return out;
}

/**
 * How long each call for the hosts' reads may take: as long as doctor's other questions to the
 * service. A service that accepts the connection and does not answer is what doctor is run for.
 */
export const SESSION_TIMEOUT_MS = 10_000;

/**
 * The local service's session for `doctor`'s hosts: the home's credential over its socket, each
 * call given up after `timeoutMs`.
 */
export async function localSession(
  home: string,
  env: Readonly<Record<string, string | undefined>>,
  timeoutMs = SESSION_TIMEOUT_MS,
): Promise<Client> {
  const credential = await resolveCredential({ home, env });
  return createClient({
    socketPath: join(home, "run", "saveslot.sock"),
    token: credential.token,
    timeoutMs,
  });
}
