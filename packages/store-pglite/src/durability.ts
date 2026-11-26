// How PGlite reaches stable storage. Loaded only in the DB Worker.
//
// Facts about @electric-sql/pglite 0.5.16 this file relies on (source: the package's dist and the
// TypeScript sources embedded in its source maps; experiment report
// docs/zh-CN/process/experiments/exp-1-pglite-durability.md has the details):
//
// 1. `PGlite.defaultStartParams` contains "-F" (fsync = off). The `startParams` option replaces
//    the whole list, so leaving "-F" out turns fsync on.
// 2. The Node filesystem is Emscripten's NODEFS. Its `stream_ops` has no `fsync`, and the emitted
//    `fd_sync` returns success when that callback is missing, so PostgreSQL's fsync() reaches no
//    host call. The emitted `__syscall_fdatasync` only validates the descriptor and returns 0, so
//    fdatasync() never reaches the host either.
// 3. PostgreSQL's default `wal_sync_method` in this build is `fdatasync` (a no-op, see 2).
//    `fsync_writethrough` is not offered; `open_sync` aborts at start-up (its flag bits are not
//    mapped by NODEFS); `open_datasync` maps to the host's O_SYNC on open.
// 4. `relaxedDurability` only changes when `syncToFs()` is awaited; NodeFS inherits an empty
//    `syncToFs()`, so the option has no effect on the Node filesystem.
//
// "host-fsync" therefore: drops "-F", sets `wal_sync_method = fsync`, and installs an `fsync`
// callback on NODEFS that calls Node's `fs.fsyncSync` on the host descriptor. On macOS libuv
// implements `fs.fsyncSync` as fcntl(F_FULLFSYNC), falling back to F_BARRIERFSYNC, then fsync();
// on Linux it is fsync(). The callback also covers data files and directories that PostgreSQL
// fsyncs at checkpoints. Whether the host call is really issued before each commit is
// acknowledged must be observed with a system call tracer (experiment 1, step 1).

import { fstatSync, fsyncSync, lstatSync } from "node:fs";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import type { Durability, HostSyncStats } from "./protocol.ts";

/**
 * How much WAL is kept (both modes). PGlite runs PostgreSQL single-user (`--single`): there is no
 * checkpointer, so a checkpoint comes only when the WAL since the last one reaches
 * `max_wal_size`, and the server's default of 1 GB let a local home grow by that much before
 * any was recycled (issue: 34k rows took 592 MB of WAL). `min_wal_size` is what a checkpoint
 * keeps for reuse. Durability is unchanged: fsync, full-page writes and synchronous commit are
 * the same; only how often a checkpoint comes.
 */
const WAL_SIZE = { max_wal_size: "64", min_wal_size: "32" } as const; // MB, as pg_settings has them
const walParams = Object.entries(WAL_SIZE).flatMap(([k, v]) => ["-c", `${k}=${v}MB`]);

/** PGlite start parameters for a durability mode. */
export function startParams(durability: Durability): string[] {
  if (durability === "pglite-default") return [...PGlite.defaultStartParams, ...walParams];
  const params = PGlite.defaultStartParams.filter((p) => p !== "-F");
  if (params.length !== PGlite.defaultStartParams.length - 1) {
    throw new Error('PGlite start parameters changed: expected exactly one "-F" to remove');
  }
  return [
    ...params,
    ...["-c", "fsync=on"],
    ...["-c", "wal_sync_method=fsync"],
    ...["-c", "synchronous_commit=on"],
    ...["-c", "full_page_writes=on"],
    ...["-c", "data_sync_retry=off"],
    ...walParams,
  ];
}

/** Settings that must hold after start for each mode; checked at open. */
export function expectedSettings(durability: Durability): Record<string, string> {
  if (durability === "pglite-default") return { fsync: "off", ...WAL_SIZE };
  return {
    ...WAL_SIZE,
    fsync: "on",
    wal_sync_method: "fsync",
    synchronous_commit: "on",
    full_page_writes: "on",
    data_sync_retry: "off",
  };
}

