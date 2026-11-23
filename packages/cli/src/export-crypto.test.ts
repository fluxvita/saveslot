// The passphrase encryption of an export (06-cli §4.8): the age v1 file it makes, what a wrong
// passphrase or a damaged file does, and where the passphrase may come from.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  closeSync,
  mkdtempSync,
  openSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import * as age from "age-encryption";
import { afterAll, describe, expect, it } from "vitest";
import {
  decryptStream,
  encryptStream,
  MAX_ASKS,
  PassphraseError,
  passphraseFromFile,
  readPassphrase,
  type Terminal,
  typeInto,
} from "./export-crypto.ts";

const dirs: string[] = [];
function tempDir(): string {
  const d = mkdtempSync(join(tmpdir(), "saveslot-cli-crypto-"));
  dirs.push(d);
  return d;
}
afterAll(() => {
  for (const d of dirs) rmSync(d, { recursive: true, force: true });
});

const bytes = (s: string) => new TextEncoder().encode(s);
const streamOf = (chunks: Uint8Array[]) =>
  new ReadableStream<Uint8Array>({
    start(c) {
      for (const x of chunks) c.enqueue(x);
      c.close();
    },
  });
async function collect(s: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const parts: Uint8Array[] = [];
  for await (const x of s) parts.push(x);
  return Buffer.concat(parts);
}
const PLAIN = `{"saveslot_export":1}\n${'{"h":{"seq":1}}\n'.repeat(5000)}`; // spans several age chunks
const PASS = "correct horse battery staple";

// A file for the cases about reading one, where the scrypt work factor plays no part: made at a low
// factor, which the reader takes from the header. Two scrypt runs at the default factor take
// seconds on a busy runner; the cases above keep the default, through `encryptStream`.
async function quickFile(plain: string): Promise<Uint8Array> {
  const e = new age.Encrypter();
  e.setScryptWorkFactor(10);
  e.setPassphrase(PASS);
  return e.encrypt(bytes(plain));
}

const codeOf = async (p: Promise<unknown>) =>
  p.then(
    () => "no error",
    (e: unknown) => (e instanceof PassphraseError ? e.code : String(e)),
  );

