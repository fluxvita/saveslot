// The front end of the read-only `sql` operation (docs/zh-CN/spec/03-data-model/11-restricted-sql.md
// «处理步骤» 1–6, context S): the caller's text, its parameters and the slots it can see in; out come
// a typed refusal, or the query as a checked tree with names resolved, `*` expanded and the type
// of each result column. Rewriting the tree to the physical tables, running it and the read record
// (steps 7–9) are not here. Pure: no storage, no clock.
//
// The text is read once: the scanner takes `FOR VALID_TIME` out (its place is kept, so offsets and
// line numbers stay the caller's), the parser reads the rest, the walker (./convert.ts) admits
// only what the whitelist lists for S, and the analysis (./sql-analyze.ts) resolves names and
// checks types. Nothing of the caller's text goes on except through the tree.

import type { SqlReason } from "@fluxvita/saveslot-contract-core";
import { convertQuery, LIMITS } from "./convert.ts";
import { RsqlError, type RsqlStop } from "./errors.ts";
import type { Query, TimeClause, TimeOperand } from "./ir.ts";
import { rsqlParser } from "./load.ts";
import { analyzeQuery, type SqlAnalysis, SqlInvalid, type SqlSlot } from "./sql-analyze.ts";

export type { SqlAnalysis, SqlSlot } from "./sql-analyze.ts";

export interface SqlInput {
  /** The statement as the caller wrote it. */
  readonly sql: string;
  /** `params` of the call: only their number matters here; the values are checked when bound. */
  readonly params: readonly unknown[];
  /** The slots the caller can see, with the tables visible in them. */
  readonly slots: readonly SqlSlot[];
  readonly context: "S";
}

export type SqlError =
  | {
      readonly code: "sql_rejected";
      readonly reason: SqlReason;
      /** Line in the caller's text, from 1. */
      readonly line?: number;
      /** The node, function or logical name; never a physical name. */
      readonly node?: string;
      readonly use?: "history";
      readonly message: string;
      readonly suggestion?: string;
    }
  | {
      readonly code: "invalid_argument";
      readonly reason: "ambiguous_table";
      readonly param: "sql";
      readonly candidates: readonly string[];
      readonly line?: number;
      readonly message: string;
    }
  | {
      readonly code: "invalid_argument";
      readonly reason: "malformed";
      readonly param: "params";
      readonly message: string;
    }
  | {
      readonly code: "invalid_argument";
      readonly reason: "granularity";
      readonly param: "sql";
      readonly line?: number;
      readonly message: string;
    };

export type SqlOutcome =
  | { readonly ok: true; readonly analysis: SqlAnalysis; readonly paramCount: number }
  | { readonly ok: false; readonly error: SqlError };

// --- text ---------------------------------------------------------------------------------------

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Line of a byte offset (parse tree locations and token offsets count bytes). */
function lineOfByte(sql: string, offset: number): number {
  return new TextDecoder().decode(utf8(sql).subarray(0, offset)).split("\n").length;
}

/** Line of a character offset (syntax errors count characters). */
const lineOfChar = (sql: string, offset: number): number =>
  [...sql].slice(0, offset).join("").split("\n").length;

type Tokens = ReturnType<ReturnType<typeof rsqlParser>["scan"]>["tokens"];
type Token = Tokens[number];

const stop = (
  reason: SqlReason,
  loc: number | undefined,
  message: string,
  extra: { node?: string; suggestion?: string } = {},
): RsqlError =>
  new RsqlError({
    kind: "rejected",
    code: "rule_sql_rejected",
    reason,
    ...(loc !== undefined ? { loc } : {}),
    message,
    ...(extra.suggestion !== undefined ? { suggestion: extra.suggestion } : {}),
    ...(extra.node !== undefined ? { node: extra.node } : {}),
  });

