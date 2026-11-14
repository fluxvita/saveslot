// Path vocabulary of event format v1 (docs/zh-CN/spec/09-event-format.md §3.1, §5).
//
// VOCABULARY is the complete set of content block paths per event type: `apply` parses strictly
// (§1.6), so a path that matches no entry makes an event invalid. Each entry gives the path
// pattern, the block kind (`meta`: metadata block; `data`: data block, §1.1) and the shape name
// (a key of BlockShapes in ./blocks.ts). `always: true` marks blocks every event of the type has.
//
// Pattern syntax: segments joined by `/`. A segment is a fixed word (`[a-z_]+`), or one of the
// placeholders `<table>` (a table ID), `<field>` (a field ID) or `<n>` (a decimal index). Fixed
// words and the two ID kinds are disjoint (IDs contain a digit; words do not), so at most one
// entry of a type matches a concrete path; the tests check this for every entry.
//
// The TypeScript type of each event's blocks (EventBlocks) is derived from this table, so the
// runtime vocabulary and the static types cannot drift apart.

import type { BlockShapeName, BlockShapes } from "./blocks.ts";
import type { EventType } from "./enums.ts";
import { type FieldId, ID_PATTERNS, MAX_EVENT_INTEGER, type TableId } from "./values.ts";

export type BlockKind = "meta" | "data";

export interface VocabularyEntry {
  readonly path: string;
  readonly kind: BlockKind;
  readonly shape: BlockShapeName;
  readonly always?: true;
}

/**
 * §5.1: request identification blocks of caller-initiated head events. `ctx` is listed per type,
 * because its keys differ (see the `*Ctx` shapes).
 */
const REQUEST_ID_BLOCKS = [
  { path: "task", kind: "data", shape: "Task" },
  { path: "request_key", kind: "data", shape: "RequestKey" },
  { path: "idempotency", kind: "data", shape: "Idempotency" },
] as const;

/** §5.9: result and restatement blocks shared by `deletion.confirmed` and `deletion.cancelled`. */
const DELETION_RESULT_BLOCKS = [
  { path: "results/<n>/target", kind: "meta", shape: "ResultTarget" },
  { path: "results/<n>/fields/<field>/<n>", kind: "data", shape: "ResultField" },
  { path: "results/<n>/existence", kind: "data", shape: "ResultExistence" },
  { path: "restated/<n>", kind: "data", shape: "Restated" },
  { path: "recreated/<n>", kind: "meta", shape: "Recreated" },
] as const;

