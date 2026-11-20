// The service's own log file when it runs in the background (docs/zh-CN/spec/06-cli.md §3
// «分步做»: `run/saveslot.log`): one line per event, appended, 0600. Past `maxBytes` after a line
// is written, the file is rotated: the oldest kept copy goes, each kept copy moves one down
// (`saveslot.log.1` → `saveslot.log.2`), the file becomes `saveslot.log.1`, and a new one is
// opened. Rotation happens only here, after a line of the service's own: what Node writes to
// stderr on a crash goes to the descriptor `saveslot start` gave the process, which after a
// rotation is the newest kept copy. A file at `path` that is no longer the one written to (the
// home was moved away while the service ran, and another may be there now) is not rotated: the
// lines go on to the open file, and nothing at the path is renamed or removed.

import { closeSync, fstatSync, lstatSync, openSync, renameSync, rmSync, writeSync } from "node:fs";

/** Rotate past this many bytes (06-cli §3; 08-open-questions). */
export const LOG_MAX_BYTES = 10 * 1024 * 1024;
/** How many rotated copies are kept. */
export const LOG_KEEP = 2;

/** A writer of log lines to `path`, rotating it as above. */
export function rotatingLog(
  path: string,
  maxBytes = LOG_MAX_BYTES,
  keep = LOG_KEEP,
): (line: string) => void {
  const open = () => openSync(path, "a", 0o600);
  let fd = open();
  let size = fstatSync(fd).size;
  return (line: string) => {
    const text = `${line}\n`;
    try {
      size += writeSync(fd, text);
    } catch {
      // A line that cannot be written is lost; the service goes on.
      return;
    }
    if (size < maxBytes) return;
    try {
      const mine = fstatSync(fd);
      const there = lstatSync(path);
      if (mine.dev !== there.dev || mine.ino !== there.ino) return;
    } catch {
      return;
    }
    try {
      closeSync(fd);
      rmSync(`${path}.${keep}`, { force: true });
      for (let i = keep - 1; i >= 1; i--) {
        try {
          renameSync(`${path}.${i}`, `${path}.${i + 1}`);
        } catch {}
      }
      renameSync(path, `${path}.1`);
    } catch {}
    fd = open();
    size = fstatSync(fd).size;
  };
}
