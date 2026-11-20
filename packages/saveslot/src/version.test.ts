// `saveslot --version` (06-cli §4): this saveslot's version, alone on stdout, exit 0, no service.

import { daemonVersion } from "@fluxvita/saveslot-daemon";
import { expect, it } from "vitest";
import { dispatch } from "./dispatch.ts";

async function saveslot(...argv: string[]) {
  let out = "";
  let err = "";
  const code = await dispatch(
    argv,
    {},
    {
      out: (s) => {
        out += s;
      },
      err: (s) => {
        err += s;
      },
      stdoutIsTTY: false,
      stderrIsTTY: false,
    },
  );
  return { code, out, err };
}

it("--version: the version the service reports and start compares, and nothing else", async () => {
  const r = await saveslot("--version");
  expect(r).toEqual({ code: 0, out: `${daemonVersion()}\n`, err: "" });
  expect(r.out).toMatch(/^\d+\.\d+\.\d+(?:-[0-9A-Za-z.-]+)?\n$/);
});

it("--version with a command is not this: the command's own usage error", async () => {
  expect((await saveslot("--version", "status")).code).toBe(2);
});
