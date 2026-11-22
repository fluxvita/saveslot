// The operation contract of saveslot (docs/zh-CN/spec/04-contract-types.md): parameter, result
// and error types of the operations a client calls in this version, plus `as const` arrays of
// the contract's enums. Types only; no validation, no route table.
//
// Covered: common types (§1), evidence (§2), marks (§3), the read row, `catalog`, `query`, `sql`
// and `history` (§4.1–§4.5), `pending` (§4.8), `resolve` (§5.2) with the `write` result shapes
// it reuses (§5.1), `schema_draft` (§5.3), warnings and notices (§7), `connections.*`,
// `reads.list`, `log.verify`, `log.reconcile` and `log.end` (§8.1, §8.3, §8.4, §8.5), `sources` (§4.6), and errors (§9). Not yet
// covered: `deletion_preview`, `write` parameters, `delete`, jobs, `policy.set`, export / import.
//
// Members the spec marks `@later` (not in this version, §0.2) are omitted. Types whose value set
// is the same as the event format's are re-exported from contract-core.

export * from "./admin.ts";
export * from "./common.ts";
export * from "./errors.ts";
export * from "./marks.ts";
export * from "./pending.ts";
export * from "./read.ts";
export * from "./schema.ts";
export * from "./validation.ts";
export * from "./write.ts";