export const VOCABULARY = {
  // §5.2
  "tenant.genesis": [
    { path: "tenant", kind: "meta", shape: "GenesisTenant", always: true },
    { path: "user", kind: "meta", shape: "UserPrincipal", always: true },
    { path: "system", kind: "meta", shape: "SystemPrincipal", always: true },
  ],
  "tenant.restored": [],
  "tenant.imported": [
    { path: "tenant", kind: "meta", shape: "ImportedTenant", always: true },
    { path: "user", kind: "meta", shape: "UserPrincipal", always: true },
    { path: "export", kind: "meta", shape: "ImportedExport", always: true },
  ],
  // §5.3: v1 principal events carry `ctx` but no `task`, `request_key` or `idempotency`.
  "principal.registered": [
    { path: "ctx", kind: "meta", shape: "PrincipalCtx", always: true },
    { path: "principal", kind: "meta", shape: "RegisteredPrincipal", always: true },
    { path: "name", kind: "data", shape: "PrincipalName", always: true },
  ],
  "principal.renamed": [
    { path: "ctx", kind: "meta", shape: "PrincipalCtx", always: true },
    { path: "principal", kind: "meta", shape: "PrincipalRef", always: true },
    { path: "name", kind: "data", shape: "PrincipalName", always: true },
  ],
  "principal.revoked": [
    { path: "ctx", kind: "meta", shape: "PrincipalCtx", always: true },
    { path: "principal", kind: "meta", shape: "PrincipalRef", always: true },
  ],
  // §5.4: as a member event (the head event form is reserved), so no `ctx`.
  "slot.policy_set": [{ path: "policy", kind: "meta", shape: "Policy", always: true }],
  // §5.5
  "schema.draft_submitted": [
    { path: "ctx", kind: "meta", shape: "SlotCtx", always: true },
    ...REQUEST_ID_BLOCKS,
    { path: "target", kind: "meta", shape: "DraftSubmittedTarget", always: true },
    { path: "draft", kind: "data", shape: "Draft", always: true },
  ],
  "schema.compiled": [
    { path: "target", kind: "meta", shape: "CompiledTarget", always: true },
    { path: "compiled", kind: "data", shape: "Compiled", always: true },
    { path: "changes", kind: "meta", shape: "Changes", always: true },
  ],
  "schema.confirmed": [{ path: "target", kind: "meta", shape: "ConfirmedTarget", always: true }],
  "schema.rejected": [{ path: "target", kind: "meta", shape: "RejectedTarget", always: true }],
  "schema.superseded": [
    { path: "target", kind: "meta", shape: "SchemaSupersededTarget", always: true },
  ],
  "schema.migration_started": [
    { path: "target", kind: "meta", shape: "MigrationStartedTarget", always: true },
  ],
  "schema.switched": [
    { path: "target", kind: "meta", shape: "SwitchedTarget", always: true },
    { path: "tables/<table>", kind: "data", shape: "SwitchedTable" },
    { path: "backfill_rows/<table>/<field>/<n>", kind: "meta", shape: "BackfillRows" },
    { path: "backfill/<table>/<field>/<n>", kind: "data", shape: "BackfillSegment" },
  ],
  "schema.migration_failed": [
    { path: "target", kind: "meta", shape: "MigrationFailedTarget", always: true },
  ],
  // §5.6: exactly one of `text`, `file`, `request`.
  "source.recorded": [
    { path: "target", kind: "meta", shape: "SourceTarget", always: true },
    { path: "text", kind: "data", shape: "SourceText" },
    { path: "file", kind: "data", shape: "SourceFile" },
    { path: "request", kind: "data", shape: "SourceRequest" },
    { path: "stated_at", kind: "data", shape: "StatedAt" },
  ],
  // §5.7
  "write.head": [
    { path: "ctx", kind: "meta", shape: "WriteCtx", always: true },
    ...REQUEST_ID_BLOCKS,
    { path: "request", kind: "meta", shape: "WriteRequest", always: true },
    { path: "ops/<n>/target", kind: "meta", shape: "OpTarget" },
    { path: "ops/<n>/set/<field>", kind: "data", shape: "RawValue" },
    { path: "ops/<n>/noop", kind: "meta", shape: "FieldIdList" },
    { path: "ops/<n>/valid", kind: "data", shape: "ValidParam" },
    { path: "ops/<n>/revert", kind: "meta", shape: "OpRevert" },
    { path: "ops/<n>/acknowledge", kind: "meta", shape: "Acknowledge" },
    { path: "ops/<n>/named_fields", kind: "meta", shape: "FieldIdList" },
    { path: "ops/<n>/refs", kind: "data", shape: "Refs" },
    { path: "ops/<n>/baseline", kind: "meta", shape: "Baseline" },
    { path: "ops/<n>/premises/<n>", kind: "meta", shape: "Premise" },
    { path: "ops/<n>/premise_valid/<n>", kind: "data", shape: "PremiseValid" },
    { path: "ops/<n>/premise_covers", kind: "meta", shape: "PremiseCovers" },
    { path: "ops/<n>/premises_cleared", kind: "meta", shape: "PremisesCleared" },
  ],
  "write.base": [
    { path: "target", kind: "meta", shape: "WriteBaseTarget", always: true },
    { path: "fields/<field>/<n>", kind: "data", shape: "FieldItem" },
    { path: "sources/<field>/<n>", kind: "data", shape: "Sources" },
    { path: "literal/<field>/<n>", kind: "data", shape: "Literal" },
    { path: "span/<field>/<n>", kind: "data", shape: "Span" },
    { path: "existence/<n>", kind: "meta", shape: "ExistenceItem" },
    { path: "span/existence/<n>", kind: "data", shape: "ExistenceSpan" },
    { path: "valid_sources", kind: "meta", shape: "SourceSeqList" },
    { path: "op_sources", kind: "meta", shape: "SourceSeqList" },
    { path: "duplicate", kind: "data", shape: "Duplicate" },
    { path: "ack/<n>", kind: "data", shape: "Ack" },
    { path: "revert", kind: "meta", shape: "Revert" },
    { path: "take", kind: "meta", shape: "Take" },
  ],
  "write.derived": [
    { path: "target", kind: "meta", shape: "DerivedTarget", always: true },
    { path: "key", kind: "data", shape: "DerivedKey" },
    { path: "checksum", kind: "data", shape: "Checksum" },
  ],
  // §5.8
  "item.created": [
    { path: "target", kind: "meta", shape: "ItemCreatedTarget", always: true },
    { path: "scope_valid", kind: "data", shape: "ScopeValid" },
    { path: "current/<n>", kind: "data", shape: "CurrentEntry" },
    { path: "candidates/<n>", kind: "data", shape: "Candidate" },
    { path: "proposed/<n>", kind: "data", shape: "FieldEntry" },
    { path: "previous/<n>", kind: "data", shape: "FieldEntry" },
    { path: "impact/<n>", kind: "data", shape: "Impact" },
    { path: "matched/<n>", kind: "data", shape: "Matched" },
  ],
  "item.merged": [
    { path: "target", kind: "meta", shape: "ItemMergedTarget", always: true },
    { path: "candidates/<n>", kind: "data", shape: "Candidate" },
    { path: "scope_valid", kind: "data", shape: "ScopeValid" },
    { path: "previous/<n>", kind: "data", shape: "FieldEntry" },
    { path: "impact/<n>", kind: "data", shape: "Impact" },
  ],
  "item.refreshed": [
    { path: "target", kind: "meta", shape: "ItemRefreshedTarget", always: true },
    { path: "current/<n>", kind: "data", shape: "CurrentEntry" },
    { path: "previous/<n>", kind: "data", shape: "FieldEntry" },
    { path: "impact/<n>", kind: "data", shape: "Impact" },
    { path: "proposed/<n>", kind: "data", shape: "FieldEntry" },
    { path: "scope_valid", kind: "data", shape: "ScopeValid" },
    { path: "candidates/<n>", kind: "data", shape: "Candidate" },
    { path: "matched/<n>", kind: "data", shape: "Matched" },
  ],
  "item.superseded": [
    { path: "target", kind: "meta", shape: "ItemSupersededTarget", always: true },
  ],
  "item.resolved": [
    { path: "ctx", kind: "meta", shape: "ResolveCtx", always: true },
    ...REQUEST_ID_BLOCKS,
    { path: "target", kind: "meta", shape: "ItemResolvedTarget", always: true },
    { path: "op_sources", kind: "meta", shape: "SourceSeqList" },
    { path: "confirmation", kind: "data", shape: "Confirmation" },
  ],
  // §5.9
  // TODO(apply-parser): `origin` ↔ actor, for `deletion.confirmed` and `deletion.cancelled`:
  // `request` comes from the caller (no `trigger`); `restored_*` (confirmed) and `restore_cancel`
  // (cancelled) come from `system` with `trigger: "restore"`. Not expressible in these types.
  "deletion.confirmed": [
    { path: "ctx", kind: "meta", shape: "SlotCtx", always: true },
    ...REQUEST_ID_BLOCKS,
    { path: "target", kind: "meta", shape: "DeletionConfirmedTarget", always: true },
    { path: "positions", kind: "meta", shape: "Positions", always: true },
    { path: "summary", kind: "data", shape: "Summary" },
    ...DELETION_RESULT_BLOCKS,
    { path: "superseded_items", kind: "meta", shape: "ItemIdList" },
  ],
  "deletion.cancelled": [
    { path: "ctx", kind: "meta", shape: "SlotCtx", always: true },
    ...REQUEST_ID_BLOCKS,
    { path: "target", kind: "meta", shape: "DeletionCancelledTarget", always: true },
    ...DELETION_RESULT_BLOCKS,
    { path: "restored_items", kind: "meta", shape: "ItemIdList" },
    { path: "kept_superseded/<n>", kind: "meta", shape: "KeptSuperseded" },
    { path: "kept_effective/<n>", kind: "meta", shape: "KeptEffective" },
  ],
  // TODO(apply-parser): header `trigger` ↔ `target.reason`: `deletion_expiry` ↔ `expiry`,
  // `restore_backfill` ↔ `restore_backfill`, `import` ↔ `import_placeholder`.
  "deletion.executed": [
    { path: "target", kind: "meta", shape: "DeletionExecutedTarget", always: true },
    { path: "positions", kind: "meta", shape: "Positions", always: true },
  ],
  // §5.10
  "premise.changed": [{ path: "targets/<n>", kind: "meta", shape: "PremiseTarget" }],
} as const satisfies Record<EventType, readonly VocabularyEntry[]>;

