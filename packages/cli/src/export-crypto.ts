// The passphrase encryption of an export file (docs/zh-CN/spec/06-cli.md §4.8 «导出的口令加密»):
// the whole export stream, manifest line included, in an age v1 file with a passphrase (scrypt)
// recipient. The format is age's own, so any age implementation opens it; there is no container
// of ours. Where the passphrase comes from, and what it must look like, is decided here; the
// command that uses it decides what to say and which exit code to give.
//
// The passphrase never appears in an argument or an environment variable; it is read from the
// controlling terminal or the first line of a file given by its path (a pipe from a password
// manager comes as a path too: the shell's process substitution, `<(pass show saveslot)`). There
// is no option taking a descriptor number: Node gives no way to tell a descriptor the user's
// shell opened from one of its own runtime's, and a wrong guess reads a wrong passphrase.

import { constants, openSync, type Stats } from "node:fs";
import { open } from "node:fs/promises";
import { setTimeout as sleep } from "node:timers/promises";
import { ReadStream, WriteStream } from "node:tty";
import * as age from "age-encryption";

/** Shorter than this the passphrase is warned about once, not refused. */
export const MIN_PASSPHRASE_CHARS = 12;

/** The longest first line read from a passphrase file (bytes). */
const MAX_LINE_BYTES = 4096;

export type PassphraseErrorCode =
  /** The passphrase is empty. */
  | "empty"
  /** Not a regular file, a pipe or a character device (a directory, a socket, a block device). */
  | "file_not_regular"
  /** The file is not the current user's. */
  | "file_not_owned"
  /** The file's mode lets group or others in (wider than 0600). */
  | "file_open_to_others"
  | "file_unreadable"
  /** The first line is longer than a passphrase can be here, or not text. */
  | "line_malformed"
  /** A pipe whose writer wrote no line within the wait. */
  | "pipe_timeout"
  /** No terminal to ask on and no file given. */
  | "no_terminal"
  /** Interrupted at the prompt (Ctrl-C, or Ctrl-D on an empty line). */
  | "interrupted"
  /** A control character or a byte order mark in the passphrase. */
  | "control_character"
  /** The two entries on the terminal differed too often. */
  | "mismatch";

export class PassphraseError extends Error {
  readonly code: PassphraseErrorCode;
  constructor(code: PassphraseErrorCode, message: string) {
    super(message);
    this.name = "PassphraseError";
    this.code = code;
  }
}

/** Where the passphrase comes from: a file, or the terminal when none is given. */
export interface PassphraseSource {
  readonly file?: string | undefined;
}

/** The terminal side of asking: injected so tests need none. */
export interface Terminal {
  /** Writes to the terminal. */
  write(text: string): void;
  /** Reads one line with no echo; the line without its end. */
  readHidden(prompt: string): Promise<string>;
  /** Gives the terminal back (raw mode off, descriptors closed). */
  close?(): void;
}

export interface Passphrase {
  readonly value: string;
  /** Warnings to show, once each (shorter than `MIN_PASSPHRASE_CHARS`). */
  readonly warnings: readonly "short"[];
}

/** The first line of `text` without its line end (`\n` or `\r\n`). */
function firstLine(bytes: Buffer): string {
  const nl = bytes.indexOf(0x0a);
  let end = nl === -1 ? bytes.length : nl;
  if (end > 0 && bytes[end - 1] === 0x0d) end -= 1;
  const text = new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
    bytes.subarray(0, end),
  );
  return text;
}

/**
 * A passphrase as given, or why not. Its bytes are used as they are, with no normalization (as
 * age does), so the same passphrase must come out of every source the same: a control character
 * (Tab included) or a byte order mark is refused, not dropped.
 */
function accept(value: string): Passphrase {
  if (value === "") throw new PassphraseError("empty", "the passphrase is empty");
  if (value.startsWith("\uFEFF")) {
    throw new PassphraseError("control_character", "the passphrase starts with a byte order mark");
  }
  if ([...value].some((c) => (c.codePointAt(0) as number) < 0x20 || c === "\u007f")) {
    throw new PassphraseError("control_character", "the passphrase holds a control character");
  }
  return {
    value,
    warnings: [...value].length < MIN_PASSPHRASE_CHARS ? ["short"] : [],
  };
}

/** How long a pipe's writer is waited on for its line. */
export const PIPE_WAIT_MS = 30_000;

