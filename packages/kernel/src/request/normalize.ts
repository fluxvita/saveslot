// Checking and normalizing a write request, before anything depends on the tenant's state
// (docs/zh-CN/spec/03-data-model/04-write-and-read.md «判定顺序» step 1; 04-contract.md §1–§5,
// §14; 04-contract-types.md §5.1, §7, §9).
//
// Two passes. The first reads the request's shape in document order (top level, evidence, then
// each op) and returns the first problem found: invalid_argument, unknown_table / unknown_field,
// derived_readonly, schema_incompatible, not_in_this_version, too_large. The second normalizes every
// value and collects every problem into one validation_failed. A request reaching the second pass
// has no problem of the first kind.
//
// Parameters this version does not take are refused as not_in_this_version at their path:
// premises, external_key, as, evidence_by_field, an op's own evidence, source_ref segments,
// revert.to, mode, the evidence level external_authority.
//
// Temporary limits, until experiment 4 (08-open-questions): at most 1,000 ops; `task` and
// `idempotency_key` at most 256 characters, well-formed, without control characters. Evidence: 32 KB
// per segment and 256 KB per request, UTF-8 bytes of `text` and `excerpt` (04-contract §3).
//
// The caller's objects are read through ./own.ts only: own enumerable keys, `undefined` as absent,
// arrays without holes.

import { createHash } from "node:crypto";
import type {
  CompiledBaseField,
  CompiledBaseTable,
  CompiledTable,
  DateStr,
  FieldId,
  Instant,
  TableId,
} from "@fluxvita/saveslot-contract-core";
import { canonicalize, isId } from "@fluxvita/saveslot-contract-core";
import { dateInZone, nextDay, startOfDay } from "../time/index.ts";
import { echoName, echoPath, fold, nearest, qualifiedTable, splitTableName } from "./names.ts";
import { isJsonNumber } from "./number.ts";
import { get, has, isDenseArray, isObj, keysOf, type Obj } from "./own.ts";
import { instantText, parseDateTime, validDate } from "./times.ts";
import type {
  ChangedFields,
  EvidenceSegment,
  FromParam,
  Intent,
  NormalizedField,
  NormalizedOp,
  NormalizedTarget,
  NormalizedWrite,
  NormalizeWriteInput,
  NormalizeWriteResult,
  RequestError,
  ToParam,
  ValidParam,
  WriteValidationDetail,
  WriteWarning,
} from "./types.ts";
import { normalizeValue } from "./values.ts";

export const MAX_OPS = 1000;
export const MAX_TAG_CHARS = 256;
export const EVIDENCE_SEGMENT_BYTES = 32 * 1024;
export const EVIDENCE_REQUEST_BYTES = 256 * 1024;
/** `file_ref` text lengths in characters (code points): name, mime, origin. */
export const FILE_REF_CHARS = { name: 256, mime: 256, origin: 2048 } as const;

/** Thrown inside the first pass with the request's error. */
export class Refused extends Error {
  readonly error: RequestError;
  constructor(error: RequestError) {
    super(error.code);
    this.error = error;
  }
}

/** Throws the error, its echoed names and paths cut to `ECHO_CHARS` code points each. */
export const refuse = (error: RequestError): never => {
  const e = error as RequestError & { param?: string; name?: string };
  throw new Refused({
    ...error,
    ...(typeof e.param === "string" ? { param: echoPath(e.param) } : {}),
    ...(typeof e.name === "string" ? { name: echoName(e.name) } : {}),
  } as RequestError);
};
export const invalid = (
  reason: string,
  param: string,
  extra: Record<string, unknown> = {},
): never => refuse({ code: "invalid_argument", reason, param, ...extra } as RequestError);
export const notYet = (param: string, reason: "parameter" | "value" = "parameter"): never =>
  refuse({ code: "not_in_this_version", reason, param });

const utf8Bytes = (s: string) => new TextEncoder().encode(s).length;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
export const CONTROL = /[\u0000-\u001f\u007f-\u009f]/;

/** A JSON integer: a number, or a JsonNumber whose text is an integer. */
export function intOf(v: unknown): number | undefined {
  if (typeof v === "number") return Number.isSafeInteger(v) ? v : undefined;
  if (isJsonNumber(v) && /^-?(0|[1-9][0-9]*)$/.test(v.text)) {
    const n = Number(v.text);
    return Number.isSafeInteger(n) ? n : undefined;
  }
  return undefined;
}

