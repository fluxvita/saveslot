// The server mode's handle key file (06-cli §4.1 `SAVESLOT_HANDLE_KEY_FILE`): made once by
// `server init`, read only by the server; followed through links, its owner not checked, refused
// when open to others.

import {
  chmodSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { CursorKeys, HandleKeyFileError } from "./cursor.ts";

// A write that fails, as on a full disk, when a test sets it.
const hooks = vi.hoisted(() => ({ failWrite: false }));
vi.mock("node:fs", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs")>();
  return {
    ...real,
    writeSync: (...a: Parameters<typeof real.writeSync>) => {
      if (hooks.failWrite) {
        throw Object.assign(new Error("no space left on device"), { code: "ENOSPC" });
      }
      return (real.writeSync as (...b: typeof a) => number)(...a);
    },
  };
});
afterEach(() => {
  hooks.failWrite = false;
});

const root = mkdtempSync(join(tmpdir(), "saveslot-keyfile-"));
afterAll(() => rmSync(root, { recursive: true, force: true }));
let n = 0;
const fresh = () => join(root, `k${n++}`);

async function refusal(path: string): Promise<{ code: string; message: string }> {
  try {
    await CursorKeys.fromFile(path);
  } catch (e) {
    if (e instanceof HandleKeyFileError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("the file was taken");
}

const NOW = "2026-11-20T12:00:00.000Z";

describe("the server mode's handle key file", () => {
  it("made at 0600; read back, its key signs a handle it then verifies", async () => {
    const path = fresh();
    expect(await CursorKeys.createFile(path)).toEqual({ created: true });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const keys = await CursorKeys.fromFile(path);
    const handle = keys.sign("pos-1", "ci_a", NOW);
    expect((await CursorKeys.fromFile(path)).verify(handle, "ci_a", NOW)).toBe("pos-1");
  });

  it("made again: left as it was, and checked", async () => {
    const path = fresh();
    await CursorKeys.createFile(path);
    const before = readFileSync(path, "utf8");
    expect(await CursorKeys.createFile(path)).toEqual({ created: false });
    expect(readFileSync(path, "utf8")).toBe(before);
    chmodSync(path, 0o644);
    await expect(CursorKeys.createFile(path)).rejects.toMatchObject({ code: "open_to_others" });
  });

  it("two made at once: one makes it, the other finds it; both read the same key", async () => {
    const path = fresh();
    const made = await Promise.all([CursorKeys.createFile(path), CursorKeys.createFile(path)]);
    expect(made.map((m) => m.created).sort()).toEqual([false, true]);
    const a = await CursorKeys.fromFile(path);
    expect((await CursorKeys.fromFile(path)).keyIds()).toEqual(a.keyIds());
  });

  it("each way it cannot be used has its own code; no message names the path", async () => {
    const missing = fresh();
    const dir = fresh();
    mkdirSync(dir);
    const corrupt = fresh();
    writeFileSync(corrupt, "{}", { mode: 0o600 });
    const open = fresh();
    await CursorKeys.createFile(open);
    chmodSync(open, 0o604);
    const found = [
      await refusal(missing),
      await refusal(dir),
      await refusal(corrupt),
      await refusal(open),
    ];
    expect(found.map((f) => f.code)).toEqual([
      "missing",
      "not_a_file",
      "corrupt",
      "open_to_others",
    ]);
    for (const f of found) expect(f.message).not.toContain(root);
  });

  it.each([0o600, 0o400, 0o640, 0o440])(
    "mode %o is taken: group may read, the owner is not checked",
    async (mode) => {
      const path = fresh();
      await CursorKeys.createFile(path);
      chmodSync(path, mode);
      await expect(CursorKeys.fromFile(path)).resolves.toBeInstanceOf(CursorKeys);
    },
  );

  it.each([0o601, 0o602, 0o604, 0o644, 0o666])(
    "mode %o is refused: open to others",
    async (mode) => {
      const path = fresh();
      await CursorKeys.createFile(path);
      chmodSync(path, mode);
      expect((await refusal(path)).code).toBe("open_to_others");
    },
  );

  it("a link to the file is followed, as a mounted secret is", async () => {
    const target = fresh();
    await CursorKeys.createFile(target);
    const link = fresh();
    symlinkSync(target, link);
    expect((await CursorKeys.fromFile(link)).keyIds()).toEqual(
      (await CursorKeys.fromFile(target)).keyIds(),
    );
  });

  it("a first write that fails leaves no file: the next run makes it", async () => {
    const path = fresh();
    hooks.failWrite = true;
    await expect(CursorKeys.createFile(path)).rejects.toMatchObject({ code: "ENOSPC" });
    hooks.failWrite = false;
    expect(() => statSync(path)).toThrow(expect.objectContaining({ code: "ENOENT" }));
    expect(await CursorKeys.createFile(path)).toEqual({ created: true });
    expect((await CursorKeys.fromFile(path)).keyIds()).toHaveLength(1);
  });

  it("made where there is no directory: refused, nothing made", async () => {
    const path = join(fresh(), "handle-key");
    await expect(CursorKeys.createFile(path)).rejects.toMatchObject({ code: "ENOENT" });
  });
});