const uid = () => (typeof process.getuid === "function" ? process.getuid() : undefined);

/**
 * What was opened, checked as an object (not as a path: on Linux the path of a process
 * substitution, `/dev/fd/63`, is itself a link). A regular file follows the credential files'
 * rule: the user's own, nothing for group or others. A pipe must be the user's own; its mode bits
 * differ between systems and are not looked at. A character device (`/dev/stdin` on a terminal)
 * is taken as it is. Anything else is refused.
 */
function checkOpened(path: string, s: Stats): void {
  if (s.isCharacterDevice()) return;
  if (!s.isFile() && !s.isFIFO()) {
    throw new PassphraseError(
      "file_not_regular",
      `${path} is not a file or a pipe (a directory, a socket or a device)`,
    );
  }
  const me = uid();
  if (me !== undefined && s.uid !== me) {
    throw new PassphraseError("file_not_owned", `${path} is not owned by the current user`);
  }
  // The same rule as the credential files: nothing for group or others.
  if (s.isFile() && (s.mode & 0o077) !== 0) {
    throw new PassphraseError(
      "file_open_to_others",
      `${path} has mode ${(s.mode & 0o777).toString(8)}, open to others; run chmod 600 ${path}`,
    );
  }
}

/**
 * The first line of the file at `path`, opened as the path says (links followed: what the user
 * named is what is read) and checked once open (`checkOpened`). A pipe is read until its first
 * line end or its end, and a writer that writes no line within `waitMs` is not waited on longer.
 * Opened here, closed here.
 */
export async function passphraseFromFile(path: string, waitMs = PIPE_WAIT_MS): Promise<Passphrase> {
  let handle: Awaited<ReturnType<typeof open>>;
  try {
    // Non-blocking: opening a pipe with no writer yet does not wait.
    handle = await open(path, constants.O_RDONLY | constants.O_NONBLOCK);
  } catch (e) {
    const code = (e as NodeJS.ErrnoException).code;
    throw new PassphraseError("file_unreadable", `${path} cannot be read (${code ?? "error"})`);
  }
  try {
    const st = await handle.stat();
    checkOpened(path, st);
    const chunks: Buffer[] = [];
    let size = 0;
    const deadline = Date.now() + waitMs;
    for (;;) {
      const b = Buffer.alloc(1024);
      let n: number;
      try {
        ({ bytesRead: n } = await handle.read(b, 0, b.length, st.isFile() ? size : null));
      } catch (e) {
        const code = (e as NodeJS.ErrnoException).code;
        if (code !== "EAGAIN") {
          throw new PassphraseError(
            "file_unreadable",
            `${path} cannot be read (${code ?? "error"})`,
          );
        }
        if (Date.now() > deadline) {
          throw new PassphraseError(
            "pipe_timeout",
            `nothing came on ${path} within ${Math.round(waitMs / 1000)} s`,
          );
        }
        await sleep(20);
        continue;
      }
      if (n === 0) {
        // A named pipe whose writer has not opened it yet reads as ended: wait for it, within
        // the same time limit. (A process substitution's pipe has its writer from the start.)
        if (st.isFIFO() && size === 0) {
          if (Date.now() > deadline) {
            throw new PassphraseError(
              "pipe_timeout",
              `nothing came on ${path} within ${Math.round(waitMs / 1000)} s`,
            );
          }
          await sleep(20);
          continue;
        }
        break;
      }
      chunks.push(b.subarray(0, n));
      size += n;
      // The first line is all that is wanted: stop at its end, or past the cap.
      if (b.subarray(0, n).includes(0x0a) || size > MAX_LINE_BYTES) break;
    }
    return lineOf(Buffer.concat(chunks));
  } finally {
    await handle.close();
  }
}

function lineOf(bytes: Buffer): Passphrase {
  if (bytes.length > MAX_LINE_BYTES && bytes.indexOf(0x0a) === -1) {
    throw new PassphraseError("line_malformed", "the passphrase line is too long");
  }
  let line: string;
  try {
    line = firstLine(bytes);
  } catch {
    throw new PassphraseError("line_malformed", "the passphrase is not UTF-8 text");
  }
  return accept(line);
}

/** How many times a mismatching pair is asked again before giving up. */
export const MAX_ASKS = 3;

/**
 * Asks on the terminal, twice, with no echo; asks again when the two differ, or when the
 * passphrase cannot be taken (empty, a control character): MAX_ASKS times in all.
 */
