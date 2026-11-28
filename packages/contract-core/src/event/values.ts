// Value encodings of event format v1 (docs/zh-CN/spec/09-event-format.md §1.2–§1.4) and the
// identifier shapes of docs/zh-CN/spec/03-data-model/01-objects.md «标识的写法».
//
// Identifier and value types are template literal types rather than nominal brands: they reject
// wrong prefixes and JSON numbers where strings are required at compile time, while the spec's
// examples type-check as written. Lengths and alphabets cannot be expressed in a type; the runtime
// predicates below check the full shape.

// ---------------------------------------------------------------------------------------------
// Identifiers (§1.4)

/** Tenant ID: `tn_` + 26 Crockford Base32 characters (128 random bits). */
export type TenantId = `tn_${string}`;
/** User principal ID: `u_` + 26 characters. */
export type UserId = `u_${string}`;
/** Connection instance ID: `ci_` + 26 characters. */
export type ConnectionId = `ci_${string}`;
/** The kernel itself as a principal: a fixed value, not a reserved value (§6). */
export type SystemPrincipal = "system";
/** Any principal that can be an event's `actor`. */
export type PrincipalId = UserId | ConnectionId | SystemPrincipal;
/** A principal that a caller authenticates as (everything but `system`). */
export type CallerId = UserId | ConnectionId;
/** Node ID (`node_id`, §2.2): `n_` + 26 characters. */
export type NodeId = `n_${string}`;
/** Slot ID: `sl_` + 16 characters (80 random bits). */
export type SlotId = `sl_${string}`;
/** Source ID as shown to callers (`s_…`); events reference a source by its `source.recorded` seq. */
export type SourceId = `s_${string}`;
/** Pending item ID; a deletion ID is the same ID (§1.4). */
export type ItemId = `pi_${string}`;
/** Schema draft ID. */
export type DraftId = `d_${string}`;
/** Schema migration ID. */
export type MigrationId = `m_${string}`;
/** Derived row `partition_id`. */
export type PartitionId = `p_${string}`;
/** One restore (`restore_id`). */
export type RestoreId = `rs_${string}`;
/** Row ID (event tables and timeless tables): `r_` + UUIDv7 as 26 characters. */
export type RowId = `r_${string}`;
/** Entity ID (state tables): `e_` + UUIDv7 as 26 characters. */
export type EntityId = `e_${string}`;
/** Table ID: `t<n>`, unique in the tenant, increasing, never reused. */
export type TableId = `t${number}`;
/** Field ID: `f<n>`, unique in its table, increasing, never reused. */
export type FieldId = `f${number}`;
/** Derived rule ID: `r<n>`. Distinct from RowId: a row ID has `_` after the `r`. */
export type RuleId = `r${number}`;

// ---------------------------------------------------------------------------------------------
// Numbers (§1.2, §1.4): JSON numbers in 0 .. 2^53 − 1. Type aliases document intent only.

/** Position of an event in the log, from 1. */
export type Seq = number;
/** Operation number: the `seq` of the operation's head event (§4.1). */
export type OpNumber = number;
/** A decimal index in a path or a block (`<i>`, `<j>`, `<k>`, `<n>`), from 0. */
export type Index = number;
/** Schema version (`sv`), version numbers and counts. */
export type VersionNumber = number;

/** Largest integer a JSON number in the event format may carry (§1.2). */
export const MAX_EVENT_INTEGER = Number.MAX_SAFE_INTEGER;

// ---------------------------------------------------------------------------------------------
// Strings with a fixed syntax (§1.2)

