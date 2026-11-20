// Asking the person running an evaluation to go on (./fixture.ts). In a terminal, readline reads
// Ctrl-C as a key, not as a signal: with no listener for it, a pending question is rejected
// ("Aborted with Ctrl+C") and the process's SIGINT handler never runs. So Ctrl-C here is handed to
// `onInterrupt`, the same way out as the signal.

import { createInterface } from "node:readline/promises";

export interface Prompt {
  ask(question: string): Promise<string>;
  close(): void;
}

export function prompt(
  input: NodeJS.ReadableStream,
  output: NodeJS.WritableStream,
  onInterrupt: () => void,
  terminal?: boolean,
): Prompt {
  const rl = createInterface({ input, output, ...(terminal !== undefined ? { terminal } : {}) });
  rl.on("SIGINT", onInterrupt);
  return {
    ask: (question) => rl.question(question),
    close: () => rl.close(),
  };
}
