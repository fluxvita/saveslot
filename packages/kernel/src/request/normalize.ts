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
// as, source_ref segments, revert.to, mode, the evidence level external_authority, and a premise's temporary name
// ("@…", with `as`).
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
  JcsValue,
  SourceId,
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
  NormalizedPremise,
  NormalizedTarget,
  NormalizedWrite,
  NormalizeWriteInput,
  NormalizeWriteResult,
  RequestError,
  TableVersions,
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
/** Evidence segments a request may have, the request's and every op's, `source_ref` ones too. */
export const MAX_EVIDENCE_SEGMENTS = 1000;
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
/** Op parameters not in this version: none now (`external_key` and `as` both taken). */
const OP_NOT_YET: readonly string[] = [];
/** A temporary name (`as`): letters, digits, `_` and `-`, at most 64. */
const TEMP_NAME = /^[A-Za-z0-9_-]{1,64}$/;
/** The premises an op may have (02-integrity «写入的前提» «上限»). */
export const MAX_PREMISES = 16;
const PREMISE_KEYS = new Set([
  "table",
  "row",
  "entity",
  "entity_key",
  "fields",
  "ver",
  "valid_at",
  "valid_during",
]);
/** A historical version as `as_of` gives it (04-contract §2): not one a premise may rest on. */
const HISTORICAL_VER = /^h([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

const INTENTS: ReadonlySet<string> = new Set(["insert", "update", "correct", "revoke"]);
const VER = /^v([1-9][0-9]*)\.(0|[1-9][0-9]*)$/;

// --- evidence (04-contract §3) ------------------------------------------------------------------

/**
 * Evidence segments in one place (the request's `evidence`, or an op's own at `ops/i/evidence`),
 * with the bytes they count toward the request's limit. The total is checked by the caller.
 */
export function segmentsAt(
  v: unknown,
  base: string,
): { readonly segments: EvidenceSegment[]; readonly bytes: number } {
  if (v === undefined) return { segments: [], bytes: 0 };
  if (!isDenseArray(v)) return invalid("malformed", base);
  let total = 0;
  const segments = v.map((s, k): EvidenceSegment => {
    const at = `${base}/${k}`;
    if (!isObj(s)) return invalid("malformed", at);
    const kind = get(s, "kind");
    if (kind === "source_ref") {
      // An existing source of the slot, by ID: no text of its own, nothing counted.
      for (const key of keysOf(s))
        if (key !== "kind" && key !== "id") invalid("malformed", `${at}/${key}`);
      if (!has(s, "id")) return invalid("missing", `${at}/id`);
      const id = get(s, "id");
      if (typeof id !== "string" || !isId("source", id)) return invalid("malformed", `${at}/id`);
      return { kind, id: id as SourceId };
    }
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
  return { segments, bytes: total };
}

/**
 * The request's evidence against its limits (04-contract §3): at most 1,000 segments, the
 * request's and every op's (a `source_ref` counts: it has no bytes), then 256 KB over them all.
 */
function checkEvidenceTotal(total: number, count: number): void {
  if (count > MAX_EVIDENCE_SEGMENTS) {
    refuse({
      code: "too_large",
      reason: "evidence_segments",
      param: "evidence",
      limit: MAX_EVIDENCE_SEGMENTS,
      actual: count,
    });
  }
  if (total > EVIDENCE_REQUEST_BYTES) {
    refuse({
      code: "too_large",
      reason: "request",
      param: "evidence",
      limit_bytes: EVIDENCE_REQUEST_BYTES,
      actual_bytes: total,
    });
  }
}

/** A request's evidence in one place, its total checked (`resolve`: no op of its own). */
export function evidence(v: unknown): EvidenceSegment[] {
  const { segments, bytes } = segmentsAt(v, "evidence");
  checkEvidenceTotal(bytes, segments.length);
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
    // (`resolveWriteSlot`); a premise's table is read here (`premiseTable`), so this is reached.
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

/**
 * An op's `external_key` (04-write-and-read «按来源键写入»): every key field of the table's key, by
 * name, each once. A field not in the key, or one named twice (by case), is malformed at it; a key
 * field not given, or given `null` (not a value: the key has none), is missing.
 */
function keyEntries(
  v: unknown,
  at: string,
  t: CompiledBaseTable,
  byName: ReadonlyMap<string, CompiledBaseField>,
): [CompiledBaseField, string, unknown][] {
  if (!isObj(v)) return invalid("malformed", at);
  const keyIds = new Set<string>(t.external_key ?? []);
  const named = new Set<string>();
  const entries = keysOf(v).map((k): [CompiledBaseField, string, unknown] => {
    const f = byName.get(fold(k));
    if (f === undefined || !keyIds.has(f.id) || named.has(f.id))
      return invalid("malformed", `${at}/${k}`);
    named.add(f.id);
    const x = get(v, k);
    if (x === null) return invalid("missing", `${at}/${k}`);
    return [f, k, x];
  });
  for (const id of keyIds) {
    if (!named.has(id)) {
      const f = t.fields.find((x) => x.id === id);
      invalid("missing", `${at}/${f?.name ?? id}`);
    }
  }
  return entries;
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
      }
    | { kind: "external_key" };
  readonly ver: { op: number; restoreCount: number } | undefined;
  readonly set: [CompiledBaseField, string, unknown][] | undefined;
  readonly valid: ValidParam | undefined;
  readonly undo: { target: number; includeLater: boolean } | undefined;
  readonly acknowledge: "overwrite"[];
  readonly evidenceRefs: number[] | undefined;
  readonly evidence?: EvidenceSegment[];
  readonly evidenceByField?: {
    readonly fields: ReadonlyMap<FieldId, readonly number[]>;
    readonly valid?: readonly number[];
  };
  readonly premises?: readonly PendingPremise[];
  /**
   * `external_key`, its key fields as written: the op's target when it has no `row` (`target` is
   * `external_key`), or the key an update by `row` adds to its row.
   */
  readonly externalKey?: [CompiledBaseField, string, unknown][];
  /** `as`: the temporary name this op declares. */
  readonly as?: string;
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
    if (
      sv === undefined ||
      sv < 1 ||
      sv > input.currentSv ||
      (input.knownSv !== undefined && !input.knownSv.has(sv))
    )
      invalid("malformed", "sv");
  }
  const top = segmentsAt(get(params, "evidence"), "evidence");
  const segments = top.segments;
  const evidenceBytes = { n: top.bytes };
  if (!has(params, "ops")) invalid("missing", "ops");
  const rawOps = get(params, "ops");
  if (!isDenseArray(rawOps) || rawOps.length === 0) return invalid("malformed", "ops");
  if (rawOps.length > MAX_OPS) {
    refuse({
      code: "too_large",
      reason: "ops",
      param: "ops",
      limit: MAX_OPS,
      actual: rawOps.length,
    });
  }

  const tables = tablesOf(input);
  const zone = input.compiled.timezone;
  const warnings: WriteWarning[] = [];
  // Tables changed as a whole since the request's version, given or by fallback (07 «带旧 sv 的
  // 写入»): an op on one is refused as it is reached, before its shape is read against a structure
  // the caller did not write it for. Ops before it are read first (document order).
  const asOf = sv ?? input.fallbackSv;
  const since = asOf !== undefined && asOf < input.currentSv ? input.changedSince(asOf) : undefined;
  // Temporary names (`as`), each with the op declaring it: unique in a request.
  const names = new Map<string, number>();
  const pending = rawOps.map((o, i) =>
    readOp(o, i, tables, input, segments.length, zone, warnings, evidenceBytes, since, names),
  );
  // The request's evidence, its own and every op's, against one set of limits.
  checkEvidenceTotal(
    evidenceBytes.n,
    segments.length + pending.reduce((n, p) => n + (p.evidence?.length ?? 0), 0),
  );

  // sv compatibility: a request at an older version may not write fields changed since. Without
  // `sv`, the caller checks after its fallback (checkSvCompatibility).
  if (sv !== undefined) {
    const e = svCompatibility(
      pending.map((p) => ({ index: p.index, table: p.table.id, named: p.named })),
      sv,
      input.currentSv,
      input.changedSince,
      { versions: input.tableVersions, tables: input.compiled.tables },
    );
    if (e !== undefined) refuse(e);
  }

  // Second pass: values.
  const details: WriteValidationDetail[] = [];
  const ops = pending.map((p): NormalizedOp => {
    // The temporary names an earlier op declared: the only ones a value of this op may name.
    const before = new Set([...names].filter(([, j]) => j < p.index).map(([n]) => n));
    // `at`: a value not the op's own (a premise's key), its table and path in the details.
    // `named`: a value of the op's own `set`, which may be a temporary name.
    const value = (
      f: CompiledBaseField,
      v: unknown,
      at?: { readonly table: string; readonly path: string },
      named?: ReadonlySet<string>,
    ): NormalizedField | undefined => {
      const where = at === undefined ? {} : { table: at.table, path: at.path };
      if (v === null) {
        if (f.required === true) {
          details.push({ op: p.index, field: f.name, code: "required_missing", ...where });
          return undefined;
        }
        return { value: null, raw: null };
      }
      const r = normalizeValue(f, v, {
        op: p.index,
        name: f.name,
        zone,
        kept: true,
        ...(named !== undefined ? { names: named } : {}),
      });
      if (!r.ok) {
        details.push({ ...r.detail, ...where });
        return undefined;
      }
      warnings.push(...r.warnings);
      return { value: r.value, raw: r.raw };
    };
    let key: Record<FieldId, NormalizedField> | undefined;
    if (p.externalKey !== undefined) {
      key = {};
      for (const [f, , v] of p.externalKey) {
        const n = value(f, v);
        if (n !== undefined) key[f.id] = n;
      }
    }
    let target: NormalizedTarget;
    if (p.target.kind === "external_key") target = { kind: "external_key", key: key ?? {} };
    else if (p.target.kind === "entity_key") {
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
        const n = value(f, v, undefined, before);
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
      ...(p.evidence !== undefined ? { evidence: p.evidence } : {}),
      ...(p.evidenceByField !== undefined ? { evidenceByField: p.evidenceByField } : {}),
      ...(p.premises !== undefined
        ? {
            premises: p.premises.map((q, j): NormalizedPremise => {
              let target: NormalizedPremise["target"];
              if (q.target.kind === "entity_key") {
                const key: Record<FieldId, NormalizedField> = {};
                for (const [f, k, v] of q.target.entries) {
                  const n = value(f, v, {
                    table: qualifiedTable(input.compiled.name, q.table),
                    path: `ops/${p.index}/premises/${j}/entity_key/${k}`,
                  });
                  if (n !== undefined) key[f.id] = n;
                }
                target = { kind: "entity_key", key };
              } else if (q.target.kind === "name") target = q.target;
              else if (q.target.kind === "row")
                target = { kind: "row", row: q.target.row as `r_${string}` };
              else target = { kind: "entity", entity: q.target.entity as `e_${string}` };
              return {
                table: q.table.id,
                target,
                ...(q.fields !== undefined ? { fields: q.fields } : {}),
                ...(q.ver !== undefined ? { ver: q.ver } : {}),
                ...(q.valid !== undefined ? { valid: q.valid } : {}),
              };
            }),
          }
        : {}),
      ...(key !== undefined && p.target.kind === "row" ? { externalKey: key } : {}),
      ...(p.as !== undefined ? { as: p.as } : {}),
      named: p.named,
    };
  });
  if (details.length > 0) {
    // Every detail names its op's table, as judge's (`required_in_gap`) do (04-contract-types §9
    // `ValidationDetail.table`).
    const tableAt = new Map(
      pending.map((p) => [p.index, qualifiedTable(input.compiled.name, p.table)]),
    );
    const named = details.map((d) => {
      const { op, table, ...rest } = d;
      const t = table ?? (op !== undefined ? tableAt.get(op) : undefined);
      return {
        ...(op !== undefined ? { op } : {}),
        ...(t !== undefined ? { table: t } : {}),
        ...rest,
      };
    });
    return { ok: false, error: { code: "validation_failed", reason: "write", details: named } };
  }
  externalKeys(ops);

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

/**
 * The keys of the request's ops, their values normalized (04-write-and-read «按来源键写入»): a key
 * field in the `set` of an op by key is the key's value again or `key_field_changed`; the same key
 * twice in a request, by key or added to a row, is `duplicate_external_key` at the later one. Values
 * compare by the same-value criterion (10-types-and-units «同值判据»: the canonical text of the
 * normalized value; text is NFC, neither trimmed nor case-folded).
 */
function externalKeys(ops: readonly NormalizedOp[]): void {
  const first = new Map<string, number>();
  for (const o of ops) {
    const key = o.target.kind === "external_key" ? o.target.key : o.externalKey;
    if (key === undefined) continue;
    const at = `ops/${o.index}`;
    if (o.target.kind === "external_key" && o.fields !== undefined) {
      for (const [id, given] of Object.entries(o.fields)) {
        const held = key[id as FieldId];
        if (held === undefined) continue;
        if (canonicalize(given.value as JcsValue) !== canonicalize(held.value as JcsValue)) {
          const n = o.named.find((x) => x.field === id && x.param.startsWith(`${at}/set/`));
          invalid("key_field_changed", n?.param ?? `${at}/set`);
        }
      }
    }
    const text = canonicalize({
      table: o.table,
      key: Object.fromEntries(Object.entries(key).map(([id, v]) => [id, v.value])),
    } as JcsValue);
    const earlier = first.get(text);
    if (earlier !== undefined)
      invalid("duplicate_external_key", `${at}/external_key`, { ops: [earlier, o.index] });
    first.set(text, o.index);
  }
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
  evidenceBytes: { n: number },
  since: ChangedFields | undefined,
  names: Map<string, number>,
): PendingOp {
  const at = `ops/${i}`;
  if (!isObj(o)) return invalid("malformed", at);
  for (const k of keysOf(o)) if (!OP_KEYS.has(k)) invalid("malformed", `${at}/${k}`);
  for (const k of OP_NOT_YET) if (has(o, k)) notYet(`${at}/${k}`);
  const table = baseTable(get(o, "table"), `${at}/table`, tables, input.compiled.tables);
  const whole = since?.get(`${table.id}/*`);
  if (whole !== undefined)
    refuse({
      code: "schema_incompatible",
      param: `${at}/table`,
      current_sv: input.currentSv,
      changed_fields: [{ field: "*", change: whole }],
    });
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

  // external_key (04-write-and-read «按来源键写入»): an update or a correction on a table declaring
  // one; by key without `row`, or added to a row by an update with `row`.
  const keyed = has(o, "external_key");
  if (keyed) {
    const p = `${at}/external_key`;
    if (table.external_key === undefined) invalid("no_external_key", p);
    if (intent === "insert") invalid("insert_with_external_key", p);
    if (kind !== "write") invalid("mutually_exclusive", p);
  }

  // Target.
  const given = (["row", "entity", "entity_key"] as const).filter((k) => has(o, k));
  let target: PendingOp["target"];
  if (intent === "insert") {
    if (table.entity_key !== undefined) invalid("insert_with_entity_key", `${at}/table`);
    const [extra] = given;
    if (extra !== undefined) invalid("mutually_exclusive", `${at}/${extra}`);
    target = { kind: "new" };
  } else if (keyed && given.length === 0) {
    // By key: located by the kernel, without `ver` and without premises.
    if (has(o, "ver")) invalid("mutually_exclusive", `${at}/ver`);
    if (has(o, "premises")) invalid("premises_with_external_key", `${at}/premises`);
    target = { kind: "external_key" };
  } else {
    const [first, second] = given;
    if (second !== undefined) invalid("mutually_exclusive", `${at}/${second}`);
    if (first === undefined) return invalid("missing", `${at}/${state ? "entity" : "row"}`);
    // A key added to a row: an update only (a correction by key has no row).
    if (keyed && intent !== "update") invalid("mutually_exclusive", `${at}/external_key`);
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

  const externalKey = keyed
    ? keyEntries(get(o, "external_key"), `${at}/external_key`, table, byName)
    : undefined;

  // A temporary name (04-contract «临时名 as»): for the row an insert creates, or the row an op by
  // key creates or hits; later ops of the request write it as "@name". Unique in the request.
  let as: string | undefined;
  if (has(o, "as")) {
    const v = get(o, "as");
    if (typeof v !== "string" || !TEMP_NAME.test(v)) invalid("malformed", `${at}/as`);
    if (target.kind !== "new" && target.kind !== "external_key")
      invalid("mutually_exclusive", `${at}/as`);
    if (names.has(v as string)) invalid("duplicate_name", `${at}/as`);
    names.set(v as string, i);
    as = v as string;
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
    // A key field is given through `external_key` only: an insert giving one would let the same
    // key be inserted twice (04-write-and-read «按来源键写入»).
    if (intent === "insert" && table.external_key !== undefined) {
      const keyIds = new Set<string>(table.external_key);
      for (const [f, k] of set)
        if (keyIds.has(f.id)) invalid("insert_with_external_key", `${at}/set/${k}`);
    }
  } else if (
    kind === "write" &&
    !(intent === "update" && (has(o, "premises") || (keyed && target.kind === "row")))
  )
    // An update without `set` is a restatement or a clearing (it carries `premises`), or adds a key
    // to its row (`external_key` with `row`).
    invalid("missing", `${at}/set`);

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
      // A restatement or a clearing (no `set`) without an interval has none: from now on.
      else if (kind === "write" && has(o, "set"))
        valid = { from: { mode: "now" }, to: { mode: "next_change" } };
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
    // An empty array is as if not given (04-contract §3): a caller filling in optional fields
    // writes `[]` for "nothing to say", not "cite none of them".
    if (evidenceRefs.length === 0) evidenceRefs = undefined;
  }
  // The op's own segments (04-contract §3): only this op's. Empty: as if not given.
  let ownEvidence: EvidenceSegment[] | undefined;
  if (has(o, "evidence")) {
    const own = segmentsAt(get(o, "evidence"), `${at}/evidence`);
    if (own.segments.length > 0) ownEvidence = own.segments;
    evidenceBytes.n += own.bytes;
  }
  // Evidence by field (04-contract §3): field name, or `valid` for the interval's, → indices into
  // the segments the op sees (its own, then the request's it cites; all of them with neither).
  let evidenceByField: PendingOp["evidenceByField"];
  if (has(o, "evidence_by_field")) {
    const base = `${at}/evidence_by_field`;
    const m = get(o, "evidence_by_field");
    if (!isObj(m)) return invalid("malformed", base);
    // An undo writes no value of its own: nothing to point evidence at. An empty object is as if
    // not given, here too.
    if (kind === "undo" && keysOf(m).length > 0) invalid("mutually_exclusive", base);
    const visible =
      (ownEvidence?.length ?? 0) +
      (evidenceRefs !== undefined
        ? evidenceRefs.length
        : ownEvidence !== undefined
          ? 0
          : segmentCount);
    // The fields the op gives a value: in `set`, and a key in `entity_key` (a revoke gives none:
    // its key names the entity, and only `valid` can be mapped).
    const given = new Set<FieldId>([
      ...(set ?? []).map(([f]) => f.id),
      ...(target.kind === "entity_key" && kind !== "revoke"
        ? target.entries.map(([f]) => f.id)
        : []),
    ]);
    const fields = new Map<FieldId, number[]>();
    let valid: number[] | undefined;
    for (const k of keysOf(m)) {
      const p = `${base}/${k}`;
      if (k === "valid") {
        if (!state) invalid("not_state_table", p);
        // The interval's evidence: there must be an interval given (a whole revoke, or a write
        // from now to the next change, gives none).
        if (!has(o, "valid_from") && !has(o, "valid_to")) invalid("malformed", p);
        valid = mappedIndices(get(m, k), p, visible);
        continue;
      }
      const f = byName.get(fold(k));
      if (f === undefined) {
        refuse({ code: "unknown_field", param: p, name: k, nearest: nearest(k, table.fields) });
        continue;
      }
      // A field this op gives no value (a revoke gives none): nothing to point at. The same field
      // twice, by case: malformed at the second spelling.
      if (!given.has(f.id) || fields.has(f.id)) invalid("malformed", p);
      fields.set(f.id, mappedIndices(get(m, k), p, visible));
    }
    // An empty object is as if not given.
    if (fields.size > 0 || valid !== undefined) {
      evidenceByField = { fields, ...(valid !== undefined ? { valid } : {}) };
    }
  }
  const premises = has(o, "premises")
    ? readPremises(get(o, "premises"), at, kind, intent, tables, input, zone, warnings, i)
    : undefined;
  const named: NamedField[] = [
    ...(set ?? []).map(([f, k]) => ({ field: f.id, name: f.name, param: `${at}/set/${k}` })),
    ...(target.kind === "entity_key" ? target.entries : []).map(([f, k]) => ({
      field: f.id,
      name: f.name,
      param: `${at}/entity_key/${k}`,
    })),
    ...(externalKey ?? []).map(([f, k]) => ({
      field: f.id,
      name: f.name,
      param: `${at}/external_key/${k}`,
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
    ...(ownEvidence !== undefined ? { evidence: ownEvidence } : {}),
    ...(evidenceByField !== undefined ? { evidenceByField } : {}),
    ...(premises !== undefined ? { premises } : {}),
    ...(externalKey !== undefined ? { externalKey } : {}),
    ...(as !== undefined ? { as } : {}),
    named,
  };
}

/** One premise as step 1 reads it: its key values not normalized yet. */
interface PendingPremise {
  readonly table: CompiledBaseTable;
  readonly target:
    | { kind: "row"; row: string }
    | { kind: "name"; name: string }
    | { kind: "entity"; entity: string }
    | { kind: "entity_key"; entries: [CompiledBaseField, string, unknown][] };
  readonly fields?: FieldId[];
  readonly ver?: { op: number; restoreCount: number };
  readonly valid?: NormalizedPremise["valid"];
}

/**
 * An op's `premises` (04-contract §5 «写入的前提»; 02-integrity «一条声明有什么», «哪些 op 可以带»):
 * the shape of each, by step 1's rules. What depends on the tenant's state (the target there, the
 * op's own target, one target twice once resolved, the version's row, how many point at it) is
 * step 5's.
 */
function readPremises(
  v: unknown,
  at: string,
  kind: PendingOp["kind"],
  intent: Intent | undefined,
  tables: Tables,
  input: NormalizeWriteInput,
  zone: string,
  warnings: WriteWarning[],
  i: number,
): PendingPremise[] {
  const base = `${at}/premises`;
  if (kind === "undo") invalid("premises_with_revert", base);
  if (kind === "revoke") invalid("premises_with_revoke", base);
  if (!isDenseArray(v)) return invalid("malformed", base);
  // A clearing is an update's (02-integrity «哪些 op 可以带»).
  if (v.length === 0 && intent !== "update") invalid("malformed", base);
  if (v.length > MAX_PREMISES) {
    refuse({
      code: "too_large",
      reason: "premise_entries",
      param: base,
      limit: MAX_PREMISES,
      actual: v.length,
    });
  }
  return v.map((p, j): PendingPremise => {
    const pat = `${base}/${j}`;
    if (!isObj(p)) return invalid("malformed", pat);
    for (const k of keysOf(p)) if (!PREMISE_KEYS.has(k)) invalid("malformed", `${pat}/${k}`);
    const table = premiseTable(get(p, "table"), `${pat}/table`, tables, input.compiled.tables);
    const byName = fieldsByName(table);
    const state = table.time.type === "state";
    // The target: exactly one of row, entity, entity_key; as an op's, without a temporary name.
    const given = (["row", "entity", "entity_key"] as const).filter((k) => has(p, k));
    const [first, second] = given;
    if (second !== undefined) invalid("mutually_exclusive", `${pat}/${second}`);
    if (first === undefined) return invalid("missing", `${pat}/${state ? "entity" : "row"}`);
    const t = get(p, first);
    let target: PendingPremise["target"];
    if (first === "row") {
      if (state) invalid("state_table", `${pat}/row`);
      // A temporary name ("@name"): the row an earlier op of the request binds it to, resolved by
      // the write path (02-integrity «能指向什么 · 本请求里新建的行»).
      if (typeof t === "string" && t.startsWith("@") && TEMP_NAME.test(t.slice(1)))
        target = { kind: "name", name: t.slice(1) };
      else {
        if (typeof t !== "string" || !isId("row", t)) invalid("malformed", `${pat}/row`);
        target = { kind: "row", row: t as string };
      }
    } else if (first === "entity") {
      if (!state) invalid("not_state_table", `${pat}/entity`);
      if (typeof t !== "string" || !isId("entity", t)) invalid("malformed", `${pat}/entity`);
      target = { kind: "entity", entity: t as string };
    } else {
      if (!state) invalid("not_state_table", `${pat}/entity_key`);
      if (table.entity_key === undefined) invalid("malformed", `${pat}/entity_key`);
      if (!isObj(t)) return invalid("malformed", `${pat}/entity_key`);
      const keyIds = new Set(table.entity_key as readonly string[]);
      const keyNamed = new Set<string>();
      const entries = keysOf(t).map((k): [CompiledBaseField, string, unknown] => {
        const f = byName.get(fold(k));
        if (f === undefined || !keyIds.has(f.id) || keyNamed.has(f.id))
          return invalid("malformed", `${pat}/entity_key/${k}`);
        keyNamed.add(f.id);
        return [f, k, get(t, k)];
      });
      for (const id of keyIds) {
        if (!keyNamed.has(id)) {
          const f = table.fields.find((x) => x.id === id);
          invalid("missing", `${pat}/entity_key/${f?.name ?? id}`);
        }
      }
      target = { kind: "entity_key", entries };
    }
    // fields: names of the target's table, each once; none given is the whole row, so an empty
    // list says nothing a missing one does not and is malformed.
    let fields: FieldId[] | undefined;
    if (has(p, "fields")) {
      const fs = get(p, "fields");
      if (!isDenseArray(fs) || fs.length === 0) return invalid("malformed", `${pat}/fields`);
      fields = [];
      for (const [k, x] of fs.entries()) {
        if (typeof x !== "string") return invalid("malformed", `${pat}/fields/${k}`);
        const f = byName.get(fold(x));
        if (f === undefined)
          return refuse({
            code: "unknown_field",
            param: `${pat}/fields/${k}`,
            name: x,
            nearest: nearest(x, table.fields),
          });
        if (fields.includes(f.id)) return invalid("malformed", `${pat}/fields/${k}`);
        fields.push(f.id);
      }
    }
    // ver: a current version's writing; a historical one (as_of's `h…`) is refused by its own
    // reason, whatever the version's state (04-contract §5).
    let ver: PendingPremise["ver"];
    if (has(p, "ver")) {
      const x = get(p, "ver");
      if (typeof x === "string" && HISTORICAL_VER.test(x))
        invalid("premise_historical_ver", `${pat}/ver`);
      const m = typeof x === "string" ? VER.exec(x) : null;
      if (m === null) return invalid("malformed", `${pat}/ver`);
      const op = Number(m[1]);
      const restoreCount = Number(m[2]);
      if (!Number.isSafeInteger(op) || !Number.isSafeInteger(restoreCount))
        invalid("malformed", `${pat}/ver`);
      ver = { op, restoreCount };
    }
    // Business time: state tables only, a point or a stretch, not both.
    const hasAt = has(p, "valid_at");
    const hasDuring = has(p, "valid_during");
    let valid: PendingPremise["valid"];
    if (hasAt || hasDuring) {
      const which = hasAt ? "valid_at" : "valid_during";
      if (!state) invalid("not_state_table", `${pat}/${which}`);
      if (hasAt && hasDuring) invalid("mutually_exclusive", `${pat}/valid_during`);
      const c: PointCtx = {
        op: i,
        granularity: (table.time as { granularity: "date" | "instant" }).granularity,
        zone,
        warnings,
      };
      if (hasAt) valid = { at: bizPoint(get(p, "valid_at"), `${pat}/valid_at`, c) };
      else {
        const d = get(p, "valid_during");
        if (!isDenseArray(d) || d.length !== 2) return invalid("malformed", `${pat}/valid_during`);
        const from = bizPoint(d[0], `${pat}/valid_during/0`, c);
        const to = d[1] === null ? null : bizPoint(d[1], `${pat}/valid_during/1`, c);
        if (to !== null && !(from < to)) invalid("malformed", `${pat}/valid_during/1`);
        valid = { during: { from, to } };
      }
    }
    return {
      table,
      target,
      ...(fields !== undefined ? { fields } : {}),
      ...(ver !== undefined ? { ver } : {}),
      ...(valid !== undefined ? { valid } : {}),
    };
  });
}

/**
 * A premise's table: a base table of the request's slot. A derived table is not in this version
 * (`not_in_this_version`, `value`: 02-integrity «能指向什么»), not `derived_readonly`, as nothing is
 * written to it; a table of another slot is `cross_slot` as for an op's.
 */
function premiseTable(
  v: unknown,
  at: string,
  t: Tables,
  compiled: readonly CompiledTable[],
): CompiledBaseTable {
  if (typeof v === "string" && v !== "") {
    const [slot, name] = splitTableName(v);
    const table =
      slot === undefined || fold(slot) === fold(t.slot) ? t.byName.get(fold(name)) : undefined;
    if (table?.kind === "derived") return notYet(at, "value");
  }
  return baseTable(v, at, t, compiled);
}

/**
 * The indices a field (or `valid`) is mapped to (04-contract §3): a non-empty array
 * (`empty_mapping`), each an index of a segment the op sees (`index_out_of_range`), none twice.
 */
function mappedIndices(v: unknown, at: string, visible: number): number[] {
  if (!isDenseArray(v)) return invalid("malformed", at);
  if (v.length === 0) return invalid("empty_mapping", at);
  const out: number[] = [];
  for (const [k, x] of v.entries()) {
    const n = intOf(x);
    if (n === undefined || out.includes(n)) return invalid("malformed", `${at}/${k}`);
    if (n < 0 || n >= visible) return invalid("index_out_of_range", `${at}/${k}`);
    out.push(n);
  }
  return out;
}

// --- sv compatibility (04-contract §2; 04-contract-types §9 `schema_incompatible`) ---------------

interface OpFields {
  readonly index: number;
  readonly table: TableId;
  readonly named: readonly NamedField[];
}

/** The slot's tables now, and the versions each is in (`NormalizeWriteInput.tableVersions`). */
interface TablesInVersions {
  readonly versions: TableVersions | undefined;
  readonly tables: readonly { readonly id: string; readonly name: string }[];
}

function svCompatibility(
  ops: readonly OpFields[],
  sv: number,
  currentSv: number,
  changedSince: (sv: number) => ChangedFields,
  inVersions: TablesInVersions,
): RequestError | undefined {
  if (sv >= currentSv) return undefined;
  // A table the version does not have (added since): its name is not there in that version.
  const inVersion = (id: string) => {
    const span = inVersions.versions?.get(id);
    return span === undefined || (span.from <= sv && sv <= span.to);
  };
  for (const op of ops) {
    if (inVersion(op.table)) continue;
    const name = inVersions.tables.find((t) => t.id === op.table)?.name ?? op.table;
    return {
      code: "unknown_table",
      param: `ops/${op.index}/table`,
      name,
      nearest: nearest(
        name,
        inVersions.tables.filter((t) => inVersion(t.id)),
      ),
    };
  }
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
  /** As `NormalizeWriteInput.tableVersions`, with the slot's tables now. */
  readonly tableVersions?: TableVersions;
  readonly tables?: readonly { readonly id: string; readonly name: string }[];
}): RequestError | undefined {
  return svCompatibility(input.request.ops, input.sv, input.currentSv, input.changedSince, {
    versions: input.tableVersions,
    tables: input.tables ?? [],
  });
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
