// The host fsync hook skips the fsync of a file that nothing has changed since its last host fsync
// in this instance (durability.ts, `installHostFsync`): 02-architecture §8 (a commit is durable
// once acknowledged). Each way a file's content or length can change makes it dirty, the first
// fsync of each file in an instance always reaches the host, and a failed one never counts.
//
// The hook is installed on a stand-in for NODEFS whose operations do what PGlite 0.5.16's do, on
// real files (the last describe checks that the real NODEFS has these operations and no others
// that change a file). The host fsync is a spy that syncs and records the path. The host stat is
// the real one, except that a case may give a path an inode number of its choosing: one above
// 2^53, or one a removed file had (a file system reuses them).

import {
  closeSync,
  fstatSync,
  fsyncSync,
  ftruncateSync,
  linkSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  openSync,
  renameSync,
  rmSync,
  truncateSync,
  unlinkSync,
  writeFileSync,
  writeSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { PGlite } from "@electric-sql/pglite";
import { NodeFS } from "@electric-sql/pglite/nodefs";
import { afterAll, describe, expect, it } from "vitest";
import {
  type EmscriptenModule,
  type HostStat,
  type HostStats,
  installHostFsync,
} from "./durability.ts";

const root = mkdtempSync(join(tmpdir(), "saveslot-host-fsync-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;

const O_RDWR = 2;
const O_TRUNC = 512;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

interface Node {
  path: string;
  mode: number;
}
interface Stream {
  node: Node;
  flags: number;
  nfd?: number;
  path?: string;
}

class ErrnoError extends Error {
  readonly errno: number;
  constructor(errno: number) {
    super(`errno ${errno}`);
    this.errno = errno;
  }
}

/** The stand-in's operations, as the cases call them. */
interface StreamOps {
  open(s: Stream): void;
  write(s: Stream, buf: Uint8Array, off: number, len: number, pos?: number): number;
  setattr(s: Stream, attr: { size?: number; mode?: number }): void;
  msync(s: Stream, buf: Uint8Array, off: number, len: number, flags: number): number;
  allocate?(s: Stream, off: number, len: number): void;
  fsync(s: Stream): number;
}
interface NodeOps {
  setattr(node: Node, attr: { size?: number; mode?: number }): void;
  mknod(parent: Node, name: string, mode: number): Node;
  rename(node: Node, to: Node, name: string): void;
  unlink(parent: Node, name: string): void;
}

/**
 * A NODEFS stand-in on a directory of its own, the hook installed: each operation as PGlite
 * 0.5.16's NODEFS does it (`msync` writes through `stream_ops.write`, looked up when called;
 * `mknod` writes an empty file on the host; `open` does not truncate: Emscripten's FS.open does,
 * through the node's setattr, as `fs.open` here does).
 */
function nodefs(o: { allocate?: boolean } = {}) {
  const dir = join(root, `d${n++}`);
  mkdirSync(dir);
  /** The paths each host fsync was for, in order; `fail` makes the next one throw. */
  const synced: string[] = [];
  let fail = false;
  /** Inode and device numbers given to paths, and the path each descriptor was opened on. */
  const inodes = new Map<string, bigint>();
  const devices = new Map<string, bigint>();
  const opened = new Map<number, string>();
  const given = (st: HostStat, path: string | undefined): HostStat => {
    const ino = path === undefined ? undefined : inodes.get(path);
    const dev = path === undefined ? undefined : devices.get(path);
    return ino === undefined && dev === undefined
      ? st
      : { dev: dev ?? st.dev, ino: ino ?? st.ino, isDirectory: () => st.isDirectory() };
  };
  const stat: HostStats = {
    fd: (fd) => given(fstatSync(fd, { bigint: true }), opened.get(fd)),
    path: (path) => given(lstatSync(path, { bigint: true }), path),
  };
  const NODEFS = {
    realPath: (node: Node) => node.path,
    stream_ops: {
      open(s: Stream) {
        s.nfd = openSync(s.node.path, "r+");
        opened.set(s.nfd, s.node.path);
      },
      write: (s: Stream, buf: Uint8Array, off: number, len: number, pos?: number) =>
        writeSync(s.nfd as number, buf, off, len, pos),
      setattr(s: Stream, attr: { size?: number; mode?: number }) {
        if (attr.size !== undefined) ftruncateSync(s.nfd as number, attr.size);
      },
      msync: (s: Stream, buf: Uint8Array, off: number, len: number) =>
        (NODEFS.stream_ops["write"] as StreamOps["write"])(s, buf, 0, len, off),
      ...(o.allocate === true
        ? {
            allocate(s: Stream, off: number, len: number) {
              writeSync(s.nfd as number, new Uint8Array(len), 0, len, off);
            },
          }
        : {}),
    } as Record<string, ((...a: never[]) => unknown) | undefined>,
    node_ops: {
      setattr(node: Node, attr: { size?: number }) {
        if (attr.size !== undefined) truncateSync(node.path, attr.size);
      },
      rename(node: Node, to: Node, name: string) {
        renameSync(node.path, join(to.path, name));
        node.path = join(to.path, name);
      },
      unlink(parent: Node, name: string) {
        unlinkSync(join(parent.path, name));
      },
      mknod(parent: Node, name: string, mode: number): Node {
        writeFileSync(join(parent.path, name), "", { mode: mode & 0o777 });
        return { path: join(parent.path, name), mode };
      },
    } as Record<string, ((...a: never[]) => unknown) | undefined>,
  };
  installHostFsync(
    { NODEFS, FS: { ErrnoError } } as unknown as EmscriptenModule,
    (fd, path) => {
      if (fail) {
        fail = false;
        throw new Error("PROBE fsync failed");
      }
      fsyncSync(fd);
      synced.push(path);
    },
    stat,
  );
  const ops = NODEFS.stream_ops as unknown as StreamOps;
  const nops = NODEFS.node_ops as unknown as NodeOps;
  const dirNode: Node = { path: dir, mode: S_IFDIR | 0o700 };
  const fs = {
    dir: dirNode,
    synced,
    failNext: () => {
      fail = true;
    },
    path: (name: string) => join(dir, name),
    /** Gives the file at `name` the inode number `ino`, as the host stat reports it. */
    inode: (name: string, ino: bigint) => inodes.set(join(dir, name), ino),
    /** Gives the file at `name` the device number `dev`, as the host stat reports it. */
    device: (name: string, dev: bigint) => devices.set(join(dir, name), dev),
    /** A file at `name`, made on the host (NODEFS's mknod writes an empty file). */
    make(name: string): Node {
      writeFileSync(join(dir, name), "x");
      return { path: join(dir, name), mode: S_IFREG | 0o600 };
    },
    /** As Emscripten's FS.open: O_TRUNC through the node's setattr, then the stream opened. */
    open(node: Node, flags = O_RDWR): Stream {
      if (flags & O_TRUNC) nops.setattr(node, { size: 0 });
      const s: Stream = { node, flags: flags & ~O_TRUNC, path: node.path };
      ops.open(s);
      return s;
    },
    write: (s: Stream, text = "y", pos = 0) =>
      ops.write(s, new TextEncoder().encode(text), 0, text.length, pos),
    /** Whether this fsync reached the host. */
    fsync(s: Stream): boolean {
      const before = synced.length;
      ops.fsync(s);
      return synced.length > before;
    },
    ops,
    nops,
  };
  return fs;
}

describe("the host fsync hook: which fsyncs reach the host", () => {
  it("a file's first fsync reaches the host; one with nothing changed since does not", () => {
    const fs = nodefs();
    const s = fs.open(fs.make("a"));
    expect(fs.fsync(s)).toBe(true);
    expect(fs.fsync(s)).toBe(false);
    // Another descriptor of the same file: the same host file, clean.
    expect(fs.fsync(fs.open(s.node))).toBe(false);
  });

  it("a write makes it dirty", () => {
    const fs = nodefs();
    const s = fs.open(fs.make("a"));
    fs.fsync(s);
    fs.write(s);
    expect(fs.fsync(s)).toBe(true);
    expect(fs.fsync(s)).toBe(false);
  });

  it("an msync makes it dirty", () => {
    const fs = nodefs();
    const s = fs.open(fs.make("a"));
    fs.fsync(s);
    fs.ops.msync(s, new TextEncoder().encode("m"), 0, 1, 0);
    expect(fs.fsync(s)).toBe(true);
  });

  it("a truncation by descriptor makes it dirty; a change of mode does not", () => {
    const fs = nodefs();
    const s = fs.open(fs.make("a"));
    fs.fsync(s);
    fs.ops.setattr(s, { mode: 0o600 });
    expect(fs.fsync(s)).toBe(false);
    fs.ops.setattr(s, { size: 0 });
    expect(fs.fsync(s)).toBe(true);
  });

  it("a truncation by path makes it dirty; a change of mode does not", () => {
    const fs = nodefs();
    const node = fs.make("a");
    const s = fs.open(node);
    fs.fsync(s);
    fs.nops.setattr(node, { mode: 0o600 });
    expect(fs.fsync(s)).toBe(false);
    fs.nops.setattr(node, { size: 0 });
    expect(fs.fsync(s)).toBe(true);
  });

  it("an open with O_TRUNC makes it dirty; an open without does not", () => {
    const fs = nodefs();
    const node = fs.make("a");
    const s = fs.open(node);
    fs.fsync(s);
    fs.open(node);
    expect(fs.fsync(s)).toBe(false);
    fs.open(node, O_RDWR | O_TRUNC);
    expect(fs.fsync(s)).toBe(true);
  });

  it("a write through another descriptor of the file makes it dirty", () => {
    const fs = nodefs();
    const node = fs.make("a");
    const s = fs.open(node);
    fs.fsync(s);
    fs.write(fs.open(node));
    expect(fs.fsync(s)).toBe(true);
  });

  it("a write through a hard link makes it dirty: a file is its device and inode, not its path", () => {
    const fs = nodefs();
    const node = fs.make("a");
    const s = fs.open(node);
    fs.fsync(s);
    // NODEFS makes no hard links; one made on the host reaches the same file.
    linkSync(node.path, fs.path("b"));
    fs.write(fs.open({ path: fs.path("b"), mode: node.mode }));
    expect(fs.fsync(s)).toBe(true);
  });

  it("a rename makes the file dirty, and a write at its new path does too", () => {
    const fs = nodefs();
    const node = fs.make("a");
    const s = fs.open(node);
    fs.fsync(s);
    fs.nops.rename(node, fs.dir, "b");
    expect(fs.fsync(s)).toBe(true);
    expect(fs.fsync(s)).toBe(false);
    fs.write(fs.open({ path: fs.path("b"), mode: node.mode }));
    expect(fs.fsync(s)).toBe(true);
  });

  it("a file replaced by a rename is dirty, as the file renamed over it", () => {
    const fs = nodefs();
    const target = fs.make("t");
    const t = fs.open(target);
    fs.fsync(t);
    // Kept reachable by a hard link, as an open descriptor keeps a replaced file.
    linkSync(target.path, fs.path("t-kept"));
    fs.nops.rename(fs.make("x"), fs.dir, "t");
    expect(fs.fsync(t)).toBe(true);
  });

  it("an unlinked file is forgotten: through another link it is dirty", () => {
    const fs = nodefs();
    const node = fs.make("a");
    linkSync(node.path, fs.path("b"));
    const s = fs.open(node);
    fs.fsync(s);
    fs.nops.unlink(fs.dir, "a");
    expect(fs.fsync(fs.open({ path: fs.path("b"), mode: node.mode }))).toBe(true);
  });

  it("a preallocation, where NODEFS has one, makes it dirty", () => {
    const fs = nodefs({ allocate: true });
    const s = fs.open(fs.make("a"));
    fs.fsync(s);
    fs.ops.allocate?.(s, 0, 4096);
    expect(fs.fsync(s)).toBe(true);
  });

  it("two files whose inode numbers differ only above 2^53 are two files", () => {
    const fs = nodefs();
    const a = fs.make("a");
    const b = fs.make("b");
    fs.inode("a", 2n ** 53n);
    fs.inode("b", 2n ** 53n + 1n);
    const sa = fs.open(a);
    const sb = fs.open(b);
    fs.fsync(sa);
    fs.fsync(sb);
    // As numbers both are 2^53: b's fsync would make a clean again, and a's write would be lost.
    fs.write(sa);
    fs.fsync(sb);
    expect(fs.fsync(sa)).toBe(true);
  });

  it("two files of one inode number on two devices are two files", () => {
    const fs = nodefs();
    const a = fs.make("a");
    const b = fs.make("b");
    fs.inode("a", 7n);
    fs.inode("b", 7n);
    fs.device("a", 1n);
    fs.device("b", 2n);
    const sa = fs.open(a);
    const sb = fs.open(b);
    fs.fsync(sa);
    fs.fsync(sb);
    // Keyed by the inode number alone they are one file: a's fsync would make b clean again, and
    // b's write would be lost.
    fs.write(sb);
    fs.fsync(sa);
    expect(fs.fsync(sb)).toBe(true);
  });

  it("a file created on the inode number of one removed is dirty, though that one was clean", () => {
    const fs = nodefs();
    fs.inode("a", 42n);
    const a = fs.open(fs.make("a"));
    fs.nops.unlink(fs.dir, "a");
    // Removed, still open: synced through its descriptor, its inode number clean again.
    expect(fs.fsync(a)).toBe(true);
    expect(fs.fsync(a)).toBe(false);
    // A new file on that number (the file system reuses it): NODEFS makes it with no write.
    fs.inode("b", 42n);
    const b = fs.nops.mknod(fs.dir, "b", S_IFREG | 0o600);
    expect(fs.fsync(fs.open(b))).toBe(true);
  });

  it("a directory's fsync always reaches the host", () => {
    const fs = nodefs();
    const d = { node: fs.dir, flags: 0, nfd: openSync(fs.dir.path, "r"), path: fs.dir.path };
    try {
      expect(fs.fsync(d)).toBe(true);
      expect(fs.fsync(d)).toBe(true);
    } finally {
      closeSync(d.nfd);
    }
  });

  it("a failed host fsync is an error to PostgreSQL (EIO), and the file never counts as clean", () => {
    const fs = nodefs();
    const s = fs.open(fs.make("a"));
    fs.failNext();
    expect(() => fs.fsync(s)).toThrow(expect.objectContaining({ errno: 29 }));
    // Succeeding later does not make it clean: each fsync of it still reaches the host.
    expect(fs.fsync(s)).toBe(true);
    expect(fs.fsync(s)).toBe(true);
  });

  it("an instance starts with no file clean: the first fsync of each, in each instance, reaches the host", () => {
    const one = nodefs();
    const node = one.make("a");
    const s = one.open(node);
    one.fsync(s);
    expect(one.fsync(s)).toBe(false);
    // A second instance on the same file (a store opened again): its first fsync is real.
    const two = nodefs();
    expect(two.fsync(two.open(node))).toBe(true);
  });
});

describe("PGlite's NODEFS, as the hook expects it", () => {
  it("has the operations the hook wraps, and none other that changes a file (no allocate, no link)", async () => {
    let seen: EmscriptenModule["NODEFS"] | undefined;
    class Seeing extends NodeFS {
      override async init(pg: PGlite, opts: Parameters<NodeFS["init"]>[1]) {
        const r = await super.init(pg, opts);
        r.emscriptenOpts.preRun = [
          ...(r.emscriptenOpts.preRun ?? []),
          (mod: unknown) => {
            seen = (mod as EmscriptenModule).NODEFS;
          },
        ] as NonNullable<typeof r.emscriptenOpts.preRun>;
        return r;
      }
    }
    const pg = await PGlite.create({ fs: new Seeing(join(root, `pg${n++}`)) });
    await pg.close();
    const s = Object.keys(seen?.stream_ops ?? {}).sort();
    const nd = Object.keys(seen?.node_ops ?? {}).sort();
    expect(s).toEqual(
      [
        "close",
        "dup",
        "getattr",
        "llseek",
        "mmap",
        "msync",
        "open",
        "read",
        "setattr",
        "write",
      ].sort(),
    );
    expect(nd).toEqual(
      [
        "getattr",
        "lookup",
        "mknod",
        "readdir",
        "readlink",
        "rename",
        "rmdir",
        "setattr",
        "statfs",
        "symlink",
        "unlink",
      ].sort(),
    );
    expect(typeof seen?.realPath).toBe("function");
  }, 120_000);
});
