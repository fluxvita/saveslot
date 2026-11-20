// What `status` and `doctor` both ask (docs/zh-CN/spec/06-cli.md §3 steps 2 and 7, §4.1): a GET
// to the local service as the user session, whether the clock is behind the log's end, and
// whether a directory looks like one a sync service keeps.

import { resolve } from "node:path";
import { readPrivate, sessionFile } from "@fluxvita/saveslot-service";
import { localRequest } from "./local-request.ts";
import { socketFile } from "./service.ts";

/** Path segments of folders that sync services keep (06-cli §3 step 2; 02-architecture §7). */
const SYNCED = [
  "/Library/Mobile Documents/", // iCloud Drive
  "/Library/CloudStorage/", // Dropbox, OneDrive, Google Drive and others on macOS
  "/Dropbox/",
  "/OneDrive/",
  "/Google Drive/",
];

export function looksSynced(dir: string): boolean {
  const d = `${resolve(dir)}/`;
  return SYNCED.some((s) => d.includes(s));
}

/** GET `path` from the local service as the user session; undefined when not to be had. */
export async function withSession(home: string, path: string): Promise<unknown> {
  let token: string | undefined;
  try {
    token = (await readPrivate(sessionFile(home)))?.trim();
  } catch {
    return undefined;
  }
  if (token === undefined) return undefined;
  try {
    const a = await localRequest({
      socketPath: socketFile(home),
      method: "GET",
      path,
      headers: { authorization: `Bearer ${token}`, accept: "application/json" },
      timeoutMs: 10_000,
    });
    if (a.status !== 200) return undefined;
    return JSON.parse(a.body.toString("utf8")) as unknown;
  } catch {
    return undefined;
  }
}

/** How far the clock may be behind the log's end before `status` warns (02-architecture §8). */
export const CLOCK_BEHIND_MS = 5 * 60_000;

/**
 * How far `now` is behind the log's end, when by more than `CLOCK_BEHIND_MS` (02-architecture §8);
 * undefined otherwise, or when the end is not a time.
 */
export function clockBehind(logEnd: string | undefined, now: number): number | undefined {
  const end = logEnd !== undefined ? Date.parse(logEnd) : Number.NaN;
  if (Number.isNaN(end)) return undefined;
  return end - now > CLOCK_BEHIND_MS ? end - now : undefined;
}