/** UTC instant with millisecond precision: `2026-11-10T04:41:07.123Z`. */
export type Instant = `${number}-${number}-${number}T${number}:${number}:${number}.${number}Z`;
/** Calendar date: `YYYY-MM-DD`. */
export type DateStr = `${number}-${number}-${number}`;
/** A point in business time: a date on `date`-granularity tables, an instant on `instant` ones. */
export type BizPoint = DateStr | Instant;
/**
 * Decimal number in canonical form (§1.2): every decimal saveslot computes or converts (field
 * values in `fields/*`, results and entries, `quantity.value`, compiled `min` / `max` / `to_base`,
 * `backfill.const`, derived results). `-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?`, zero is `"0"`, never
 * `"-0"`. Never a JSON number. The type admits any numeric string; `isCanonicalDecimal` checks the
 * exact form (a template literal type cannot exclude `"1.0"`, `"-0"` or `"01"`).
 */
export type DecimalString = `${number}`;
/** An `integer` field value in canonical form: a canonical decimal without a fraction (§1.3). */
export type IntegerString = `${number}`;
/**
 * A decimal as the caller gave it (§1.3): recorded verbatim, not canonicalized; when the caller sent
 * a JSON number, its number text. Only in raw values (`ops/<i>/set/*`) and `request` blocks.
 */
export type RawDecimalString = `${number}`;
/** SHA-256 as 64 lowercase hexadecimal characters (hashes and checksums). */
export type Hash = string;
/** IANA time zone name (`Asia/Shanghai`). */
export type TimeZoneName = string;
/** Unit code from the unit vocabulary `units@1` (`CNY`, `km`). */
export type UnitCode = string;

/**
 * Business time interval (§1.2): left-closed, right-open; `to` absent means "continues".
 * Points are dates or instants by the table's granularity.
 */
export interface BizInterval {
  readonly from: BizPoint;
  readonly to?: BizPoint;
}

/** An interval that may also be open at the start (deletion result gaps, §5.9). */
export interface OpenBizInterval {
  readonly from?: BizPoint;
  readonly to?: BizPoint;
}

// ---------------------------------------------------------------------------------------------
// Field values (§1.3)

/** `zoned_datetime` value. */
export interface ZonedDateTimeValue {
  readonly instant: Instant;
  readonly zone: TimeZoneName;
}

/** `quantity` value: converted to the field's unit in normalized values; the caller's unit in raw values. */
export interface QuantityValue {
  readonly value: DecimalString;
  readonly unit: UnitCode;
}

/**
 * A field value by field type (§1.3):
 * text / enum → string; integer / decimal → decimal string; boolean → boolean; date → date string;
 * zoned_datetime → object; quantity → object; ref → row or entity ID (a string);
 * `null` → an optional field explicitly set empty (a sourced value, not an absent one).
 */
export type FieldValue = string | boolean | ZonedDateTimeValue | QuantityValue | null;

/** `quantity` raw value: the caller's number text and the caller's unit. */
export interface RawQuantityValue {
  readonly value: RawDecimalString;
  readonly unit: UnitCode;
}

/**
 * A raw value (§1.3), as recorded in `ops/<i>/set/<field>`: the same shapes as FieldValue, but
 * decimals are verbatim caller text (RawDecimalString) and units are the caller's.
 */
export type RawFieldValue = string | boolean | ZonedDateTimeValue | RawQuantityValue | null;

// ---------------------------------------------------------------------------------------------
// JSON values (the `draft` and `request` blocks carry arbitrary JSON)

export type JsonValue =
  | null
  | boolean
  | number
  | string
  | readonly JsonValue[]
  | { readonly [key: string]: JsonValue };
export type JsonObject = { readonly [key: string]: JsonValue };

// ---------------------------------------------------------------------------------------------
// Runtime shape predicates

const CROCKFORD = "[0-9A-HJKMNP-TV-Z]";
/** The `n` of a short ID: from 1, no leading zeros, at most 9 digits (01-objects «标识的写法»). */
const SHORT_NUMBER = "[1-9][0-9]{0,8}";

/**
 * Full syntax of each identifier kind (01-objects.md «标识的写法»). Short IDs (`t<n>`, `f<n>`,
 * `r<n>`): `n` is a decimal integer from 1 without leading zeros, at most 9 digits, so physical
 * table names stay well within PostgreSQL's 63-byte identifiers (01-objects «标识的写法»).
 */
