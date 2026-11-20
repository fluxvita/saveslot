// What both paths of `schema_draft` share (docs/zh-CN/spec/04-contract.md §10 `schema_draft`):
// its error, the change record by names, the parameters, the request key, the tenant's numbering.

import { createHash } from "node:crypto";
import type {
  CompiledSchema,
  DraftId,
  KernelErrorCode,
  KernelErrorDetail,
  KernelErrorReason,
  SchemaChangeRecord,
} from "@fluxvita/saveslot-contract-core";
import type { ReadTx } from "../store/ports.ts";
import { randomCrockford } from "./ids.ts";

/** An error of `schema_draft`, by contract error code (04-contract-types §9). */
export class SchemaDraftError<C extends KernelErrorCode = KernelErrorCode> extends Error {
  override readonly name = "SchemaDraftError";
  readonly code: C;
  readonly detail: KernelErrorDetail<C>;
  constructor(code: C, message: string, detail: KernelErrorDetail<C> = {}) {
    super(message);
    this.code = code;
    this.detail = detail;
  }
}

/** 04-contract-types §5.3 `SchemaChange`: the logged change record, its target by names. */
export interface SchemaChange extends Omit<SchemaChangeRecord, "target"> {
  readonly target:
    | { readonly slot: true }
    | { readonly table: string; readonly field?: string; readonly rule?: true };
}

export const PARAM_KEYS = new Set(["document", "task", "idempotency_key"]);
const MAX_TAG_CHARS = 256;
// biome-ignore lint/suspicious/noControlCharactersInRegex: control characters are what it finds
const CONTROL = /[\u0000-\u001f\u007f-\u009f]/u;

export const own = (o: object, k: string) => Object.hasOwn(o, k);
export const isObject = (v: unknown): v is Record<string, unknown> =>
  typeof v === "object" && v !== null && !Array.isArray(v);
export const invalid = (
  reason: KernelErrorReason<"invalid_argument">,
  param: string,
  extra: Record<string, unknown> = {},
) => new SchemaDraftError("invalid_argument", `${param}: ${reason}`, { ...extra, reason, param });

/** `task` / `idempotency_key`: as the write takes them (at most 256 characters, no control characters). */
export function tag(params: Record<string, unknown>, key: string): string | undefined {
  if (!own(params, key)) return undefined;
  const v = params[key];
  if (
    typeof v !== "string" ||
    v.length === 0 ||
    !v.isWellFormed() ||
    [...v].length > MAX_TAG_CHARS ||
    CONTROL.test(v)
  )
    throw invalid("malformed", key);
  return v;
}

export const sha256 = (s: string) => createHash("sha256").update(s, "utf8").digest("hex");
export const newSlotId = (): `sl_${string}` => `sl_${randomCrockford(16)}`;
export const newDraftId = (): DraftId => `d_${randomCrockford(16)}`;

/**
 * A slot ID never used in the tenant: not a slot's now, nor a removed slot's (its versions stay,
 * process/decisions/remove-empty-slot.md §4), so that the log's events of a slot always mean it.
 */
export async function unusedSlotId(tx: ReadTx): Promise<`sl_${string}`> {
  for (;;) {
    const id = newSlotId();
    const r = await tx.query(
      `SELECT 1 FROM slots WHERE id = $1 UNION ALL SELECT 1 FROM schema_versions WHERE slot_id = $1`,
      [id],
    );
    if (r.rows.length === 0) return id;
  }
}

/** The highest number of an ID like `t12` / `r3` among `ids`. */
export const highest = (ids: readonly string[], prefix: string) =>
  Math.max(
    0,
    ...ids.filter((x) => x.startsWith(prefix)).map((x) => Number(x.slice(prefix.length))),
  );

/** The slot names in use, and the next free table and rule numbers of the tenant (any version). */
export async function numbering(tx: ReadTx) {
  const names = await tx.query<{ name: string }>("SELECT name FROM slots");
  const compiled = await tx.query<{ body: string | null }>(
    `SELECT c.body FROM schema_versions v
     JOIN content c ON c.seq = v.compiled_seq AND c.path = 'compiled'`,
  );
  const tables: string[] = [];
  const rules: string[] = [];
  for (const x of compiled.rows) {
    if (x.body === null) continue;
    const c = JSON.parse(x.body) as CompiledSchema;
    for (const t of c.tables) {
      tables.push(t.id);
      if (t.kind === "derived") rules.push(t.rule.id);
    }
  }
  return {
    existingSlotNames: names.rows.map((x) => x.name),
    nextTableNumber: highest(tables, "t") + 1,
    nextRuleNumber: highest(rules, "r") + 1,
  };
}
