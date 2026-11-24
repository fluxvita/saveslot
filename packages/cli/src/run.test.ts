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
/** The questions the command asked, in order. */
const asked: string[] = [];
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
  o: {
    env?: Record<string, string | undefined>;
    tty?: boolean;
    answers?: string[];
    stdinIsTTY?: boolean;
  } = {},
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
    stdinIsTTY: o.stdinIsTTY ?? o.answers !== undefined,
    ask: async (prompt) => {
      asked.push(prompt);
      return o.answers?.shift();
    },
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
      // Pages of `limit` tables (50 when not given), the cursor carrying where the next starts.
      const limit = Number(url.searchParams.get("limit") ?? "50");
      const from = Number(/^cur_(\d+)\./.exec(url.searchParams.get("cursor") ?? "")?.[1] ?? "0");
      const page = names.slice(from, from + limit);
      const tables = page.map((n) => ({ table: n, kind: "base", description: "d" }));
      const more = from + limit < names.length;
      json(res, 200, {
        level: "list",
        total: names.length,
        slots: [{ ...LIST.slots[0], tables }],
        ...(more ? { next_cursor: `cur_${from + limit}.${"A".repeat(43)}` } : {}),
      });
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
    expect(urls[0]).toBe("/v1/slots/health?limit=200");
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

  it("a slot whose tables fill more than one page of the list: every page taken", async () => {
    const names = Array.from({ length: 450 }, (_, i) => `t${i}`);
    answer = catalogOf(names);
    seen.length = 0;
    const r = await cli(["slot", "show", "health", "--json"]);
    expect(r.code).toBe(0);
    const lists = seen
      .map((x) => new URL(x.url ?? "", "http://x"))
      .filter((u) => u.pathname === "/v1/slots/health");
    expect(lists).toHaveLength(3);
    expect(JSON.parse(r.out).tables).toHaveLength(450);
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

  it("a --timezone the service refuses: the error says it was the one given, and what it takes", async () => {
    answer = (_, res) =>
      json(res, 400, {
        error: {
          code: "validation_failed",
          reason: "schema",
          message: "the document does not compile",
          details: [{ code: "timezone_unknown", path: "timezone" }],
        },
      });
    const given = await cli([
      "slot",
      "create",
      "mine",
      "--template",
      "running",
      "--timezone",
      "Mars/Olympus",
    ]);
    expect(given.code).toBe(5);
    expect(given.err).toContain(TEXTS.timezoneRefused);
    // Not the command line's time zone (a file's own): no such line.
    const file = join(root, "tz.json");
    writeFileSync(file, JSON.stringify({ timezone: "Mars/Olympus", tables: [] }));
    const fromFile = await cli(["slot", "create", "mine", "--file", file]);
    expect(fromFile.code).toBe(5);
    expect(fromFile.err).not.toContain(TEXTS.timezoneRefused);
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
      // The keys are the CLI's words; the values, the service's, are inside the boundary.
      "  reserved_name  at path <U>tables/0/fields/1</U>",
      "  rule_sql_rejected  at table <U>w</U>, line 3",
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

describe("query", () => {
  const RESULT = { table: "ledger.expenses", slot: "ledger", sv: 1, total: 0, rows: [] };
  /** The stand-in: the table's catalog (for --where), and the query. */
  const answering = () => {
    answer = (req, res) => {
      if (req.method === "GET") {
        json(res, 200, {
          level: "table",
          tables: [
            {
              ...TABLE("ledger.expenses"),
              fields: [
                { name: "amount", type: "quantity", unit: "CNY", description: "d" },
                { name: "n", type: "integer", description: "d" },
                { name: "note", type: "text", description: "d" },
                { name: "Paid", type: "boolean", description: "d" },
              ],
            },
          ],
        });
        return;
      }
      json(res, 200, RESULT);
    };
  };

  it("--where by the fields' types, read from the catalog first; --where-json after them", async () => {
    answering();
    seen.length = 0;
    bodies.length = 0;
    const r = await cli([
      "query",
      "expenses",
      "--where",
      "amount>50CNY",
      "--where",
      "n = 007",
      "--where-json",
      '{"field":"note","op":"contains","value":"x"}',
      "--order",
      "n:desc",
      "--fields",
      "amount, n",
      "--valid-during",
      "2026-11-01,",
      "--detail",
      "detailed",
      "--include-revoked",
      "--limit",
      "5",
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => `${x.method} ${x.url}`)).toEqual([
      "GET /v1/tables/expenses",
      "POST /v1/query",
    ]);
    expect(bodies[1]).toEqual({
      table: "expenses",
      where: [
        { field: "amount", op: ">", value: { value: "50", unit: "CNY" } },
        { field: "n", op: "=", value: "7" },
        { field: "note", op: "contains", value: "x" },
      ],
      order: [{ field: "n", dir: "desc" }],
      fields: ["amount", "n"],
      valid_during: ["2026-11-01", null],
      include_revoked: true,
      detail: "detailed",
      limit: 5,
    });
  });

  it("a field in another ASCII case: its type found all the same (a quantity, a boolean)", async () => {
    answering();
    bodies.length = 0;
    const r = await cli(["query", "expenses", "--where", "AMOUNT>50CNY", "--where", "paid=true"]);
    expect(r.code).toBe(0);
    // The catalog has `amount` and `Paid`: each found from the other case.
    expect((bodies[1] as { where: unknown }).where).toEqual([
      { field: "AMOUNT", op: ">", value: { value: "50", unit: "CNY" } },
      { field: "paid", op: "=", value: true },
    ]);
  });

  it("no --where: no catalog read", async () => {
    answering();
    seen.length = 0;
    expect((await cli(["query", "expenses"])).code).toBe(0);
    expect(seen.map((x) => x.method)).toEqual(["POST"]);
  });

  it.each([
    [["query"], TEXTS.queryTableMissing],
    [["query", "a", "b"], TEXTS.queryTableMissing],
    [["query", "t", "--order", "n:sideways"], TEXTS.orderBad],
    [["query", "t", "--valid-during", ",2026-11-01"], TEXTS.validDuringBad],
    [["query", "t", "--detail", "full"], TEXTS.detailBad],
    [["query", "t", "--where-json", "nope"], TEXTS.whereJsonBad(1)],
    [["query", "t", "--sources"], TEXTS.optionNotHere],
  ])("%j: 2", async (argv, text) => {
    answering();
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
  });

  it("a --where the catalog's types refuse: 2, after reading the catalog only", async () => {
    answering();
    seen.length = 0;
    const r = await cli(["query", "expenses", "--where", "amount>50"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(TEXTS.whereUnitMissing(1))}\n`);
    expect(seen.map((x) => x.method)).toEqual(["GET"]);
  });
});

describe("sql", () => {
  const RESULT = { sv: { ledger: 1 }, columns: [{ name: "n", type: "integer" }], rows: [["2"]] };
  const answering = () => {
    answer = (_req, res) => json(res, 200, RESULT);
  };

  it("the statement, each --param as text in order, --max-rows, --at, --cursor", async () => {
    answering();
    seen.length = 0;
    bodies.length = 0;
    const cursor = `cur_abc.${"A".repeat(43)}`;
    const r = await cli([
      "sql",
      "SELECT count(*) AS n FROM expenses WHERE date >= $1 AND amount > $2",
      "--param",
      "2026-11-01",
      "--param",
      "50",
      "--max-rows",
      "20",
      "--at",
      "2026-11-20T00:00:00Z",
      "--cursor",
      cursor,
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => `${x.method} ${x.url}`)).toEqual(["POST /v1/sql"]);
    expect(bodies[0]).toEqual({
      sql: "SELECT count(*) AS n FROM expenses WHERE date >= $1 AND amount > $2",
      params: ["2026-11-01", "50"],
      max_rows: 20,
      at: "2026-11-20T00:00:00Z",
      cursor,
    });
    expect(r.out).toContain("ledger schema v1 · 1 rows");
  });

  it("--json: the result as the service gave it", async () => {
    answering();
    const r = await cli(["sql", "SELECT count(*) AS n FROM expenses", "--json"]);
    expect(r.code).toBe(0);
    expect(JSON.parse(r.out)).toEqual(RESULT);
  });

  it.each([
    [["sql"], TEXTS.sqlMissing],
    [["sql", "SELECT 1", "SELECT 2"], TEXTS.sqlMissing],
    [["sql", "SELECT 1", "--max-rows", "0"], TEXTS.maxRowsInvalid],
    [["sql", "SELECT 1", "--max-rows", "ten"], TEXTS.maxRowsInvalid],
    [["sql", "SELECT 1", "--limit", "5"], TEXTS.sqlNoLimit],
    [["sql", "SELECT 1", "--where", "a=1"], TEXTS.optionNotHere],
  ])("%j: 2, nothing sent", async (argv, text) => {
    answering();
    seen.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
    expect(seen).toEqual([]);
  });
});

describe("history", () => {
  const TIMELINE = {
    mode: "timeline",
    target: { table: "t" },
    sv: 1,
    timezone: "UTC",
    ver: "v1.0",
    total: 0,
    entries: [],
  };
  const AS_OF = { mode: "as_of", as_of: { seq: 3 }, sv: 1, timezone: "UTC", total: 0, rows: [] };
  const answering = () => {
    answer = (req, res) => {
      if (req.method === "GET") {
        json(res, 200, {
          level: "table",
          tables: [
            {
              ...TABLE("plan.budgets"),
              fields: [{ name: "category", type: "text", description: "d" }],
            },
          ],
        });
        return;
      }
      json(
        res,
        200,
        (bodies[bodies.length - 1] as { mode?: string }).mode === "as_of" ? AS_OF : TIMELINE,
      );
    };
  };
  const row = "r_4KWKRM296X61WJ89DY5XJNVA4P";

  it.each([
    [["history", "expenses", row], { table: "expenses", row, mode: "timeline" }],
    [
      ["history", "expenses", row, "--sources"],
      { table: "expenses", row, mode: "timeline", expand_sources: true },
    ],
    [
      ["history", "budgets", "e_4KWKRM296X61WJ89DY5XJNVA4P"],
      { table: "budgets", entity: "e_4KWKRM296X61WJ89DY5XJNVA4P", mode: "timeline" },
    ],
    [
      ["history", "expenses", row, "--as-of", "12"],
      { table: "expenses", row, mode: "as_of", as_of: 12 },
    ],
    [
      ["history", "expenses", row, "--as-of", "2026-11-10T00:00:00Z", "--detail", "detailed"],
      { table: "expenses", row, mode: "as_of", as_of: "2026-11-10T00:00:00Z", detail: "detailed" },
    ],
    [
      ["history", "expenses", row, "--as-of-read", "rd_VE4MY5TRXJHK2HQ7"],
      { table: "expenses", row, mode: "as_of", as_of: { read: "rd_VE4MY5TRXJHK2HQ7" } },
    ],
  ])("%j", async (argv, body) => {
    answering();
    bodies.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(0);
    expect(bodies[bodies.length - 1]).toEqual(body);
  });

  it("--key: the entity by its key, the value by the field's type from the catalog", async () => {
    answering();
    bodies.length = 0;
    seen.length = 0;
    const r = await cli([
      "history",
      "budgets",
      "--key",
      "category=food",
      "--as-of",
      "5",
      "--valid-at",
      "2026-11-02",
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => x.method)).toEqual(["GET", "POST"]);
    expect(bodies[1]).toEqual({
      table: "budgets",
      entity_key: { category: "food" },
      mode: "as_of",
      as_of: 5,
      valid_at: "2026-11-02",
    });
  });

  it.each([
    [["history", "t"], TEXTS.historyTarget],
    [["history", "t", "nope"], TEXTS.historyTarget],
    [["history", "t", row, "--key", "a=b"], TEXTS.historyTarget],
    [["history", "t", "--key", "nokey"], TEXTS.keyBad],
    [["history", "t", row, "--as-of", "3", "--as-of-read", "rd_x"], TEXTS.asOfBoth],
    [["history", "t", row, "--valid-at", "2026-11-01"], TEXTS.asOfOnly],
  ])("%j: 2", async (argv, text) => {
    answering();
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
  });
});

describe("history changes", () => {
  const CHANGES = {
    mode: "changes",
    target: { table: "expenses" },
    timezone: "UTC",
    since: 3,
    until: 9,
    total: 0,
    changes: [],
  };
  const answering = () => {
    answer = (req, res) => {
      if (req.method === "GET") {
        json(res, 200, {
          level: "table",
          tables: [
            {
              ...TABLE("plan.budgets"),
              fields: [{ name: "category", type: "text", description: "d" }],
            },
          ],
        });
        return;
      }
      json(res, 200, CHANGES);
    };
  };
  const row = "r_4KWKRM296X61WJ89DY5XJNVA4P";

  it.each([
    [
      ["history", "changes", "expenses", "--since", "3"],
      { table: "expenses", mode: "changes", since: 3 },
    ],
    [
      ["history", "changes", "expenses", "--since", "my_last_read", "--limit", "5"],
      { table: "expenses", mode: "changes", since: "my_last_read", limit: 5 },
    ],
    [
      ["history", "changes", "expenses", row, "--since", "2026-11-10T00:00:00Z", "--until", "9"],
      { table: "expenses", row, mode: "changes", since: "2026-11-10T00:00:00Z", until: 9 },
    ],
    [
      ["history", "changes", "budgets", "e_4KWKRM296X61WJ89DY5XJNVA4P", "--since", "0"],
      { table: "budgets", entity: "e_4KWKRM296X61WJ89DY5XJNVA4P", mode: "changes", since: 0 },
    ],
  ])("%j", async (argv, body) => {
    answering();
    bodies.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(0);
    expect(bodies[bodies.length - 1]).toEqual(body);
    expect(r.out).toContain("expenses · after #3 up to #9 · 0 changes");
  });

  it("--key: the entity by its key, the value by the field's type from the catalog", async () => {
    answering();
    bodies.length = 0;
    seen.length = 0;
    const r = await cli([
      "history",
      "changes",
      "budgets",
      "--key",
      "category=food",
      "--since",
      "5",
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => x.method)).toEqual(["GET", "POST"]);
    expect(bodies[1]).toEqual({
      table: "budgets",
      entity_key: { category: "food" },
      mode: "changes",
      since: 5,
    });
  });

  it("--json writes the result as the service gave it", async () => {
    answering();
    const r = await cli(["history", "changes", "expenses", "--since", "3", "--json"]);
    expect(JSON.parse(r.out)).toEqual(CHANGES);
  });

  it.each([
    [["history", "changes"], TEXTS.changesArgs],
    [["history", "changes", "t"], TEXTS.changesSince],
    [["history", "changes", "t", "nope", "--since", "1"], TEXTS.changesArgs],
    [["history", "changes", "t", row, "--key", "a=b", "--since", "1"], TEXTS.changesArgs],
    [["history", "changes", "t", "x", "y", "--since", "1"], TEXTS.changesArgs],
    [["history", "changes", "t", "--key", "nokey", "--since", "1"], TEXTS.keyBad],
  ])("%j: 2", async (argv, text) => {
    answering();
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
  });

  it("my_last_read before any read: the service's read_first, and what to do", async () => {
    answer = (_req, res) =>
      json(res, 409, {
        error: {
          code: "read_first",
          message: "read the table first",
          reason: "no_read",
          target: "table",
          ref: { table: "plan.budgets" },
          param: "since",
        },
      });
    const r = await cli(["history", "changes", "budgets", "--since", "my_last_read"]);
    expect(r.code).toBe(3);
    expect(r.err).toContain(TEXTS.changesReadFirst);
  });

  it("--since and --until are not for the other commands", async () => {
    answering();
    const r = await cli(["history", "expenses", row, "--until", "3"]);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(TEXTS.optionNotHere)}\n`);
  });
});

describe("pending, reads, verify", () => {
  const VERIFY = {
    events: 3,
    chain: { intact: true },
    checksum_mismatch: [],
    index_mismatch: [],
    removed: 0,
    gaps: [],
  };
  const answering = (verify: unknown = VERIFY) => {
    answer = (req, res) => {
      const u = new URL(req.url ?? "", "http://x");
      if (u.pathname === "/v1/pending") json(res, 200, { total: 0, items: [] });
      else if (u.pathname.startsWith("/v1/pending/"))
        json(res, 404, { error: { code: "not_found", message: "no such item" } });
      else if (u.pathname === "/v1/reads")
        json(res, 200, { covered_since: "2026-01-01T00:00:00.000Z", total: 0, reads: [] });
      else json(res, 200, verify);
    };
  };

  it("pending and pending list: the list, with the filters as asked", async () => {
    answering();
    seen.length = 0;
    expect((await cli(["pending"])).code).toBe(0);
    expect(
      (await cli(["pending", "list", "--slot", "ledger", "--type", "conflict", "--status", "all"]))
        .code,
    ).toBe(0);
    const u = new URL(seen[1]?.url ?? "", "http://x");
    expect(seen[0]?.url).toBe("/v1/pending");
    expect([...u.searchParams]).toEqual([
      ["slot", "ledger"],
      ["type", "conflict"],
      ["status", "all"],
    ]);
  });

  it("pending show <pi_…>: the item's route; not found is 4", async () => {
    answering();
    seen.length = 0;
    const r = await cli(["pending", "show", "pi_8VEZWJ3J7BMKMXTV"]);
    expect(seen[0]?.url).toBe("/v1/pending/pi_8VEZWJ3J7BMKMXTV");
    expect(r.code).toBe(4);
  });

  it("reads --since 10m: a moment ten minutes ago; --connection as given", async () => {
    answering();
    seen.length = 0;
    const before = Date.now();
    expect((await cli(["reads", "--since", "10m", "--connection", "MacBook · Codex"])).code).toBe(
      0,
    );
    const u = new URL(seen[0]?.url ?? "", "http://x");
    expect(u.searchParams.get("connection")).toBe("MacBook · Codex");
    const since = Date.parse(u.searchParams.get("since") ?? "");
    expect(before - 600_000 - since).toBeLessThanOrEqual(0);
    expect(Date.now() - 600_000 - since).toBeGreaterThanOrEqual(0);
    seen.length = 0;
    expect((await cli(["reads", "--since", "2026-11-10T00:00:00Z"])).code).toBe(0);
    expect(new URL(seen[0]?.url ?? "", "http://x").searchParams.get("since")).toBe(
      "2026-11-10T00:00:00Z",
    );
  });

  it("verify: 0 when all is well, 9 when it finds a problem (the result written all the same)", async () => {
    answering();
    expect((await cli(["verify"])).code).toBe(0);
    answering({ ...VERIFY, chain: { intact: false, broken_at: 2 } });
    const bad = await cli(["verify"]);
    expect(bad.code).toBe(9);
    expect(bad.out).toContain("problems found");
  });

  it.each([
    [["pending", "list", "extra"], TEXTS.pendingListArgs],
    [["pending", "--type", "nope"], TEXTS.pendingTypeBad],
    [["pending", "--status", "closed"], TEXTS.pendingStatusBad],
    [["pending", "show"], TEXTS.pendingShowArgs],
    [["pending", "show", "r_1"], TEXTS.pendingShowArgs],
    [["reads", "--since", "yesterday"], TEXTS.sinceBad],
    [["reads", "x"], TEXTS.readsArgs],
    [["verify", "x"], TEXTS.verifyArgs],
  ])("%j: 2", async (argv, text) => {
    answering();
    seen.length = 0;
    const r = await cli(argv);
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
    expect(seen).toHaveLength(0);
  });
});

describe("pending resolve", () => {
  const ID = "pi_8VEZWJ3J7BMKMXTV";
  const actor = { kind: "user", id: `u_${"2".repeat(26)}` };
  const awaiting = (iv: string, status = "open") => ({
    id: ID,
    item_ver: iv,
    type: "awaiting_confirmation",
    status,
    slot: "ledger",
    target: { table: "ledger.budgets", entity: "e_4KWKRM296X61WJ89DY5XJNVA4P" },
    reason: "overwrites_change_point",
    opened_at: "2026-11-10T18:02:00.000Z",
    opened_by: actor,
    decisions: status === "open" ? ["confirm", "reject"] : [],
    proposal: { seq: 4, actor, intent: "update", set: { amount: { value: "3", unit: "CNY" } } },
    current: { values: { amount: { value: "4", unit: "CNY" } } },
    impact: {},
  });
  const resolved = (iv: string) => ({
    id: ID,
    type: "awaiting_confirmation",
    decision: "confirm",
    item_ver: iv,
    status: "resolved",
  });
  /** The stand-in: each GET of the item and each POST of a resolution answered from a queue. */
  const queue = (gets: unknown[], posts: [number, unknown][]) => {
    answer = (req, res) => {
      if (req.method === "GET") json(res, 200, gets.shift());
      else {
        const [status, body] = posts.shift() as [number, unknown];
        json(res, status, body);
      }
    };
  };
  const posts = () =>
    seen
      .map((x, i) => [x, bodies[i]] as const)
      .filter(([x]) => x.method === "POST")
      .map(([, b]) => b);

  it("asked: the item read and shown, then resolved with the version of that read", async () => {
    queue([awaiting("iv_A1B2C3D4E5F6G7H8.4.0")], [[200, resolved("iv_A1B2C3D4E5F6G7H8.5.0")]]);
    seen.length = 0;
    bodies.length = 0;
    asked.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm", "--note", "fine"], {
      answers: ["y"],
    });
    expect(r.code).toBe(0);
    expect(seen.map((x) => `${x.method} ${x.url}`)).toEqual([
      `GET /v1/pending/${ID}`,
      `POST /v1/pending/${ID}/resolution`,
    ]);
    expect(posts()).toEqual([
      { decision: "confirm", item_ver: "iv_A1B2C3D4E5F6G7H8.4.0", note: "fine" },
    ]);
    expect(r.err).toContain("proposed: update amount 3");
    expect(asked).toEqual([`confirm ${ID}? [y/N] `]);
    expect(r.out).toContain(`${ID} resolved: confirm · version iv_A1B2C3D4E5F6G7H8.5.0`);
  });

  it("changed between the question and the answer: shown again, asked again, sent with the new version", async () => {
    const mismatch = {
      error: {
        code: "confirmation_mismatch",
        message: "changed",
        current: awaiting("iv_A1B2C3D4E5F6G7H8.6.0"),
      },
    };
    queue(
      [awaiting("iv_A1B2C3D4E5F6G7H8.4.0")],
      [
        [409, mismatch],
        [200, resolved("iv_A1B2C3D4E5F6G7H8.7.0")],
      ],
    );
    seen.length = 0;
    bodies.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm"], { answers: ["y", "y"] });
    expect(r.code).toBe(0);
    expect(posts().map((b) => (b as { item_ver: string }).item_ver)).toEqual([
      "iv_A1B2C3D4E5F6G7H8.4.0",
      "iv_A1B2C3D4E5F6G7H8.6.0",
    ]);
    expect(r.err).toContain(TEXTS.changedSince);
  });

  it("changed under every one of three questions: its own words, not done (8)", async () => {
    const mismatch = (v: string) => ({
      error: { code: "confirmation_mismatch", message: "changed", current: awaiting(v) },
    });
    queue(
      [awaiting("iv_A1B2C3D4E5F6G7H8.4.0")],
      [
        [409, mismatch("iv_A1B2C3D4E5F6G7H8.5.0")],
        [409, mismatch("iv_A1B2C3D4E5F6G7H8.6.0")],
        [409, mismatch("iv_A1B2C3D4E5F6G7H8.7.0")],
      ],
    );
    seen.length = 0;
    bodies.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm"], { answers: ["y", "y", "y"] });
    expect(r.code).toBe(8);
    expect(posts()).toHaveLength(3);
    expect(r.err.endsWith(`${TEXTS.keptChanging}\n`)).toBe(true);
    expect(r.err).not.toContain(`${TEXTS.declined}\n`);
  });

  it("--item-ver older than the item: said so, and the version shown is the one sent", async () => {
    queue([awaiting("iv_A1B2C3D4E5F6G7H8.6.0")], [[200, resolved("iv_A1B2C3D4E5F6G7H8.7.0")]]);
    bodies.length = 0;
    seen.length = 0;
    const r = await cli(
      ["pending", "resolve", ID, "confirm", "--item-ver", "iv_A1B2C3D4E5F6G7H8.4.0"],
      { answers: ["y"] },
    );
    expect(r.code).toBe(0);
    expect(r.err).toContain(TEXTS.changedSince);
    expect((posts()[0] as { item_ver: string }).item_ver).toBe("iv_A1B2C3D4E5F6G7H8.6.0");
  });

  it("declined, or stdin ends: not done (8), nothing sent", async () => {
    for (const answers of [["n"], [""], []]) {
      queue([awaiting("iv_A1B2C3D4E5F6G7H8.4.0")], []);
      seen.length = 0;
      const r = await cli(["pending", "resolve", ID, "confirm"], { answers });
      expect(r.code).toBe(8);
      expect(seen.map((x) => x.method)).toEqual(["GET"]);
    }
  });

  it("no terminal and no --yes: not done (8), nothing asked or read", async () => {
    seen.length = 0;
    asked.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm"], { stdinIsTTY: false });
    expect(r.code).toBe(8);
    expect(r.err).toBe(`${TEXTS.noTerminal}\n`);
    expect(seen).toHaveLength(0);
    expect(asked).toHaveLength(0);
  });

  it("--yes: the --item-ver given, as it is, the item not read; without it, not done (8)", async () => {
    queue([], [[200, resolved("iv_A1B2C3D4E5F6G7H8.5.0")]]);
    seen.length = 0;
    bodies.length = 0;
    const r = await cli([
      "pending",
      "resolve",
      ID,
      "confirm",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
    ]);
    expect(r.code).toBe(0);
    expect(seen.map((x) => x.method)).toEqual(["POST"]);
    expect(posts()).toEqual([{ decision: "confirm", item_ver: "iv_A1B2C3D4E5F6G7H8.4.0" }]);
    seen.length = 0;
    const none = await cli(["pending", "resolve", ID, "confirm", "--yes"]);
    expect(none.code).toBe(8);
    expect(seen).toHaveLength(0);
  });

  it("an item closed already: said how, 3, nothing sent", async () => {
    const closed = {
      ...awaiting("iv_A1B2C3D4E5F6G7H8.5.0", "resolved"),
      resolution: { decision: "reject", seq: 9, at: "2026-11-10T19:00:00.000Z", actor },
    };
    queue([closed], []);
    seen.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm"], { answers: ["y"] });
    expect(r.code).toBe(3);
    expect(r.err).toContain("resolved: reject (#9");
    expect(seen.map((x) => x.method)).toEqual(["GET"]);
  });

  it("a conflict, take_candidate, several candidates: asked which (a wrong answer asked again)", async () => {
    const conflict = {
      ...awaiting("iv_A1B2C3D4E5F6G7H8.4.0"),
      type: "conflict",
      reason: "stale_write",
      decisions: ["keep_effective", "take_candidate", "take_previous"],
      effective: { seq: 3, actor, values: { amount: { value: "4", unit: "CNY" } }, exists: true },
      candidates: [
        {
          index: 0,
          seq: 4,
          actor,
          intent: "update",
          ver: "v3.0",
          values: { amount: { value: "5", unit: "CNY" } },
          cause: "stale_write",
        },
        {
          index: 1,
          seq: 5,
          actor,
          intent: "update",
          ver: "v3.0",
          values: { amount: { value: "6", unit: "CNY" } },
          cause: "stale_write",
        },
      ],
      previous: { seq: 2, exists: true, values: { amount: { value: "1", unit: "CNY" } } },
      reverted_by_previous: [],
    };
    queue(
      [conflict],
      [
        [
          200,
          { ...resolved("iv_A1B2C3D4E5F6G7H8.5.0"), type: "conflict", decision: "take_candidate" },
        ],
      ],
    );
    bodies.length = 0;
    seen.length = 0;
    asked.length = 0;
    const r = await cli(["pending", "resolve", ID, "take_candidate"], { answers: ["7", "1", "y"] });
    expect(r.code).toBe(0);
    expect(asked).toEqual([
      `${TEXTS.candidateNumber} (0, 1): `,
      `${TEXTS.candidateNumber} (0, 1): `,
      `take_candidate ${ID}? [y/N] `,
    ]);
    expect((posts()[0] as { candidate: number }).candidate).toBe(1);
  });

  it("--yes and a conflict with candidates unnamed: the service's refusal, the candidates listed, 2", async () => {
    queue(
      [],
      [
        [
          400,
          {
            error: {
              code: "invalid_argument",
              reason: "candidate_required",
              message: "name one",
              candidate_choices: [
                { index: 0, seq: 4, actor },
                { index: 1, seq: 5, actor },
              ],
            },
          },
        ],
      ],
    );
    const r = await cli([
      "pending",
      "resolve",
      ID,
      "take_candidate",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
    ]);
    expect(r.code).toBe(2);
    expect(r.err).toContain("  --candidate 0 (#4)");
    expect(r.err).toContain("  --candidate 1 (#5)");
  });

  it("a replay: already resolved so, nothing new, 0", async () => {
    queue([], [[200, { ...resolved("iv_A1B2C3D4E5F6G7H8.5.0"), replayed: true }]]);
    const r = await cli([
      "pending",
      "resolve",
      ID,
      "confirm",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
    ]);
    expect(r.code).toBe(0);
    expect(r.out).toContain(`${ID} was already resolved as confirm; nothing new was recorded`);
  });

  it("a mismatch with --yes: 3, and the version the item is at now", async () => {
    queue(
      [],
      [
        [
          409,
          {
            error: {
              code: "confirmation_mismatch",
              message: "changed",
              current: awaiting("iv_A1B2C3D4E5F6G7H8.6.0"),
            },
          },
        ],
      ],
    );
    const r = await cli([
      "pending",
      "resolve",
      ID,
      "confirm",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
    ]);
    expect(r.code).toBe(3);
    expect(r.err).toContain(`${TEXTS.itemVersionNow} iv_A1B2C3D4E5F6G7H8.6.0`);
  });

  it("the connection broken after the request went: where to see whether it took effect", async () => {
    answer = (req) => req.socket.destroy();
    const r = await cli([
      "pending",
      "resolve",
      ID,
      "confirm",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
    ]);
    expect(r.code).toBe(7);
    expect(r.err).toContain(TEXTS.unknownOutcome);
  });

  it("--evidence-json: segments, or the object form, sent with the decision", async () => {
    const file = join(root, "evidence.json");
    writeFileSync(file, JSON.stringify([{ kind: "user_message", text: "yes, 3000" }]));
    queue([], [[200, resolved("iv_A1B2C3D4E5F6G7H8.5.0")]]);
    bodies.length = 0;
    seen.length = 0;
    await cli([
      "pending",
      "resolve",
      ID,
      "confirm",
      "--yes",
      "--item-ver",
      "iv_A1B2C3D4E5F6G7H8.4.0",
      "--evidence-json",
      file,
    ]);
    expect(posts()).toEqual([
      {
        decision: "confirm",
        item_ver: "iv_A1B2C3D4E5F6G7H8.4.0",
        evidence: [{ kind: "user_message", text: "yes, 3000" }],
      },
    ]);
  });

  it.each([
    [["pending", "resolve", ID], TEXTS.resolveArgs],
    [["pending", "resolve", "pi_short", "confirm"], TEXTS.resolveArgs],
    [["pending", "resolve", `${ID}\u001b[2J`, "confirm"], TEXTS.resolveArgs],
    [["pending", "resolve", ID, "cancel"], TEXTS.decisionNotYet],
    [["pending", "resolve", ID, "take_candidate", "--candidate", "x"], TEXTS.candidateBad],
    [
      ["pending", "resolve", ID, "confirm", "--evidence-json", "/nonexistent.json"],
      TEXTS.evidenceBad,
    ],
  ])("%j: 2", async (argv, text) => {
    seen.length = 0;
    const r = await cli(argv, { answers: ["y"] });
    expect(r.code).toBe(2);
    expect(r.err).toBe(`${TEXTS.usageError(text)}\n`);
    expect(seen).toHaveLength(0);
  });

  it("an item of a kind this version does not resolve (flagged): 2 after reading it, nothing sent", async () => {
    queue([{ ...awaiting("iv_A1B2C3D4E5F6G7H8.4.0"), type: "flagged" }], []);
    seen.length = 0;
    const r = await cli(["pending", "resolve", ID, "confirm"], { answers: ["y"] });
    expect(r.code).toBe(2);
    expect(seen.map((x) => x.method)).toEqual(["GET"]);
  });
});

describe("usage", () => {
  it.each([
    [["nope"], TEXTS.unknownCommand],
    [["slot", "list", "--profile", "Cloud"], TEXTS.usageError(TEXTS.profileBad)],
    [["slot", "list", "--profile", "../x"], TEXTS.usageError(TEXTS.profileBad)],
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