/** `task` or `idempotency_key`: non-empty, well-formed, at most MAX_TAG_CHARS, no control chars. */
export function tag(o: Obj, key: string): string | undefined {
  if (!has(o, key)) return undefined;
  const v = get(o, key);
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    !v.isWellFormed() ||
    [...v].length > MAX_TAG_CHARS ||
    CONTROL.test(v)
  )
    return invalid("malformed", key);
  return v;
}

const TOP_KEYS = new Set(["sv", "evidence", "ops", "task", "idempotency_key", "mode"]);
const OP_KEYS = new Set([
  "intent",
  "table",
  "row",
  "entity",
  "entity_key",
  "external_key",
  "as",
  "ver",
  "set",
  "revert",
  "valid_from",
  "valid_to",
  "acknowledge",
  "premises",
  "evidence",
  "evidence_refs",
  "evidence_by_field",
]);
/** Op keys this version does not take, in the order they are reported. */
const OP_NOT_YET = ["premises", "external_key", "as", "evidence", "evidence_by_field"];
const INTENTS: ReadonlySet<string> = new Set(["insert", "update", "correct", "revoke"]);
const VER = /^v([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// --- evidence (04-contract §3) ------------------------------------------------------------------

export function evidence(v: unknown): EvidenceSegment[] {
  if (v === undefined) return [];
  if (!isDenseArray(v)) return invalid("malformed", "evidence");
  let total = 0;
  const segments = v.map((s, k): EvidenceSegment => {
    const at = `evidence/${k}`;
    if (!isObj(s)) return invalid("malformed", at);
    const kind = get(s, "kind");
    if (kind === "source_ref") return notYet(at);
    // Evidence text: well-formed, no NUL (PostgreSQL text cannot hold it). `short` texts have a
    // length limit and no control characters.
    const text = (key: string, required: boolean, short?: number): string | undefined => {
      if (!has(s, key)) return required ? invalid("missing", `${at}/${key}`) : undefined;
      const t = get(s, key);
      if (
        typeof t !== "string" ||
        !t.isWellFormed() ||
        t.includes("\u0000") ||
        (required && t === "") ||
        (short !== undefined && ([...t].length > short || CONTROL.test(t)))
      )
        return invalid("malformed", `${at}/${key}`);
      return t;
    };
    const common = (): { level?: "user_stated" | "agent_inferred"; stated_at?: Instant } => {
      const out: { level?: "user_stated" | "agent_inferred"; stated_at?: Instant } = {};
      if (has(s, "level")) {
        const l = get(s, "level");
        if (l === "external_authority") notYet(`${at}/level`, "value");
        if (l !== "user_stated" && l !== "agent_inferred") invalid("malformed", `${at}/level`);
        out.level = l as "user_stated" | "agent_inferred";
      }
      if (has(s, "stated_at")) {
        const t = get(s, "stated_at");
        const p = typeof t === "string" ? parseDateTime(t, "UTC", false) : undefined;
        // An instant must carry its offset here: there is no slot time zone to assume for it.
        if (p === undefined || !p.ok || p.assumed) return invalid("malformed", `${at}/stated_at`);
        out.stated_at = instantText(p.epochMs);
      }
      return out;
    };
    const sized = (t: string | undefined, key: string) => {
      if (t === undefined) return;
      const n = utf8Bytes(t);
      if (n > EVIDENCE_SEGMENT_BYTES) {
        refuse({
          code: "too_large",
          reason: "evidence_segment",
          param: `${at}/${key}`,
          limit_bytes: EVIDENCE_SEGMENT_BYTES,
          actual_bytes: n,
        });
      }
      total += n;
    };
    if (kind === "user_message" || kind === "agent_note" || kind === "tool_result") {
      for (const key of keysOf(s))
        if (!["kind", "text", "level", "stated_at"].includes(key))
          invalid("malformed", `${at}/${key}`);
      const t = text("text", true) as string;
      sized(t, "text");
      return { kind, text: t, ...common() };
    }
    if (kind === "file_ref") {
      const keys = [
        "kind",
        "name",
        "mime",
        "size",
        "sha256",
        "origin",
        "excerpt",
        "level",
        "stated_at",
      ];
      for (const key of keysOf(s)) if (!keys.includes(key)) invalid("malformed", `${at}/${key}`);
      const name = text("name", true, FILE_REF_CHARS.name) as string;
      const mime = text("mime", true, FILE_REF_CHARS.mime) as string;
      if (!has(s, "size")) invalid("missing", `${at}/size`);
      const size = intOf(get(s, "size"));
      if (size === undefined || size < 0) return invalid("malformed", `${at}/size`);
      const sha = text("sha256", true) as string;
      if (!/^[0-9a-fA-F]{64}$/.test(sha)) invalid("malformed", `${at}/sha256`);
      const origin = text("origin", false, FILE_REF_CHARS.origin);
      const excerpt = text("excerpt", false);
      sized(excerpt, "excerpt");
      return {
        kind,
        name,
        mime,
        size,
        sha256: sha.toLowerCase(),
        ...(origin !== undefined ? { origin } : {}),
        ...(excerpt !== undefined ? { excerpt } : {}),
        ...common(),
      };
    }
    return invalid(has(s, "kind") ? "malformed" : "missing", `${at}/kind`);
  });
  if (total > EVIDENCE_REQUEST_BYTES) {
    refuse({
      code: "too_large",
      reason: "request",
      param: "evidence",
      limit_bytes: EVIDENCE_REQUEST_BYTES,
      actual_bytes: total,
    });
  }
  return segments;
}

// --- tables and fields --------------------------------------------------------------------------

interface Tables {
  readonly byName: ReadonlyMap<string, CompiledTable>;
  readonly slot: string;
  readonly inRange: NormalizeWriteInput["inRange"];
}

function tablesOf(input: NormalizeWriteInput): Tables {
  const byName = new Map<string, CompiledTable>();
  for (const t of input.compiled.tables) byName.set(fold(t.name), t);
  return { byName, slot: input.compiled.name, inRange: input.inRange };
}

function baseTable(
  v: unknown,
  at: string,
  t: Tables,
  compiled: readonly CompiledTable[],
): CompiledBaseTable {
  if (typeof v !== "string" || v === "")
    return invalid(v === undefined ? "missing" : "malformed", at);
  const [slot, name] = splitTableName(v);
  if (slot !== undefined && fold(slot) !== fold(t.slot)) {
    // A table of another slot: cross_slot only when it is in range, else it is a name that is not
    // there for this caller (04-contract-types §9 `cross_slot`; 04-contract «不存在与不可见报同一个
    // 错误»). Not reached for now: an op's table was resolved with the request's slot before
    // (`resolveWriteSlot`), and the premises that name tables are not taken in this version.
    if (t.inRange === undefined) return invalid("cross_slot", at);
    const other = t.inRange.find((x) => fold(x.name) === fold(slot));
    if (other?.tables.some((x) => fold(x) === fold(name))) return invalid("cross_slot", at);
    const named = t.inRange.flatMap((x) => x.tables.map((y) => ({ name: `${x.name}.${y}` })));
    return refuse({ code: "unknown_table", param: at, name: v, nearest: nearest(v, named) });
  }
  const table = t.byName.get(fold(name));
  if (table === undefined) {
    return refuse({ code: "unknown_table", param: at, name: v, nearest: nearest(name, compiled) });
  }
  if (table.kind === "derived") {
    const byId = new Map(compiled.map((x) => [x.id, x.name]));
    const bases = [...new Set(table.rule.depends_on.map((d) => byId.get(d.table) ?? d.table))];
    return refuse({ code: "derived_readonly", param: at, table: table.name, base_tables: bases });
  }
  return table;
}

function fieldsByName(t: CompiledBaseTable): Map<string, CompiledBaseField> {
  return new Map(t.fields.map((f) => [fold(f.name), f]));
}

/** The fields an object names: by folded name, each once; unknown names refused. */
function namedFields(
  o: Obj,
  at: string,
  t: CompiledBaseTable,
  byName: ReadonlyMap<string, CompiledBaseField>,
): [CompiledBaseField, string, unknown][] {
  const seen = new Set<string>();
  return keysOf(o).map((k): [CompiledBaseField, string, unknown] => {
    const f = byName.get(fold(k));
    if (f === undefined) {
      return refuse({
        code: "unknown_field",
        param: `${at}/${k}`,
        name: k,
        nearest: nearest(k, t.fields),
      });
    }
    // The same field twice, by case: malformed at the second spelling.
    if (seen.has(f.id)) return invalid("malformed", `${at}/${k}`);
    seen.add(f.id);
    return [f, k, get(o, k)];
  });
}

// --- business time (04-contract §4, §5.2) ---------------------------------------------------------

interface PointCtx {
  readonly op: number;
  readonly granularity: "date" | "instant";
  readonly zone: string;
  readonly warnings: WriteWarning[];
}

function bizPoint(v: unknown, at: string, c: PointCtx): DateStr | Instant {
  if (typeof v !== "string") return invalid("malformed", at);
  if (c.granularity === "date") {
    if (validDate(v)) return v;
    const p = parseDateTime(v, c.zone, false);
    if (!p.ok) return invalid("malformed", at);
    const day = dateInZone(p.epochMs, c.zone);
    // The day in the slot's zone must be a date of 0001–9999 too.
    if (!validDate(day)) return invalid("malformed", at);
    if (p.assumed)
      c.warnings.push({ code: "timezone_assumed", op: c.op, param: at, timezone: c.zone });
    c.warnings.push({
      code: "time_truncated",
      op: c.op,
      param: at,
      from: instantText(p.epochMs),
      to: day,
    });
    return day;
  }
  if (validDate(v)) {
    // A date on an instant table: the day's bounds in the slot's time zone as the example.
    return invalid("granularity", at, {
      example: {
        valid_from: instantText(startOfDay(v, c.zone)),
        valid_to: instantText(startOfDay(nextDay(v), c.zone)),
      },
    });
  }
  const p = parseDateTime(v, c.zone, false);
  if (!p.ok) return invalid("malformed", at);
  if (p.assumed)
    c.warnings.push({ code: "timezone_assumed", op: c.op, param: at, timezone: c.zone });
  return instantText(p.epochMs);
}

// --- request key (04-contract §14) ----------------------------------------------------------------

/** RFC 8785 form of the request without task and idempotency_key; JsonNumbers as their own text. */
/** The request's canonical content, without `task` and `idempotency_key` (its request key's). */
export function requestContent(params: Obj): string {
  const out: string[] = [];
  const walk = (v: unknown): void => {
    if (isJsonNumber(v)) out.push(v.text);
    else if (Array.isArray(v)) {
      out.push("[");
      v.forEach((x, i) => {
        if (i > 0) out.push(",");
        walk(x);
      });
      out.push("]");
    } else if (v !== null && typeof v === "object") {
      const o = v as Obj;
      const keys = keysOf(o).sort((a, b) => (a < b ? -1 : a > b ? 1 : 0));
      out.push("{");
      keys.forEach((k, i) => {
        if (i > 0) out.push(",");
        out.push(canonicalize(k), ":");
        walk(get(o, k));
      });
      out.push("}");
    } else out.push(canonicalize(v as string | number | boolean | null));
  };
  const rest: Record<string, unknown> = Object.create(null);
  for (const k of keysOf(params))
    if (k !== "task" && k !== "idempotency_key") rest[k] = get(params, k);
  walk(rest);
  return out.join("");
}

// --- the entry ------------------------------------------------------------------------------------

/** Checks and normalizes a write request: steps of «判定顺序» step 1 only. */
export function normalizeWrite(input: NormalizeWriteInput): NormalizeWriteResult {
  try {
    return normalize(input);
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.error };
    throw e;
  }
}

interface PendingOp {
  readonly index: number;
  readonly table: CompiledBaseTable;
  readonly intent: Intent | undefined;
  readonly kind: "write" | "revoke" | "undo";
  readonly target:
    | { kind: "new" }
    | { kind: "row"; row: string }
    | { kind: "entity"; entity: string }
    | {
        kind: "entity_key";
        entries: [CompiledBaseField, string, unknown][];
      };
  readonly ver: { op: number; restoreCount: number } | undefined;
  readonly set: [CompiledBaseField, string, unknown][] | undefined;
  readonly valid: ValidParam | undefined;
  readonly undo: { target: number; includeLater: boolean } | undefined;
  readonly acknowledge: "overwrite"[];
  readonly evidenceRefs: number[] | undefined;
  readonly named: NamedField[];
}

/** A field an op names in `set` or `entity_key`, with its path in the request. */
interface NamedField {
  readonly field: FieldId;
  readonly name: string;
  readonly param: string;
}

function normalize(input: NormalizeWriteInput): NormalizeWriteResult {
  const params = input.params;
  if (!isObj(params)) return invalid("malformed", "");
  for (const k of keysOf(params)) if (!TOP_KEYS.has(k)) invalid("malformed", k);
  if (has(params, "mode")) notYet("mode");
  const task = tag(params, "task");
  const idempotencyKey = tag(params, "idempotency_key");
  let sv: number | undefined;
  if (has(params, "sv")) {
    sv = intOf(get(params, "sv"));
    if (sv === undefined || sv < 1 || sv > input.currentSv) invalid("malformed", "sv");
  }
  const segments = evidence(get(params, "evidence"));
  if (!has(params, "ops")) invalid("missing", "ops");
  const rawOps = get(params, "ops");
  if (!isDenseArray(rawOps) || rawOps.length === 0) return invalid("malformed", "ops");
  if (rawOps.length > MAX_OPS) {
    refuse({ code: "too_large", reason: "request", param: "ops", limit: MAX_OPS });
  }

  const tables = tablesOf(input);
  const zone = input.compiled.timezone;
  const warnings: WriteWarning[] = [];
  const pending = rawOps.map((o, i) =>
    readOp(o, i, tables, input, segments.length, zone, warnings),
  );

  // sv compatibility: a request at an older version may not write fields changed since. Without
  // `sv`, the caller checks after its fallback (checkSvCompatibility).
  if (sv !== undefined) {
    const e = svCompatibility(
      pending.map((p) => ({ index: p.index, table: p.table.id, named: p.named })),
      sv,
      input.currentSv,
      input.changedSince,
    );
    if (e !== undefined) refuse(e);
  }

  // Second pass: values.
  const details: WriteValidationDetail[] = [];
  const ops = pending.map((p): NormalizedOp => {
    const value = (f: CompiledBaseField, v: unknown): NormalizedField | undefined => {
      if (v === null) {
        if (f.required === true) {
          details.push({ op: p.index, field: f.name, code: "required_missing" });
          return undefined;
        }
        return { value: null, raw: null };
      }
      const r = normalizeValue(f, v, { op: p.index, name: f.name, zone, kept: true });
      if (!r.ok) {
        details.push(r.detail);
        return undefined;
      }
      warnings.push(...r.warnings);
      return { value: r.value, raw: r.raw };
    };
    let target: NormalizedTarget;
    if (p.target.kind === "entity_key") {
      const key: Record<FieldId, NormalizedField> = {};
      for (const [f, , v] of p.target.entries) {
        const n = value(f, v);
        if (n !== undefined) key[f.id] = n;
      }
      target = { kind: "entity_key", key };
    } else if (p.target.kind === "row")
      target = { kind: "row", row: p.target.row as `r_${string}` };
    else if (p.target.kind === "entity")
      target = { kind: "entity", entity: p.target.entity as `e_${string}` };
    else target = { kind: "new" };
    let fields: Record<FieldId, NormalizedField> | undefined;
    if (p.set !== undefined) {
      fields = {};
      for (const [f, , v] of p.set) {
        const n = value(f, v);
        if (n !== undefined) fields[f.id] = n;
      }
      if (p.intent === "insert") {
        const given = new Set(p.set.map(([f]) => f.id));
        for (const f of p.table.fields) {
          if (f.required === true && !given.has(f.id))
            details.push({ op: p.index, field: f.name, code: "required_missing" });
        }
        // An event or timeless row stands only on a field with a non-empty value: a clear alone
        // does not keep one (03-data-model/03-deletion «重放规则», existence), so an insert giving
        // none would leave nothing, its row ID of no use (04-contract «写入»). Only the set counts:
        // this version's fields have no defaults, and a constant backfill only fills existing rows;
        // a default, once there is one, counts here too. Each insert stands alone: no later op of
        // the request can name the row it would make (no `as` binding in this version). On a state
        // table a clear is a value (05-time «无值区间»), so this does not apply there. A table with
        // a required field has `required_missing` for such an insert already (an event table always
        // has one, its time field), so this is said only where no field is required.
        if (
          p.table.time.type !== "state" &&
          !p.table.fields.some((f) => f.required === true) &&
          p.set.every(([, , v]) => v === null)
        ) {
          details.push({
            op: p.index,
            table: qualifiedTable(input.compiled.name, p.table),
            code: "empty_row",
          });
        }
      }
    }
    return {
      index: p.index,
      table: p.table.id,
      intent: p.intent,
      target,
      ver: p.ver,
      kind: p.kind,
      ...(fields !== undefined ? { fields } : {}),
      ...(p.valid !== undefined ? { valid: p.valid } : {}),
      ...(p.undo !== undefined ? { undo: p.undo } : {}),
      acknowledge: p.acknowledge,
      ...(p.evidenceRefs !== undefined ? { evidenceRefs: p.evidenceRefs } : {}),
      named: p.named,
    };
  });
  if (details.length > 0) {
    return { ok: false, error: { code: "validation_failed", reason: "write", details } };
  }

  const content = requestContent(params);
  return {
    ok: true,
    request: {
      sv,
      task,
      evidence: segments,
      ops,
      warnings,
      requestKey: {
        content,
        ...(idempotencyKey !== undefined
          ? {
              idempotencyKey,
              fingerprint: createHash("sha256").update(content, "utf8").digest("hex"),
            }
          : {}),
      },
    },
  };
}

/** Reads one op's shape (first pass). */
function readOp(
  o: unknown,
  i: number,
  tables: Tables,
  input: NormalizeWriteInput,
  segmentCount: number,
  zone: string,
  warnings: WriteWarning[],
): PendingOp {
  const at = `ops/${i}`;
  if (!isObj(o)) return invalid("malformed", at);
  for (const k of keysOf(o)) if (!OP_KEYS.has(k)) invalid("malformed", `${at}/${k}`);
  for (const k of OP_NOT_YET) if (has(o, k)) notYet(`${at}/${k}`);
  const table = baseTable(get(o, "table"), `${at}/table`, tables, input.compiled.tables);
  const byName = fieldsByName(table);
  const state = table.time.type === "state";

  // Intent and kind.
  let intent: Intent | undefined;
  if (has(o, "intent")) {
    const v = get(o, "intent");
    if (typeof v !== "string" || !INTENTS.has(v)) invalid("malformed", `${at}/intent`);
    intent = v as Intent;
  }
  let undo: { target: number; includeLater: boolean } | undefined;
  if (has(o, "revert")) {
    const r = get(o, "revert");
    if (!isObj(r)) return invalid("malformed", `${at}/revert`);
    if (has(r, "to")) notYet(`${at}/revert/to`);
    for (const k of keysOf(r))
      if (k !== "undo" && k !== "include_later") invalid("malformed", `${at}/revert/${k}`);
    if (!has(r, "undo")) invalid("missing", `${at}/revert/undo`);
    const n = intOf(get(r, "undo"));
    if (n === undefined || n < 1) invalid("malformed", `${at}/revert/undo`);
    const later = has(r, "include_later") ? get(r, "include_later") : false;
    if (typeof later !== "boolean") invalid("malformed", `${at}/revert/include_later`);
    if (has(o, "set")) invalid("mutually_exclusive", `${at}/set`);
    if (intent === "insert" || intent === "revoke") invalid("mutually_exclusive", `${at}/revert`);
    for (const k of ["valid_from", "valid_to"])
      if (has(o, k)) invalid("mutually_exclusive", `${at}/${k}`);
    undo = { target: n as number, includeLater: later as boolean };
  } else if (intent === undefined) invalid("missing", `${at}/intent`);
  const kind = undo !== undefined ? "undo" : intent === "revoke" ? "revoke" : "write";

  // Target.
  const given = (["row", "entity", "entity_key"] as const).filter((k) => has(o, k));
  let target: PendingOp["target"];
  if (intent === "insert") {
    if (table.entity_key !== undefined) invalid("insert_with_entity_key", `${at}/table`);
    const [extra] = given;
    if (extra !== undefined) invalid("mutually_exclusive", `${at}/${extra}`);
    target = { kind: "new" };
  } else {
    const [first, second] = given;
    if (second !== undefined) invalid("mutually_exclusive", `${at}/${second}`);
    if (first === undefined) return invalid("missing", `${at}/${state ? "entity" : "row"}`);
    const v = get(o, first);
    if (first === "row") {
      if (state) invalid("state_table", `${at}/row`);
      if (typeof v !== "string" || !isId("row", v)) invalid("malformed", `${at}/row`);
      target = { kind: "row", row: v as string };
    } else if (first === "entity") {
      if (!state) invalid("not_state_table", `${at}/entity`);
      if (typeof v !== "string" || !isId("entity", v)) invalid("malformed", `${at}/entity`);
      target = { kind: "entity", entity: v as string };
    } else {
      if (!state) invalid("not_state_table", `${at}/entity_key`);
      if (table.entity_key === undefined) invalid("malformed", `${at}/entity_key`);
      if (!isObj(v)) return invalid("malformed", `${at}/entity_key`);
      const keyIds = new Set(table.entity_key as readonly string[]);
      const keyNamed = new Set<string>();
      const entries = keysOf(v).map((k): [CompiledBaseField, string, unknown] => {
        const f = byName.get(fold(k));
        // Not a key field, or a key field named a second time (by case): malformed at that key.
        if (f === undefined || !keyIds.has(f.id) || keyNamed.has(f.id))
          return invalid("malformed", `${at}/entity_key/${k}`);
        keyNamed.add(f.id);
        return [f, k, get(v, k)];
      });
      for (const id of keyIds) {
        if (!keyNamed.has(id)) {
          const f = table.fields.find((x) => x.id === id);
          invalid("missing", `${at}/entity_key/${f?.name ?? id}`);
        }
      }
      target = { kind: "entity_key", entries };
    }
  }

  // ver.
  let ver: PendingOp["ver"];
  if (has(o, "ver")) {
    if (intent === "insert") invalid("mutually_exclusive", `${at}/ver`);
    const v = get(o, "ver");
    const m = typeof v === "string" ? VER.exec(v) : null;
    if (m === null) return invalid("malformed", `${at}/ver`);
    const op = Number(m[1]);
    const restoreCount = Number(m[2]);
    if (!Number.isSafeInteger(op) || !Number.isSafeInteger(restoreCount))
      invalid("malformed", `${at}/ver`);
    ver = { op, restoreCount };
  }

  // set.
  let set: PendingOp["set"];
  if (has(o, "set")) {
    if (kind === "revoke") invalid("mutually_exclusive", `${at}/set`);
    const s = get(o, "set");
    if (!isObj(s)) return invalid("malformed", `${at}/set`);
    set = namedFields(s, `${at}/set`, table, byName);
    if (set.length === 0) invalid("malformed", `${at}/set`);
  } else if (kind === "write") invalid("missing", `${at}/set`);

  // Business time.
  let valid: ValidParam | undefined;
  const hasFrom = has(o, "valid_from");
  const hasTo = has(o, "valid_to");
  if ((hasFrom || hasTo) && !state)
    invalid("not_state_table", `${at}/${hasFrom ? "valid_from" : "valid_to"}`);
  if (state && kind !== "undo") {
    const c: PointCtx = {
      op: i,
      granularity: (table.time as { granularity: "date" | "instant" }).granularity,
      zone,
      warnings,
    };
    if (!hasFrom && !hasTo) {
      if (intent === "correct") valid = "corrected_span";
      else if (kind === "write") valid = { from: { mode: "now" }, to: { mode: "next_change" } };
    } else {
      const from: FromParam = hasFrom
        ? { mode: "given", value: bizPoint(get(o, "valid_from"), `${at}/valid_from`, c) }
        : { mode: "now" };
      let to: ToParam = { mode: "next_change" };
      if (hasTo) {
        const v = get(o, "valid_to");
        if (v === "next_change") to = { mode: "next_change" };
        else if (v === "open") to = { mode: "open" };
        else to = { mode: "given", value: bizPoint(v, `${at}/valid_to`, c) };
      }
      if (from.mode === "given" && to.mode === "given" && !(from.value < to.value))
        invalid("malformed", `${at}/valid_to`);
      valid = { from, to };
    }
  }

  // acknowledge, evidence_refs.
  const acknowledge: "overwrite"[] = [];
  if (has(o, "acknowledge")) {
    const a = get(o, "acknowledge");
    if (!isDenseArray(a)) return invalid("malformed", `${at}/acknowledge`);
    a.forEach((x, k) => {
      // A value given twice is malformed at the second.
      if (x !== "overwrite" || acknowledge.includes(x))
        invalid("malformed", `${at}/acknowledge/${k}`);
      acknowledge.push("overwrite");
    });
  }
  let evidenceRefs: number[] | undefined;
  if (has(o, "evidence_refs")) {
    const r = get(o, "evidence_refs");
    if (!isDenseArray(r)) return invalid("malformed", `${at}/evidence_refs`);
    evidenceRefs = [];
    for (const [k, x] of r.entries()) {
      const n = intOf(x);
      if (n === undefined || evidenceRefs.includes(n))
        return invalid("malformed", `${at}/evidence_refs/${k}`);
      if (n < 0 || n >= segmentCount)
        return invalid("index_out_of_range", `${at}/evidence_refs/${k}`);
      evidenceRefs.push(n);
    }
  }
  const named: NamedField[] = [
    ...(set ?? []).map(([f, k]) => ({ field: f.id, name: f.name, param: `${at}/set/${k}` })),
    ...(target.kind === "entity_key" ? target.entries : []).map(([f, k]) => ({
      field: f.id,
      name: f.name,
      param: `${at}/entity_key/${k}`,
    })),
  ];

  return {
    index: i,
    table,
    intent,
    kind,
    target,
    ver,
    set,
    valid,
    undo,
    acknowledge,
    evidenceRefs,
    named,
  };
}

// --- sv compatibility (04-contract §2; 04-contract-types §9 `schema_incompatible`) ---------------

interface OpFields {
  readonly index: number;
  readonly table: TableId;
  readonly named: readonly NamedField[];
}

function svCompatibility(
  ops: readonly OpFields[],
  sv: number,
  currentSv: number,
  changedSince: (sv: number) => ChangedFields,
): RequestError | undefined {
  if (sv >= currentSv) return undefined;
  const changed = changedSince(sv);
  for (const op of ops) {
    // The whole table changed (restructure_unused): any write to it.
    const whole = changed.get(`${op.table}/*`);
    if (whole !== undefined) {
      return {
        code: "schema_incompatible",
        param: `ops/${op.index}/table`,
        current_sv: currentSv,
        changed_fields: [{ field: "*", change: whole }],
      };
    }
    const seen = new Set<FieldId>();
    const hits = op.named.filter((n) => {
      if (seen.has(n.field) || !changed.has(`${op.table}/${n.field}`)) return false;
      seen.add(n.field);
      return true;
    });
    const [first] = hits;
    if (first !== undefined) {
      return {
        code: "schema_incompatible",
        param: first.param,
        current_sv: currentSv,
        changed_fields: hits.map((n) => ({
          field: n.name,
          change: changed.get(`${op.table}/${n.field}`) as NonNullable<
            ReturnType<ChangedFields["get"]>
          >,
        })),
      };
    }
  }
  return undefined;
}

/**
 * The sv compatibility check for a request normalized without `sv`: the caller runs it with the
 * version its fallback found (04-contract §2). The first op writing a field changed since that
 * version, or any table changed as a whole, gives `schema_incompatible`. `changedSince` is not
 * called when `sv` is the current version.
 */
export function checkSvCompatibility(input: {
  readonly request: NormalizedWrite;
  readonly sv: number;
  readonly currentSv: number;
  readonly changedSince: (sv: number) => ChangedFields;
}): RequestError | undefined {
  return svCompatibility(input.request.ops, input.sv, input.currentSv, input.changedSince);
}

// --- the request's slot (04-contract §1, §5) -----------------------------------------------------

export interface SlotTables {
  readonly name: string;
  readonly tables: readonly string[];
  /** Aliases by table name (they are not names; `nearest` lists the tables they match first). */
  readonly aliases?: ReadonlyMap<string, readonly string[]>;
}

export type ResolveWriteSlotResult =
  | { readonly ok: true; readonly slot: string }
  | { readonly ok: false; readonly error: RequestError };

/**
 * The slot a write request is in, before its compiled definition is read: a qualified `slot.table`
 * names it; a bare table name counts when exactly one visible slot has the table. Every op must be
 * in the same slot.
 */
export function resolveWriteSlot(
  params: unknown,
  slots: readonly SlotTables[],
): ResolveWriteSlotResult {
  try {
    if (!isObj(params)) return invalid("malformed", "");
    if (!has(params, "ops")) return invalid("missing", "ops");
    const ops = get(params, "ops");
    if (!isDenseArray(ops) || ops.length === 0) return invalid("malformed", "ops");
    const bySlot = new Map(slots.map((s) => [fold(s.name), s]));
    let slot: SlotTables | undefined;
    ops.forEach((o, i) => {
      const at = `ops/${i}/table`;
      if (!isObj(o)) invalid("malformed", `ops/${i}`);
      const v = get(o as Obj, "table");
      if (typeof v !== "string" || v === "") invalid(v === undefined ? "missing" : "malformed", at);
      const [s, name] = splitTableName(v as string);
      let here: SlotTables | undefined;
      if (s !== undefined) {
        here = bySlot.get(fold(s));
        if (here === undefined || !here.tables.some((t) => fold(t) === fold(name))) {
          const all = slots.flatMap((x) =>
            x.tables.map((t) => ({
              name: `${x.name}.${t}`,
              aliases: (x.aliases?.get(t) ?? []).map((a) => `${x.name}.${a}`),
            })),
          );
          refuse({
            code: "unknown_table",
            param: at,
            name: v as string,
            nearest: nearest(v as string, all),
          });
        }
      } else {
        const holders = slots.filter((x) => x.tables.some((t) => fold(t) === fold(name)));
        if (holders.length === 0) {
          const byName = new Map<string, string[]>();
          for (const x of slots)
            for (const t of x.tables)
              byName.set(t, [...(byName.get(t) ?? []), ...(x.aliases?.get(t) ?? [])]);
          const all = [...byName].map(([n, aliases]) => ({ name: n, aliases }));
          refuse({
            code: "unknown_table",
            param: at,
            name: v as string,
            nearest: nearest(name, all),
          });
        }
        if (holders.length > 1) {
          invalid("ambiguous_table", at, {
            candidates: holders.map((x) => {
              const t = x.tables.find((y) => fold(y) === fold(name)) as string;
              return `${x.name}.${t}`;
            }),
          });
        }
        here = holders[0];
      }
      if (slot === undefined) slot = here;
      else if (here !== slot) invalid("cross_slot", at);
    });
    return { ok: true, slot: (slot as SlotTables).name };
  } catch (e) {
    if (e instanceof Refused) return { ok: false, error: e.error };
    throw e;
  }
}