function scanWords(sql: string): Token[] | undefined {
  try {
    return rsqlParser()
      .scan(sql)
      .tokens.filter((t) => t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT");
  } catch {
    // Unscannable text: the parser reports it.
    return undefined;
  }
}

/**
 * One statement in the text: something besides white space and comments, and at most one `;`, at
 * its end (11 «语句形状»).
 */
function oneStatement(sql: string, words: readonly Token[] | undefined): void {
  const none = () => stop("not_select", undefined, "a sql query is exactly one SELECT statement");
  // The scanner refuses an empty text outright.
  if (sql.trim() === "") throw none();
  if (words === undefined) return;
  if (words.length === 0) throw none();
  const semis = words.filter((t) => t.text === ";");
  if (semis.length > 1 || (semis.length === 1 && words[words.length - 1] !== semis[0]))
    throw none();
}

const TIME_NEXT = new Set(["as", "from", "between", "all"]);

/** An identifier token as the name it is: a quoted one is itself, an unquoted one is in lower case. */
const identName = (text: string): string =>
  text.startsWith('"') && text.endsWith('"') && text.length >= 2
    ? text.slice(1, -1).replaceAll('""', '"')
    : text.toLowerCase();

/** The time clauses of the text, by the offset of the table name each follows; the text without them. */
interface Taken {
  readonly text: string;
  readonly clauses: ReadonlyMap<number, TimeClause>;
  /** `$n` in the clauses, with where. */
  readonly params: ReadonlyMap<number, number>;
}

/**
 * `FOR VALID_TIME …` and `FOR SYSTEM_TIME` (11 «处理步骤» 2), found by the scanner outside strings
 * and comments: the first is cut out of the text (replaced by white space of the same size, line
 * breaks kept) and remembered with the table name it follows; the second is refused.
 */
function takeTimeClauses(sql: string, words: readonly Token[] | undefined): Taken {
  const clauses = new Map<number, TimeClause>();
  const params = new Map<number, number>();
  if (words === undefined) return { text: sql, clauses, params };
  const bytes = utf8(sql);
  const blank: [number, number][] = [];
  for (let i = 0; i < words.length; i++) {
    const t = words[i] as Token;
    const next = words[i + 1];
    if (t.text.toLowerCase() !== "for" || next === undefined || next.tokenName !== "IDENT")
      continue;
    // `substring(t FOR system_time)` names a column: the clause goes on with AS OF, FROM … TO,
    // BETWEEN … AND or ALL.
    const after = words[i + 2]?.text.toLowerCase();
    if (after === undefined || !TIME_NEXT.has(after)) continue;
    const w = identName(next.text);
    if (w === "system_time") {
      throw stop("system_time", t.start, "record time (FOR SYSTEM_TIME) is not readable in SQL", {
        node: "FOR SYSTEM_TIME",
      });
    }
    if (w !== "valid_time") continue;
    const at = t.start;
    const bad = (what: string, loc: number = at): never => {
      throw stop("node", loc, `FOR VALID_TIME: ${what}`, { node: "FOR VALID_TIME" });
    };
    // The table name before it: `table` or `slot.table`.
    const prev = words[i - 1];
    if (prev === undefined || prev.tokenName !== "IDENT")
      bad("it goes right after the name of a state table");
    const dot = words[i - 2];
    const slotPart = words[i - 3];
    const nameStart =
      dot?.text === "." && slotPart?.tokenName === "IDENT" ? slotPart.start : (prev as Token).start;
    let k = i + 2;
    const operandAt = (): TimeOperand => {
      const o = words[k];
      if (o === undefined) return bad("an operand is missing");
      let base: TimeOperand["base"];
      if (o.tokenName === "PARAM") {
        const n = Number(o.text.slice(1));
        if (!Number.isInteger(n) || n < 1) return bad("not a parameter", o.start);
        if (!params.has(n)) params.set(n, o.start);
        base = { k: "param", n };
        k++;
      } else if (o.tokenName === "SCONST") {
        if (!o.text.startsWith("'") || !o.text.endsWith("'"))
          return bad("a string constant in plain quotes is expected", o.start);
        base = { k: "str", value: o.text.slice(1, -1).replaceAll("''", "'") };
        k++;
      } else if (o.tokenName === "IDENT" && words[k + 1]?.text === "(") {
        const fn = identName(o.text);
        if (fn !== "saveslot_today" && fn !== "saveslot_now") {
          throw stop("function", o.start, `the function ${fn} as an operand of FOR VALID_TIME`, {
            node: fn,
          });
        }
        if (words[k + 2]?.text !== ")")
          return bad("saveslot_today() and saveslot_now() take none", o.start);
        base = { k: fn === "saveslot_today" ? "today" : "now" };
        k += 3;
      } else
        return bad(
          "the operand is $n, a string constant, saveslot_today() or saveslot_now()",
          o.start,
        );
      // Whole days added or taken away.
      let days: number | undefined;
      const sign = words[k]?.text;
      if ((sign === "+" || sign === "-") && words[k + 1]?.tokenName === "ICONST") {
        const n = Number(words[k + 1]?.text);
        if (!Number.isSafeInteger(n) || n > 2 ** 31 - 1) return bad("too many days", o.start);
        days = sign === "-" ? -n : n;
        k += 2;
      } else if (sign === "+" || sign === "-")
        return bad("only a whole number of days can be added", o.start);
      return { base, ...(days !== undefined ? { days } : {}), loc: o.start };
    };
    let clause: TimeClause;
    if (after === "as") {
      if (words[i + 3]?.text.toLowerCase() !== "of") return bad("AS OF is expected");
      k = i + 4;
      clause = { k: "as_of", at: operandAt() };
    } else if (after === "from") {
      k = i + 3;
      const from = operandAt();
      if (words[k]?.text.toLowerCase() !== "to") return bad("FROM … TO is expected");
      k++;
      clause = { k: "during", from, to: operandAt() };
    } else return bad("only AS OF and FROM … TO are allowed");
    if (clauses.has(nameStart)) return bad("two clauses for one table");
    clauses.set(nameStart, clause);
    const last = words[k - 1] as Token;
    blank.push([at, last.end]);
    i = k - 1;
  }
  if (blank.length === 0) return { text: sql, clauses, params };
  const out = new Uint8Array(bytes);
  for (const [from, to] of blank) {
    for (let j = from; j < to; j++) if (out[j] !== 0x0a) out[j] = 0x20;
  }
  return { text: new TextDecoder().decode(out), clauses, params };
}

/** A syntax error: the parser's message and its line. */
class SyntaxFailure extends Error {
  readonly line: number | undefined;
  constructor(message: string, line: number | undefined) {
    super(message);
    this.line = line;
  }
}

// --- errors -------------------------------------------------------------------------------------

function refusal(sql: string, s: RsqlStop): SqlError {
  const line = s.loc !== undefined ? { line: lineOfByte(sql, s.loc) } : {};
  if (s.kind === "rejected") {
    return {
      code: "sql_rejected",
      // The codes of a derived rule are not the query's: only the reason carries over.
      reason: s.reason ?? "node",
      ...line,
      ...(s.node !== undefined ? { node: s.node } : {}),
      ...(s.reason === "system_time" ? { use: "history" as const } : {}),
      message: s.message,
      ...(s.suggestion !== undefined && s.reason !== "system_time"
        ? { suggestion: s.suggestion }
        : {}),
    };
  }
  // Not reached by a query; given as the nearest refusal rather than a crash.
  return { code: "sql_rejected", reason: "node", ...line, message: s.message };
}

function invalid(sql: string, e: SqlInvalid): SqlError {
  const line = e.detail.loc !== undefined ? { line: lineOfByte(sql, e.detail.loc) } : {};
  switch (e.reason) {
    case "ambiguous_table":
      return {
        code: "invalid_argument",
        reason: "ambiguous_table",
        param: "sql",
        candidates: e.detail.candidates ?? [],
        ...line,
        message: e.message,
      };
    case "granularity":
      return {
        code: "invalid_argument",
        reason: "granularity",
        param: "sql",
        ...line,
        message: e.message,
      };
    case "malformed":
      return { code: "invalid_argument", reason: "malformed", param: "params", message: e.message };
  }
}

// --- the entry ----------------------------------------------------------------------------------

/** Steps 1–4: the text read and checked against the whitelist, no names resolved. */
interface Read {
  readonly query: Query;
  /** The parameters `$n` the text uses, with where each first appears. */
  readonly params: ReadonlyMap<number, number>;
  /** The table references written in the text. */
  readonly tableRefs: number;
}

function read(sql: string): Read {
  const parser = rsqlParser();
  // Text is well-formed Unicode: a lone surrogate would not survive printing (11 «处理步骤» 1).
  if (!sql.isWellFormed()) throw stop("syntax", undefined, "the text is not well-formed Unicode");
  // PostgreSQL text cannot hold NUL (the parser reads the text as a C string and would stop at it).
  const nul = sql.indexOf("\0");
  if (nul >= 0) throw new SyntaxFailure("the text contains a NUL character", lineOfChar(sql, nul));
  if (utf8(sql).length > LIMITS.textBytes) {
    throw stop("limit", undefined, `the text is longer than ${LIMITS.textBytes} bytes`);
  }
  const words = scanWords(sql);
  const taken = takeTimeClauses(sql, words);
  oneStatement(sql, words);
  let tree: unknown;
  try {
    tree = parser.parse(taken.text);
  } catch (e) {
    const details = (e as { sqlDetails?: { cursorPosition?: unknown } }).sqlDetails;
    // Anything but a syntax error (the parser running out of stack on deep nesting) is a limit,
    // in fixed words: the engine's message is not passed on.
    if (details === undefined)
      throw stop("limit", undefined, "the text is nested too deeply to parse");
    const pos = details.cursorPosition;
    const message = e instanceof Error ? e.message : "a syntax error";
    throw new SyntaxFailure(
      message,
      typeof pos === "number" && pos >= 0 ? lineOfChar(taken.text, pos) : undefined,
    );
  }
  const { query, facts } = convertQuery(tree, { timeClauses: taken.clauses });
  const [lost] = facts.unattached;
  if (lost !== undefined) {
    throw stop("node", lost, "FOR VALID_TIME: it goes right after the name of a state table", {
      node: "FOR VALID_TIME",
    });
  }
  return {
    query,
    params: new Map([...facts.params, ...taken.params]),
    tableRefs: facts.tableRefs,
  };
}

/** `$1 … $n`, from `$1` on without gaps, as many as `params` has (11 «名字» 参数). */
function checkParams(used: ReadonlyMap<number, number>, given: number): number {
  const n = used.size === 0 ? 0 : Math.max(...used.keys());
  if (n > LIMITS.params) throw stop("limit", used.get(n), `a parameter above $${LIMITS.params}`);
  for (let i = 1; i <= n; i++) {
    if (!used.has(i)) {
      throw new SqlInvalid(
        "malformed",
        `the parameters are not numbered from $1 without gaps ($${i} is missing)`,
        { param: "params" },
      );
    }
  }
  if (n !== given) {
    throw new SqlInvalid("malformed", `the statement has ${n} parameters, params has ${given}`, {
      param: "params",
    });
  }
  return n;
}

function failure(sql: string, e: unknown): SqlOutcome {
  if (e instanceof SqlInvalid) return { ok: false, error: invalid(sql, e) };
  if (e instanceof SyntaxFailure) {
    return {
      ok: false,
      error: {
        code: "sql_rejected",
        reason: "syntax",
        ...(e.line !== undefined ? { line: e.line } : {}),
        message: e.message,
      },
    };
  }
  if (e instanceof RsqlError) return { ok: false, error: refusal(sql, e.stop) };
  throw e;
}

/**
 * Steps 1–4 of 11 «处理步骤» alone: the text against the whitelist for S, offline (no slots, no
 * names). The query as a tree, or the refusal. For tests of the whitelist and of printing.
 */
export function readSql(
  sql: string,
):
  | { readonly ok: true; readonly query: Query; readonly params: ReadonlyMap<number, number> }
  | { readonly ok: false; readonly error: SqlError } {
  rsqlParser();
  try {
    return { ok: true, ...read(sql) };
  } catch (e) {
    const f = failure(sql, e);
    if (f.ok) throw e;
    return f;
  }
}

/**
 * Steps 1–6 of 11 «处理步骤» for a `sql` query: the text checked against the whitelist for S, its
 * names resolved against `slots`, its types and units checked. Throws when loadRsql() has not
 * completed; every problem of the query itself is in the result.
 */
export function checkSql(input: SqlInput): SqlOutcome {
  rsqlParser();
  try {
    const { query, params, tableRefs } = read(input.sql);
    const paramCount = checkParams(params, input.params.length);
    const analysis = analyzeQuery({ query, slots: input.slots, paramLocs: params, tableRefs });
    return { ok: true, analysis, paramCount };
  } catch (e) {
    return failure(input.sql, e);
  }
}
