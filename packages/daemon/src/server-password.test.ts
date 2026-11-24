// A local account's new password from a file or the terminal (06-cli §4.1 «服务器自部署的运维命令»):
// the file read as the server's secret files are, its first line; the terminal asked twice; the
// keystrokes of the prompt.

import { EventEmitter } from "node:events";
import { chmodSync, mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, describe, expect, it } from "vitest";
import {
  MAX_ASKS,
  PasswordFileRefused,
  PasswordInterrupted,
  PasswordsDiffer,
  passwordFromFile,
  passwordFromTerminal,
  terminalOver,
  typeInto,
} from "./server-password.ts";

const AS_ROOT = process.getuid?.() === 0;
const root = mkdtempSync(join(tmpdir(), "saveslot-server-password-"));
afterAll(() => rmSync(root, { recursive: true, force: true }), 60_000);
let n = 0;

function file(text: string, mode = 0o600): string {
  const path = join(root, `p${n++}`);
  writeFileSync(path, text, { mode });
  chmodSync(path, mode);
  return path;
}

const refusal = async (path: string) => {
  try {
    await passwordFromFile(path);
  } catch (e) {
    if (e instanceof PasswordFileRefused) return e;
    throw e;
  }
  throw new Error("the file was taken");
};

describe("passwordFromFile", () => {
  it.each([0o600, 0o400, 0o640, 0o440])("mode %o: taken; the group may read it", async (mode) => {
    expect(await passwordFromFile(file("correct horse\n", mode))).toBe("correct horse");
  });

  it("its first line, the line end taken off (\\n or \\r\\n); spaces are the password's", async () => {
    expect(await passwordFromFile(file("one two \r\nsecond line\n"))).toBe("one two ");
    expect(await passwordFromFile(file("no line end"))).toBe("no line end");
    // A byte order mark an editor wrote is not the password's; one inside it is.
    expect(await passwordFromFile(file("\uFEFFwith a mark\n"))).toBe("with a mark");
    expect(await passwordFromFile(file("in\uFEFFside\n"))).toBe("in\uFEFFside");
  });

  it("followed through a link, as a mounted secret is", async () => {
    const link = join(root, `l${n++}`);
    symlinkSync(file("linked password"), link);
    expect(await passwordFromFile(link)).toBe("linked password");
  });

  it.each([0o601, 0o604, 0o644, 0o666])("mode %o: open to others, refused", async (mode) => {
    expect((await refusal(file("pw-open-to-others", mode))).code).toBe("open_to_others");
  });

  it("missing, a directory, a pipe-less empty first line: each its own code; no message holds the path or the content", async () => {
    const dir = join(root, `d${n++}`);
    mkdirSync(dir);
    const found = [
      await refusal(join(root, "not-there")),
      await refusal(dir),
      await refusal(file("\nsecond line holds it")),
      await refusal(file("")),
    ];
    expect(found.map((e) => e.code)).toEqual(["missing", "not_a_file", "empty", "empty"]);
    for (const e of found) {
      expect(e.message).not.toContain(root);
      expect(e.message).not.toContain("second line");
    }
  });

  it("behind a loop of links, a name too long, a path through a file: unreadable", async () => {
    const a = join(root, `la${n}`);
    const b = join(root, `lb${n++}`);
    symlinkSync(b, a);
    symlinkSync(a, b);
    for (const path of [a, join(root, "x".repeat(300)), join(file("pw-x"), "inside")]) {
      expect((await refusal(path)).code).toBe("unreadable");
    }
  });

  it.skipIf(AS_ROOT)("one this process may not read: unreadable", async () => {
    expect((await refusal(file("pw-unreadable", 0o000))).code).toBe("unreadable");
  });
});

describe("passwordFromTerminal", () => {
  const terminal = (entries: string[]) => {
    const asked: string[] = [];
    return {
      asked,
      readHidden: async (prompt: string) => {
        asked.push(prompt);
        const e = entries.shift();
        if (e === undefined) throw new Error("asked once too often");
        return e;
      },
      close: () => {},
    };
  };

  it("asked twice; the two the same: taken", async () => {
    const t = terminal(["correct horse", "correct horse"]);
    expect(await passwordFromTerminal(t)).toBe("correct horse");
    expect(t.asked).toHaveLength(2);
  });

  it("the two differ: asked again, MAX_ASKS times in all, then refused", async () => {
    const ok = terminal(["one password", "another one", "third try", "third try"]);
    expect(await passwordFromTerminal(ok)).toBe("third try");
    const never = terminal(Array.from({ length: 2 * MAX_ASKS }, (_, i) => `entry ${i}`));
    await expect(passwordFromTerminal(never)).rejects.toBeInstanceOf(PasswordsDiffer);
    expect(never.asked).toHaveLength(2 * MAX_ASKS);
  });
});

describe("the terminal's raw mode (terminalOver)", () => {
  /** A terminal's streams that record raw mode and what is written; typed into with `type`. */
  function tty() {
    const input = Object.assign(new EventEmitter(), {
      raw: [] as boolean[],
      setRawMode(on: boolean) {
        input.raw.push(on);
      },
      resume() {},
      pause() {},
      destroy() {},
    });
    const output = {
      written: [] as string[],
      write: (t: string) => output.written.push(t),
      destroy() {},
    };
    return { input, output, term: terminalOver(input, output) };
  }

  it("raw while the line is typed, so nothing is echoed; left again at Enter", async () => {
    const t = tty();
    const line = t.term.readHidden("New password: ");
    expect(t.input.raw).toEqual([true]);
    t.input.emit("data", Buffer.from("pw-typed-here\r"));
    expect(await line).toBe("pw-typed-here");
    expect(t.input.raw).toEqual([true, false]);
    // Only the prompt and the line end: never what was typed.
    expect(t.output.written).toEqual(["New password: ", "\n"]);
    expect([t.input.listenerCount("data"), t.input.listenerCount("error")]).toEqual([0, 0]);
  });

  it("Ctrl-C: interrupted, raw mode left again", async () => {
    const t = tty();
    const line = t.term.readHidden("New password: ");
    t.input.emit("data", Buffer.from("ab\u0003"));
    await expect(line).rejects.toBeInstanceOf(PasswordInterrupted);
    expect(t.input.raw).toEqual([true, false]);
    expect(t.output.written).toEqual(["New password: ", "\n"]);
  });

  it("an error of the stream: refused with it, raw mode left again", async () => {
    const t = tty();
    const line = t.term.readHidden("New password: ");
    t.input.emit("error", new Error("EIO"));
    await expect(line).rejects.toThrow("EIO");
    expect(t.input.raw).toEqual([true, false]);
    expect([t.input.listenerCount("data"), t.input.listenerCount("error")]).toEqual([0, 0]);
  });
});

// The same cases as packages/cli/src/export-crypto.test.ts has for its `typeInto`, of which this
// one is a copy: the two must not drift apart.
describe("typing a password (the keystrokes of the terminal prompt)", () => {
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

  it("other control keys are kept, for the password to be what was typed", () => {
    expect(typeInto("", "a\u001bb\t\r").line).toBe("a\u001bb\t");
  });
});
