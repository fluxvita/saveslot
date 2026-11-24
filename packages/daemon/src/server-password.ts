// A local account's new password, for `saveslot server init --user`, `server user add` and
// `server user passwd` (docs/zh-CN/spec/06-cli.md §4.1 «服务器自部署的运维命令»): from the
// controlling terminal, typed twice with no echo, or from a password file (`--password-file`); never
// from an argument, which would go into the shell's history and the process list.
//
// The file is checked as the server's other secret files are (service's secret-file.ts): followed
// through links, a regular file this process can read, nothing for others; its owner is not checked
// and the group may read it. A pipe is not a regular file and is refused. Its first line is the
// password, its line end and a byte order mark at its start taken off. A file refused is the
// command's input refused before anything is done (exit 2); the password's own rules (its length)
// are the local accounts' (exit 5).

import { constants, openSync } from "node:fs";
import { ReadStream, WriteStream } from "node:tty";
import { readSecretFile, SecretFileError } from "@fluxvita/saveslot-service";

/** The terminal a password is typed on. */
export interface PasswordTerminal {
  /** Writes `prompt`, then reads one line with no echo; the line without its end. */
  readHidden(prompt: string): Promise<string>;
  close(): void;
}

/** Why a password file was refused; the message names neither the path nor the content. */
export class PasswordFileRefused extends Error {
  override readonly name = "PasswordFileRefused";
  readonly code: SecretFileError["code"] | "empty";
  constructor(code: PasswordFileRefused["code"]) {
    super(`the password file is refused: ${code}`);
    this.code = code;
  }
}

/** The two entries on the terminal differed, every time it asked. */
export class PasswordsDiffer extends Error {
  override readonly name = "PasswordsDiffer";
}

/** Ctrl-C (or Ctrl-D on an empty line) at the prompt. */
export class PasswordInterrupted extends Error {
  override readonly name = "PasswordInterrupted";
}

/** How many times the terminal asks before two entries that differ end the command. */
export const MAX_ASKS = 3;

/** The password in the file at `path`: its first line. */
export async function passwordFromFile(path: string): Promise<string> {
  let text: string;
  try {
    text = await readSecretFile(path);
  } catch (e) {
    if (e instanceof SecretFileError) throw new PasswordFileRefused(e.code);
    throw e;
  }
  // A byte order mark an editor wrote at the start is not the password's.
  const line = (text.replace(/^\uFEFF/, "").split("\n")[0] ?? "").replace(/\r$/, "");
  if (line === "") throw new PasswordFileRefused("empty");
  return line;
}

/** Asks for the password twice, and again when the two differ: `MAX_ASKS` times in all. */
export async function passwordFromTerminal(term: PasswordTerminal): Promise<string> {
  for (let i = 0; i < MAX_ASKS; i++) {
    const first = await term.readHidden("New password: ");
    const again = await term.readHidden("The same password again: ");
    if (first === again) return first;
  }
  throw new PasswordsDiffer("the two entries differed");
}

/**
 * Applies keystrokes to the line typed so far: Enter ends it, Backspace takes off the last
 * character, Ctrl-C (or Ctrl-D on an empty line) interrupts. Everything else, control keys
 * included, is kept. Pure, so it is tested without a terminal.
 *
 * A copy of `typeInto` in packages/cli/src/export-crypto.ts, which reads an export's passphrase the
 * same way: this package may not depend on the command line's (02-architecture §11). The tests of
 * both have the same cases, so that the two do not drift apart unseen.
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
    // Any other control character is kept: dropping it would make the password differ from the
    // same one given in a file.
    else cur += ch;
  }
  return { line: cur, done: false, interrupted: false };
}

/** What a password is read from: a terminal's input stream (node:tty's `ReadStream`). */
export interface RawInput {
  setRawMode(raw: boolean): unknown;
  on(event: "data", listener: (chunk: Buffer) => void): unknown;
  on(event: "error", listener: (e: Error) => void): unknown;
  off(event: "data", listener: (chunk: Buffer) => void): unknown;
  off(event: "error", listener: (e: Error) => void): unknown;
  resume(): unknown;
  pause(): unknown;
  destroy(): unknown;
}

/** What the prompts are written to: a terminal's output stream. */
export interface PromptOutput {
  write(text: string): unknown;
  destroy(): unknown;
}

/**
 * A terminal over `input` and `output`: each line read in raw mode, so nothing typed is echoed, and
 * raw mode left again however the line ends (Enter, Ctrl-C, an error of the stream).
 */
export function terminalOver(input: RawInput, output: PromptOutput): PasswordTerminal {
  return {
    readHidden: (prompt) =>
      new Promise<string>((resolve, reject) => {
        output.write(prompt);
        let line = "";
        input.setRawMode(true);
        const finish = (): void => {
          input.off("data", onData);
          input.off("error", onError);
          input.setRawMode(false);
          input.pause();
          output.write("\n");
        };
        const onData = (chunk: Buffer): void => {
          const r = typeInto(line, chunk.toString("utf8"));
          line = r.line;
          if (r.interrupted) {
            finish();
            reject(new PasswordInterrupted("interrupted at the password prompt"));
          } else if (r.done) {
            finish();
            resolve(line);
          }
        };
        const onError = (e: Error): void => {
          finish();
          reject(e);
        };
        input.on("data", onData);
        input.on("error", onError);
        input.resume();
      }),
    close() {
      input.destroy();
      output.destroy();
    },
  };
}

/**
 * The controlling terminal (`/dev/tty`), not standard input (`terminalOver`). Undefined where there
 * is none (a service, CI, a detached session).
 */
export function openControllingTerminal(): PasswordTerminal | undefined {
  let fdIn: number;
  let fdOut: number;
  try {
    fdIn = openSync("/dev/tty", constants.O_RDONLY | constants.O_NOCTTY);
    fdOut = openSync("/dev/tty", constants.O_WRONLY | constants.O_NOCTTY);
  } catch {
    return undefined;
  }
  return terminalOver(new ReadStream(fdIn), new WriteStream(fdOut));
}