// =============================================================================================
// Static types derived from the vocabulary

type SegmentType<S extends string> = S extends "<field>"
  ? FieldId
  : S extends "<table>"
    ? TableId
    : S extends "<n>"
      ? `${number}`
      : S;

/** The template literal type of the concrete paths a pattern matches. */
export type PathOf<P extends string> = P extends `${infer Head}/${infer Rest}`
  ? `${SegmentType<Head>}/${PathOf<Rest>}`
  : SegmentType<P>;

type EntriesOf<T extends EventType> = (typeof VOCABULARY)[T][number];

/** The blocks every event of type `T` has (vocabulary entries marked `always`). */
export type RequiredBlocks<T extends EventType> = {
  readonly [E in EntriesOf<T> as E extends { readonly always: true }
    ? PathOf<E["path"]>
    : never]: BlockShapes[E["shape"]];
};

/** The blocks an event of type `T` may have; patterns become template literal index signatures. */
export type OptionalBlocks<T extends EventType> = {
  readonly [E in EntriesOf<T> as E extends { readonly always: true }
    ? never
    : PathOf<E["path"]>]?: BlockShapes[E["shape"]];
};

/** The content blocks of an event of type `T`: path → block value. */
export type EventBlocks<T extends EventType> = RequiredBlocks<T> & OptionalBlocks<T>;