interface EmscriptenNode {
  mode: number;
}
interface EmscriptenStream {
  nfd?: number;
  path?: string;
  flags?: number;
  node?: EmscriptenNode;
  /** The host file it is open on, set when it is opened: see `installHostFsync`. */
  host?: HostFile | undefined;
}
type Fn = (...args: never[]) => unknown;
/** The parts of Emscripten's NODEFS the hook wraps; each is optional so that one missing shows. */
export interface NodefsOps {
  stream_ops: {
    open?: (stream: EmscriptenStream) => void;
    write?: (stream: EmscriptenStream, ...rest: never[]) => number;
    setattr?: (stream: EmscriptenStream, attr: { size?: number }) => void;
    allocate?: (stream: EmscriptenStream, ...rest: never[]) => void;
    fsync?: (stream: EmscriptenStream) => number;
    [op: string]: Fn | undefined;
  };
  node_ops: {
    setattr?: (node: EmscriptenNode, attr: { size?: number }) => void;
    mknod?: (parent: EmscriptenNode, name: string, ...rest: never[]) => EmscriptenNode;
    rename?: (node: EmscriptenNode, dir: EmscriptenNode, name: string) => void;
    unlink?: (parent: EmscriptenNode, name: string) => void;
    [op: string]: Fn | undefined;
  };
  /** The host path of a node. */
  realPath(node: EmscriptenNode): string;
}
export interface EmscriptenModule {
  NODEFS: NodefsOps;
  FS: { ErrnoError: new (errno: number) => Error };
}

const EMSCRIPTEN_EIO = 29;

const stats = { total: 0, wal: 0, skipped: 0 };

export function hostSyncStats(): HostSyncStats {
  return { ...stats };
}

/** Tests only, given only in code: what the hook calls in place of `fs.fsyncSync`. */
export interface HostFsyncTesting {
  /** Called with the descriptor and the host path; it must sync the file or throw. */
  readonly hostFsync?: (fd: number, path: string) => void;
}

/** What the hook needs of a host stat: device and inode as bigints (see `hostFile`). */
export interface HostStat {
  readonly dev: bigint;
  readonly ino: bigint;
  isDirectory(): boolean;
}
/** How the hook stats a host file: `fs.fstatSync` and `fs.lstatSync` with bigints. */
export interface HostStats {
  fd(fd: number): HostStat;
  path(path: string): HostStat;
}
const bigintStats: HostStats = {
  fd: (fd) => fstatSync(fd, { bigint: true }),
  path: (path) => lstatSync(path, { bigint: true }),
};

/** A host file: its key (device and inode), and whether it is a directory. */
interface HostFile {
  readonly key: string;
  readonly dir: boolean;
}
/**
 * A host file by device and inode: one file whatever path or descriptor reaches it. As bigints:
 * an inode number above 2^53 (NFS 64-bit file IDs, overlayfs) loses bits as a number, and two
 * files would share a key.
 */
const hostFile = (s: HostStat): HostFile => ({ key: `${s.dev}:${s.ino}`, dir: s.isDirectory() });

/**
 * Installs the fsync callback on NODEFS, so that PostgreSQL's fsync() reaches the host, and skips
 * the fsync of a file that nothing has changed since its last host fsync in this instance.
 *
 * Why the skip: when PostgreSQL starts after a crash it syncs the data directory in two walks, the
 * first meant only to start writeback; in this build the first walk ends in a real fsync too, so
 * each file was fsynced twice (perf issue: starting after a crash). Reported upstream to PGlite;
 * the skip goes when that is fixed.
 *
 * What makes the skip safe:
 * - A file is clean only once a host fsync of it has returned, in this instance: the set is made
 *   here, once for each PGlite instance, and goes with it; the first fsync of each file after the
 *   store is opened, a crash's leftovers included, always reaches the host.
 * - A file whose host fsync ever failed is never clean again.
 * - Everything that changes a file's content or length makes it dirty first: a write (msync
 *   writes through it too), a truncation by descriptor or by path (an open with O_TRUNC is one:
 *   Emscripten's FS.open truncates through the node's setattr), a preallocation (NODEFS has none
 *   in this version). Files are keyed by device and inode, so a write through another descriptor,
 *   another path or a hard link reaches the same entry.
 * - A file created is dirty (NODEFS makes it with no write through the stream: its inode number
 *   may be one a removed file had, clean through a descriptor still open); one renamed, replaced
 *   by a rename or unlinked is dirty too. A directory is never skipped.
 *
 * Left as they were: fdatasync() reaches no host call (the emitted `__syscall_fdatasync`), and
 * `wal_sync_method = fsync` keeps the WAL off it; PROXYFS has no fsync, and is not used here.
 */
