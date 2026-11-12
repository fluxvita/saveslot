// Experiment 1 observer: a separate process (for power-loss runs, on another machine) that records
// the highest event number the writer reported as committed — the "confirmed" number.
//
//   node --conditions=source experiments/exp1/observer.ts [--host 127.0.0.1] [--port 0] [--log <file>]
//
// Protocol (TCP, one line per message):
//   writer → "ack <n>"   observer replies "ok" after recording n
//   anyone → "max"       observer replies the highest n recorded so far
// With --log, every ack is appended to the file with a timestamp and fsynced before "ok", so the
// confirmed number survives an observer restart.

import { appendFileSync, closeSync, fsyncSync, openSync } from "node:fs";
import { createServer } from "node:net";
import { createInterface } from "node:readline";
import { arg } from "../lib/util.ts";

const host = arg("host", "127.0.0.1");
const port = Number(arg("port", "0"));
const logPath = process.argv.includes("--log") ? arg("log") : undefined;
const logFd = logPath ? openSync(logPath, "a") : undefined;

let max = 0;
const server = createServer((sock) => {
  const rl = createInterface({ input: sock });
  rl.on("line", (line) => {
    const [cmd, val] = line.trim().split(" ");
    if (cmd === "ack") {
      const n = Number(val);
      if (n > max) max = n;
      if (logFd !== undefined && logPath) {
        appendFileSync(logFd, `${new Date().toISOString()} ack ${n}\n`);
        fsyncSync(logFd);
      }
      sock.write("ok\n");
    } else if (cmd === "max") {
      sock.write(`${max}\n`);
    } else {
      sock.write("error\n");
    }
  });
  // A writer killed mid-conversation resets the connection; that is expected here.
  sock.on("error", () => {});
  rl.on("error", () => {});
});
server.listen(port, host, () => {
  const a = server.address();
  process.stdout.write(
    `${JSON.stringify({ listening: true, host, port: typeof a === "object" && a ? a.port : port })}\n`,
  );
});
process.on("SIGTERM", () => {
  if (logFd !== undefined) closeSync(logFd);
  process.exit(0);
});
