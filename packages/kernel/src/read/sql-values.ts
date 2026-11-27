// The values of a `sql` call as the statement is given them (11-restricted-sql.md «名字 · 参数»,
// «时间»): each parameter checked and converted by the type its use gave it, and the call's times:
// the evaluation instant, its day in a zone, the operands of `FOR VALID_TIME`. A value is validated
// here, by saveslot, and passed to the database as a parameter of a known type: the database does
// not read it by the session's settings.

import type { Instant } from "@fluxvita/saveslot-contract-core";
import { instantText, parseDateTime, validDate } from "../request/index.ts";
import type { ParamType, SqlCall, TimeOperand } from "../rules/index.ts";
import type { SqlValue } from "../store/ports.ts";
import { dateInZone } from "../time/index.ts";
import { invalid, ReadError, type ReadWarning } from "./types.ts";

const INT = /^-?[0-9]{1,19}$/;
const DECIMAL = /^-?(?:[0-9]+\.?[0-9]*|\.[0-9]+)$/;
const INT64_MAX = 2n ** 63n - 1n;
const INT64_MIN = -(2n ** 63n);
/** More digits than a number of any column can hold: refused before the database sees it. */
const MAX_DECIMAL_CHARS = 1000;

/** A parameter as the caller gave it: a scalar. */
export type Scalar = string | number | boolean | null;

/** The value of parameter `$n` (index `n - 1` of `params`) for a type, or the caller's mistake. */
export function convertParam(v: Scalar, t: ParamType, index: number): SqlValue {
  const bad = (_expected: string): never => {
    throw invalid("malformed", `params/${index}`);
  };
  if (v === null) return null;
  switch (t.t) {
    case "bigint": {
      const text =
        typeof v === "number" && Number.isSafeInteger(v)
          ? String(v)
          : typeof v === "string" && INT.test(v)
            ? v
            : undefined;
      if (text === undefined) return bad("an integer");
      const n = BigInt(text);
      if (n > INT64_MAX || n < INT64_MIN) return bad("an integer within 64 bits");
      return n.toString();
    }
    case "numeric": {
      const text = typeof v === "number" && Number.isFinite(v) ? String(v) : v;
      if (typeof text !== "string" || !DECIMAL.test(text) || text.length > MAX_DECIMAL_CHARS)
        return bad("a decimal number");
      return text;
    }
    case "text":
      if (typeof v !== "string" || !v.isWellFormed() || v.includes("\0")) return bad("text");
      return v;
    case "boolean":
      if (typeof v !== "boolean") return bad("a boolean");
      return v;
    case "date":
      if (typeof v !== "string" || !validDate(v)) return bad("a date (YYYY-MM-DD)");
      return v;
    case "timestamptz": {
      const p = typeof v === "string" ? parseDateTime(v, "UTC", false) : undefined;
      if (p === undefined || !p.ok || p.assumed) return bad("an instant with an offset");
      return instantText(p.epochMs);
    }
    default:
      return bad("a value of a type a parameter cannot have");
  }
}

/** `date` moved by whole days; out of 0001–9999 is the query's runtime failure. */
function shifted(date: string, days: number): string {
  const [y, m, d] = date.split("-").map(Number) as [number, number, number];
  const t = new Date(0);
  t.setUTCFullYear(y, m - 1, d + days);
  const out = t.toISOString().slice(0, 10);
  if (!validDate(out)) {
    throw new ReadError("sql_rejected", "a day out of range in FOR VALID_TIME", {
      reason: "runtime",
    });
  }
  return out;
}

/**
 * The call's times. `at` is the evaluation instant. `values` has the converted parameters; warnings
 * are collected into `warnings`.
 */
export function callOf(
  at: Instant,
  values: (n: number) => SqlValue,
  warnings: ReadWarning[],
): SqlCall {
  const ms = Date.parse(at);
  const today = (zone: string) => dateInZone(ms, zone);
  const operand = (o: TimeOperand, granularity: "date" | "instant", zone: string): string => {
    const byDay = granularity === "date";
    let base: string;
    switch (o.base.k) {
      case "param":
      case "str": {
        // A literal and a parameter are read the same way, whatever the analysis checked of a literal
        // before: the same refusals and the same truncation.
        let v: string;
        if (o.base.k === "param") {
          const given = values(o.base.n);
          if (typeof given !== "string") throw invalid("malformed", `params/${o.base.n - 1}`);
          v = given;
        } else v = o.base.value;
        if (validDate(v)) {
          if (!byDay) {
            throw invalid("granularity", "sql");
          }
          base = v;
        } else {
          const p = parseDateTime(v, zone, false);
          if (!p.ok || p.assumed) {
            throw new ReadError(
              "sql_rejected",
              "FOR VALID_TIME: a date (YYYY-MM-DD) or an instant with an offset is expected",
              { reason: "type" },
            );
          }
          if (o.days !== undefined) {
            throw new ReadError(
              "sql_rejected",
              "FOR VALID_TIME: days cannot be added to an instant",
              {
                reason: "node",
              },
            );
          }
          if (byDay) {
            const day = dateInZone(p.epochMs, zone);
            warnings.push({
              code: "time_truncated",
              param: "sql",
              from: instantText(p.epochMs),
              to: day as never,
            });
            base = day;
          } else base = instantText(p.epochMs);
        }
        break;
      }
      case "today":
        base = today(zone);
        break;
      case "now":
        base = byDay ? today(zone) : at;
        break;
    }
    return o.days === undefined ? base : shifted(base, o.days);
  };
  return {
    param: values,
    now: at,
    today,
    operand,
    current: (granularity, zone) => (granularity === "date" ? today(zone) : at),
  };
}
