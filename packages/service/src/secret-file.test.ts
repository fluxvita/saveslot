// A secret file the server mode's deployer keeps (06-cli §4.1 «服务器模式的配置»): followed through
// links, its owner not checked, refused when it is not a regular file or is open to others; checked
// and read on one open file.

import { execFileSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, renameSync, symlinkSync, writeFileSync } from "node:fs";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, afterEach, describe, expect, it, vi } from "vitest";
import { readSecretFile, SecretFileError } from "./secret-file.ts";

// A hook run right after the file is opened, to change what is at its path then.
const hooks = vi.hoisted(() => ({ afterOpen: undefined as (() => Promise<void>) | undefined }));
vi.mock("node:fs/promises", async (importOriginal) => {
  const real = await importOriginal<typeof import("node:fs/promises")>();
  return {
    ...real,
    open: async (...a: Parameters<typeof real.open>) => {
      const handle = await real.open(...a);
      await hooks.afterOpen?.();
      return handle;
    },
  };
});
afterEach(() => {
  hooks.afterOpen = undefined;
});

/** Running as root, whom the permission bits do not bind. */
const AS_ROOT = process.getuid?.() === 0;

const root = mkdtempSync(join(tmpdir(), "saveslot-secret-"));
// Removing the temporary directory can pass the default 10 s hook time under load.
afterAll(() => rm(root, { recursive: true, force: true }), 60_000);
let n = 0;
const fresh = () => join(root, `f${n++}`);

function secret(text: string, mode = 0o600): string {
  const path = fresh();
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

async function refusal(path: string): Promise<{ code: string; message: string }> {
  try {
    await readSecretFile(path);
  } catch (e) {
    if (e instanceof SecretFileError) return { code: e.code, message: e.message };
    throw e;
  }
  throw new Error("the file was read");
}

describe("readSecretFile", () => {
  it.each([0o600, 0o400, 0o640, 0o440])("mode %o: read; the group may read it", async (mode) => {
    expect(await readSecretFile(secret("k-1", mode))).toBe("k-1");
  });

  it.each([0o601, 0o602, 0o604, 0o644, 0o666])("mode %o: open to others, refused", async (mode) => {
    expect((await refusal(secret("k-1", mode))).code).toBe("open_to_others");
  });

  it("missing, and a directory: each its own code; no message names the path", async () => {
    const dir = fresh();
    mkdirSync(dir);
    const found = [await refusal(fresh()), await refusal(dir)];
    expect(found.map((f) => f.code)).toEqual(["missing", "not_a_file"]);
    for (const f of found) expect(f.message).not.toContain(root);
  });

  it("a link is followed, as a mounted secret is; the file it leads to is what is checked", async () => {
    const target = secret("k-linked");
    const link = fresh();
    symlinkSync(target, link);
    expect(await readSecretFile(link)).toBe("k-linked");
    chmodSync(target, 0o644);
    expect((await refusal(link)).code).toBe("open_to_others");
  });

  it("checked and read on one open file: another file put at the path after the open is not read", async () => {
    const path = secret("k-checked");
    const other = secret("k-other", 0o644);
    hooks.afterOpen = async () => {
      renameSync(other, path);
    };
    expect(await readSecretFile(path)).toBe("k-checked");
  });

  it("a named pipe: refused as not a file, without waiting for a writer", async () => {
    const pipe = fresh();
    execFileSync("mkfifo", ["-m", "600", pipe]);
    expect((await refusal(pipe)).code).toBe("not_a_file");
  }, 5_000);

  it.skipIf(AS_ROOT)(
    "one the process cannot read: the error is the system's, not taken as missing",
    async () => {
      const path = secret("k-1", 0o000);
      await expect(readSecretFile(path)).rejects.toMatchObject({ code: "EACCES" });
    },
  );
});
