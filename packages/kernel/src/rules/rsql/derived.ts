// Compiling a derived rule's restricted SQL (docs/zh-CN/spec/03-data-model/11-restricted-sql.md
// «处理步骤» 1–6 for derived rules; 06-derived.md): the rule's ID-bound text, dependencies,
// recompute scope and time dependency (09-event-format §7 `rule`), and the inferred types, units and
// precision of the derived table's fields. Pure: no storage, no events, no evaluation.
//
// This version compiles rules over one base table whose outermost level is an aggregate; other
// whitelisted forms stop as not implemented. The rule ID and version are the schema compiler's.

import type {
  CompiledBaseTable,
  FieldId,
  TableId,
  TimeDependency,
} from "@fluxvita/saveslot-contract-core";
import { type Analysis, analyze, type DeclaredField, type DerivedFieldResult } from "./analyze.ts";
import { convertRule, LIMITS } from "./convert.ts";
import { RsqlError, type RsqlStop, type RuleDetailCode, type SqlReason } from "./errors.ts";
import type { RuleStatement } from "./ir.ts";
import { rsqlParser } from "./load.ts";
import { printRule } from "./print.ts";
import { RSQL_VERSION } from "./whitelist.ts";

export type { DeclaredField, DerivedFieldResult } from "./analyze.ts";

export interface DerivedRuleInput {
  /** The rule's restricted SQL as the document gives it. */
  readonly sql: string;
  readonly declaredTimeDependency: TimeDependency;
  /** The derived table's fields, in document order; field `i` gets ID `f<i+1>`. */
  readonly fields: readonly DeclaredField[];
  readonly slot: { readonly name: string };
  /** The slot's base tables, with IDs. */
  readonly tables: readonly CompiledBaseTable[];
  /** The slot's derived table names: reading one is not compiled yet. */
  readonly derivedTables?: readonly string[];
  /** Where the rule is in the document, for details: `tables/<i>/rule/sql`. */
  readonly path: string;
}

export interface RuleDetail {
  readonly path: string;
  readonly code: RuleDetailCode;
  /** Line in the rule text, from 1. */
  readonly line?: number;
  readonly sql_reason?: SqlReason;
  readonly suggestion?: string;
  /** For people: logical names, node and function names only. */
  readonly message: string;
}

export interface CompiledRuleParts {
  /** ID-bound text (09 §7 `rule.sql`). */
  readonly sql: string;
  readonly rsql: string;
  readonly time_dependency: TimeDependency;
  readonly depends_on: readonly { readonly table: TableId; readonly field: FieldId }[];
  readonly scope:
    | {
        readonly kind: "group";
        readonly key: readonly FieldId[];
        readonly key_from_free_text: boolean;
      }
    | { readonly kind: "tenant" };
}

export type DerivedRuleResult =
  | {
      readonly ok: true;
      readonly rule: CompiledRuleParts;
      /** The derived fields, in document order. */
      readonly fields: readonly DerivedFieldResult[];
    }
  | {
      readonly ok: false;
      readonly error:
        | { readonly code: "validation_failed"; readonly details: readonly [RuleDetail] }
        | { readonly code: "not_in_this_version"; readonly param: string; readonly message: string }
        | { readonly code: "not_implemented"; readonly what: string; readonly param: string };
    };

/** Line of a byte offset (parse tree locations count bytes). */
function lineOfByte(sql: string, offset: number): number {
  const before = new TextDecoder().decode(utf8(sql).subarray(0, offset));
  return before.split("\n").length;
}

const utf8 = (s: string) => new TextEncoder().encode(s);

/** Line of a character offset (syntax errors count characters). */
function lineOfChar(sql: string, offset: number): number {
  return [...sql].slice(0, offset).join("").split("\n").length;
}

const TIME_CLAUSE_NEXT = new Set(["as", "from", "between", "all"]);

