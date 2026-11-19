// Copies of a template home, for tests whose subject is not how a home is made.
//
// Making a home builds a database, which costs over a second; copying one made already costs a
// tenth of that. A test file makes one template (by `initLocalHome`, or by the `init` command) on
// first use, never starts a service on it, and gives each case a copy: a home of its own, with its
// own files, lock and socket. The copies hold the template's tenant and its user session: a case
// about what init itself makes, or about two homes being told apart by what init gave them, makes
// its home the real way.
//
// A copy makes its directories with the default mode, and the service refuses a home whose
// control files are open to others: each entry's mode is set back to the template's.

import { createHash } from "node:crypto";
import { chmodSync, cpSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";

const modeOf = (path: string) => statSync(path).mode & 0o777;

/** Every entry under `dir` with its mode: "<path from dir> <d|f> <mode in octal>", sorted. */
export function homeEntries(dir: string, from = dir): string[] {
  return readdirSync(dir)
    .sort()
    .flatMap((name) => {
      const path = join(dir, name);
      const isDir = statSync(path).isDirectory();
      const line = `${path.slice(from.length + 1)} ${isDir ? "d" : "f"} ${modeOf(path).toString(8)}`;
      return isDir ? [line, ...homeEntries(path, from)] : [line];
    });
}

/** A home by what is in it: its own mode, every entry's path and mode, every file's bytes. */
export function homeDigest(dir: string): string {
  const h = createHash("sha256").update(`${modeOf(dir).toString(8)}\n`);
  for (const line of homeEntries(dir)) {
    h.update(`${line}\n`);
    const [path, kind] = line.split(" ") as [string, string];
    if (kind === "f") h.update(readFileSync(join(dir, path)));
  }
  return h.digest("hex");
}

/** Copies the home `template` to `to` (not there yet), modes as in the template. Returns `to`. */
export function copyHome(template: string, to: string): string {
  cpSync(template, to, { recursive: true, errorOnExist: true, force: false });
  chmodSync(to, modeOf(template));
  for (const line of homeEntries(template)) {
    const [path, , mode] = line.split(" ") as [string, string, string];
    chmodSync(join(to, path), Number.parseInt(mode, 8));
  }
  return to;
}

export interface HomeTemplate {
  /** Where the template is (made by the first copy). */
  readonly dir: string;
  /** A copy of the template at `to`; returns `to`. */
  copy(to: string): Promise<string>;
  /** The template's digest when it was made. */
  made(): Promise<string>;
}

/**
 * A template home at `dir`, made by `make` the first time a copy is asked for. `make` leaves the
 * home closed: nothing runs on the template, then or later.
 */
export function homeTemplate(dir: string, make: (home: string) => Promise<unknown>): HomeTemplate {
  let made: Promise<string> | undefined;
  const ready = () => {
    if (made === undefined) made = make(dir).then(() => homeDigest(dir));
    return made;
  };
  return {
    dir,
    made: ready,
    copy: async (to) => {
      await ready();
      return copyHome(dir, to);
    },
  };
}
