// Samples of a storage format (docs/zh-CN/process/decisions/data-compatibility.md §4): data written
// by a release through the service, kept under packages/test-backend/fixtures/storage-format/ so
// that every later release's tests open it. Here: the history a sample holds, written over HTTP as
// an agent and a user would, with the values a reader must find in it; and packing a local home.
//
// The history has what the decision asks a sample to hold: writes on tables of every time type,
// a correction, a revoke and its undo, a conflict left open and one resolved, a write awaiting
// confirmation, premises (one changed since), rows by source key, a reference field, a derived
// table, evidence, and reads of what was written.

import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { CURRENT_FORMAT, REPO, SAMPLES_DIR } from "./format-sample-paths.fixture.ts";
import { httpRequest, type Target } from "./http-driver.fixture.ts";

export { CURRENT_FORMAT, REPO, SAMPLES_DIR };

/** The sample's slot: an event table, a state table, a timeless one by source key, a reference. */
export const SAMPLE_SLOT = {
  slot: "household",
  base_version: null,
  timezone: "Asia/Shanghai",
  tables: [
    {
      name: "expenses",
      kind: "base",
      description: "one row per expense",
      time: { type: "event", field: "date" },
      fields: [
        { name: "date", type: "date", required: true, description: "the day" },
        { name: "amount", type: "integer", description: "how much, in yuan" },
        { name: "note", type: "text", description: "what for" },
      ],
    },
    {
      name: "budgets",
      kind: "base",
      description: "a monthly budget by kind",
      time: { type: "state", granularity: "date" },
      entity_key: ["kind"],
      fields: [
        { name: "kind", type: "text", required: true, description: "what the budget is for" },
        { name: "amount", type: "integer", required: true, description: "the budget, in yuan" },
      ],
    },
    {
      name: "rides",
      kind: "base",
      description: "rides from an app",
      time: { type: "none" },
      external_key: ["origin", "external_id"],
      fields: [
        { name: "origin", type: "text", description: "the app" },
        { name: "external_id", type: "text", description: "its ID there" },
        { name: "fare", type: "integer", description: "how much" },
      ],
    },
    {
      name: "refunds",
      kind: "base",
      description: "one row per refund of an expense",
      time: { type: "none" },
      fields: [
        { name: "note", type: "text", required: true, description: "why" },
        {
          name: "expense",
          type: "ref",
          description: "the expense refunded",
          ref: { table: "expenses", target: "row" },
        },
      ],
    },
    {
      name: "spent_by_day",
      kind: "derived",
      description: "what was spent each day",
      rule: {
        sql: "SELECT date AS day, sum(amount) AS total, count(*) AS n FROM expenses GROUP BY 1",
        time_dependency: "bucketed",
      },
      fields: [
        { name: "day", description: "the day" },
        { name: "total", description: "the sum" },
        { name: "n", description: "how many" },
      ],
    },
  ],
};

type Json = Record<string, unknown>;

/** What a reader of the sample must find; written beside it as `expected.json`. */
export interface SampleExpected {
  readonly storage_format: number;
  /** The log's last `seq` when the sample was closed. */
  readonly log_end: number;
  /** Rows of `household.expenses` in effect, by note: date and amount. */
  readonly expenses: Readonly<Record<string, { date: string; amount: number | null }>>;
  /** The food budget on two days, one in each of its stretches. */
  readonly budget: Readonly<Record<string, number>>;
  /** Rides in effect, by external ID: the fare. */
  readonly rides: Readonly<Record<string, number>>;
  /** Open items by type. */
  readonly open_items: Readonly<Record<string, number>>;
  /** How many reads the read log holds at least. */
  readonly reads_at_least: number;
}

export class SampleError extends Error {}

/** A JSON request as `token`; the body parsed, a status other than 200 thrown with the body. */
export async function call(
  at: Target,
  token: string,
  method: string,
  path: string,
  body?: unknown,
): Promise<Json> {
  const r = await httpRequest(at, {
    method,
    path,
    token,
    ...(body !== undefined ? { body: JSON.stringify(body) } : {}),
  });
  if (r.status !== 200) throw new SampleError(`${method} ${path}: ${r.status} ${r.body}`);
  return JSON.parse(r.body) as Json;
}

interface OpReceipt {
  readonly target: { row?: string; entity?: string };
  readonly ver?: string;
  readonly status?: string;
  readonly outcome?: string;
}

/**
 * Writes the sample's history on the service at `at` as the user session `session`, and returns
 * what a reader must find. The tenant must be new: the slot is created here.
 */
