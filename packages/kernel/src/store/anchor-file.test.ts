// The anchor store in a file (./anchor-file.ts): the port's conformance suite, then what is the
// file's own: the format read strictly, temporary files of interrupted writes, detecting another
// writer, and that a write failing at any step leaves a whole file behind.

import { spawnSync } from "node:child_process";
import * as fs from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import { afterEach, describe, expect, it } from "vitest";
import { anchorStoreConformance, deletionEntry } from "./anchor-conformance.fixture.ts";
import { type AnchorFileOps, openFileAnchorStore } from "./anchor-file.ts";

const TENANT = `tn_${"1".repeat(26)}`;

const dirs: string[] = [];
function tempDir(): string {
  const d = fs.mkdtempSync(join(tmpdir(), "anchor-"));
  dirs.push(d);
  return d;
}
afterEach(() => {
  for (const d of dirs.splice(0)) fs.rmSync(d, { recursive: true, force: true });
});

anchorStoreConformance("file", () => {
  const path = join(tempDir(), "anchor.json");
  return { store: openFileAnchorStore(path), reopen: () => openFileAnchorStore(path) };
});

const REAL: AnchorFileOps = {
  readFileSync: (p, e) => fs.readFileSync(p, e),
  openSync: (p, f, m) => fs.openSync(p, f, m),
  writeSync: (fd, d, o, l) => fs.writeSync(fd, d, o, l),
  fsyncSync: (fd) => fs.fsyncSync(fd),
  closeSync: (fd) => fs.closeSync(fd),
  renameSync: (a, b) => fs.renameSync(a, b),
  readdirSync: (p) => fs.readdirSync(p),
  unlinkSync: (p) => fs.unlinkSync(p),
};

describe("the file", () => {
  it("is JSON of format 1 with a generation raised on every write, mode 0600", async () => {
    const path = join(tempDir(), "anchor.json");
    const store = openFileAnchorStore(path);
    await store.putDeletion(TENANT, deletionEntry(1));
    await store.advanceHighWater(TENANT, 4);
    expect(JSON.parse(fs.readFileSync(path, "utf8"))).toEqual({
      format: 1,
      generation: 2,
      tenants: {
        [TENANT]: { deletions: [deletionEntry(1)], highWater: 4, restoreCount: 0 },
      },
    });
    expect(fs.statSync(path).mode & 0o777).toBe(0o600);
  });

  it("is not written when nothing changes", async () => {
    const path = join(tempDir(), "anchor.json");
    const store = openFileAnchorStore(path);
    await store.advanceHighWater(TENANT, 4);
    const before = fs.statSync(path).mtimeMs;
    const text = fs.readFileSync(path, "utf8");
    await store.advanceHighWater(TENANT, 3);
    await store.removeDeletion(TENANT, "pi_none");
    await store.abortImport(TENANT, "im_1");
    await store.read(TENANT);
    expect(fs.readFileSync(path, "utf8")).toBe(text);
    expect(fs.statSync(path).mtimeMs).toBe(before);
  });

  it("missing reads as empty and is not created by a read", async () => {
    const path = join(tempDir(), "anchor.json");
    expect(await openFileAnchorStore(path).read(TENANT)).toEqual({
      deletions: [],
      highWater: 0,
      restoreCount: 0,
    });
    expect(fs.existsSync(path)).toBe(false);
  });

  it("needs its directory to exist", () => {
    expect(() => openFileAnchorStore(join(tempDir(), "no", "anchor.json"))).toThrow(/ENOENT/);
  });
});

describe("tenant IDs that are names of built-in object properties", () => {
  const names = ["constructor", "__proto__", "toString"];
  it("are stored as their own keys and read back after reopening", async () => {
    const path = join(tempDir(), "anchor.json");
    const store = openFileAnchorStore(path);
    for (const [i, t] of names.entries()) await store.advanceHighWater(t, i + 1);
    const again = openFileAnchorStore(path);
    for (const [i, t] of names.entries()) {
      expect(await again.read(t)).toEqual({ deletions: [], highWater: i + 1, restoreCount: 0 });
    }
    expect(Object.keys(JSON.parse(fs.readFileSync(path, "utf8")).tenants)).toEqual(names);
  });
});

