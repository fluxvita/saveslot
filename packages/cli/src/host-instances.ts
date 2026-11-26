// Which connection instances are a host's, and whether one has been read through: what `setup`
// (06-cli §3.3 item 7) and `doctor` (06-cli §3 step 7) both go by.

import type { Client, Connection } from "@fluxvita/saveslot-client";
import type { SetupHost } from "./connect.ts";
import { TEXTS } from "./texts.ts";

/**
 * This host's instances that are not revoked or disabled, in two tiers (06 §3.3 item 7):
 * - `own`: named exactly as setup names them on this computer now (`base`, "<computer> · <host>",
 *   a number after it or not): setup's own, and the host's entry may be told by them;
 * - `like`: the others whose name is "<host>" or ends with " · <host>" (a number after it or not):
 *   made under another computer name (it changes: macOS names the computer after its network), or
 *   named so by the user. They may be the host's, but are not taken to be.
 * Without `base` (doctor, which takes both tiers together), every one is in `like`.
 */
export function hostInstances(
  all: readonly Connection[],
  host: SetupHost,
  base?: string,
): { own: Connection[]; like: Connection[] } {
  const display = TEXTS.hostDisplay(host);
  const own: Connection[] = [];
  const like: Connection[] = [];
  for (const c of all) {
    if (c.state !== undefined) continue;
    const n = c.name.replace(/ [0-9]+$/, "");
    if (n === base) own.push(c);
    else if (n === display || n.endsWith(` · ${display}`)) like.push(c);
  }
  return { own, like };
}

/** The last read of an instance besides its self-check: its time, null when there is none, undefined when the reads cannot be read. */
export async function lastRead(
  session: Pick<Client, "readsList">,
  c: Connection,
): Promise<string | null | undefined> {
  const reads = await session.readsList({ connection: c.id, limit: 200 }).catch(() => undefined);
  if (reads === undefined) return undefined;
  const r = reads.reads.find((x) => (x as { selfcheck?: boolean }).selfcheck !== true);
  return r !== undefined ? String((r as { at: unknown }).at) : null;
}