export function installHostFsync(
  mod: EmscriptenModule,
  hostFsync: (fd: number, path: string) => void = (fd) => fsyncSync(fd),
  stat: HostStats = bigintStats,
): void {
  const { NODEFS } = mod;
  const s = NODEFS.stream_ops;
  const n = NODEFS.node_ops;
  /** Host files whose last host fsync returned, with nothing changed since. */
  const clean = new Set<string>();
  /** Host files a host fsync of which failed. */
  const failed = new Set<string>();
  const dirty = (file: HostFile | undefined) => {
    if (file !== undefined) clean.delete(file.key);
  };
  const fileAt = (path: string): HostFile | undefined => {
    try {
      return hostFile(stat.path(path));
    } catch {
      return undefined;
    }
  };
  const fileOf = (stream: EmscriptenStream): HostFile | undefined => {
    if (stream.host === undefined && typeof stream.nfd === "number") {
      stream.host = hostFile(stat.fd(stream.nfd));
    }
    return stream.host;
  };
  const wrap = <T extends Fn>(
    ops: Record<string, Fn | undefined>,
    op: string,
    f: (orig: T) => T,
  ) => {
    const orig = ops[op] as T | undefined;
    if (orig !== undefined) ops[op] = f(orig);
  };

  wrap<NonNullable<typeof s.open>>(s, "open", (open) => (stream) => {
    open(stream);
    stream.host = undefined;
    fileOf(stream);
  });
  wrap<NonNullable<typeof s.write>>(s, "write", (write) => (stream, ...rest) => {
    dirty(fileOf(stream));
    return write(stream, ...rest);
  });
  wrap<NonNullable<typeof s.setattr>>(s, "setattr", (setattr) => (stream, attr) => {
    if (attr.size !== undefined) dirty(fileOf(stream));
    setattr(stream, attr);
  });
  wrap<NonNullable<typeof s.allocate>>(s, "allocate", (allocate) => (stream, ...rest) => {
    dirty(fileOf(stream));
    allocate(stream, ...rest);
  });
  wrap<NonNullable<typeof n.setattr>>(n, "setattr", (setattr) => (node, attr) => {
    if (attr.size !== undefined) dirty(fileAt(NODEFS.realPath(node)));
    setattr(node, attr);
  });
  wrap<NonNullable<typeof n.mknod>>(n, "mknod", (mknod) => (parent, name, ...rest) => {
    const node = mknod(parent, name, ...rest);
    dirty(fileAt(join(NODEFS.realPath(parent), name)));
    return node;
  });
  wrap<NonNullable<typeof n.rename>>(n, "rename", (rename) => (node, dir, name) => {
    const moved = fileAt(NODEFS.realPath(node));
    const replaced = fileAt(join(NODEFS.realPath(dir), name));
    dirty(moved);
    dirty(replaced);
    rename(node, dir, name);
  });
  wrap<NonNullable<typeof n.unlink>>(n, "unlink", (unlink) => (parent, name) => {
    dirty(fileAt(join(NODEFS.realPath(parent), name)));
    unlink(parent, name);
  });

  s.fsync = (stream) => {
    let file: HostFile | undefined;
    try {
      if (typeof stream.nfd !== "number") {
        throw new Error(`no host descriptor for ${stream.path ?? "a stream"}`);
      }
      file = fileOf(stream);
      if (file !== undefined && !file.dir && clean.has(file.key)) {
        stats.skipped++;
        return 0;
      }
      hostFsync(stream.nfd, stream.node !== undefined ? NODEFS.realPath(stream.node) : "");
    } catch (cause) {
      if (file !== undefined) failed.add(file.key);
      // An error code makes fsync() fail in PostgreSQL; with data_sync_retry = off it PANICs.
      const err = new mod.FS.ErrnoError(EMSCRIPTEN_EIO);
      (err as Error & { cause?: unknown }).cause = cause;
      throw err;
    }
    // Clean only now that the host fsync has returned.
    if (file !== undefined && !failed.has(file.key)) clean.add(file.key);
    stats.total++;
    if (stream.path?.includes("/pg_wal/")) stats.wal++;
    return 0;
  };
}

/** NodeFS whose fsync reaches the host. */
class HostFsyncNodeFS extends NodeFS {
  readonly #testing: HostFsyncTesting | undefined;
  constructor(pgdata: string, testing?: HostFsyncTesting) {
    super(pgdata);
    this.#testing = testing;
  }
  override async init(pg: PGlite, opts: Parameters<NodeFS["init"]>[1]): ReturnType<NodeFS["init"]> {
    const r = await super.init(pg, opts);
    const preRun = r.emscriptenOpts.preRun ?? [];
    const hostFsync = this.#testing?.hostFsync;
    r.emscriptenOpts.preRun = [
      ...preRun,
      (mod: unknown) => installHostFsync(mod as EmscriptenModule, hostFsync),
    ] as typeof preRun;
    return r;
  }
}

export function nodeFs(pgdata: string, durability: Durability, testing?: HostFsyncTesting): NodeFS {
  return durability === "host-fsync" ? new HostFsyncNodeFS(pgdata, testing) : new NodeFS(pgdata);
}
