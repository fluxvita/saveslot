// The codes and reasons the kernel's errors carry (contract-core, 04-contract-types §9).
export {
  KERNEL_OUTER_ERROR_REASONS,
  type KernelErrorCode,
  type KernelErrorDetail,
  type KernelErrorReason,
} from "@fluxvita/saveslot-contract-core";
export * from "./apply/index.ts";
export * from "./audit/index.ts";
export * from "./derive/index.ts";
export * from "./judge/index.ts";
export * from "./log/index.ts";
export * from "./ops/index.ts";
export type { DecisionResolution } from "./pending/closing.ts";
export {
  type AsOfResult,
  type CatalogResult,
  MAX_NOTICES,
  type NoticeRefs,
  type PendingItemsNotice,
  type PendingReadResult,
  pendingItemsNotices,
  type QueryReadResult,
  ReadError,
  type ReadsListResult,
  type Row,
  slotCreators,
  type TimelineResult,
  type VisibleSlot,
  visibleSlots,
} from "./read/index.ts";
// The business time parameter types (FromParam, ToParam, ValidParam) are request's; judge takes the
// same ones and re-exports them, so they come out through judge.
export {
  type ChangedFields,
  checkSvCompatibility,
  type EvidenceSegment,
  type Intent,
  isJsonNumber,
  JsonNumber,
  jsonNumber,
  keepNumberText,
  type NormalizedField,
  type NormalizedOp,
  type NormalizedTarget,
  type NormalizedWrite,
  type NormalizeWriteInput,
  type NormalizeWriteResult,
  normalizeWrite,
  type RequestError,
  type ResolveWriteSlotResult,
  resolveWriteSlot,
  type SlotTables,
  type WriteValidationDetail,
  type WriteWarning,
} from "./request/index.ts";
export * from "./rules/index.ts";
export * from "./schema/index.ts";
export * from "./store/anchor.ts";
export * from "./store/anchor-check.ts";
export * from "./store/format-v1.ts";
export * from "./store/ports.ts";
export * from "./time/index.ts";
