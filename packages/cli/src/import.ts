// `saveslot import <file>…` (docs/zh-CN/spec/06-cli.md §4.8): an export loaded into the empty
// tenant. Each file's manifest is read first and the files checked against each other here, before
// anything is sent; what is about to happen is shown and confirmed; then the files' plain bytes go
// up as one body, in the order given. An age file is opened here (the service takes no age file
// and no passphrase, 05-surfaces §15): one passphrase is tried on every encrypted file, and asked
// again for a file it does not open when there is a terminal. A file found cut short only at its
// end stops the upload before its end is sent, so the service never takes it whole.

import { createReadStream } from "node:fs";
import { open } from "node:fs/promises";
import { Readable } from "node:stream";
import type { Client, ExportHeader, ImportResult } from "@fluxvita/saveslot-client";
import {
  decryptStream,
  openControllingTerminal,
  PassphraseError,
  readPassphrase,
  type Terminal,
} from "./export-crypto.ts";
import { type Line, num, t, time, untrusted, words } from "./render/text.ts";
import { type Static, TEXTS } from "./texts.ts";
import { Failed, NotDone, UsageError } from "./usage.ts";

export interface ImportRequest {
  readonly files: readonly string[];
  readonly passphraseFile: string | undefined;
  readonly yes: boolean;
}

export interface ImportIO {
  readonly stdinIsTTY?: boolean | undefined;
  readonly stderrIsTTY?: boolean | undefined;
  readonly platform?: NodeJS.Platform | undefined;
  readonly ask?: ((prompt: string) => Promise<string | undefined>) | undefined;
  readonly err: (text: string) => void;
  /** Writes saveslot's lines on stderr (what is about to happen). */
  readonly sayErr: (lines: Line[]) => void;
  /** The controlling terminal for the passphrase; undefined: none. Default: `/dev/tty`. */
  readonly terminal?: (() => Terminal | undefined) | undefined;
}

/** What an age file begins with (age v1). */
const AGE = Buffer.from("age-encryption.org/v1\n", "utf8");
/** At most this much of a file is read for its manifest line. */
const MAX_MANIFEST = 1 << 20;

/** A file's bytes as a web stream. */
const bytesOf = (path: string) =>
  Readable.toWeb(createReadStream(path)) as unknown as ReadableStream<Uint8Array>;

/** Whether the file begins as an age file does; a file that cannot be read: a usage error. */
async function isAge(path: string, n: number): Promise<boolean> {
  let h: Awaited<ReturnType<typeof open>>;
  try {
    h = await open(path, "r");
  } catch {
    throw new UsageError(TEXTS.importFileUnreadable(n));
  }
  try {
    const buf = Buffer.alloc(AGE.length);
    const { bytesRead } = await h.read(buf, 0, buf.length, 0);
    return bytesRead === AGE.length && buf.equals(AGE);
  } finally {
    await h.close();
  }
}

/** The plain bytes of a file: decrypted when it is an age file. */
async function plainOf(
  path: string,
  passphrase: string | undefined,
): Promise<ReadableStream<Uint8Array>> {
  const raw = bytesOf(path);
  return passphrase === undefined ? raw : decryptStream(raw, passphrase);
}

/**
 * The first line of the plain bytes, as the export's manifest; the stream is then let go of (what
 * is shown need not wait for an age file's end; what is sent does). Undefined when the passphrase
 * does not open the file.
 */
