// Prints the observer's confirmed number (the highest acknowledged n).
//   node --conditions=source experiments/exp1/observer-max.ts --host <host> --port <port>

import { connect } from "node:net";
import { createInterface } from "node:readline";
import { arg } from "../lib/util.ts";

const s = connect(Number(arg("port")), arg("host", "127.0.0.1"));
await new Promise<void>((r, j) => {
  s.once("connect", () => r());
  s.once("error", j);
});
s.write("max\n");
const line = await new Promise<string>((r) => createInterface({ input: s }).once("line", r));
s.end();
console.log(line);
process.exit(0);