export async function writeSampleHistory(at: Target, session: string): Promise<SampleExpected> {
  const draft = await call(at, session, "POST", "/v1/drafts", { document: SAMPLE_SLOT });
  const sv = Number((draft["sv"] ?? 1) as number);
  const agent = String(
    (await call(at, session, "POST", "/v1/connections", { name: "sample agent" }))["token"],
  );
  const other = String(
    (await call(at, session, "POST", "/v1/connections", { name: "another agent" }))["token"],
  );
  const write = async (token: string, ops: unknown[], extra: Json = {}): Promise<OpReceipt[]> =>
    (await call(at, token, "POST", "/v1/writes", { sv, ops, ...extra }))["ops"] as OpReceipt[];
  const first = async (token: string, op: unknown, extra: Json = {}): Promise<OpReceipt> => {
    const r = (await write(token, [op], extra))[0];
    if (r === undefined) throw new SampleError("a write gave no receipt");
    return r;
  };
  const rowOf = (r: OpReceipt): string => {
    if (r.target.row === undefined) throw new SampleError("a receipt without a row");
    return r.target.row;
  };

  // Event table: inserts with evidence, a correction, a revoke undone, a revoke left.
  const lunch = await first(
    agent,
    {
      intent: "insert",
      table: "household.expenses",
      set: { date: "2026-11-02", amount: 45, note: "lunch" },
    },
    { evidence: [{ kind: "user_message", text: "lunch today was 45" }] },
  );
  const taxi = await first(agent, {
    intent: "insert",
    table: "household.expenses",
    set: { date: "2026-11-02", amount: 30, note: "taxi" },
  });
  const coffee = await first(agent, {
    intent: "insert",
    table: "household.expenses",
    set: { date: "2026-11-03", amount: 18, note: "coffee" },
  });
  const lunchFixed = await first(
    agent,
    {
      intent: "correct",
      table: "household.expenses",
      row: rowOf(lunch),
      ver: lunch.ver,
      set: { amount: 54 },
    },
    { evidence: [{ kind: "user_message", text: "sorry, lunch was 54" }] },
  );
  await first(agent, {
    intent: "revoke",
    table: "household.expenses",
    row: rowOf(coffee),
    ver: coffee.ver,
  });

  // A revoke undone: the snack is there again.
  const snack = await first(agent, {
    intent: "insert",
    table: "household.expenses",
    set: { date: "2026-11-04", amount: 9, note: "snack" },
  });
  const revoked = await call(at, agent, "POST", "/v1/writes", {
    sv,
    ops: [{ intent: "revoke", table: "household.expenses", row: rowOf(snack), ver: snack.ver }],
  });
  await first(agent, {
    table: "household.expenses",
    row: rowOf(snack),
    revert: { undo: Number(revoked["seq"]) },
  });

  // A conflict left open: two updates of the taxi from the version both read.
  await first(agent, {
    intent: "update",
    table: "household.expenses",
    row: rowOf(taxi),
    ver: taxi.ver,
    set: { amount: 32 },
  });
  await first(other, {
    intent: "update",
    table: "household.expenses",
    row: rowOf(taxi),
    ver: taxi.ver,
    set: { amount: 35 },
  });

  // A reference field, and a premise: the refund rests on the lunch's amount as corrected.
  await first(agent, {
    intent: "insert",
    table: "household.refunds",
    set: { note: "half of lunch", expense: rowOf(lunch) },
    premises: [
      { table: "household.expenses", row: rowOf(lunch), fields: ["amount"], ver: lunchFixed.ver },
    ],
  });

  // State table: a budget, changed from a later day on.
  const budget = (amount: number, from: string) => ({
    intent: "update",
    table: "household.budgets",
    entity_key: { kind: "food" },
    set: { amount },
    valid_from: from,
  });
  await first(agent, budget(5000, "2026-10-01"));
  await first(agent, budget(4000, "2026-11-10"));
  // A write awaiting confirmation: over the change at 11-10, which it would erase (high impact).
  await first(agent, { ...budget(4500, "2026-10-15"), valid_to: "open" });

  // Rows by source key: created, updated by a later sync.
  const ride = (id: string, fare: number) => ({
    intent: "update",
    table: "household.rides",
    external_key: { origin: "app", external_id: id },
    set: { fare },
  });
  await write(agent, [ride("k-1", 10), ride("k-2", 21)]);
  await write(agent, [ride("k-1", 12)]);

  // Reads: the tables as an agent reads them, and one row's history.
  for (const table of ["expenses", "budgets", "rides", "refunds", "spent_by_day"]) {
    await call(at, agent, "POST", "/v1/query", { table: `household.${table}` });
  }
  await call(at, other, "POST", "/v1/history", { table: "household.expenses", row: rowOf(lunch) });

  return expectedOf(at, session);
}

