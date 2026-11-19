// The MCP call record (docs/zh-CN/spec/02-architecture.md §11 «评测对实现的要求»; 06-cli §4.1):
// `saveslot mcp --record <file>`, for evaluations only. The bridge writes every message it reads
// from the host and every message it writes back, in order, so that the run's whole tool call
// sequence (arguments and structured results) is kept even when the host does not export it.
//
// - The file is new: made with O_EXCL at 0600; one that exists is refused, never appended to.
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

import { closeSync, openSync, writeSync } from "node:fs";

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

/** Opens a new record at `path`; throws (`EEXIST` when it exists) when it cannot. */
export function openRecord(path: string, version: string): CallRecord {
  const fd = openSync(path, "wx", 0o600);
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