/** Every block path of event type `T`. */
export type BlockPath<T extends EventType> = PathOf<EntriesOf<T>["path"]>;

// =============================================================================================
// Path syntax (§3.1)

/** One segment of a concrete path, classified by syntax alone. */
export type PathSegment =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "table"; readonly text: string }
  | { readonly kind: "field"; readonly text: string }
  | { readonly kind: "index"; readonly text: string; readonly value: number };

export type PathSyntaxResult =
  | { readonly ok: true; readonly segments: readonly PathSegment[] }
  | { readonly ok: false; readonly reason: string };

const WORD_RE = /^[a-z_]+$/;
const INDEX_RE = /^(0|[1-9][0-9]*)$/;

function classify(segment: string): PathSegment | undefined {
  if (WORD_RE.test(segment)) return { kind: "word", text: segment };
  if (INDEX_RE.test(segment)) {
    const value = Number(segment);
    return value <= MAX_EVENT_INTEGER ? { kind: "index", text: segment, value } : undefined;
  }
  if (ID_PATTERNS.table.test(segment)) return { kind: "table", text: segment };
  if (ID_PATTERNS.field.test(segment)) return { kind: "field", text: segment };
  return undefined;
}

/**
 * Check a path against the §3.1 syntax, independent of event type: one or more `/`-separated
 * ASCII segments, each a fixed word (`[a-z_]+`), an opaque ID (table `t<n>` or field `f<n>`), or a
 * decimal index from 0 without leading zeros (at most 2^53 − 1). The three segment grammars are
 * ASCII-only, so a non-ASCII path is rejected by them.
 */
export function checkPathSyntax(path: string): PathSyntaxResult {
  if (path === "") return { ok: false, reason: "path is empty" };
  const segments: PathSegment[] = [];
  for (const text of path.split("/")) {
    if (text === "") return { ok: false, reason: "empty segment" };
    const segment = classify(text);
    if (segment === undefined) return { ok: false, reason: `invalid segment "${text}"` };
    segments.push(segment);
  }
  return { ok: true, segments };
}

type CompiledSegment =
  | { readonly kind: "word"; readonly text: string }
  | { readonly kind: "table" | "field" | "index" };

const PLACEHOLDERS = { "<table>": "table", "<field>": "field", "<n>": "index" } as const;

function compilePattern(pattern: string): readonly CompiledSegment[] {
  return pattern.split("/").map((text): CompiledSegment => {
    if (Object.hasOwn(PLACEHOLDERS, text)) {
      return { kind: PLACEHOLDERS[text as keyof typeof PLACEHOLDERS] };
    }
    if (!WORD_RE.test(text)) throw new Error(`vocabulary: bad pattern segment "${text}"`);
    return { kind: "word", text };
  });
}

interface CompiledEntry {
  readonly entry: VocabularyEntry;
  readonly segments: readonly CompiledSegment[];
}

const COMPILED: ReadonlyMap<string, readonly CompiledEntry[]> = new Map(
  Object.entries(VOCABULARY).map(([type, entries]) => [
    type,
    (entries as readonly VocabularyEntry[]).map((entry) => ({
      entry,
      segments: compilePattern(entry.path),
    })),
  ]),
);

function matches(pattern: readonly CompiledSegment[], path: readonly PathSegment[]): boolean {
  if (pattern.length !== path.length) return false;
  return pattern.every((p, i) => {
    const s = path[i];
    if (s === undefined || p.kind !== s.kind) return false;
    return p.kind !== "word" || p.text === s.text;
  });
}

/**
 * The vocabulary entry of a concrete path in an event of type `type`, or undefined when the type
 * is unknown, the path is malformed, or the type has no such path. Undefined means the event is
 * not a valid v1 event (§1.6).
 */
export function matchPath(type: string, path: string): VocabularyEntry | undefined {
  const entries = COMPILED.get(type);
  if (entries === undefined) return undefined;
  const syntax = checkPathSyntax(path);
  if (!syntax.ok) return undefined;
  return entries.find((c) => matches(c.segments, syntax.segments))?.entry;
}

/** All vocabulary entries of a concrete path (the vocabulary guarantees at most one). */
export function matchPathAll(type: string, path: string): readonly VocabularyEntry[] {
  const entries = COMPILED.get(type);
  const syntax = checkPathSyntax(path);
  if (entries === undefined || !syntax.ok) return [];
  return entries.filter((c) => matches(c.segments, syntax.segments)).map((c) => c.entry);
}
