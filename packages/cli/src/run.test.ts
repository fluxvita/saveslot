// The command line (06-cli §4, §6) against a stand-in service on a home's socket: the global
// options, the forms of the output, an error's text and exit code, the usage errors. The real
// service is the entry package's tests'.

import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
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
/** The bodies of the requests, in order, as JSON. */
const bodies: unknown[] = [];
let answer: (req: IncomingMessage, res: ServerResponse) => void;
let server: Server;
beforeAll(async () => {
  mkdirSync(join(home, "run"), { recursive: true, mode: 0o700 });
  server = createServer((req, res) => {
    seen.push(req);
    const chunks: Buffer[] = [];
    req.on("data", (c: Buffer) => chunks.push(c));
    req.on("end", () => {
      const text = Buffer.concat(chunks).toString("utf8");
      bodies.push(text === "" ? undefined : JSON.parse(text));
      answer(req, res);
    });
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

const TABLE = (name: string) => ({
  table: name,
  slot: "health",
  sv: 1,
  timezone: "UTC",
  kind: "base",
  description: "d",
  time: { type: "none" },
  fields: [],
});

/** The stand-in's catalog for slot `health`: the list, several tables, one table. */
function catalogOf(names: readonly string[]) {
  return (req: IncomingMessage, res: ServerResponse) => {
    const url = new URL(req.url ?? "", "http://x");
    if (url.pathname === "/v1/slots/health") {
      const tables = names.map((n) => ({ table: n, kind: "base", description: "d" }));
      json(res, 200, { level: "list", total: names.length, slots: [{ ...LIST.slots[0], tables }] });
      return;
    }
    const one = /^\/v1\/slots\/health\/tables\/(\w+)$/.exec(url.pathname)?.[1];
    const asked = one !== undefined ? [one] : (url.searchParams.get("tables") ?? "").split(",");
    json(res, 200, { level: "table", tables: asked.map((t) => TABLE(`health.${t}`)) });
  };
}

describe("slot show", () => {
  it("no tables named: the slot's tables from the list, asked ten at a time", async () => {
    const names = Array.from({ length: 12 }, (_, i) => `t${i}`);
    answer = catalogOf(names);
    seen.length = 0;
    const r = await cli(["slot", "show", "health", "--json"]);
    expect(r.code).toBe(0);
    const urls = seen.map((x) => x.url ?? "");
    expect(urls[0]).toBe("/v1/slots/health");
    // Twelve tables: ten, then two, each a call for several tables of the slot.
    expect(urls.slice(1).map((u) => new URL(u, "http://x").pathname)).toEqual([
      "/v1/slots/health/tables",
      "/v1/slots/health/tables",
    ]);
    expect(urls.slice(1).map((u) => new URL(u, "http://x").searchParams.get("tables"))).toEqual([
      names.slice(0, 10).join(","),
      names.slice(10).join(","),
    ]);
    expect(JSON.parse(r.out).tables.map((x: { table: string }) => x.table)).toEqual(
      names.map((n) => `health.${n}`),
    );
  });

  it("tables named: those only, qualified by the slot; --tables adds to them", async () => {
    answer = catalogOf(["runs", "y"]);
    seen.length = 0;
    const r = await cli(["slot", "show", "health", "runs", "--tables", " y ", "--json"]);
    expect(r.code).toBe(0);
    expect(seen).toHaveLength(1);
    expect(new URL(seen[0]?.url ?? "", "http://x").searchParams.get("tables")).toBe("runs,y");
  });

  it("a table of another slot: a usage error, nothing asked", async () => {
    seen.length = 0;
    const r = await cli(["slot", "show", "health", "runs", "other.x"]);
    expect(r.code).toBe(2);
    expect(seen).toHaveLength(0);
  });
});

describe("slot create", () => {
  const created = (doc: Record<string, unknown>) => ({
    draft: "d_8VEZWJ3J7BMKMXTV",
    slot: doc["slot"],
    slot_id: "sl_8VEZWJ3J7BMKMXTV",
    target_sv: 1,
    sv: 1,
    document: doc,
    changes: [],
    impact: {},
    outcome: "applied",
  });
  const answering = () => {
    answer = (_, res) => json(res, 200, created(bodies[bodies.length - 1] as never));
  };

  it("a template: named by the command line, a new slot, the time zone given", async () => {
    answering();
    bodies.length = 0;
    const r = await cli([
      "slot",
      "create",
      "mine",
      "--template",
      "running",
      "--timezone",
      "Europe/Berlin",
    ]);
    expect(r.code).toBe(0);
    const doc = (bodies[0] as { document: Record<string, unknown> }).document;
    expect(doc).toMatchObject({ slot: "mine", base_version: null, timezone: "Europe/Berlin" });
    expect(r.out).not.toContain(TEXTS.timezoneChosen);
  });

  it("a template with no --timezone: this computer's, and the output says so", async () => {
    answering();
    bodies.length = 0;
    const r = await cli(["slot", "create", "mine", "--template", "budget"]);
    expect(r.code).toBe(0);
    const zone = Intl.DateTimeFormat().resolvedOptions().timeZone;
    expect((bodies[0] as { document: { timezone: string } }).document.timezone).toBe(zone);
    expect(r.out).toContain(TEXTS.timezoneChosen);
  });

  it("a file: its own time zone kept, unless --timezone is given; the name the command line's", async () => {
    answering();
    const file = join(root, "schema.json");
    writeFileSync(
      file,
      JSON.stringify({ slot: "x", base_version: 3, timezone: "Asia/Tokyo", tables: [] }),
    );
    bodies.length = 0;
    expect((await cli(["slot", "create", "mine", "--file", file])).code).toBe(0);
    expect((bodies[0] as { document: unknown }).document).toMatchObject({
      slot: "mine",
      base_version: null,
      timezone: "Asia/Tokyo",
    });
    bodies.length = 0;
    expect((await cli(["slot", "create", "mine", "--file", file, "--timezone", "UTC"])).code).toBe(
      0,
    );
    expect((bodies[0] as { document: { timezone: string } }).document.timezone).toBe("UTC");
  });

  it("a compile failure: each detail with where it is", async () => {
    answer = (_, res) =>
      json(res, 400, {
        error: {
          code: "validation_failed",
          message: "the schema does not compile",
          details: [
            { code: "reserved_name", path: "tables/0/fields/1" },
            { code: "rule_sql_rejected", table: "w", line: 3 },
          ],
        },
      });
    const r = await cli(["slot", "create", "mine", "--template", "running"]);
    expect(r.code).toBe(5);
    const lines = r.err.replace(/untrusted-data-[0-9a-f]{32}/g, "U").split("\n");
    expect(lines.slice(1, 3)).toEqual([
      "  reserved_name  at <U>path</U> <U>tables/0/fields/1</U>",
      "  rule_sql_rejected  at <U>table</U> <U>w</U>, <U>line</U> 3",
    ]);
  });

  it.each([
    [["slot", "create", "mine"], TEXTS.createNeedsOne],
    [["slot", "create", "mine", "--template", "running", "--file", "x.json"], TEXTS.createNeedsOne],
    [["slot", "create", "mine", "--template", "nope"], TEXTS.templateUnknown],
    [["slot", "create", "mine", "--file", "/nonexistent/x.json"], TEXTS.fileUnreadable],
    [["slot", "create", "--template", "running"], TEXTS.slotNameMissing],
    [["slot", "list", "--template", "running"], TEXTS.optionNotHere],
    [["slot", "show"], TEXTS.slotShowMissing],
  ])("%j: 2", async (argv, text) => {
    seen.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
    expect(seen).toHaveLength(0);
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