describe("a file that cannot be read", () => {
  const good = {
    format: 1,
    generation: 3,
    tenants: { [TENANT]: { deletions: [deletionEntry(1)], highWater: 4, restoreCount: 0 } },
  };
  const tenantWith = (patch: Record<string, unknown>) => ({
    ...good,
    tenants: { [TENANT]: { ...good.tenants[TENANT], ...patch } },
  });

  it.each<[string, string, RegExp]>([
    ["not JSON", "{secret: pi_1", /: not valid JSON$/],
    ["truncated", JSON.stringify(good).slice(0, 40), /: not valid JSON$/],
    ["empty", "", /: not valid JSON$/],
    ["an array", "[]", /: not an object$/],
    ["format 2", JSON.stringify({ ...good, format: 2 }), /: format is not 1$/],
    ["no format", JSON.stringify({ generation: 1, tenants: {} }), /: format is not 1$/],
    ["an unknown key", JSON.stringify({ ...good, extra: "secret" }), /: an unknown key$/],
    ["a negative generation", JSON.stringify({ ...good, generation: -1 }), /: generation$/],
    ["tenants not an object", JSON.stringify({ ...good, tenants: [] }), /: tenants$/],
    [
      "a high water mark not a count",
      JSON.stringify(tenantWith({ highWater: "4" })),
      /: highWater$/,
    ],
    [
      "a restore count missing",
      JSON.stringify(tenantWith({ restoreCount: undefined })),
      /: missing key restoreCount$/,
    ],
    [
      "an empty marker",
      JSON.stringify(tenantWith({ importInProgress: "" })),
      /: importInProgress$/,
    ],
    [
      "an entry of an unknown state",
      JSON.stringify(tenantWith({ deletions: [{ ...deletionEntry(1), state: "secret" }] })),
      /: deletions\[0\]: state$/,
    ],
    [
      "two entries with one ID",
      JSON.stringify(tenantWith({ deletions: [deletionEntry(1), deletionEntry(1)] })),
      /: deletions\[1\]: deletion ID listed twice$/,
    ],
  ])("%s: an error naming the file and the place, never the content", async (_, text, where) => {
    const path = join(tempDir(), "anchor.json");
    fs.writeFileSync(path, text);
    const store = openFileAnchorStore(path);
    const e = await store.read(TENANT).then(
      () => undefined,
      (x: unknown) => x,
    );
    expect(e).toMatchObject({ name: "AnchorStoreError", code: "corrupt" });
    const message = (e as Error).message;
    expect(message.startsWith(`anchor file ${path}: `)).toBe(true);
    expect(message).toMatch(where);
    expect(message).not.toMatch(/secret|pi_/);
    // Writes refuse too, and leave the file as it was.
    await expect(store.advanceHighWater(TENANT, 9)).rejects.toMatchObject({ code: "corrupt" });
    expect(fs.readFileSync(path, "utf8")).toBe(text);
  });
});

describe("temporary files", () => {
  it("of an interrupted write are removed on open; other files are kept", () => {
    const dir = tempDir();
    const path = join(dir, "anchor.json");
    const left = `anchor.json.${"a".repeat(32)}.tmp`;
    const keep = [
      "anchor.json.tmp",
      `anchor.json.${"a".repeat(31)}.tmp`,
      `other.json.${"b".repeat(32)}.tmp`,
      "credentials.json",
    ];
    for (const f of [left, ...keep]) fs.writeFileSync(join(dir, f), "x");
    openFileAnchorStore(path);
    expect(fs.readdirSync(dir).sort()).toEqual(keep.sort());
  });

  it("are not left behind by successful writes", async () => {
    const dir = tempDir();
    const store = openFileAnchorStore(join(dir, "anchor.json"));
    for (let i = 0; i < 5; i++) await store.putDeletion(TENANT, deletionEntry(i));
    expect(fs.readdirSync(dir)).toEqual(["anchor.json"]);
  });
});