describe("encrypting the export stream", () => {
  it("makes an age v1 passphrase file that opens to the same bytes", async () => {
    const enc = await collect(await encryptStream(streamOf([bytes(PLAIN)]), PASS));
    expect(
      Buffer.from(enc).toString("latin1").startsWith("age-encryption.org/v1\n-> scrypt "),
    ).toBe(true);
    expect(enc.length).toBeGreaterThan(PLAIN.length);
    const out = await collect(await decryptStream(streamOf([enc]), PASS));
    expect(Buffer.from(out).toString("utf8")).toBe(PLAIN);
  });

  it("takes the stream in pieces of any size", async () => {
    const all = bytes(PLAIN);
    const pieces: Uint8Array[] = [];
    for (let i = 0; i < all.length; i += 7001) pieces.push(all.subarray(i, i + 7001));
    const enc = await collect(await encryptStream(streamOf(pieces), PASS));
    expect(Buffer.from(await collect(await decryptStream(streamOf([enc]), PASS))).toString()).toBe(
      PLAIN,
    );
  });

  it("two encryptions of the same stream differ (own salt and file key)", async () => {
    const a = await collect(await encryptStream(streamOf([bytes(PLAIN)]), PASS));
    const b = await collect(await encryptStream(streamOf([bytes(PLAIN)]), PASS));
    expect(Buffer.from(a).equals(Buffer.from(b))).toBe(false);
  });

  it("a wrong passphrase does not open it", async () => {
    const enc = await quickFile(PLAIN);
    // The right one does, at that factor: the refusals below are not about the factor.
    expect(Buffer.from(await collect(await decryptStream(streamOf([enc]), PASS))).toString()).toBe(
      PLAIN,
    );
    await expect(
      decryptStream(streamOf([enc]), `${PASS}x`).then((s) => collect(s)),
    ).rejects.toThrow();
  });

  it("a truncated file fails by the end of reading, never as a short success", async () => {
    const enc = await quickFile(PLAIN);
    const cut = enc.subarray(0, enc.length - 100);
    await expect(decryptStream(streamOf([cut]), PASS).then((s) => collect(s))).rejects.toThrow();
  });

  it("a changed byte in the body fails", async () => {
    const enc = Buffer.from(await quickFile(PLAIN));
    enc[enc.length - 40] = (enc[enc.length - 40] ?? 0) ^ 0xff;
    await expect(decryptStream(streamOf([enc]), PASS).then((s) => collect(s))).rejects.toThrow();
  });

  it("extra data after the file is refused (ciphertexts cannot be concatenated)", async () => {
    const a = await quickFile("one\n");
    const b = await quickFile("two\n");
    await expect(
      decryptStream(streamOf([Buffer.concat([a, b])]), PASS).then((s) => collect(s)),
    ).rejects.toThrow();
  });

  // The spec's interoperability check: the `age` command opens the file, with the passphrase
  // given non-interactively through age-plugin-batchpass (`AGE_PASSPHRASE_FD`). It needs `age`
  // and the plugin on PATH. Where they are missing the test is skipped, unless
  // SAVESLOT_TEST_AGE_REQUIRED=1 is set (CI): then it fails, so a job without them is not green.
  const have = (cmd: string) => spawnSync(cmd, ["--version"]).error === undefined;
  const haveAge =
    have("age") && spawnSync("age-plugin-batchpass", ["--version"]).error === undefined;
  const required = process.env["SAVESLOT_TEST_AGE_REQUIRED"] === "1";
  it("age and age-plugin-batchpass are there when the job says they must be", () => {
    if (required) expect(haveAge).toBe(true);
  });
  it.skipIf(!haveAge)("the age command line opens it, to the same bytes", async () => {
    const dir = tempDir();
    const file = join(dir, "export.ndjson.age");
    const passFile = join(dir, "pass");
    writeFileSync(file, await collect(await encryptStream(streamOf([bytes(PLAIN)]), PASS)));
    writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 });
    const fd = openSync(passFile, "r");
    try {
      const r = spawnSync("age", ["-d", "-j", "batchpass", file], {
        env: { ...process.env, AGE_PASSPHRASE_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", fd],
        maxBuffer: 1 << 26,
      });
      expect(r.stderr.toString()).toBe("");
      expect(r.status).toBe(0);
      expect(r.stdout.toString("utf8")).toBe(PLAIN);
    } finally {
      closeSync(fd);
    }
  });
  it.skipIf(!haveAge)("a file the age command line made opens here", async () => {
    const dir = tempDir();
    const plainFile = join(dir, "plain");
    const passFile = join(dir, "pass");
    writeFileSync(plainFile, PLAIN);
    writeFileSync(passFile, `${PASS}\n`, { mode: 0o600 });
    const fd = openSync(passFile, "r");
    let out: Buffer;
    try {
      const r = spawnSync("age", ["-e", "-j", "batchpass", plainFile], {
        env: { ...process.env, AGE_PASSPHRASE_FD: "3" },
        stdio: ["ignore", "pipe", "pipe", fd],
        maxBuffer: 1 << 26,
      });
      expect(r.status).toBe(0);
      out = r.stdout;
    } finally {
      closeSync(fd);
    }
    const back = await collect(await decryptStream(streamOf([out]), PASS));
    expect(Buffer.from(back).toString("utf8")).toBe(PLAIN);
  });
});

