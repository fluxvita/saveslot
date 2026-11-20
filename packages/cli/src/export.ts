// `saveslot export` (docs/zh-CN/spec/06-cli.md §4.8): the whole log as NDJSON, to stdout or `-o`,
// the manifest first, optionally in an age file under a passphrase. What is written is the
// service's stream, checked as it is read (the client fails the stream at its end if it is not
// whole); the summary goes to stderr, since stdout may be the data.

import { randomBytes } from "node:crypto";
import { lstat, open, rename, unlink } from "node:fs/promises";
import { basename, dirname, join } from "node:path";
import type { Client } from "@fluxvita/saveslot-client";
import {
  encryptStream,
  openControllingTerminal,
  PassphraseError,
  readPassphrase,
  type Terminal,
} from "./export-crypto.ts";
import { type Line, num, t, untrusted, words } from "./render/text.ts";
import { type Static, TEXTS } from "./texts.ts";
import { Failed, NotDone, UsageError } from "./usage.ts";

export interface ExportRequest {
  readonly out: string | undefined;
  readonly afterSeq: string | undefined;
  readonly includePendingDeletion: boolean;
  readonly encrypt: boolean;
  readonly passphraseFile: string | undefined;
  readonly yes: boolean;
  /** Replace a file that is there (`-o`). */
  readonly force: boolean;
}

export interface ExportIO {
  readonly stdinIsTTY?: boolean | undefined;
  readonly stdoutIsTTY?: boolean | undefined;
  /** The platform (tests: injected). */
  readonly platform?: NodeJS.Platform | undefined;
  readonly ask?: ((prompt: string) => Promise<string | undefined>) | undefined;
  /** Raw bytes to stdout (the NDJSON, or the age file). */
  readonly outBytes?: ((bytes: Uint8Array) => Promise<unknown>) | undefined;
  readonly err: (text: string) => void;
  /** The controlling terminal for the passphrase; undefined: none. Default: `/dev/tty`. */
  readonly terminal?: (() => Terminal | undefined) | undefined;
}

/** Runs the export; resolves with the lines for stderr. */
export async function exportCommand(
  a: ExportRequest,
  client: () => Promise<Client>,
  io: ExportIO,
): Promise<Line[]> {
  let afterSeq: number | undefined;
  if (a.afterSeq !== undefined) {
    if (!/^(0|[1-9][0-9]{0,15})$/.test(a.afterSeq)) throw new UsageError(TEXTS.exportAfterSeq);
    afterSeq = Number(a.afterSeq);
  }
  if (!a.encrypt && a.passphraseFile !== undefined) {
    throw new UsageError(TEXTS.exportPassphraseNeedsEncrypt);
  }
  // Windows has no controlling terminal device: only a file there.
  if (
    (io.platform ?? process.platform) === "win32" &&
    a.encrypt &&
    a.passphraseFile === undefined
  ) {
    throw new UsageError(TEXTS.exportWindowsFileOnly);
  }

  // A file that is there, refused before anything is asked or typed (the exclusive creation
  // below still guards against one made in between).
  if (a.out !== undefined && !a.force) {
    const there = await lstat(a.out).then(
      () => true,
      (e: NodeJS.ErrnoException) => e.code !== "ENOENT",
    );
    if (there) throw new UsageError(TEXTS.exportFileExists);
  }

  // An age file is binary: not to a terminal.
  if (a.encrypt && a.out === undefined && io.stdoutIsTTY === true) {
    throw new UsageError(TEXTS.exportEncryptedToTerminal);
  }

  // The content in its grace period is only exported when asked for twice over: the option, and
  // here, a yes (06 §4.8).
  if (a.includePendingDeletion && !a.yes) {
    if (io.stdinIsTTY !== true || io.ask === undefined)
      throw new NotDone(TEXTS.exportPendingNoTerminal);
    const answer = await io.ask(`${TEXTS.exportPendingAsk} [y/N] `);
    if (!/^(y|yes)$/i.test((answer ?? "").trim())) throw new NotDone(TEXTS.declined);
  }

  // The passphrase before anything is asked of the service or written: a refused one leaves no
  // half-made file.
  let passphrase: string | undefined;
  const warnings: string[] = [];
  if (a.encrypt) {
    const terminal =
      a.passphraseFile === undefined ? (io.terminal ?? openControllingTerminal)() : undefined;
    try {
      if (terminal !== undefined) terminal.write(`${TEXTS.exportPassphraseNotKept}\n`);
      const p = await readPassphrase({ file: a.passphraseFile }, terminal);
      passphrase = p.value;
      if (p.warnings.includes("short")) warnings.push(TEXTS.exportPassphraseShort);
    } catch (e) {
      if (!(e instanceof PassphraseError)) throw e;
      if (e.code === "no_terminal") throw new NotDone(TEXTS.exportNoPassphraseSource);
      if (e.code === "interrupted") throw new NotDone(TEXTS.exportPassphraseInterrupted);
      if (e.code === "mismatch") throw new NotDone(TEXTS.exportPassphraseMismatch);
      // A passphrase file or descriptor that cannot be used: a usage error (2), saying why and
      // what to do; 6 is for credentials (06 §6.2).
      const why: Record<string, Static> = {
        file_not_regular: TEXTS.passphraseFileNotRegular,
        file_not_owned: TEXTS.passphraseFileNotOwned,
        file_open_to_others: TEXTS.passphraseFileOpen,
        file_unreadable: TEXTS.passphraseFileUnreadable,
        pipe_timeout: TEXTS.passphrasePipeTimeout,
        empty: TEXTS.passphraseEmpty,
        line_malformed: TEXTS.passphraseMalformed,
        control_character: TEXTS.passphraseControl,
      };
      throw new UsageError(why[e.code] ?? TEXTS.passphraseFileUnreadable);
    } finally {
      terminal?.close?.();
    }
  }
  for (const w of warnings) io.err(`${w}\n`);

  const c = await client();
  const stream = await c.export({
    ...(afterSeq !== undefined ? { after_seq: afterSeq } : {}),
    ...(a.includePendingDeletion ? { include_pending_deletion: true } : {}),
  });
  const source =
    passphrase === undefined ? stream.body : await encryptStream(stream.body, passphrase);

  if (a.out !== undefined) {
    await writeFile(a.out, a.force, source);
  } else {
    if (io.outBytes === undefined) throw new Error("no raw stdout");
    for await (const chunk of source) {
      if ((await io.outBytes(chunk)) === false) throw new Failed(TEXTS.outputLost, 1);
    }
  }

  const m = stream.manifest;
  const first = t`${words(TEXTS.exported)} ${num(m.events)} ${words(TEXTS.exportedEvents)} ${num(m.upto)}, ${words(
    m.pending_deletions === "included" ? TEXTS.exportedWithPending : TEXTS.exportedNoPending,
  )}`;
  const summary: Line[] = [
    passphrase === undefined ? first : [...first, ...t`, ${words(TEXTS.exportedEncrypted)}`],
  ];
  if (passphrase !== undefined) {
    summary.push(t`${words(TEXTS.exportContinueWith)} ${num(m.upto)}`);
    summary.push(t`${words(TEXTS.exportDecryptWith)} ${untrusted(a.out ?? "<file>")}`);
  }
  return summary;
}

