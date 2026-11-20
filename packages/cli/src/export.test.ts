// `saveslot export` (06-cli §4.8) against a stand-in service on a home's socket: the data to stdout
// or `-o`, what goes to stderr, the confirmation for content in its grace period, the usage
// errors and the exit 8s, and the encrypted file. The real service is the entry package's tests'.

import { spawn, spawnSync } from "node:child_process";
import {
  chmodSync,
  existsSync,
  lstatSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  readlinkSync,
  rmSync,
  statSync,
  symlinkSync,
  writeFileSync,
} from "node:fs";
import { open } from "node:fs/promises";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { decryptStream } from "./export-crypto.ts";
import { run } from "./run.ts";
import { TEXTS } from "./texts.ts";

const TOKEN = `slt_${"A".repeat(43)}`;
const root = mkdtempSync(join(tmpdir(), "saveslot-cli-export-"));
const home = join(root, "home");
const seen: string[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;

const MANIFEST = JSON.stringify({
  saveslot_export: 1,
  tenant_id: "tn_x",
  event_format: 1,
  restore_count: 0,
  upto: 2,
  events: 2,
  exported_at: "2026-11-10T08:00:00.000Z",
  pending_deletions: "placeholder",
});
const BODY = `${MANIFEST}\n{"h":{"seq":1}}\n{"h":{"seq":2}}\n`;

beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  server = createServer((req, res) => {
    seen.push(req.url ?? "");
    answer(req, res);
  });
  await new Promise<void>((r) => server.listen(join(home, "run", "saveslot.sock"), r));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});
const ndjson = (_: IncomingMessage, res: ServerResponse) => res.writeHead(200).end(BODY);

