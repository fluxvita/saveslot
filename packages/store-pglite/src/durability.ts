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

import { fsyncSync } from "node:fs";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import type { Durability, HostSyncStats } from "./protocol.ts";

/** PGlite start parameters for a durability mode. */
export function startParams(durability: Durability): string[] {
  if (durability === "pglite-default") return [...PGlite.defaultStartParams];
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
  ];
}

/** Settings that must hold after start for each mode; checked at open. */
export function expectedSettings(durability: Durability): Record<string, string> {
  if (durability === "pglite-default") return { fsync: "off" };
  return {
    fsync: "on",
    wal_sync_method: "fsync",
    synchronous_commit: "on",
    full_page_writes: "on",
    data_sync_retry: "off",
  };
}

interface EmscriptenStream {
  nfd?: number;
  path?: string;
}
interface EmscriptenModule {
  NODEFS: { stream_ops: { fsync?: (stream: EmscriptenStream) => number } };
  FS: { ErrnoError: new (errno: number) => Error };
}

const EMSCRIPTEN_EIO = 29;

const stats = { total: 0, wal: 0 };

export function hostSyncStats(): HostSyncStats {
  return { ...stats };
}

function installHostFsync(mod: EmscriptenModule): void {
  mod.NODEFS.stream_ops.fsync = (stream) => {
    try {
      if (typeof stream.nfd === "number") {
        fsyncSync(stream.nfd);
      } else {
        throw new Error(`no host descriptor for ${stream.path ?? "a stream"}`);
      }
    } catch (cause) {
      // An error code makes fsync() fail in PostgreSQL; with data_sync_retry = off it PANICs.
      const err = new mod.FS.ErrnoError(EMSCRIPTEN_EIO);
      (err as Error & { cause?: unknown }).cause = cause;
      throw err;
    }
    stats.total++;
    if (stream.path?.includes("/pg_wal/")) stats.wal++;
    return 0;
  };
}

/** NodeFS whose fsync reaches the host. */
class HostFsyncNodeFS extends NodeFS {
  override async init(pg: PGlite, opts: Parameters<NodeFS["init"]>[1]): ReturnType<NodeFS["init"]> {
    const r = await super.init(pg, opts);
    const preRun = r.emscriptenOpts.preRun ?? [];
    r.emscriptenOpts.preRun = [
      ...preRun,
      (mod: unknown) => installHostFsync(mod as EmscriptenModule),
    ] as typeof preRun;
    return r;
  }
}

export function nodeFs(pgdata: string, durability: Durability): NodeFS {
  return durability === "host-fsync" ? new HostFsyncNodeFS(pgdata) : new NodeFS(pgdata);
}
