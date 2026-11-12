// The owner file `<dir>/saveslot.owner`: names the current opener with a random token and its start
// time (not a pid, 02-architecture §7), plus the ownership epoch it holds.
//
// Why a file next to the database: the ownership epoch in `meta` cannot reveal a takeover to an
// old PGlite instance. PGlite keeps pages in its own buffer pool, so an instance that lost the
// lock keeps reading its cached `meta` page and sees its own epoch (experiment 8 shows this).
// A plain file read goes to the host every time. Every write transaction reads this file first and
// again just before COMMIT; a different token means another opener took over.

import { randomBytes } from "node:crypto";
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, writeSync } from "node:fs";
import { join } from "node:path";
import { fsyncPath } from "./fsutil.ts";

export const OWNER_FILE = "saveslot.owner";

export interface OwnerRecord {
  readonly token: string;
  readonly startedAt: string;
  readonly epoch: number | null;
}

export function newToken(): string {
  return randomBytes(16).toString("hex");
}

export function writeOwner(dir: string, rec: OwnerRecord): void {
  const tmp = join(dir, `${OWNER_FILE}.${rec.token}.tmp`);
  const fd = openSync(tmp, "w", 0o600);
  try {
    writeSync(fd, `${JSON.stringify(rec)}\n`);
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
  renameSync(tmp, join(dir, OWNER_FILE));
  fsyncPath(dir);
}

export function readOwnerToken(dir: string): string | undefined {
  try {
    const rec = JSON.parse(readFileSync(join(dir, OWNER_FILE), "utf8")) as Partial<OwnerRecord>;
    return typeof rec.token === "string" ? rec.token : undefined;
  } catch {
    return undefined;
  }
}
