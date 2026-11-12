import { closeSync, constants, fsyncSync, openSync, readdirSync } from "node:fs";
import { join } from "node:path";

/** fsyncs a file or directory. Node's fsync is F_FULLFSYNC on macOS (libuv), fsync elsewhere. */
export function fsyncPath(path: string): void {
  const fd = openSync(path, constants.O_RDONLY);
  try {
    fsyncSync(fd);
  } finally {
    closeSync(fd);
  }
}

/** fsyncs every file and directory under `root`, then `root` itself. */
export function fsyncTree(root: string): void {
  for (const e of readdirSync(root, { withFileTypes: true })) {
    const p = join(root, e.name);
    if (e.isDirectory()) fsyncTree(p);
    else if (e.isFile()) fsyncPath(p);
  }
  fsyncPath(root);
}