/** The sample's fixed values, read from the service as it is now. */
export async function expectedOf(at: Target, session: string): Promise<SampleExpected> {
  const rows = async (table: string, extra: Json = {}): Promise<Json[]> =>
    (await call(at, session, "POST", "/v1/query", { table: `household.${table}`, ...extra }))[
      "rows"
    ] as Json[];
  const values = (r: Json): Json => (r["values"] ?? r) as Json;
  const expenses: Record<string, { date: string; amount: number | null }> = {};
  for (const r of await rows("expenses")) {
    const v = values(r);
    expenses[String(v["note"])] = {
      date: String(v["date"]),
      amount: v["amount"] === null || v["amount"] === undefined ? null : Number(v["amount"]),
    };
  }
  const rides: Record<string, number> = {};
  for (const r of await rows("rides")) {
    const v = values(r);
    rides[String(v["external_id"])] = Number(v["fare"]);
  }
  const budget: Record<string, number> = {};
  for (const day of ["2026-10-05", "2026-11-15"]) {
    const [r] = await rows("budgets", { valid_at: day });
    if (r !== undefined) budget[day] = Number(values(r)["amount"]);
  }
  const open: Record<string, number> = {};
  const pending = await call(at, session, "GET", "/v1/pending");
  for (const item of (pending["items"] ?? []) as Json[]) {
    const type = String(item["type"]);
    open[type] = (open[type] ?? 0) + 1;
  }
  const reads = ((await call(at, session, "GET", "/v1/reads"))["reads"] ?? []) as unknown[];
  const end = await call(at, session, "GET", "/v1/log/end");
  return {
    storage_format: CURRENT_FORMAT,
    log_end: Number(end["seq"]),
    expenses,
    budget,
    rides,
    open_items: open,
    reads_at_least: reads.length,
  };
}

function tar(args: string[], cwd: string): void {
  const r = spawnSync("tar", args, { cwd, encoding: "utf8" });
  if (r.status !== 0) throw new SampleError(`tar ${args.join(" ")}: ${r.stderr}`);
}

/**
 * Packs a closed local home into `<out>/home.tar.gz`, with `expected.json` beside it. Compressed:
 * a new PGlite data directory is some 45 MB, most of it an empty WAL segment, and 5 MB packed.
 */
export function packLocalSample(home: string, out: string, expected: SampleExpected): void {
  mkdirSync(out, { recursive: true });
  // Not what a run leaves behind: the socket, the pid file, the logs.
  tar(["-czf", join(out, "home.tar.gz"), "--exclude", "./run", "--exclude", "./tmp", "."], home);
  writeFileSync(join(out, "expected.json"), `${JSON.stringify(expected, null, 2)}\n`);
}

/** Unpacks a local sample's home into `to` (not there yet) and returns what it must hold. */
export function unpackLocalSample(sample: string, to: string): SampleExpected {
  mkdirSync(to, { recursive: true, mode: 0o700 });
  tar(["-xzpf", join(sample, "home.tar.gz")], to);
  return JSON.parse(readFileSync(join(sample, "expected.json"), "utf8")) as SampleExpected;
}

/** The formats that have a sample of `mode` in the repository. */
export function sampledFormats(mode: "local" | "server"): number[] {
  const dir = join(REPO, SAMPLES_DIR);
  if (!existsSync(dir)) return [];
  const out: number[] = [];
  for (let f = 1; f <= CURRENT_FORMAT; f++) {
    if (existsSync(join(dir, String(f), mode, "expected.json"))) out.push(f);
  }
  return out;
}

/** What a server sample holds beside its dumps: each tenant's user, credentials and values. */
export interface ServerSampleExpected {
  readonly storage_format: number;
  readonly tenants: readonly {
    /** The local account's name. */
    readonly name: string;
    readonly tenant: string;
    /** The tenant's database, as the control database names it; its dump is `tenant-<database>.sql`. */
    readonly database: string;
    /** A user session issued when the sample was made: it must still be taken. */
    readonly session: string;
    readonly expected: SampleExpected;
  }[];
}

/** Where a PostgreSQL server is, as pg_dump is told. */
export interface DumpFrom {
  readonly host: string;
  readonly port?: number;
  readonly user: string;
  readonly password?: string;
}

/**
 * Dumps a database into `file` as plain SQL with INSERTs: a script any connection can run, without
 * psql and its COPY data. No owners and no privileges: they are the server's, not the data's.
 */
export function dumpDatabase(from: DumpFrom, database: string, file: string): void {
  const r = spawnSync(
    "pg_dump",
    [
      "--format=plain",
      "--inserts",
      "--no-owner",
      "--no-privileges",
      "--host",
      from.host,
      ...(from.port !== undefined ? ["--port", String(from.port)] : []),
      "--username",
      from.user,
      "--file",
      file,
      database,
    ],
    {
      encoding: "utf8",
      env: {
        ...process.env,
        ...(from.password !== undefined ? { PGPASSWORD: from.password } : {}),
      },
    },
  );
  if (r.error !== undefined) throw new SampleError(`pg_dump could not be run: ${r.error.message}`);
  if (r.status !== 0) throw new SampleError(`pg_dump ${database}: ${r.stderr}`);
}

/** A dump as a script for a connection: without psql's own commands (`\restrict` and the like). */
export function dumpScript(file: string): string {
  return readFileSync(file, "utf8")
    .split("\n")
    .filter((line) => !line.startsWith("\\"))
    .join("\n");
}
