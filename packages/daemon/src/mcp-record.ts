// The MCP call record (docs/zh-CN/spec/02-architecture.md §11 «评测对实现的要求»; 06-cli §4.1):
// `saveslot mcp --record <file>`, for evaluations only. The bridge writes every message it reads
// from the host and every message it writes back, in order, so that the run's whole tool call
// sequence (the arguments sent and the text given back) is kept even when the host does not
// export it. The contract result of each call is the service's evaluation results' (service.ts).
//
// - The file is new: made with O_EXCL at 0600; one that exists is refused, never appended to.
//   Given a directory, each bridge makes its own file there, named by when it started and its
//   process (`record-20261110T010000123Z-4242.jsonl`): a host's configuration names the directory
//   once, and every session it starts keeps its own record.
// - JSON Lines. The first line `{"record":1,"saveslot":<version>}`; once the protocol version is
//   known (the `initialize` answer, or the first request whose envelope names it), one line
//   `{"protocol":<version>}`; then one line per message: `{"t":<when, the system clock>,
//   "dir":"in"|"out","msg":<the message as it is>}`. A line from the host that is not JSON is kept
//   as `"raw"` instead of `"msg"`.
// - No token: the bridge sends its token only in a header, never in a message; a token of either
//   form written into a message anyway (`slt_…`, `sls_…`) is replaced by `slt_REDACTED` /
//   `sls_REDACTED` before the line is written.
// - Every line is written synchronously; a write that fails throws, and the bridge stops: a record
//   with a hole in it is worse than a run that visibly broke.

import { closeSync, openSync, statSync, writeSync } from "node:fs";
import { join } from "node:path";

/** A credential of either form, as it may appear inside a message. */
const TOKENS = /\b(slt|sls)_[A-Za-z0-9_-]{16,}/g;

/** `s` with every token replaced by its form's `_REDACTED`. */
export const redactTokens = (s: string): string => s.replace(TOKENS, "$1_REDACTED");

export interface CallRecord {
  /** A message read from the host (`in`) or written back to it (`out`), as its line. */
  message(dir: "in" | "out", line: string): void;
  /** The protocol version, once known; written once. */
  protocol(version: string): void;
  close(): void;
}

/** A new record's file in the directory `dir`: when the bridge started, and its process. */
export const recordFileIn = (dir: string, at: Date, pid: number): string =>
  join(dir, `record-${at.toISOString().replace(/[-:.]/g, "")}-${pid}.jsonl`);

/**
 * Opens a new record at `path`, or in it when it is a directory; throws (`EEXIST` when the file
 * exists) when it cannot.
 */
export function openRecord(path: string, version: string): CallRecord {
  let isDir = false;
  try {
    isDir = statSync(path).isDirectory();
  } catch {}
  const file = isDir ? recordFileIn(path, new Date(), process.pid) : path;
  const fd = openSync(file, "wx", 0o600);
  let closed = false;
  let protocolSaid = false;
  const line = (v: unknown) => {
    if (closed) return;
    writeSync(fd, `${redactTokens(JSON.stringify(v))}\n`);
  };
  line({ record: 1, saveslot: version });
  return {
    message(dir, text) {
      let msg: unknown;
      try {
        msg = JSON.parse(text);
      } catch {
        line({ t: new Date().toISOString(), dir, raw: text });
        return;
      }
      line({ t: new Date().toISOString(), dir, msg });
    },
    protocol(v) {
      if (protocolSaid) return;
      protocolSaid = true;
      line({ protocol: v });
    },
    close() {
      if (closed) return;
      closed = true;
      closeSync(fd);
    },
  };
}