describe("where the passphrase comes from", () => {
  const fileWith = (content: string, mode = 0o600) => {
    const f = join(tempDir(), "pass");
    writeFileSync(f, content);
    chmodSync(f, mode);
    return f;
  };

  it("a file: the first line, without its line end (LF or CRLF)", async () => {
    expect((await passphraseFromFile(fileWith(`${PASS}\nsecond line\n`))).value).toBe(PASS);
    expect((await passphraseFromFile(fileWith(`${PASS}\r\n`))).value).toBe(PASS);
    expect((await passphraseFromFile(fileWith(PASS))).value).toBe(PASS);
  });

  it("a file wider than 0600 is refused, for group and for others", async () => {
    expect(await codeOf(passphraseFromFile(fileWith(PASS, 0o640)))).toBe("file_open_to_others");
    expect(await codeOf(passphraseFromFile(fileWith(PASS, 0o604)))).toBe("file_open_to_others");
    expect(await codeOf(passphraseFromFile(fileWith(PASS, 0o400)))).toBe("no error");
  });

  it("a link is followed, and what it names is checked; a file that is not there is refused", async () => {
    const good = fileWith(`${PASS}\n`);
    const link = join(tempDir(), "link");
    symlinkSync(good, link);
    expect((await passphraseFromFile(link)).value).toBe(PASS);
    const open = fileWith(`${PASS}\n`, 0o644);
    const link2 = join(tempDir(), "link2");
    symlinkSync(open, link2);
    expect(await codeOf(passphraseFromFile(link2))).toBe("file_open_to_others");
    expect(await codeOf(passphraseFromFile(join(tempDir(), "missing")))).toBe("file_unreadable");
  });

  it("a directory is refused", async () => {
    expect(await codeOf(passphraseFromFile(tempDir()))).toBe("file_not_regular");
  });

  // As root every file is the current user's to read; the owner check is about who owns it.
  it.skipIf(process.getuid?.() === 0)("a file another user owns is refused", async () => {
    expect(await codeOf(passphraseFromFile("/etc/hosts"))).toBe("file_not_owned");
  });

  it("empty is refused (an empty first line, an empty file)", async () => {
    expect(await codeOf(passphraseFromFile(fileWith("\nsomething\n")))).toBe("empty");
    expect(await codeOf(passphraseFromFile(fileWith("")))).toBe("empty");
  });

  it("shorter than 12 characters is accepted with one warning; 12 is not warned", async () => {
    expect((await passphraseFromFile(fileWith("short pw\n"))).warnings).toEqual(["short"]);
    expect((await passphraseFromFile(fileWith("twelve chars\n"))).warnings).toEqual([]);
    // Characters, not bytes: eleven of them in more bytes still warn.
    expect((await passphraseFromFile(fileWith("口令口令口令口令口令口\n"))).warnings).toEqual([
      "short",
    ]);
  });

  it("a byte order mark or a control character in the line is refused, not dropped", async () => {
    expect(await codeOf(passphraseFromFile(fileWith(`\uFEFF${PASS}\n`)))).toBe("control_character");
    expect(await codeOf(passphraseFromFile(fileWith(`a\tpassphrase of words\n`)))).toBe(
      "control_character",
    );
    expect(await codeOf(passphraseFromFile(fileWith(`a passphrase\u007f of words\n`)))).toBe(
      "control_character",
    );
  });

  it("the same passphrase gives the same bytes from a file and the terminal", async () => {
    const odd = "pässwörd 口令 \u00a0 end";
    const f = fileWith(`${odd}\n`);
    const viaTerm = (await readPassphrase({}, fakeTerminal([odd, odd]))).value;
    expect([(await passphraseFromFile(f)).value, viaTerm]).toEqual([odd, odd]);
  });

  it("not UTF-8 is refused, not guessed at", async () => {
    const f = join(tempDir(), "bin");
    writeFileSync(f, Buffer.from([0xff, 0xfe, 0x41, 0x0a]));
    chmodSync(f, 0o600);
    expect(await codeOf(passphraseFromFile(f))).toBe("line_malformed");
  });

  it("no source and no terminal: refused", async () => {
    expect(await codeOf(readPassphrase({}, undefined))).toBe("no_terminal");
  });
});

function fakeTerminal(answers: string[]): Terminal & { shown: string[]; asked: string[] } {
  const shown: string[] = [];
  const asked: string[] = [];
  return {
    shown,
    asked,
    write: (t) => shown.push(t),
    async readHidden(prompt) {
      asked.push(prompt);
      const a = answers.shift();
      if (a === undefined) throw new Error("asked more than the test expected");
      return a;
    },
  };
}