describe("another writer", () => {
  it("is detected by the generation: the write is refused and the file kept", async () => {
    const path = join(tempDir(), "anchor.json");
    const a = openFileAnchorStore(path);
    const b = openFileAnchorStore(path);
    await a.advanceHighWater(TENANT, 1);
    await b.advanceHighWater(TENANT, 2);
    const text = fs.readFileSync(path, "utf8");
    await expect(a.advanceHighWater(TENANT, 3)).rejects.toMatchObject({
      name: "AnchorStoreError",
      code: "conflict",
    });
    expect(fs.readFileSync(path, "utf8")).toBe(text);
    // The instance stays stopped: every later write is refused too, until the store is reopened.
    await expect(a.advanceHighWater(TENANT, 4)).rejects.toMatchObject({ code: "conflict" });
    await expect(a.putDeletion(TENANT, deletionEntry(1))).rejects.toMatchObject({
      code: "conflict",
    });
    expect(fs.readFileSync(path, "utf8")).toBe(text);
    await openFileAnchorStore(path).advanceHighWater(TENANT, 4);
    expect((await b.read(TENANT)).highWater).toBe(4);
  });

  it("is detected when the file appears after this instance read it missing", async () => {
    const path = join(tempDir(), "anchor.json");
    const a = openFileAnchorStore(path);
    await a.read(TENANT);
    await openFileAnchorStore(path).advanceHighWater(TENANT, 2);
    await expect(a.advanceHighWater(TENANT, 3)).rejects.toMatchObject({ code: "conflict" });
  });
});

type Step = "open" | "write" | "fsync" | "rename" | "dir fsync";

/** File operations that fail at `step` of the next write. */
function failingAt(step: Step, dir: string): AnchorFileOps {
  let dirFd: number | undefined;
  const fail = () => {
    throw Object.assign(new Error(`injected failure: ${step}`), { code: "EIO" });
  };
  return {
    ...REAL,
    openSync: (p, f, m) => {
      if (step === "open" && p.endsWith(".tmp")) fail();
      const fd = REAL.openSync(p, f, m);
      if (p === dir) dirFd = fd;
      return fd;
    },
    writeSync: (fd, d, o, l) => (step === "write" ? fail() : REAL.writeSync(fd, d, o, l)),
    fsyncSync: (fd) => {
      if (fd === dirFd ? step === "dir fsync" : step === "fsync") fail();
      REAL.fsyncSync(fd);
    },
    renameSync: (a, b) => (step === "rename" ? fail() : REAL.renameSync(a, b)),
  };
}

describe("a write failing part way", () => {
  const before = { deletions: [deletionEntry(1)], highWater: 5, restoreCount: 0 };
  const after = { deletions: [deletionEntry(1), deletionEntry(2)], highWater: 5, restoreCount: 0 };

  it.each<[Step, typeof before]>([
    ["open", before],
    ["write", before],
    ["fsync", before],
    ["rename", before],
    // The new file is in place; only the directory entry's durability is unknown.
    ["dir fsync", after],
  ])("at %s: rejects, and a new instance reads a whole file", async (step, expected) => {
    const dir = tempDir();
    const path = join(dir, "anchor.json");
    const setUp = openFileAnchorStore(path);
    await setUp.putDeletion(TENANT, deletionEntry(1));
    await setUp.advanceHighWater(TENANT, 5);

    const failing = openFileAnchorStore(path, { ops: failingAt(step, dir) });
    await expect(failing.putDeletion(TENANT, deletionEntry(2))).rejects.toThrow(
      `injected failure: ${step}`,
    );
    // The failed write removed its temporary file itself, before any open cleans up.
    expect(fs.readdirSync(dir)).toEqual(["anchor.json"]);
    expect(await openFileAnchorStore(path).read(TENANT)).toEqual(expected);
  });

  it("at dir fsync: the instance keeps its generation and goes on without a false conflict", async () => {
    const dir = tempDir();
    const path = join(dir, "anchor.json");
    let failNext = true;
    const ops: AnchorFileOps = {
      ...REAL,
      fsyncSync: (fd) => {
        // The directory is fsynced last; fail it once.
        if (failNext && fs.fstatSync(fd).isDirectory()) {
          failNext = false;
          throw new Error("injected failure: dir fsync");
        }
        REAL.fsyncSync(fd);
      },
    };
    const store = openFileAnchorStore(path, { ops });
    await expect(store.advanceHighWater(TENANT, 1)).rejects.toThrow("dir fsync");
    await store.advanceHighWater(TENANT, 2);
    expect((await store.read(TENANT)).highWater).toBe(2);
  });
});