export async function passphraseFromTerminal(term: Terminal): Promise<Passphrase> {
  for (let i = 0; i < MAX_ASKS; i++) {
    const a = await term.readHidden("Passphrase: ");
    const b = await term.readHidden("Again: ");
    if (a !== b) {
      term.write("The two entries differ; try again.\n");
      continue;
    }
    try {
      return accept(a);
    } catch (e) {
      if (!(e instanceof PassphraseError)) throw e;
      term.write(`${e.message}; try again.\n`);
    }
  }
  throw new PassphraseError("mismatch", "no passphrase could be taken in three tries");
}

/**
 * The passphrase for an export or an import: from the one source given; with none, the terminal,
 * if there is one (`terminal` undefined means there is none).
 */
export async function readPassphrase(
  source: PassphraseSource,
  terminal: Terminal | undefined,
): Promise<Passphrase> {
  if (source.file !== undefined) return passphraseFromFile(source.file);
  if (terminal === undefined) {
    throw new PassphraseError("no_terminal", "no terminal to ask the passphrase on");
  }
  return passphraseFromTerminal(terminal);
}

/** Encrypts the stream with the passphrase: one age v1 file, scrypt recipient. */
export async function encryptStream(
  plain: ReadableStream<Uint8Array>,
  passphrase: string,
): Promise<ReadableStream<Uint8Array>> {
  const e = new age.Encrypter();
  e.setPassphrase(passphrase);
  return e.encrypt(plain);
}

/**
 * Decrypts an age file made with `encryptStream`; a wrong passphrase or a damaged file throws.
 * A file cut short is found only at its end: the chunks before were authenticated and are given
 * out already (age's own behaviour). Whoever reads it (an import) must not act on the content
 * before the stream has ended without an error.
 */
export async function decryptStream(
  cipher: ReadableStream<Uint8Array>,
  passphrase: string,
): Promise<ReadableStream<Uint8Array>> {
  const d = new age.Decrypter();
  d.addPassphrase(passphrase);
  return d.decrypt(cipher);
}

/**
 * Applies keystrokes to the line typed so far: Enter ends it, Backspace takes off the last
 * character, Ctrl-C (or Ctrl-D on an empty line) interrupts. Everything else, control keys
 * included, is kept, for the passphrase to be refused. Pure, so it is tested without a terminal.
 */
export function typeInto(
  line: string,
  keys: string,
): { readonly line: string; readonly done: boolean; readonly interrupted: boolean } {
  let cur = line;
  for (const ch of keys) {
    if (ch === "\r" || ch === "\n") return { line: cur, done: true, interrupted: false };
    if (ch === "\u0003" || (ch === "\u0004" && cur === "")) {
      return { line: cur, done: false, interrupted: true };
    }
    if (ch === "\u007f" || ch === "\b") cur = [...cur].slice(0, -1).join("");
    // Any other control character is kept, to be refused with the rest (`accept`): dropping it
    // would make the passphrase differ from the same one given in a file.
    else cur += ch;
  }
  return { line: cur, done: false, interrupted: false };
}

/**
 * The controlling terminal (`/dev/tty`), not standard input: `saveslot export --encrypt > file`
 * still asks. Undefined where there is none (a service, CI, a detached session).
 */
export function openControllingTerminal(): Terminal | undefined {
  let fdIn: number;
  let fdOut: number;
  try {
    fdIn = openSync("/dev/tty", constants.O_RDONLY | constants.O_NOCTTY);
    fdOut = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    return undefined;
  }
  const input = new ReadStream(fdIn);
  const output = new WriteStream(fdOut);
  return {
    write: (text) => void output.write(text),
    readHidden: (prompt) =>
      new Promise<string>((resolve, reject) => {
        output.write(prompt);
        let line = "";
        input.setRawMode(true);
        const finish = (): void => {
          input.off("data", onData);
          input.setRawMode(false);
          input.pause();
          output.write("\n");
        };
        const onData = (chunk: Buffer): void => {
          const r = typeInto(line, chunk.toString("utf8"));
          line = r.line;
          if (r.interrupted) {
            finish();
            reject(new PassphraseError("interrupted", "interrupted at the passphrase prompt"));
          } else if (r.done) {
            finish();
            resolve(line);
          }
        };
        input.on("data", onData);
        input.resume();
      }),
    close() {
      input.destroy();
      output.destroy();
    },
  };
}