describe("asking on the terminal", () => {
  it("asks twice and takes the entry", async () => {
    const t = fakeTerminal([PASS, PASS]);
    expect((await readPassphrase({}, t)).value).toBe(PASS);
    expect(t.asked).toEqual(["Passphrase: ", "Again: "]);
  });

  it("asks again when the two differ, and gives up after MAX_ASKS", async () => {
    const ok = fakeTerminal(["one", "two", PASS, PASS]);
    expect((await readPassphrase({}, ok)).value).toBe(PASS);
    expect(ok.shown).toHaveLength(1);

    const bad = fakeTerminal(Array.from({ length: MAX_ASKS * 2 }, (_, i) => `x${i}`));
    expect(await codeOf(readPassphrase({}, bad))).toBe("mismatch");
  });

  it("an empty entry, or one with a control character, is asked again, counted in the tries", async () => {
    const t = fakeTerminal(["", "", "a\tb", "a\tb", PASS, PASS]);
    expect((await readPassphrase({}, t)).value).toBe(PASS);
    expect(t.shown).toEqual([
      "the passphrase is empty; try again.\n",
      "the passphrase holds a control character; try again.\n",
    ]);
    expect(await codeOf(readPassphrase({}, fakeTerminal(["", "", "", "", "", ""])))).toBe(
      "mismatch",
    );
  });

  it("a file given: the terminal is not asked", async () => {
    const f = join(tempDir(), "p");
    writeFileSync(f, `${PASS}\n`);
    chmodSync(f, 0o600);
    const t = fakeTerminal([]);
    expect((await readPassphrase({ file: f }, t)).value).toBe(PASS);
    expect(t.asked).toEqual([]);
  });
});

describe("typing a passphrase (the keystrokes of the terminal prompt)", () => {
  const type = (...keys: string[]) => {
    let line = "";
    for (const k of keys) {
      const r = typeInto(line, k);
      if (r.interrupted || r.done) return { ...r };
      line = r.line;
    }
    return { line, done: false, interrupted: false };
  };

  it("collects characters, whole or in pieces, and ends at Enter", () => {
    expect(typeInto("", "abc\r")).toEqual({ line: "abc", done: true, interrupted: false });
    expect(type("a", "b", "\n")).toEqual({ line: "ab", done: true, interrupted: false });
  });

  it("Backspace takes off one character, not one byte", () => {
    expect(typeInto("", "口令\u007f\r").line).toBe("口");
    expect(typeInto("", "\u007f\u007fa\r").line).toBe("a");
  });

  it("Ctrl-C interrupts; Ctrl-D only on an empty line", () => {
    expect(typeInto("abc", "\u0003").interrupted).toBe(true);
    expect(typeInto("", "\u0004").interrupted).toBe(true);
    expect(typeInto("a", "\u0004").interrupted).toBe(false);
  });

  it("other control keys are kept, for the passphrase to be refused rather than changed", () => {
    expect(typeInto("", "a\u001bb\t\r").line).toBe("a\u001bb\t");
  });
});

describe("a pipe as the passphrase file", () => {
  const MODULE = new URL("./export-crypto.ts", import.meta.url).pathname;
  const script = `import { passphraseFromFile } from ${JSON.stringify(MODULE)};
    try { const p = await passphraseFromFile(process.argv.at(-1), 3000); console.log("ok:" + p.value); }
    catch (e) { console.log("refused:" + e.code); }`;

  it("the shell's process substitution, `<(…)`: its first line, even from a slow writer", () => {
    const r = spawnSync(
      "bash",
      [
        "-c",
        `exec "$NODE" --input-type=module --no-warnings -e "$SCRIPT" <(sleep 1; printf '%s\\nmore\\n' "$PASS")`,
      ],
      {
        env: { ...process.env, NODE: process.execPath, SCRIPT: script, PASS },
        encoding: "utf8",
        timeout: 30_000,
      },
    );
    expect(r.stdout.trim()).toBe(`ok:${PASS}`);
  });

  it("a writer that writes nothing: refused after the wait, not hung", async () => {
    const fifo = join(tempDir(), "q");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    // A writer that holds the pipe open and never writes.
    const writer = openSync(fifo, "r+");
    try {
      expect(await codeOf(passphraseFromFile(fifo, 300))).toBe("pipe_timeout");
    } finally {
      closeSync(writer);
    }
  });

  it("a named pipe whose writer opens it late: waited for, within the limit", async () => {
    const fifo = join(tempDir(), "late");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    const writer = spawn("sh", ["-c", `sleep 0.3; printf '%s\\n' "$2" > "$1"`, "sh", fifo, PASS]);
    const exited = new Promise((r) => writer.on("exit", r));
    expect((await passphraseFromFile(fifo, 5000)).value).toBe(PASS);
    await exited;
  });

  it("a named pipe no writer ever opens: refused after the wait", async () => {
    const fifo = join(tempDir(), "e");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    expect(await codeOf(passphraseFromFile(fifo, 300))).toBe("pipe_timeout");
  });
});
