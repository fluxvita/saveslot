// The anchor store in a file (docs/zh-CN/spec/02-architecture.md §8 «锚点存储», §5 «控制面存储»:
// local mode keeps it in `control/anchor.json`; §11: the kernel ships this implementation, for its
// tests and for hosts that embed it with a path of their choosing).
//
// Exported from the subpath `@fluxvita/saveslot-kernel/anchor-file`, not from the package entry, so
// that importing the kernel does not load `node:fs`.
//
// Format: one JSON object, `{"format": 1, "generation": <n>, "tenants": {<tenant>: <Anchor>}}`.
// Each tenant's value has exactly the keys of the port's `Anchor`. The file holds no user content:
// IDs, states, instants, seqs and opaque block positions only (03-deletion «删除登记»).
//
// Durability: every write goes to a temporary file in the same directory, which is fsynced, renamed
// over the file and followed by an fsync of the directory; the promise resolves after all of that
// (§8, the local control plane: "write to a temporary file in the same directory → flush to disk
// → rename over the target → flush the directory"). A crash at any point leaves either the
// whole old file or the whole new one. Each operation reads the file, changes it and writes it
// back; nothing is cached, so a failed write leaves no half-new state in memory either.
//
// A missing file reads as empty: that is how the first run looks. A file deleted by hand cannot be
// told apart from it; like a restore of the anchor together with the tenant storage, this is a
// stated boundary (§8). A file that cannot be read is an error, never empty: an empty registry
// would let restored deletions come back.
//
// Concurrency: one instance runs its operations one at a time. Across processes nothing is locked:
// the spec gives the file a single writer, the saveslot service process, whose exclusivity the
// opener provides. The `generation` counter, raised on every write, only detects another writer
// after the fact: a write whose last known generation differs from the file's is refused
// (`conflict`). After a conflict the instance keeps its last known generation, so every later
// write is refused too until the store is opened again: it stops rather than write over a file it
// no longer knows. It is NOT a guarantee: a write by another process between this instance's read
// and its rename is overwritten unnoticed.
//
// Tenant IDs come from callers and are keys of the file: they are looked up in a Map, never on a
// plain object, so a name such as `constructor` or `__proto__` is just another tenant.

import { randomBytes } from "node:crypto";
import * as fs from "node:fs";
import { basename, dirname, join } from "node:path";
import {
  type Anchor,
  type AnchorStore,
  AnchorStoreError,
  type DeletionEntry,
  type DeletionId,
  type ImportId,
  type RestoreId,
  type Seq,
  type TenantId,
} from "./anchor.ts";
import {
  anchorProblem,
  copyAnchor,
  copyEntry,
  EMPTY_ANCHOR,
  entriesProblem,
  entryProblem,
  isCount,
  isName,
} from "./anchor-check.ts";

/** The file operations this store uses. Replaceable in tests, to fail a step on purpose. */
export interface AnchorFileOps {
  readonly readFileSync: (path: string, encoding: "utf8") => string;
  readonly openSync: (path: string, flags: string, mode: number) => number;
  /** Writes up to `length` bytes of `data` from `offset`; returns how many were written. */
  readonly writeSync: (fd: number, data: Uint8Array, offset: number, length: number) => number;
  readonly fsyncSync: (fd: number) => void;
  readonly closeSync: (fd: number) => void;
  readonly renameSync: (from: string, to: string) => void;
  readonly readdirSync: (path: string) => string[];
  readonly unlinkSync: (path: string) => void;
}

const NODE_OPS: AnchorFileOps = {
  readFileSync: (p, e) => fs.readFileSync(p, e),
  openSync: (p, f, m) => fs.openSync(p, f, m),
  writeSync: (fd, d, o, l) => fs.writeSync(fd, d, o, l),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (a, b) => fs.renameSync(a, b),
  readdirSync: (p) => fs.readdirSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
};

const FORMAT = 1;

interface FileContent {
  readonly generation: number;
  readonly tenants: ReadonlyMap<TenantId, Anchor>;
}

export interface FileAnchorStoreOptions {
  /** For tests only. */
  readonly ops?: AnchorFileOps;
}

/**
 * Opens the anchor store kept in the file at `path`; its directory must exist. Removes temporary
 * files an interrupted write of this store left beside it.
 */
export function openFileAnchorStore(path: string, opts: FileAnchorStoreOptions = {}): AnchorStore {
  return new FileAnchorStore(path, opts.ops ?? NODE_OPS);
}

class FileAnchorStore implements AnchorStore {
  readonly #path: string;
  readonly #ops: AnchorFileOps;
  /** The generation this instance last read or wrote; undefined before the first operation. */
  #generation: number | undefined;
  #tail: Promise<unknown> = Promise.resolve();