/** `FOR VALID_TIME` / `FOR SYSTEM_TIME` (11 «处理步骤» 2), found by the scanner outside strings and comments. Token offsets count bytes. */
function timeClause(sql: string): void {
  let tokens: ReturnType<ReturnType<typeof rsqlParser>["scan"]>["tokens"];
  try {
    tokens = rsqlParser().scan(sql).tokens;
  } catch {
    // Unscannable text: the parser reports it.
    return;
  }
  const words = tokens.filter((t) => t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT");
  words.forEach((t, i) => {
    const next = words[i + 1];
    if (t.text.toLowerCase() !== "for" || next === undefined || next.tokenName !== "IDENT") return;
    // The clause goes on with AS OF, FROM … TO, BETWEEN … AND or ALL; `substring(t FOR
    // system_time)` names a column.
    const after = words[i + 2]?.text.toLowerCase();
    if (after === undefined || !TIME_CLAUSE_NEXT.has(after)) return;
    const w = next.text.toLowerCase();
    if (w === "system_time") {
      throw new RsqlError({
        kind: "rejected",
        code: "rule_sql_rejected",
        reason: "system_time",
        loc: t.start,
        message: "record time (FOR SYSTEM_TIME) is not readable in SQL",
      });
    }
    if (w === "valid_time") {
      throw new RsqlError({
        kind: "not_implemented",
        loc: t.start,
        message: "FOR VALID_TIME in a derived rule is not compiled yet",
      });
    }
  });
}

const notSelect = (): never => {
  throw new RsqlError({
    kind: "rejected",
    code: "rule_sql_rejected",
    reason: "not_select",
    message: "a derived rule is exactly one SELECT statement",
  });
};

/**
 * One statement in the text: something besides white space and comments, and at most one `;`,
 * at its end (11 «语句形状»).
 */
function oneStatement(sql: string): void {
  // The scanner refuses an empty text outright.
  if (sql.trim() === "") notSelect();
  let tokens: ReturnType<ReturnType<typeof rsqlParser>["scan"]>["tokens"];
  try {
    tokens = rsqlParser().scan(sql).tokens;
  } catch {
    // Unscannable text: the parser reports it.
    return;
  }
  const words = tokens.filter((t) => t.tokenName !== "SQL_COMMENT" && t.tokenName !== "C_COMMENT");
  if (words.length === 0) notSelect();
  const semis = words.filter((t) => t.text === ";");
  if (semis.length > 1 || (semis.length === 1 && words[words.length - 1] !== semis[0])) notSelect();
}

export interface Checked {
  readonly stmt: RuleStatement;
  readonly analysis: Analysis;
}

function check(sql: string, input: DerivedRuleInput, naming: "names" | "ids"): Checked {
  const parser = rsqlParser();
  // Text is well-formed Unicode: a lone surrogate would not survive printing (11 «处理步骤» 1).
  if (!sql.isWellFormed()) {
    throw new RsqlError({
      kind: "rejected",
      code: "rule_sql_rejected",
      reason: "syntax",
      message: "the rule is not well-formed Unicode text",
    });
  }
  if (utf8(sql).length > LIMITS.textBytes) {
    throw new RsqlError({
      kind: "rejected",
      code: "rule_sql_rejected",
      reason: "limit",
      message: `the rule is longer than ${LIMITS.textBytes} bytes`,
    });
  }
  timeClause(sql);
  oneStatement(sql);
  let tree: unknown;
  try {
    tree = parser.parse(sql);
  } catch (e) {
    const details = (e as { sqlDetails?: { cursorPosition?: unknown } }).sqlDetails;
    // Anything but a syntax error (the parser running out of stack on deep nesting) is a limit,
    // reported in fixed words: the engine's message is not passed on.
    if (details === undefined) {
      throw new RsqlError({
        kind: "rejected",
        code: "rule_sql_rejected",
        reason: "limit",
        message: "the rule is nested too deeply to parse",
      });
    }
    const pos = details.cursorPosition;
    const message = e instanceof Error ? e.message : "a syntax error";
    throw new SyntaxRuleError(
      message,
      typeof pos === "number" && pos >= 0 ? lineOfChar(sql, pos) : undefined,
    );
  }
  const stmt = convertRule(tree);
  const analysis = analyze(stmt, {
    slot: input.slot.name,
    tables: input.tables,
    derivedTables: input.derivedTables ?? [],
    fields: input.fields,
    declaredTimeDependency: input.declaredTimeDependency,
    naming,
  });
  return { stmt, analysis };
}

/** A syntax error: the parser's message, its line. */
class SyntaxRuleError extends Error {
  readonly line: number | undefined;
  constructor(message: string, line: number | undefined) {
    super(message);
    this.line = line;
  }
}

function result(c: Checked): DerivedRuleResult {
  const { stmt, analysis: a } = c;
  const outputs = a.outputs.map((i): FieldId => `f${i + 1}`);
  const bound = printRule(stmt, {
    table: a.table.id,
    column: (e) => {
      const col = a.columnOf(e);
      return col.kind === "field"
        ? col.field.id
        : (col.name as "row_id" | "entity_id" | "valid_from" | "valid_to");
    },
    outputs,
    groupKey: a.groupKey,
    hints: a.hints,
  });
  return {
    ok: true,
    rule: {
      sql: bound,
      rsql: RSQL_VERSION,
      time_dependency: a.timeDependency,
      depends_on: a.dependsOn,
      scope:
        a.groupKey.length === 0
          ? { kind: "tenant" }
          : {
              kind: "group",
              key: a.groupKey
                .map((i) => outputs[i] as FieldId)
                .sort((x, y) => Number(x.slice(1)) - Number(y.slice(1))),
              key_from_free_text: a.keyFromFreeText,
            },
    },
    fields: a.fields,
  };
}

function failure(sql: string, input: DerivedRuleInput, e: unknown): DerivedRuleResult {
  if (e instanceof SyntaxRuleError) {
    return {
      ok: false,
      error: {
        code: "validation_failed",
        details: [
          {
            path: input.path,
            code: "rule_sql_rejected",
            ...(e.line !== undefined ? { line: e.line } : {}),
            sql_reason: "syntax",
            message: e.message,
          },
        ],
      },
    };
  }
  if (!(e instanceof RsqlError)) throw e;
  const s: RsqlStop = e.stop;
  const line = s.loc !== undefined ? { line: lineOfByte(sql, s.loc) } : {};
  switch (s.kind) {
    case "rejected":
      return {
        ok: false,
        error: {
          code: "validation_failed",
          details: [
            {
              path: input.path,
              code: s.code,
              ...line,
              ...(s.reason !== undefined ? { sql_reason: s.reason } : {}),
              ...(s.suggestion !== undefined ? { suggestion: s.suggestion } : {}),
              message: s.message,
            },
          ],
        },
      };
    case "not_in_this_version":
      return {
        ok: false,
        error: { code: "not_in_this_version", param: input.path, message: s.message },
      };
    case "not_implemented":
      return { ok: false, error: { code: "not_implemented", what: s.message, param: input.path } };
  }
}

/**
 * Compiles a derived rule written by name. Throws when loadRsql() has not completed; every
 * problem of the rule itself is in the result.
 */
export function compileDerivedRule(input: DerivedRuleInput): DerivedRuleResult {
  rsqlParser();
  try {
    return result(check(input.sql, input, "names"));
  } catch (e) {
    return failure(input.sql, input, e);
  }
}

/**
 * Checks a rule's ID-bound text (`rule.sql` as compiled) the way evaluation will read it: parsed
 * and checked again, names being table and field IDs. Gives the same result as the compilation
 * that printed it.
 */
export function checkBoundRule(input: DerivedRuleInput): DerivedRuleResult {
  rsqlParser();
  try {
    return result(check(input.sql, input, "ids"));
  } catch (e) {
    return failure(input.sql, input, e);
  }
}

/**
 * The checked form of a rule's ID-bound text, for evaluation (./evaluate.ts): parsed and checked
 * again as checkBoundRule does. Throws on any problem; a bound text that compiled has none. Not
 * exported from the package.
 */
export function checkedBoundRule(input: DerivedRuleInput): Checked {
  rsqlParser();
  return check(input.sql, input, "ids");
}

/**
 * The rule's structure, for tests: each output by derived field, WHERE, the group key by derived
 * field and HAVING, with columns by what they resolve to, places and the bound text's own widening
 * casts left out. The same for a rule and its ID-bound text; undefined when the rule is refused.
 * Not exported from the package.
 */
export function ruleShape(input: DerivedRuleInput, naming: "names" | "ids"): string | undefined {
  rsqlParser();
  let c: Checked;
  try {
    c = check(input.sql, input, naming);
  } catch {
    return undefined;
  }
  const { stmt, analysis: a } = c;
  const outputs: unknown[] = new Array(input.fields.length);
  stmt.targets.forEach((t, i) => {
    outputs[a.outputs[i] as number] = JSON.parse(a.key(t.expr));
  });
  return JSON.stringify({
    table: a.table.id,
    outputs,
    where: stmt.where !== undefined ? JSON.parse(a.key(stmt.where)) : null,
    group: a.groupKey.map((i) => a.outputs[i] as number).sort((x, y) => x - y),
    having: stmt.having !== undefined ? JSON.parse(a.key(stmt.having)) : null,
  });
}