describe("short writes", () => {
  /** Real operations whose writeSync writes at most half of what it is asked; with `stall`, nothing after the first call. */
  function partial(stall: boolean): { ops: AnchorFileOps; calls: () => number } {
    let calls = 0;
    return {
      calls: () => calls,
      ops: {
        ...REAL,
        writeSync: (fd, d, o, l) => {
          calls++;
          if (stall && calls > 1) return 0;
          return REAL.writeSync(fd, d, o, Math.max(1, Math.floor(l / 2)));
        },
      },
    };
  }

  it("are continued until every byte is written", async () => {
    const dir = tempDir();
    const path = join(dir, "anchor.json");
    const { ops, calls } = partial(false);
    await openFileAnchorStore(path, { ops }).putDeletion(TENANT, deletionEntry(1));
    expect(calls()).toBeGreaterThan(5);
    expect(await openFileAnchorStore(path).read(TENANT)).toEqual({
      deletions: [deletionEntry(1)],
      highWater: 0,
      restoreCount: 0,
    });
    expect(fs.readdirSync(dir)).toEqual(["anchor.json"]);
  });

  it("that stop after half: the write fails and the whole old file stays", async () => {
    const dir = tempDir();
    const path = join(dir, "anchor.json");
    await openFileAnchorStore(path).advanceHighWater(TENANT, 3);
    const text = fs.readFileSync(path, "utf8");
    const store = openFileAnchorStore(path, { ops: partial(true).ops });
    await expect(store.putDeletion(TENANT, deletionEntry(1))).rejects.toThrow(/no progress/);
    expect(fs.readFileSync(path, "utf8")).toBe(text);
    expect(fs.readdirSync(dir)).toEqual(["anchor.json"]);
  });
});

describe("a process killed during a write", () => {
  // The child writes once, then is killed just before the rename of its second write.
  const child = `
    import { openFileAnchorStore } from ${JSON.stringify(pathToFileURL(join(import.meta.dirname, "anchor-file.ts")).href)};
    import * as fs from "node:fs";
    const [path, phase] = process.argv.slice(2);
    let armed = false;
    const ops = {
      readFileSync: (p, e) => fs.readFileSync(p, e),
      openSync: (p, f, m) => fs.openSync(p, f, m),
      writeSync: (fd, d, o, l) => fs.writeSync(fd, d, o, l),
      fsyncSync: (fd) => fs.fsyncSync(fd),
      closeSync: (fd) => fs.closeSync(fd),
      renameSync: (a, b) => {
        if (armed && phase === "before") process.kill(process.pid, "SIGKILL");
        fs.renameSync(a, b);
        if (armed && phase === "after") process.kill(process.pid, "SIGKILL");
      },
      readdirSync: (p) => fs.readdirSync(p),
      unlinkSync: (p) => fs.unlinkSync(p),
    };
    const store = openFileAnchorStore(path, { ops });
    await store.advanceHighWater("${TENANT}", 1);
    armed = true;
    await store.advanceHighWater("${TENANT}", 2);
  `;

  it.each([
    ["before the rename", "before", 1],
    ["after the rename", "after", 2],
  ])(
    "%s: the next open reads a whole file and removes the temporary one",
    (_, phase, highWater) => {
      const dir = tempDir();
      const path = join(dir, "anchor.json");
      const script = join(tempDir(), "child.mjs");
      fs.writeFileSync(script, child);
      const r = spawnSync(process.execPath, [script, path, phase], { encoding: "utf8" });
      expect([r.signal, r.stderr]).toEqual(["SIGKILL", ""]);
      const store = openFileAnchorStore(path);
      expect(fs.readdirSync(dir)).toEqual(["anchor.json"]);
      return store.read(TENANT).then((a) => expect(a.highWater).toBe(highWater));
    },
  );
});
