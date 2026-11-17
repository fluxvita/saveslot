// Questions on a terminal (06-cli §5.4): the prompt to `output`, the answer a line of `input`.
// One reader for the whole process, so that lines that came in together are each the answer to
// one question, in order, and none is lost between two questions.

import { createInterface, type Interface } from "node:readline";
import type { Readable, Writable } from "node:stream";

export interface Asker {
  /** Writes `prompt` and resolves with the next line; undefined once the input has ended. */
  readonly ask: (prompt: string) => Promise<string | undefined>;
  /** Stops reading the input (the process can then exit with a terminal on stdin). */
  readonly close: () => void;
}

export function lineAsker(input: Readable, output: Writable): Asker {
  let rl: Interface | undefined;
  let lines: AsyncIterator<string> | undefined;
  return {
    ask: async (prompt) => {
      output.write(prompt);
      if (lines === undefined) {
        // Made on the first question: a command that asks nothing does not read stdin.
        rl = createInterface({ input, terminal: false, crlfDelay: Number.POSITIVE_INFINITY });
        lines = rl[Symbol.asyncIterator]();
      }
      const next = await lines.next();
      return next.done === true ? undefined : next.value;
    },
    close: () => rl?.close(),
  };
}