  constructor(path: string, ops: AnchorFileOps) {
    this.#path = path;
    this.#ops = ops;
    const tmp = new RegExp(`^${escapeRegExp(basename(path))}\\.[0-9a-f]{32}\\.tmp$`);
    for (const name of ops.readdirSync(dirname(path))) {
      if (tmp.test(name)) ops.unlinkSync(join(dirname(path), name));
    }
  }

  /**
   * Runs `f` after every operation queued before it. With synchronous file calls each operation
   * already runs whole in one step; the queue keeps operations apart should a step become
   * asynchronous.
   */
  #run<T>(f: () => T): Promise<T> {
    const p = this.#tail.then(f);
    this.#tail = p.catch(() => undefined);
    return p;
  }

  #load(): FileContent {
    let text: string;
    try {
      text = this.#ops.readFileSync(this.#path, "utf8");
    } catch (e) {
      if ((e as NodeJS.ErrnoException).code === "ENOENT") {
        this.#generation ??= 0;
        return { generation: 0, tenants: new Map() };
      }
      throw e;
    }
    const corrupt = (what: string) =>
      new AnchorStoreError("corrupt", `anchor file ${this.#path}: ${what}`);
    let v: unknown;
    try {
      v = JSON.parse(text);
    } catch {
      // The parser's message quotes the text; it is not passed on.
      throw corrupt("not valid JSON");
    }
    if (v === null || typeof v !== "object" || Array.isArray(v)) throw corrupt("not an object");
    const o = v as Record<string, unknown>;
    for (const k of Object.keys(o)) {
      if (!["format", "generation", "tenants"].includes(k)) throw corrupt("an unknown key");
    }
    if (o["format"] !== FORMAT) throw corrupt("format is not 1");
    if (!isCount(o["generation"])) throw corrupt("generation");
    const tenants = o["tenants"];
    if (tenants === null || typeof tenants !== "object" || Array.isArray(tenants)) {
      throw corrupt("tenants");
    }
    const out = new Map<TenantId, Anchor>();
    for (const [t, a] of Object.entries(tenants)) {
      if (!isName(t)) throw corrupt("a tenant ID");
      const p = anchorProblem(a);
      if (p !== undefined) throw corrupt(`a tenant's anchor: ${p}`);
      out.set(t, copyAnchor(a as Anchor));
    }
    this.#generation ??= o["generation"];
    return { generation: o["generation"], tenants: out };
  }

  #save(prev: FileContent, tenant: TenantId, anchor: Anchor): void {
    if (this.#generation !== undefined && prev.generation !== this.#generation) {
      throw new AnchorStoreError(
        "conflict",
        `anchor file ${this.#path} was written by someone else (generation ${prev.generation}, expected ${this.#generation})`,
      );
    }
    const generation = prev.generation + 1;
    const text = `${JSON.stringify({
      format: FORMAT,
      generation,
      // Object.fromEntries defines own properties, `__proto__` included.
      tenants: Object.fromEntries(new Map(prev.tenants).set(tenant, anchor)),
    })}\n`;
    const tmp = `${this.#path}.${randomBytes(16).toString("hex")}.tmp`;
    const ops = this.#ops;
    const fd = ops.openSync(tmp, "wx", 0o600);
    try {
      try {
        // A write may take only part of the bytes: go on until all are written.
        const bytes = Buffer.from(text, "utf8");
        for (let off = 0; off < bytes.length; ) {
          const n = ops.writeSync(fd, bytes, off, bytes.length - off);
          if (!(n > 0)) throw new Error(`anchor file ${this.#path}: write made no progress`);
          off += n;
        }
        ops.fsyncSync(fd);
      } finally {
        ops.closeSync(fd);
      }
      ops.renameSync(tmp, this.#path);
    } catch (e) {
      try {
        ops.unlinkSync(tmp);
      } catch {
        // Left for the next open to remove.
      }
      throw e;
    }
    // The new content is in place: whatever happens next, it is what the next read sees.
    this.#generation = generation;
    const dir = ops.openSync(dirname(this.#path), "r", 0);
    try {
      ops.fsyncSync(dir);
    } finally {
      ops.closeSync(dir);
    }
  }

  /** Reads the tenant's anchor, applies `change`, writes it when it returns a new anchor. */
  #update<T>(tenant: TenantId, change: (a: Anchor) => { anchor?: Anchor; result: T }): Promise<T> {
    if (!isName(tenant)) return reject("invalid_entry", "tenant ID");
    return this.#run(() => {
      const file = this.#load();
      const { anchor, result } = change(file.tenants.get(tenant) ?? EMPTY_ANCHOR);
      if (anchor !== undefined) this.#save(file, tenant, anchor);
      return result;
    });
  }

  read(tenant: TenantId): Promise<Anchor> {
    if (!isName(tenant)) return reject("invalid_entry", "tenant ID");
    return this.#run(() => copyAnchor(this.#load().tenants.get(tenant) ?? EMPTY_ANCHOR));
  }

  putDeletion(tenant: TenantId, entry: DeletionEntry): Promise<void> {
    const p = entryProblem(entry);
    if (p !== undefined) return reject("invalid_entry", `deletion entry: ${p}`);
    const e = copyEntry(entry);
    return this.#update(tenant, (a) => {
      const i = a.deletions.findIndex((x) => x.deletion === e.deletion);
      const deletions = i < 0 ? [...a.deletions, e] : a.deletions.with(i, e);
      return { anchor: { ...a, deletions }, result: undefined };
    });
  }

  removeDeletion(tenant: TenantId, deletion: DeletionId): Promise<void> {
    return this.#update(tenant, (a) =>
      a.deletions.some((x) => x.deletion === deletion)
        ? {
            anchor: { ...a, deletions: a.deletions.filter((x) => x.deletion !== deletion) },
            result: undefined,
          }
        : { result: undefined },
    );
  }

  advanceHighWater(tenant: TenantId, seq: Seq): Promise<void> {
    if (!isCount(seq)) return reject("invalid_entry", "high water mark");
    return this.#update(tenant, (a) =>
      seq > a.highWater
        ? { anchor: { ...a, highWater: seq }, result: undefined }
        : { result: undefined },
    );
  }

  beginRestore(tenant: TenantId, restore: RestoreId): Promise<Anchor> {
    if (!isName(restore)) return reject("invalid_entry", "restore ID");
    return this.#update(tenant, (a) => {
      if (a.restoreInProgress !== undefined) return { result: copyAnchor(a) };
      const next = { ...a, restoreInProgress: restore, restoreCount: a.restoreCount + 1 };
      return { anchor: next, result: copyAnchor(next) };
    });
  }

  endRestore(tenant: TenantId, restore: RestoreId, highWater: Seq): Promise<void> {
    if (!isCount(highWater)) return reject("invalid_entry", "high water mark");
    return this.#update(tenant, (a) => {
      if (a.restoreInProgress !== restore) throw notInProgress("restore", a.restoreInProgress);
      const { restoreInProgress: _, ...rest } = a;
      return {
        anchor: { ...rest, highWater: Math.max(a.highWater, highWater) },
        result: undefined,
      };
    });
  }

  beginImport(tenant: TenantId, importId: ImportId): Promise<void> {
    if (!isName(importId)) return reject("invalid_entry", "import ID");
    return this.#update(tenant, (a) => {
      if (
        a.deletions.length > 0 ||
        a.restoreCount !== 0 ||
        a.restoreInProgress !== undefined ||
        a.importInProgress !== undefined
      ) {
        throw new AnchorStoreError("import_refused", "the anchor is not empty");
      }
      return { anchor: { ...a, importInProgress: importId }, result: undefined };
    });
  }

  endImport(
    tenant: TenantId,
    importId: ImportId,
    r: {
      readonly deletions: readonly DeletionEntry[];
      readonly highWater: Seq;
      readonly restoreCount: number;
    },
  ): Promise<void> {
    const p = entriesProblem(r.deletions);
    if (p !== undefined)
      return reject("invalid_entry", `deletion entries${p.startsWith("[") ? "" : ": "}${p}`);
    if (!isCount(r.highWater)) return reject("invalid_entry", "high water mark");
    if (!isCount(r.restoreCount)) return reject("invalid_entry", "restore count");
    const deletions = r.deletions.map(copyEntry);
    return this.#update(tenant, (a) => {
      if (a.importInProgress !== importId) throw notInProgress("import", a.importInProgress);
      const { importInProgress: _, ...rest } = a;
      return {
        anchor: {
          ...rest,
          deletions,
          highWater: Math.max(a.highWater, r.highWater),
          restoreCount: r.restoreCount,
        },
        result: undefined,
      };
    });
  }

  abortImport(tenant: TenantId, importId: ImportId): Promise<void> {
    return this.#update(tenant, (a) => {
      if (a.importInProgress === undefined) return { result: undefined };
      if (a.importInProgress !== importId) throw notInProgress("import", a.importInProgress);
      const { importInProgress: _, ...rest } = a;
      return { anchor: rest, result: undefined };
    });
  }
}

const escapeRegExp = (s: string) => s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");

const reject = (code: "invalid_entry", what: string): Promise<never> =>
  Promise.reject(new AnchorStoreError(code, `not a valid ${what}`));

const notInProgress = (what: string, current: string | undefined) =>
  new AnchorStoreError(
    "not_in_progress",
    current === undefined ? `no ${what} in progress` : `another ${what} is in progress`,
  );
