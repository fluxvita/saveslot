// `sql` (docs/zh-CN/spec/04-contract.md §10 `sql`; 04-contract-types.md §4.4; 03-data-model/
// 11-restricted-sql.md): the caller's statement checked and bound (rules/rsql `checkSql`), rewritten to
// the physical tables and run in the caller's read transaction, the rows given back as an array per
// row; and the read as `audit` records it (02-integrity-and-records «读取记录»; 04-write-and-read
// «读取记录里记什么形状», «记多少条»).
//
// Not here: the surfaces (contract, service, HTTP, MCP, client and CLI). The cursor of the contract
// is `position` here, unsigned: the service layer wraps it.
//
// The session. A statement of the caller runs with `standard_conforming_strings = on` (the printed
// string literals leave a backslash alone), `search_path = pg_catalog` (functions are printed
// without a schema, tables with theirs), and on a backend that has one, a `statement_timeout`.
// They are set for the transaction (`SET LOCAL`) and put back before the read record is worked out,
// which reads the kernel's own tables by the search path they are kept under.
//
// What is recorded as read. For each base table of the query, a superset of the rows the query read
// of it: the rows its own level (the FROM and WHERE it is written in) lets through, whatever the
// grouping, HAVING, ORDER BY, DISTINCT and LIMIT above it do, taken in this same transaction. Up to
// 1,000 rows are recorded one by one; more than that, or a level that cannot run alone (a subquery
// that reads the outer query's columns), is one record of the table. A superset only makes an
// impact query say "possibly affected" more often, never less.