async function cli(
  argv: string[],
  o: {
    answers?: string[];
    terminal?: () => never | undefined;
    stdinIsTTY?: boolean;
    stdoutIsTTY?: boolean;
    platform?: NodeJS.Platform;
  } = {},
) {
  const chunks: Buffer[] = [];
  let err = "";
  const asked: string[] = [];
  const code = await run(
    ["--home", home, ...argv],
    { SAVESLOT_TOKEN: TOKEN },
    {
      out: () => {
        throw new Error("text on stdout: the data goes as bytes");
      },
      outBytes: async (b) => {
        chunks.push(Buffer.from(b));
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: o.stdoutIsTTY ?? false,
      stderrIsTTY: false,
      stdinIsTTY: o.stdinIsTTY ?? o.answers !== undefined,
      ask: async (p) => {
        asked.push(p);
        return o.answers?.shift();
      },
      terminal: o.terminal ?? (() => undefined),
      ...(o.platform !== undefined ? { platform: o.platform } : {}),
    },
  );
  return { code, out: Buffer.concat(chunks), err, asked };
}

const passFile = (text: string, mode = 0o600) => {
  const f = join(root, `pass-${Math.random().toString(36).slice(2)}`);
  writeFileSync(f, text);
  chmodSync(f, mode);
  return f;
};

describe("export to stdout", () => {
  it("writes the service's bytes as they are, the summary to stderr, exit 0", async () => {
    answer = ndjson;
    seen.length = 0;
    const r = await cli(["export"]);
    expect(r.code).toBe(0);
    expect(r.out.toString("utf8")).toBe(BODY);
    expect(seen).toEqual(["/v1/export"]);
    expect(r.err).toContain("exported 2 events, last seq 2");
    expect(r.err).toContain("without the content waiting to be deleted");
  });

  it("--json does not turn the stream into JSON: stdout is the export either way", async () => {
    answer = ndjson;
    const r = await cli(["export", "--json"]);
    expect(r.out.toString("utf8")).toBe(BODY);
  });

  it("--after-seq goes to the service, a continuation says what it is", async () => {
    answer = ndjson;
    seen.length = 0;
    await cli(["export", "--after-seq", "5"]);
    expect(seen).toEqual(["/v1/export?after_seq=5"]);
  });

  it("an arguments or a bad --after-seq is a usage error, exit 2, nothing asked of the service", async () => {
    seen.length = 0;
    expect((await cli(["export", "file.ndjson"])).code).toBe(2);
    expect((await cli(["export", "--after-seq", "x"])).code).toBe(2);
    expect((await cli(["export", "--after-seq", "-1"])).code).toBe(2);
    expect(seen).toEqual([]);
  });

  it("a stream that is cut off is an error, exit 7 (not a success with a short file)", async () => {
    answer = (_req, res) => {
      res.writeHead(200);
      res.write(`${MANIFEST}\n{"h":{"seq":1}}\n`);
      setTimeout(() => res.destroy(), 20);
    };
    const r = await cli(["export"]);
    expect(r.code).toBe(7);
    expect(r.err).toContain("may be partial");
  });
});

describe("a connection instance's credential", () => {
  it("is refused by the service: the error as every command says it, nothing on stdout, no file", async () => {
    answer = (_req, res) =>
      res.writeHead(403, { "content-type": "application/json" }).end(
        JSON.stringify({
          error: { code: "insufficient_scope", message: "no", required_scope: "user_session" },
        }),
      );
    const f = join(root, "never.ndjson");
    const r = await cli(["export", "-o", f]);
    expect(r.code).toBe(6);
    expect(r.out.length).toBe(0);
    expect(() => statSync(f)).toThrow();
    expect(r.err).not.toContain("exported");
  });
});

describe("export to a file", () => {
  it("-o: the file holds the export, owner-only, and stdout nothing", async () => {
    answer = ndjson;
    const f = join(root, "out.ndjson");
    const r = await cli(["export", "-o", f]);
    expect(r.code).toBe(0);
    expect(r.out.length).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(BODY);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });
});

describe("content in its grace period", () => {
  it("is asked about; a yes goes on, with the flag to the service", async () => {
    answer = ndjson;
    seen.length = 0;
    const r = await cli(["export", "--include-pending-deletion"], { answers: ["y"] });
    expect(r.code).toBe(0);
    expect(r.asked[0]).toContain("waiting to be deleted");
    expect(seen).toEqual(["/v1/export?include_pending_deletion=true"]);
  });

  it("a no, or no terminal without --yes: exit 8, the service not asked", async () => {
    seen.length = 0;
    expect((await cli(["export", "--include-pending-deletion"], { answers: ["n"] })).code).toBe(8);
    const noTty = await cli(["export", "--include-pending-deletion"], { stdinIsTTY: false });
    expect([noTty.code, noTty.err]).toEqual([8, `${TEXTS.exportPendingNoTerminal}\n`]);
    expect(seen).toEqual([]);
  });

  it("--yes goes without asking", async () => {
    answer = ndjson;
    const r = await cli(["export", "--include-pending-deletion", "--yes"]);
    expect([r.code, r.asked]).toEqual([0, []]);
  });
});

describe("--encrypt", () => {
  const PASS = "correct horse battery staple";

  it("an age file that opens to the same bytes; the next --after-seq and the age command in the summary", async () => {
    answer = ndjson;
    const f = join(root, "enc.ndjson.age");
    const r = await cli([
      "export",
      "--encrypt",
      "--passphrase-file",
      passFile(`${PASS}\n`),
      "-o",
      f,
    ]);
    expect(r.code).toBe(0);
    const enc = readFileSync(f);
    expect(enc.subarray(0, 21).toString("latin1")).toBe("age-encryption.org/v1");
    expect(enc.includes(Buffer.from("saveslot_export"))).toBe(false);
    const plain = await decryptStream(new Blob([enc]).stream() as never, PASS);
    let text = "";
    for await (const c of plain as unknown as AsyncIterable<Uint8Array>)
      text += Buffer.from(c).toString("utf8");
    expect(text).toBe(BODY);
    expect(r.err).toContain("encrypted with the passphrase (age v1)");
    expect(r.err).toContain("to continue later: --after-seq 2");
    expect(r.err).toContain("age -d -o export.ndjson");
  });

  it("to stdout: the age bytes", async () => {
    answer = ndjson;
    const r = await cli(["export", "--encrypt", "--passphrase-file", passFile(`${PASS}\n`)]);
    expect(r.out.subarray(0, 21).toString("latin1")).toBe("age-encryption.org/v1");
  });

  it("no terminal and no file or descriptor: exit 8, the service not asked", async () => {
    seen.length = 0;
    const r = await cli(["export", "--encrypt"]);
    expect([r.code, r.err]).toEqual([8, `${TEXTS.exportNoPassphraseSource}\n`]);
    expect(seen).toEqual([]);
  });

  it("a passphrase option without --encrypt is a usage error, exit 2, not a quiet plain export", async () => {
    seen.length = 0;
    expect((await cli(["export", "--passphrase-file", passFile(`${PASS}\n`)])).code).toBe(2);
    // The descriptor option is not in this version (06-cli §4.9): an unknown option.
    expect((await cli(["export", "--encrypt", "--passphrase-fd", "3"])).code).toBe(2);
    expect(seen).toEqual([]);
  });

  it("a passphrase file open to others is refused before anything is exported", async () => {
    seen.length = 0;
    const r = await cli(["export", "--encrypt", "--passphrase-file", passFile(`${PASS}\n`, 0o644)]);
    expect(r.code).toBe(2);
    expect(seen).toEqual([]);
  });

  it("a short passphrase is accepted with one warning", async () => {
    answer = ndjson;
    const r = await cli(["export", "--encrypt", "--passphrase-file", passFile("short\n")]);
    expect(r.code).toBe(0);
    expect(r.err.split(TEXTS.exportPassphraseShort).length - 1).toBe(1);
  });
});

describe("the file of -o, and a terminal", () => {
  it("a file that is there is not written over: exit 2, its content as it was; --force replaces it, owner-only", async () => {
    answer = ndjson;
    const f = join(root, "there.ndjson");
    writeFileSync(f, "precious");
    chmodSync(f, 0o644);
    const refused = await cli(["export", "-o", f]);
    expect([refused.code, refused.err]).toEqual([
      2,
      `${TEXTS.usageError(TEXTS.exportFileExists)}\n`,
    ]);
    expect(readFileSync(f, "utf8")).toBe("precious");
    const forced = await cli(["export", "-o", f, "--force"]);
    expect(forced.code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(BODY);
    expect(statSync(f).mode & 0o777).toBe(0o600);
  });

  it("--force with no file there makes it, and --force is for -o only in effect", async () => {
    answer = ndjson;
    const f = join(root, "fresh.ndjson");
    expect((await cli(["export", "-o", f, "--force"])).code).toBe(0);
    expect(readFileSync(f, "utf8")).toBe(BODY);
  });

  it("an encrypted export to a terminal with no -o is refused, exit 2, before anything is asked", async () => {
    seen.length = 0;
    const r = await cli(
      ["export", "--encrypt", "--passphrase-file", passFile("a passphrase of length\n")],
      {
        stdoutIsTTY: true,
      },
    );
    expect([r.code, r.err]).toEqual([2, `${TEXTS.usageError(TEXTS.exportEncryptedToTerminal)}\n`]);
    expect(seen).toEqual([]);
  });

  it("a plain export to a terminal is allowed", async () => {
    answer = ndjson;
    expect((await cli(["export"], { stdoutIsTTY: true })).code).toBe(0);
  });

  it("the file is synced before it is closed; with --force before the rename, and a failed sync keeps the original", async () => {
    answer = ndjson;
    const dir = join(root, "sync");
    mkdirSync(dir);
    const f = join(dir, "backup.ndjson");
    const probe = await open(join(root, "probe"), "w");
    const proto = Object.getPrototypeOf(probe) as { sync: () => Promise<void> };
    await probe.close();
    const atSync: string[] = [];
    const spy = vi.spyOn(proto, "sync").mockImplementation(async function (this: unknown) {
      atSync.push(existsSync(f) ? readFileSync(f, "utf8") : "(none)");
    });
    try {
      expect((await cli(["export", "-o", f])).code).toBe(0);
      writeFileSync(f, "old backup");
      expect((await cli(["export", "-o", f, "--force"])).code).toBe(0);
      // Once each; with --force the old file still in place when the new one is synced.
      expect(atSync).toEqual([BODY, "old backup"]);

      writeFileSync(f, "old backup");
      spy.mockRejectedValue(Object.assign(new Error("EIO"), { code: "EIO" }));
      const r = await cli(["export", "-o", f, "--force"]);
      expect(r.code).toBe(1);
      expect(r.err).toContain(TEXTS.exportUnwritableOriginalKept);
      expect(readFileSync(f, "utf8")).toBe("old backup");
      expect(readdirSync(dir)).toEqual(["backup.ndjson"]);
    } finally {
      spy.mockRestore();
    }
  });
});

/** A service that sends the manifest and one event, then cuts the connection. */
const cutOff = (_req: IncomingMessage, res: ServerResponse) => {
  res.writeHead(200);
  res.write(`${MANIFEST}\n{"h":{"seq":1}}\n`);
  setTimeout(() => res.destroy(), 20);
};

describe("a stream cut off, into a file", () => {
  it("-o: exit 7; the file left is said to be partial", async () => {
    answer = cutOff;
    const f = join(root, "cut.ndjson");
    const r = await cli(["export", "-o", f]);
    expect(r.code).toBe(7);
    expect(r.err).toContain("may be partial");
    expect(readFileSync(f, "utf8").length).toBeLessThan(BODY.length);
  });

  it("--encrypt -o: exit 7; what is left does not open", async () => {
    answer = cutOff;
    const f = join(root, "cut.ndjson.age");
    const r = await cli([
      "export",
      "--encrypt",
      "--passphrase-file",
      passFile("a passphrase of words\n"),
      "-o",
      f,
    ]);
    expect(r.code).toBe(7);
    const plain = await decryptStream(
      new Blob([readFileSync(f)]).stream() as never,
      "a passphrase of words",
    )
      .then(async (st) => {
        for await (const _ of st as unknown as AsyncIterable<Uint8Array>) {
          // drain
        }
        return "opened";
      })
      .catch(() => "refused");
    expect(plain).toBe("refused");
  });

  it("--force: the file that was there is as it was, and no part file is left beside it", async () => {
    answer = ndjson;
    const dir = join(root, "force-cut");
    mkdirSync(dir);
    const f = join(dir, "backup.ndjson");
    expect((await cli(["export", "-o", f])).code).toBe(0);
    answer = cutOff;
    const r = await cli(["export", "-o", f, "--force"]);
    expect(r.code).toBe(7);
    expect(r.err).toContain(TEXTS.exportBrokenOriginalKept);
    expect(readFileSync(f, "utf8")).toBe(BODY);
    expect(readdirSync(dir)).toEqual(["backup.ndjson"]);
  });

  it("--force onto a symbolic link: the link is replaced, its target untouched", async () => {
    answer = ndjson;
    const dir = join(root, "force-link");
    mkdirSync(dir);
    const target = join(dir, "elsewhere.txt");
    writeFileSync(target, "keep me");
    chmodSync(target, 0o644);
    const link = join(dir, "out.ndjson");
    symlinkSync(target, link);
    const r = await cli(["export", "-o", link, "--force"]);
    expect(r.code).toBe(0);
    expect(lstatSync(link).isSymbolicLink()).toBe(false);
    expect(readFileSync(link, "utf8")).toBe(BODY);
    expect(statSync(link).mode & 0o777).toBe(0o600);
    expect(readFileSync(target, "utf8")).toBe("keep me");
    expect(statSync(target).mode & 0o777).toBe(0o644);
    // Without --force a link that is there is refused like a file.
    const dangling = join(dir, "dangling.ndjson");
    symlinkSync(join(dir, "nowhere"), dangling);
    expect((await cli(["export", "-o", dangling])).code).toBe(2);
    expect(existsSync(join(dir, "nowhere"))).toBe(false);
    expect(readlinkSync(dangling)).toBe(join(dir, "nowhere"));
  });
});

describe("-o that is there, checked first", () => {
  it("refused before the service is asked or a passphrase typed", async () => {
    seen.length = 0;
    const f = join(root, "early.ndjson");
    writeFileSync(f, "x");
    let asked = false;
    const r = await cli(["export", "--encrypt", "-o", f], {
      terminal: (() => {
        asked = true;
        return undefined;
      }) as never,
    });
    expect([r.code, seen, asked]).toEqual([2, [], false]);
  });
});

describe("why a passphrase source is refused", () => {
  it("each says its cause and what to do; exit 2; the service not asked", async () => {
    seen.length = 0;
    const open = await cli([
      "export",
      "--encrypt",
      "--passphrase-file",
      passFile("a passphrase of words\n", 0o644),
    ]);
    expect([open.code, open.err]).toEqual([2, `${TEXTS.usageError(TEXTS.passphraseFileOpen)}\n`]);
    // A link is followed: what it names is what is checked.
    const link = join(root, "pass-link");
    symlinkSync(passFile("a passphrase of words\n", 0o644), link);
    expect((await cli(["export", "--encrypt", "--passphrase-file", link])).err).toBe(
      `${TEXTS.usageError(TEXTS.passphraseFileOpen)}\n`,
    );
    expect((await cli(["export", "--encrypt", "--passphrase-file", root])).err).toBe(
      `${TEXTS.usageError(TEXTS.passphraseFileNotRegular)}\n`,
    );
    expect(
      (await cli(["export", "--encrypt", "--passphrase-file", join(root, "missing")])).err,
    ).toBe(`${TEXTS.usageError(TEXTS.passphraseFileUnreadable)}\n`);
    expect((await cli(["export", "--encrypt", "--passphrase-file", passFile("\n")])).err).toBe(
      `${TEXTS.usageError(TEXTS.passphraseEmpty)}\n`,
    );
    expect(
      (await cli(["export", "--encrypt", "--passphrase-file", passFile("a\tb of words\n")])).err,
    ).toBe(`${TEXTS.usageError(TEXTS.passphraseControl)}\n`);
    expect(seen).toEqual([]);
  });
});

describe("on Windows", () => {
  it("--encrypt takes --passphrase-file only: without it, a usage error", async () => {
    seen.length = 0;
    const none = await cli(["export", "--encrypt", "-o", join(root, "w1")], { platform: "win32" });
    expect([none.code, none.err]).toEqual([
      2,
      `${TEXTS.usageError(TEXTS.exportWindowsFileOnly)}\n`,
    ]);
    expect(seen).toEqual([]);
    answer = ndjson;
    const ok = await cli(
      [
        "export",
        "--encrypt",
        "--passphrase-file",
        passFile("a passphrase of words\n"),
        "-o",
        join(root, "w3"),
      ],
      {
        platform: "win32",
      },
    );
    expect(ok.code).toBe(0);
  });
});

describe("a password manager's output as the passphrase file", () => {
  it("a pipe (what `<(pass show …)` gives): its first line, the export encrypted with it", async () => {
    answer = ndjson;
    const dir = join(root, "pipe");
    mkdirSync(dir);
    const fifo = join(dir, "p");
    expect(spawnSync("mkfifo", [fifo]).status).toBe(0);
    // The writer: another process, as the shell's process substitution runs one.
    const writer = spawn("sh", [
      "-c",
      `sleep 0.3; printf '%s\\n' "a passphrase of words" > "$1"`,
      "sh",
      fifo,
    ]);
    const exited = new Promise((r) => writer.on("exit", r));
    const f = join(dir, "out.age");
    const r = await cli(["export", "--encrypt", "--passphrase-file", fifo, "-o", f]);
    await exited;
    expect(r.code).toBe(0);
    const plain = await decryptStream(
      new Blob([readFileSync(f)]).stream() as never,
      "a passphrase of words",
    );
    let text = "";
    for await (const c of plain as unknown as AsyncIterable<Uint8Array>)
      text += Buffer.from(c).toString("utf8");
    expect(text).toBe(BODY);
  });
});
