// The process's one reader of answers (./ask.ts).

import { PassThrough } from "node:stream";
import { describe, expect, it } from "vitest";
import { lineAsker } from "./ask.ts";

function streams() {
  const input = new PassThrough();
  const output = new PassThrough();
  let written = "";
  output.on("data", (c: Buffer) => {
    written += c.toString("utf8");
  });
  return { input, output, written: () => written };
}

describe("lineAsker", () => {
  it("two lines written at once: each question gets one, in order", async () => {
    const s = streams();
    const a = lineAsker(s.input, s.output);
    s.input.write("first\nsecond\n");
    expect(await a.ask("one? ")).toBe("first");
    expect(await a.ask("two? ")).toBe("second");
    expect(s.written()).toBe("one? two? ");
    a.close();
  });

  it("a line that comes after the question is its answer; CRLF ends a line too", async () => {
    const s = streams();
    const a = lineAsker(s.input, s.output);
    const asked = a.ask("q? ");
    setTimeout(() => s.input.write("later\r\n"), 20);
    expect(await asked).toBe("later");
    a.close();
  });

  it("the input ended: undefined, for this question and every later one", async () => {
    const s = streams();
    const a = lineAsker(s.input, s.output);
    s.input.end("last\n");
    expect(await a.ask("1? ")).toBe("last");
    expect(await a.ask("2? ")).toBeUndefined();
    expect(await a.ask("3? ")).toBeUndefined();
    expect(s.written()).toBe("1? 2? 3? ");
  });

  it("nothing asked: the input is not read", async () => {
    const s = streams();
    const a = lineAsker(s.input, s.output);
    s.input.write("untouched\n");
    a.close();
    expect(s.input.read()?.toString("utf8")).toBe("untouched\n");
  });
});
