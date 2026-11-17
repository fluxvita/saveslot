// The command line (06-cli §4, §6) against a stand-in service on a home's socket: the global
// options, the forms of the output, an error's text and exit code, the usage errors. The real
// service is the entry package's tests'.

import { mkdirSync, mkdtempSync, rmSync } from "node:fs";
import { createServer, type IncomingMessage, type Server, type ServerResponse } from "node:http";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { run } from "./run.ts";
import { TEXTS } from "./texts.ts";

const TOKEN = `slt_${"A".repeat(43)}`;
const LIST = {
  level: "list",
  total: 1,
  slots: [
    {
      slot: "health",
      slot_id: "sl_8VEZWJ3J7BMKMXTV",
      sv: 1,
      timezone: "Asia/Shanghai",
      tables: [{ table: "health.runs", kind: "base", description: "runs \u202e" }],
    },
  ],
};

const root = mkdtempSync(join(tmpdir(), "saveslot-cli-"));
const home = join(root, "home");
const seen: IncomingMessage[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  server = createServer((req, res) => {
    seen.push(req);
    answer(req, res);
  });
  await new Promise<void>((r) => server.listen(join(home, "run", "saveslot.sock"), r));
});
afterAll(async () => {
  server.closeAllConnections();
  await new Promise((r) => server.close(r));
  rmSync(root, { recursive: true, force: true });
});

const json = (res: ServerResponse, status: number, v: unknown) =>
  res.writeHead(status, { "content-type": "application/json" }).end(JSON.stringify(v));

async function cli(
  argv: string[],
  o: { env?: Record<string, string | undefined>; tty?: boolean } = {},
) {
  let out = "";
  let err = "";
  const code = await run(["--home", home, ...argv], o.env ?? { SAVESLOT_TOKEN: TOKEN }, {
    out: (s) => {
      out += s;
    },
    err: (s) => {
      err += s;
    },
    stdoutIsTTY: o.tty ?? false,
    stderrIsTTY: o.tty ?? false,
  });
  return { code, out, err };
}

describe("slot list", () => {
  it("asks the catalog with the token; not a terminal: values in one numbered boundary", async () => {
    answer = (_, res) => json(res, 200, LIST);
    seen.length = 0;
    const r = await cli(["slot", "list", "--limit", "20"]);
    expect(r.code).toBe(0);
    expect(seen[0]?.headers["authorization"]).toBe(`Bearer ${TOKEN}`);
    expect(seen[0]?.url).toBe("/v1/slots?limit=20");
    const n = /<untrusted-data-([0-9a-f]{32})>/.exec(r.out)?.[1] as string;
    expect(r.out).toContain(`<untrusted-data-${n}>runs <U+202E></untrusted-data-${n}>`);
    expect(r.out).not.toContain("\u202e");
    expect(r.err).toBe("");
  });

  it("a terminal: between brackets, dim when it may, plain when NO_COLOR is set", async () => {
    answer = (_, res) => json(res, 200, LIST);
    const dim = await cli(["slot", "list"], {
      tty: true,
      env: { SAVESLOT_TOKEN: TOKEN, TERM: "xterm" },
    });
    expect(dim.out).toContain("\u001b[2m「runs <U+202E>」\u001b[22m");
    const bare = await cli(["slot", "list"], {
      tty: true,
      env: { SAVESLOT_TOKEN: TOKEN, NO_COLOR: "1" },
    });
    expect(bare.out).toContain("「runs <U+202E>」");
    expect(bare.out).not.toContain("\u001b");
  });

  it("--untrusted-tags: always tags in a terminal; never leaves them out off one", async () => {
    answer = (_, res) => json(res, 200, LIST);
    expect((await cli(["slot", "list", "--untrusted-tags", "always"], { tty: true })).out).toMatch(
      /<untrusted-data-[0-9a-f]{32}>/,
    );
    const never = await cli(["slot", "list", "--untrusted-tags", "never"]);
    expect(never.out).not.toContain("untrusted-data");
    expect(never.out).toContain("runs <U+202E>");
  });

  it("--json: the contract's result, with the bidi control written as \\u202e", async () => {
    answer = (_, res) => json(res, 200, LIST);
    const r = await cli(["slot", "list", "--json"]);
    expect(r.out).toContain("runs \\u202e");
    expect(JSON.parse(r.out)).toEqual(LIST);
  });
});

describe("errors", () => {
  it("a contract error: its exit code, the text on stderr; --json gives the error object", async () => {
    const body = {
      error: { code: "unavailable", reason: "starting", message: "the service is starting" },
    };
    answer = (_, res) => json(res, 503, body);
    const r = await cli(["slot", "list"]);
    expect(r.code).toBe(7);
    expect(r.out).toBe("");
    expect(r.err).toMatch(/^error unavailable \(<untrusted-data-/);
    const j = await cli(["slot", "list", "--json"]);
    expect(j.code).toBe(7);
    expect(JSON.parse(j.out)).toEqual(body);
  });

  it("no service on the socket: 7", async () => {
    const other = join(root, "elsewhere");
    mkdirSync(join(other, "run"), { recursive: true });
    let err = "";
    const code = await run(
      ["--home", other, "slot", "list"],
      { SAVESLOT_TOKEN: TOKEN },
      {
        out: () => {},
        err: (s) => {
          err += s;
        },
        stdoutIsTTY: false,
        stderrIsTTY: false,
      },
    );
    expect(code).toBe(7);
    expect(err).toBe(`${TEXTS.transport("unreachable")}\n`);
  });

  it("a credential it cannot use: 6, and the token never in the text", async () => {
    const bad = await cli(["slot", "list"], { env: { SAVESLOT_TOKEN: "sls_not_a_connection" } });
    expect(bad.code).toBe(6);
    expect(bad.err).not.toContain("sls_not_a_connection");
    const none = await cli(["slot", "list"], { env: {} });
    expect(none.code).toBe(6);
  });
});

describe("usage", () => {
  it.each([
    [["nope"], TEXTS.unknownCommand],
    [["slot", "list", "--profile", "cloud"], TEXTS.profileNotYet],
    [["slot", "list", "--limit", "0"], TEXTS.usageError(TEXTS.limitInvalid)],
    [
      ["slot", "list", "--untrusted-tags", "sometimes"],
      TEXTS.usageError(TEXTS.untrustedTagsInvalid),
    ],
  ])("%j: 2", async (argv, text) => {
    seen.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${text}\n`);
    expect(seen).toHaveLength(0);
  });

  it("an unknown option, no command: 2; --help: the usage, 0", async () => {
    expect((await cli(["slot", "list", "--nope"])).code).toBe(2);
    expect((await cli([])).code).toBe(2);
    const h = await cli(["--help"]);
    expect(h.code).toBe(0);
    expect(h.out).toBe(`${TEXTS.usage}\n`);
  });

  it("schema templates needs no service and no credential", async () => {
    seen.length = 0;
    const r = await cli(["schema", "templates"], { env: {} });
    expect(r.code).toBe(0);
    expect(r.out.split("\n")[0]).toMatch(/^running +/);
    expect(seen).toHaveLength(0);
  });
});
