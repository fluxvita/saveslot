// A new PGlite storage, copied from a template instead of made: making one runs initdb and the
// format's DDL in WASM, seconds each (over 15 s on a loaded machine), and many tests make several.
// Every storage made with the same creation parameters (store-pglite's `creation`: the format's
// DDL, its `meta` rows, the session settings, the durability) holds the same, so the first one a
// run makes for those parameters is made for real, by store-pglite's own `createPgdata`, and kept as
// the template; each later one is a copy of it. A copy then goes through the backend's own
// opening, which takes the lock, names the owner and moves the ownership epoch as for any storage.
//
// - Keyed by the creation parameters: other parameters, another template.
// - Made under a name of its own and renamed into place once complete, so neither another case of
//   the same process nor another worker of the run ever copies one half made; when two make one at
//   once, the first rename stands and the other copy is dropped.
// - Copied with a clone of each file where the file system can (APFS, Btrfs, XFS), a plain copy
//   where it cannot (COPYFILE_FICLONE), into a name of its own in the storage's directory, renamed
//   to `pgdata` once complete. With durability "host-fsync" the copy is synced to the host as a
//   storage made for real is.
// - Kept under the run's directory (SAVESLOT_TEST_TEMPLATES, set by scripts/test-tmp.ts beside the
//   run's TMPDIR), so it goes with the run and is not among what the tests left. Without it (a
//   file run outside Vitest's global setup) storages are made for real.
//
// A test whose subject is making a storage (the steps of making one, a failure halfway, what is
// left of one half made) makes it for real: `testBackend({ template: false })`, or PgliteBackend
// itself.

import { createHash, randomBytes } from "node:crypto";
import {
  closeSync,
  constants,
  existsSync,
  fsyncSync,
  mkdirSync,
  openSync,
  readdirSync,
  renameSync,
  rmSync,
} from "node:fs";
import { cp } from "node:fs/promises";
import { join } from "node:path";
import {
  createPgdata,
  creation,
  type Durability,
  PGDATA_DIR,
} from "@fluxvita/saveslot-store-pglite";

/** The environment variable naming the run's directory of templates. */
export const TEMPLATES_ENV = "SAVESLOT_TEST_TEMPLATES";

/** A template's name: the hash of the parameters a storage is made from. */
export function templateKey(durability: Durability): string {
  return createHash("sha256")
    .update(JSON.stringify(creation(durability)))
    .digest("hex")
    .slice(0, 32);
}

const scratch = () => `${process.pid}-${randomBytes(4).toString("hex")}`;

/** Whether a rename failed because the target was already there (another maker came first). */
const taken = (e: unknown) =>
  ["ENOTEMPTY", "EEXIST"].includes((e as NodeJS.ErrnoException).code ?? "");

function fsync(path: string): void {
  const fd = openSync(path, "r");
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

function fsyncTree(root: string): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) fsyncTree(p);
    else fsync(p);
  }
  fsync(root);
}

const made = new Map<string, Promise<string>>();

/** The template for `durability` under `root`, made if the run has none yet. */
export function templateFor(root: string, durability: Durability): Promise<string> {
  const key = templateKey(durability);
  const at = join(root, key);
  let p = made.get(at);
  if (p === undefined) {
    p = (async () => {
      if (!existsSync(join(at, "PG_VERSION"))) {
        mkdirSync(root, { recursive: true });
        const making = join(root, `${key}.making-${scratch()}`);
        try {
          await createPgdata(making, durability);
          try {
            renameSync(making, at);
          } catch (e) {
            if (!taken(e)) throw e;
          }
        } finally {
          rmSync(making, { recursive: true, force: true });
        }
      }
      // What is there under the key is a whole storage, whoever made it.
      if (!existsSync(join(at, "PG_VERSION"))) {
        throw new Error(`the store template ${at} is there but holds no storage`);
      }
      return at;
    })();
    // A failure is not kept: the next storage tries again.
    p.catch(() => made.delete(at));
    made.set(at, p);
  }
  return p;
}

/**
 * Puts a copy of the template into `dir` when it holds no storage yet (no `pgdata`); otherwise
 * leaves it to the backend's opening. Whether a copy was put there.
 */
export async function copyTemplate(
  root: string,
  dir: string,
  durability: Durability,
): Promise<boolean> {
  const pgdata = join(dir, PGDATA_DIR);
  if (existsSync(pgdata)) return false;
  const template = await templateFor(root, durability);
  mkdirSync(dir, { recursive: true });
  const copying = join(dir, `${PGDATA_DIR}.copying-${scratch()}`);
  try {
    await cp(template, copying, { recursive: true, mode: constants.COPYFILE_FICLONE });
    if (durability === "host-fsync") fsyncTree(copying);
    try {
      renameSync(copying, pgdata);
    } catch (e) {
      if (!taken(e)) throw e;
      return false;
    }
    if (durability === "host-fsync") fsync(dir);
    return true;
  } finally {
    rmSync(copying, { recursive: true, force: true });
  }
}