import type {
  CompiledBaseTable,
  CompiledSchema,
  FieldId,
  Instant,
  ItemId,
  SlotId,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import type { ReadEntry, ReadRow, ReadValid } from "../audit/index.ts";
import {
  canonical,
  get,
  has,
  instantText,
  isObj,
  keysOf,
  parseDateTime,
  rationalOf,
} from "../request/index.ts";
import {
  checkSql,
  type FormerNames,
  fingerprintOf,
  IDENTITY_CAP,
  type OutputColumn,
  rewriteSql,
  type SqlError,
  SqlNotImplemented,
  SqlRuntime,
  type SqlSlot,
  type SqlWarning,
  type Statement,
  type TableRead,
} from "../rules/index.ts";
import { type ReadTx, type SqlValue, sqlStateOf } from "../store/ports.ts";
import { digest } from "./page.ts";
import { logPosition, readFlagsOf, readTableFlags, restoreCount, rowFacts } from "./select.ts";
import { type Visibility, visibleSlots } from "./slots.ts";
import { callOf, convertParam, type Scalar } from "./sql-values.ts";
import { type InputMarks, invalid, notImplemented, ReadError, type ReadWarning } from "./types.ts";

/**
 * How long a statement of the caller may run, on a backend that enforces it (PostgreSQL's
 * `statement_timeout`; PGlite has none): a first value, until experiments 2 and 4 set it
 * (08-open-questions). Not a configuration key: a call can be given another by its caller.
 */
export const SQL_TIMEOUT_MS = 10_000;

export const SQL_DEFAULT_ROWS = 100;
export const SQL_MAX_ROWS = 1_000;

/** The most rows of a table recorded one by one; more are a record of the table. */
export const READ_ROWS_THRESHOLD = 1_000;

const SQL_KEYS: ReadonlySet<string> = new Set([
  "sql",
  "params",
  "max_rows",
  "at",
  "position",
  "task",
]);

export interface SqlInput {
  readonly actor: ReadEntry["actor"];
  readonly task: string | null;
  /** The entry instant: the evaluation time when the call gives no `at`. */
  readonly now: Instant;
  readonly visibility: Visibility;
  readonly params: unknown;
  readonly read: ReadEntry["read"];
  /** The statement timeout in milliseconds, on a backend that enforces one; none when undefined. */
  readonly timeoutMs?: number;
  /** The clock of the call's one deadline, in milliseconds; the process's by default (tests inject one). */
  readonly clock?: () => number;
  /**
   * Where the database's own error goes when a statement fails: a local log, never the caller. The
   * default writes it to the process's standard error.
   */
  readonly onDatabaseError?: (e: unknown) => void;
}

export interface SqlColumn {
  readonly name: string;
  readonly type: OutputColumn["type"];
  readonly unit?: string;
}

/** §4.4 `SqlResult`, the part the kernel gives. */
export interface SqlReadResult {
  /** The schema version of each slot the query reads, by the slot's name. */
  readonly sv: Readonly<Record<string, number>>;
  readonly columns: readonly SqlColumn[];
  /** One array per row, in the order of `columns`: quantities and decimals as decimal text. */
  readonly rows: readonly (readonly (string | number | boolean | null)[])[];
  /** The next page's position, unsigned (the service layer wraps it as `next_cursor`). */
  readonly next_position?: string;
  readonly warnings?: readonly (ReadWarning | SqlWarning)[];
  readonly marks_summary?: InputMarks;
}

export interface SqlOutput {
  readonly result: SqlReadResult;
  /** The read to record. */
  readonly entry: ReadEntry;
}

// --- errors -------------------------------------------------------------------------------------

/** A refusal of the statement as the error the caller gets. */
function refused(e: SqlError): ReadError {
  if (e.code === "sql_rejected") {
    return new ReadError("sql_rejected", e.message, {
      reason: e.reason,
      ...(e.line !== undefined ? { line: e.line } : {}),
      ...(e.node !== undefined ? { node: e.node } : {}),
      ...(e.use !== undefined ? { use: e.use } : {}),
      ...(e.suggestion !== undefined ? { suggestion: e.suggestion } : {}),
    });
  }
  return new ReadError("invalid_argument", e.message, {
    reason: e.reason,
    param: e.param,
    ...("candidates" in e ? { candidates: e.candidates } : {}),
    ...("line" in e && e.line !== undefined ? { line: e.line } : {}),
  });
}

/** The default log: the process's standard error. */
function logDatabaseError(e: unknown): void {
  console.error("sql: the database refused a statement:", e);
}

/** Our own words for the data errors the caller can cause, by SQLSTATE. */
const RUNTIME_WORDS: Readonly<Record<string, string>> = {
  "22003": "a number is out of range",
  "22012": "division by zero",
  "22008": "a date or time is out of range",
  "21000": "a subquery used as a value returned more than one row",
};

/**
 * What a failed statement is to the caller. Whatever the database says, the caller gets `sql_rejected`
 * (or `sql_timeout`) in words of ours: the database's text names generated aliases and internals, so it
 * goes to the log (`log`) and nowhere else. By SQLSTATE: a data error (class 22) and a scalar subquery
 * of several rows (21000) are `runtime`; any other refusal is also `runtime`, the contract's reason
 * for a query that was accepted and failed as it ran. An error that is no refusal of a statement (no
 * SQLSTATE, not a failed query: a lost connection) is not the caller's and is passed on as it is.
 */
function failed(e: unknown, elapsed: number, log: (e: unknown) => void): Error {
  const state = sqlStateOf(e);
  const refusedQuery = (e as { code?: unknown } | null)?.code === "query_failed";
  if (state === undefined && !refusedQuery) return e instanceof Error ? e : new Error(String(e));
  log(e);
  if (state === "57014") {
    return new ReadError("sql_timeout", "the query ran past its time limit", {
      elapsed_ms: Math.round(elapsed),
    });
  }
  const words =
    state !== undefined && RUNTIME_WORDS[state] !== undefined
      ? RUNTIME_WORDS[state]
      : state?.startsWith("22") === true
        ? "a value is out of range or not valid"
        : "the database refused the query";
  return new ReadError("sql_rejected", words as string, { reason: "runtime" });
}

// --- the position of a later page ---------------------------------------------------------------

interface Position {
  readonly seq: number;
  readonly at: Instant;
  readonly restoreCount: number;
  readonly offset: number;
}

function encodePosition(identity: string, p: Position): string {
  return Buffer.from(
    JSON.stringify({ v: 1, q: identity, s: p.seq, t: p.at, r: p.restoreCount, o: p.offset }),
    "utf8",
  ).toString("base64url");
}

function decodePosition(
  text: string,
  check: { identity: string; restoreCount: number; latest: number },
): Position {
  const bad = () => invalid("malformed", "position");
  if (!/^[A-Za-z0-9_-]+$/.test(text) || text.length > 4096) throw bad();
  let o: unknown;
  try {
    o = JSON.parse(Buffer.from(text, "base64url").toString("utf8"));
  } catch {
    throw bad();
  }
  if (!isObj(o) || [...keysOf(o)].sort().join(",") !== "o,q,r,s,t,v" || get(o, "v") !== 1)
    throw bad();
  const seq = get(o, "s");
  const at = get(o, "t");
  const r = get(o, "r");
  const offset = get(o, "o");
  if (get(o, "q") !== check.identity) throw bad();
  if (typeof seq !== "number" || !Number.isSafeInteger(seq) || seq < 0 || seq > check.latest)
    throw bad();
  if (typeof at !== "string" || !/^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\d\.\d{3}Z$/.test(at)) throw bad();
  if (typeof r !== "number" || !Number.isSafeInteger(r) || r < 0) throw bad();
  if (typeof offset !== "number" || !Number.isSafeInteger(offset) || offset < 1) throw bad();
  if (r !== check.restoreCount) {
    throw new ReadError("handle_expired", "the position is from before a restore", {
      reason: "restored",
      param: "position",
    });
  }
  // The statement reads the tables as they are now: it cannot read them as they were after the
  // first page's operation, so a write since makes the later pages another result.
  if (seq !== check.latest) {
    throw new ReadError("handle_expired", "the data changed since the first page was read", {
      reason: "expired",
      param: "position",
    });
  }
  return { seq, at: at as Instant, restoreCount: r, offset };
}

// --- former names -------------------------------------------------------------------------------

/** Names the visible tables and fields had in the last 10 schema versions (11 «名字»). */
async function formerNamesOf(
  tx: ReadTx,
  slots: readonly {
    readonly slot: SlotId;
    readonly sv: number;
    readonly tables: SqlSlot["tables"];
  }[],
): Promise<Map<string, NonNullable<SqlSlot["formerNames"]>>> {
  const out = new Map<string, NonNullable<SqlSlot["formerNames"]>>();
  if (slots.length === 0) return out;
  const r = await tx.query<{ slot_id: string; body: string | null }>(
    `SELECT v.slot_id, c.body FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'
     WHERE v.slot_id = ANY($1) AND v.state = 'retired'
     ORDER BY v.slot_id, v.sv DESC`,
    [slots.map((s) => s.slot)] as never,
  );
  const per = new Map<string, CompiledSchema[]>();
  for (const x of r.rows) {
    if (x.body === null) continue;
    const old = JSON.parse(x.body) as CompiledSchema;
    per.set(x.slot_id, [...(per.get(x.slot_id) ?? []), old]);
  }
  for (const s of slots) {
    const tables: { name: string; table: TableId }[] = [];
    const fields: { table: TableId; name: string; field: FieldId }[] = [];
    const recent = (per.get(s.slot) ?? []).filter((o) => o.sv >= s.sv - 10);
    for (const old of recent) {
      for (const ot of old.tables) {
        const now = s.tables.find((t) => t.id === ot.id);
        if (now === undefined) continue;
        if (ot.name !== now.name) tables.push({ name: ot.name, table: now.id as TableId });
        for (const of of ot.fields) {
          const nf = (now.fields as readonly { id: string; name: string }[]).find(
            (f) => f.id === of.id,
          );
          if (nf !== undefined && nf.name !== of.name)
            fields.push({ table: now.id as TableId, name: of.name, field: of.id as FieldId });
        }
      }
    }
    if (tables.length > 0 || fields.length > 0) out.set(s.slot, { tables, fields });
  }
  return out;
}

// --- the cells of a row -------------------------------------------------------------------------

type Cell = string | number | boolean | null;

const TIMESTAMPTZ = /^(\d{4}-\d\d-\d\d) (\d\d:\d\d:\d\d)(\.\d+)?\+00$/;

const DATE_TEXT = /^\d{4}-\d\d-\d\d$/;
/** A year before 0001 (`… BC`) or after 9999 (five digits), which PostgreSQL computes and the contract has no form for. */
const OUT_OF_YEARS = /^\d{5,}-\d\d-\d\d| BC$/;
const outOfRange = () =>
  new ReadError("sql_rejected", "a date is out of range (0001-01-01 to 9999-12-31)", {
    reason: "runtime",
  });

/** One cell as the contract gives it, from the text the database gave (a boolean as it is). */
function cellOf(type: OutputColumn["type"], v: unknown): Cell {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v;
  const text = String(v);
  switch (type) {
    case "integer":
    case "decimal":
    case "quantity":
      return canonical(rationalOf(text));
    case "date":
      if (!DATE_TEXT.test(text) || text.startsWith("0000")) throw outOfRange();
      return text;
    case "unknown": {
      // A time stamp is an instant in the event format's form; anything else is text.
      if (OUT_OF_YEARS.test(text)) throw outOfRange();
      const m = TIMESTAMPTZ.exec(text);
      return m === null ? text : instantText(Date.parse(`${m[1]}T${m[2]}${m[3] ?? ""}Z`));
    }
    default:
      return text;
  }
}

/** The page of the statement: every column as text (a boolean as it is), `limit` rows from `offset`. */
function pageOf(main: Statement, columns: readonly OutputColumn[], offset: number, limit: number) {
  const cols = columns.map((c, i) =>
    c.type === "boolean" ? `"p"."c${i + 1}"` : `CAST("p"."c${i + 1}" AS text) AS "c${i + 1}"`,
  );
  return {
    text: `SELECT ${cols.join(", ")} FROM (${main.text}) AS "p" OFFSET ${offset} LIMIT ${limit}`,
    params: main.params,
  };
}

// --- the read record ----------------------------------------------------------------------------

interface Recorded {
  readonly rows: ReadRow[];
  readonly coarse: TableId[];
  readonly marks: InputMarks;
}

/** The identities each statement gives, run in the read transaction: undefined for more than the cap. */
async function identitiesOf(
  tx: ReadTx,
  t: TableRead,
  arm: () => Promise<void>,
): Promise<string[] | undefined> {
  const ids = new Set<string>();
  for (const s of t.refs) {
    if (s === undefined) return undefined;
    await arm();
    const r = await tx.query<{ id: string | null }>(s.text, s.params);
    // The null-extended side of an outer join has no row: nothing was read of it.
    for (const x of r.rows) if (x.id !== null) ids.add(String(x.id));
    if (r.rows.length >= IDENTITY_CAP || ids.size > READ_ROWS_THRESHOLD) return undefined;
  }
  return [...ids];
}

async function recordedOf(
  tx: ReadTx,
  tables: readonly TableRead[],
  restore: number,
  identities: ReadonlyMap<string, string[] | undefined>,
): Promise<Recorded> {
  const rows: ReadRow[] = [];
  const coarse: TableId[] = [];
  const flagged = {
    disputed: new Set<string>(),
    awaiting: new Set<string>(),
    flagged: new Set<string>(),
  };
  const items = new Set<ItemId>();
  const mark = (table: string, row: string, flags: readonly { flag: string; item: ItemId }[]) => {
    for (const f of flags) {
      if (f.flag === "disputed" || f.flag === "awaiting" || f.flag === "flagged") {
        flagged[f.flag].add(`${table}/${row}`);
        items.add(f.item);
      }
    }
  };
  for (const t of tables) {
    const id = t.table.id as TableId;
    const ids = identities.get(`${t.slot}/${t.table.id}`);
    if (ids === undefined) {
      coarse.push(id);
      if (t.table.kind === "base") {
        for (const [row, flags] of await readTableFlags(tx, id)) mark(id, row, flags);
      }
      continue;
    }
    if (t.table.kind === "derived") {
      for (const target of ids) rows.push({ table: id, target });
      continue;
    }
    const facts = await rowFacts(tx, t.table as CompiledBaseTable, ids);
    for (const target of ids) {
      const op = facts.ver.get(target);
      rows.push({
        table: id,
        target,
        ...(op !== undefined ? { ver: { op: op as never, restoreCount: restore } } : {}),
      });
    }
    for (const [row, flags] of await readFlagsOf(tx, id, ids)) mark(id, row, flags);
  }
  return {
    rows,
    coarse,
    marks: {
      disputed: flagged.disputed.size,
      awaiting: flagged.awaiting.size,
      flagged: flagged.flagged.size,
      premise_changed: 0,
      items: [...items].sort().slice(0, 10),
    },
  };
}

/**
 * The business time a read is recorded with: the one condition all its state table references
 * share (a point, or a stretch), none when they differ, where the impact query then reads it as
 * the whole time (more reports, never fewer).
 */
function validOf(times: readonly { readonly read: ReadValid }[]): ReadValid | undefined {
  const [first] = times;
  if (first === undefined) return undefined;
  const same = times.every((t) => JSON.stringify(t.read) === JSON.stringify(first.read));
  return same ? first.read : undefined;
}

// --- the operation ------------------------------------------------------------------------------

/** Field-level visibility is not in this version: a call carrying it is refused before anything runs. */
function refuseFieldLevel(v: Visibility): void {
  if (v.kind === "scoped" && v.slots.some((s) => s.tables?.some((t) => t.fields !== undefined))) {
    throw new ReadError("internal", "visibility by field is not implemented", {
      reason: "not_implemented",
    });
  }
}

export async function sqlInTx(tx: ReadTx, input: SqlInput): Promise<SqlOutput> {
  const begun = (input.clock ?? (() => performance.now()))();
  const params = input.params;
  if (!isObj(params)) throw invalid("malformed", "");
  refuseFieldLevel(input.visibility);
  for (const k of keysOf(params)) if (!SQL_KEYS.has(k)) throw invalid("malformed", k);

  // The call's own values, before anything is read.
  const sql = get(params, "sql");
  if (sql === undefined) throw invalid("missing", "sql");
  if (typeof sql !== "string") throw invalid("malformed", "sql");
  let values: Scalar[] = [];
  if (has(params, "params")) {
    const v = get(params, "params");
    if (!Array.isArray(v)) throw invalid("malformed", "params");
    v.forEach((x, i) => {
      if (x !== null && typeof x !== "string" && typeof x !== "number" && typeof x !== "boolean")
        throw invalid("malformed", `params/${i}`);
    });
    values = v as Scalar[];
  }
  let rowsPerPage = SQL_DEFAULT_ROWS;
  if (has(params, "max_rows")) {
    const n = get(params, "max_rows");
    if (typeof n !== "number" || !Number.isInteger(n) || n < 1 || n > SQL_MAX_ROWS)
      throw invalid("malformed", "max_rows");
    rowsPerPage = n;
  }
  let task = input.task;
  if (has(params, "task")) {
    const v = get(params, "task");
    // As for the other reads.
    if (typeof v !== "string" || v === "" || !v.isWellFormed() || [...v].length > 256)
      throw invalid("malformed", "task");
    task = v;
  }
  let at: Instant = input.now;
  const atGiven = has(params, "at");
  if (atGiven) {
    const v = get(params, "at");
    const p = typeof v === "string" ? parseDateTime(v, "UTC", false) : undefined;
    if (p === undefined || !p.ok || p.assumed) throw invalid("malformed", "at");
    at = instantText(p.epochMs);
  }

  // The names the call can see, and the statement bound against them.
  const visible = await visibleSlots(tx, input.visibility);
  const former = await formerNamesOf(tx, visible);
  const slots: SqlSlot[] = visible.map((s) => ({
    slot: s.slot,
    name: s.name,
    timezone: s.timezone,
    sv: s.sv,
    tables: s.tables,
    ...(former.has(s.slot) ? { formerNames: former.get(s.slot) as FormerNames } : {}),
  }));
  const checked = checkSql({ sql, params: values, slots, context: "S" });
  if (!checked.ok) throw refused(checked.error);
  const { analysis } = checked;

  // The page asked for: its position fixes the evaluation time of the first page.
  const restore = await restoreCount(tx);
  const latest = await logPosition(tx);
  const identity = digest({ sql, params: values, at: atGiven ? at : null });
  const position = has(params, "position")
    ? decodePosition(String(get(params, "position")), { identity, restoreCount: restore, latest })
    : undefined;
  if (position !== undefined && !atGiven) at = position.at;
  const offset = position === undefined ? 0 : position.offset;

  // The values of `$n`, converted by the type each was found to have.
  const converted = new Map<number, SqlValue>();
  for (const [n, t] of analysis.params)
    converted.set(n, convertParam(values[n - 1] as Scalar, t, n - 1));
  const warnings: ReadWarning[] = [];
  const call = callOf(at, (n) => converted.get(n) as SqlValue, warnings);
  let rewritten: ReturnType<typeof rewriteSql>;
  try {
    rewritten = rewriteSql({ analysis, slots, call });
  } catch (e) {
    if (e instanceof SqlNotImplemented) throw notImplemented("sql", e.message);
    if (e instanceof SqlRuntime)
      throw new ReadError("sql_rejected", e.message, { reason: "runtime" });
    throw e;
  }

  // The session, then the statement.
  const saved = (await tx.query<{ search_path: string }>("SHOW search_path")).rows[0]?.search_path;
  if (saved === undefined) throw new Error("the search path is not readable");
  await tx.query("SET LOCAL standard_conforming_strings = on");
  await tx.query("SET LOCAL search_path = pg_catalog");
  if (input.timeoutMs !== undefined) {
    if (!Number.isSafeInteger(input.timeoutMs) || input.timeoutMs < 1)
      throw new Error("a statement timeout is a whole number of milliseconds");
  }
  // One deadline for the whole call: each statement gets what is left of it, not a limit of its own.
  const clock = input.clock ?? (() => performance.now());
  const arm = async (): Promise<void> => {
    if (input.timeoutMs === undefined) return;
    const left = input.timeoutMs - (clock() - begun);
    if (left < 1) {
      throw new ReadError("sql_timeout", "the query ran past its time limit", {
        elapsed_ms: Math.round(clock() - begun),
      });
    }
    await tx.query(`SET LOCAL statement_timeout = ${Math.floor(left)}`);
  };
  await arm();
  const page = pageOf(rewritten.main, analysis.columns, offset, rowsPerPage + 1);
  let fetched: readonly Record<string, unknown>[];
  const identities = new Map<string, string[] | undefined>();
  try {
    fetched = (await tx.query<Record<string, unknown>>(page.text, page.params)).rows;
    // What the statement read, from the same state: one statement of each table's level.
    for (const t of rewritten.tables)
      identities.set(`${t.slot}/${t.table.id}`, await identitiesOf(tx, t, arm));
  } catch (e) {
    if (e instanceof ReadError) throw e;
    throw failed(e, clock() - begun, input.onDatabaseError ?? logDatabaseError);
  }
  await tx.query("SELECT set_config('search_path', $1, true)", [saved]);

  const shown = fetched.slice(0, rowsPerPage);
  const result: SqlReadResult = {
    sv: Object.fromEntries([...analysis.slots.values()].map((s) => [s.name, s.sv])),
    columns: analysis.columns,
    rows: shown.map((r) => analysis.columns.map((c, i) => cellOf(c.type, r[`c${i + 1}`]))),
    ...(fetched.length > rowsPerPage
      ? {
          next_position: encodePosition(identity, {
            seq: position?.seq ?? latest,
            at,
            restoreCount: restore,
            offset: offset + rowsPerPage,
          }),
        }
      : {}),
  };

  const recorded = await recordedOf(tx, rewritten.tables, restore, identities);
  const outWarnings = [
    ...analysis.warnings,
    ...new Map(warnings.map((w) => [JSON.stringify(w), w])).values(),
  ];
  const valid = validOf(rewritten.times);
  const slotsRead = [...analysis.slots];
  const only = slotsRead.length === 1 ? slotsRead[0] : undefined;
  const entry: ReadEntry = {
    read: input.read,
    actor: input.actor,
    task,
    at: input.now,
    // The state read: a later page's is the first page's.
    pos: (position?.seq ?? latest) as never,
    operation: "sql",
    ...(only !== undefined ? { slot: only[0] as SlotId, sv: only[1].sv } : {}),
    ...(rewritten.tables.length === 1
      ? { table: (rewritten.tables[0] as TableRead).table.id as TableId }
      : {}),
    shape: fingerprintOf(analysis),
    ...(valid !== undefined ? { valid } : {}),
    rows: recorded.rows,
    coarse: recorded.coarse,
    // `sql` is no read of a row's version for the fallback, only of the slot's `sv`.
    lastRead: slotsRead.map(([slot, s]) => ({
      kind: "sv" as const,
      target: slot,
      op: s.sv,
      restoreCount: 0,
    })),
  };
  return {
    result: {
      ...result,
      ...(outWarnings.length > 0 ? { warnings: outWarnings } : {}),
      marks_summary: recorded.marks,
    },
    entry,
  };
}
