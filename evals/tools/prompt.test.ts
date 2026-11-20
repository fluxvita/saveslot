// Ctrl-C at the runner's question (./prompt.ts): in a terminal it is a key that readline reads,
// and it must reach the runner's way out, not reject the question.

import { PassThrough } from "node:stream";
import { expect, it } from "vitest";
import { prompt } from "./prompt.ts";

it("Ctrl-C while a question waits calls onInterrupt, and the question is not rejected", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  let interrupted = 0;
  const p = prompt(input, output, () => interrupted++, true);
  let settled: string | undefined;
  p.ask("Press Enter once the agent has replied. ").then(
    () => (settled = "answered"),
    (e: Error) => (settled = `rejected: ${e.message}`),
  );
  input.write("\x03");
  await new Promise((r) => setTimeout(r, 50));
  expect(interrupted).toBe(1);
  expect(settled).toBeUndefined();
  p.close();
});

it("Enter answers the question", async () => {
  const input = new PassThrough();
  const output = new PassThrough();
  output.resume();
  const p = prompt(input, output, () => {}, true);
  const answer = p.ask("? ");
  input.write("\r");
  await expect(answer).resolves.toBe("");
  p.close();
});
