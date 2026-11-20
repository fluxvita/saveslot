// `saveslot doctor`'s check of the hosts' saveslot entries (06-cli §3 step 7): each host `setup`
// knows, found on PATH, asked through its own look-up command (`mcp get saveslot`), never by
// reading its configuration. The entry passes when it shows this saveslot's path (`entryHolds`,
// the one reading of that output, which is never shown: it may hold the token). One that does not
// show it is a reminder, not a failure: a host may write the path another way. A host with no
// look-up command is "not checked". A host not installed gives no line. The daemon's `doctor`
// writes these lines; the entry package hands this function to it.

import { access } from "node:fs/promises";
import { homedir } from "node:os";
import {
  entryHolds,
  entryPath,
  HOST_INFO,
  hostEntry,
  onPath,
  removeCommand,
  SETUP_HOSTS,
} from "./connect.ts";
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
}): Promise<HostFinding[]> {
  const out: HostFinding[] = [];
  const self = await entryPath(o.entry).catch(() => undefined);
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
  }
  return out;
}