async function manifestOf(
  path: string,
  n: number,
  passphrase: string | undefined,
): Promise<ExportHeader | undefined> {
  let plain: ReadableStream<Uint8Array>;
  let first = Buffer.alloc(0);
  const reader = await (async () => {
    try {
      plain = await plainOf(path, passphrase);
      return plain.getReader();
    } catch {
      return undefined;
    }
  })();
  if (reader === undefined) return undefined;
  try {
    for (;;) {
      const nl = first.indexOf(0x0a);
      if (nl >= 0) {
        first = first.subarray(0, nl);
        break;
      }
      let r: Awaited<ReturnType<typeof reader.read>>;
      try {
        r = await reader.read();
      } catch {
        // An age header the passphrase does not open fails on the first read.
        if (passphrase !== undefined) return undefined;
        throw new UsageError(TEXTS.importFileUnreadable(n));
      }
      if (r.done) break;
      first = Buffer.concat([first, r.value]);
      if (first.length > MAX_MANIFEST) throw new UsageError(TEXTS.importNotAnExport(n));
    }
  } finally {
    await reader.cancel().catch(() => {});
  }
  let m: unknown;
  try {
    m = JSON.parse(first.toString("utf8"));
  } catch {
    throw new UsageError(TEXTS.importNotAnExport(n));
  }
  const x = m as Record<string, unknown>;
  const whole = (k: string) => Number.isSafeInteger(x[k]) && (x[k] as number) >= 0;
  if (
    m === null ||
    typeof m !== "object" ||
    Array.isArray(m) ||
    x["saveslot_export"] !== 1 ||
    typeof x["tenant_id"] !== "string" ||
    !whole("event_format") ||
    !whole("restore_count") ||
    !whole("upto") ||
    !whole("events") ||
    (x["after"] !== undefined && !whole("after")) ||
    typeof x["exported_at"] !== "string" ||
    (x["pending_deletions"] !== "placeholder" && x["pending_deletions"] !== "included")
  ) {
    throw new UsageError(TEXTS.importNotAnExport(n));
  }
  return m as ExportHeader;
}

/**
 * The files' manifests checked against each other, by the manifests' own fields only, as the service
 * checks them again (`import_rejected`: `not_from_start`, `segment_order`): one tenant, one event
 * format and restore count; the first from the start, each next one going on where the one before
 * ended. What does not fit: a usage error naming the file, nothing sent.
 */
function checkSegments(ms: readonly ExportHeader[]): void {
  const [first] = ms as [ExportHeader];
  if (first.after !== undefined && first.after !== 0) {
    throw new UsageError(TEXTS.importNotFromStart);
  }
  for (let k = 1; k < ms.length; k++) {
    const m = ms[k] as ExportHeader;
    const before = ms[k - 1] as ExportHeader;
    const file = k + 1;
    if (m.tenant_id !== first.tenant_id) throw new UsageError(TEXTS.importOtherTenant(file));
    if (m.event_format !== first.event_format || m.restore_count !== first.restore_count) {
      throw new UsageError(TEXTS.importOtherExport(file));
    }
    if ((m.after ?? 0) !== before.upto) throw new UsageError(TEXTS.importSegmentOrder(file));
  }
}