export const ID_PATTERNS = {
  tenant: new RegExp(`^tn_${CROCKFORD}{26}$`),
  user: new RegExp(`^u_${CROCKFORD}{26}$`),
  connection: new RegExp(`^ci_${CROCKFORD}{26}$`),
  node: new RegExp(`^n_${CROCKFORD}{26}$`),
  slot: new RegExp(`^sl_${CROCKFORD}{16}$`),
  source: new RegExp(`^s_${CROCKFORD}{16}$`),
  item: new RegExp(`^pi_${CROCKFORD}{16}$`),
  draft: new RegExp(`^d_${CROCKFORD}{16}$`),
  migration: new RegExp(`^m_${CROCKFORD}{16}$`),
  partition: new RegExp(`^p_${CROCKFORD}{16}$`),
  restore: new RegExp(`^rs_${CROCKFORD}{16}$`),
  row: new RegExp(`^r_${CROCKFORD}{26}$`),
  entity: new RegExp(`^e_${CROCKFORD}{26}$`),
  table: new RegExp(`^t${SHORT_NUMBER}$`),
  field: new RegExp(`^f${SHORT_NUMBER}$`),
  rule: new RegExp(`^r${SHORT_NUMBER}$`),
} as const;

export type IdKind = keyof typeof ID_PATTERNS;

export function isId(kind: IdKind, s: string): boolean {
  return ID_PATTERNS[kind].test(s);
}

const INSTANT_RE = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}\.\d{3}Z$/;
const DATE_RE = /^\d{4}-\d{2}-\d{2}$/;
const HASH_RE = /^[0-9a-f]{64}$/;
/** §1.2 canonical decimal; `-0` is excluded separately. */
const CANONICAL_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]*[1-9])?$/;
const CANONICAL_INTEGER_RE = /^-?(0|[1-9][0-9]*)$/;
/**
 * Raw decimal text (§1.3): the JSON number grammar (RFC 8259 §6), for a caller's decimal string and
 * a caller's JSON number text alike. Exponents are allowed; leading zeros are not.
 */
const RAW_DECIMAL_RE = /^-?(0|[1-9][0-9]*)(\.[0-9]+)?([eE][+-]?[0-9]+)?$/;

/** A syntactically and calendrically valid UTC instant with millisecond precision. */
export function isInstant(s: string): boolean {
  if (!INSTANT_RE.test(s)) return false;
  const t = Date.parse(s);
  return Number.isFinite(t) && new Date(t).toISOString() === s;
}

/** A syntactically and calendrically valid `YYYY-MM-DD` date. */
export function isDate(s: string): boolean {
  return DATE_RE.test(s) && isInstant(`${s}T00:00:00.000Z`);
}

export function isHash(s: string): boolean {
  return HASH_RE.test(s);
}

/** A decimal in the §1.2 canonical form: no exponent, sign `+`, leading or trailing zeros, or `-0`. */
export function isCanonicalDecimal(s: string): boolean {
  return CANONICAL_DECIMAL_RE.test(s) && s !== "-0";
}

/** An `integer` value in canonical form: a canonical decimal without a fraction. */
export function isCanonicalInteger(s: string): boolean {
  return CANONICAL_INTEGER_RE.test(s) && s !== "-0";
}

/**
 * A raw decimal as a caller may give it (verbatim; not canonical): the JSON number grammar, as a
 * string or as a JSON number's text (§1.3). Exponents are allowed; leading zeros, `+1`, `.5` and
 * `1.` are not. Every canonical decimal is raw too.
 */
export function isRawDecimal(s: string): boolean {
  return RAW_DECIMAL_RE.test(s);
}

/** An integer the event format may carry: 0 .. 2^53 − 1 (§1.2). */
export function isEventInteger(n: unknown): n is number {
  return typeof n === "number" && Number.isSafeInteger(n) && n >= 0;
}