/**
 * The export into `path`, made when the first bytes are there (a refused or failed request leaves
 * no file). Without `force`: exclusive creation, owner-only, written in place; a failure leaves
 * the file it made, partial, and says so. With `force`: written to a new owner-only file beside
 * it and renamed over `path` once the whole stream is in, so a failure leaves the file that was
 * there as it was; a symbolic link at `path` is itself replaced, its target untouched.
 */
async function writeFile(path: string, force: boolean, source: ReadableStream<Uint8Array>) {
  const target = force
    ? join(dirname(path), `.${basename(path)}.${randomBytes(6).toString("hex")}.part`)
    : path;
  let handle: Awaited<ReturnType<typeof open>> | undefined;
  let made = false;
  try {
    for await (const chunk of source) {
      if (handle === undefined) {
        handle = await open(target, "wx", 0o600).catch((e: NodeJS.ErrnoException) => {
          if (e.code === "EEXIST") throw new UsageError(TEXTS.exportFileExists);
          throw new Failed(TEXTS.exportOutputUnwritable, 1);
        });
        made = true;
        await handle.chmod(0o600);
      }
      await handle.write(chunk);
    }
    // On disk before it is called done, and before a rename puts it in place of a backup: a
    // crash after the rename must not leave an empty or short file where the old one was.
    await handle?.sync();
    await handle?.close();
    handle = undefined;
    if (force && made) await rename(target, path);
  } catch (e) {
    await handle?.close().catch(() => {});
    if (force) {
      if (made) await unlink(target).catch(() => {});
      if (e instanceof UsageError) throw e;
      // The stream's failure (cut off) keeps its own error; the note says the original is whole.
      throw new Failed(
        (e as Error).name === "TransportError"
          ? TEXTS.exportBrokenOriginalKept
          : TEXTS.exportUnwritableOriginalKept,
        (e as Error).name === "TransportError" ? 7 : 1,
      );
    }
    if (e instanceof UsageError || e instanceof Failed) throw e;
    if ((e as Error).name === "TransportError") throw e;
    // A write that failed half way (disk full): what is left is partial.
    throw new Failed(made ? TEXTS.exportUnwritablePartial : TEXTS.exportOutputUnwritable, 1);
  }
}