/** Runs the import: the result, as JSON and as lines. */
export async function importCommand(
  a: ImportRequest,
  client: () => Promise<Client>,
  io: ImportIO,
): Promise<{ readonly json: ImportResult; readonly lines: Line[] }> {
  if (a.files.length === 0) throw new UsageError(TEXTS.importArgs);
  const encrypted: boolean[] = [];
  for (const [k, f] of a.files.entries()) encrypted.push(await isAge(f, k + 1));
  if (!encrypted.some((e) => e) && a.passphraseFile !== undefined) {
    throw new UsageError(TEXTS.importPassphraseNotNeeded);
  }

  // One passphrase for every encrypted file; asked again, with a terminal, for one it does not open.
  let terminal: Terminal | undefined;
  const passphrases: (string | undefined)[] = [];
  const manifests: ExportHeader[] = [];
  try {
    let passphrase: string | undefined;
    for (let k = 0; k < a.files.length; k++) {
      const file = a.files[k] as string;
      if (!encrypted[k]) {
        passphrases.push(undefined);
        manifests.push((await manifestOf(file, k + 1, undefined)) as ExportHeader);
        continue;
      }
      if (passphrase === undefined) {
        if (a.passphraseFile === undefined) {
          if ((io.platform ?? process.platform) === "win32") {
            throw new UsageError(TEXTS.exportWindowsFileOnly);
          }
          terminal = (io.terminal ?? openControllingTerminal)();
        }
        passphrase = await passphraseOf(a.passphraseFile, terminal);
      }
      let m = await manifestOf(file, k + 1, passphrase);
      if (m === undefined && terminal !== undefined) {
        // Another passphrase for this file (continuations may each have their own).
        passphrase = await terminal.readHidden(`${TEXTS.importAnotherPassphrase(k + 1)} `);
        m = await manifestOf(file, k + 1, passphrase);
      }
      if (m === undefined) throw new Failed(TEXTS.importPassphraseWrong(k + 1), 1);
      passphrases.push(passphrase);
      manifests.push(m);
    }
  } finally {
    terminal?.close?.();
  }
  checkSegments(manifests);

  // What is about to happen, then one answer (06 §4.8; without a terminal, --yes).
  const first = manifests[0] as ExportHeader;
  const last = manifests[manifests.length - 1] as ExportHeader;
  const events = manifests.reduce((n, m) => n + m.events, 0);
  const pending = manifests.some((m) => m.pending_deletions === "included");
  io.sayErr([
    t`${words(TEXTS.importFrom)} ${untrusted(first.tenant_id)}`,
    t`${num(events)} ${words(TEXTS.importEvents)} (${num(a.files.length)} ${words(TEXTS.importFiles)})`,
    t`${words(TEXTS.importExportedAt)} ${untrusted(last.exported_at)}`,
    [words(pending ? TEXTS.importWithPending : TEXTS.importNoPending)],
    [words(TEXTS.importLaterDeletions)],
  ]);
  if (!a.yes) {
    if (io.stdinIsTTY !== true || io.stderrIsTTY !== true || io.ask === undefined) {
      throw new NotDone(TEXTS.importNoTerminal);
    }
    const answer = await io.ask(`${TEXTS.importAsk} [y/N] `);
    if (!/^(y|yes)$/i.test((answer ?? "").trim())) throw new NotDone(TEXTS.declined);
  }

  // The files' plain bytes, one after another; an age file found cut short fails the upload.
  async function* body(): AsyncGenerator<Uint8Array> {
    for (let k = 0; k < a.files.length; k++) {
      const plain = await plainOf(a.files[k] as string, passphrases[k]);
      for await (const chunk of plain as unknown as AsyncIterable<Uint8Array>) yield chunk;
    }
  }
  const r = await (await client()).import(body());
  return { json: r, lines: resultLines(r) };
}

/** The passphrase from the file given, or the terminal; refusals as `export` says them. */
async function passphraseOf(file: string | undefined, terminal: Terminal | undefined) {
  try {
    if (file === undefined && terminal !== undefined) {
      // As typed: spaces at its ends are part of it, as from a file (06 §4.8).
      return await terminal.readHidden(`${TEXTS.importPassphrase} `);
    }
    return (await readPassphrase({ file }, terminal)).value;
  } catch (e) {
    if (!(e instanceof PassphraseError)) throw e;
    if (e.code === "no_terminal") throw new NotDone(TEXTS.importNoPassphraseSource);
    if (e.code === "interrupted") throw new NotDone(TEXTS.exportPassphraseInterrupted);
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
  }
}

/** The result (06 §4.8): what was done, what did not come over, and what to do next. */
function resultLines(r: ImportResult): Line[] {
  const out: Line[] = [
    t`${words(TEXTS.imported)} ${num(r.events)} ${words(TEXTS.importEvents)} · ${words(TEXTS.importFrom)} ${untrusted(r.previous_tenant_id)} · ${words(TEXTS.importExportedAt)} ${time(r.exported_at)}`,
    t`${words(TEXTS.importDisabled)} ${num(r.principals_disabled)}`,
    t`${words(TEXTS.importTombstones)} ${num(r.pending_deletions.executed)} · ${words(TEXTS.importCarried)} ${num(r.pending_deletions.carried)}`,
  ];
  if (r.not_imported.length > 0) {
    out.push([
      ...t`${words(TEXTS.importNotImported)} `,
      ...r.not_imported.flatMap((x, k) =>
        k === 0
          ? [words(TEXTS.importNotImportedKind(x))]
          : t`, ${words(TEXTS.importNotImportedKind(x))}`,
      ),
    ]);
  }
  out.push([words(TEXTS.importReissue)]);
  return out;
}
